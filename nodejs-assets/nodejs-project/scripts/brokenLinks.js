// (scripts/brokenLinks.js) Scan vault for broken links and return results.

const fs = require("fs");
const path = require("path");

const IGNORED_DIRS = new Set([
  ".git",
  ".claude",
  ".claudian",
  ".trash",
  "node_modules",
]);

/**
 * Build maps of all note paths for quick lookup.
 * Returns { nameMap: Map(lowercaseName -> notePath), pathMap: Map(lowercasePath -> notePath) }
 */
function buildNoteMaps(vaultPath) {
  const nameMap = new Map();
  const pathMap = new Map();

  function walk(dir, basePath = "") {
    const items = fs.readdirSync(dir);
    for (const item of items) {
      const fullPath = path.join(dir, item);
      const stat = fs.statSync(fullPath);
      if (stat.isDirectory()) {
        if (IGNORED_DIRS.has(item) || item.startsWith(".")) continue;
        walk(fullPath, path.join(basePath, item));
      } else if (stat.isFile() && item.endsWith(".md")) {
        const noteName = item.slice(0, -3);
        const notePath = path.join(basePath, noteName);
        const lowerName = noteName.toLowerCase();
        const lowerPath = notePath.toLowerCase();
        if (!nameMap.has(lowerName)) {
          nameMap.set(lowerName, notePath);
        }
        if (!pathMap.has(lowerPath)) {
          pathMap.set(lowerPath, notePath);
        }
      }
    }
  }
  walk(vaultPath);
  return { nameMap, pathMap };
}

/**
 * Scan a single note for broken links.
 * Returns array of broken link strings.
 */
function scanNoteForBrokenLinks(notePath, vaultPath, nameMap, pathMap) {
  const fullPath = path.join(vaultPath, notePath + ".md");
  if (!fs.existsSync(fullPath)) return [];
  const content = fs.readFileSync(fullPath, "utf8");
  const linkRegex = /\[\[([^\]]+)\]\]/g;
  const broken = [];
  let match;
  while ((match = linkRegex.exec(content)) !== null) {
    const link = match[1].trim();
    const lowerLink = link.toLowerCase();
    let exists = false;
    if (link.includes("/") || link.includes("\\")) {
      // Treat as full path
      exists = pathMap.has(lowerLink);
    } else {
      // Treat as note name
      exists = nameMap.has(lowerLink);
    }
    if (!exists) {
      broken.push(link);
    }
  }
  return broken;
}

/**
 * Scan the entire vault for broken links.
 * Returns an object: { [notePath]: [brokenLink1, brokenLink2, ...] }
 */
function scanAllNotes(vaultPath) {
  const { nameMap, pathMap } = buildNoteMaps(vaultPath);
  // Collect all note paths from the pathMap (values are unique note paths)
  const notePaths = new Set(pathMap.values());
  const result = {};
  for (const notePath of notePaths) {
    const broken = scanNoteForBrokenLinks(
      notePath,
      vaultPath,
      nameMap,
      pathMap,
    );
    if (broken.length > 0) {
      result[notePath] = broken;
    }
  }
  return result;
}

module.exports = { scanAllNotes, scanNoteForBrokenLinks, buildNoteMaps };
