// ======================================================
//  SIDEBAR RESIZE & TREE (js/sidebar.js)
// ======================================================

/**
 * Escape a string so it can be used safely inside a CSS attribute selector
 * such as `[data-path="..."]`. Prevents selector injection / breakage when
 * note paths contain quotes or backslashes.
 */
function cssEscapeForAttr(str) {
  return String(str).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

/** Escape text for safe insertion into HTML (prevents XSS from note names). */
function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = String(str);
  return div.innerHTML;
}

export function setupSidebarResize() {
  const sidebar = document.getElementById("sidebar");
  const handle = document.getElementById("resize-handle");
  if (!sidebar || !handle) return;

  let isResizing = false;
  let startX, startWidth;

  const savedWidth = localStorage.getItem("sidebarWidth");
  if (savedWidth) {
    const w = parseInt(savedWidth, 10);
    if (w >= 180 && w <= 500) {
      sidebar.style.width = w + "px";
    }
  }

  handle.addEventListener("mousedown", function (e) {
    isResizing = true;
    startX = e.clientX;
    startWidth = sidebar.offsetWidth;
    document.body.style.userSelect = "none";
    document.body.style.cursor = "col-resize";
    handle.classList.add("active");
    document.addEventListener("mousemove", onMouseMove);
    document.addEventListener("mouseup", onMouseUp);
    e.preventDefault();
  });

  function onMouseMove(e) {
    if (!isResizing) return;
    const delta = e.clientX - startX;
    let newWidth = startWidth + delta;
    if (newWidth < 180) newWidth = 180;
    if (newWidth > 500) newWidth = 500;
    sidebar.style.width = newWidth + "px";
  }

  function onMouseUp() {
    isResizing = false;
    document.body.style.userSelect = "";
    document.body.style.cursor = "";
    handle.classList.remove("active");
    document.removeEventListener("mousemove", onMouseMove);
    document.removeEventListener("mouseup", onMouseUp);
    const w = sidebar.offsetWidth;
    localStorage.setItem("sidebarWidth", w);
  }
}

// ======================================================
//  SIDEBAR COLLAPSE (similar to the outline rail)
// ======================================================
const SIDEBAR_HIDDEN_KEY = "sidebarHidden";

/**
 * Add a collapse button to the sidebar header and a restore tab on the left
 * edge. Clicking collapse fully hides the sidebar (width 0) and the resize
 * handle; clicking the restore tab brings it back. State persists in
 * localStorage.
 */
export function setupSidebarCollapse() {
  const sidebar = document.getElementById("sidebar");
  const handle = document.getElementById("resize-handle");
  if (!sidebar) return;

  // ---- Collapse button (chevron-left) in the sidebar header ----
  const collapseBtn = document.createElement("button");
  collapseBtn.id = "sidebar-collapse-btn";
  collapseBtn.className = "sidebar-icon-btn";
  collapseBtn.title = "Hide explorer";
  collapseBtn.setAttribute("aria-label", "Hide explorer");
  collapseBtn.innerHTML = `<i class="fas fa-chevron-left"></i>`;
  collapseBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    hideSidebar();
  });
  // Insert at the END of the sidebar-header (after the badge + dashboard link)
  const header = sidebar.querySelector("#sidebar-header");
  if (header) header.appendChild(collapseBtn);

  // ---- Restore tab (floating button on the left edge) ----
  const showBtn = document.createElement("button");
  showBtn.id = "sidebar-show-btn";
  showBtn.title = "Show explorer";
  showBtn.setAttribute("aria-label", "Show explorer");
  showBtn.innerHTML = `<i class="fas fa-chevron-right"></i>`;
  showBtn.addEventListener("click", showSidebar);
  document.body.appendChild(showBtn);

  // ---- Restore from localStorage ----
  if (localStorage.getItem(SIDEBAR_HIDDEN_KEY) === "true") {
    sidebar.classList.add("fully-hidden");
    if (handle) handle.classList.add("fully-hidden");
  }

  function hideSidebar() {
    sidebar.classList.add("fully-hidden");
    if (handle) handle.classList.add("fully-hidden");
    localStorage.setItem(SIDEBAR_HIDDEN_KEY, "true");
  }

  function showSidebar() {
    sidebar.classList.remove("fully-hidden");
    if (handle) handle.classList.remove("fully-hidden");
    localStorage.setItem(SIDEBAR_HIDDEN_KEY, "false");
  }
}

// ======================================================
//  TREE STATE & RENDER
// ======================================================
export let flatItems = [];
export let collapsed = new Set();
export let searchQuery = "";
export let searchMode = "both";
export let activePath = null;

export function setActivePath(path) {
  activePath = path;
}

export function setFlatItems(items) {
  flatItems = items;
}

// Tracks folders we've seen on a previous flattenTree pass. We only auto-
// collapse folders the FIRST time we encounter them — subsequent refreshes
// (triggered by SSE treeChanged events) must preserve the user's manual
// expand/collapse state. Without this, every refresh would re-collapse every
// folder, destroying the user's navigation context.
const knownFolders = new Set();

export function flattenTree(tree, depth = 0, parentPath = "") {
  const result = [];
  for (const node of tree) {
    const item = {
      path: node.path,
      type: node.type,
      name: node.name,
      depth: depth,
      parentPath: parentPath,
    };
    if (node.type === "folder") {
      item.children = node.children || [];
      // Only collapse folders that are NEW (not seen on a previous pass).
      // Returning folders default to NOT collapsed — safer than always
      // re-collapsing, which destroyed the user's expand state on every
      // SSE-triggered refresh.
      if (!knownFolders.has(node.path)) {
        collapsed.add(node.path);
        knownFolders.add(node.path);
      }
      const childItems = flattenTree(node.children, depth + 1, node.path);
      result.push(item, ...childItems);
    } else {
      result.push(item);
    }
  }
  return result;
}

export function renderTree() {
  const list = document.getElementById("tree-list");
  if (!list) return;
  let filtered = flatItems;

  // Build a Map for O(1) parent lookups (was O(n) with .find() in a loop,
  // which was O(n²) overall for large vaults).
  const itemByPath = new Map();
  for (const item of flatItems) {
    itemByPath.set(item.path, item);
  }

  if (searchQuery.trim() !== "") {
    const lower = searchQuery.toLowerCase().trim();
    let matches = flatItems.filter(
      (item) =>
        item.name.toLowerCase().includes(lower) &&
        (searchMode === "both" ||
          (searchMode === "notes" && item.type === "note") ||
          (searchMode === "folders" && item.type === "folder")),
    );

    const pathsToShow = new Set();
    for (const item of matches) {
      pathsToShow.add(item.path);
      let parent = item.parentPath;
      while (parent) {
        pathsToShow.add(parent);
        collapsed.delete(parent);
        const parentItem = itemByPath.get(parent);
        if (parentItem) {
          parent = parentItem.parentPath;
        } else {
          break;
        }
      }
    }

    filtered = flatItems.filter((item) => pathsToShow.has(item.path));
  } else {
    if (searchMode === "notes") {
      filtered = flatItems.filter((item) => item.type === "note");
    } else if (searchMode === "folders") {
      filtered = flatItems.filter((item) => item.type === "folder");
    }
  }

  // Cache the total note count (avoids re-filtering on every render)
  const totalNotes = flatItems.filter((item) => item.type === "note").length;
  const noteCount = document.getElementById("noteCount");
  if (noteCount) noteCount.textContent = totalNotes;

  if (filtered.length === 0) {
    list.innerHTML = `<li class="no-results">${searchQuery.trim() ? "No results match your search" : "No items found"}</li>`;
    return;
  }

  let html = "";
  for (const item of filtered) {
    let hidden = false;
    if (item.parentPath) {
      let parent = item.parentPath;
      while (parent) {
        if (collapsed.has(parent)) {
          hidden = true;
          break;
        }
        const parentItem = itemByPath.get(parent);
        if (parentItem) {
          parent = parentItem.parentPath;
        } else {
          break;
        }
      }
    }

    const isHiddenClass = hidden ? "hidden" : "";
    const depthPadding = item.depth * 20;
    const isFolder = item.type === "folder";
    const isImage = item.type === "image";
    const isActive =
      (item.type === "note" || item.type === "image") && item.path === activePath ? "active" : "";

    let toggleHtml = "";
    if (isFolder) {
      const isCollapsed = collapsed.has(item.path);
      const arrow = isCollapsed ? "▸" : "▾";
      toggleHtml = `<span class="toggle" data-path="${escapeHtml(item.path)}">${arrow}</span>`;
    } else {
      toggleHtml = `<span class="toggle" style="visibility:hidden;">•</span>`;
    }

    const iconHtml = isFolder
      ? `<span class="icon"><i class="fas fa-folder"></i></span>`
      : isImage
      ? `<span class="icon"><i class="fas fa-image"></i></span>`
      : `<span class="icon"><i class="fas fa-file-alt"></i></span>`;

    const liClass = isFolder ? "folder" : isImage ? "image-item" : "note";
    html += `
      <li class="${liClass} ${isActive} ${isHiddenClass}"
          data-path="${escapeHtml(item.path)}"
          data-type="${item.type}"
          style="padding-left:${depthPadding + 8}px;">
          ${toggleHtml}
          ${iconHtml}
          <span class="label">${escapeHtml(item.name)}</span>
      </li>
    `;
  }

  list.innerHTML = html;

  // ---- Event delegation: one click handler on the <ul> instead of one per <li> ----
  // This is much faster for large vaults (no N event listeners to attach).
  list.onclick = function (e) {
    const toggle = e.target.closest(".toggle");
    if (toggle) {
      e.stopPropagation();
      const path = toggle.dataset.path;
      if (collapsed.has(path)) {
        collapsed.delete(path);
      } else {
        collapsed.add(path);
      }
      renderTree();
      return;
    }
    const li = e.target.closest("li");
    if (!li) return;
    const path = li.dataset.path;
    const type = li.dataset.type;
    if (type === "folder") {
      if (collapsed.has(path)) {
        collapsed.delete(path);
      } else {
        collapsed.add(path);
      }
      renderTree();
    } else if (type === "note") {
      const event = new CustomEvent("navigate", {
        detail: { path, pushHistory: true },
      });
      document.dispatchEvent(event);
    } else if (type === "image") {
      // Images get their own event — the image viewer handles rendering
      const event = new CustomEvent("openImage", {
        detail: { path, pushHistory: true },
      });
      document.dispatchEvent(event);
    }
  };

  if (activePath) {
    const activeLi = list.querySelector(".note.active, .image-item.active");
    if (activeLi) {
      // Don't use scrollIntoView — it scrolls ALL ancestors including #main.
      // Manually scroll only the tree-container.
      const treeContainer = document.getElementById("tree-container");
      if (treeContainer) {
        const containerRect = treeContainer.getBoundingClientRect();
        const liRect = activeLi.getBoundingClientRect();
        if (liRect.top < containerRect.top || liRect.bottom > containerRect.bottom) {
          const offset = liRect.top - containerRect.top;
          treeContainer.scrollTop += offset - treeContainer.clientHeight / 2 + liRect.height / 2;
        }
      }
    }
  }
}

// ======================================================
//  EXPAND PARENT FOLDERS AND HIGHLIGHT NOTE
// ======================================================
export function expandAndHighlightNote(path) {
  const noteItem = flatItems.find(
    (item) => item.path === path && item.type === "note",
  );
  if (!noteItem) return;

  let parent = noteItem.parentPath;
  while (parent) {
    collapsed.delete(parent);
    const parentItem = flatItems.find(
      (i) => i.path === parent && i.type === "folder",
    );
    if (parentItem) {
      parent = parentItem.parentPath;
    } else {
      break;
    }
  }

  renderTree();

  // Fixed: correct container id + escaped attribute value.
  const list = document.getElementById("tree-list");
  if (!list) return;
  const li = list.querySelector(
    `.note[data-path="${cssEscapeForAttr(path)}"]`,
  );
  if (li) {
    // DON'T use scrollIntoView — it scrolls ALL scrollable ancestors including
    // #main, which overrides our scroll memory restoration. Instead, manually
    // scroll only the sidebar's tree-container.
    const treeContainer = document.getElementById("tree-container");
    if (treeContainer) {
      const containerRect = treeContainer.getBoundingClientRect();
      const liRect = li.getBoundingClientRect();
      const offset = liRect.top - containerRect.top;
      const targetScroll = treeContainer.scrollTop + offset - treeContainer.clientHeight / 2 + liRect.height / 2;
      treeContainer.scrollTo({ top: Math.max(0, targetScroll), behavior: "smooth" });
    }
    li.classList.add("active");
  }
}

// ======================================================
//  SEARCH INPUT HANDLERS (debounced for performance)
// ======================================================
export function setupSearch() {
  const searchInput = document.getElementById("searchInput");
  if (!searchInput) return;
  // Debounce: wait 200ms after the user stops typing before re-rendering
  // the tree. This avoids rebuilding the entire sidebar tree on every
  // keystroke, which is expensive for large vaults.
  let searchTimer = null;
  searchInput.addEventListener("input", function () {
    searchQuery = this.value;
    if (searchTimer) clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      searchTimer = null;
      renderTree();
    }, 200);
  });

  const modeToggle = document.getElementById("searchModeToggle");
  if (modeToggle) {
    modeToggle.addEventListener("change", function () {
      searchMode = this.value;
      renderTree();
    });
  }
}

// ======================================================
//  CONTEXT MENU (right-click) — create/rename/delete
// ======================================================
let contextMenuEl = null;

function escapeHtmlSafe(str) {
  const div = document.createElement("div");
  div.textContent = String(str);
  return div.innerHTML;
}

/**
 * Show the context menu at (x, y) with the given items.
 * items: [{ label, icon, action, danger }]
 */
function showContextMenu(x, y, items) {
  hideContextMenu();
  contextMenuEl = document.createElement("div");
  contextMenuEl.id = "sidebar-context-menu";
  contextMenuEl.className = "sidebar-context-menu";
  let html = "";
  for (const item of items) {
    if (item.separator) {
      html += '<div class="ctx-separator"></div>';
    } else {
      html += `<div class="ctx-item${item.danger ? " ctx-danger" : ""}" data-label="${escapeHtmlSafe(item.label)}">
        <span class="ctx-icon">${item.icon || ""}</span>
        <span class="ctx-label">${escapeHtmlSafe(item.label)}</span>
      </div>`;
    }
  }
  contextMenuEl.innerHTML = html;
  document.body.appendChild(contextMenuEl);
  // Position — make sure it doesn't go off-screen
  const rect = contextMenuEl.getBoundingClientRect();
  let left = x, top = y;
  if (left + rect.width > window.innerWidth) left = window.innerWidth - rect.width - 4;
  if (top + rect.height > window.innerHeight) top = window.innerHeight - rect.height - 4;
  contextMenuEl.style.left = left + "px";
  contextMenuEl.style.top = top + "px";

  // Wire up clicks
  let idx = 0;
  contextMenuEl.querySelectorAll(".ctx-item").forEach((el) => {
    // Find the matching non-separator item
    while (items[idx] && items[idx].separator) idx++;
    const item = items[idx];
    idx++;
    if (item && item.action) {
      el.addEventListener("click", () => {
        hideContextMenu();
        item.action();
      });
    }
  });
}

function hideContextMenu() {
  if (contextMenuEl) {
    contextMenuEl.remove();
    contextMenuEl = null;
  }
}

// Hide on click anywhere / Escape / scroll
document.addEventListener("click", () => hideContextMenu());
document.addEventListener("keydown", (e) => { if (e.key === "Escape") hideContextMenu(); });

/**
 * Prompt for a name (inline, not browser prompt). Returns a Promise<string|null>.
 */
function promptName(title, defaultValue) {
  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.className = "sidebar-prompt-overlay";
    overlay.innerHTML = `
      <div class="sidebar-prompt">
        <div class="sidebar-prompt-title">${escapeHtmlSafe(title)}</div>
        <input type="text" class="sidebar-prompt-input" value="${escapeHtmlSafe(defaultValue || "")}" spellcheck="false">
        <div class="sidebar-prompt-buttons">
          <button class="sp-cancel">Cancel</button>
          <button class="sp-ok">OK</button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);
    const input = overlay.querySelector(".sidebar-prompt-input");
    input.focus();
    input.select();
    const ok = () => { const v = input.value.trim(); overlay.remove(); resolve(v || null); };
    const cancel = () => { overlay.remove(); resolve(null); };
    overlay.querySelector(".sp-ok").addEventListener("click", ok);
    overlay.querySelector(".sp-cancel").addEventListener("click", cancel);
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); ok(); }
      if (e.key === "Escape") { e.preventDefault(); cancel(); }
    });
  });
}

/**
 * Confirm dialog (inline). Returns a Promise<boolean>.
 */
function confirmDialog(message) {
  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.className = "sidebar-prompt-overlay";
    overlay.innerHTML = `
      <div class="sidebar-prompt">
        <div class="sidebar-prompt-title">${escapeHtmlSafe(message)}</div>
        <div class="sidebar-prompt-buttons">
          <button class="sp-cancel">Cancel</button>
          <button class="sp-ok">Delete</button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);
    const ok = () => { overlay.remove(); resolve(true); };
    const cancel = () => { overlay.remove(); resolve(false); };
    overlay.querySelector(".sp-ok").addEventListener("click", ok);
    overlay.querySelector(".sp-cancel").addEventListener("click", cancel);
    overlay.addEventListener("keydown", (e) => {
      if (e.key === "Escape") { e.preventDefault(); cancel(); }
    });
  });
}

/**
 * Set up the right-click context menu on the sidebar tree.
 */
export function setupContextMenu() {
  const list = document.getElementById("tree-list");
  const sidebar = document.getElementById("sidebar");
  if (!list) return;

  // Right-click on a tree item
  list.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    const li = e.target.closest("li");
    const path = li ? li.dataset.path : "";
    const type = li ? li.dataset.type : "";

    const items = [];

    if (type === "folder") {
      // Folder context menu
      items.push({ label: "New Note", icon: "📄", action: () => createItem(path, "note") });
      items.push({ label: "New Folder", icon: "📁", action: () => createItem(path, "folder") });
      items.push({ separator: true });
      items.push({ label: "Rename", icon: "✏️", action: () => renameItem(path, "folder") });
      items.push({ label: "Delete", icon: "🗑️", danger: true, action: () => deleteItem(path, "folder") });
    } else if (type === "note") {
      // Note context menu
      items.push({ label: "Rename", icon: "✏️", action: () => renameItem(path, "note") });
      items.push({ separator: true });
      items.push({ label: "Delete", icon: "🗑️", danger: true, action: () => deleteItem(path, "note") });
    } else {
      // Empty area — create at root
      items.push({ label: "New Note", icon: "📄", action: () => createItem("", "note") });
      items.push({ label: "New Folder", icon: "📁", action: () => createItem("", "folder") });
    }

    showContextMenu(e.clientX, e.clientY, items);
  });

  // Right-click on empty sidebar area
  if (sidebar) {
    sidebar.addEventListener("contextmenu", (e) => {
      if (e.target.closest("li")) return; // handled by list handler
      e.preventDefault();
      showContextMenu(e.clientX, e.clientY, [
        { label: "New Note", icon: "📄", action: () => createItem("", "note") },
        { label: "New Folder", icon: "📁", action: () => createItem("", "folder") },
      ]);
    });
  }
}

async function createItem(parentPath, kind) {
  const name = await promptName(kind === "note" ? "New note name" : "New folder name", "");
  if (!name) return;
  const fullPath = parentPath ? parentPath + "/" + name : name;
  try {
    const endpoint = kind === "note" ? "/api/create-note" : "/api/create-folder";
    const res = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: fullPath }),
    });
    const data = await res.json();
    if (!data.success) { window.showErrorModal("Create Failed", data.error || "Failed"); return; }
    // The treeChanged SSE event will refresh the sidebar
  } catch (err) {
    window.showErrorModal("Create Failed", "Error: " + err.message);
  }
}

async function renameItem(path, kind) {
  const oldName = path.split("/").pop();
  const newName = await promptName("Rename " + kind, oldName);
  if (!newName || newName === oldName) return;
  const slashIdx = path.lastIndexOf("/");
  const dir = slashIdx >= 0 ? path.slice(0, slashIdx) : "";
  const newPath = dir ? dir + "/" + newName : newName;
  try {
    const endpoint = kind === "note" ? "/api/rename-note" : "/api/rename-folder";
    const res = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ oldPath: path, newPath }),
    });
    const data = await res.json();
    if (!data.success) { window.showErrorModal("Rename Failed", data.error || "Failed"); return; }
  } catch (err) {
    window.showErrorModal("Rename Failed", "Error: " + err.message);
  }
}

async function deleteItem(path, kind) {
  const name = path.split("/").pop();
  const confirmed = await confirmDialog(`Delete ${kind} "${name}"?` + (kind === "folder" ? "\nAll contents will be deleted." : ""));
  if (!confirmed) return;
  try {
    const endpoint = kind === "note" ? "/api/delete-note" : "/api/delete-folder";
    const res = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path }),
    });
    const data = await res.json();
    if (!data.success) { window.showErrorModal("Delete Failed", data.error || "Failed"); return; }
  } catch (err) {
    window.showErrorModal("Delete Failed", "Error: " + err.message);
  }
}
