// ======================================================
//  VAULT MODULE (js/vault.js)
// ======================================================

import {
  stripFrontmatter,
  processObsidianEmbeds,
  processObsidianLinks,
  processHtmlEmbeds,
  processMermaid,
  processHighlightBlocks,
  preprocessCallouts,
  fixImagePaths,
  wrapTables,
} from "./markdown.js";
import {
  loadTabsFromStorage,
  renderTabs,
  openTab,
  closeTab,
  getActiveTabPath,
  setActiveTabPath,
} from "./tabs.js";
import {
  navigateTo,
  getCurrentNotePath,
  setCurrentNotePath,
  updateBackButton,
  setupBackButton,
} from "./navigation.js";
import {
  applyEmbedSettings,
  applyFontSettings,
  applyImageAlignment,
} from "./settings.js";
import {
  flattenTree,
  setFlatItems,
  renderTree,
  expandAndHighlightNote,
  setActivePath,
} from "./sidebar.js";

// ---- Global state ----
export let noteMap = {};
export let nameToPath = {};

// Scroll memory: stores the last scroll position per note path.
// Updated on EVERY scroll event (so it's always current) and restored
// instantly when switching back to a previously-visited note.
const scrollMemory = new Map();
let lastUserScrollTime = 0; // timestamp of last scroll — used to prevent scroll fighting
let scrollSaveTimer = null;

// ---- SSE state ----
// Debounce timer for treeChanged events — Obsidian/watcher can fire several
// treeChanged events in rapid succession (e.g. bulk create, multi-file
// rename). Without debouncing, each one triggers a full /api/vault-tree +
// /api/images refetch, hammering the server and causing render races.
let treeChangedDebounce = null;
// Exponential backoff for SSE reconnection. Doubles on each failure (capped
// at 60s) and resets to 1s on a successful connection.
let sseRetryDelay = 1000;

/**
 * Normalize a note path to use forward slashes.
 */
function norm(p) {
  return p ? String(p).replace(/\\/g, "/") : p;
}

/**
 * Set up the scroll-save listener on #main. Fires on every scroll, debounced
 * to 150ms. Saves the current scroll position for the current note path so
 * it can be restored when the user returns to this note later.
 */
export function setupScrollMemory() {
  const mainEl = document.getElementById("main");
  if (!mainEl) return;
  mainEl.addEventListener("scroll", () => {
    // Track the last time the user scrolled — used by renderNoteContent
    // to avoid fighting the user's scroll when an async loadNote completes.
    lastUserScrollTime = Date.now();
    if (scrollSaveTimer) clearTimeout(scrollSaveTimer);
    scrollSaveTimer = setTimeout(() => {
      scrollSaveTimer = null;
      const current = norm(getCurrentNotePath());
      if (current) {
        scrollMemory.set(current, mainEl.scrollTop);
      }
    }, 150);
  }, { passive: true });
}

// ---- Internal: render note content without scroll reset ----
// options.skipSidebarUpdate: when true, skip expandAndHighlightNote (used for
//   live-preview content updates so the sidebar doesn't re-scroll on every
//   keystroke in Obsidian).
//
// SCROLL PRESERVATION: simple pixel-based approach. Capture scrollTop before
// re-render, restore it immediately after innerHTML, and re-apply after a
// short timeout. This is more reliable than anchor-based approaches.
function renderNoteContent(path, preserveScroll = null, options = {}) {
  path = norm(path);
  const contentDiv = document.getElementById("content");
  const content = noteMap[path];
  if (content === undefined || content === null) {
    contentDiv.innerHTML = '<p class="empty-state">Note not found.</p>';
    return;
  }

  const mainEl = document.getElementById("main");

  // Determine the target scroll position:
  // 1. If preserveScroll is explicitly provided (edit mode exit), use it
  // 2. If we have a saved scroll position in scrollMemory, use it (returning to a note)
  // 3. Otherwise use the current scrollTop (live preview) or 0 (first visit)
  let targetScroll = preserveScroll;
  if (targetScroll === null || targetScroll === undefined) {
    if (scrollMemory.has(path)) {
      targetScroll = scrollMemory.get(path);
    } else {
      targetScroll = mainEl ? mainEl.scrollTop : 0;
    }
  }

  // ---- Record which <details> (collapsible callouts) are currently open ----
  const openCalloutTitles = new Set();
  contentDiv.querySelectorAll("details.callout").forEach((d) => {
    if (d.hasAttribute("open")) {
      const summary = d.querySelector("summary");
      const title = summary ? summary.textContent.trim() : "";
      if (title) openCalloutTitles.add(title);
    }
  });

  if (!options.skipSidebarUpdate) {
    setActivePath(path);
  }

  let cleanContent = stripFrontmatter(content);
  cleanContent = preprocessCallouts(cleanContent);
  cleanContent = processHighlightBlocks(cleanContent);
  cleanContent = processObsidianEmbeds(cleanContent, path);

  let rawHtml = marked.parse(cleanContent);
  rawHtml = processHtmlEmbeds(rawHtml);
  rawHtml = processMermaid(rawHtml);
  // Fix standard markdown image paths (![alt](path)) to resolve to /vault/...
  // This handles images in subfolders (like assets/foo.png) that marked
  // would otherwise leave as relative URLs.
  rawHtml = fixImagePaths(rawHtml, path);

  contentDiv.innerHTML = rawHtml;

  applyImageAlignment();
  // Wrap tables in scrollable containers so wide tables (and tables inside
  // @@@ highlight blocks) scroll horizontally instead of overflowing.
  wrapTables(contentDiv);

  const firstChild = contentDiv.firstElementChild;
  if (!firstChild || firstChild.tagName !== "H1") {
    const h1 = document.createElement("h1");
    const cleanPath = path.replace(/\\/g, "/");
    const noteName = cleanPath.split("/").pop();
    h1.textContent = noteName;
    contentDiv.insertBefore(h1, contentDiv.firstChild);
  }

  processObsidianLinks(contentDiv, nameToPath);

  // ---- Re-open collapsible callouts ----
  if (openCalloutTitles.size > 0) {
    contentDiv.querySelectorAll("details.callout").forEach((d) => {
      const summary = d.querySelector("summary");
      const title = summary ? summary.textContent.trim() : "";
      if (openCalloutTitles.has(title)) {
        d.setAttribute("open", "");
      }
    });
  }

  // ---- Wire up HTML embed fullscreen buttons ----
  contentDiv.querySelectorAll(".html-embed-fullscreen-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      const embedPath = btn.dataset.path;
      const url = "/vault/" + embedPath;
      const overlay = document.createElement("div");
      overlay.className = "html-embed-fullscreen-overlay";
      overlay.innerHTML = `
        <button class="html-embed-fullscreen-close" title="Close (Esc)">✕</button>
        <iframe src="${url}" style="border:none;"></iframe>
      `;
      document.body.appendChild(overlay);
      const closeBtn = overlay.querySelector(".html-embed-fullscreen-close");
      closeBtn.addEventListener("click", () => overlay.remove());
      const escHandler = (e) => {
        if (e.key === "Escape") {
          overlay.remove();
          document.removeEventListener("keydown", escHandler);
        }
      };
      document.addEventListener("keydown", escHandler);
    });
  });

  // ---- Sidebar update (does NOT touch #main scroll anymore) ----
  if (!options.skipSidebarUpdate) {
    expandAndHighlightNote(path);
  }

  // ---- Restore scroll INSTANTLY (no smooth, no delays) ----
  // BUT: only restore if the user hasn't scrolled in the last 500ms.
  // If they have, it means the async loadNote completed while they were
  // already scrolling — restoring the old position would "fight" them.
  // In that case, let them keep their current position.
  if (mainEl && targetScroll !== undefined && targetScroll !== null) {
    const timeSinceLastScroll = Date.now() - lastUserScrollTime;
    if (timeSinceLastScroll > 500) {
      // User hasn't scrolled recently — safe to restore
      mainEl.scrollTo({ top: targetScroll, behavior: "instant" });
      requestAnimationFrame(() => {
        mainEl.scrollTo({ top: targetScroll, behavior: "instant" });
      });
    }
    // else: user is actively scrolling — don't fight them
  }

  localStorage.setItem("lastNote", path);

  // Track recent note for the Daily Review Dashboard
  if (window._trackRecentNote) window._trackRecentNote(path);

  applyEmbedSettings();
  applyFontSettings();

  if (window._updateEditToggleIcon) window._updateEditToggleIcon();
  contentDiv.classList.remove("editing");
  setCurrentNotePath(path);

  if (window._refreshOutline) window._refreshOutline();
}

// ---- Apply replacements to DOM (for broken-link fixes AND image swaps) ----
//
// replacements is an array of { original, fixed } pairs. We handle two cases:
//
// 1. TEXT replacements (broken links, linker): "original" and "fixed" are
//    markdown snippets like "[[BadLink]]" → "GoodName". We walk all text
//    nodes and replace occurrences.
//
// 2. IMAGE replacements (compression): "original" is "![[image.png]]" and
//    "fixed" is "![[image.webp]]". In the rendered DOM, these appear as
//    <img alt="image.png" src="/vault/.../image.png">. We extract the
//    filenames and patch the alt + src attributes in-place so the image
//    swaps without a full re-render (no scroll jump).
// Returns TRUE if at least one replacement was applied, FALSE if nothing
// matched (e.g. a NEW image that was never rendered — caller should fall
// back to a full re-render).
function applyReplacementsToDOM(replacements) {
  const contentDiv = document.getElementById("content");
  if (!contentDiv) return false;

  let appliedAny = false;

  // Separate text replacements from image replacements
  const textReplacements = [];
  const imageReplacements = [];
  for (const r of replacements) {
    const imgMatchOrig = /^\!\[\[(.+)\]\]$/.exec(r.original);
    const imgMatchFixed = /^\!\[\[(.+)\]\]$/.exec(r.fixed);
    if (imgMatchOrig && imgMatchFixed) {
      imageReplacements.push({
        oldName: imgMatchOrig[1],
        newName: imgMatchFixed[1],
      });
    } else {
      textReplacements.push(r);
    }
  }

  // ---- 1. Patch text nodes ----
  if (textReplacements.length > 0) {
    const walker = document.createTreeWalker(
      contentDiv,
      NodeFilter.SHOW_TEXT,
      null,
      false,
    );
    const textNodes = [];
    let node;
    while ((node = walker.nextNode())) {
      textNodes.push(node);
    }
    for (const textNode of textNodes) {
      let text = textNode.textContent;
      let changed = false;
      for (const { original, fixed } of textReplacements) {
        if (text.includes(original)) {
          text = text.split(original).join(fixed);
          changed = true;
          appliedAny = true;
        }
      }
      if (changed) {
        textNode.textContent = text;
      }
    }
  }

  // ---- 2. Patch <img> src + alt in-place (image compression) ----
  if (imageReplacements.length > 0) {
    const imgs = contentDiv.querySelectorAll("img");
    for (const img of imgs) {
      const alt = img.getAttribute("alt") || "";
      const src = img.getAttribute("src") || "";
      for (const { oldName, newName } of imageReplacements) {
        const oldLower = oldName.toLowerCase();
        const altLower = alt.toLowerCase();
        const srcBasename = src.split("/").pop() || "";
        const srcDecoded = (() => {
          try {
            return decodeURIComponent(srcBasename);
          } catch {
            return srcBasename;
          }
        })();
        if (
          altLower === oldLower ||
          altLower.endsWith("/" + oldLower) ||
          srcDecoded.toLowerCase() === oldLower ||
          srcDecoded.toLowerCase().endsWith("/" + oldLower)
        ) {
          const currentNotePath = norm(getCurrentNotePath());
          const noteDir = currentNotePath.includes("/")
            ? currentNotePath.slice(0, currentNotePath.lastIndexOf("/"))
            : "";
          const newRelPath = noteDir
            ? noteDir + "/assets/" + newName
            : "assets/" + newName;
          const newSrc =
            "/vault/" +
            newRelPath.split("/").map(encodeURIComponent).join("/");
          img.setAttribute("alt", newName);
          img.setAttribute("src", newSrc);
          img.removeAttribute("loading");
          appliedAny = true;
          break;
        }
      }
    }
    // If we had image replacements but NONE matched, the image is NEW
    // (never rendered). Return false so caller does a full re-render.
    if (!appliedAny && imageReplacements.length > 0) {
      return false;
    }
  }

  return appliedAny;
}

// ---- Full navigation with scroll memory ----
// saveScroll: if true, save the current note's scroll position before switching
// preserveScroll: explicit scroll value (used by edit mode exit)
//
// ASYNC: with lazy-loading (T3-1), noteMap[path] may be `null` (metadata only,
// content not yet fetched). In that case we fetch from /api/note before
// rendering. Callers that don't await still work — the DOM updates when the
// fetch resolves.
export async function loadNote(path, saveScroll = true, preserveScroll = null) {
  path = norm(path);
  const mainEl = document.getElementById("main");
  const currentPath = norm(getCurrentNotePath());

  // Save the current note's scroll position before switching
  if (saveScroll && currentPath && currentPath !== path && mainEl) {
    scrollMemory.set(currentPath, mainEl.scrollTop);
  }

  // Lazy-load: if the note's content hasn't been fetched yet (metadata-only
  // tree), fetch it on demand. null = not loaded, undefined = doesn't exist.
  if (noteMap[path] === null) {
    try {
      const res = await fetch("/api/note?path=" + encodeURIComponent(path));
      const data = await res.json();
      if (data.success) {
        noteMap[path] = data.content;
      } else {
        document.getElementById("content").innerHTML =
          '<p class="empty-state">Note not found.</p>';
        return;
      }
    } catch (e) {
      document.getElementById("content").innerHTML =
        '<p class="empty-state">Error loading note.</p>';
      return;
    }
  }

  // renderNoteContent handles scroll restoration internally:
  // - If preserveScroll is set, uses it (edit mode exit)
  // - If scrollMemory has this path, restores it (returning to a note)
  // - Otherwise uses current scrollTop (live preview) or 0
  renderNoteContent(path, preserveScroll);
  updateBackButton();
}

// ---- Navigation wrapper ----
export async function appNavigateTo(path, pushHistory = true) {
  path = norm(path);
  if (!path || noteMap[path] === undefined) return;

  // If we're in edit mode and switching to a DIFFERENT note, handle the
  // transition: if there are unsaved changes, show the save prompt. Then exit
  // edit mode, load the new note, and re-enter edit mode (so the user
  // stays in editing mode across note switches, as they requested).
  if (window._isEditing === true) {
    const current = norm(getCurrentNotePath());
    if (current !== path) {
      // Switching to a different note while editing
      if (window._exitEditMode) {
        // exitEditMode is async — it may show a save prompt.
        // We need to await it before proceeding with navigation.
        // If the user cancels, don't navigate.
        const exited = await window._exitEditMode(false);
        if (!exited) return; // user cancelled the save prompt
      }
      // Load the new note
      navigateTo(path, pushHistory, noteMap, loadNote);
      // Dispatch a "noteChanged" event (NOT "navigate" — that would re-trigger
      // appNavigateTo and cause an infinite loop). Modules like chat.js and
      // backlinks.js listen for "noteChanged" to know when the active note
      // switches.
      document.dispatchEvent(new CustomEvent("noteChanged", { detail: { path } }));
      // Re-enter edit mode for the new note (deferred so loadNote completes)
      setTimeout(() => {
        if (window._enterEditMode) window._enterEditMode(path);
      }, 50);
      return;
    }
  }

  navigateTo(path, pushHistory, noteMap, loadNote);
  // Dispatch "noteChanged" (NOT "navigate" — "navigate" is the event the
  // sidebar dispatches to TRIGGER navigation; dispatching it here would
  // re-trigger appNavigateTo and cause an infinite loop).
  document.dispatchEvent(new CustomEvent("noteChanged", { detail: { path } }));
}

// ---- Build note map ----
// Notes from /api/vault-tree may or may not include `content`. When the
// server returns a metadata-only tree (T3-1), `node.content` is undefined
// and we set `map[p] = null` to signal "not loaded yet". loadNote() will
// fetch the content on demand from /api/note. `undefined` is reserved for
// "this path doesn't exist" so other lookups can distinguish the two states.
export function buildNoteMapFromTree(tree) {
  const map = {};
  const nameMap = {};
  const ignoreNames = new Set([
    "readme",
    "contributing",
    "important",
    "importants",
    "main",
  ]);
  function recurse(node) {
    if (node.type === "note") {
      const p = norm(node.path);
      map[p] = node.content !== undefined ? node.content : null;
      const lowerName = node.name.toLowerCase();
      if (!ignoreNames.has(lowerName) && !lowerName.startsWith("untitled")) {
        if (!nameMap[lowerName]) {
          nameMap[lowerName] = p;
        }
      }
    } else if (node.children) {
      for (const child of node.children) recurse(child);
    }
  }
  for (const node of tree) recurse(node);
  return { map, nameMap };
}

// ---- Refresh data on file change (SSE) ----
//
// CRITICAL: while in edit mode, we must NEVER overwrite #content (that would
// destroy the #editableNote div and leave the user in a ghost editing state).
// So: if window._isEditing is true, we update noteMap / sidebar in memory but
// skip the renderNoteContent call. The note will re-render when the user
// exits edit mode.
export async function refreshVaultData(changedPath, content, replacements) {
  // Capture current scroll
  const mainEl = document.getElementById("main");
  const savedScroll = mainEl ? mainEl.scrollTop : 0;
  const editing = window._isEditing === true;

  // BLOCK all re-renders during the save sequence. The server broadcasts
  // fileChanged via SSE after saving — if we re-render during/after save,
  // it destroys the editor mid-operation (causing ghost editing state and
  // lost images). The saveNote function sets isSaving=true, exits edit
  // mode, then clears isSaving after 500ms.
  if (window._isSaving === true) {
    // Still update noteMap so the data is fresh, but don't touch the DOM
    if (content !== undefined && changedPath) {
      const normalizedPath = norm(changedPath);
      noteMap[normalizedPath] = content;
    }
    return;
  }

  // Update noteMap with the new content (always, so data stays fresh)
  if (content !== undefined && changedPath) {
    const normalizedPath = norm(changedPath);
    const current = norm(getCurrentNotePath());

    // Suppress the SSE echo from our OWN save. The editor stores the
    // last-saved path + content so we can recognize the echo by content
    // match (not just timing — the 2s isSaving window can expire before
    // the SSE arrives on slow connections).
    if (window._lastSavedPath && window._lastSavedContent) {
      const savedName = window._lastSavedPath.replace(/\\/g, '/').split('/').pop().toLowerCase();
      const changedName = normalizedPath.replace(/\\/g, '/').split('/').pop().toLowerCase();
      if (savedName === changedName && content === window._lastSavedContent) {
        // This is our own save echo — update noteMap but don't notify
        noteMap[normalizedPath] = content;
        return;
      }
    }

    // Don't overwrite noteMap for the note currently being edited — that
    // would destroy the user's in-progress changes. Instead, notify the
    // editor so it can show an "external change" banner and let the user
    // decide (reload vs keep their version). We skip this during save
    // (isSaving) because the save itself triggers a fileChanged event
    // that would otherwise look like an external edit.
    if (editing && current === normalizedPath && !window._isSaving) {
      if (window._notifyExternalChange) window._notifyExternalChange();
      return;
    }
    noteMap[normalizedPath] = content;
    const lowerName = normalizedPath.split("/").pop().toLowerCase();
    if (!nameToPath[lowerName]) {
      nameToPath[lowerName] = normalizedPath;
    }
  }

  // PRIORITY: if replacements are provided, try to patch the DOM IN-PLACE.
  // If the patch succeeds (existing elements found), we're done — no re-render,
  // no scroll jump. If it FAILS (new image not in DOM), fall back to a full
  // re-render so the new image appears. The image map is refreshed first so
  // new images resolve correctly.
  if (replacements && replacements.length > 0 && changedPath) {
    const normalizedPath = norm(changedPath);
    const current = norm(getCurrentNotePath());
    if (current === normalizedPath) {
      if (editing) {
        return;
      }
      // Refresh the image map FIRST so image src swaps resolve correctly.
      await refreshImageMap();
      const applied = applyReplacementsToDOM(replacements);
      if (applied) {
        // In-place patch succeeded — no re-render needed.
        if (window._refreshOutline) window._refreshOutline();
        return;
      }
      // Patch failed (new image not in DOM) — full re-render with the
      // refreshed image map so the new image resolves.
      renderNoteContent(normalizedPath, mainEl ? mainEl.scrollTop : 0, {
        skipSidebarUpdate: true,
      });
      if (window._refreshOutline) window._refreshOutline();
    }
    return;
  }

  // No replacements — fall back to full content re-render (live preview of
  // external edits, e.g. typing in Obsidian).
  if (content !== undefined && changedPath) {
    const normalizedPath = norm(changedPath);
    const current = norm(getCurrentNotePath());
    if (current === normalizedPath) {
      if (editing) {
        return;
      }
      // SKIP re-render if the content is identical to what we already have.
      // Obsidian frequently touches files (auto-save, metadata updates) which
      // triggers watcher events even when nothing changed. Re-rendering would
      // reset scroll to 0 (innerHTML replacement) and cause the "thrown to top"
      // issue. By skipping identical content, we eliminate spurious re-renders.
      if (noteMap[normalizedPath] === content) {
        return;
      }
      // Content actually changed — re-render with scroll preservation.
      renderNoteContent(normalizedPath, savedScroll, {
        skipSidebarUpdate: true,
      });
    }
    return;
  }

  // 3. Full refresh (new/deleted notes, tree changes, etc.)
  try {
    const [treeRes, imagesRes] = await Promise.all([
      fetch("/api/vault-tree"),
      fetch("/api/images"),
    ]);

    const treeData = await treeRes.json();
    const imagesData = await imagesRes.json();
    if (!treeData.success) throw new Error(treeData.error);
    if (!imagesData.success) throw new Error(imagesData.error);

    window.imageMap = imagesData.images || {};

    const { map, nameMap } = buildNoteMapFromTree(treeData.tree);
    noteMap = map;
    nameToPath = nameMap;
    // Update the globals for the graph view
    window._allNotes = noteMap;
    window._nameToPath = nameToPath;

    // Update sidebar (always safe — doesn't touch #content)
    const flat = flattenTree(treeData.tree);
    setFlatItems(flat);
    renderTree();

    // If editing, do NOT re-render the note content — that would destroy
    // the editor. The noteMap is already updated, so when the user exits
    // edit mode they'll see the latest content.
    if (editing) {
      return;
    }

    const current = norm(getCurrentNotePath());
    const normalizedChanged = norm(changedPath);
    if (current && noteMap[current] !== undefined) {
      // Use loadNote (async) so it can lazy-load content if noteMap[current]
      // is null (metadata-only tree). Pass saveScroll=false and the saved
      // scroll position so behavior matches the old renderNoteContent call.
      loadNote(current, false, savedScroll);
    } else if (normalizedChanged && noteMap[normalizedChanged] !== undefined) {
      appNavigateTo(normalizedChanged, false);
    } else {
      document.getElementById("content").innerHTML =
        '<p class="empty-state">The current note was removed.</p>';
      document
        .querySelectorAll("#tree-list .note.active")
        .forEach((el) => el.classList.remove("active"));
    }
  } catch (err) {
    console.error("Refresh failed:", err);
  }
}

/**
 * Refresh window.imageMap from the server. Returns a Promise so callers can
 * await it before re-rendering (so new images resolve correctly).
 */
function refreshImageMap() {
  return fetch("/api/images")
    .then((res) => res.json())
    .then((data) => {
      if (data.success) {
        window.imageMap = data.images || {};
      }
    })
    .catch(() => {});
}

// ---- SSE Connection ----
export function setupSSE() {
  const eventSource = new EventSource("/api/events");

  // Reset the reconnection backoff on a successful connection. This way,
  // after a long network outage we don't keep waiting 60s between attempts
  // once the connection is stable again.
  eventSource.onopen = () => {
    sseRetryDelay = 1000;
  };

  eventSource.addEventListener("fileChanged", function (e) {
    const data = JSON.parse(e.data);
    refreshVaultData(data.path, data.content, data.replacements);
  });

  // A note was deleted — remove it from noteMap and refresh the sidebar tree.
  eventSource.addEventListener("fileDeleted", function (e) {
    const data = JSON.parse(e.data);
    const normalizedPath = data.path.replace(/\\/g, "/");
    delete noteMap[normalizedPath];
    // Remove from nameToPath if present
    const lowerName = normalizedPath.split("/").pop().toLowerCase();
    if (nameToPath[lowerName] === normalizedPath) {
      delete nameToPath[lowerName];
    }
    const current = getCurrentNotePath();
    if (current === normalizedPath) {
      document.getElementById("content").innerHTML =
        '<p class="empty-state">This note was deleted.</p>';
      document
        .querySelectorAll("#tree-list .note.active")
        .forEach((el) => el.classList.remove("active"));
    }
    // Close any tab for the deleted note. tabs.js owns the open-tabs array
    // and will activate the next available tab (dispatching a navigate /
    // openImage event as appropriate).
    document.dispatchEvent(
      new CustomEvent("closeTabByPath", { detail: { path: normalizedPath } }),
    );
    // Full refresh to update the sidebar tree (preserves scroll).
    refreshVaultData(null, undefined, null);
  });

  // Folder added/removed → refresh the sidebar tree. Debounced because the
  // watcher can fire several treeChanged events in quick succession (bulk
  // operations, multi-file renames). 300ms is short enough to feel instant
  // but long enough to coalesce bursts.
  eventSource.addEventListener("treeChanged", function () {
    if (treeChangedDebounce) clearTimeout(treeChangedDebounce);
    treeChangedDebounce = setTimeout(() => {
      treeChangedDebounce = null;
      refreshVaultData(null, undefined, null);
    }, 300);
  });

  // Exponential backoff on connection loss. Starts at 1s, doubles each
  // failure (capped at 60s), resets to 1s on a successful reconnect.
  eventSource.onerror = function () {
    console.warn(
      "SSE connection lost, reconnecting in " +
        sseRetryDelay / 1000 +
        "s...",
    );
    eventSource.close();
    const delay = sseRetryDelay;
    sseRetryDelay = Math.min(sseRetryDelay * 2, 60000); // cap at 60s
    setTimeout(() => {
      setupSSE();
    }, delay);
  };
}

// ---- Load vault data (initial) ----
export async function loadVault() {
  const list = document.getElementById("tree-list");
  list.innerHTML = '<li class="no-results">Loading notes...</li>';
  try {
    const [treeRes, imagesRes] = await Promise.all([
      fetch("/api/vault-tree"),
      fetch("/api/images"),
    ]);

    const treeData = await treeRes.json();
    const imagesData = await imagesRes.json();

    if (!treeData.success) throw new Error(treeData.error);
    if (!imagesData.success) throw new Error(imagesData.error);

    window.imageMap = imagesData.images || {};

    const tree = treeData.tree;
    const flat = flattenTree(tree);
    setFlatItems(flat);
    renderTree();

    const { map, nameMap } = buildNoteMapFromTree(tree);
    noteMap = map;
    nameToPath = nameMap;
    // Update the globals for the graph view
    window._allNotes = noteMap;
    window._nameToPath = nameToPath;

    // Load tabs from storage
    loadTabsFromStorage(noteMap);
    renderTabs();

    const activeTab = norm(getActiveTabPath());
    const isImage = activeTab && /\.(png|jpg|jpeg|gif|webp|svg|bmp|tiff|ico|avif)$/i.test(activeTab);
    if (activeTab && (noteMap[activeTab] !== undefined || isImage)) {
      if (isImage) {
        // Restore image viewer for image tabs
        document.dispatchEvent(new CustomEvent("openImage", { detail: { path: activeTab, pushHistory: false } }));
      } else {
        appNavigateTo(activeTab, false);
      }
    } else {
      const lastPath = norm(localStorage.getItem("lastNote"));
      const lastIsImage = lastPath && /\.(png|jpg|jpeg|gif|webp|svg|bmp|tiff|ico|avif)$/i.test(lastPath);
      if (lastPath && (noteMap[lastPath] !== undefined || lastIsImage)) {
        if (lastIsImage) {
          setTimeout(() => document.dispatchEvent(new CustomEvent("openImage", { detail: { path: lastPath, pushHistory: false } })), 150);
        } else {
          setTimeout(() => appNavigateTo(lastPath, false), 150);
        }
      } else {
        document.getElementById("content").innerHTML =
          '<p class="empty-state">Select a note from the sidebar</p>';
      }
    }
  } catch (err) {
    list.innerHTML = `<li class="no-results">Error: ${err.message}</li>`;
    console.error(err);
  }
}

// ---- Event listeners for module communication ----
export function setupVaultEventListeners() {
  document.addEventListener("navigate", function (e) {
    const { path, pushHistory } = e.detail;
    appNavigateTo(path, pushHistory);
  });

  document.addEventListener("openTab", function (e) {
    const { path } = e.detail;
    openTab(path, noteMap);
  });

  document.addEventListener("closeTab", function (e) {
    const { path } = e.detail;
    closeTab(path, noteMap);
  });

  document.addEventListener("clearActive", function () {
    document
      .querySelectorAll("#tree-list .note.active")
      .forEach((el) => el.classList.remove("active"));
    setActivePath(null);
  });
}
