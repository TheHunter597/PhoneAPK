// (scripts/scraper.js) Recursively scans the vault for .md files, excluding ignored notes and folders, and writes the note names to a text file. Can be run standalone or imported as a module.

const fs = require("fs");
const path = require("path");

// Folders to ignore while scanning
const IGNORED_DIRS = new Set([
  ".git",
  ".claude",
  ".claudian",
  ".trash",
  "node_modules",
]);

/**
 * Check if a note name should be ignored (existing logic)
 */
function isIgnoredNote(name) {
  const lower = name.toLowerCase();
  const exactIgnores = new Set([
    "readme",
    "contributing",
    "important",
    "importants",
    "main",
    "test",
    "tests",
    "index",
    "control",
    "home",
    "welcome",
  ]);
  if (exactIgnores.has(lower)) return true;
  if (lower.startsWith("untitled")) return true;
  return false;
}

/**
 * Recursively gather all .md filenames (without extension) from a directory,
 * excluding ignored notes and skipping ignored folders.
 */
function getAllMdFiles(dir, relativePath = "") {
  let results = [];
  const items = fs.readdirSync(dir);

  for (const item of items) {
    const fullPath = path.join(dir, item);
    const stat = fs.statSync(fullPath);
    const relPath = path.join(relativePath, item);

    if (stat.isDirectory()) {
      // Skip ignored directories
      if (!IGNORED_DIRS.has(item) && !item.startsWith(".")) {
        results = results.concat(getAllMdFiles(fullPath, relPath));
      }
    } else if (stat.isFile() && item.endsWith(".md")) {
      const noteName = item.slice(0, -3);
      if (!isIgnoredNote(noteName)) {
        results.push(noteName);
      }
    }
  }
  return results;
}

/**
 * Wrapper that gathers names, writes to file, and returns the array.
 */
function getNoteNames(vaultDir, outputDir = ".") {
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }
  const outputFile = path.join(outputDir, "note-names.txt");
  const noteNames = getAllMdFiles(vaultDir);
  fs.writeFileSync(outputFile, noteNames.join("\n"), "utf8");
  console.log(`✅ Scraped ${noteNames.length} notes from "${vaultDir}"`);
  return noteNames;
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const vaultDir = args[0] || ".";
  const outputDir = args[1] || ".";
  getNoteNames(vaultDir, outputDir);
}

module.exports = { getNoteNames };
