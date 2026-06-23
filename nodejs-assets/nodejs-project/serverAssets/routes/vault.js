// Mobile patch: this file reads vaultPath/backupRoot via the live
// getters on serverAssets/config.js (which delegates to runtimeConfig.js)
// so that a runtime vault path change (after the user picks a new
// folder via SAF) is visible to all route handlers without restarting
// Express.

// (routes/vault.js) Provides API endpoints for fetching the vault tree
// structure and resolving image paths. The vault tree endpoint returns a
// hierarchical representation of folders and notes, while the images endpoint
// returns a mapping of image filenames to their relative paths. Caches image
// results for performance and excludes certain folders from the vault tree.
// The image cache is invalidated when a file change is broadcast via SSE.

const express = require("express");
const router = express.Router();
const path = require("path");
const fs = require("fs");
const config = require("../config");
const IGNORED_DIRS = new Set([
  ".git",
  ".claude",
  ".claudian",
  ".trash",
  "node_modules",
]);

const IMAGE_EXTS = [".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".bmp", ".tiff", ".ico", ".avif"];

function buildVaultTree(dir, basePath = "") {
  const items = fs.readdirSync(dir);
  const result = [];
  for (const item of items) {
    const fullPath = path.join(dir, item);
    const stat = fs.statSync(fullPath);
    if (stat.isDirectory()) {
      // Ignore explicitly-listed dirs AND any dotfolder (.obsidian, .stfolder,
      // .git, .trash, etc.) — anything starting with ".".
      if (IGNORED_DIRS.has(item) || item.startsWith(".")) continue;
      // Recurse with OS-native basePath (path.join handles it), but expose
      // forward-slash paths to clients so SSE changedPath comparisons work
      // cross-platform.
      const childBase = path.join(basePath, item);
      const children = buildVaultTree(fullPath, childBase);
      result.push({
        name: item,
        type: "folder",
        path: childBase.replace(/\\/g, "/"),
        children: children,
      });
    } else if (stat.isFile() && item.endsWith(".md")) {
      const noteName = item.slice(0, -3);
      // NOTE: content is NOT inlined here — that would make the tree response
      // huge for large vaults. Clients fetch note content lazily via
      // GET /api/note?path=... when a note is opened.
      result.push({
        name: noteName,
        type: "note",
        path: path.join(basePath, noteName).replace(/\\/g, "/"),
        mtime: stat.mtimeMs,
      });
    } else if (stat.isFile()) {
      // Include image files in the tree so they appear in the sidebar.
      // They get type "image" and their path INCLUDES the extension (unlike
      // notes, which strip .md). The frontend uses this path to load the
      // image via /vault/<path>.
      const ext = path.extname(item).toLowerCase();
      if (IMAGE_EXTS.includes(ext)) {
        result.push({
          name: item,  // keep extension for images (display name)
          type: "image",
          path: path.join(basePath, item).replace(/\\/g, "/"),
        });
      }
    }
  }
  result.sort((a, b) => {
    if (a.type === "folder" && b.type !== "folder") return -1;
    if (b.type === "folder" && a.type !== "folder") return 1;
    return a.name.localeCompare(b.name);
  });
  return result;
}

router.get("/vault-tree", (req, res) => {
  try {
    const tree = buildVaultTree(config.vaultPath);
    res.json({ success: true, tree });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ---------------------------------------------------------------------------
// Lazy-load a single note's content.
// GET /api/note?path=Folder/NoteName  (path is relative to vault, no .md ext)
// Returns { success, content, mtime }.
// The vault-tree endpoint no longer inlines content, so clients must call this
// to fetch a note's body when it is opened. mtime is returned so the editor
// can send it back as expectedMtime on save (conflict detection).
// ---------------------------------------------------------------------------
router.get("/note", (req, res) => {
  try {
    const notePath = req.query.path;
    if (!notePath) {
      return res.status(400).json({ success: false, error: "Missing path" });
    }
    // `let` because we may append ".md" below (paths are conventionally
    // sent without the extension).
    let fullPath = path.resolve(config.vaultPath, notePath.replace(/\\/g, "/"));
    const relPath = path.relative(config.vaultPath, fullPath);
    if (relPath.startsWith("..") || path.isAbsolute(relPath)) {
      return res.status(403).json({ success: false, error: "Path outside vault" });
    }
    // Append .md if the caller didn't (paths are conventionally extensionless).
    if (!fullPath.endsWith(".md")) fullPath += ".md";
    if (!fs.existsSync(fullPath)) {
      return res.status(404).json({ success: false, error: "Note not found" });
    }
    const content = fs.readFileSync(fullPath, "utf8");
    const stat = fs.statSync(fullPath);
    res.json({ success: true, content, mtime: stat.mtimeMs });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ---------------------------------------------------------------------------
// Image resolver (with cache)
// ---------------------------------------------------------------------------
let imageCache = null;
let imageCacheTime = 0;
const CACHE_TTL = 60 * 1000;

/** Allow other modules to invalidate the image cache (e.g. on file change). */
function invalidateImageCache() {
  imageCache = null;
  imageCacheTime = 0;
}

function scanImages(dir, basePath = "") {
  const results = {};
  const items = fs.readdirSync(dir);
  for (const item of items) {
    if (item.startsWith(".")) continue;
    const fullPath = path.join(dir, item);
    const stat = fs.statSync(fullPath);
    const relPath = path.join(basePath, item);
    if (stat.isDirectory()) {
      if (IGNORED_DIRS.has(item)) continue;
      const sub = scanImages(fullPath, relPath);
      Object.assign(results, sub);
    } else if (stat.isFile()) {
      const ext = path.extname(item).toLowerCase();
      const imageExts = [
        ".png",
        ".jpg",
        ".jpeg",
        ".gif",
        ".webp",
        ".svg",
        ".bmp",
        ".tiff",
        ".ico",
        ".avif",
      ];
      if (imageExts.includes(ext)) {
        const lowerName = item.toLowerCase();
        // Normalize to forward slashes so the frontend can build "/vault/..." URLs
        // consistently on both Windows and Unix.
        results[lowerName] = relPath.replace(/\\/g, "/");
      }
    }
  }
  return results;
}

router.get("/images", (req, res) => {
  try {
    const now = Date.now();
    if (!imageCache || now - imageCacheTime > CACHE_TTL) {
      imageCache = scanImages(config.vaultPath);
      imageCacheTime = now;
      console.log(`📸 Scanned ${Object.keys(imageCache).length} images`);
    }
    res.json({ success: true, images: imageCache });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Expose an invalidation hook so other modules (watcher, save-note) can clear
// the image cache when files change, ensuring newly added images are picked up
// promptly instead of waiting for the 60s TTL to expire.
module.exports = router;
module.exports.invalidateImageCache = invalidateImageCache;

// ---------------------------------------------------------------------------
//  SAVE IMAGE — used by the image editor to write edited images back to the vault.
//  Receives base64-encoded image data + a path (relative to vault root).
//  The path includes the extension (e.g. "assets/diagram.png"). If the format
//  differs from the original (e.g. user exports a .jpg as .png), the extension
//  in the path determines the output format.
// ---------------------------------------------------------------------------
router.post("/save-image", (req, res) => {
  try {
    const { path: imgPath, dataUrl } = req.body;
    if (!imgPath || !dataUrl) {
      return res.status(400).json({ success: false, error: "path and dataUrl are required" });
    }

    // Security: resolve the path and ensure it's inside the vault
    const fullPath = path.resolve(config.vaultPath, imgPath);
    const relPath = path.relative(config.vaultPath, fullPath);
    if (relPath.startsWith("..") || path.isAbsolute(relPath)) {
      return res.status(403).json({ success: false, error: "Path outside vault" });
    }

    // Parse the data URL: data:image/png;base64,<data>
    const match = dataUrl.match(/^data:image\/(\w+);base64,(.+)$/);
    if (!match) {
      return res.status(400).json({ success: false, error: "Invalid data URL" });
    }
    const ext = match[1]; // png, jpeg, webp, etc.
    const base64Data = match[2];
    const buffer = Buffer.from(base64Data, "base64");

    // Ensure the target directory exists
    const dir = path.dirname(fullPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    fs.writeFileSync(fullPath, buffer);
    console.log(`💾 Saved image: ${imgPath} (${(buffer.length / 1024).toFixed(1)} KB)`);

    // Invalidate the image cache so the new image shows up
    invalidateImageCache();

    res.json({ success: true, path: imgPath });
  } catch (err) {
    console.error("Save image error:", err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});
