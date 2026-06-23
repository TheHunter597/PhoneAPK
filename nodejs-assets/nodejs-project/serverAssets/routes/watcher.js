// Mobile patch: this file reads vaultPath/backupRoot via the live
// getters on serverAssets/config.js (which delegates to runtimeConfig.js)
// so that a runtime vault path change (after the user picks a new
// folder via SAF) is visible to all route handlers without restarting
// Express.

// (routes/watcher.js) Provides API endpoints for managing the vault watcher,
// which monitors changes in the vault and processes notes by compressing
// images, applying links, and fixing broken links. Includes endpoints to
// check status, start, stop, and update settings for the watcher. The watcher
// is initialized based on configuration and can be controlled via API calls.
// Settings changes are persisted to config.json.

const express = require("express");
const router = express.Router();
const fs = require("fs");
const path = require("path");
const { getNoteNames } = require("../../scripts/scraper");
const VaultWatcher = require("../../scripts/watcher");
const config = require("../config");
const innerConfig = config.config;
const { broadcastSSE } = require("./sse");

let watcherConfig = {
  enabled: false,
  quality: 85,
  format: "webp",
  linkerEnabled: false,
  fixBrokenLinks: false,
  ...(innerConfig.watcher || {}),
};

let watcher = null;

// Persist the current in-memory watcher config back to config.json so that
// changes survive a server restart.
function persistWatcherConfig() {
  try {
    const raw = fs.existsSync(config.CONFIG_FILE)
      ? fs.readFileSync(config.CONFIG_FILE, "utf8")
      : "{}";
    const parsed = JSON.parse(raw);
    parsed.watcher = watcherConfig;
    fs.writeFileSync(config.CONFIG_FILE, JSON.stringify(parsed, null, 2), "utf8");
  } catch (err) {
    console.warn("⚠️ Could not persist watcher config:", err.message);
  }
}

function createWatcher() {
  return new VaultWatcher(config.vaultPath, {
    quality: watcherConfig.quality || 85,
    outputFormat: watcherConfig.format || "webp",
    linkerEnabled: watcherConfig.linkerEnabled || false,
    fixBrokenLinks: watcherConfig.fixBrokenLinks || false,
    broadcast: broadcastSSE,
  });
}

function initWatcher() {
  if (watcher) watcher.stop();
  if (watcherConfig.enabled) {
    watcher = createWatcher();
    watcher.start();
  } else {
    watcher = null;
  }
}

router.get("/watcher/status", (req, res) => {
  if (!watcher) {
    return res.json({ running: false, enabled: false });
  }
  res.json(watcher.getStatus());
});

router.get("/refresh-notes", (req, res) => {
  try {
    const noteNames = getNoteNames(config.vaultPath, config.DATA_DIR);
    if (watcher) {
      watcher.noteNamesCache = [];
      watcher.cacheTimestamp = 0;
    }
    res.json({ success: true, count: noteNames.length, names: noteNames });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.post("/watcher/start", (req, res) => {
  if (!watcher) {
    watcher = createWatcher();
    watcher.start();
    watcherConfig.enabled = true;
  } else if (!watcher.isRunning) {
    watcher.start();
    watcherConfig.enabled = true;
  }
  persistWatcherConfig();
  res.json({ success: true, running: watcher.isRunning });
});

router.post("/watcher/stop", (req, res) => {
  if (watcher && watcher.isRunning) {
    watcher.stop();
    watcherConfig.enabled = false;
  }
  persistWatcherConfig();
  res.json({ success: true, running: false });
});

router.post("/watcher/settings", (req, res) => {
  const { quality, format, linkerEnabled, fixBrokenLinks } = req.body;
  if (quality !== undefined) {
    watcherConfig.quality = Math.min(
      100,
      Math.max(10, parseInt(quality) || 85),
    );
  }
  if (format !== undefined && ["webp", "jpeg"].includes(format)) {
    watcherConfig.format = format;
  }
  if (linkerEnabled !== undefined) {
    watcherConfig.linkerEnabled = !!linkerEnabled;
  }
  if (fixBrokenLinks !== undefined) {
    watcherConfig.fixBrokenLinks = !!fixBrokenLinks;
  }
  if (watcher && watcher.isRunning) {
    watcher.stop();
    watcher = createWatcher();
    watcher.start();
  }
  persistWatcherConfig();
  res.json({ success: true, settings: watcherConfig });
});

module.exports = {
  router,
  initWatcher,
};
