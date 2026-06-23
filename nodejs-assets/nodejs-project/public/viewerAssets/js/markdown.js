// ======================================================
//  MARKDOWN PROCESSING (js/markdown.js)
// ======================================================

export function stripFrontmatter(content) {
  const lines = content.split("\n");
  if (lines.length > 0 && lines[0].trim() === "---") {
    let endIndex = -1;
    for (let i = 1; i < lines.length; i++) {
      if (lines[i].trim() === "---") {
        endIndex = i;
        break;
      }
    }
    if (endIndex !== -1) {
      return lines.slice(endIndex + 1).join("\n");
    }
  }
  return content;
}

// ======================================================
//  PROCESS OBSIDIAN EMBEDS (![[...]]) – images only
// ======================================================
export function processObsidianEmbeds(content, notePath) {
  const embedRegex = /!\[\[([^\]]+)\]\]/g;
  return content.replace(embedRegex, (match, p1) => {
    const ext = p1.split(".").pop().toLowerCase();
    const imageExtensions = [
      "png",
      "jpg",
      "jpeg",
      "gif",
      "webp",
      "svg",
      "bmp",
      "tiff",
      "ico",
      "avif",
    ];

    // If it's not an image, just return the link as a text note
    if (!imageExtensions.includes(ext)) {
      return `\n📎 ${p1}\n`;
    }

    const imageMap = window.imageMap || {};
    let relPath = null;

    // Try 1: exact match (full path as stored)
    const lowerFull = p1.toLowerCase();
    if (imageMap[lowerFull]) {
      relPath = imageMap[lowerFull];
    } else {
      // Try 2: just the filename (basename)
      const basename = p1.split(/[\/\\]/).pop();
      const lowerBasename = basename.toLowerCase();
      if (imageMap[lowerBasename]) {
        relPath = imageMap[lowerBasename];
      } else {
        // Try 3: with URL decoding (in case of %20)
        let decoded;
        try {
          decoded = decodeURIComponent(p1);
        } catch (e) {
          decoded = p1; // malformed % sequence, use as-is
        }
        const lowerDecoded = decoded.toLowerCase();
        if (imageMap[lowerDecoded]) {
          relPath = imageMap[lowerDecoded];
        } else {
          const decodedBasename = decoded
            .split(/[\/\\]/)
            .pop()
            .toLowerCase();
          if (imageMap[decodedBasename]) {
            relPath = imageMap[decodedBasename];
          }
        }
      }
    }

    if (!relPath) {
      // If still not found, return a broken image indicator (but no text)
      console.warn("Image not found:", p1);
      return `\n<img src="" alt="${p1}" style="max-width:100%; border:1px dashed red;" title="Image not found: ${p1}">\n`;
    }

    const urlPath = relPath.replace(/ /g, "%20");
    const imgSrc = "/vault/" + urlPath;
    return `\n<img src="${imgSrc}" alt="${p1}" loading="lazy" style="max-width:100%;">\n`;
  });
}

// ======================================================
//  PROCESS OBSIDIAN LINKS ([[...]])
// ======================================================
export function processObsidianLinks(root, nameToPath) {
  function walk(node) {
    if (node.nodeType === Node.TEXT_NODE) {
      const text = node.textContent;
      if (text.includes("[[") && text.includes("]]")) {
        const parts = text.split(/(\[\[[^\]]+\]\])/g);
        const fragment = document.createDocumentFragment();
        for (const part of parts) {
          if (part.startsWith("[[") && part.endsWith("]]")) {
            const inner = part.slice(2, -2);
            const notePath = nameToPath[inner.toLowerCase()];
            if (notePath) {
              const span = document.createElement("span");
              span.className = "note-link";
              span.textContent = inner;
              span.dataset.path = notePath;
              span.addEventListener("click", function (e) {
                e.stopPropagation();
                const path = this.dataset.path;
                // Dispatch custom event – app.js listens for it
                const event = new CustomEvent("navigate", {
                  detail: { path, pushHistory: true },
                });
                document.dispatchEvent(event);
              });
              fragment.appendChild(span);
            } else {
              const textNode = document.createTextNode(part);
              fragment.appendChild(textNode);
            }
          } else {
            const textNode = document.createTextNode(part);
            fragment.appendChild(textNode);
          }
        }
        node.parentNode.replaceChild(fragment, node);
      }
    } else if (node.nodeType === Node.ELEMENT_NODE) {
      if (node.tagName === "PRE" || node.tagName === "CODE") return;
      const children = Array.from(node.childNodes);
      for (const child of children) walk(child);
    }
  }
  walk(root);
}

// ======================================================
//  PROCESS HTML EMBEDS (```html-embed ... ```)
// ======================================================
export function processHtmlEmbeds(html) {
  const regex =
    /<pre><code class="language-html-embed">([^<]*)<\/code><\/pre>/g;
  return html.replace(regex, (match, p1) => {
    let path = p1.trim();
    path = path.replace(/\\/g, "/");
    if (!path) {
      console.warn("HTML embed: empty path in code block, skipping");
      return '<div class="html-embed-error">⚠️ HTML embed path is empty</div>';
    }
    const url = "/vault/" + path;
    return `<div class="html-embed-container" style="position:relative;">
                <iframe src="${url}" data-path="${path}" class="html-embed-iframe" loading="lazy"></iframe>
                <button class="html-embed-fullscreen-btn" title="Open fullscreen" data-path="${path}">⛶</button>
            </div>`;
  });
}

// ======================================================
//  PROCESS HIGHLIGHT BLOCKS (@@@ color ... @@@)
// ======================================================
// Custom markdown syntax for styled content boxes:
//   @@@ blue
//   Content here — can include any markdown (tables, callouts, lists, etc.)
//   @@@
//
// Colors: blue, green, red, orange, purple (default: blue if no color given)
// In Obsidian, these appear as plain text (@@@ before/after). In the viewer
// and editor, they render as styled boxes with colored borders + backgrounds.
//
// This function runs BEFORE marked.parse(). It extracts @@@ blocks, renders
// the inner content with marked.parse(), and replaces the block with a raw
// HTML <div> that marked.parse() will pass through unchanged.
export function processHighlightBlocks(markdown) {
  const lines = markdown.split("\n");
  const result = [];
  let inCodeBlock = false;
  let inHighlight = false;
  let highlightColor = "blue";
  let highlightLines = [];

  for (const line of lines) {
    const trimmed = line.trim();

    // Track code fences — don't process @@@ inside code blocks
    if (trimmed.startsWith("```") || trimmed.startsWith("~~~")) {
      inCodeBlock = !inCodeBlock;
      if (inHighlight) {
        highlightLines.push(line);
      } else {
        result.push(line);
      }
      continue;
    }

    if (inCodeBlock) {
      if (inHighlight) {
        highlightLines.push(line);
      } else {
        result.push(line);
      }
      continue;
    }

    // Check for @@@ start (with optional color)
    const startMatch = trimmed.match(/^@@@\s*(\w+)?$/);
    if (startMatch && !inHighlight) {
      inHighlight = true;
      highlightColor = startMatch[1] || "blue";
      highlightLines = [];
      continue;
    }

    // Check for @@@ end
    if (trimmed === "@@@" && inHighlight) {
      inHighlight = false;
      // Render the inner content with marked.parse (callouts are already
      // preprocessed if they were inside the block)
      let inner = highlightLines.join("\n");
      inner = preprocessCallouts(inner);
      const rendered = marked.parse(inner);
      // Output as a raw HTML block. The blank lines before and after ensure
      // marked.parse() treats this as a block-level HTML element and passes
      // it through without wrapping in a <p>.
      result.push("", `<div class="highlight-block highlight-${highlightColor}">${rendered}</div>`, "");
      continue;
    }

    if (inHighlight) {
      highlightLines.push(line);
    } else {
      result.push(line);
    }
  }

  // If we ended still inside a highlight block (unclosed @@@), just output
  // the content as-is with the opening marker
  if (inHighlight) {
    result.push(`@@@ ${highlightColor}`);
    result.push(...highlightLines);
  }

  return result.join("\n");
}

// ======================================================
//  PROCESS HIGHLIGHT BLOCKS (POST-RENDER)
// ======================================================
// This version runs AFTER marked.parse(). It finds any @@@ markers that
// survived into the rendered HTML (because they were in the markdown but
// not caught by the pre-render pass — e.g. if the user typed @@@ directly
// in the editor and the content was re-parsed without going through
// processHighlightBlocks first).
//
// It also re-applies styling to highlight-block divs that lost their color
// class during serialization/deserialization.
export function processHighlightBlocksPostRender(html) {
  // This is a no-op for now — the pre-render pass handles everything.
  // Keeping this for future use.
  return html;
}
// Converts fenced ```mermaid code blocks into rendered Mermaid diagrams.
// Must be called AFTER marked.parse() (which wraps them in
// <pre><code class="language-mermaid">). We replace each with a unique div
// and trigger async rendering.
//
// PERFORMANCE (T3-2): mermaid is ~1MB and was previously loaded
// synchronously in <head>. It is now lazy-loaded on first use via
// `loadScript()`. This function remains SYNCHRONOUS (so callers in
// vault.js don't need to await it); it kicks off the async load + render
// internally and updates the DOM in-place when ready.
export function processMermaid(html) {
  const regex = /<pre><code class="language-mermaid">([\s\S]*?)<\/code><\/pre>/g;
  const diagrams = [];
  html = html.replace(regex, (match, code) => {
    const id = "mermaid-diagram-" + Date.now() + "-" + diagrams.length;
    diagrams.push({ id, code: code.trim() });
    return `<div class="mermaid-container" id="${id}"><div class="mermaid-loading">Rendering diagram…</div></div>`;
  });

  if (diagrams.length > 0) {
    // Load mermaid dynamically and render the diagrams in-place.
    renderMermaidDiagrams(diagrams);
  }

  return html;
}

// Async helper — loads mermaid if needed, initializes it once, then renders
// every diagram by swapping the placeholder div's innerHTML with the SVG.
async function renderMermaidDiagrams(diagrams) {
  if (!window.mermaid) {
    try {
      await loadScript("https://cdn.jsdelivr.net/npm/mermaid@10/dist/mermaid.min.js");
    } catch (e) {
      for (const { id } of diagrams) {
        const el = document.getElementById(id);
        if (el) el.innerHTML = '<div class="mermaid-error">⚠️ Failed to load Mermaid</div>';
      }
      return;
    }
  }

  // Initialize mermaid once (with the current theme)
  if (!window._mermaidInitialized) {
    const isDark = document.body.classList.contains("dark-mode");
    window.mermaid.initialize({
      startOnLoad: false,
      theme: isDark ? "dark" : "default",
      securityLevel: "loose",
    });
    window._mermaidInitialized = true;
  }

  for (const { id, code } of diagrams) {
    try {
      const { svg } = await window.mermaid.render(id + "-svg", code);
      const el = document.getElementById(id);
      if (el) el.innerHTML = svg;
    } catch (err) {
      const el = document.getElementById(id);
      if (el) el.innerHTML = `<div class="mermaid-error">⚠️ ${err.message}</div>`;
    }
  }
}

// Small promise wrapper around a <script> tag. Deduped: if the same URL is
// already loading or loaded, the promise resolves immediately.
function loadScript(src) {
  return new Promise((resolve, reject) => {
    if (document.querySelector(`script[src="${src}"]`)) {
      resolve();
      return;
    }
    const script = document.createElement("script");
    script.src = src;
    script.onload = resolve;
    script.onerror = reject;
    document.head.appendChild(script);
  });
}

// ======================================================
//  FIX STANDARD MARKDOWN IMAGE PATHS
// ======================================================
// marked.parse() converts ![alt](path) to <img src="path">. But the path
// is relative to the page URL, not the vault root — so images in subfolders
// (like assets/foo.png) don't resolve. This function finds all <img> tags
// whose src is NOT already absolute (http, data:, /vault/) and rewrites
// them to /vault/<path>, resolving relative to the note's directory.
//
// Also handles Obsidian-style ![[image]] embeds that somehow slipped through
// processObsidianEmbeds (e.g. if the note was edited after the embed map
// was built) — tries to resolve them via window.imageMap.
export function fixImagePaths(html, notePath) {
  // Determine the note's directory (for relative path resolution)
  const noteDir = notePath
    ? notePath.replace(/\\/g, "/").split("/").slice(0, -1).join("/")
    : "";

  // Regex: match <img src="..."> (single or double quotes)
  return html.replace(/<img\s+([^>]*?)src=["']([^"']+)["']([^>]*?)\/?>/gi, (match, before, src, after) => {
    // Skip if already absolute, data URI, or /vault/ path
    if (/^(https?:|data:|\/vault\/)/i.test(src)) {
      return match;
    }

    // Strip leading ./ if present
    let cleanSrc = src.replace(/^\.\//, "");

    // Try to resolve via imageMap (basename lookup) — handles Obsidian-style
    // ![[image.png]] that was converted to <img> by marked, and also handles
    // the case where the path includes a folder prefix
    const imageMap = window.imageMap || {};
    let resolvedPath = null;

    // Try 1: exact path as-is (lowercased)
    const lowerFull = cleanSrc.toLowerCase();
    if (imageMap[lowerFull]) {
      resolvedPath = imageMap[lowerFull];
    } else {
      // Try 2: basename only (lowercased) — handles assets/foo.png → foo.png
      const basename = cleanSrc.split(/[\/\\]/).pop().toLowerCase();
      if (imageMap[basename]) {
        resolvedPath = imageMap[basename];
      } else {
        // Try 3: URL-decoded
        let decoded;
        try { decoded = decodeURIComponent(cleanSrc); } catch (e) { decoded = cleanSrc; }
        const lowerDecoded = decoded.toLowerCase();
        if (imageMap[lowerDecoded]) {
          resolvedPath = imageMap[lowerDecoded];
        } else {
          const decodedBasename = decoded.split(/[\/\\]/).pop().toLowerCase();
          if (imageMap[decodedBasename]) {
            resolvedPath = imageMap[decodedBasename];
          }
        }
      }
    }

    let finalSrc;
    if (resolvedPath) {
      // Found in imageMap — use the resolved path
      finalSrc = "/vault/" + resolvedPath.replace(/ /g, "%20");
    } else {
      // Not in imageMap — resolve relative to the note's directory
      let fullPath = cleanSrc;
      if (noteDir && !fullPath.startsWith("/")) {
        fullPath = noteDir + "/" + fullPath;
      }
      finalSrc = "/vault/" + fullPath.replace(/ /g, "%20");
    }

    // Reconstruct the <img> tag with the fixed src
    return `<img ${before}src="${finalSrc}"${after}>`;
  });
}

// ======================================================
//  ROBUST CALLOUT PREPROCESSOR
// ======================================================
export function preprocessCallouts(markdown) {
  const lines = markdown.split("\n");
  const result = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();

    if (trimmed.startsWith("> [")) {
      const headerMatch = trimmed.match(/^>\s*\[!([^\]]+)\]\s*(-?)\s*(.*)$/);
      if (headerMatch) {
        const type = headerMatch[1].toLowerCase();
        const isCollapsible = headerMatch[2] === "-";
        const title =
          headerMatch[3].trim() || type.charAt(0).toUpperCase() + type.slice(1);

        const contentLines = [];
        let j = i + 1;
        while (j < lines.length) {
          const nextLine = lines[j];
          const nextTrimmed = nextLine.trim();
          // In Obsidian, a truly empty line ENDS the callout. A line that is
          // just ">" (the quote marker with nothing after) is a blank line
          // WITHIN the callout and continues it. Any other non-quote line
          // ends the callout.
          if (nextTrimmed === "" || !nextTrimmed.startsWith(">")) {
            break;
          }
          contentLines.push(nextLine);
          j++;
        }

        const contentMarkdown = contentLines
          .map((l) => l.replace(/^>\s?/, ""))
          .join("\n");

        const processedContent = preprocessCallouts(contentMarkdown);
        // CRITICAL: marked.parse() by default treats single \n as a soft break
        // (renders as a space, not <br>). This collapses all multi-line content
        // inside callouts into a single line. Fix: temporarily enable breaks
        // mode so \n becomes <br>, preserving line breaks.
        const prevBreaks = marked.defaults.breaks;
        marked.setOptions({ breaks: true });
        const renderedContent = marked.parse(processedContent);
        marked.setOptions({ breaks: prevBreaks });

        let html;
        if (isCollapsible) {
          html = `<details class="callout callout-${type}">
                        <summary class="callout-title">${title}</summary>
                        <div class="callout-content">${renderedContent}</div>
                    </details>`;
        } else {
          html = `<div class="callout callout-${type}">
                        <div class="callout-title">${title}</div>
                        <div class="callout-content">${renderedContent}</div>
                    </div>`;
        }
        // Pad with blank lines so marked treats the callout as a standalone
        // HTML block. Without this, the markdown immediately after the
        // callout (e.g. "## Header") gets absorbed into the HTML block and
        // rendered as literal text instead of being parsed as markdown.
        result.push("", html, "");
        i = j;
        continue;
      }
    }

    result.push(line);
    i++;
  }

  return result.join("\n");
}

// ======================================================
//  wrapTables — make wide tables horizontally scrollable
// ======================================================
// Walks the rendered DOM and wraps every <table> that isn't already inside a
// .table-scroll wrapper in <div class="table-scroll">. This makes wide tables
// (and tables inside @@@ highlight blocks) scroll horizontally instead of
// overflowing / being clipped. Safe to call repeatedly (idempotent).
export function wrapTables(root) {
  if (!root) return;
  const tables = root.querySelectorAll("table");
  tables.forEach((table) => {
    // Skip if already wrapped (parent is .table-scroll)
    if (table.parentElement && table.parentElement.classList.contains("table-scroll")) return;
    // Skip tables inside the editor (contenteditable) — wrapping there breaks
    // cursor movement. The editor handles its own overflow via CSS.
    if (table.closest("[contenteditable='true']")) return;
    const wrapper = document.createElement("div");
    wrapper.className = "table-scroll";
    table.parentNode.insertBefore(wrapper, table);
    wrapper.appendChild(table);
  });
}
