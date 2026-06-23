// ======================================================
//  BACKLINKS PANEL (js/backlinks.js)
// ======================================================
// Shows every note that links TO the currently-open note via [[wikilinks]].
//
// Setup adds a 🔗 button to the outline rail header (next to graph / mind-map).
// Clicking it opens a floating panel anchored to the right side of the main
// content area. Each backlink is clickable — clicking navigates to that note.
//
// AUTO-INITIALIZATION: This module wires itself up on DOMContentLoaded and
// polls briefly for the outline rail (which is built dynamically by
// outline.js after vault data loads). app.js does NOT need to import or
// call setupBacklinks().
//
// The panel rebuilds itself whenever the current note changes (listens for
// the "navigate" custom event that vault.js dispatches on every note open).

let backlinksPanel = null;
let backlinksBtn = null;

const SETUP_RETRY_LIMIT = 40; // 40 × 250ms = 10s max wait for outline rail
let setupRetries = 0;

export function setupBacklinks() {
  const rail = document.getElementById("outline-rail");
  if (!rail) {
    // Outline rail is built dynamically after vault data loads — retry.
    if (setupRetries++ < SETUP_RETRY_LIMIT) {
      setTimeout(setupBacklinks, 250);
    }
    return;
  }
  setupRetries = 0;

  const header = rail.querySelector(".outline-rail-header");
  if (!header) return;

  // Don't add the button twice.
  if (header.querySelector(".backlinks-toggle-btn")) return;

  backlinksBtn = document.createElement("button");
  backlinksBtn.className = "outline-icon-btn backlinks-toggle-btn";
  backlinksBtn.title = "Backlinks (links to this note)";
  backlinksBtn.setAttribute("aria-label", "Toggle backlinks panel");
  backlinksBtn.innerHTML = `<i class="fas fa-link"></i>`;
  backlinksBtn.addEventListener("click", toggleBacklinks);

  // Insert before the graph button (or any existing toggle button) so the
  // order roughly matches: gear, edit, backlinks, graph, mindmap, focus, …
  const graphBtn = header.querySelector(".graph-toggle-btn");
  const mindMapBtn = header.querySelector(".mindmap-toggle-btn");
  const focusBtn = header.querySelector(".focus-toggle-btn");
  const collapseBtn = header.querySelector("#outline-collapse-btn");
  const insertBefore = graphBtn || mindMapBtn || focusBtn || collapseBtn || null;
  if (insertBefore) {
    header.insertBefore(backlinksBtn, insertBefore);
  } else {
    header.appendChild(backlinksBtn);
  }
}

function toggleBacklinks() {
  if (backlinksPanel) {
    closeBacklinks();
  } else {
    openBacklinks();
  }
}

function openBacklinks() {
  const currentPath = window._getCurrentNotePath ? window._getCurrentNotePath() : null;
  if (!currentPath) {
    window.showModal("No Note Open", "Open a note first to see its backlinks.", { icon: "ℹ️" });
    return;
  }

  // Find every note that links to the current note.
  const noteName = currentPath.split("/").pop().toLowerCase();
  // Strip the .md extension for matching — [[Note]] links use the bare name.
  const noteBaseName = noteName.replace(/\.md$/i, "");
  const allNotes = window._allNotes || {};
  const backlinks = [];

  for (const path of Object.keys(allNotes)) {
    if (path === currentPath) continue;
    const content = allNotes[path] || "";
    if (!content || typeof content !== "string") continue;
    // Match [[NoteName]], [[NoteName|alias]], [[NoteName#heading]], or
    // [[NoteName#heading|alias]] — case-insensitive on the name part.
    const regex = new RegExp(
      "\\[\\[" + escapeRegex(noteBaseName) + "(\\|[^\\]]*)?(#[^\\]]*)?\\]\\]",
      "i"
    );
    if (regex.test(content)) {
      backlinks.push(path);
    }
  }

  backlinksPanel = document.createElement("div");
  backlinksPanel.className = "backlinks-panel";
  backlinksPanel.innerHTML = `
    <div class="backlinks-header">
      <span class="backlinks-title">🔗 Backlinks <span class="backlinks-count">(${backlinks.length})</span></span>
      <button class="backlinks-close-btn" id="backlinksCloseBtn" title="Close (Esc)" aria-label="Close backlinks panel">✕</button>
    </div>
    <div class="backlinks-list">
      ${backlinks.length === 0
        ? '<p class="backlinks-empty">No notes link to this note.</p>'
        : backlinks.map(path => {
            const name = path.split("/").pop();
            const folder = path.includes("/")
              ? path.split("/").slice(0, -1).join("/")
              : "";
            return `
              <div class="backlink-item" data-path="${escapeHtml(path)}" role="button" tabindex="0">
                <span class="backlink-icon">📄</span>
                <div class="backlink-text">
                  <span class="backlink-name">${escapeHtml(name)}</span>
                  ${folder ? `<span class="backlink-path">${escapeHtml(folder)}</span>` : ""}
                </div>
              </div>
            `;
          }).join("")
      }
    </div>
  `;

  // Anchor it to the right side of the main content area.
  const main = document.getElementById("main");
  if (main) main.appendChild(backlinksPanel);
  else document.body.appendChild(backlinksPanel);

  backlinksPanel.querySelector("#backlinksCloseBtn").addEventListener("click", closeBacklinks);

  backlinksPanel.querySelectorAll(".backlink-item").forEach(item => {
    const onClick = () => {
      const path = item.dataset.path;
      document.dispatchEvent(new CustomEvent("navigate", {
        detail: { path, pushHistory: true },
      }));
      // Keep the panel open so the user can hop between backlinks easily.
    };
    item.addEventListener("click", onClick);
    item.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        onClick();
      }
    });
  });

  // Auto-close on Escape.
  backlinksPanel.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      e.preventDefault();
      closeBacklinks();
    }
  });
}

function closeBacklinks() {
  if (backlinksPanel) {
    backlinksPanel.remove();
    backlinksPanel = null;
  }
}

// Listen for note navigation — if the panel is open, refresh it so it shows
// the new note's backlinks.
document.addEventListener("noteChanged", () => {
  if (backlinksPanel) {
    // Rebuild the panel for the new note.
    closeBacklinks();
    openBacklinks();
  }
});

// ---- Auto-init (so app.js does not need to wire this up) ----
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", setupBacklinks);
} else {
  setupBacklinks();
}

// ---- Helpers ----
function escapeRegex(str) {
  return String(str).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = String(str ?? "");
  return div.innerHTML;
}
