// ======================================================
//  NAVIGATION HISTORY (js/navigation.js)
// ======================================================

// Normalize to forward slashes so SSE changedPath comparisons work
// cross-platform (Windows server used to send backslash paths).
function norm(p) {
  return p ? String(p).replace(/\\/g, "/") : p;
}

let navHistory = [];
let currentNotePath = null;

export function getCurrentNotePath() {
  return currentNotePath;
}

export function setCurrentNotePath(path) {
  currentNotePath = norm(path);
}

export function getHistoryLength() {
  return navHistory.length;
}

export function dispatchHistoryChange() {
  document.dispatchEvent(new CustomEvent("historyChange"));
}

/**
 * Navigate to a note. Pushes the current note onto the history stack (unless
 * pushHistory is false), opens a tab for it, and loads the note content.
 */
export function navigateTo(path, pushHistory = true, noteMap, loadNoteFn) {
  path = norm(path);
  if (!path || noteMap[path] === undefined) return;
  if (pushHistory && currentNotePath && currentNotePath !== path) {
    navHistory.push(currentNotePath);
  }
  currentNotePath = path;
  // Open the note as a tab (tabs module listens for this event).
  const event = new CustomEvent("openTab", { detail: { path } });
  document.dispatchEvent(event);
  // Load the note content.
  if (loadNoteFn) loadNoteFn(path);
  updateBackButton();
  dispatchHistoryChange();
}

/**
 * Go back in history. Dispatches a "navigate" event (with pushHistory:false)
 * which is handled by the vault module's appNavigateTo, so no loadNoteFn
 * argument is needed here.
 */
export function goBack() {
  if (navHistory.length === 0) return;
  const prev = norm(navHistory.pop());
  currentNotePath = prev;
  const event = new CustomEvent("navigate", {
    detail: { path: prev, pushHistory: false },
  });
  document.dispatchEvent(event);
  updateBackButton();
  dispatchHistoryChange();
}

export function updateBackButton() {
  // The back button is rendered inside tabs, so we dispatch an event to
  // re-render tabs (which checks getHistoryLength()).
  dispatchHistoryChange();
}

/**
 * No-op kept for API compatibility. The back button now lives inside the tab
 * bar and its click handler is attached in tabs.js.
 */
export function setupBackButton() {
  // intentionally empty
}
