// (scripts/watcher.js) Watches for changes in the vault and processes notes
// by compressing images, applying links, and fixing broken links. Uses
// chokidar for file watching and sharp for image processing. Maintains a
// cache of note names for linking and broadcasts changes to connected clients.
//
// IMPORTANT: all three transformations (image compression, auto-linker, broken
// link fixing) are applied to the same in-memory string before a single write,
// so they compose correctly. The previous implementation called
// fixBrokenLinksInNote() which read+wrote the original file, discarding the
// image-compression and linker changes — a silent data-loss bug.

// Mobile patch: chokidar (native fsevents) is unavailable on Android, so we
// use a polling-based watcher with the same .on()/.close() API.
const chokidar = require("../pollingWatcher");
const fs = require("fs-extra");
const path = require("path");
// Mobile patch: 'sharp' is a local shim package that re-exports @img/sharp-wasm32.
// See nodejs-assets/nodejs-project/node_modules/sharp/index.js
const sharp = require("sharp");
const { applyLinks } = require("./linker");
const { buildNoteMaps } = require("./brokenLinks");
// markHandled tells the live-preview watcher to skip its broadcast for a file
// we already handled (avoids a redundant full-content re-render that causes
// scroll-to-top jumps).
let markHandled = null;
try {
  markHandled = require("./livePreviewWatcher").markHandled;
} catch (e) {
  // livePreviewWatcher not available — no-op
  markHandled = () => {};
}

const IGNORED_DIRS = new Set([
  ".git",
  ".claude",
  ".claudian",
  ".trash",
  "node_modules",
]);

class VaultWatcher {
  constructor(vaultPath, options = {}) {
    this.vaultPath = vaultPath;
    this.quality = options.quality || 85;
    this.outputFormat = options.outputFormat || "webp";
    this.linkerEnabled = options.linkerEnabled || false;
    this.fixBrokenLinks = options.fixBrokenLinks || false;
    this.processing = new Set();
    this.debounceTimers = new Map();
    this.watcher = null;
    this.isRunning = false;
    this.broadcast = options.broadcast || null;
    this.skipNextChange = new Set();

    this.ignored = options.ignored || [
      "**/.git/**",
      "**/.claude/**",
      "**/.claudian/**",
      "**/.trash/**",
      "**/node_modules/**",
      // Ignore ALL dotfolders (.obsidian, .stfolder, etc.) and dotfiles
      "**/.*",
      "**/.*/**",
    ];
    this.noteNamesCache = [];
    this.cacheTimestamp = 0;
    this.cacheExpiry = 5 * 60 * 1000;
    this.scrapeDebounceTimer = null;
    // Cache for broken-link resolution maps (rebuilt lazily).
    this._noteMapsCache = null;
    this._noteMapsCacheTime = 0;
    this._fileMapCache = null;
    this._fileMapCacheTime = 0;
  }

  start() {
    if (this.isRunning) return;
    this.watcher = chokidar.watch(this.vaultPath, {
      persistent: true,
      ignoreInitial: true,
      ignored: this.ignored,
      awaitWriteFinish: { stabilityThreshold: 300, pollInterval: 100 },
      ignorePermissionErrors: true,
    });

    this.watcher
      .on("add", this.handleAdd.bind(this))
      .on("change", this.handleChange.bind(this));

    this.isRunning = true;
    console.log(`👀 Watcher started on ${this.vaultPath}`);
    console.log(`   Quality: ${this.quality}%, Format: ${this.outputFormat}`);
    console.log(`   Linker: ${this.linkerEnabled ? "ON" : "OFF"}`);
    console.log(`   Fix Broken Links: ${this.fixBrokenLinks ? "ON" : "OFF"}`);
    return true;
  }

  stop() {
    if (this.watcher) {
      this.watcher.close();
      this.isRunning = false;
      for (const [file, timer] of this.debounceTimers) {
        clearTimeout(timer);
      }
      this.debounceTimers.clear();
      if (this.scrapeDebounceTimer) {
        clearTimeout(this.scrapeDebounceTimer);
        this.scrapeDebounceTimer = null;
      }
      this.skipNextChange.clear();
      console.log("👀 Watcher stopped");
    }
    return true;
  }

  async getNoteNames(forceRefresh = false) {
    const now = Date.now();
    const noteNamesFile = path.join(__dirname, "..", "data", "note-names.txt");

    let shouldScrape = forceRefresh;
    if (!shouldScrape && this.noteNamesCache.length === 0) {
      shouldScrape = true;
    }
    if (!shouldScrape && now - this.cacheTimestamp > this.cacheExpiry) {
      shouldScrape = true;
    }
    if (!shouldScrape) {
      try {
        const stats = await fs.stat(noteNamesFile);
        if (now - stats.mtimeMs > this.cacheExpiry) {
          shouldScrape = true;
        }
      } catch (err) {
        shouldScrape = true;
      }
    }

    if (!shouldScrape) {
      return this.noteNamesCache;
    }

    let names = [];
    try {
      console.log("🔄 Scraping vault for note names...");
      const { getNoteNames } = require("./scraper");
      const outputDir = path.join(__dirname, "..", "data");
      names = getNoteNames(this.vaultPath, outputDir);
      this.noteNamesCache = names;
      this.cacheTimestamp = now;
      console.log(`📋 Loaded ${names.length} note names for linking.`);
    } catch (err) {
      console.error("Failed to scrape note names:", err.message);
      if (this.noteNamesCache.length > 0) {
        console.warn("⚠️ Using stale cache due to scrape failure.");
        return this.noteNamesCache;
      }
      return [];
    }
    return names;
  }

  /**
   * Lazily build (and cache for 5 min) the note maps + file map used by the
   * broken-link fixer. Walking the whole vault on every note change is too
   * expensive.
   */
  getResolutionMaps() {
    const now = Date.now();
    const TTL = 5 * 60 * 1000;
    if (
      !this._noteMapsCache ||
      now - this._noteMapsCacheTime > TTL
    ) {
      this._noteMapsCache = buildNoteMaps(this.vaultPath);
      this._noteMapsCacheTime = now;
    }
    if (
      !this._fileMapCache ||
      now - this._fileMapCacheTime > TTL
    ) {
      this._fileMapCache = this._buildFileMap(this.vaultPath);
      this._fileMapCacheTime = now;
    }
    return {
      nameMap: this._noteMapsCache.nameMap,
      pathMap: this._noteMapsCache.pathMap,
      fileMap: this._fileMapCache,
    };
  }

  _buildFileMap(dir, basePath = "", map = new Map()) {
    const items = fs.readdirSync(dir);
    for (const item of items) {
      const fullPath = path.join(dir, item);
      const stat = fs.statSync(fullPath);
      const relPath = path.join(basePath, item);
      if (stat.isDirectory()) {
        if (IGNORED_DIRS.has(item) || item.startsWith(".")) continue;
        this._buildFileMap(fullPath, relPath, map);
      } else if (stat.isFile()) {
        const basename = path.basename(item);
        const lower = basename.toLowerCase();
        if (!map.has(lower)) {
          map.set(lower, relPath);
        }
      }
    }
    return map;
  }

  /**
   * Apply the same smart broken-link fixing logic as the /api/broken-links/fix
   * endpoint, but IN MEMORY on the given content string. Returns
   * { content, modifications }.
   */
  _fixBrokenLinksInMemory(content) {
    const { nameMap, pathMap, fileMap } = this.getResolutionMaps();
    const linkRegex = /\[\[([^\]]+)\]\]/g;
    const modifications = [];
    let match;
    let newContent = content;
    while ((match = linkRegex.exec(content)) !== null) {
      const original = match[0];
      const link = match[1].trim();
      const lowerLink = link.toLowerCase();

      // Already valid?
      let exists = false;
      if (link.includes("/") || link.includes("\\")) {
        exists = pathMap.has(lowerLink);
      } else {
        exists = nameMap.has(lowerLink);
      }
      if (exists) continue;

      const basename = path.basename(link);
      const lowerBasename = basename.toLowerCase();
      const ext = path.extname(basename).toLowerCase();

      let fixed = null;
      if (ext) {
        if (fileMap.has(lowerBasename)) {
          fixed = `[[${basename}]]`;
        }
      } else {
        if (link.includes("/") || link.includes("\\")) {
          if (nameMap.has(lowerBasename)) {
            fixed = `[[${basename}]]`;
          }
        } else {
          // Plain broken note name – strip brackets.
          fixed = basename;
        }
      }

      if (fixed) {
        modifications.push({ original, fixed });
        newContent = newContent.split(original).join(fixed);
      }
    }
    if (modifications.length > 0) {
      newContent = newContent.replace(/\n{3,}/g, "\n\n");
    }
    return { content: newContent, modifications };
  }

  async handleAdd(filePath) {
    if (filePath.endsWith(".md")) {
      if (this.scrapeDebounceTimer) clearTimeout(this.scrapeDebounceTimer);
      this.scrapeDebounceTimer = setTimeout(async () => {
        this.scrapeDebounceTimer = null;
        console.log("🔄 New .md file detected – refreshing note names.");
        await this.getNoteNames(true);
      }, 5000);
    }
    this.handleChange(filePath);
  }

  async handleChange(filePath) {
    if (!filePath.endsWith(".md")) return;

    if (this.skipNextChange.has(filePath)) {
      this.skipNextChange.delete(filePath);
      console.log(
        `⏭️ Skipping self‑triggered change for ${path.basename(filePath)}`,
      );
      return;
    }

    if (this.debounceTimers.has(filePath)) {
      clearTimeout(this.debounceTimers.get(filePath));
    }
    this.debounceTimers.set(
      filePath,
      setTimeout(async () => {
        this.debounceTimers.delete(filePath);
        if (this.processing.has(filePath)) return;
        this.processing.add(filePath);
        try {
          await this.processNote(filePath);
        } catch (err) {
          console.error(`Error processing ${filePath}:`, err);
        } finally {
          this.processing.delete(filePath);
        }
      }, 500),
    );
  }

  async processNote(filePath) {
    const originalContent = await fs.readFile(filePath, "utf8");
    let newContent = originalContent;
    let updated = false;
    let modifications = [];

    // ---- QUICK CHECK: will we modify this file? ----
    // If yes, call markHandled IMMEDIATELY (before slow compression) so the
    // live-preview watcher skips its broadcast. This prevents a race condition
    // where the live-preview watcher fires during compression and causes a
    // full re-render + scroll jump.
    const hasPngs = /!\[\[.*?\.png\]\]/i.test(originalContent);
    const willProcess =
      hasPngs || this.linkerEnabled || this.fixBrokenLinks;
    if (willProcess) {
      markHandled(filePath);
    }

    // ---------- 1. Image compression ----------
    const imageRegex = /!\[\[(.*?)\]\]|!\[.*?\]\((.*?)\)/g;
    let match;
    const replacements = [];

    while ((match = imageRegex.exec(originalContent)) !== null) {
      let imagePath = match[1] || match[2];
      if (!imagePath) continue;
      const ext = path.extname(imagePath).toLowerCase();
      if (ext !== ".png") continue;

      const noteDir = path.dirname(filePath);
      let absPath = path.resolve(noteDir, imagePath);
      if (!(await fs.pathExists(absPath))) {
        absPath = path.resolve(this.vaultPath, imagePath);
        if (!(await fs.pathExists(absPath))) {
          console.warn(`⚠️ Image not found: ${imagePath} in ${filePath}`);
          continue;
        }
      }

      const baseName = path.basename(imagePath, ".png");
      const assetsDir = path.join(noteDir, "assets");
      await fs.ensureDir(assetsDir);
      const outputFileName = `${baseName}.${this.outputFormat}`;
      const outputPath = path.join(assetsDir, outputFileName);

      try {
        await sharp(absPath)
          .toFormat(this.outputFormat, { quality: this.quality })
          .toFile(outputPath);
        console.log(`✅ Compressed ${imagePath} → ${outputPath}`);
      } catch (err) {
        console.error(`❌ Compression failed for ${imagePath}:`, err);
        continue;
      }

      const newLink = `![[${outputFileName}]]`;
      replacements.push({ old: match[0], new: newLink, absPath });
    }

    if (replacements.length > 0) {
      for (const { old, new: newLink } of replacements) {
        newContent = newContent.split(old).join(newLink);
      }
      updated = true;
    }

    // ---------- 2. Auto‑linker ----------
    if (this.linkerEnabled) {
      const noteNames = await this.getNoteNames(false);
      if (noteNames.length > 0) {
        const linkedContent = applyLinks(newContent, noteNames);
        if (linkedContent !== newContent) {
          newContent = linkedContent;
          updated = true;
          console.log(`🔗 Applied links in ${path.basename(filePath)}`);
        } else {
          console.log(`ℹ️ No new links found in ${path.basename(filePath)}`);
        }
      } else {
        console.warn(
          `⚠️ No note names available for linking in ${path.basename(filePath)}`,
        );
      }
    }

    // ---------- 3. Fix broken links (IN MEMORY, composes with 1 & 2) ----------
    if (this.fixBrokenLinks) {
      const result = this._fixBrokenLinksInMemory(newContent);
      if (result.modifications.length > 0) {
        newContent = result.content;
        modifications = result.modifications;
        updated = true;
        console.log(
          `🔧 Fixed ${modifications.length} broken links in ${path.basename(filePath)}`,
        );
      }
    }

    // ---------- Write once, with all transformations composed ----------
    if (updated) {
      await fs.writeFile(filePath, newContent, "utf8");
      this.skipNextChange.add(filePath);
      console.log(`💾 Updated note: ${path.basename(filePath)}`);
    }

    // ---------- Delete original PNGs after successful compression ----------
    // The WebP files already exist in assets/, and the note links are updated.
    // We delete the originals AFTER the write succeeds so a write failure
    // doesn't leave orphaned links. Retries handle Windows file-locking where
    // sharp may briefly hold a handle on the source file.
    for (const { absPath } of replacements) {
      try {
        if (!(await fs.pathExists(absPath))) continue;
        let deleted = false;
        for (let attempt = 0; attempt < 5; attempt++) {
          try {
            await fs.remove(absPath);
            deleted = true;
            break;
          } catch (e) {
            // File may be locked by another process (sharp, antivirus, etc.)
            // Wait 300ms and retry.
            await new Promise((r) => setTimeout(r, 300));
          }
        }
        if (deleted) {
          console.log(`🗑️ Deleted original: ${absPath}`);
        } else {
          console.error(`❌ Failed to delete after 5 attempts: ${absPath}`);
        }
      } catch (err) {
        console.error(`Failed to delete ${absPath}:`, err);
      }
    }

    // Invalidate the image cache so the viewer picks up the new WebP files
    // and stops referencing the deleted PNGs.
    if (replacements.length > 0) {
      try {
        const vaultRouter = require("../serverAssets/routes/vault");
        if (vaultRouter.invalidateImageCache) {
          vaultRouter.invalidateImageCache();
        }
      } catch (e) {
        // ignore
      }
    }

    // ---- Broadcast the file change ----
    // Strategy:
    //   - If image replacements happened: broadcast replacements[] so the
    //     viewer patches <img> src in-place — no re-render, no scroll jump.
    //   - If broken-link modifications happened: broadcast those replacements
    //     (viewer patches text in-place).
    //   - If linker-only changes: broadcast full content (viewer re-renders
    //     with anchor-based scroll preservation).
    //   - If NOTHING changed but willProcess was true (we called markHandled):
    //     broadcast the content so the live-preview isn't lost. The viewer
    //     will re-render but this is rare (only when the watcher thought it
    //     would modify but didn't actually change anything).
    if (this.broadcast) {
      const relPath = path.relative(this.vaultPath, filePath);
      const notePath = relPath.slice(0, -3).replace(/\\/g, "/");

      const imageReplacements = replacements.map(({ old, new: newLink }) => ({
        original: old,
        fixed: newLink,
      }));

      const onlyImagesChanged =
        imageReplacements.length > 0 && modifications.length === 0;

      const payload = {
        path: notePath,
        content: newContent,
      };

      if (onlyImagesChanged) {
        // Image-only change: send replacements so the viewer patches in-place
        // (no re-render, no scroll jump — same as broken-link-fixer).
        payload.replacements = imageReplacements;
        this.broadcast("fileChanged", payload);
        console.log(
          `📡 Broadcasted image replacements for: ${notePath} (in-place patch)`,
        );
      } else if (modifications.length > 0) {
        // Broken-link changes: send those replacements (viewer patches in-place)
        payload.replacements = modifications;
        this.broadcast("fileChanged", payload);
        console.log(
          `📡 Broadcasted broken-link replacements for: ${notePath} (in-place patch)`,
        );
      } else if (updated) {
        // Linker-only changes: full content re-render.
        this.broadcast("fileChanged", payload);
        console.log(`📡 Broadcasted file change: ${notePath} (content included)`);
      } else if (willProcess) {
        // We called markHandled but didn't actually modify the file (e.g. no
        // PNGs found, or linker found nothing). Broadcast the content so the
        // viewer still gets the live-preview update.
        this.broadcast("fileChanged", payload);
        console.log(`📡 Broadcasted (no-change fallback): ${notePath}`);
      }
    }
  }

  getStatus() {
    return {
      running: this.isRunning,
      vaultPath: this.vaultPath,
      quality: this.quality,
      format: this.outputFormat,
      linkerEnabled: this.linkerEnabled,
      fixBrokenLinks: this.fixBrokenLinks,
      ignored: this.ignored,
      cacheSize: this.noteNamesCache.length,
      cacheAge:
        Math.round((Date.now() - this.cacheTimestamp) / 1000 / 60) + " min",
    };
  }
}

module.exports = VaultWatcher;
