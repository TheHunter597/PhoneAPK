// (scripts/linker.js) Provides functions for applying Obsidian-style links to note content.

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Apply Obsidian-style links [[Title]] to any occurrence of a note title in the text.
 * Avoids linking inside existing [[...]] or ![[...]], and avoids linking in file paths.
 * @param {string} text - the note content
 * @param {string[]} noteNames - list of note titles (without .md)
 * @returns {string} - text with links applied
 */
function applyLinks(text, noteNames) {
  if (!noteNames || noteNames.length === 0) return text;

  // Build a map: lowercase -> exact title (preserves capitalization)
  const nameMap = new Map();
  const escapedNames = [];
  for (const name of noteNames) {
    const lower = name.toLowerCase();
    if (!nameMap.has(lower)) {
      nameMap.set(lower, name);
      escapedNames.push(escapeRegex(name));
    }
  }

  // Regex: match whole words that are:
  // - NOT already inside [[...]] or ![[...]] (negative lookbehind/lookahead)
  // - NOT preceded by a slash or backslash (to avoid paths like /title/)
  // - NOT followed by a slash or backslash (to avoid paths like title/)
  const pattern =
    "(?<!\\[\\[)(?<![\\\\/])\\b(" +
    escapedNames.join("|") +
    ")\\b(?!\\]\\])(?![\\\\/])";
  const regex = new RegExp(pattern, "gi");

  return text.replace(regex, (match) => {
    const lower = match.toLowerCase();
    const exact = nameMap.get(lower) || match;
    return "[[" + exact + "]]";
  });
}

module.exports = { applyLinks };
