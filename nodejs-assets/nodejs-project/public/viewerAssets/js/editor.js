// ======================================================
//  EDITOR MODULE (js/editor.js) — WYSIWYG (like Obsidian edit mode)
// ======================================================
//
// The editor renders the note's markdown as HTML (same pipeline as view mode)
// inside a contenteditable div. The user sees rendered headers, images,
// callouts, etc. — but can edit everything directly.
//
// SAVE STRATEGY: We do NOT use Turndown (HTML→Markdown is lossy — it breaks
// code fences, collapses tables, merges images). Instead we build markdown
// directly from the DOM using a custom serializer that preserves Obsidian
// markdown structure exactly:
//   - <h1>-<h6> → # heading (with blank lines around)
//   - <p> → paragraph text (with blank lines between)
//   - <ul>/<ol>/<li> → - item / 1. item
//   - <pre><code> → ```fenced code``` (with blank lines around)
//   - <pre data-raw-md> → verbatim text (pasted callouts)
//   - <img> → ![[filename]] (on its own line)
//   - <table> → | col | col | markdown table
//   - <blockquote> → > text
//   - <strong> → **bold**, <em> → *italic*
//   - [[links]] stay as literal text (never mangled)
//   - <hr> → ---

import {
  stripFrontmatter,
  processObsidianEmbeds,
  processHtmlEmbeds,
  preprocessCallouts,
  processHighlightBlocks,
  fixImagePaths,
} from "./markdown.js";
import { applyFontSettings } from "./settings.js";

// ---- Editor state ----
let isEditing = false;
let currentEditPath = null;
let originalContent = "";
let dirty = false;
let isSaving = false;  // true during the save sequence — blocks SSE re-renders
let pendingNewName = null;  // if the user edited the title, the new note name
// Save mutex/queue — prevents concurrent saveNote() calls (e.g., double Ctrl+S)
let saveInProgress = false;  // a saveNote() invocation is currently in-flight
let pendingResave = false;   // a second save was requested during the in-flight one
// Detected line ending of the original note ("\n" or "\r\n") — preserved on save
let editLineEnding = "\n";
// Set when an SSE fileChanged arrives for the note currently being edited
let externalChangePending = false;
// Server-reported mtime of the note at the last fetch/save — used for 409 conflict detection
let originalMtime = null;

// Normalize path to forward slashes (same as vault.js — not imported, so defined locally)
function norm(p) {
  return p ? String(p).replace(/\\/g, "/") : p;
}

// ---- Image embed toggle state ----
let activeImageEmbed = null;  // the span that replaced a clicked image
let activeBlockEmbed = null;  // the pre that replaced a clicked callout/embed
let isExpanding = false;      // flag to prevent premature collapse during expansion
let selectionChangeHandler = null;

// ---- Dependencies (set by app.js) ----
let _getCurrentNotePath = null;
let _loadNote = null;
let _updateNoteMap = null;

export function setEditorDependencies(
  getCurrentNotePath,
  loadNote,
  updateNoteMap,
) {
  _getCurrentNotePath = getCurrentNotePath;
  _loadNote = loadNote;
  _updateNoteMap = updateNoteMap;
}

export function updateEditToggleIcon() {
  const btn = document.getElementById("outline-edit-btn");
  if (!btn) return;
  if (isEditing) {
    btn.innerHTML = `<i class="fas fa-eye"></i>`;
    btn.title = "Switch to View mode";
  } else {
    btn.innerHTML = `<i class="fas fa-pencil-alt"></i>`;
    btn.title = "Edit note";
  }
}

function applyContentWidth() {
  const editable = document.getElementById("editableNote");
  if (!editable) return;
  const saved = localStorage.getItem("contentWidth");
  if (saved) {
    const val = parseInt(saved, 10);
    editable.style.maxWidth = val + "%";
  } else {
    editable.style.maxWidth = "750px";
  }
}

function currentNoteDir() {
  const p = currentEditPath || "";
  const slash = p.lastIndexOf("/");
  return slash >= 0 ? p.slice(0, slash) : "";
}

async function uploadImageToVault(blob, suggestedName) {
  const noteDir = currentNoteDir();
  const formData = new FormData();
  formData.append("image", blob, suggestedName || "pasted-image.png");
  formData.append("noteDir", noteDir);
  try {
    const res = await fetch("/api/upload-image", { method: "POST", body: formData });
    const data = await res.json();
    if (data.success) return data.filename;
    console.error("Image upload failed:", data.error);
    return null;
  } catch (err) {
    console.error("Image upload error:", err);
    return null;
  }
}

async function insertImageFile(file) {
  if (!file || !file.type.startsWith("image/")) return;
  const editable = document.getElementById("editableNote");
  if (!editable) return;

  // Create a visible loading placeholder (NOT a broken img tag)
  const placeholder = document.createElement("div");
  placeholder.className = "img-upload-placeholder";
  placeholder.innerHTML = '<span class="img-upload-spinner"></span> Uploading image…';
  insertNodeAtCursor(placeholder);

  const filename = await uploadImageToVault(file, file.name || "pasted-image.png");
  if (filename) {
    const dir = currentNoteDir();
    const rel = dir ? dir + "/assets/" + filename : "assets/" + filename;
    // Replace the placeholder with a proper <img> tag
    const img = document.createElement("img");
    img.alt = filename;
    img.src = "/vault/" + rel.split("/").map(encodeURIComponent).join("/");
    img.style.maxWidth = "100%";
    placeholder.replaceWith(img);
    dirty = true;
  } else {
    placeholder.remove();
    window.showErrorModal("Upload Failed", "Failed to upload image to the vault.");
  }
}

function insertNodeAtCursor(node) {
  const sel = window.getSelection();
  const editable = document.getElementById("editableNote");
  if (sel && sel.rangeCount && editable && editable.contains(sel.getRangeAt(0).commonAncestorContainer)) {
    const range = sel.getRangeAt(0);
    range.deleteContents();
    range.insertNode(node);
    range.setStartAfter(node);
    range.collapse(true);
    sel.removeAllRanges();
    sel.addRange(range);
  } else if (editable) {
    editable.appendChild(node);
  }
}

function setupPasteHandler(editable) {
  editable.addEventListener("paste", function (e) {
    const items = e.clipboardData && e.clipboardData.items;
    if (items) {
      for (const item of items) {
        if (item.kind === "file" && item.type.startsWith("image/")) {
          e.preventDefault();
          const file = item.getAsFile();
          if (file) insertImageFile(file);
          return;
        }
      }
    }

    const text = e.clipboardData && e.clipboardData.getData("text/plain");
    const html = e.clipboardData && e.clipboardData.getData("text/html");

    // Case 1: Content with callouts, code fences, @@@ blocks, or tables →
    // intercept and insert as parsed markdown (browser would mangle these).
    if (text && looksLikeRawMarkdown(text)) {
      e.preventDefault();
      insertRawMarkdown(text);
      return;
    }

    // Case 2: HTML from Obsidian (contains callout/blockquote structures) →
    // convert back to markdown and insert as parsed HTML.
    if (html && (html.includes("callout") || html.includes("blockquote"))) {
      e.preventDefault();
      const temp = document.createElement("div");
      temp.innerHTML = html;
      while (temp.children.length === 1 && temp.firstElementChild.tagName === "DIV") {
        temp.innerHTML = temp.firstElementChild.innerHTML;
      }
      let md = domToMarkdown(temp);
      if (md.trim()) {
        insertRawMarkdown(md);
      }
      return;
    }

    // Case 3: All other content → SANITIZE and let the browser paste.
    // We strip inline styles (font-size, font-family, color, etc.) that
    // cause "huge text" issues, but preserve structural HTML (headers, bold,
    // lists, links, etc.). This is the key fix for issues #1, #2, #3, #5.
    if (html) {
      // Parse the HTML, strip dangerous/inheritance-breaking styles, then
      // re-serialize and let the browser insert the cleaned version.
      const temp = document.createElement("div");
      temp.innerHTML = html;

      // Strip all inline styles from every element (prevents font-size
      // inheritance, color overrides, etc.)
      temp.querySelectorAll("*").forEach(el => {
        el.removeAttribute("style");
        el.removeAttribute("class");
        // Strip font-related attributes
        el.removeAttribute("face");
        el.removeAttribute("size");
        el.removeAttribute("color");
      });

      // Remove <font> tags (legacy clipboard format) — replace with their content
      temp.querySelectorAll("font").forEach(font => {
        const parent = font.parentNode;
        while (font.firstChild) {
          parent.insertBefore(font.firstChild, font);
        }
        parent.removeChild(font);
      });

      // Remove <meta> and <link> tags (some clipboard HTML includes these)
      temp.querySelectorAll("meta, link, style, script").forEach(el => el.remove());

      // Replace the clipboard data with the cleaned HTML
      e.preventDefault();
      const cleanedHtml = temp.innerHTML;
      document.execCommand("insertHTML", false, cleanedHtml);
      dirty = true;
    }
    // If no HTML, let the browser paste as plain text (default behavior)
  });

  editable.addEventListener("dragover", function (e) {
    if (e.dataTransfer && e.dataTransfer.types.includes("Files")) e.preventDefault();
  });
  editable.addEventListener("drop", function (e) {
    if (!e.dataTransfer || !e.dataTransfer.files) return;
    const files = Array.from(e.dataTransfer.files).filter((f) => f.type.startsWith("image/"));
    if (files.length === 0) return;
    e.preventDefault();
    for (const file of files) insertImageFile(file);
  });
}

function looksLikeRawMarkdown(text) {
  if (!text || !text.trim()) return false;
  // Only intercept paste for content that the browser would mangle:
  // callouts, code fences, and @@@ blocks. Everything else (headers, bold,
  // lists, links) should be handled by the browser's native paste, which
  // preserves formatting from the clipboard's HTML.
  if (/^>\s*\[!\w+\]/m.test(text)) return true;
  if (/^```/m.test(text)) return true;
  if (/^@@@\s*\w*/m.test(text)) return true;
  // Markdown tables (the browser mangles these)
  if (/^\|.*\|/m.test(text) && /\|[\s-:]+\|/m.test(text)) return true;
  return false;
}

function insertRawMarkdown(text) {
  // For callouts, code fences, @@@ blocks, and tables: parse the markdown
  // into rendered HTML and insert at cursor. These structures need special
  // handling because the browser's native paste mangles them.
  let clean = text;
  clean = preprocessCallouts(clean);
  clean = processHighlightBlocks(clean);
  if (window.imageMap) clean = processObsidianEmbeds(clean, currentEditPath || "");
  let html = marked.parse(clean);
  html = processHtmlEmbeds(html);
  html = fixImagePaths(html, currentEditPath || "");

  const container = document.createElement("div");
  container.innerHTML = html;
  // Strip leading/trailing empty paragraphs
  while (container.firstElementChild && container.firstElementChild.tagName === "P" && !container.firstElementChild.textContent.trim()) {
    container.firstElementChild.remove();
  }
  while (container.lastElementChild && container.lastElementChild.tagName === "P" && !container.lastElementChild.textContent.trim()) {
    container.lastElementChild.remove();
  }

  const editable = document.getElementById("editableNote");
  if (!editable) return;
  const sel = window.getSelection();
  if (sel && sel.rangeCount && editable.contains(sel.getRangeAt(0).commonAncestorContainer)) {
    let range = sel.getRangeAt(0);
    range.deleteContents();
    const fragment = document.createDocumentFragment();
    while (container.firstChild) {
      fragment.appendChild(container.firstChild);
    }
    range.insertNode(fragment);
    range.collapse(false);
    sel.removeAllRanges();
    sel.addRange(range);
  } else {
    while (container.firstChild) {
      editable.appendChild(container.firstChild);
    }
  }
  dirty = true;
}

// ======================================================
//  IMAGE EMBED TOGGLE (click image → show ![[filename]], click away → image)
// ======================================================

/**
 * Replace an <img> with an editable text span showing "![[filename]]".
 * Called when the user clicks an image in edit mode.
 */
function expandImageToText(img) {
  const alt = img.getAttribute("alt") || "";
  if (!alt || alt === "uploading…") return;

  isExpanding = true;

  const span = document.createElement("span");
  span.className = "img-embed-text";
  span.setAttribute("contenteditable", "true");
  span.textContent = `![[${alt}]]`;
  span.dataset.originalSrc = img.getAttribute("src") || "";
  // Style it so it's visually distinct as an embed reference
  span.style.background = "rgba(64, 153, 255, 0.1)";
  span.style.border = "1px solid rgba(64, 153, 255, 0.3)";
  span.style.borderRadius = "4px";
  span.style.padding = "0.15rem 0.4rem";
  span.style.fontFamily = "var(--font-mono, monospace)";
  span.style.fontSize = "0.85em";
  span.style.display = "inline-block";
  span.style.color = "#4099ff";
  span.style.whiteSpace = "nowrap";

  img.parentNode.replaceChild(span, img);
  activeImageEmbed = span;
  dirty = true;

  // Focus and select all text so the user can edit the filename
  setTimeout(() => {
    span.focus();
    const range = document.createRange();
    range.selectNodeContents(span);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    isExpanding = false;
  }, 0);
}

/**
 * Convert the active embed text span back to an <img>.
 * Called when the cursor moves away from the span.
 */
function collapseImageEmbed() {
  if (!activeImageEmbed) return;

  // If the span was deleted from the DOM (user backspaced over it), just
  // clear the reference and return — nothing to collapse.
  if (!activeImageEmbed.parentNode) {
    activeImageEmbed = null;
    return;
  }

  // Parse the filename from "![[filename]]"
  const text = activeImageEmbed.textContent;
  const match = text.match(/!\[\[(.+)\]\]/);
  const filename = match ? match[1] : "image";
  const src = activeImageEmbed.dataset.originalSrc || "";

  // If the user deleted the embed text (empty or just whitespace), remove
  // the span entirely — the image is gone.
  if (!text.trim()) {
    activeImageEmbed.remove();
    activeImageEmbed = null;
    return;
  }

  const img = document.createElement("img");
  img.setAttribute("alt", filename);
  img.setAttribute("src", src);
  img.style.maxWidth = "100%";
  img.style.borderRadius = "8px";
  img.style.margin = "0.8rem 0";
  img.style.boxShadow = "0 2px 8px rgba(0,0,0,0.08)";

  activeImageEmbed.parentNode.replaceChild(img, activeImageEmbed);
  activeImageEmbed = null;
}

/**
 * Expand a callout or HTML embed into its raw markdown representation.
 * Called when the user clicks a callout div or html-embed-container in edit mode.
 */
function expandBlockToText(blockEl) {
  // Serialize the block back to markdown.
  // CRITICAL: We must WRAP the element in a temp container and call
  // domToMarkdown on the CONTAINER — not on the element itself. Otherwise
  // domToMarkdown iterates the element's children (callout-title,
  // callout-content) instead of recognizing the element as a callout.
  const temp = document.createElement("div");
  temp.appendChild(blockEl.cloneNode(true));
  let markdown = domToMarkdown(temp).trim();
  if (!markdown) return;

  isExpanding = true;

  const pre = document.createElement("pre");
  pre.setAttribute("data-raw-md", "1");
  pre.setAttribute("contenteditable", "true");
  pre.textContent = markdown;
  pre.style.background = "rgba(64, 153, 255, 0.08)";
  pre.style.border = "1px solid rgba(64, 153, 255, 0.3)";
  pre.style.borderRadius = "6px";
  pre.style.padding = "0.6rem";
  pre.style.fontSize = "0.85rem";
  pre.style.whiteSpace = "pre-wrap";
  pre.style.fontFamily = "var(--font-mono, monospace)";
  pre.style.color = "#4099ff";
  pre.style.margin = "0.5rem 0";
  pre.style.outline = "none";

  // Store the original element type so we know how to collapse back
  if (blockEl.querySelector("hr") || blockEl.tagName === "HR") {
    pre.dataset.blockType = "hr";
  } else if (blockEl.classList.contains("highlight-block")) {
    pre.dataset.blockType = "highlight-block";
  } else if (blockEl.classList.contains("callout") || blockEl.tagName === "DETAILS") {
    pre.dataset.blockType = "callout";
  } else {
    pre.dataset.blockType = "html-embed";
  }

  blockEl.parentNode.replaceChild(pre, blockEl);
  activeBlockEmbed = pre;
  dirty = true;

  setTimeout(() => {
    pre.focus();
    const range = document.createRange();
    range.selectNodeContents(pre);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    isExpanding = false;
  }, 0);
}

/**
 * Collapse the active block embed text back to its rendered form.
 * Re-parses the markdown and replaces the <pre> with ALL rendered elements.
 */
function collapseBlockEmbed() {
  if (!activeBlockEmbed) return;
  if (!activeBlockEmbed.parentNode) {
    activeBlockEmbed = null;
    return;
  }

  const text = getPreContent(activeBlockEmbed);
  if (!text.trim()) {
    activeBlockEmbed.remove();
    activeBlockEmbed = null;
    return;
  }

  // Re-parse the markdown to get the rendered HTML.
  // MUST call preprocessCallouts first — without it, "> [!info]" is treated
  // as a regular blockquote, not a callout. This was the bug that caused
  // callouts to collapse into plain text.
  let clean = text;
  clean = preprocessCallouts(clean);
  clean = processHighlightBlocks(clean);
  if (window.imageMap) clean = processObsidianEmbeds(clean, currentEditPath || "");
  let html = marked.parse(clean);
  html = processHtmlEmbeds(html);
  html = fixImagePaths(html, currentEditPath || "");

  // Create a temporary container with ALL the parsed HTML
  const temp = document.createElement("div");
  temp.innerHTML = html;

  // Replace the <pre> with ALL children from the temp container (not just
  // the first — a callout produces multiple elements: the callout div +
  // possibly trailing paragraphs). We insert them in order.
  const parent = activeBlockEmbed.parentNode;
  const fragment = document.createDocumentFragment();
  while (temp.firstChild) {
    fragment.appendChild(temp.firstChild);
  }
  parent.replaceChild(fragment, activeBlockEmbed);
  activeBlockEmbed = null;
}

/**
 * Set up click toggles for images, callouts, and HTML embeds in the editable area.
 * - Click an <img> → replace with editable "![[filename]]" text
 * - Click a .callout → replace with editable raw markdown
 * - Click a .html-embed-container → replace with editable raw markdown
 * - Selection moves away → convert back to rendered form
 * - Hover over callout → show × delete button
 */
function setupImageToggle(editable) {
  // Click handler
  editable.addEventListener("click", (e) => {
    // Collapse any active embeds first
    if (activeImageEmbed && e.target.tagName === "IMG") {
      collapseImageEmbed();
    }
    if (activeBlockEmbed) {
      // Check if click is outside the active block embed
      if (!activeBlockEmbed.contains(e.target)) {
        collapseBlockEmbed();
      }
    }

    // Image click → expand to text
    if (e.target.tagName === "IMG") {
      e.preventDefault();
      expandImageToText(e.target);
      return;
    }

    // Callout click → expand to raw markdown (only if clicking the title or border,
    // not if clicking inside the content to edit it)
    const callout = e.target.closest(".callout, details.callout");
    if (callout && !e.target.closest(".callout-content")) {
      // Only expand if clicking the title area or the callout border
      e.preventDefault();
      expandBlockToText(callout);
      return;
    }

    // HTML embed click → expand to raw markdown
    const embed = e.target.closest(".html-embed-container");
    if (embed) {
      e.preventDefault();
      expandBlockToText(embed);
      return;
    }

    // Highlight block (@@@) click → expand to raw markdown (like callouts)
    const highlightBlock = e.target.closest(".highlight-block");
    if (highlightBlock) {
      e.preventDefault();
      expandBlockToText(highlightBlock);
      return;
    }

    // HR (---) click → expand to raw markdown text
    if (e.target.tagName === "HR") {
      e.preventDefault();
      // Create a temporary wrapper div around the HR so expandBlockToText
      // can serialize it properly (domToMarkdown handles <hr> inside a div)
      const wrapper = document.createElement("div");
      wrapper.appendChild(e.target.cloneNode(true));
      e.target.replaceWith(wrapper);
      expandBlockToText(wrapper);
      return;
    }

    // Delete button click
    if (e.target.classList.contains("callout-delete-btn")) {
      e.preventDefault();
      e.stopPropagation();
      const callout = e.target.closest(".callout, details.callout");
      if (callout) {
        callout.remove();
        dirty = true;
      }
    }
  });

  // Mousemove handler: show/hide delete button on callouts
  editable.addEventListener("mousemove", (e) => {
    const callout = e.target.closest(".callout, details.callout");
    // Remove all existing delete buttons first
    editable.querySelectorAll(".callout-delete-btn").forEach(btn => {
      if (!callout || !callout.contains(btn)) btn.remove();
    });
    if (callout && !callout.classList.contains("active-block")) {
      // Add delete button if not already there
      if (!callout.querySelector(".callout-delete-btn")) {
        const btn = document.createElement("button");
        btn.className = "callout-delete-btn";
        btn.textContent = "×";
        btn.title = "Delete this callout";
        btn.style.cssText = `
          position: absolute; top: 4px; right: 4px;
          width: 22px; height: 22px; border-radius: 50%;
          background: rgba(192, 57, 43, 0.8); color: #fff;
          border: none; cursor: pointer; font-size: 14px;
          line-height: 1; z-index: 10; opacity: 0.7;
          transition: opacity 0.15s;
        `;
        btn.addEventListener("mouseenter", () => btn.style.opacity = "1");
        btn.addEventListener("mouseleave", () => btn.style.opacity = "0.7");
        // Make callout position relative for the button
        if (getComputedStyle(callout).position === "static") {
          callout.style.position = "relative";
        }
        callout.appendChild(btn);
      }
    }
  });

  // Mouseleave: remove delete buttons
  editable.addEventListener("mouseleave", () => {
    editable.querySelectorAll(".callout-delete-btn").forEach(btn => btn.remove());
  });

  // Selection change handler: when cursor leaves embeds, collapse them
  if (!selectionChangeHandler) {
    selectionChangeHandler = () => {
      if (!isEditing || isExpanding) return;
      const sel = window.getSelection();
      if (!sel || !sel.rangeCount) return;
      const node = sel.anchorNode;

      // Check image embed
      if (activeImageEmbed) {
        if (activeImageEmbed.contains(node) || node === activeImageEmbed) {
          return; // still inside
        }
        collapseImageEmbed();
      }

      // Check block embed
      if (activeBlockEmbed) {
        if (activeBlockEmbed.contains(node) || node === activeBlockEmbed) {
          return; // still inside
        }
        collapseBlockEmbed();
      }
    };
    document.addEventListener("selectionchange", selectionChangeHandler);
  }
}

// ======================================================
//  CUSTOM MARKDOWN SERIALIZER (DOM → Markdown)
// ======================================================
// Walks the contenteditable DOM and produces clean Obsidian markdown that
// preserves: code fences, tables, images on separate lines, callouts,
// blockquotes, lists, and [[links]] as literal text.

function escapeHtml(str) {
  return String(str).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function serializeInline(node) {
  // Serialize inline content (text, bold, italic, code, links, images)
  let result = "";
  for (const child of node.childNodes) {
    if (child.nodeType === 3) {
      // Text node — keep [[ ]] links as-is, escape nothing.
      // Preserve any \n in the text node (browsers sometimes use actual
      // newline characters in text nodes for line breaks).
      result += child.textContent;
    } else if (child.nodeType === 1) {
      const tag = child.tagName;
      if (tag === "STRONG" || tag === "B") {
        // Skip empty bold tags (prevents spurious ** in output)
        const inner = serializeInline(child);
        if (inner.trim()) result += `**${inner}**`;
      } else if (tag === "EM" || tag === "I") {
        // Skip empty italic tags
        const inner = serializeInline(child);
        if (inner.trim()) result += `*${inner}*`;
      } else if (tag === "CODE") {
        result += "`" + child.textContent + "`";
      } else if (tag === "A") {
        // Preserve markdown links [text](url) — don't lose the URL
        const href = child.getAttribute("href") || "";
        if (href && !href.startsWith("#")) {
          result += `[${child.textContent}](${href})`;
        } else {
          result += child.textContent;
        }
      } else if (tag === "BR") {
        result += "\n";
      } else if (tag === "IMG") {
        const alt = child.getAttribute("alt") || "";
        if (alt && alt !== "uploading…") {
          result += `![[${alt}]]`;
        }
      } else if (tag === "SPAN" && child.classList.contains("note-link")) {
        // View-mode link span (from processObsidianLinks) — output [[text]]
        result += `[[${child.textContent}]]`;
      } else if (tag === "SPAN" && child.classList.contains("editor-link")) {
        // Editor-mode link highlight — brackets are in surrounding text nodes,
        // so just output the inner text (no [[ ]] wrapping)
        result += child.textContent;
      } else if (tag === "SPAN" && child.classList.contains("img-embed-text")) {
        // Active image embed — output the text as-is (it's "![[filename]]")
        result += child.textContent;
      } else if (tag === "PRE") {
        // Block element inside inline context — output its text content
        result += child.textContent;
      } else if (tag === "DIV") {
        // Browsers (especially Chrome) use <div> tags inside contenteditable
        // to represent paragraph breaks within a <p>. In markdown, a single \n
        // is a "soft break" (rendered as a space), while \n\n is a paragraph
        // break. Since <div> in the editor almost always represents a paragraph
        // break (the user pressed Enter), we output \n\n.
        if (result && !result.endsWith("\n\n")) {
          result = result.replace(/\n+$/, "") + "\n\n";
        }
        result += serializeInline(child);
      } else {
        result += serializeInline(child);
      }
    }
  }
  return result;
}

function serializeTable(table) {
  const rows = table.querySelectorAll("tr");
  if (rows.length === 0) return "";
  let result = "";
  let headerDone = false;
  for (const row of rows) {
    const cells = row.querySelectorAll("th, td");
    const cellTexts = Array.from(cells).map(c => {
      // Replace newlines with <br> so the table row stays on one line
      // (markdown tables cannot contain literal newlines in a cell).
      let t = serializeInline(c).trim().replace(/\|/g, "\\|");
      t = t.replace(/\n/g, "<br>");
      return t;
    });
    result += "| " + cellTexts.join(" | ") + " |\n";
    // After the first row (header), add the separator
    if (!headerDone && row.querySelector("th")) {
      const sep = cellTexts.map(() => "---");
      result += "| " + sep.join(" | ") + " |\n";
      headerDone = true;
    }
  }
  return result;
}

function serializeList(list, indent = "") {
  let result = "";
  const items = list.children;
  let i = 1;
  const isOrdered = list.tagName === "OL";
  for (const item of items) {
    if (item.tagName !== "LI") continue;
    const marker = isOrdered ? `${i}. ` : "- ";
    i++;
    // Serialize the li's inline content (excluding nested lists)
    let inlineContent = "";
    let nestedLists = "";
    for (const child of item.childNodes) {
      if (child.nodeType === 1 && (child.tagName === "UL" || child.tagName === "OL")) {
        nestedLists += serializeList(child, indent + "  ");
      } else {
        inlineContent += child.nodeType === 3 ? child.textContent : serializeInline(child);
      }
    }
    result += indent + marker + inlineContent.trim() + "\n";
    result += nestedLists;
  }
  return result;
}

function serializeBlockquote(bq) {
  let result = "";
  for (const child of bq.childNodes) {
    if (child.nodeType === 3) {
      const lines = child.textContent.split("\n");
      for (const line of lines) {
        result += "> " + line + "\n";
      }
    } else if (child.nodeType === 1) {
      if (child.tagName === "P") {
        const text = serializeInline(child).trim();
        const lines = text.split("\n");
        for (const line of lines) {
          result += "> " + line + "\n";
        }
      } else {
        result += "> " + serializeInline(child).trim() + "\n";
      }
    }
  }
  return result;
}

function domToMarkdown(root) {
  const blocks = [];
  // Iterate childNodes (includes text nodes) instead of children (elements only).
  // Browsers wrap typed text in <div> or <p> tags, but sometimes leave bare
  // text nodes at the top level. We must capture ALL content.
  for (const child of root.childNodes) {
    // Skip text nodes that are just whitespace between block elements
    if (child.nodeType === 3) {
      const text = child.textContent.trim();
      if (text) blocks.push(text);
      continue;
    }
    // Skip comment nodes
    if (child.nodeType !== 1) continue;

    const tag = child.tagName;
    if (tag === "H1") blocks.push("# " + serializeInline(child).trim());
    else if (tag === "H2") blocks.push("## " + serializeInline(child).trim());
    else if (tag === "H3") blocks.push("### " + serializeInline(child).trim());
    else if (tag === "H4") blocks.push("#### " + serializeInline(child).trim());
    else if (tag === "H5") blocks.push("##### " + serializeInline(child).trim());
    else if (tag === "H6") blocks.push("###### " + serializeInline(child).trim());
    else if (tag === "P") {
      // Serialize the paragraph's inline content. Use a "soft trim" that
      // only strips leading/trailing whitespace (not internal newlines from
      // <br> or <div> tags that represent line breaks within the paragraph).
      const raw = serializeInline(child);
      // Strip leading/trailing whitespace but preserve internal newlines
      const text = raw.replace(/^\s+/, '').replace(/\s+$/, '');
      if (text) blocks.push(text);
    }
    else if (tag === "UL" || tag === "OL") blocks.push(serializeList(child).trim());
    else if (tag === "PRE") {
      if (child.getAttribute("data-raw-md") === "1") {
        // Pasted raw markdown — output verbatim (but trim trailing whitespace
        // that the browser may have added)
        blocks.push(getPreContent(child).replace(/\s+$/, ""));
      } else {
        // Code block — extract language and content
        const codeEl = child.querySelector("code");
        const lang = codeEl ? (codeEl.className || "").match(/language-([\w-]+)/)?.[1] || "" : "";
        // CRITICAL: Use getPreContent() instead of textContent.
        // In contenteditable, browsers replace \n with <br> inside <pre>.
        // textContent ignores <br> (returns empty string for it), losing all
        // line breaks. getPreContent() walks the DOM and converts <br> to \n.
        let code = getPreContent(codeEl || child);
        code = code.replace(/\n+$/, ""); // strip trailing newlines
        const maxBackticks = (code.match(/`+/g) || []).reduce((max, s) => Math.max(max, s.length), 0);
        const fenceLength = Math.max(3, maxBackticks + 1);
        const fence = "`".repeat(fenceLength);
        blocks.push(fence + lang + "\n" + code + "\n" + fence);
      }
    }
    else if (tag === "TABLE") blocks.push(serializeTable(child).trim());
    else if (tag === "BLOCKQUOTE") blocks.push(serializeBlockquote(child).trim());
    else if (tag === "HR") blocks.push("---");
    else if (tag === "DIV") {
      // Could be a callout, html-embed, highlight-block, AI-inserted block, or plain div
      if (child.classList.contains("highlight-block")) {
        // Highlight block (@@@ color ... @@@) — serialize back to @@@ syntax
        // CRITICAL: match the COLOR class (blue/green/red/orange/purple), NOT
        // "highlight-block" itself. The regex must exclude "block".
        const colorMatch = child.className.match(/highlight-(blue|green|red|orange|purple)/);
        const color = colorMatch ? colorMatch[1] : "blue";
        const contentMd = domToMarkdown(child);
        blocks.push(`@@@ ${color}\n${contentMd}\n@@@`);
      } else if (child.classList.contains("rec-inserted-block")) {
        // AI-inserted content wrapper — visual only. Serialize children as
        // normal markdown. The wrapper itself produces no markdown output,
        // so reverting (removing the div) cleanly removes the content.
        const inner = domToMarkdown(child);
        if (inner.trim()) blocks.push(inner.trim());
      } else if (child.classList.contains("callout")) {
        // Reconstruct callout from the rendered div
        const titleEl = child.querySelector(".callout-title");
        const contentEl = child.querySelector(".callout-content");
        const typeMatch = child.className.match(/callout-(\w+)/);
        const type = typeMatch ? typeMatch[1] : "note";
        const isCollapsible = child.tagName === "DETAILS";
        const title = titleEl ? titleEl.textContent.trim() : "";
        let header = `> [!${type}]`;
        if (isCollapsible) header += "-";
        if (title) header += ` ${title}`;
        let calloutText = header + "\n";
        if (contentEl) {
          const contentMd = domToMarkdown(contentEl);
          const lines = contentMd.split("\n");
          for (const line of lines) {
            // Obsidian callout format: every line inside a callout must
            // start with "> ". Blank lines inside callouts should be ">"
            // (just the prefix, no trailing space) — NOT empty lines, which
            // would break the callout.
            if (line.trim() === "") {
              calloutText += ">\n";
            } else {
              calloutText += "> " + line + "\n";
            }
          }
        }
        blocks.push(calloutText.trim());
      } else if (child.classList.contains("html-embed-container")) {
        const iframe = child.querySelector("iframe");
        const path = iframe ? iframe.getAttribute("data-path") || "" : "";
        blocks.push("```html-embed\n" + path + "\n```");
      } else {
        // Generic div — could be browser-wrapped text or nested blocks.
        // Try block-level serialization first; if that returns nothing,
        // fall back to inline serialization (captures text nodes).
        const inner = domToMarkdown(child);
        if (inner.trim()) {
          blocks.push(inner.trim());
        } else {
          // No block-level children — serialize as inline text (paragraph)
          const text = serializeInline(child).trim();
          if (text) blocks.push(text);
        }
      }
    }
    else if (tag === "DETAILS") {
      // Collapsible callout. Honor the open/collapsed state:
      //   open   → "> [!type]+"
      //   closed → "> [!type]-"
      const summary = child.querySelector("summary");
      const content = child.querySelector(".callout-content");
      const typeMatch = child.className.match(/callout-(\w+)/);
      const type = typeMatch ? typeMatch[1] : "note";
      const title = summary ? summary.textContent.trim() : "";
      const stateChar = child.hasAttribute("open") ? "+" : "-";
      let header = `> [!${type}]${stateChar}`;
      if (title) header += ` ${title}`;
      let calloutText = header + "\n";
      if (content) {
        const contentMd = domToMarkdown(content);
        const lines = contentMd.split("\n");
        for (const line of lines) {
          // Same fix as the div.callout branch: blank lines become ">"
          if (line.trim() === "") {
            calloutText += ">\n";
          } else {
            calloutText += "> " + line + "\n";
          }
        }
      }
      blocks.push(calloutText.trim());
    }
    else if (tag === "IMG") {
      const alt = child.getAttribute("alt") || "";
      if (alt && alt !== "uploading…") {
        blocks.push(`![[${alt}]]`);
      }
    }
  }
  // Join blocks with blank lines between them
  return blocks.filter(b => b.trim()).join("\n\n");
}

/**
 * Highlight [[note links]] in the editor content. Walks text nodes and wraps
 * the INNER text (without brackets) in styled <span class="note-link">
 * elements, with the brackets as separate text nodes before/after.
 *
 * This is critical: if the span contains "[[text]]", the serializer would
 * output "[[[[text]]]]" (double-wrapping). Instead, the span contains just
 * "text", and the serializer outputs "[[text]]".
 */
function highlightLinksInEditor(root) {
  function walk(node) {
    if (node.nodeType === 3) {
      const text = node.textContent;
      if (text.includes("[[") && text.includes("]]")) {
        const parts = text.split(/(\[\[[^\]]+\]\])/g);
        const fragment = document.createDocumentFragment();
        for (const part of parts) {
          if (part.startsWith("[[") && part.endsWith("]]")) {
            // Extract the inner text (without brackets)
            const inner = part.slice(2, -2);
            // Add "[" "[" as text nodes, then the styled span with inner text,
            // then "]" "]" as text nodes. This way the serializer sees:
            //   text("[[") + span.note-link("text") + text("]]")
            // and outputs: "[[" + "[[text]]" + "]]" — NO, that's still wrong.
            //
            // BETTER APPROACH: Use a special span class "editor-link" (NOT
            // "note-link") so the serializer treats it differently — outputs
            // just the text content (no [[ ]] wrapping), since the brackets
            // are already in the surrounding text nodes.
            fragment.appendChild(document.createTextNode("[["));
            const span = document.createElement("span");
            span.className = "editor-link";
            span.textContent = inner;
            span.setAttribute("contenteditable", "true");
            fragment.appendChild(span);
            fragment.appendChild(document.createTextNode("]]"));
          } else {
            fragment.appendChild(document.createTextNode(part));
          }
        }
        node.parentNode.replaceChild(fragment, node);
      }
    } else if (node.nodeType === 1) {
      if (node.tagName === "PRE" || node.tagName === "CODE") return;
      if (node.classList && (node.classList.contains("note-link") || node.classList.contains("editor-link"))) return;
      const children = Array.from(node.childNodes);
      for (const child of children) walk(child);
    }
  }
  walk(root);
}

// ---- Core editor functions ----
export async function enterEditMode(path, content, noteMap) {
  if (!path || content === undefined || content === null) return;

  const contentDiv = document.getElementById("content");
  const mainEl = document.getElementById("main");
  const savedScroll = mainEl ? mainEl.scrollTop : 0;

  // Detect the line ending of the original content so we can preserve it
  // on save. Default to "\n"; switch to "\r\n" only if CRLF is present.
  editLineEnding = "\n";
  if (content && content.includes("\r\n")) {
    editLineEnding = "\r\n";
  }

  // Reset conflict-detection state for the new note.
  externalChangePending = false;
  originalMtime = null;

  // Fetch the note's mtime from the server for conflict detection.
  // Non-fatal: if it fails, we just skip the 409 check on save.
  try {
    const statRes = await fetch("/api/note?path=" + encodeURIComponent(path));
    const statData = await statRes.json();
    if (statData.success) {
      originalMtime = statData.mtime ?? null;
    }
  } catch (e) { /* non-fatal */ }

  try {
    originalContent = content;
    currentEditPath = path;

    // Build the editor HTML FIRST, before setting isEditing or adding the
    // class. If anything throws here, we haven't changed any state yet.
    let clean = stripFrontmatter(content);
    clean = preprocessCallouts(clean);
  clean = processHighlightBlocks(clean);
    if (window.imageMap) clean = processObsidianEmbeds(clean, path);
    let html = marked.parse(clean);
    html = processHtmlEmbeds(html);
    html = fixImagePaths(html, path);

    const noteName = norm(path).split("/").pop();

    const editorHTML = `
      <div id="externalChangeBanner" class="external-change-banner" style="display:none;">
        ⚠️ This note was modified in another session.
        <button type="button" onclick="window._saveNote()">Save (overwrite)</button>
        <button type="button" onclick="window._reloadFromDisk()">Reload (discard local)</button>
      </div>
      <input type="text" id="editNoteTitle" class="edit-note-title" value="${noteName.replace(/"/g, '&quot;')}" placeholder="Note name" spellcheck="false">
      <div id="editableNote" class="editable-content note-content" contenteditable="true" spellcheck="true">
        ${html}
      </div>
      <div class="edit-actions">
        <button class="btn-save" id="saveBtn">💾 Save</button>
        <button class="btn-cancel" id="cancelBtn">✖ Cancel</button>
      </div>
    `;

    // NOW set the state and apply the changes — all at once, after the
    // HTML is ready. If we get here, everything succeeded.
    isEditing = true;
    contentDiv.classList.add("editing");
    contentDiv.innerHTML = editorHTML;

  // Track title changes — if the user edits the title, the note will be
  // renamed on save (the new name is sent to the server).
  pendingNewName = null;
  const titleInput = document.getElementById("editNoteTitle");
  if (titleInput) {
    titleInput.addEventListener("input", () => {
      const v = titleInput.value.trim();
      if (v && v !== noteName) {
        pendingNewName = v;
      } else {
        pendingNewName = null;
      }
      dirty = true;
    });
    titleInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        document.getElementById("editableNote").focus();
      }
    });
  }

  if (mainEl) {
    mainEl.scrollTop = savedScroll;
    setTimeout(() => { mainEl.scrollTop = savedScroll; }, 10);
  }

  applyContentWidth();
  applyFontSettings();

  const editable = document.getElementById("editableNote");
  if (editable) {
    editable.addEventListener("input", () => { dirty = true; });
    setupPasteHandler(editable);
    setupImageToggle(editable);

    // ---- Enter/Shift+Enter at block boundaries ----
    // Handles:
    // 1. Enter/Shift+Enter at START of a heading → create normal <p> before it
    // 2. Enter on an EMPTY line inside a callout/@@@ block → exit the block,
    //    create a sibling <p> after it
    // 3. Enter at END of a callout/@@@ block's content (last child) → if the
    //    line is empty, exit the block
    editable.addEventListener("keydown", (e) => {
      if (e.key !== "Enter") return;
      const sel = window.getSelection();
      if (!sel || !sel.rangeCount) return;
      const range = sel.getRangeAt(0);
      if (!range.collapsed) return;

      let node = range.startContainer;
      if (node.nodeType === 3) node = node.parentNode;

      // ---- Case 1: Cursor at start of a heading ----
      // Enter or Shift+Enter at offset 0 of <h1>-<h6> should create a normal
      // paragraph BEFORE the heading (not another heading-sized line).
      const heading = node.closest ? node.closest("h1, h2, h3, h4, h5, h6") : null;
      if (heading) {
        const headingRange = document.createRange();
        headingRange.selectNodeContents(heading);
        headingRange.setEnd(range.startContainer, range.startOffset);
        if (headingRange.toString().length === 0) {
          e.preventDefault();
          const p = document.createElement("p");
          p.innerHTML = "<br>";
          heading.parentNode.insertBefore(p, heading);
          const newRange = document.createRange();
          newRange.setStart(p, 0);
          newRange.collapse(true);
          sel.removeAllRanges();
          sel.addRange(newRange);
          dirty = true;
          return;
        }
      }

      // ---- Case 2 & 3: Enter inside a callout or highlight-block ----
      // If the cursor is on an empty line inside a callout/@@@ block,
      // pressing Enter should EXIT the block and create a sibling <p> after it.
      // This matches the convention used by Notion, Obsidian, etc.
      const container = node.closest ? node.closest(".callout-content, .highlight-block") : null;
      if (container) {
        // Check if the current line is empty (cursor is in an empty <p> or
        // text node with only whitespace)
        const currentBlock = node.tagName === "P" ? node : (node.closest ? node.closest("p") : null);
        const currentText = currentBlock ? currentBlock.textContent.trim() : (node.textContent ? node.textContent.trim() : "");
        if (!currentText) {
          // Line is empty → exit the container
          e.preventDefault();
          // Find the container's top-level element (callout div or highlight-block div)
          let topLevel = container;
          while (topLevel.parentNode && topLevel.parentNode !== editable) {
            topLevel = topLevel.parentNode;
          }
          // Remove the empty <p> if it exists
          if (currentBlock && currentBlock !== container) {
            currentBlock.remove();
          }
          // Create a new <p> after the container
          const p = document.createElement("p");
          p.innerHTML = "<br>";
          if (topLevel.nextSibling) {
            editable.insertBefore(p, topLevel.nextSibling);
          } else {
            editable.appendChild(p);
          }
          const newRange = document.createRange();
          newRange.setStart(p, 0);
          newRange.collapse(true);
          sel.removeAllRanges();
          sel.addRange(newRange);
          dirty = true;
          return;
        }
      }
    });
    // Highlight [[links]] in the editor (visual only — no click handlers,
    // so the user can still edit the link text). This runs once on entering
    // edit mode; new links typed by the user won't be highlighted until
    // re-entering edit mode, which is acceptable.
    highlightLinksInEditor(editable);
    let outlineTimer = null;
    editable.addEventListener("input", () => {
      if (outlineTimer) clearTimeout(outlineTimer);
      outlineTimer = setTimeout(() => {
        outlineTimer = null;
        if (window._refreshOutline) window._refreshOutline();
      }, 500);
    });
  }

  document.getElementById("saveBtn").addEventListener("click", () => saveNote());
  document.getElementById("cancelBtn").addEventListener("click", () => exitEditMode(true));

  if (editable) {
    editable.focus();
    const range = document.createRange();
    range.selectNodeContents(editable);
    range.collapse(false);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
  }

  if (window._refreshOutline) window._refreshOutline();
  updateEditToggleIcon();

  } catch (err) {
    // If anything failed, clean up ALL state so the user isn't stuck.
    console.error("enterEditMode failed:", err);
    isEditing = false;
    dirty = false;
    currentEditPath = null;
    pendingNewName = null;
    contentDiv.classList.remove("editing");
    // Restore the note content
    if (_loadNote) {
      const p = _getCurrentNotePath ? _getCurrentNotePath() : null;
      if (p) _loadNote(p, false, savedScroll);
    }
    window.showErrorModal("Edit Mode Error", "Could not enter edit mode: " + err.message);
  }
}

export async function exitEditMode(reload = true) {
  if (dirty) {
    // Three-button choice: Save / Discard / Cancel — shown via a custom
    // modal callout (T10) instead of the native browser confirm() dialog.
    //   - "save"     → save first, then exit (only if save succeeded)
    //   - "discard"  → exit without saving
    //   - "cancel"   → stay in edit mode
    const choice = await _showSavePrompt();
    if (choice === "cancel") return false;
    if (choice === "save") {
      // Save first, then exit only if the save actually cleared `dirty`.
      await saveNote();
      if (dirty) return false; // save failed / conflicted — don't exit
    }
    // choice === "discard" → proceed to exit
  }
  _performExit(reload);
  return true;
}

/**
 * Custom save-prompt modal callout (T10). Replaces the old native confirm()
 * dialog with a styled overlay in the middle of the page. Returns a Promise
 * that resolves to "save" | "discard" | "cancel".
 *
 * - "save"     → user wants to save changes before exiting
 * - "discard"  → user wants to discard changes and exit
 * - "cancel"   → user wants to stay in edit mode
 *
 * Clicking the backdrop (outside the modal) resolves to "cancel".
 */
function _showSavePrompt() {
  return new Promise((resolve) => {
    // Remove any existing prompt (shouldn't happen, but be defensive).
    const existing = document.getElementById("savePromptOverlay");
    if (existing) existing.remove();

    const overlay = document.createElement("div");
    overlay.id = "savePromptOverlay";
    overlay.className = "save-prompt-overlay";
    overlay.innerHTML = `
      <div class="save-prompt-modal">
        <div class="save-prompt-icon">⚠️</div>
        <div class="save-prompt-title">Unsaved Changes</div>
        <div class="save-prompt-message">You have unsaved changes in this note. What would you like to do?</div>
        <div class="save-prompt-actions">
          <button class="save-prompt-btn save-prompt-save" id="savePromptSave">💾 Save and switch</button>
          <button class="save-prompt-btn save-prompt-discard" id="savePromptDiscard">✖ Discard changes</button>
          <button class="save-prompt-btn save-prompt-cancel" id="savePromptCancel">Stay here</button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);

    const close = (result) => {
      overlay.remove();
      resolve(result);
    };

    overlay.querySelector("#savePromptSave").addEventListener("click", () => close("save"));
    overlay.querySelector("#savePromptDiscard").addEventListener("click", () => close("discard"));
    overlay.querySelector("#savePromptCancel").addEventListener("click", () => close("cancel"));
    // Click on the backdrop (not the modal itself) cancels.
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) close("cancel");
    });
  });
}

/**
 * Actually tear down the editor and (optionally) re-render the note in view
 * mode. Extracted from exitEditMode so the save-first path can call it after
 * the async save completes. Does NOT prompt — caller is responsible for that.
 */
function _performExit(reload) {
  // Collapse any active embeds before leaving
  if (activeImageEmbed) collapseImageEmbed();
  if (activeBlockEmbed) collapseBlockEmbed();
  // Capture the path BEFORE nulling it — after a rename, currentEditPath holds
  // the NEW path, while _getCurrentNotePath() still returns the OLD stale path.
  const pathToLoad = currentEditPath;
  isEditing = false;
  dirty = false;
  currentEditPath = null;
  document.getElementById("content").classList.remove("editing");
  if (reload && _loadNote && pathToLoad) {
    const mainEl = document.getElementById("main");
    const savedScroll = mainEl ? mainEl.scrollTop : 0;
    _loadNote(pathToLoad, false, savedScroll);
  }
  updateEditToggleIcon();
}

export async function saveNote() {
  // ---- Save mutex / queue ----
  // If a save is already in-flight, mark that a re-save is pending and
  // return immediately. When the in-flight save finishes, it will re-snapshot
  // the DOM and call itself again — so the very latest keystrokes are saved.
  if (saveInProgress) {
    pendingResave = true;
    return;
  }
  saveInProgress = true;

  // ---- Visual feedback: update the Save button ----
  const saveBtn = document.getElementById("saveBtn");
  if (saveBtn) {
    saveBtn.disabled = true;
    saveBtn.textContent = "💾 Saving...";
  }

  // Capture the markdown snapshot UP FRONT. Any keystrokes that land after
  // this point are not part of this save — but because we no longer call
  // exitEditMode, the editor DOM stays alive and those keystrokes are not
  // lost; they'll be captured by the next saveNote() (or the pendingResave
  // triggered just above).
  const editable = document.getElementById("editableNote");
  if (!editable) {
    saveInProgress = false;
    return;
  }

  // Set the saving flag — this blocks refreshVaultData from re-rendering
  // during the save sequence (the server broadcasts fileChanged via SSE
  // after saving, which would destroy the editor mid-save).
  isSaving = true;
  window._isSaving = true;

  // Collapse any active embeds before serializing
  if (activeImageEmbed) collapseImageEmbed();
  if (activeBlockEmbed) collapseBlockEmbed();

  let markdown = domToMarkdown(editable);
  // Collapse 3+ consecutive newlines to 2, BUT preserve newlines inside
  // fenced code blocks (``` ... ```). We split on code fences and only
  // apply the collapse to non-code sections.
  markdown = collapseNewlinesOutsideCodeBlocks(markdown);

  // Preserve original frontmatter if present
  if (originalContent && originalContent.trimStart().startsWith("---")) {
    const fmMatch = originalContent.match(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/);
    if (fmMatch) {
      markdown = fmMatch[0] + "\n" + markdown;
    }
  }

  // Preserve the detected line ending. The DOM serializer always emits LF;
  // if the original file used CRLF, convert before sending to the server.
  if (editLineEnding === "\r\n") {
    markdown = markdown.replace(/\r?\n/g, "\r\n");
  }

  const path = currentEditPath;
  if (!path) {
    isSaving = false;
    window._isSaving = false;
    saveInProgress = false;
    // Drain the queue just in case a pendingResave was set.
    if (pendingResave) {
      pendingResave = false;
      saveNote();
    }
    return;
  }

  // If the user edited the title, compute the new path and send a rename
  // request to the server BEFORE saving the content.
  let savePath = path;
  if (pendingNewName) {
    const slashIdx = path.lastIndexOf("/");
    const dir = slashIdx >= 0 ? path.slice(0, slashIdx) : "";
    const newPath = dir ? dir + "/" + pendingNewName : pendingNewName;
    try {
      const renameRes = await fetch("/api/rename-note", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ oldPath: path, newPath: newPath }),
      });
      const renameData = await renameRes.json();
      if (!renameData.success) throw new Error(renameData.error || "Rename failed");
      savePath = newPath;
      // Update currentEditPath so a later exitEditMode loads the right note
      currentEditPath = newPath;
      // Update the navigation module's current path
      if (_getCurrentNotePath) {
        // Force-update via the note map
        if (_updateNoteMap) _updateNoteMap(newPath, markdown);
      }
    } catch (err) {
      isSaving = false;
      window._isSaving = false;
      saveInProgress = false;
      // Drain the queue even on rename failure so a later Ctrl+S isn't stuck.
      if (pendingResave) {
        pendingResave = false;
        saveNote();
      }
      window.showErrorModal("Rename Error", "Error renaming note: " + err.message);
      return;
    }
    pendingNewName = null;
  }

  try {
    const res = await fetch("/api/save-note", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        path: savePath,
        content: markdown,
        expectedMtime: originalMtime,
      }),
    });

    // 409 Conflict — the file was modified on disk since originalMtime.
    // Surface the external-change banner instead of overwriting.
    if (res.status === 409) {
      notifyExternalChange();
      isSaving = false;
      window._isSaving = false;
      saveInProgress = false;
      // Drain the queue — but a pendingResave here would just re-conflict,
      // so we drop it. The user must explicitly choose Save (overwrite) or
      // Reload from the banner.
      pendingResave = false;
      return;
    }

    const data = await res.json();
    if (!data.success) throw new Error(data.error || "Save failed");

    // Save succeeded — update local state
    originalContent = markdown;
    if (_updateNoteMap) _updateNoteMap(savePath, markdown);
    if (data.mtime !== undefined) originalMtime = data.mtime;
    externalChangePending = false;
    const banner = document.getElementById("externalChangeBanner");
    if (banner) banner.style.display = "none";
    dirty = false;

    // Refresh the vault tree so nameToPath is up-to-date.
    if (window._refreshVault) {
      try {
        await window._refreshVault();
      } catch (e) { /* non-fatal */ }
    }

    // ---- Refresh the image map so newly-pasted images resolve ----
    // The vault refresh above updates imageMap, but only if it took the
    // "full refresh" path. If it took a shortcut (e.g. editing === true),
    // the imageMap might be stale. Explicitly fetch a fresh image map.
    try {
      const imgRes = await fetch("/api/images");
      const imgData = await imgRes.json();
      if (imgData.success) {
        window.imageMap = imgData.images || {};
      }
    } catch (e) { /* non-fatal */ }

    // ---- Exit to view mode (user requested this behavior) ----
    isSaving = false;
    window._isSaving = false;
    _performExit(true);
    isSaving = true;
    window._isSaving = true;
  } catch (err) {
    isSaving = false;
    window._isSaving = false;
    saveInProgress = false;
    // Restore the Save button on error
    if (saveBtn) {
      saveBtn.disabled = false;
      saveBtn.textContent = "💾 Save";
    }
    // Drain the queue on error too — otherwise a stuck pendingResave would
    // prevent any future Ctrl+S from doing anything.
    if (pendingResave) {
      pendingResave = false;
      saveNote();
    }
    window.showErrorModal("Save Error", "Error saving note: " + err.message);
    return;
  }

  // Clear isSaving after a longer window so the SSE fileChanged (from our
  // own save) is suppressed. 2 seconds is generous enough for the SSE
  // event to arrive even on slow connections.
  // We also store the last-saved path + content so refreshVaultData can
  // suppress the SSE echo by content match (not just timing).
  window._lastSavedPath = savePath;
  window._lastSavedContent = markdown;
  setTimeout(() => {
    isSaving = false;
    window._isSaving = false;
    window._lastSavedPath = null;
    window._lastSavedContent = null;
  }, 2000);

  // ---- Drain the save queue ----
  // If a second save was requested while we were in-flight, re-snapshot
  // the DOM and save again. This captures any keystrokes that landed
  // between our initial snapshot and now.
  saveInProgress = false;

  // Restore the Save button
  if (saveBtn) {
    saveBtn.disabled = false;
    saveBtn.textContent = "💾 Save";
  }

  if (pendingResave) {
    pendingResave = false;
    // Fire-and-forget — saveNote is async and self-manages the mutex.
    saveNote();
  }
}

export function toggleEditMode(noteMap, getCurrentNotePath, loadNote) {
  if (getCurrentNotePath) _getCurrentNotePath = getCurrentNotePath;
  if (loadNote) _loadNote = loadNote;
  if (isEditing) {
    exitEditMode(true);
  } else {
    const path = _getCurrentNotePath ? _getCurrentNotePath() : null;
    if (!path) return;
    const content = noteMap[path];
    if (content === undefined || content === null) return;
    enterEditMode(path, content, noteMap);
  }
}

export function getEditorState() {
  return { isEditing, currentEditPath, originalContent, dirty, isSaving };
}

// ======================================================
//  EXTERNAL CHANGE DETECTION (T2-5)
// ======================================================
// Called (typically by vault.js) when an SSE fileChanged arrives for the note
// currently being edited. Sets a flag and shows a banner so the user can pick:
//   - Save (overwrite)  → forced save, ignoring the mtime mismatch
//   - Reload            → discard local edits and re-fetch from disk
//
// If a save is in-flight (isSaving), we ignore the event — our own save just
// triggered the SSE, and the banner would be a false positive.
export function notifyExternalChange() {
  if (isEditing && !isSaving) {
    externalChangePending = true;
    const banner = document.getElementById("externalChangeBanner");
    if (banner) banner.style.display = "block";
  }
}

/**
 * Reload the note content from disk and re-render the editor with it.
 * Discards any local unsaved edits. Triggered by the "Reload (discard local)"
 * button in the external-change banner.
 */
export async function reloadFromDisk() {
  if (!currentEditPath) return;
  const path = currentEditPath;
  // Re-fetch the note content from the server.
  try {
    const res = await fetch("/api/note?path=" + encodeURIComponent(path));
    const data = await res.json();
    if (data.success) {
      originalContent = data.content;
      if (data.mtime !== undefined) originalMtime = data.mtime;
      externalChangePending = false;
      const banner = document.getElementById("externalChangeBanner");
      if (banner) banner.style.display = "none";
      // Re-render the editor with the fresh content. We pass `null` for
      // noteMap because we already have the content; enterEditMode only
      // uses noteMap for the initial lookup (which we've bypassed).
      enterEditMode(path, data.content, null);
    } else {
      window.showErrorModal("Reload Failed", "Failed to reload: " + (data.error || "unknown error"));
    }
  } catch (e) {
    window.showErrorModal("Reload Failed", "Failed to reload: " + e.message);
  }
}

// ======================================================
//  AI RECOMMENDATION INSERTION
// ======================================================
// Called when the user clicks "Accept & Insert" on a recommendation card in
// the chat panel. Enters edit mode (if not already), finds the target location
// in the note's markdown, inserts the recommended content, and re-renders the
// editor so the user immediately sees the result. The note is NOT auto-saved —
// the user reviews the change and saves manually (Ctrl+S or the Save button).
//
// @param mode   — "after" | "before" | "at-end" | "at-start"
// @param anchor — the text to find in the note (for "after"/"before")
// @param content — the markdown content to insert
// @returns { success: boolean, error?: string }

export async function acceptRecommendation(mode, anchor, content, recId, intendedNotePath) {
  if (!_getCurrentNotePath) {
    return { success: false, error: "No note is currently open." };
  }
  const path = _getCurrentNotePath();
  if (!path) {
    return { success: false, error: "No note is currently open." };
  }

  // The note name for error messages — normalize paths to forward slashes
  // and compare by the last path segment (note name) to avoid mismatches
  // from backslash/forwardslash differences or folder prefixes.
  const currentNoteName = path.replace(/\\/g, "/").split("/").pop();
  const intendedNoteName = intendedNotePath ? intendedNotePath.replace(/\\/g, "/").split("/").pop() : currentNoteName;
  const isWrongNote = intendedNotePath && intendedNoteName.toLowerCase() !== currentNoteName.toLowerCase();

  // Use the provided recId, or generate one. This ID is stamped on the
  // .rec-inserted-block div so revertRecommendation() can find and remove it.
  const id = recId || ("rec-" + Math.random().toString(36).slice(2, 10));

  // ---- 1. Get the current note markdown ----
  let markdown;
  if (isEditing) {
    // Already editing — serialize the current editor state
    const editable = document.getElementById("editableNote");
    if (!editable) return { success: false, error: "Editor is not ready." };
    if (activeImageEmbed) collapseImageEmbed();
    if (activeBlockEmbed) collapseBlockEmbed();
    markdown = domToMarkdown(editable);
    // Collapse 3+ consecutive newlines to 2, BUT preserve newlines inside
  // fenced code blocks (``` ... ```). We split on code fences and only
  // apply the collapse to non-code sections.
  markdown = collapseNewlinesOutsideCodeBlocks(markdown);
    // Preserve original frontmatter
    if (originalContent && originalContent.trimStart().startsWith("---")) {
      const fmMatch = originalContent.match(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/);
      if (fmMatch) {
        markdown = fmMatch[0] + "\n" + markdown;
      }
    }
  } else {
    // Not editing — grab from noteMap (via window._getNoteContent) and enter edit mode
    const noteContent = window._getNoteContent ? window._getNoteContent(path) : null;
    if (noteContent === null || noteContent === undefined) {
      return { success: false, error: "Could not load note content." };
    }
    markdown = noteContent;
  }

  // ---- 2. Split off frontmatter (insert into body only) ----
  let frontmatter = "";
  let body = markdown;
  if (markdown.trimStart().startsWith("---")) {
    const fmMatch = markdown.match(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/);
    if (fmMatch) {
      frontmatter = fmMatch[0];
      body = markdown.slice(fmMatch[0].length);
    }
  }

  // ---- 3. Compute insertion point — returns { before, after } split ----
  // Pass the content so the fallback can search for the most relevant heading
  const result = computeInsertionSplit(body, mode, anchor, content);
  if (!result.inserted) {
    // Two distinct error messages based on whether the user is on the
    // intended note or a different one.
    if (isWrongNote) {
      // Case 1: User is on a DIFFERENT note than the one the recommendation
      // was created for.
      return {
        success: false,
        error: `This recommendation was created for note "${intendedNoteName}". You are currently in note "${currentNoteName}". Switch to "${intendedNoteName}" to insert it.`,
        notePath: intendedNotePath,
        intendedNoteName: intendedNoteName,
        currentNoteName: currentNoteName,
        wrongNote: true,
      };
    }
    // Case 2: User IS on the intended note, but the anchor (section heading)
    // isn't found — the note was edited since the recommendation was generated.
    return {
      success: false,
      error: `This recommendation was created for note "${currentNoteName}". You are currently in note "${currentNoteName}", but the note has been edited since the recommendation was generated, and the section after which this AI section would be inserted is not found. The section may have been renamed, edited, or removed.`,
      notePath: path,
      intendedNoteName: currentNoteName,
      currentNoteName: currentNoteName,
      wrongNote: false,
    };
  }

  // ---- 4. Enter edit mode (if not already) ----
  // We enter with the ORIGINAL content first (to set up the editor UI), then
  // overwrite the editable div's HTML with the split-rendered content.
  if (!isEditing) {
    const noteContent = window._getNoteContent ? window._getNoteContent(path) : null;
    if (noteContent === null || noteContent === undefined) {
      return { success: false, error: "Could not load note content." };
    }
    enterEditMode(path, noteContent, null);
    await new Promise((r) => setTimeout(r, 80));
  }

  // ---- 5. Render the FULL markdown as ONE document ----
  // We wrap the inserted content in @@@ markers (the custom highlight-block
  // syntax). This is processed by processHighlightBlocks() which converts
  // it to a styled <div class="highlight-block"> in the rendered HTML.
  // On save, domToMarkdown() converts it back to @@@ syntax.
  // This is MUCH more robust than the old sentinel approach — no DOM walking,
  // no comment nodes, no split-boundary issues. The @@@ markers ARE the
  // markdown, so they survive round-trips perfectly.
  //
  // We use the rec-id as the "color" name temporarily, then after rendering
  // we find the div and restyle it to blue + add data-rec-id for revert.
  const fullMarkdown = result.before + "\n\n@@@ " + id + "\n" + content + "\n@@@\n\n" + result.after;

  let clean = stripFrontmatter(fullMarkdown);
  clean = preprocessCallouts(clean);
  clean = processHighlightBlocks(clean);
  if (window.imageMap) clean = processObsidianEmbeds(clean, path);
  let fullHtml = marked.parse(clean);
  fullHtml = processHtmlEmbeds(fullHtml);
  fullHtml = fixImagePaths(fullHtml, path);

  const editable = document.getElementById("editableNote");
  if (!editable) {
    return { success: false, error: "Editor failed to open." };
  }
  editable.innerHTML = fullHtml;

  // Find the inserted highlight block (it has class highlight-{id}) and
  // restyle it to blue + add rec-inserted-block class for revert.
  const insertedBlock = editable.querySelector(".highlight-" + CSS.escape(id));
  if (insertedBlock) {
    insertedBlock.classList.remove("highlight-" + id);
    insertedBlock.classList.add("highlight-blue", "rec-inserted-block");
    insertedBlock.dataset.recId = id;
  }
  highlightLinksInEditor(editable);

  // ---- 6. Update editor state ----
  // Build the full markdown (without the wrapper — it's visual only) for
  // noteMap and originalContent. The wrapper is reconstructed from the
  // Build the full markdown with @@@ markers around the inserted content.
  // The @@@ blue ... @@@ is preserved on save and rendered as a styled box
  // in both the editor and viewer. In Obsidian it appears as plain text.
  const newBody = collapseNewlinesOutsideCodeBlocks(
    result.before + "\n\n@@@ blue\n" + content + "\n@@@\n\n" + result.after
  );
  const newMarkdown = frontmatter + newBody;
  originalContent = newMarkdown;
  dirty = true;
  if (window._updateNoteMap) window._updateNoteMap(path, newMarkdown);

  // ---- 7. Refresh the outline so new headings show up ----
  if (window._refreshOutline) {
    setTimeout(() => window._refreshOutline(), 100);
  }

  // ---- 8. Scroll to the inserted block ----
  setTimeout(() => {
    const mainEl = document.getElementById("main");
    if (!mainEl) return;
    const block = editable.querySelector(`.rec-inserted-block[data-rec-id="${id}"]`);
    if (block) {
      const rect = block.getBoundingClientRect();
      const mainRect = mainEl.getBoundingClientRect();
      mainEl.scrollTop += rect.top - mainRect.top - 40;
    }
  }, 150);

  return { success: true, recId: id };
}

// Revert a previously-accepted recommendation. Removes the .rec-inserted-block
// div with the matching data-rec-id from the editor, then re-serializes the
// editor content to update originalContent and noteMap. Does NOT auto-save —
// the user still needs to press Ctrl+S or the Save button to persist.
export function revertRecommendation(recId) {
  if (!isEditing) {
    return { success: false, error: "Not in edit mode — nothing to revert." };
  }
  const editable = document.getElementById("editableNote");
  if (!editable) return { success: false, error: "Editor is not ready." };

  const block = editable.querySelector(`.rec-inserted-block[data-rec-id="${recId}"]`);
  if (!block) {
    return { success: false, error: "Inserted block not found — it may have been deleted already." };
  }

  // Remove the block (and any surrounding empty wrappers)
  block.remove();

  // Re-serialize the editor content to markdown
  if (activeImageEmbed) collapseImageEmbed();
  if (activeBlockEmbed) collapseBlockEmbed();
  let markdown = domToMarkdown(editable);
  // Collapse 3+ consecutive newlines to 2, BUT preserve newlines inside
  // fenced code blocks (``` ... ```). We split on code fences and only
  // apply the collapse to non-code sections.
  markdown = collapseNewlinesOutsideCodeBlocks(markdown);

  // Preserve original frontmatter
  if (originalContent && originalContent.trimStart().startsWith("---")) {
    const fmMatch = originalContent.match(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/);
    if (fmMatch) {
      markdown = fmMatch[0] + "\n" + markdown;
    }
  }

  const path = currentEditPath;
  originalContent = markdown;
  dirty = true;
  if (window._updateNoteMap) window._updateNoteMap(path, markdown);

  if (window._refreshOutline) {
    setTimeout(() => window._refreshOutline(), 100);
  }

  return { success: true };
}

// Split `body` into { before, after } at the insertion point determined by
// mode + anchor. The `content` itself is NOT included in the return value —
// the caller inserts it between `before` and `after`.
// Returns { inserted: boolean, before?: string, after?: string }.
function computeInsertionSplit(body, mode, anchor, content) {
  const lines = body.split("\n");
  let insertIndex = -1;

  if (mode === "at-end") {
    insertIndex = lines.length;
  } else if (mode === "at-start") {
    insertIndex = 0;
    while (insertIndex < lines.length && lines[insertIndex].trim() === "") {
      insertIndex++;
    }
  } else if (mode === "before") {
    if (!anchor) return { inserted: false };
    const needle = anchor.toLowerCase();
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].toLowerCase().includes(needle)) {
        insertIndex = i;
        break;
      }
    }
  } else if (mode === "after") {
    if (!anchor) return { inserted: false };
    const needle = anchor.toLowerCase();
    let foundIndex = -1;
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].toLowerCase().includes(needle)) {
        foundIndex = i;
        break;
      }
    }

    // ---- FALLBACK: if the AI's anchor wasn't found, try to find the most
    // relevant heading based on the content of the recommendation. ----
    if (foundIndex === -1 && content) {
      foundIndex = findMostRelevantHeading(lines, content);
    }

    if (foundIndex === -1) return { inserted: false };

    // If it's a heading, find the end of that section (next heading of
    // same or higher level, or end of document).
    const headingMatch = lines[foundIndex].match(/^(#{1,6})\s/);
    if (headingMatch) {
      const level = headingMatch[1].length;
      let j = foundIndex + 1;
      while (j < lines.length) {
        const nextHeading = lines[j].match(/^(#{1,6})\s/);
        if (nextHeading && nextHeading[1].length <= level) break;
        j++;
      }
      insertIndex = j;
    } else {
      insertIndex = foundIndex + 1;
    }
  } else {
    return { inserted: false };
  }

  if (insertIndex === -1) {
    return { inserted: false };
  }

  // ---- CALLOUT + CODE BLOCK SAFEGUARD ----
  // If the insertion point is in the MIDDLE of a callout (consecutive `>`
  // lines) or a code block (between ``` fences), move the insertIndex PAST
  // the block to avoid splitting it.

  if (insertIndex > 0 && insertIndex < lines.length) {
    const prevLine = lines[insertIndex - 1];
    const nextLine = lines[insertIndex];

    // Check for callout: both prev and next lines start with >
    if (prevLine.trim().startsWith(">") && nextLine.trim().startsWith(">")) {
      let k = insertIndex;
      while (k < lines.length && lines[k].trim().startsWith(">")) {
        k++;
      }
      while (k < lines.length && lines[k].trim() === "") {
        k++;
      }
      insertIndex = k;
    }

    // Check for code block: count ``` fences before insertIndex. If odd,
    // we're inside a code block — skip to the end of it.
    let fenceCount = 0;
    for (let i = 0; i < insertIndex; i++) {
      if (lines[i].trim().startsWith("```")) fenceCount++;
    }
    if (fenceCount % 2 === 1) {
      // We're inside a code block — find the closing fence
      let k = insertIndex;
      while (k < lines.length && !lines[k].trim().startsWith("```")) {
        k++;
      }
      k++; // skip past the closing fence
      while (k < lines.length && lines[k].trim() === "") {
        k++;
      }
      insertIndex = k;
    }
  }

  // Ensure blank line separation: trim trailing blank lines from `before`
  // and leading blank lines from `after`, then the caller adds \n\n between
  // them which guarantees proper separation.
  let beforeLines = lines.slice(0, insertIndex);
  let afterLines = lines.slice(insertIndex);

  // Trim trailing blank lines from before (but keep at least the content)
  while (beforeLines.length > 0 && beforeLines[beforeLines.length - 1].trim() === "") {
    beforeLines.pop();
  }
  // Trim leading blank lines from after
  while (afterLines.length > 0 && afterLines[0].trim() === "") {
    afterLines.shift();
  }

  const before = beforeLines.join("\n");
  const after = afterLines.join("\n");
  return { inserted: true, before, after };
}

// Extract text content from a <pre> or <code> element, converting <br> tags
// to \n. This is necessary because in contenteditable mode, browsers replace
// \n characters with <br> tags inside <pre> elements. textContent ignores
// <br> (returns empty string for it), which loses all line breaks.
function getPreContent(el) {
  let result = "";
  for (const node of el.childNodes) {
    if (node.nodeType === 3) {
      // Text node — preserve as-is
      result += node.textContent;
    } else if (node.nodeType === 1) {
      if (node.tagName === "BR") {
        result += "\n";
      } else {
        // Recurse into child elements (e.g., <code> inside <pre>, or <div>
        // wrappers the browser may have added)
        result += getPreContent(node);
      }
    }
  }
  return result;
}

// Collapse 3+ consecutive newlines to 2, but ONLY outside fenced code blocks.
// Code block content is whitespace-significant and must be preserved exactly.
function collapseNewlinesOutsideCodeBlocks(markdown) {
  const lines = markdown.split("\n");
  const result = [];
  let inCodeBlock = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Track code fence state
    if (line.trim().startsWith("```") || line.trim().startsWith("~~~")) {
      inCodeBlock = !inCodeBlock;
      result.push(line);
      continue;
    }

    if (inCodeBlock) {
      // Inside a code block — preserve everything exactly
      result.push(line);
    } else {
      // Outside code blocks — collect runs of blank lines and collapse
      if (line.trim() === "") {
        // Look ahead to count consecutive blank lines
        let blankCount = 1;
        while (i + 1 < lines.length && lines[i + 1].trim() === "" && !isCodeFence(lines[i + 1])) {
          blankCount++;
          i++;
        }
        // Output at most 2 blank lines (1 blank line = \n\n in markdown)
        if (blankCount >= 2) {
          result.push(""); // one blank line
        } else {
          result.push("");
        }
      } else {
        result.push(line);
      }
    }
  }

  return result.join("\n");
}

function isCodeFence(line) {
  return line.trim().startsWith("```") || line.trim().startsWith("~~~");
}

// Find the most relevant heading in the note for the given recommendation content.
// Uses keyword overlap: extracts significant words from the content and finds
// the heading whose section has the most overlapping keywords.
function findMostRelevantHeading(lines, content) {
  // Extract keywords from the recommendation content (words > 3 chars, lowercased)
  const stopWords = new Set(["the", "and", "for", "with", "that", "this", "from", "have", "your", "will", "they", "their", "which", "would", "could", "should", "what", "when", "where", "while", "about", "into", "also", "such", "than", "then", "them", "were", "been", "more", "most", "some", "only", "very", "like", "just", "over", "both", "each", "make", "made", "does", "done"]);
  const contentWords = content.toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 3 && !stopWords.has(w));
  const contentWordSet = new Set(contentWords);

  // Collect all headings with their line index
  const headings = [];
  for (let i = 0; i < lines.length; i++) {
    const match = lines[i].match(/^(#{1,6})\s+(.+)$/);
    if (match) {
      headings.push({ index: i, level: match[1].length, title: match[2] });
    }
  }

  if (headings.length === 0) return -1;

  // For each heading, count keyword overlaps between the heading title + its
  // section content and the recommendation content
  let bestHeading = -1;
  let bestScore = 0;

  for (let h = 0; h < headings.length; h++) {
    const heading = headings[h];
    const headingWords = heading.title.toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter(w => w.length > 3 && !stopWords.has(w));

    // Count heading title keyword overlap (weighted 3x — title match is strong)
    let score = 0;
    for (const w of headingWords) {
      if (contentWordSet.has(w)) score += 3;
    }

    // Count section content keyword overlap (find the end of this section)
    const nextHeadingIdx = (h + 1 < headings.length) ? headings[h + 1].index : lines.length;
    let sectionWords = 0;
    for (let i = heading.index + 1; i < nextHeadingIdx; i++) {
      const words = lines[i].toLowerCase()
        .replace(/[^a-z0-9\s]/g, ' ')
        .split(/\s+/)
        .filter(w => w.length > 3 && !stopWords.has(w));
      for (const w of words) {
        if (contentWordSet.has(w)) score += 1;
      }
      sectionWords += words.length;
    }

    // Normalize by section length to avoid bias toward long sections
    if (sectionWords > 0) {
      score = score / Math.sqrt(sectionWords) * 10; // sqrt for soft normalization
    }

    if (score > bestScore) {
      bestScore = score;
      bestHeading = heading.index;
    }
  }

  // If no heading scored above 0, fall back to "at-end"
  if (bestScore === 0) return -1;

  console.log(`findMostRelevantHeading: best heading at line ${bestHeading} (score ${bestScore.toFixed(2)})`);
  return bestHeading;
}
