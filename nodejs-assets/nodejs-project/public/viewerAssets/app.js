// ======================================================
//  APP.JS – Main entry
// ======================================================
import { setupSidebarResize, setupSearch, setupSidebarCollapse, setupContextMenu } from "./js/sidebar.js";
import {
  setupSettings,
  applyEmbedSettings,
  applyFontSettings,
} from "./js/settings.js";
import { setupLightbox } from "./js/lightbox.js";
import {
  loadShortcuts,
  parseKeyEvent,
  getActionFromKeyCombination,
} from "./js/shortcuts.js";
import { setupBackButton, getCurrentNotePath } from "./js/navigation.js";
import {
  loadVault,
  setupSSE,
  loadNote,
  setupVaultEventListeners,
  setupScrollMemory,
  noteMap,
  refreshVaultData,
} from "./js/vault.js";
import {
  toggleEditMode,
  exitEditMode,
  saveNote,
  updateEditToggleIcon,
  setEditorDependencies,
  getEditorState,
  enterEditMode,
  acceptRecommendation,
  revertRecommendation,
} from "./js/editor.js";
import { nextTab, prevTab, closeCurrentTab } from "./js/tabs.js";
import {
  setupOutline,
  setOutlineDeps,
  refreshOutline,
} from "./js/outline.js";
import { startAnimals, stopAnimals, isAnimalsRunning } from "./js/animals.js";
import { setupChat, toggleChat } from "./js/chat.js";
import { setupImageViewer } from "./js/imageEditor.js";
import { setupFocusMode, toggleFocusMode } from "./js/focusMode.js";
import { setupMindMap } from "./js/mindMap.js";
import { setupGraphView } from "./js/graphView.js";
import { setupQuizMode } from "./js/quizMode.js";
import { setupDashboard, trackRecentNote } from "./js/dashboard.js";

// ---- Expose editor functions to vault ----
window._isEditing = false;
window._isSaving = false;
window._currentEditPath = null;
window._exitEditMode = exitEditMode;
window._enterEditMode = (path) => {
  // Re-enter edit mode for a specific note (used when switching notes
  // while already in edit mode)
  const content = noteMap[path];
  if (content !== undefined && content !== null) {
    enterEditMode(path, content, noteMap);
  }
};
window._updateEditToggleIcon = updateEditToggleIcon;
window._updateNoteMap = function (path, content) {
  noteMap[path] = content;
};
// Expose refreshOutline so vault.js can rebuild the outline after every
// note render (initial load, navigation, and live-preview content updates).
window._refreshOutline = refreshOutline;
// Expose refreshVaultData so editor.js can trigger a sidebar refresh after
// save (the isSaving flag blocks SSE events, so we need a manual refresh).
window._refreshVault = () => refreshVaultData(null, undefined, null);
// Expose animal functions for settings toggle
window._startAnimals = startAnimals;
window._stopAnimals = stopAnimals;
window._isAnimalsRunning = isAnimalsRunning;
// Expose current note path + note content lookup for chat
window._getCurrentNotePath = getCurrentNotePath;
window._getNoteContent = (path) => noteMap[path];
// Expose full noteMap + nameToPath for graph view (read-only snapshot)
// Updated whenever the vault refreshes (see vault.js loadVault + refreshVaultData)
window._allNotes = noteMap;
window._nameToPath = {}; // populated by vault.js after buildNoteMapFromTree
// Expose trackRecentNote so vault.js can track note views for the dashboard
window._trackRecentNote = trackRecentNote;
// Expose the recommendation-acceptance function so the chat panel can call it
// when the user clicks "Accept & Insert" on a recommendation card.
window._acceptRecommendation = acceptRecommendation;
// Expose the revert function so the chat panel can undo an accepted rec.
window._revertRecommendation = revertRecommendation;
// Expose lazy-loaded editor hooks so vault.js can notify the editor of
// external changes (SSE) without a static import cycle, and trigger a
// reload-from-disk or save when needed. These dynamically import editor.js
// on demand.
window._notifyExternalChange = () => {
  import("./js/editor.js").then((m) => {
    if (m.notifyExternalChange) m.notifyExternalChange();
  });
};
window._reloadFromDisk = () => {
  import("./js/editor.js").then((m) => {
    if (m.reloadFromDisk) m.reloadFromDisk();
  });
};
window._saveNote = () => {
  import("./js/editor.js").then((m) => {
    if (m.saveNote) m.saveNote();
  });
};

// Sync the editor's isEditing/isSaving flags to window so vault.js can check
// them in refreshVaultData. We poll every 300ms — fast enough for the SSE
// race condition, but 3x less frequent than the original 100ms to reduce
// background CPU usage during typing.
setInterval(() => {
  const state = getEditorState();
  window._isEditing = state.isEditing;
  window._isSaving = state.isSaving;
  window._currentEditPath = state.currentEditPath;
}, 300);

// ---- Set editor dependencies ----
setEditorDependencies(getCurrentNotePath, loadNote, (path, content) => {
  noteMap[path] = content;
});

// ---- Initialise ----
function init() {
  loadShortcuts();

  setupSidebarResize();
  setupSidebarCollapse();
  setupSearch();
  setupContextMenu();
  setupSettings();
  setupLightbox();
  setupBackButton(loadNote);
  setupVaultEventListeners();
  setupScrollMemory();

  // ---- Outline rail (right side) ----
  // Contains the gear + pencil icons in the header (always visible even when
  // collapsed) and the note's heading outline below (visible on hover).
  setupOutline();
  setupChat();
  setupImageViewer();
  setupDashboard();
  setupFocusMode();
  setupMindMap();
  setupGraphView();
  setupQuizMode();
  setOutlineDeps(() => toggleEditMode(noteMap, getCurrentNotePath, loadNote));

  // ---- Keyboard shortcuts ----
  document.addEventListener("keydown", function (e) {
    // ---- Disable main app shortcuts when the image editor is open ----
    if (window._isImageEditorOpen) return;

    const tag = e.target.tagName;
    const isEditable = e.target.isContentEditable;

    // Ctrl+D / Cmd+D: open Daily Review Dashboard
    if ((e.ctrlKey || e.metaKey) && e.key === "d") {
      e.preventDefault();
      import("./js/dashboard.js").then(m => m.openDashboard());
      return;
    }

    // Block single-key shortcuts (Z/X/C) when typing in the contenteditable
    // editor — otherwise the user can't type those letters. Modifier-based
    // shortcuts (Ctrl+S, Ctrl+E, Ctrl+Shift+F) are always allowed.
    if (isEditable && !e.ctrlKey && !e.metaKey && !e.altKey) return;
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
    const combo = parseKeyEvent(e);
    if (!combo) return;
    const action = getActionFromKeyCombination(combo);
    if (!action) return;
    e.preventDefault();
    switch (action) {
      case "nextTab":
        nextTab();
        break;
      case "prevTab":
        prevTab();
        break;
      case "closeTab":
        closeCurrentTab();
        break;
      case "saveNote":
        if (getEditorState().isEditing) saveNote();
        break;
      case "toggleEditMode":
        toggleEditMode(noteMap, getCurrentNotePath, loadNote);
        break;
      case "focusMode":
        toggleFocusMode();
        break;
    }
  });

  // ---- beforeunload guard ----
  // Prevent tab/window close when the editor has unsaved changes.
  // Browsers ignore custom messages and only show a generic prompt, but
  // calling preventDefault() + setting returnValue is enough to trigger it.
  window.addEventListener("beforeunload", (e) => {
    if (window._isEditing && window._isEditing) {
      const state = getEditorState();
      if (state.dirty) {
        e.preventDefault();
        e.returnValue = "";
        return "";
      }
    }
  });

  // Load vault and start SSE
  loadVault();
  setupSSE();

  // Apply settings after load
  setTimeout(() => {
    applyEmbedSettings();
    applyFontSettings();
  }, 500);
}

// Start the app
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init);
} else {
  init();
}
