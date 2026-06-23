// Mobile patch: this file reads vaultPath/backupRoot via the live
// getters on serverAssets/config.js (which delegates to runtimeConfig.js)
// so that a runtime vault path change (after the user picks a new
// folder via SAF) is visible to all route handlers without restarting
// Express.

// (routes/api.js) Defines API endpoints for fetching note names, triggering
// backups, checking backup status, and saving notes. Uses Express router and
// imports functions from scraper and backup scripts. Broadcasts file changes
// via SSE.

const express = require("express");
const router = express.Router();
const path = require("path");
const fs = require("fs");
const multer = require("multer");
const { getNoteNames } = require("../../scripts/scraper");
const { performBackup, getAllBackupState } = require("../../scripts/backup");
const config = require("../config");
const { broadcastSSE } = require("./sse");
const { backupTypes } = require("../backup");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Resolve a user-supplied relative note path against the vault and ensure the
 * result stays inside the vault. Returns the absolute path or null if the path
 * would escape the vault (path-traversal guard).
 */
function safeResolveNotePath(notePath) {
  if (typeof notePath !== "string" || notePath.length === 0) return null;
  // Normalise separators and strip a leading slash so absolute paths can't
  // break out of the vault root.
  const cleaned = notePath.replace(/\\/g, "/").replace(/^\/+/, "");
  const fullPath = path.resolve(config.vaultPath, cleaned + ".md");
  const normalizedVault = path.resolve(config.vaultPath) + path.sep;
  if (fullPath !== path.resolve(config.vaultPath) && !fullPath.startsWith(normalizedVault)) {
    return null;
  }
  return fullPath;
}

/**
 * Atomically write `content` to `filePath` by first writing to a temp file in
 * the same directory, fsync-ing it, then renaming over the target. This
 * prevents truncated / zero-byte files if the process crashes mid-write.
 * The temp file lives in the same directory so the rename is atomic on the
 * same filesystem (POSIX rename + Windows MoveFileEx are both atomic).
 */
function atomicWriteFile(filePath, content) {
  const tmpPath =
    filePath + ".tmp-" + Date.now() + "-" + Math.random().toString(36).slice(2, 8);
  fs.writeFileSync(tmpPath, content, "utf8");
  // fsync to flush the OS write buffer to disk so the rename is durable.
  try {
    const fd = fs.openSync(tmpPath, "r");
    fs.fsyncSync(fd);
    fs.closeSync(fd);
  } catch (e) {
    /* fsync may fail on some systems — non-fatal */
  }
  try {
    // Try the atomic rename first
    fs.renameSync(tmpPath, filePath);
  } catch (renameErr) {
    // On Windows, rename fails with EPERM if the target file is locked
    // (by Obsidian, an antivirus, a sync client like OneDrive, or another
    // process holding a handle). Fall back to a direct write — it's not
    // atomic, but it's better than losing the save entirely.
    try {
      // Clean up the temp file
      try { fs.unlinkSync(tmpPath); } catch (e) {}
      // Direct write (non-atomic, but works even when the file is locked
      // for renaming — Windows allows writing to an open file in many cases)
      fs.writeFileSync(filePath, content, "utf8");
    } catch (writeErr) {
      // If even the direct write fails, rethrow the original rename error
      // (it's more descriptive of the actual problem)
      throw renameErr;
    }
  }
}

/** Escape a literal string so it can be safely embedded inside a RegExp. */
function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Scan the entire vault for `[[oldName]]` wikilinks and rewrite them to
 * `[[newName]]`, preserving any `#heading` or `|alias` suffix. Called after a
 * note is renamed so backlinks keep pointing at the right note.
 *
 * Matches:
 *   [[OldName]]
 *   [[OldName|alias]]
 *   [[OldName#heading]]
 *   [[OldName#heading|alias]]
 *
 * Returns an array of relative paths (with .md extension, forward slashes)
 * for every file whose content was modified.
 */
function rewriteBacklinks(vaultDir, oldName, newName) {
  const results = [];
  function scanDir(dir) {
    const items = fs.readdirSync(dir);
    for (const item of items) {
      if (item.startsWith(".")) continue;
      const fullPath = path.join(dir, item);
      const stat = fs.statSync(fullPath);
      if (stat.isDirectory()) {
        if (["node_modules", ".git", ".trash"].includes(item)) continue;
        scanDir(fullPath);
      } else if (item.endsWith(".md")) {
        const content = fs.readFileSync(fullPath, "utf8");
        // Capture optional #heading and |alias (in that order) so we can
        // preserve them when swapping the note name.
        const regex = new RegExp(
          "\\[\\[" +
            escapeRegex(oldName) +
            "(#[^\\]|]*)?(\\|[^\\]]*)?\\]\\]",
          "gi"
        );
        let changed = false;
        let newContent = content.replace(regex, (match, heading, alias) => {
          changed = true;
          return "[[" + newName + (heading || "") + (alias || "") + "]]";
        });
        if (changed) {
          fs.writeFileSync(fullPath, newContent, "utf8");
          const relPath = path.relative(vaultDir, fullPath).replace(/\\/g, "/");
          results.push(relPath);
        }
      }
    }
  }
  scanDir(vaultDir);
  return results;
}

// ---------------------------------------------------------------------------
// Notes
// ---------------------------------------------------------------------------
router.get("/notes", (req, res) => {
  try {
    const noteNames = getNoteNames(config.vaultPath, config.DATA_DIR);
    res.json({ success: true, count: noteNames.length, names: noteNames });
  } catch (err) {
    console.error("Scraper error:", err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ---------------------------------------------------------------------------
// Backup triggers
// Backups are destructive (they delete previous backups) and expensive, so
// they use POST instead of GET.
// ---------------------------------------------------------------------------
router.post("/backup", async (req, res) => {
  const type = req.query.type;
  if (type) {
    const validTypes = backupTypes.map((t) => t.type);
    if (!validTypes.includes(type)) {
      return res.status(400).json({
        success: false,
        error: `Invalid type. Must be one of: ${validTypes.join(", ")}`,
      });
    }
    const result = await performBackup(config.vaultPath, config.backupRoot, type);
    return res.json(result);
  } else {
    const results = {};
    for (const { type: t } of backupTypes) {
      results[t] = await performBackup(config.vaultPath, config.backupRoot, t);
    }
    return res.json({ success: true, results });
  }
});

// Keep GET for backward compatibility (old backup.html button) but redirect to
// the POST handler logic. Deprecated.
router.get("/backup", async (req, res) => {
  const type = req.query.type;
  if (type) {
    const validTypes = backupTypes.map((t) => t.type);
    if (!validTypes.includes(type)) {
      return res.status(400).json({
        success: false,
        error: `Invalid type. Must be one of: ${validTypes.join(", ")}`,
      });
    }
    const result = await performBackup(config.vaultPath, config.backupRoot, type);
    return res.json(result);
  } else {
    const results = {};
    for (const { type: t } of backupTypes) {
      results[t] = await performBackup(config.vaultPath, config.backupRoot, t);
    }
    return res.json({ success: true, results });
  }
});

// Backup status (vault-specific)
router.get("/backup-status", (req, res) => {
  const state = getAllBackupState(config.vaultPath);
  res.json({ success: true, state });
});

// ---------------------------------------------------------------------------
// Save note (from editor)
// ---------------------------------------------------------------------------
router.post("/save-note", (req, res) => {
  const { path: notePath, content, expectedMtime } = req.body;
  if (!notePath || content === undefined) {
    return res
      .status(400)
      .json({ success: false, error: "Missing path or content" });
  }
  const fullPath = safeResolveNotePath(notePath);
  if (!fullPath) {
    return res
      .status(400)
      .json({ success: false, error: "Invalid note path (path traversal blocked)" });
  }
  try {
    // Conflict detection: if the client sent expectedMtime, verify the file
    // on disk hasn't been modified by another session since the client last
    // loaded it. This prevents silent clobbering of concurrent edits.
    if (expectedMtime !== undefined && fs.existsSync(fullPath)) {
      const stat = fs.statSync(fullPath);
      if (stat.mtimeMs !== expectedMtime) {
        return res.status(409).json({
          success: false,
          error:
            "This note was modified by another session. Please reload and merge your changes.",
          code: "CONFLICT",
          currentMtime: stat.mtimeMs,
        });
      }
    }
    const dir = path.dirname(fullPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    // Save a version snapshot of the CURRENT content BEFORE overwriting.
    // This lets the user browse and restore previous versions.
    if (fs.existsSync(fullPath)) {
      try {
        const currentContent = fs.readFileSync(fullPath, "utf8");
        if (currentContent !== content) {
          saveVersionSnapshot(notePath, currentContent);
        }
      } catch (e) { /* non-fatal */ }
    }
    // Atomic write: write to temp file, fsync, then rename. Prevents
    // truncated / zero-byte files if the process crashes mid-write.
    atomicWriteFile(fullPath, content);
    const newStat = fs.statSync(fullPath);
    // Broadcast the new content so the viewer can update without a full
    // vault refetch.
    broadcastSSE("fileChanged", {
      path: notePath.replace(/\\/g, "/"),
      content,
      mtime: newStat.mtimeMs,
    });
    res.json({ success: true, mtime: newStat.mtimeMs });
  } catch (err) {
    console.error("Save error:", err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ---------------------------------------------------------------------------
// Create note
// Body: { path: "Folder/NoteName" } — creates an empty .md file.
// ---------------------------------------------------------------------------
router.post("/create-note", (req, res) => {
  const { path: notePath } = req.body;
  if (!notePath) {
    return res.status(400).json({ success: false, error: "Missing path" });
  }
  const fullPath = safeResolveNotePath(notePath);
  if (!fullPath) {
    return res.status(400).json({ success: false, error: "Invalid path (path traversal blocked)" });
  }
  try {
    if (fs.existsSync(fullPath)) {
      return res.status(409).json({ success: false, error: "Note already exists" });
    }
    const dir = path.dirname(fullPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(fullPath, "", "utf8");
    broadcastSSE("treeChanged", {});
    res.json({ success: true });
  } catch (err) {
    console.error("Create note error:", err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ---------------------------------------------------------------------------
// Create folder
// Body: { path: "Folder/Subfolder" } — creates an empty directory.
// ---------------------------------------------------------------------------
router.post("/create-folder", (req, res) => {
  const { path: folderPath } = req.body;
  if (!folderPath) {
    return res.status(400).json({ success: false, error: "Missing path" });
  }
  // Validate the folder path stays inside the vault
  const cleaned = folderPath.replace(/\\/g, "/").replace(/^\/+/, "");
  const fullPath = path.resolve(config.vaultPath, cleaned);
  const normalizedVault = path.resolve(config.vaultPath) + path.sep;
  if (fullPath !== path.resolve(config.vaultPath) && !fullPath.startsWith(normalizedVault)) {
    return res.status(400).json({ success: false, error: "Invalid path (path traversal blocked)" });
  }
  try {
    if (fs.existsSync(fullPath)) {
      return res.status(409).json({ success: false, error: "Folder already exists" });
    }
    fs.mkdirSync(fullPath, { recursive: true });
    broadcastSSE("treeChanged", {});
    res.json({ success: true });
  } catch (err) {
    console.error("Create folder error:", err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ---------------------------------------------------------------------------
// Rename note
// Body: { oldPath: "Folder/OldName", newPath: "Folder/NewName" }
// Renames the .md file and updates noteMap on the client.
// ---------------------------------------------------------------------------
router.post("/rename-note", (req, res) => {
  const { oldPath, newPath } = req.body;
  if (!oldPath || !newPath) {
    return res.status(400).json({ success: false, error: "Missing oldPath or newPath" });
  }
  const oldFull = safeResolveNotePath(oldPath);
  const newFull = safeResolveNotePath(newPath);
  if (!oldFull || !newFull) {
    return res.status(400).json({ success: false, error: "Invalid path (path traversal blocked)" });
  }
  try {
    if (!fs.existsSync(oldFull)) {
      return res.status(404).json({ success: false, error: "Original note not found" });
    }
    if (fs.existsSync(newFull)) {
      return res.status(409).json({ success: false, error: "A note with that name already exists" });
    }
    const dir = path.dirname(newFull);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.renameSync(oldFull, newFull);
    // After the rename, walk the vault and rewrite [[OldName]] wikilinks to
    // [[NewName]] so backlinks keep resolving. Preserve #heading and |alias.
    const oldName = oldPath.split("/").pop();
    const newName = newPath.split("/").pop();
    const affected = rewriteBacklinks(config.vaultPath, oldName, newName);
    broadcastSSE("treeChanged", {});
    // Notify clients that each affected backlink file's content changed so
    // they can refresh any open editor/viewer tabs.
    for (const affPath of affected) {
      const affContent = fs.readFileSync(path.join(config.vaultPath, affPath), "utf8");
      broadcastSSE("fileChanged", { path: affPath, content: affContent });
    }
    res.json({ success: true, newPath, affectedBacklinks: affected });
  } catch (err) {
    console.error("Rename note error:", err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ---------------------------------------------------------------------------
// Rename folder
// Body: { oldPath: "Folder/OldName", newPath: "Folder/NewName" }
// ---------------------------------------------------------------------------
router.post("/rename-folder", (req, res) => {
  const { oldPath, newPath } = req.body;
  if (!oldPath || !newPath) {
    return res.status(400).json({ success: false, error: "Missing oldPath or newPath" });
  }
  const cleanOld = oldPath.replace(/\\/g, "/").replace(/^\/+/, "");
  const cleanNew = newPath.replace(/\\/g, "/").replace(/^\/+/, "");
  const oldFull = path.resolve(config.vaultPath, cleanOld);
  const newFull = path.resolve(config.vaultPath, cleanNew);
  const normalizedVault = path.resolve(config.vaultPath) + path.sep;
  if (!oldFull.startsWith(normalizedVault) || !newFull.startsWith(normalizedVault)) {
    return res.status(400).json({ success: false, error: "Invalid path (path traversal blocked)" });
  }
  try {
    if (!fs.existsSync(oldFull)) {
      return res.status(404).json({ success: false, error: "Original folder not found" });
    }
    if (fs.existsSync(newFull)) {
      return res.status(409).json({ success: false, error: "A folder with that name already exists" });
    }
    fs.renameSync(oldFull, newFull);
    broadcastSSE("treeChanged", {});
    res.json({ success: true });
  } catch (err) {
    console.error("Rename folder error:", err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ---------------------------------------------------------------------------
// Delete note
// Body: { path: "Folder/NoteName" } — deletes the .md file.
// ---------------------------------------------------------------------------
router.post("/delete-note", (req, res) => {
  const { path: notePath } = req.body;
  if (!notePath) {
    return res.status(400).json({ success: false, error: "Missing path" });
  }
  const fullPath = safeResolveNotePath(notePath);
  if (!fullPath) {
    return res.status(400).json({ success: false, error: "Invalid path (path traversal blocked)" });
  }
  try {
    if (!fs.existsSync(fullPath)) {
      return res.status(404).json({ success: false, error: "Note not found" });
    }
    fs.unlinkSync(fullPath);
    // Broadcast fileDeleted (with forward-slash path, no .md extension) so
    // clients can close any open tabs pointing at this note, then
    // treeChanged so the sidebar refreshes.
    broadcastSSE("fileDeleted", { path: notePath.replace(/\\/g, "/") });
    broadcastSSE("treeChanged", {});
    res.json({ success: true });
  } catch (err) {
    console.error("Delete note error:", err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ---------------------------------------------------------------------------
// Delete folder
// Body: { path: "Folder/Subfolder" } — deletes the directory recursively.
// ---------------------------------------------------------------------------
router.post("/delete-folder", (req, res) => {
  const { path: folderPath } = req.body;
  if (!folderPath) {
    return res.status(400).json({ success: false, error: "Missing path" });
  }
  const cleaned = folderPath.replace(/\\/g, "/").replace(/^\/+/, "");
  const fullPath = path.resolve(config.vaultPath, cleaned);
  const normalizedVault = path.resolve(config.vaultPath) + path.sep;
  if (fullPath === path.resolve(config.vaultPath) || !fullPath.startsWith(normalizedVault)) {
    return res.status(400).json({ success: false, error: "Invalid path (path traversal blocked)" });
  }
  try {
    if (!fs.existsSync(fullPath)) {
      return res.status(404).json({ success: false, error: "Folder not found" });
    }
    // Scan the folder for .md files BEFORE deleting so we can broadcast a
    // fileDeleted event for each note (clients need this to close open tabs).
    // Paths are emitted WITHOUT the .md extension to match the convention
    // used by /delete-note and the rest of the API.
    const deletedNotes = [];
    (function collectNotes(dir) {
      const items = fs.readdirSync(dir);
      for (const item of items) {
        if (item.startsWith(".")) continue;
        const fp = path.join(dir, item);
        const st = fs.statSync(fp);
        if (st.isDirectory()) {
          if (["node_modules", ".git", ".trash"].includes(item)) continue;
          collectNotes(fp);
        } else if (item.toLowerCase().endsWith(".md")) {
          const rel = path.relative(config.vaultPath, fp).replace(/\\/g, "/");
          deletedNotes.push(rel.replace(/\.md$/i, ""));
        }
      }
    })(fullPath);
    fs.rmSync(fullPath, { recursive: true, force: true });
    for (const noteRelPath of deletedNotes) {
      broadcastSSE("fileDeleted", { path: noteRelPath });
    }
    broadcastSSE("treeChanged", {});
    res.json({ success: true });
  } catch (err) {
    console.error("Delete folder error:", err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ---------------------------------------------------------------------------
// Upload image (from editor paste/drop)
// Receives a multipart/form-data upload with:
//   - image: the image file
//   - noteDir: the relative path of the note's folder (e.g. "Folder/Sub")
// Writes the file to <vault>/<noteDir>/assets/<filename> and returns the
// filename. The editor then inserts ![[filename]] which resolves via the
// image map.
// ---------------------------------------------------------------------------

// In-memory multer storage so we can control the exact destination
// (we need to resolve it relative to the vault + noteDir, with a path-
// traversal guard).
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 }, // 25 MB max
});

router.post("/upload-image", upload.single("image"), async (req, res) => {
  try {
    if (!req.file) {
      return res
        .status(400)
        .json({ success: false, error: "No image file received" });
    }

    // Resolve the noteDir safely (must stay inside the vault)
    let noteDir = "";
    if (typeof req.body.noteDir === "string") {
      noteDir = req.body.noteDir.replace(/\\/g, "/").replace(/^\/+/, "");
    }
    const assetsDir = noteDir
      ? path.resolve(config.vaultPath, noteDir, "assets")
      : path.resolve(config.vaultPath, "assets");
    const normalizedVault = path.resolve(config.vaultPath) + path.sep;
    if (!assetsDir.startsWith(normalizedVault) && assetsDir !== path.resolve(config.vaultPath)) {
      return res.status(400).json({
        success: false,
        error: "Invalid noteDir (path traversal blocked)",
      });
    }

    // Generate an Obsidian-style filename: "Pasted image YYYYMMDDHHMMSS.webp"
    // Convert all pasted images to WebP for consistency and smaller size.
    const now = new Date();
    const pad = (n) => String(n).padStart(2, "0");
    const timestamp =
      now.getFullYear().toString() +
      pad(now.getMonth() + 1) +
      pad(now.getDate()) +
      pad(now.getHours()) +
      pad(now.getMinutes()) +
      pad(now.getSeconds());
    const filename = `Pasted image ${timestamp}.webp`;

    // Ensure the assets dir exists
    fs.mkdirSync(assetsDir, { recursive: true });

    // If a file with the same name exists, append a counter (very unlikely
    // with second-precision timestamps but just in case).
    let finalPath = path.join(assetsDir, filename);
    let finalName = filename;
    if (fs.existsSync(finalPath)) {
      const ext = path.extname(filename);
      const base = path.basename(filename, ext);
      let counter = 1;
      while (fs.existsSync(path.join(assetsDir, `${base} ${counter}${ext}`))) {
        counter++;
      }
      finalName = `${base} ${counter}${ext}`;
      finalPath = path.join(assetsDir, finalName);
    }

    // Convert the uploaded image to WebP using sharp (quality 90 for good
    // balance of size and quality). This handles PNG, JPEG, GIF, etc.
    try {
      const sharp = require("sharp");
      await sharp(req.file.buffer)
        .webp({ quality: 90 })
        .toFile(finalPath);
    } catch (convErr) {
      // If sharp conversion fails (e.g. SVG), fall back to writing the
      // original bytes with their original extension.
      console.warn("WebP conversion failed, keeping original:", convErr.message);
      const origExt = path.extname(req.file.originalname || ".png") || ".png";
      finalName = `Pasted image ${timestamp}${origExt}`;
      finalPath = path.join(assetsDir, finalName);
      fs.writeFileSync(finalPath, req.file.buffer);
    }

    // Invalidate the image cache so the new image is picked up immediately.
    try {
      const vaultRouter = require("./vault");
      if (vaultRouter.invalidateImageCache) vaultRouter.invalidateImageCache();
    } catch (e) {
      // ignore
    }

    res.json({ success: true, filename: finalName });
  } catch (err) {
    console.error("Upload image error:", err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ---------------------------------------------------------------------------
// CONFIG — get/set vault settings
// ---------------------------------------------------------------------------
const CONFIG_FILE = path.join(__dirname, "..", "..", "config.json");

router.get("/config", (req, res) => {
  try {
    const config = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"));
    res.json({ success: true, config });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

router.post("/config", async (req, res) => {
  try {
    const { vaultPath: newVaultPath, backupDestination: newBackupDest, backupTimezone: newTz } = req.body;

    // Read current config
    const config = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"));

    // Validate vault path exists (if changed)
    if (newVaultPath && newVaultPath !== config.vaultPath) {
      if (!fs.existsSync(newVaultPath)) {
        return res.status(400).json({ success: false, error: `Vault path does not exist: ${newVaultPath}` });
      }
      config.vaultPath = newVaultPath;
    }

    if (newBackupDest) {
      config.backupDestination = newBackupDest;
    }
    if (newTz) {
      config.backupTimezone = newTz;
    }

    // Write updated config
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), "utf8");
    console.log("⚙️ Config updated. Server restart required for changes to take effect.");

    res.json({ success: true, message: "Config saved. Server will restart." });

    // Schedule a restart after 1 second (so the response is sent first)
    setTimeout(() => {
      console.log("🔄 Restarting server for config changes...");
      process.exit(0); // The process manager (bun --hot or nodemon) will restart
    }, 1000);
  } catch (e) {
    console.error("Config save error:", e.message);
    res.status(500).json({ success: false, error: e.message });
  }
});

// ---------------------------------------------------------------------------
// VERSION HISTORY — snapshot-based note versioning
// ---------------------------------------------------------------------------
// Before each save, a snapshot of the current file content is saved to
// data/versions/[notePath]/[timestamp].md. The user can browse the timeline
// and view diffs between versions (like VS Code's timeline).
// ---------------------------------------------------------------------------
const VERSIONS_DIR = path.join(config.DATA_DIR, "versions");
const MAX_VERSIONS_PER_NOTE = 50; // keep last 50 versions per note

function getNoteVersionsDir(notePath) {
  const safeName = notePath.replace(/[^a-zA-Z0-9_/-]/g, "_").replace(/\.md$/, "");
  return path.join(VERSIONS_DIR, safeName);
}

function saveVersionSnapshot(notePath, content) {
  try {
    const dir = getNoteVersionsDir(notePath);
    fs.mkdirSync(dir, { recursive: true });
    const timestamp = Date.now();
    const versionFile = path.join(dir, `${timestamp}.md`);
    fs.writeFileSync(versionFile, content, "utf8");

    // Write metadata alongside the version
    const metaFile = path.join(dir, `${timestamp}.meta.json`);
    fs.writeFileSync(metaFile, JSON.stringify({
      timestamp,
      size: content.length,
      preview: content.substring(0, 200),
    }), "utf8");

    // Clean up old versions (keep last MAX_VERSIONS_PER_NOTE)
    const files = fs.readdirSync(dir)
      .filter(f => f.endsWith(".md"))
      .map(f => parseInt(f.replace(".md", ""), 10))
      .sort((a, b) => b - a); // newest first

    if (files.length > MAX_VERSIONS_PER_NOTE) {
      for (let i = MAX_VERSIONS_PER_NOTE; i < files.length; i++) {
        try {
          fs.unlinkSync(path.join(dir, `${files[i]}.md`));
          fs.unlinkSync(path.join(dir, `${files[i]}.meta.json`));
        } catch (e) { /* non-fatal */ }
      }
    }

    return timestamp;
  } catch (e) {
    console.warn("Version snapshot error:", e.message);
    return null;
  }
}

// List all versions for a note
router.get("/versions", (req, res) => {
  try {
    const notePath = req.query.path;
    if (!notePath) return res.status(400).json({ success: false, error: "Missing path" });

    const dir = getNoteVersionsDir(notePath);
    if (!fs.existsSync(dir)) {
      return res.json({ success: true, versions: [] });
    }

    const metaFiles = fs.readdirSync(dir).filter(f => f.endsWith(".meta.json"));
    const versions = metaFiles.map(f => {
      try {
        const meta = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
        return meta;
      } catch (e) {
        return null;
      }
    }).filter(v => v !== null).sort((a, b) => b.timestamp - a.timestamp);

    res.json({ success: true, versions });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// Get the content of a specific version
router.get("/versions/:timestamp", (req, res) => {
  try {
    const notePath = req.query.path;
    const timestamp = req.params.timestamp;
    if (!notePath || !timestamp) return res.status(400).json({ success: false, error: "Missing path or timestamp" });

    const dir = getNoteVersionsDir(notePath);
    const versionFile = path.join(dir, `${timestamp}.md`);
    if (!fs.existsSync(versionFile)) {
      return res.status(404).json({ success: false, error: "Version not found" });
    }

    const content = fs.readFileSync(versionFile, "utf8");
    res.json({ success: true, content, timestamp: parseInt(timestamp, 10) });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// Restore a specific version (saves it as the current content)
router.post("/versions/:timestamp/restore", (req, res) => {
  try {
    const notePath = req.body.path;
    const timestamp = req.params.timestamp;
    if (!notePath || !timestamp) return res.status(400).json({ success: false, error: "Missing path or timestamp" });

    const dir = getNoteVersionsDir(notePath);
    const versionFile = path.join(dir, `${timestamp}.md`);
    if (!fs.existsSync(versionFile)) {
      return res.status(404).json({ success: false, error: "Version not found" });
    }

    const content = fs.readFileSync(versionFile, "utf8");
    // Save the current content as a version BEFORE restoring
    const fullPath = safeResolveNotePath(notePath);
    if (fullPath && fs.existsSync(fullPath)) {
      const currentContent = fs.readFileSync(fullPath, "utf8");
      saveVersionSnapshot(notePath, currentContent);
    }

    // Write the restored version
    if (fullPath) {
      atomicWriteFile(fullPath, content);
      broadcastSSE("fileChanged", { path: notePath.replace(/\\/g, "/"), content });
    }

    res.json({ success: true, message: "Version restored" });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

module.exports = router;
