// ======================================================
//  TABS STATE & FUNCTIONS (js/tabs.js)
// ======================================================
import { getHistoryLength, goBack } from "./navigation.js";

let openTabs = [];
let activeTabPath = null;
const TABS_STORAGE_KEY = "openTabs";
const ACTIVE_TAB_KEY = "activeTabPath";

// Escape text for safe insertion into HTML (prevents XSS from note names/paths).
function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = String(str);
  return div.innerHTML;
}

// Normalize to forward slashes (old localStorage data may have backslashes).
function norm(p) {
  return p ? String(p).replace(/\\/g, "/") : p;
}

export function getActiveTabPath() {
  return activeTabPath;
}

export function setActiveTabPath(path) {
  activeTabPath = norm(path);
}

export function getOpenTabs() {
  return openTabs;
}

export function loadTabsFromStorage(noteMap) {
  try {
    const stored = localStorage.getItem(TABS_STORAGE_KEY);
    if (stored) {
      const parsed = JSON.parse(stored);
      // Normalize stored paths so they match noteMap keys (forward slashes).
      // Keep tabs that are either notes (in noteMap) or images (by extension).
      openTabs = parsed
        .map((tab) => ({ ...tab, path: norm(tab.path) }))
        .filter((tab) => noteMap[tab.path] !== undefined || isImagePath(tab.path));
    } else {
      openTabs = [];
    }
    const active = norm(localStorage.getItem(ACTIVE_TAB_KEY));
    if (active && (noteMap[active] !== undefined || isImagePath(active))) {
      activeTabPath = active;
    } else {
      activeTabPath = openTabs.length > 0 ? openTabs[0].path : null;
    }
  } catch (e) {
    openTabs = [];
    activeTabPath = null;
  }
}

export function saveTabs() {
  localStorage.setItem(TABS_STORAGE_KEY, JSON.stringify(openTabs));
  localStorage.setItem(ACTIVE_TAB_KEY, activeTabPath || "");
}

export function renderTabs() {
  const container = document.getElementById("tabs-container");
  if (!container) return;
  let html = "";
  // Back button if history exists
  if (getHistoryLength() > 0) {
    html += `<button id="tabBackButton" class="tab-back-btn" title="Go Back">←</button>`;
  }
  if (openTabs.length === 0) {
    html += `<span class="empty-tabs">No notes open</span>`;
  } else {
    for (const tab of openTabs) {
      const isActive = tab.path === activeTabPath;
      const activeClass = isActive ? "active" : "";
      html += `
        <div class="tab-item ${activeClass}" data-path="${escapeHtml(tab.path)}">
          <span class="tab-name">${escapeHtml(tab.name)}</span>
          <button class="tab-close" data-path="${escapeHtml(tab.path)}" title="Close">×</button>
        </div>
      `;
    }
  }
  container.innerHTML = html;

  // Attach back button click
  const backBtn = container.querySelector("#tabBackButton");
  if (backBtn) {
    backBtn.addEventListener("click", function (e) {
      e.stopPropagation();
      goBack();
    });
  }

  // Tab click events
  container.querySelectorAll(".tab-item").forEach((el) => {
    el.addEventListener("click", function (e) {
      if (e.target.classList.contains("tab-close")) return;
      const path = this.dataset.path;
      if (path) {
        // Dispatch "openImage" for images, "navigate" for notes
        const eventName = isImagePath(path) ? "openImage" : "navigate";
        const event = new CustomEvent(eventName, {
          detail: { path, pushHistory: true },
        });
        document.dispatchEvent(event);
      }
    });
  });

  container.querySelectorAll(".tab-close").forEach((btn) => {
    btn.addEventListener("click", function (e) {
      e.stopPropagation();
      const path = this.dataset.path;
      const closeEvent = new CustomEvent("closeTab", { detail: { path } });
      document.dispatchEvent(closeEvent);
    });
  });
}

// Check if a path is an image file (by extension)
function isImagePath(p) {
  return /\.(png|jpg|jpeg|gif|webp|svg|bmp|tiff|ico|avif)$/i.test(p);
}

export function openTab(path, noteMap) {
  path = norm(path);
  // Allow opening tabs for both notes (in noteMap) and images
  const isImage = isImagePath(path);
  if (!isImage && noteMap[path] === undefined) return;
  const existing = openTabs.find((t) => t.path === path);
  if (existing) {
    activeTabPath = path;
  } else {
    const name = path.split(/[\\/]/).pop();
    openTabs.push({ path, name, isImage });
    activeTabPath = path;
  }
  saveTabs();
  renderTabs();
}

export function closeTab(path, noteMap) {
  path = norm(path);
  const index = openTabs.findIndex((t) => t.path === path);
  if (index === -1) return;
  openTabs.splice(index, 1);
  if (activeTabPath === path) {
    activeTabPath =
      openTabs.length > 0 ? openTabs[openTabs.length - 1].path : null;
  }
  saveTabs();
  renderTabs();
  if (activeTabPath) {
    // Image tabs need their own navigation event so the image viewer
    // handles rendering instead of the markdown note renderer.
    const eventName = isImagePath(activeTabPath) ? "openImage" : "navigate";
    const event = new CustomEvent(eventName, {
      detail: { path: activeTabPath, pushHistory: false },
    });
    document.dispatchEvent(event);
  } else {
    const clearEvent = new CustomEvent("clearActive");
    document.dispatchEvent(clearEvent);
  }
}

// ===== Navigation shortcuts =====
export function nextTab() {
  if (openTabs.length === 0) return;
  const currentIndex = openTabs.findIndex((t) => t.path === activeTabPath);
  let nextIndex;
  if (currentIndex === -1) {
    nextIndex = 0;
  } else {
    nextIndex = (currentIndex + 1) % openTabs.length;
  }
  activeTabPath = openTabs[nextIndex].path;
  saveTabs();
  renderTabs();
  // Use the right event for image vs note tabs.
  const eventName = isImagePath(activeTabPath) ? "openImage" : "navigate";
  const event = new CustomEvent(eventName, {
    detail: { path: activeTabPath, pushHistory: false },
  });
  document.dispatchEvent(event);
}

export function prevTab() {
  if (openTabs.length === 0) return;
  const currentIndex = openTabs.findIndex((t) => t.path === activeTabPath);
  let prevIndex;
  if (currentIndex === -1) {
    prevIndex = 0;
  } else {
    prevIndex = (currentIndex - 1 + openTabs.length) % openTabs.length;
  }
  activeTabPath = openTabs[prevIndex].path;
  saveTabs();
  renderTabs();
  // Use the right event for image vs note tabs.
  const eventName = isImagePath(activeTabPath) ? "openImage" : "navigate";
  const event = new CustomEvent(eventName, {
    detail: { path: activeTabPath, pushHistory: false },
  });
  document.dispatchEvent(event);
}

export function closeCurrentTab() {
  if (!activeTabPath) return;
  // Dispatch an event so the vault module (which owns noteMap) can call
  // closeTab(activeTabPath, noteMap).
  const closeEvent = new CustomEvent("closeTab", {
    detail: { path: activeTabPath },
  });
  document.dispatchEvent(closeEvent);
}

// Listen for history changes to re-render tabs (back button visibility)
document.addEventListener("historyChange", renderTabs);

// ---- closeTabByPath ----
// Fired by vault.js when a note is deleted (SSE fileDeleted event) so the
// corresponding tab — if any — is closed and the next tab activated. We do
// NOT dispatch the regular "closeTab" event here because that is handled by
// vault.js itself (which owns noteMap); to avoid a round-trip we update the
// tabs array directly and dispatch the navigation event ourselves.
document.addEventListener("closeTabByPath", (e) => {
  const { path } = e.detail;
  const normalized = norm(path);
  const index = openTabs.findIndex((t) => t.path === normalized);
  if (index === -1) return;
  openTabs.splice(index, 1);
  if (activeTabPath === normalized) {
    activeTabPath =
      openTabs.length > 0 ? openTabs[openTabs.length - 1].path : null;
    if (activeTabPath) {
      // Navigate to the new active tab (image vs note aware).
      const eventName = isImagePath(activeTabPath) ? "openImage" : "navigate";
      document.dispatchEvent(
        new CustomEvent(eventName, {
          detail: { path: activeTabPath, pushHistory: false },
        }),
      );
    }
  }
  saveTabs();
  renderTabs();
});
