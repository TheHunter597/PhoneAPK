// ======================================================
//  COMMAND PALETTE (js/commandPalette.js)
// ======================================================
// Opens with Ctrl+P (or Cmd+P on macOS). Provides:
//   - Fuzzy search across every note in the vault (by name or path)
//   - Quick action commands (New Note, Toggle Edit, Open Graph, Take Quiz,
//     Toggle Focus Mode, Open Dashboard, Toggle AI Chat, ...)
//   - Keyboard navigation: ↑/↓ to move, Enter to run, Esc to close
//   - Click to run, mouse hover to highlight
//
// AUTO-INITIALIZATION: This module wires itself up on DOMContentLoaded so
// that app.js does NOT need to import or call setupCommandPalette(). The
// only contract is that `window._allNotes` (the noteMap snapshot maintained
// by vault.js) is up to date when the palette opens.

let paletteOverlay = null;

export function setupCommandPalette() {
  document.addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && (e.key === "p" || e.key === "P")) {
      e.preventDefault();
      // Don't open the palette while a modal overlay is already open — those
      // have their own keyboard handlers and the palette would be confusing.
      if (
        document.querySelector(".image-editor-overlay") ||
        document.querySelector(".quiz-overlay") ||
        document.querySelector(".dashboard-overlay") ||
        document.querySelector(".graph-overlay") ||
        document.querySelector(".mindmap-overlay") ||
        paletteOverlay
      ) {
        return;
      }
      openCommandPalette();
    }
  });
}

function openCommandPalette() {
  closeCommandPalette();
  const allNotes = window._allNotes || {};
  const notePaths = Object.keys(allNotes);

  paletteOverlay = document.createElement("div");
  paletteOverlay.className = "command-palette-overlay";
  paletteOverlay.innerHTML = `
    <div class="command-palette-modal" role="dialog" aria-label="Command palette">
      <input type="text" id="paletteInput" class="palette-input"
             placeholder="Type to search notes or commands..."
             autocomplete="off" spellcheck="false">
      <div class="palette-results" id="paletteResults" role="listbox"></div>
      <div class="palette-footer">
        <span><kbd>↑</kbd><kbd>↓</kbd> navigate</span>
        <span><kbd>Enter</kbd> select</span>
        <span><kbd>Esc</kbd> close</span>
      </div>
    </div>
  `;
  document.body.appendChild(paletteOverlay);

  const input = paletteOverlay.querySelector("#paletteInput");
  const results = paletteOverlay.querySelector("#paletteResults");

  // Quick action commands. Each action clicks an existing button or
  // dispatches a custom event that vault.js listens for.
  const commands = [
    {
      name: "New Note",
      icon: "📝",
      action: () => document.dispatchEvent(new CustomEvent("createNote")),
    },
    {
      name: "Toggle Edit Mode",
      icon: "✏️",
      action: () => document.querySelector("#outline-edit-btn")?.click(),
    },
    {
      name: "Open Graph View",
      icon: "🌐",
      action: () => document.querySelector(".graph-toggle-btn")?.click(),
    },
    {
      name: "Open Mind Map",
      icon: "🧠",
      action: () => document.querySelector(".mindmap-toggle-btn")?.click(),
    },
    {
      name: "Take Quiz",
      icon: "🧪",
      action: () => document.getElementById("quizHubBtn")?.click(),
    },
    {
      name: "Toggle Focus Mode",
      icon: "🔍",
      action: () => document.querySelector(".focus-toggle-btn")?.click(),
    },
    {
      name: "Open Dashboard",
      icon: "📊",
      action: () => document.querySelector(".dashboard-toggle-btn")?.click(),
    },
    {
      name: "Toggle AI Chat",
      icon: "🤖",
      action: () => document.querySelector(".chat-toggle-btn")?.click(),
    },
    {
      name: "Toggle Backlinks Panel",
      icon: "🔗",
      action: () => document.querySelector(".backlinks-toggle-btn")?.click(),
    },
  ];

  // Track the currently selected index across re-renders.
  let selectedIndex = 0;
  let currentItems = [];

  function renderResults(query) {
    const lower = (query || "").toLowerCase().trim();
    const items = [];

    // Commands first (always show all commands when query is empty)
    for (const cmd of commands) {
      if (!lower || cmd.name.toLowerCase().includes(lower)) {
        items.push({ type: "command", ...cmd });
      }
    }

    // Notes — match by basename or full path
    for (const path of notePaths) {
      const name = path.split("/").pop();
      const nameLower = name.toLowerCase();
      const pathLower = path.toLowerCase();
      if (!lower || nameLower.includes(lower) || pathLower.includes(lower)) {
        const suffix = path.includes("/") ? "  (" + path + ")" : "";
        items.push({
          type: "note",
          name: name + suffix,
          icon: "📄",
          path,
        });
      }
    }

    // Cap at a reasonable number so the list stays snappy on big vaults.
    currentItems = items.slice(0, 12);
    selectedIndex = 0;

    if (currentItems.length === 0) {
      results.innerHTML = `<div class="palette-empty">No matches found.</div>`;
      return;
    }

    results.innerHTML = currentItems.map((item, i) => `
      <div class="palette-item ${i === 0 ? "selected" : ""}" data-index="${i}" role="option">
        <span class="palette-icon">${item.icon}</span>
        <span class="palette-name">${escapeHtml(item.name)}</span>
        ${item.type === "command" ? '<span class="palette-tag">cmd</span>' : '<span class="palette-tag palette-tag-note">note</span>'}
      </div>
    `).join("");

    // Wire up clicks and hover.
    results.querySelectorAll(".palette-item").forEach((el, i) => {
      el.addEventListener("click", () => executeItem(currentItems[i]));
      el.addEventListener("mouseenter", () => {
        updateSelected(i);
      });
    });
  }

  function updateSelected(idx) {
    selectedIndex = idx;
    results.querySelectorAll(".palette-item").forEach((el, i) => {
      el.classList.toggle("selected", i === selectedIndex);
    });
    // Scroll the selected item into view if the list scrolls.
    const sel = results.querySelector(".palette-item.selected");
    if (sel) sel.scrollIntoView({ block: "nearest" });
  }

  function executeItem(item) {
    if (!item) return;
    if (item.type === "note") {
      document.dispatchEvent(new CustomEvent("navigate", {
        detail: { path: item.path, pushHistory: true },
      }));
    } else if (typeof item.action === "function") {
      item.action();
    }
    closeCommandPalette();
  }

  input.addEventListener("input", () => renderResults(input.value));

  input.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      if (currentItems.length === 0) return;
      updateSelected(Math.min(selectedIndex + 1, currentItems.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      if (currentItems.length === 0) return;
      updateSelected(Math.max(selectedIndex - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      executeItem(currentItems[selectedIndex]);
    } else if (e.key === "Escape") {
      e.preventDefault();
      closeCommandPalette();
    }
  });

  // Click outside the modal closes the palette.
  paletteOverlay.addEventListener("click", (e) => {
    if (e.target === paletteOverlay) closeCommandPalette();
  });

  renderResults("");
  // Focus on the next tick so the input is actually ready to receive keys.
  setTimeout(() => input.focus(), 0);
}

function closeCommandPalette() {
  if (paletteOverlay) {
    paletteOverlay.remove();
    paletteOverlay = null;
  }
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = String(str ?? "");
  return div.innerHTML;
}

// ---- Auto-init (so app.js does not need to wire this up) ----
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", setupCommandPalette);
} else {
  setupCommandPalette();
}
