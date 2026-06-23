// ======================================================
//  VERSION HISTORY (js/versionHistory.js)
// ======================================================
// Shows a timeline of note versions (like VS Code's timeline).
// Each save creates a snapshot. The user can browse versions, view diffs,
// and restore previous versions.
//
// A 🕐 button is added to the outline rail header.

let versionOverlay = null;

export function setupVersionHistory() {
  const rail = document.getElementById("outline-rail");
  if (!rail) return;
  const header = rail.querySelector(".outline-rail-header");
  if (!header) return;

  const btn = document.createElement("button");
  btn.className = "outline-icon-btn version-history-btn";
  btn.title = "Version History";
  btn.setAttribute("aria-label", "Version history");
  btn.innerHTML = `<i class="fas fa-history"></i>`;
  btn.addEventListener("click", openVersionHistory);

  // Insert before the backlinks button
  const backlinksBtn = header.querySelector(".backlinks-toggle-btn");
  if (backlinksBtn) {
    header.insertBefore(btn, backlinksBtn);
  } else {
    const graphBtn = header.querySelector(".graph-toggle-btn");
    if (graphBtn) header.insertBefore(btn, graphBtn);
    else header.appendChild(btn);
  }
}

function openVersionHistory() {
  const notePath = window._getCurrentNotePath ? window._getCurrentNotePath() : null;
  if (!notePath) {
    window.showErrorModal("No Note Open", "Open a note first to view its version history.");
    return;
  }

  closeVersionHistory();

  versionOverlay = document.createElement("div");
  versionOverlay.className = "version-history-overlay";
  versionOverlay.innerHTML = `
    <div class="version-history-modal">
      <div class="version-history-header">
        <span class="version-history-title">🕐 Version History — ${escapeHtml(notePath.split("/").pop())}</span>
        <button class="version-history-close" id="versionCloseBtn" title="Close (Esc)">✕</button>
      </div>
      <div class="version-history-body">
        <div class="version-timeline" id="versionTimeline">
          <p class="version-loading">Loading versions…</p>
        </div>
        <div class="version-diff-area" id="versionDiffArea">
          <p class="version-diff-placeholder">Select a version to view the diff</p>
        </div>
      </div>
    </div>
  `;
  document.body.appendChild(versionOverlay);

  versionOverlay.querySelector("#versionCloseBtn").addEventListener("click", closeVersionHistory);
  versionOverlay.addEventListener("click", (e) => {
    if (e.target === versionOverlay) closeVersionHistory();
  });

  loadVersions(notePath);
}

async function loadVersions(notePath) {
  const timeline = versionOverlay.querySelector("#versionTimeline");
  try {
    const res = await fetch(`/api/versions?path=${encodeURIComponent(notePath)}`);
    const data = await res.json();
    if (!data.success) {
      timeline.innerHTML = `<p class="version-error">❌ ${escapeHtml(data.error)}</p>`;
      return;
    }

    if (data.versions.length === 0) {
      timeline.innerHTML = `<p class="version-empty">No saved versions yet. Versions are created automatically each time you save.</p>`;
      return;
    }

    // Get current content for diff comparison
    const currentContent = window._getNoteContent ? window._getNoteContent(notePath) : "";

    let html = `<div class="version-item version-current" data-timestamp="current">
      <span class="version-time">Now</span>
      <span class="version-label">Current</span>
      <span class="version-size">${currentContent ? currentContent.length + ' chars' : ''}</span>
    </div>`;

    for (const v of data.versions) {
      const date = new Date(v.timestamp);
      const timeStr = date.toLocaleString(undefined, {
        month: 'short', day: 'numeric',
        hour: '2-digit', minute: '2-digit'
      });
      const preview = v.preview ? v.preview.substring(0, 60).replace(/\n/g, ' ') + '…' : '';
      html += `
        <div class="version-item" data-timestamp="${v.timestamp}">
          <span class="version-time">${timeStr}</span>
          <span class="version-preview">${escapeHtml(preview)}</span>
          <span class="version-size">${v.size} chars</span>
        </div>
      `;
    }

    timeline.innerHTML = html;

    // Wire up version clicks
    timeline.querySelectorAll(".version-item").forEach(item => {
      item.addEventListener("click", () => {
        timeline.querySelectorAll(".version-item").forEach(i => i.classList.remove("selected"));
        item.classList.add("selected");
        const ts = item.dataset.timestamp;
        if (ts === "current") {
          showDiff(currentContent, currentContent, "Current version");
        } else {
          loadVersionDiff(notePath, ts, currentContent);
        }
      });
    });

  } catch (err) {
    timeline.innerHTML = `<p class="version-error">❌ ${escapeHtml(err.message)}</p>`;
  }
}

async function loadVersionDiff(notePath, timestamp, currentContent) {
  const diffArea = versionOverlay.querySelector("#versionDiffArea");
  diffArea.innerHTML = '<p class="version-loading">Loading version…</p>';

  try {
    const res = await fetch(`/api/versions/${timestamp}?path=${encodeURIComponent(notePath)}`);
    const data = await res.json();
    if (!data.success) {
      diffArea.innerHTML = `<p class="version-error">❌ ${escapeHtml(data.error)}</p>`;
      return;
    }

    const date = new Date(parseInt(timestamp, 10));
    const timeStr = date.toLocaleString();
    showDiff(data.content, currentContent, `Version from ${timeStr}`, notePath, timestamp);

  } catch (err) {
    diffArea.innerHTML = `<p class="version-error">❌ ${escapeHtml(err.message)}</p>`;
  }
}

function showDiff(oldContent, newContent, label, notePath, timestamp) {
  const diffArea = versionOverlay.querySelector("#versionDiffArea");

  // Simple line-by-line diff
  const oldLines = oldContent.split("\n");
  const newLines = newContent.split("\n");
  const maxLen = Math.max(oldLines.length, newLines.length);

  let diffHtml = `<div class="diff-header">
    <span>${escapeHtml(label)}</span>`;
  if (notePath && timestamp) {
    diffHtml += `<button class="version-restore-btn" id="versionRestoreBtn">♻️ Restore this version</button>`;
  }
  diffHtml += `</div><div class="diff-content">`;

  for (let i = 0; i < maxLen; i++) {
    const oldLine = i < oldLines.length ? oldLines[i] : null;
    const newLine = i < newLines.length ? newLines[i] : null;

    if (oldLine === newLine) {
      diffHtml += `<div class="diff-line diff-same">${escapeHtml(oldLine || '')}</div>`;
    } else {
      if (oldLine !== null) {
        diffHtml += `<div class="diff-line diff-removed">- ${escapeHtml(oldLine)}</div>`;
      }
      if (newLine !== null) {
        diffHtml += `<div class="diff-line diff-added">+ ${escapeHtml(newLine)}</div>`;
      }
    }
  }
  diffHtml += '</div>';

  diffArea.innerHTML = diffHtml;

  // Wire up restore button
  if (notePath && timestamp) {
    const restoreBtn = diffArea.querySelector("#versionRestoreBtn");
    if (restoreBtn) {
      restoreBtn.addEventListener("click", async () => {
        window.showModal("Restore Version",
          "Are you sure you want to restore this version? The current content will be saved as a new version before restoring.",
          {
            icon: "♻️",
            buttons: [
              { text: "Restore", primary: true, action: async () => {
                try {
                  const res = await fetch(`/api/versions/${timestamp}/restore`, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ path: notePath }),
                  });
                  const data = await res.json();
                  if (data.success) {
                    closeVersionHistory();
                    // Reload the note
                    if (window._refreshVault) await window._refreshVault();
                  } else {
                    window.showErrorModal("Restore Failed", data.error || "Unknown error");
                  }
                } catch (err) {
                  window.showErrorModal("Restore Error", err.message);
                }
              }},
              { text: "Cancel" }
            ]
          }
        );
      });
    }
  }
}

function closeVersionHistory() {
  if (versionOverlay) {
    versionOverlay.remove();
    versionOverlay = null;
  }
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = String(str);
  return div.innerHTML;
}

// Auto-init
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", setupVersionHistory);
} else {
  setupVersionHistory();
}
