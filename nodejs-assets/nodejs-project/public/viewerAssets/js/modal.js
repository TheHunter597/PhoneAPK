// ======================================================
//  MODAL UTILITY (js/modal.js)
// ======================================================
// Replaces browser alert() with a styled modal. Available globally as
// window.showModal(title, message, options).
//
// Usage:
//   window.showModal("Error", "Something went wrong.")
//   window.showModal("Insert Failed", "This recommendation was intended for a different note.", {
//     buttons: [
//       { text: "Go to note", action: () => navigateToNote(path), primary: true },
//       { text: "Close", action: () => {} }
//     ]
//   })
//
// Auto-initializes on DOMContentLoaded — no setup needed.

window.showModal = function(title, message, options) {
  options = options || {};
  const buttons = options.buttons || [{ text: "Close", action: () => {}, primary: true }];

  // Remove any existing modal
  const existing = document.getElementById("globalModalOverlay");
  if (existing) existing.remove();

  const overlay = document.createElement("div");
  overlay.id = "globalModalOverlay";
  overlay.className = "global-modal-overlay";
  overlay.innerHTML = `
    <div class="global-modal">
      <div class="global-modal-header">
        <span class="global-modal-icon">${options.icon || "ℹ️"}</span>
        <span class="global-modal-title">${escapeHtml(title)}</span>
      </div>
      <div class="global-modal-body">${options.rawHtml ? message : (typeof message === "string" ? escapeHtml(message) : message)}</div>
      <div class="global-modal-actions" id="globalModalActions"></div>
    </div>
  `;
  document.body.appendChild(overlay);

  const actionsEl = overlay.querySelector("#globalModalActions");
  for (const btn of buttons) {
    const btnEl = document.createElement("button");
    btnEl.className = "global-modal-btn" + (btn.primary ? " global-modal-btn-primary" : "");
    btnEl.textContent = btn.text;
    btnEl.addEventListener("click", () => {
      overlay.remove();
      if (btn.action) btn.action();
    });
    actionsEl.appendChild(btnEl);
  }

  // Close on overlay click
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) {
      overlay.remove();
    }
  });

  // Close on Escape
  const escHandler = (e) => {
    if (e.key === "Escape") {
      overlay.remove();
      document.removeEventListener("keydown", escHandler);
    }
  };
  document.addEventListener("keydown", escHandler);

  // Focus the first button for keyboard accessibility
  setTimeout(() => actionsEl.querySelector("button")?.focus(), 0);
};

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = String(str);
  return div.innerHTML;
}

// Also expose a convenience function for error modals
window.showErrorModal = function(title, message) {
  window.showModal(title, message, { icon: "❌" });
};

// Auto-init marker (the functions above are set immediately, no DOMContentLoaded needed)
