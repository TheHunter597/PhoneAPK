// ======================================================
//  OUTLINE / TABLE OF CONTENTS (js/outline.js)
// ======================================================
//
// Right-side collapsible rail. Contains:
//   - settings (gear) button
//   - edit (pencil) button
//   - collapse (chevron) button — fully hides the rail
//   - separator
//   - list of headings (h1-h6) in the current note
//
// Behaviour:
//   - Collapsed by default (narrow 16px strip with tiny icons)
//   - Expands to full width on hover (CSS-driven, smooth transition)
//   - PINNED open when edit mode is active OR settings panel is visible
//     (so it doesn't collapse while you're editing or adjusting settings)
//   - Collapse button fully hides the rail; a restore tab appears on the
//     right edge to bring it back. State persists in localStorage.

let railEl = null;
let listEl = null;
let scrollSpyHandler = null;
let currentHeadings = []; // [{ id, text, level }]
let editToggleHandler = null; // set via setOutlineDeps
let pinnedCheckInterval = null;

const HIDDEN_KEY = "outlineRailHidden";

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = String(str);
  return div.innerHTML;
}

/**
 * Check whether the rail should be PINNED open (not collapse on mouseout).
 * Only pins when the settings panel is visible. Does NOT pin in edit mode
 * anymore — the user wants the rail to auto-collapse on mouseout regardless.
 */
function shouldBePinned() {
  const panel = document.getElementById("settings-panel");
  const settingsOpen = panel && !panel.classList.contains("hidden");
  return settingsOpen;
}

/**
 * Update the rail's pinned class. Called periodically (300ms interval) and
 * after every state change we can hook into. When pinned, the rail stays at
 * full width regardless of hover.
 */
export function updateRailPinnedState() {
  if (!railEl) return;
  // Don't pin if the rail is fully hidden — the user explicitly hid it.
  if (railEl.classList.contains("fully-hidden")) return;
  railEl.classList.toggle("pinned", shouldBePinned());
}

/**
 * Build the rail DOM once (called from setupOutline).
 */
export function setupOutline() {
  if (document.getElementById("outline-rail")) return; // already built

  railEl = document.createElement("nav");
  railEl.id = "outline-rail";
  railEl.setAttribute("aria-label", "Note outline and quick actions");

  railEl.innerHTML = `
    <div class="outline-rail-header">
      <button id="outline-gear-btn" class="outline-icon-btn" title="Settings" aria-label="Settings">
        <i class="fas fa-cog"></i>
      </button>
      <button id="outline-edit-btn" class="outline-icon-btn" title="Edit note" aria-label="Edit note">
        <i class="fas fa-pencil-alt"></i>
      </button>
      <span class="outline-rail-label">Outline</span>
      <button id="outline-collapse-btn" class="outline-icon-btn outline-collapse-btn" title="Hide outline" aria-label="Hide outline">
        <i class="fas fa-chevron-right"></i>
      </button>
    </div>
    <div class="outline-rail-divider"></div>
    <div class="outline-rail-body">
      <ul id="outline-list" class="outline-list"></ul>
    </div>
  `;
  document.body.appendChild(railEl);

  listEl = railEl.querySelector("#outline-list");

  // Restore fully-hidden state from localStorage.
  if (localStorage.getItem(HIDDEN_KEY) === "true") {
    railEl.classList.add("fully-hidden");
  }

  // ---- Gear → toggle settings panel ----
  railEl.querySelector("#outline-gear-btn").addEventListener("click", (e) => {
    e.stopPropagation();
    const panel = document.getElementById("settings-panel");
    if (panel) panel.classList.toggle("hidden");
    updateRailPinnedState();
  });

  // ---- Pencil → toggle edit mode ----
  railEl.querySelector("#outline-edit-btn").addEventListener("click", (e) => {
    e.stopPropagation();
    if (editToggleHandler) editToggleHandler();
    // updateRailPinnedState will be called by the editor's enter/exit, but
    // also schedule a deferred check in case the handler is async-ish.
    setTimeout(updateRailPinnedState, 50);
  });

  // ---- Collapse button → fully hide the rail ----
  railEl
    .querySelector("#outline-collapse-btn")
    .addEventListener("click", (e) => {
      e.stopPropagation();
      hideRail();
    });

  // ---- Restore tab (floating button on the right edge) ----
  const showBtn = document.createElement("button");
  showBtn.id = "outline-show-btn";
  showBtn.title = "Show outline";
  showBtn.setAttribute("aria-label", "Show outline");
  showBtn.innerHTML = `<i class="fas fa-chevron-left"></i>`;
  showBtn.addEventListener("click", showRail);
  document.body.appendChild(showBtn);

  // ---- Scroll-spy (throttled via requestAnimationFrame for performance) ----
  let scrollSpyPending = false;
  scrollSpyHandler = () => {
    if (scrollSpyPending) return;
    scrollSpyPending = true;
    requestAnimationFrame(() => {
      scrollSpyPending = false;
      updateActiveHeading();
    });
  };
  const mainEl = document.getElementById("main");
  if (mainEl) {
    mainEl.addEventListener("scroll", scrollSpyHandler, { passive: true });
  }
  window.addEventListener("resize", scrollSpyHandler, { passive: true });

  // ---- Pinned-state poll (catches edit-mode and settings-panel changes) ----
  // 500ms is responsive enough that the rail pins/unpins quickly, without
  // being a performance concern.
  if (pinnedCheckInterval) clearInterval(pinnedCheckInterval);
  pinnedCheckInterval = setInterval(updateRailPinnedState, 500);
}

function hideRail() {
  if (!railEl) return;
  railEl.classList.add("fully-hidden");
  railEl.classList.remove("pinned");
  localStorage.setItem(HIDDEN_KEY, "true");
}

function showRail() {
  if (!railEl) return;
  railEl.classList.remove("fully-hidden");
  localStorage.setItem(HIDDEN_KEY, "false");
  updateRailPinnedState();
}

/**
 * Inject the edit-mode toggle handler.
 */
export function setOutlineDeps(toggleEditModeFn) {
  editToggleHandler = toggleEditModeFn;
}

/**
 * Rebuild the outline from the current note's headings.
 */
export function refreshOutline() {
  if (!listEl) return;
  const contentDiv = document.getElementById("content");
  if (!contentDiv) {
    listEl.innerHTML = "";
    currentHeadings = [];
    return;
  }

  const heads = Array.from(
    contentDiv.querySelectorAll("h1, h2, h3, h4, h5, h6"),
  );

  // Skip the auto-inserted H1 (the note name) — first H1 at the very top.
  const realHeadings = heads.filter((h, idx) => {
    if (idx === 0 && h.tagName === "H1") return false;
    return true;
  });

  currentHeadings = realHeadings.map((h, i) => {
    if (!h.id) {
      h.id =
        "heading-" +
        i +
        "-" +
        String(h.textContent || "")
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, "-")
          .replace(/^-+|-+$/g, "");
    }
    return {
      id: h.id,
      text: h.textContent || "(untitled)",
      level: parseInt(h.tagName.charAt(1), 10),
    };
  });

  if (currentHeadings.length === 0) {
    listEl.innerHTML =
      '<li class="outline-empty">No headings in this note</li>';
    return;
  }

  const minLevel = Math.min(...currentHeadings.map((h) => h.level));

  let html = "";
  for (const h of currentHeadings) {
    const indent = h.level - minLevel;
    html += `<li class="outline-item outline-level-${h.level}" data-target="${escapeHtml(h.id)}" style="padding-left:${8 + indent * 14}px;">
      <span class="outline-marker outline-marker-${h.level}"></span>
      <span class="outline-text">${escapeHtml(h.text)}</span>
    </li>`;
  }
  listEl.innerHTML = html;

  listEl.querySelectorAll(".outline-item").forEach((li) => {
    li.addEventListener("click", () => {
      const target = document.getElementById(li.dataset.target);
      if (!target) return;
      const mainEl = document.getElementById("main");
      if (!mainEl) return;
      const mainRect = mainEl.getBoundingClientRect();
      const targetRect = target.getBoundingClientRect();
      const offset = targetRect.top - mainRect.top + mainEl.scrollTop - 16;
      mainEl.scrollTo({ top: offset, behavior: "smooth" });
    });
  });

  updateActiveHeading();
}

/**
 * Highlight the outline item for the heading currently nearest the top.
 */
function updateActiveHeading() {
  if (!listEl || currentHeadings.length === 0) return;
  const mainEl = document.getElementById("main");
  if (!mainEl) return;
  const scrollTop = mainEl.scrollTop;
  let activeId = null;
  for (const h of currentHeadings) {
    const el = document.getElementById(h.id);
    if (!el) continue;
    let absTop = 0;
    let node = el;
    while (node && node !== mainEl) {
      absTop += node.offsetTop;
      node = node.offsetParent;
    }
    if (absTop <= scrollTop + 80) {
      activeId = h.id;
    } else {
      break;
    }
  }
  if (!activeId && currentHeadings.length > 0) {
    activeId = currentHeadings[0].id;
  }
  listEl.querySelectorAll(".outline-item").forEach((li) => {
    li.classList.toggle("active", li.dataset.target === activeId);
  });
}
