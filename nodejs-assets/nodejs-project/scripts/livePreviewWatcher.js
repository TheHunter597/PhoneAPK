// (scripts/livePreviewWatcher.js) Always-on watcher that broadcasts .md file
// changes to all SSE clients for INSTANT live-preview in the web note viewer.
//
// This watcher performs NO modifications — it only reads the changed file and
// broadcasts its content. It is decoupled from the processing VaultWatcher
// (image compression / linker / broken-link-fixer), so live preview works
// even when all processing is disabled.
//
// COORDINATION WITH THE PROCESSING WATCHER:
// The processing VaultWatcher (scripts/watcher.js) debounces at 500ms and
// broadcasts replacements[] for in-place DOM patching (no scroll jump). If
// this live-preview watcher fired at 250ms (faster), it would broadcast the
// raw content first and trigger a full re-render — causing a scroll-to-top
// jump before the processing watcher's in-place patch arrives.
//
// To avoid this, we use a longer debounce (700ms) so the processing watcher
// (500ms) fires FIRST. When the processing watcher handles a file, it sets
// a flag that tells this watcher to skip its broadcast for that file (since
// the processing watcher already broadcast with replacements). If the
// processing watcher is disabled or doesn't handle the file, this watcher
// fires at 700ms as a fallback — slightly slower live preview, but no
// scroll jumps.
//
// Events broadcast:
//   fileChanged  { path, content }   — on .md add/change (debounced 700ms)
//   fileDeleted  { path }            — on .md deletion
//   treeChanged  { }                 — on folder add/remove (sidebar refresh)

// Mobile patch: chokidar (native fsevents) is unavailable on Android, so we
// use a polling-based watcher with the same .on()/.close() API.
const chokidar = require("../pollingWatcher");
const fs = require("fs-extra");
const path = require("path");

const IGNORED = [
  "**/.git/**",
  "**/.claude/**",
  "**/.claudian/**",
  "**/.trash/**",
  "**/node_modules/**",
  // Ignore ALL dotfolders (.obsidian, .stfolder, etc.) and dotfiles
  "**/.*",
  "**/.*/**",
];

// Files recently handled by the processing watcher. The processing watcher
// calls markHandled(filePath) after broadcasting; this watcher checks the
// set and skips its own broadcast for those files (avoiding a duplicate
// full-content re-render that would cause a scroll jump).
const recentlyHandled = new Set();

class LivePreviewWatcher {
  constructor(vaultPath, broadcast) {
    this.vaultPath = vaultPath;
    this.broadcast = broadcast;
    this.watcher = null;
    this.isRunning = false;
    this.debounceTimers = new Map();
    this.processing = new Set();
    this.treeDebounceTimer = null;
    // 700ms debounce: longer than the processing watcher's 500ms so the
    // processing watcher fires first (with replacements) and this watcher
    // can skip files it already handled.
    this.DEBOUNCE_MS = 700;
  }

  start() {
    if (this.isRunning) return;
    this.watcher = chokidar.watch(this.vaultPath, {
      persistent: true,
      ignoreInitial: true,
      ignored: IGNORED,
      // Wait 200ms of write-stability before firing — avoids reading a
      // half-written file when Obsidian saves in chunks.
      awaitWriteFinish: { stabilityThreshold: 200, pollInterval: 50 },
      ignorePermissionErrors: true,
    });

    this.watcher
      .on("add", (f) => this.handleChange(f, "add"))
      .on("change", (f) => this.handleChange(f, "change"))
      .on("unlink", (f) => this.handleUnlink(f))
      .on("addDir", () => this.handleTreeChange())
      .on("unlinkDir", () => this.handleTreeChange());

    this.isRunning = true;
    console.log(`📡 Live-preview watcher started on ${this.vaultPath}`);
  }

  stop() {
    if (this.watcher) {
      this.watcher.close();
      this.isRunning = false;
      for (const [, t] of this.debounceTimers) clearTimeout(t);
      this.debounceTimers.clear();
      if (this.treeDebounceTimer) {
        clearTimeout(this.treeDebounceTimer);
        this.treeDebounceTimer = null;
      }
      console.log("📡 Live-preview watcher stopped");
    }
  }

  relPath(filePath) {
    return path
      .relative(this.vaultPath, filePath)
      .replace(/\\/g, "/")
      .replace(/\.md$/i, "");
  }

  handleChange(filePath, kind) {
    if (!filePath.endsWith(".md")) return;
    if (this.debounceTimers.has(filePath)) {
      clearTimeout(this.debounceTimers.get(filePath));
    }
    this.debounceTimers.set(
      filePath,
      setTimeout(async () => {
        this.debounceTimers.delete(filePath);
        // Skip if the processing watcher already handled this file (it
        // broadcast with replacements, so our full-content broadcast would
        // cause a redundant re-render + scroll jump).
        if (recentlyHandled.has(filePath)) {
          recentlyHandled.delete(filePath);
          return;
        }
        if (this.processing.has(filePath)) return;
        this.processing.add(filePath);
        try {
          const content = await fs.readFile(filePath, "utf8");
          const rel = this.relPath(filePath);
          this.broadcast("fileChanged", { path: rel, content });
          // A brand-new file means the sidebar tree needs refreshing so it
          // appears in the list.
          if (kind === "add") {
            this.handleTreeChange();
          }
        } catch (err) {
          // File may have been deleted mid-read; ignore quietly.
        } finally {
          this.processing.delete(filePath);
        }
      }, this.DEBOUNCE_MS),
    );
  }

  handleUnlink(filePath) {
    if (!filePath.endsWith(".md")) return;
    const rel = this.relPath(filePath);
    this.broadcast("fileDeleted", { path: rel });
    this.handleTreeChange();
  }

  handleTreeChange() {
    // Debounce tree changes (bulk folder operations can fire many events).
    if (this.treeDebounceTimer) clearTimeout(this.treeDebounceTimer);
    this.treeDebounceTimer = setTimeout(() => {
      this.treeDebounceTimer = null;
      this.broadcast("treeChanged", {});
    }, 500);
  }

  getStatus() {
    return {
      running: this.isRunning,
      vaultPath: this.vaultPath,
      debounceMs: this.DEBOUNCE_MS,
    };
  }
}

/**
 * Mark a file as recently handled by the processing watcher. The
 * live-preview watcher will skip its next broadcast for this file to avoid
 * a redundant full-content re-render (which would cause a scroll jump).
 * The entry auto-expires after 2 seconds.
 */
function markHandled(filePath) {
  recentlyHandled.add(filePath);
  // Auto-expire after 2s so the set doesn't grow unbounded and so a later
  // legitimate change to the same file still gets a live-preview broadcast.
  setTimeout(() => recentlyHandled.delete(filePath), 2000);
}

module.exports = LivePreviewWatcher;
module.exports.markHandled = markHandled;
