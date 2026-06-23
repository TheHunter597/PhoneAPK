// (server.js) Mobile-patched version.
//
// Patches vs. the desktop build:
//   1. Read vaultPath / backupRoot via the live getter exports of
//      serverAssets/config.js (which delegates to runtimeConfig.js). This
//      lets main.js swap the path at runtime after the user picks a vault
//      folder, without restarting Express.
//   2. Mount /vault via a custom middleware that resolves express.static()
//      against the CURRENT vaultPath on every request, so a runtime path
//      change takes effect immediately.
//   3. Expose module.exports.reinitWatchers() so main.js can stop the old
//      live-preview watcher and start a new one on the new vault path.
//   4. Expose module.exports.app / .server for testing.

const express = require("express");
const path = require("path");
const config = require("./serverAssets/config");
// Read these through the live getters — never destructure at module load,
// because the user may pick a different vault folder later.
const DATA_DIR = config.DATA_DIR;
const runtimeConfig = require("./runtimeConfig");

const {
  scheduleBackups,
  runInitialBackupsIfNeeded,
} = require("./serverAssets/backup");
const { router: sseRouter, broadcastSSE } = require("./serverAssets/routes/sse");
const apiRouter = require("./serverAssets/routes/api");
const watcherRoutes = require("./serverAssets/routes/watcher");
const htmlWatcherRoutes = require("./serverAssets/routes/htmlWatcher");
const brokenLinksRouter = require("./serverAssets/routes/brokenLinks");
const vaultRouter = require("./serverAssets/routes/vault");
const LivePreviewWatcher = require("./scripts/livePreviewWatcher");
const { initWatcher } = watcherRoutes;
const { initHtmlWatcher } = htmlWatcherRoutes;

const app = express();
const PORT = process.env.PORT || 4000;

// Middleware
app.use(express.json({ limit: "50mb" }));

// CORS — allow the WebView (and any other local client) to call us.
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
  res.header("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});

// Serve static files from 'public'
app.use(express.static(path.join(__dirname, "public")));

// Serve vault contents (for images, HTML embeds).
// IMPORTANT: we resolve the vault path on EVERY request so that a runtime
// vault path change (after the user picks a new folder) takes effect without
// restarting Express. express.static is safe against path traversal.
app.use("/vault", (req, res, next) => {
  const currentVault = runtimeConfig.getVaultPath();
  express.static(currentVault)(req, res, next);
});

// Schedule backups — uses the live vaultPath via config.js getter.
scheduleBackups();

// Run initial backups after 5 seconds
setTimeout(runInitialBackupsIfNeeded, 5000);

// Initialize the processing watchers (image compression / linker / HTML embeds).
// These read vaultPath lazily on each file change via the config getter, so
// they don't need to be restarted on a vault path change.
initWatcher();
initHtmlWatcher();

// Always-on live-preview watcher. Unlike the processing watchers, this one
// captures vaultPath at construction time (because it passes it to the
// polling watcher), so we DO need to stop+restart it when the path changes.
// reinitWatchers() below handles that.
let livePreviewWatcher = new LivePreviewWatcher(runtimeConfig.getVaultPath(), broadcastSSE);
livePreviewWatcher.start();

const chatRouter = require("./serverAssets/routes/chat");

// API routes
app.use("/api", apiRouter);
app.use("/api", sseRouter); // /api/events
app.use("/api", watcherRoutes.router);
app.use("/api", htmlWatcherRoutes.router);
app.use("/api", brokenLinksRouter);
app.use("/api", vaultRouter);
app.use("/api", chatRouter); // /api/chat — AI assistant

// Main page
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// 404 handler for unknown API routes
app.use("/api", (req, res) => {
  res
    .status(404)
    .json({ success: false, error: `Not found: ${req.method} ${req.path}` });
});

// Centralised error handler
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error("Unhandled error:", err);
  if (res.headersSent) return;
  res
    .status(500)
    .json({ success: false, error: err.message || "Internal server error" });
});

// Start server
const server = app.listen(PORT, () => {
  console.log(`🚀 Server running at http://localhost:${PORT}`);
  console.log(`📂 Serving tools from /public`);
  console.log(`📄 Note names will be saved in ${DATA_DIR}`);
  console.log(`💾 Backups will be stored in ${runtimeConfig.getBackupRoot()}`);
  console.log(`📁 Vault path: ${runtimeConfig.getVaultPath()}`);
  console.log(`📡 Live-preview watcher: active`);
});

/**
 * Stop the old live-preview watcher and start a new one on the current
 * vault path. Called by main.js when the user picks a different vault folder.
 *
 * Also re-runs scheduleBackups() so the cron timers capture the new
 * vaultPath / backupRoot via the live getters.
 */
function reinitWatchers() {
  try {
    if (livePreviewWatcher) {
      livePreviewWatcher.stop();
    }
  } catch (err) {
    console.warn("[server] old live-preview watcher stop failed:", err.message);
  }
  try {
    livePreviewWatcher = new LivePreviewWatcher(runtimeConfig.getVaultPath(), broadcastSSE);
    livePreviewWatcher.start();
  } catch (err) {
    console.error("[server] new live-preview watcher start failed:", err.message);
  }
  try {
    // Re-schedule backups so they pick up the new vaultPath/backupRoot.
    scheduleBackups();
  } catch (err) {
    console.warn("[server] scheduleBackups() on reinit failed:", err.message);
  }
}

module.exports = {
  app,
  server,
  reinitWatchers,
};
