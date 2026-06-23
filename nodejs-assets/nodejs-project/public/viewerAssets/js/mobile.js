// ======================================================
//  MOBILE LAYOUT (js/mobile.js)
// ======================================================
//
// Converts the desktop 3-pane layout into overlay drawers on phones/tablets
// (≤768px). The mobile top bar (in viewer.html) has toggle buttons:
//   ☰  → sidebar (explorer) drawer
//   ✏️  → edit note (delegates to outline rail's edit button)
//   ⚙️  → settings (bottom sheet)
//   📑  → outline drawer
//
// A backdrop (#mobile-backdrop) appears behind any open drawer; tapping it
// closes all drawers. Selecting a note auto-closes the sidebar drawer so the
// content is immediately visible. The top-bar title mirrors the current note's
// first heading via a MutationObserver on #content.
//
// All of this is a no-op on desktop (the top bar + backdrop are display:none
// above 768px via mobile.css), so this module is safe to always load.

const MOBILE_MQ = window.matchMedia("(max-width: 768px)");

function isMobile() {
  return MOBILE_MQ.matches;
}

/** Open a drawer: add .mobile-open, show backdrop, lock scroll. */
function openDrawer(el) {
  if (!el) return;
  el.classList.add("mobile-open");
  document.body.classList.add("mobile-drawer-open");
}

/** Close a single drawer. */
function closeDrawer(el) {
  if (!el) return;
  el.classList.remove("mobile-open");
}

/** Close ALL drawers + hide backdrop. */
function closeAllDrawers() {
  closeDrawer(document.getElementById("sidebar"));
  closeDrawer(document.getElementById("outline-rail"));
  document.body.classList.remove("mobile-drawer-open");
  // Also close the settings panel if it's open on mobile
  const settings = document.getElementById("settings-panel");
  if (settings && !settings.classList.contains("hidden")) {
    settings.classList.add("hidden");
  }
}

function toggleSidebarDrawer() {
  const sb = document.getElementById("sidebar");
  if (!sb) return;
  const open = sb.classList.contains("mobile-open");
  closeAllDrawers();
  if (!open) openDrawer(sb);
}

function toggleOutlineDrawer() {
  const rail = document.getElementById("outline-rail");
  if (!rail) return;
  const open = rail.classList.contains("mobile-open");
  closeAllDrawers();
  if (!open) openDrawer(rail);
}

function toggleSettings() {
  // Delegate to the outline rail's gear button. This reuses the existing
  // toggle + pinned logic AND — crucially — makes settings.js's
  // "click-outside-to-close" handler recognise the trigger (it only excludes
  // #outline-gear-btn and #settings-toggle). Calling panel.classList.toggle
  // directly here would be immediately undone by that outside-click handler.
  const gearBtn = document.getElementById("outline-gear-btn");
  if (gearBtn) {
    gearBtn.click();
  } else {
    // Fallback: toggle directly (desktop gear not built yet)
    const panel = document.getElementById("settings-panel");
    if (panel) panel.classList.toggle("hidden");
  }
  // Close any open drawers so the bottom sheet isn't obscured
  closeDrawer(document.getElementById("sidebar"));
  closeDrawer(document.getElementById("outline-rail"));
  // Show the backdrop while the settings sheet is open so tapping outside
  // (the backdrop) closes it. We poll the panel state because the gear click
  // above toggles it synchronously.
  const panel = document.getElementById("settings-panel");
  const isOpen = panel && !panel.classList.contains("hidden");
  if (isOpen) {
    document.body.classList.add("mobile-drawer-open");
  } else {
    document.body.classList.remove("mobile-drawer-open");
  }
}

/** Trigger edit mode by delegating to the outline rail's edit button. */
function triggerEdit() {
  const editBtn = document.getElementById("outline-edit-btn");
  if (editBtn) {
    editBtn.click();
  } else {
    // Fallback: dispatch a keyboard shortcut the editor listens for
    document.dispatchEvent(
      new KeyboardEvent("keydown", { key: "e", ctrlKey: true, bubbles: true })
    );
  }
  closeAllDrawers();
}

/** Update the top-bar title from #content's first heading. */
function updateTitle() {
  const content = document.getElementById("content");
  const titleEl = document.getElementById("mobile-title");
  if (!content || !titleEl) return;
  const h1 = content.querySelector("h1");
  const h2 = content.querySelector("h2");
  const empty = content.querySelector(".empty-state");
  let title = "";
  if (h1) title = h1.textContent.trim();
  else if (h2) title = h2.textContent.trim();
  else if (empty) title = "Notes";
  else title = "Notes";
  titleEl.textContent = title;
  document.title = title + " — Note Viewer";
}

function init() {
  const sidebarBtn = document.getElementById("mobile-sidebar-btn");
  const outlineBtn = document.getElementById("mobile-outline-btn");
  const settingsBtn = document.getElementById("mobile-settings-btn");
  const editBtn = document.getElementById("mobile-edit-btn");
  const backdrop = document.getElementById("mobile-backdrop");

  if (sidebarBtn) sidebarBtn.addEventListener("click", toggleSidebarDrawer);
  if (outlineBtn) outlineBtn.addEventListener("click", toggleOutlineDrawer);
  if (settingsBtn) settingsBtn.addEventListener("click", toggleSettings);
  if (editBtn) editBtn.addEventListener("click", triggerEdit);
  if (backdrop) backdrop.addEventListener("click", closeAllDrawers);

  // Auto-close drawers when a note is selected (the tree dispatches a
  // "navigate" CustomEvent on note click — see sidebar.js).
  document.addEventListener("navigate", () => {
    if (!isMobile()) return;
    closeDrawer(document.getElementById("sidebar"));
    // If only the sidebar was open, hide the backdrop too
    if (
      !document.getElementById("outline-rail").classList.contains("mobile-open")
    ) {
      document.body.classList.remove("mobile-drawer-open");
    }
    // Title updates via the MutationObserver below, but also set it eagerly.
    setTimeout(updateTitle, 50);
  });

  // Also close on image open
  document.addEventListener("openImage", () => {
    if (!isMobile()) return;
    closeAllDrawers();
  });

  // Escape closes drawers
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && isMobile()) closeAllDrawers();
  });

  // Observe #content for changes → update the top-bar title
  const content = document.getElementById("content");
  if (content) {
    const observer = new MutationObserver(() => updateTitle());
    observer.observe(content, { childList: true, subtree: true, characterData: true });
    updateTitle();
  }

  // When crossing the desktop↔mobile boundary, clean up drawer state so a
  // leftover .mobile-open doesn't leave an element stranded off-screen on
  // desktop (where the drawer CSS no longer applies).
  MOBILE_MQ.addEventListener("change", (e) => {
    if (!e.matches) closeAllDrawers();
  });

  // Prevent iOS rubber-band scrolling from pulling the body under a drawer —
  // only the drawer's own list should scroll. Lightweight touch handler.
  let touchStartY = 0;
  document.addEventListener(
    "touchstart",
    (e) => {
      touchStartY = e.touches[0].clientY;
    },
    { passive: true }
  );
  // No-op scroll-jacking beyond title tracking — kept simple to avoid
  // interfering with the tree / outline internal scroll.
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init);
} else {
  init();
}
