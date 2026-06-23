// (scripts/htmlwatcher.js) Watches for changes in the vault and processes HTML links in Markdown files.

// Mobile patch: chokidar (native fsevents) is unavailable on Android, so we
// use a polling-based watcher with the same .on()/.close() API.
const chokidar = require("../pollingWatcher");
const fs = require("fs-extra");
const path = require("path");

const IGNORED_DIRS = new Set([
  ".git",
  ".claude",
  ".claudian",
  ".trash",
  "node_modules",
]);

class HtmlWatcher {
  constructor(vaultPath, options = {}) {
    this.vaultPath = vaultPath;
    this.processing = new Set();
    this.debounceTimers = new Map();
    this.watcher = null;
    this.isRunning = false;
    this.ignored = options.ignored || [
      "**/.git/**",
      "**/.claude/**",
      "**/.claudian/**",
      "**/.trash/**",
      "**/node_modules/**",
      "**/.*",
      "**/.*/**",
    ];
  }

  start() {
    if (this.isRunning) return;
    this.watcher = chokidar.watch(this.vaultPath, {
      persistent: true,
      ignoreInitial: true,
      ignored: this.ignored,
      awaitWriteFinish: { stabilityThreshold: 500, pollInterval: 100 },
      ignorePermissionErrors: true,
    });

    this.watcher
      .on("add", this.handleChange.bind(this))
      .on("change", this.handleChange.bind(this));

    this.isRunning = true;
    console.log(`👀 HTML Watcher started on ${this.vaultPath}`);
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
      console.log("👀 HTML Watcher stopped");
    }
    return true;
  }

  /**
   * Find a file in the vault by its base name (recursively).
   * Returns absolute path or null.
   */
  async findFileInVault(filename) {
    const walk = async (dir) => {
      const items = await fs.readdir(dir, { withFileTypes: true });
      for (const item of items) {
        const fullPath = path.join(dir, item.name);
        if (item.isDirectory()) {
          if (IGNORED_DIRS.has(item.name) || item.name.startsWith(".")) continue;
          const result = await walk(fullPath);
          if (result) return result;
        } else if (item.isFile() && item.name === filename) {
          return fullPath;
        }
      }
      return null;
    };
    return walk(this.vaultPath);
  }

  handleChange(filePath) {
    if (!filePath.endsWith(".md")) return;
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
          console.error(`HTML Watcher error processing ${filePath}:`, err);
        } finally {
          this.processing.delete(filePath);
        }
      }, 1000),
    );
  }

  async processNote(filePath) {
    const content = await fs.readFile(filePath, "utf8");
    let newContent = content;
    let updated = false;

    const htmlRegex = /!\[\[(.*?\.html)\]\]/g;
    let match;
    const replacements = [];

    while ((match = htmlRegex.exec(content)) !== null) {
      const htmlPath = match[1].trim();
      if (!htmlPath) continue;

      const noteDir = path.dirname(filePath);
      let absPath = null;

      // 1. Check if the path is absolute (e.g., C:/Users/... or /home/...)
      if (path.isAbsolute(htmlPath)) {
        if (await fs.pathExists(htmlPath)) {
          absPath = htmlPath;
          console.log(`📁 Found HTML at absolute path: ${absPath}`);
        }
      }

      // 2. Try relative to note directory
      if (!absPath) {
        const noteRelative = path.resolve(noteDir, htmlPath);
        if (await fs.pathExists(noteRelative)) {
          absPath = noteRelative;
        }
      }

      // 3. Try relative to vault root
      if (!absPath) {
        const vaultRelative = path.resolve(this.vaultPath, htmlPath);
        if (await fs.pathExists(vaultRelative)) {
          absPath = vaultRelative;
        }
      }

      // 4. Last resort: search the entire vault by base filename
      if (!absPath) {
        const filename = path.basename(htmlPath);
        const found = await this.findFileInVault(filename);
        if (found) {
          absPath = found;
          console.log(`🔍 Found HTML by scanning vault: ${absPath}`);
        }
      }

      if (!absPath) {
        console.warn(`⚠️ HTML file not found: ${htmlPath} in ${filePath}`);
        continue;
      }

      // Copy to assets folder
      const assetsDir = path.join(noteDir, "assets");
      await fs.ensureDir(assetsDir);
      const fileName = path.basename(htmlPath);
      const destPath = path.join(assetsDir, fileName);

      // Only copy if not already in the correct location
      if (absPath !== destPath) {
        try {
          await fs.copy(absPath, destPath, { overwrite: true });
          console.log(`📄 HTML copied: ${absPath} → ${destPath}`);
        } catch (err) {
          console.error(`❌ Failed to copy HTML ${htmlPath}:`, err);
          continue;
        }
      }

      // Generate relative path from vault root (for the code block)
      const relPath = path
        .relative(this.vaultPath, destPath)
        .replace(/\\/g, "/");
      const codeBlock = `\`\`\`html-embed\n${relPath}\n\`\`\``;
      replacements.push({ old: match[0], new: codeBlock });
    }

    for (const { old, new: newBlock } of replacements) {
      newContent = newContent.replace(old, newBlock);
      updated = true;
    }

    if (updated) {
      await fs.writeFile(filePath, newContent, "utf8");
      console.log(`💾 HTML links updated in ${path.basename(filePath)}`);
    }
  }

  getStatus() {
    return {
      running: this.isRunning,
      vaultPath: this.vaultPath,
    };
  }
}

module.exports = HtmlWatcher;
