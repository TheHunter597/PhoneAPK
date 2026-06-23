// Mobile patch: this file reads vaultPath/backupRoot via the live
// getters on serverAssets/config.js (which delegates to runtimeConfig.js)
// so that a runtime vault path change (after the user picks a new
// folder via SAF) is visible to all route handlers without restarting
// Express.

// (routes/htmlWatcher.js) Provides API endpoints for managing the HTML watcher, which monitors changes in the vault and processes HTML links in Markdown files. Includes endpoints to check status, start, and stop the watcher. The watcher is initialized based on configuration and can be controlled via API calls.

const express = require("express");
const router = express.Router();
const HtmlWatcher = require("../../scripts/htmlWatcher");
const config = require("../config");
const innerConfig = config.config;
let htmlWatcherConfig = innerConfig.htmlWatcher || { enabled: false };
let htmlWatcher = null;

function initHtmlWatcher() {
  if (htmlWatcher) {
    htmlWatcher.stop();
  }
  if (htmlWatcherConfig.enabled) {
    htmlWatcher = new HtmlWatcher(config.vaultPath);
    htmlWatcher.start();
  } else {
    htmlWatcher = null;
  }
}

router.get("/htmlwatcher/status", (req, res) => {
  if (!htmlWatcher) {
    return res.json({ running: false, enabled: false });
  }
  res.json(htmlWatcher.getStatus());
});

router.post("/htmlwatcher/start", (req, res) => {
  if (!htmlWatcher) {
    htmlWatcher = new HtmlWatcher(config.vaultPath);
    htmlWatcher.start();
    htmlWatcherConfig.enabled = true;
  } else if (!htmlWatcher.isRunning) {
    htmlWatcher.start();
    htmlWatcherConfig.enabled = true;
  }
  res.json({ success: true, running: htmlWatcher.isRunning });
});

router.post("/htmlwatcher/stop", (req, res) => {
  if (htmlWatcher && htmlWatcher.isRunning) {
    htmlWatcher.stop();
    htmlWatcherConfig.enabled = false;
  }
  res.json({ success: true, running: false });
});

module.exports = {
  router,
  initHtmlWatcher,
};
