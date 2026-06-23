// ======================================================
//  SHORTCUTS MODULE (js/shortcuts.js)
// ======================================================
const DEFAULT_SHORTCUTS = {
  nextTab: "Z",
  prevTab: "X",
  closeTab: "C",
  saveNote: "Ctrl+S",
  toggleEditMode: "Ctrl+E",
  focusMode: "Ctrl+Shift+F",
};

let shortcuts = {};

export function loadShortcuts() {
  const stored = localStorage.getItem("shortcuts");
  if (stored) {
    try {
      shortcuts = JSON.parse(stored);
    } catch (e) {
      shortcuts = { ...DEFAULT_SHORTCUTS };
    }
  } else {
    shortcuts = { ...DEFAULT_SHORTCUTS };
  }
  for (const action of Object.keys(DEFAULT_SHORTCUTS)) {
    if (!shortcuts[action]) shortcuts[action] = DEFAULT_SHORTCUTS[action];
  }
  saveShortcuts();
}

export function saveShortcuts() {
  localStorage.setItem("shortcuts", JSON.stringify(shortcuts));
}

export function getShortcut(action) {
  return shortcuts[action] || null;
}

export function setShortcut(action, keyCombination) {
  if (
    keyCombination &&
    keyCombination.length === 1 &&
    keyCombination.match(/[a-zA-Z]/)
  ) {
    keyCombination = keyCombination.toUpperCase();
  }
  shortcuts[action] = keyCombination;
  saveShortcuts();
}

export function getActionFromKeyCombination(keyCombination) {
  if (
    keyCombination &&
    keyCombination.length === 1 &&
    keyCombination.match(/[a-zA-Z]/)
  ) {
    keyCombination = keyCombination.toUpperCase();
  }
  for (const [action, shortcut] of Object.entries(shortcuts)) {
    if (shortcut === keyCombination) return action;
  }
  return null;
}

export function parseKeyEvent(event) {
  const specialKeys = [
    "Escape",
    "Enter",
    "Tab",
    "Backspace",
    "Delete",
    "Space",
    "ArrowUp",
    "ArrowDown",
    "ArrowLeft",
    "ArrowRight",
    "Home",
    "End",
    "PageUp",
    "PageDown",
  ];
  const functionKeys = [
    "F1",
    "F2",
    "F3",
    "F4",
    "F5",
    "F6",
    "F7",
    "F8",
    "F9",
    "F10",
    "F11",
    "F12",
  ];
  const key = event.key;

  if (!event.ctrlKey && !event.shiftKey && !event.altKey && !event.metaKey) {
    if (key.length === 1) {
      if (key.match(/[a-zA-Z]/)) return key.toUpperCase();
      return key;
    }
    if (specialKeys.includes(key)) return key;
    if (functionKeys.includes(key)) return key;
    return null;
  }

  const parts = [];
  if (event.ctrlKey) parts.push("Ctrl");
  if (event.shiftKey) parts.push("Shift");
  if (event.altKey) parts.push("Alt");
  if (event.metaKey) parts.push("Meta");
  if (specialKeys.includes(key)) {
    parts.push(key);
  } else if (functionKeys.includes(key)) {
    parts.push(key);
  } else if (key.length === 1) {
    if (key.match(/[a-zA-Z]/)) parts.push(key.toUpperCase());
    else parts.push(key);
  } else {
    return null;
  }
  return parts.join("+");
}
