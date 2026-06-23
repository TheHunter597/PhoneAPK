// ======================================================
//  FOCUS MODE (js/focusMode.js)
// ======================================================
// Hides the sidebar, outline rail, chat panel, and tabs — leaving only the
// note content centered on screen. Also enters the browser's true fullscreen
// mode (hides tabs, address bar, taskbar) via the Fullscreen API.
// Toggle with a button in the outline rail or the F11 key.

let isFocusMode = false;
let focusToggleBtn = null;

export function setupFocusMode() {
  const rail = document.getElementById("outline-rail");
  if (!rail) return;
  const header = rail.querySelector(".outline-rail-header");
  if (!header) return;

  focusToggleBtn = document.createElement("button");
  focusToggleBtn.className = "outline-icon-btn focus-toggle-btn";
  focusToggleBtn.title = "Focus Mode (Ctrl+Shift+F)";
  focusToggleBtn.setAttribute("aria-label", "Toggle focus mode");
  focusToggleBtn.innerHTML = `<i class="fas fa-expand"></i>`;
  focusToggleBtn.addEventListener("click", toggleFocusMode);

  const collapseBtn = header.querySelector("#outline-collapse-btn");
  if (collapseBtn) {
    header.insertBefore(focusToggleBtn, collapseBtn);
  } else {
    header.appendChild(focusToggleBtn);
  }

  // Listen for browser fullscreen changes (e.g. user presses Esc to exit
  // browser fullscreen) — sync our state so the UI is consistent.
  document.addEventListener("fullscreenchange", () => {
    const inBrowserFullscreen = !!document.fullscreenElement;
    if (!inBrowserFullscreen && isFocusMode) {
      // User exited browser fullscreen (Esc) — exit focus mode too
      _exitFocusMode();
    }
  });
}

export function toggleFocusMode() {
  if (isFocusMode) {
    _exitFocusMode();
  } else {
    _enterFocusMode();
  }
}

function _enterFocusMode() {
  isFocusMode = true;
  document.body.classList.add("focus-mode");

  // Enter browser true fullscreen (hides tabs, address bar, taskbar)
  const el = document.documentElement;
  if (el.requestFullscreen) {
    el.requestFullscreen().catch(() => {
      // Fullscreen may be blocked by browser settings — non-fatal, the
      // CSS focus-mode class still hides the UI elements.
    });
  } else if (el.webkitRequestFullscreen) {
    el.webkitRequestFullscreen();
  } else if (el.msRequestFullscreen) {
    el.msRequestFullscreen();
  }

  if (focusToggleBtn) {
    focusToggleBtn.innerHTML = `<i class="fas fa-compress"></i>`;
    focusToggleBtn.title = "Exit Focus Mode (Ctrl+Shift+F)";
  }
}

function _exitFocusMode() {
  isFocusMode = false;
  document.body.classList.remove("focus-mode");

  // Exit browser fullscreen
  if (document.fullscreenElement) {
    if (document.exitFullscreen) {
      document.exitFullscreen().catch(() => {});
    } else if (document.webkitExitFullscreen) {
      document.webkitExitFullscreen();
    } else if (document.msExitFullscreen) {
      document.msExitFullscreen();
    }
  }

  if (focusToggleBtn) {
    focusToggleBtn.innerHTML = `<i class="fas fa-expand"></i>`;
    focusToggleBtn.title = "Focus Mode (F11)";
  }
}

export function isFocusModeActive() {
  return isFocusMode;
}
