// (scripts/brokenLinkFixer.js) — DEPRECATED.
//
// This module previously fixed broken links by reading + writing the note file
// directly. It is no longer used by the watcher, which now applies broken-link
// fixing in-memory (composing with image compression and the auto-linker) via
// VaultWatcher._fixBrokenLinksInMemory(). The on-demand /api/broken-links/fix
// endpoint also implements its own (smarter) in-memory fixing.
//
// Kept for backward compatibility only. Do not use in new code.
//
// Original behaviour: only stripped brackets from plain note names (no path,
// no extension) that did not exist as notes.

const path = require("path");
const fs = require("fs");
const { buildNoteMaps } = require("./brokenLinks");

/**
 * @deprecated Use VaultWatcher._fixBrokenLinksInMemory or the
 * /api/broken-links/fix endpoint instead.
 */
function fixBrokenLinksInNote(notePath, vaultPath) {
  const fullPath = path.join(vaultPath, notePath + ".md");
  if (!fs.existsSync(fullPath)) return { fixed: 0, modifications: [] };
  let content = fs.readFileSync(fullPath, "utf8");
  const { nameMap, pathMap } = buildNoteMaps(vaultPath);

  const linkRegex = /\[\[([^\]]+)\]\]/g;
  const modifications = [];
  let match;
  let modified = false;
  while ((match = linkRegex.exec(content)) !== null) {
    const original = match[0];
    const link = match[1].trim();
    const lowerLink = link.toLowerCase();

    // ---- Skip links with slashes (paths) or extensions ----
    if (link.includes("/") || link.includes("\\")) continue;
    const ext = path.extname(link);
    if (ext) continue;

    // Check if already valid (exists as a note)
    if (nameMap.has(lowerLink)) continue;

    // Broken plain note link – remove brackets
    const fixed = link; // plain text
    modifications.push({ original, fixed });
    modified = true;
    console.log(`🔨 Fixing: "${original}" → "${fixed}"`);
  }

  if (!modified) return { fixed: 0, modifications: [] };

  // Apply replacements to content
  let newContent = content;
  for (const { original, fixed } of modifications) {
    newContent = newContent.split(original).join(fixed);
  }
  newContent = newContent.replace(/\n{3,}/g, "\n\n");
  fs.writeFileSync(fullPath, newContent, "utf8");
  return { fixed: modifications.length, modifications };
}

module.exports = { fixBrokenLinksInNote };
