// Mobile patch: this file reads vaultPath/backupRoot via the live
// getters on serverAssets/config.js (which delegates to runtimeConfig.js)
// so that a runtime vault path change (after the user picks a new
// folder via SAF) is visible to all route handlers without restarting
// Express.

// (routes/brokenLinks.js) Provides API endpoints for scanning and fixing
// broken links in notes. Uses a cache to store results and includes a smart
// fixing algorithm that attempts to resolve broken links by checking for files
// with matching basenames. Can be triggered manually or automatically when
// fetching broken links.

const express = require("express");
const router = express.Router();
const fs = require("fs");
const path = require("path");
const { scanAllNotes, buildNoteMaps } = require("../../scripts/brokenLinks");
const config = require("../config");
const { broadcastSSE } = require("./sse");

let brokenLinksCache = null;
let brokenLinksCacheTime = 0;
const BROKEN_LINKS_TTL = 5000; // 5 seconds

// ---------------------------------------------------------------------------
// Path-traversal guard
// ---------------------------------------------------------------------------
function safeResolveNotePath(notePath) {
  if (typeof notePath !== "string" || notePath.length === 0) return null;
  const cleaned = notePath.replace(/\\/g, "/").replace(/^\/+/, "");
  const fullPath = path.resolve(config.vaultPath, cleaned + ".md");
  const normalizedVault = path.resolve(config.vaultPath) + path.sep;
  if (fullPath !== path.resolve(config.vaultPath) && !fullPath.startsWith(normalizedVault)) {
    return null;
  }
  return fullPath;
}

// Build a map of basename -> relative path for all files (images, html, etc.)
function buildFileMap(dir, basePath = "", map = new Map()) {
  const items = fs.readdirSync(dir);
  for (const item of items) {
    const fullPath = path.join(dir, item);
    const stat = fs.statSync(fullPath);
    const relPath = path.join(basePath, item);
    if (stat.isDirectory()) {
      // Ignore explicitly-listed dirs AND any dotfolder (.obsidian, .stfolder,
      // .git, .trash, etc.) — anything starting with ".".
      if (
        [".git", ".claude", ".claudian", ".trash", "node_modules"].includes(
          item,
        ) ||
        item.startsWith(".")
      )
        continue;
      buildFileMap(fullPath, relPath, map);
    } else if (stat.isFile()) {
      // Map by lowercase basename
      const basename = path.basename(item);
      const lower = basename.toLowerCase();
      if (!map.has(lower)) {
        map.set(lower, relPath);
      }
    }
  }
  return map;
}

function refreshBrokenLinks() {
  try {
    brokenLinksCache = scanAllNotes(config.vaultPath);
    brokenLinksCacheTime = Date.now();
    console.log(
      `🔗 Found broken links in ${Object.keys(brokenLinksCache).length} notes.`,
    );
  } catch (err) {
    console.error("Error scanning broken links:", err);
    brokenLinksCache = {};
  }
}

// Initial scan
setTimeout(refreshBrokenLinks, 1000);

router.get("/broken-links", (req, res) => {
  if (
    !brokenLinksCache ||
    Date.now() - brokenLinksCacheTime > BROKEN_LINKS_TTL
  ) {
    refreshBrokenLinks();
  }
  res.json({ success: true, data: brokenLinksCache });
});

router.post("/broken-links/refresh", (req, res) => {
  refreshBrokenLinks();
  res.json({ success: true, data: brokenLinksCache });
});

// ---------------------------------------------------------------------------
// FIX broken links with smart logic
// ---------------------------------------------------------------------------
router.post("/broken-links/fix", (req, res) => {
  const { notePath } = req.body;
  if (!notePath) {
    return res.status(400).json({ success: false, error: "Missing notePath" });
  }
  const fullPath = safeResolveNotePath(notePath);
  if (!fullPath) {
    return res
      .status(400)
      .json({ success: false, error: "Invalid note path (path traversal blocked)" });
  }
  if (!fs.existsSync(fullPath)) {
    return res.status(404).json({ success: false, error: "Note not found" });
  }
  try {
    let content = fs.readFileSync(fullPath, "utf8");
    // Build maps for lookup
    const { nameMap, pathMap } = buildNoteMaps(config.vaultPath);
    const fileMap = buildFileMap(config.vaultPath);

    const linkRegex = /\[\[([^\]]+)\]\]/g;
    const replacements = [];
    let match;
    while ((match = linkRegex.exec(content)) !== null) {
      const original = match[0]; // e.g., [[Basic life support/assets/image.png]]
      const link = match[1].trim();
      const lowerLink = link.toLowerCase();

      // Check if link is already valid (skip if exists)
      let exists = false;
      if (link.includes("/") || link.includes("\\")) {
        exists = pathMap.has(lowerLink);
      } else {
        exists = nameMap.has(lowerLink);
      }
      if (exists) continue; // not broken, skip

      // ---- Try to fix ----
      let fixed = null;
      const basename = path.basename(link);
      const lowerBasename = basename.toLowerCase();

      // Check if basename has an extension (image, html, etc.)
      const ext = path.extname(basename).toLowerCase();
      if (ext) {
        // It's a file reference – search fileMap
        if (fileMap.has(lowerBasename)) {
          fixed = `[[${basename}]]`; // just the basename
        }
      } else {
        // No extension: could be a note
        if (link.includes("/") || link.includes("\\")) {
          // It had a path, so try to find a note with that basename
          if (nameMap.has(lowerBasename)) {
            fixed = `[[${basename}]]`;
          }
        } else {
          // Just a plain name – remove brackets
          fixed = basename; // plain text
        }
      }

      if (fixed) {
        replacements.push({ original, fixed });
      }
    }

    if (replacements.length === 0) {
      return res.json({
        success: true,
        message: "No fixable broken links found in this note.",
      });
    }

    // Apply replacements
    for (const { original, fixed } of replacements) {
      content = content.replace(original, fixed);
    }

    // Clean up extra newlines
    content = content.replace(/\n{3,}/g, "\n\n");
    fs.writeFileSync(fullPath, content, "utf8");

    // Refresh cache
    refreshBrokenLinks();

    // Broadcast the change so the viewer live-updates.
    broadcastSSE("fileChanged", {
      path: notePath.replace(/\\/g, "/"),
      content,
      replacements,
    });

    res.json({ success: true, fixed: replacements.length, notePath });
  } catch (err) {
    console.error("Fix error:", err);
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
