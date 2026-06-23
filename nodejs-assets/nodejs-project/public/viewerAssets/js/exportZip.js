// ======================================================
//  EXPORT ALL NOTES AS ZIP (js/exportZip.js)
// ======================================================
// Triggers a full vault backup via the server's /api/backup endpoint and
// then opens the backup manager page (backup.html) where the user can
// download the resulting ZIP file.
//
// Why not download the ZIP directly from JS? The server stores backups in
// `backupRoot` (outside the vault), which is NOT exposed via the /vault/
// static route. Adding a new download endpoint would require touching server
// files outside this task's ownership. Instead we trigger a fresh backup
// and direct the user to the existing backup.html manager, which knows how
// to surface the ZIP files.
//
// AUTO-INITIALIZATION: Listens for the "exportAllNotes" custom event
// (dispatched by dashboard.js when the user clicks "📦 Export All Notes").
// app.js does NOT need to import or call setupExportZip().

let exportInProgress = false;

export function setupExportZip() {
  document.addEventListener("exportAllNotes", exportAllNotes);
}

async function exportAllNotes() {
  if (exportInProgress) return;
  exportInProgress = true;

  // Show a transient status toast so the user knows something is happening.
  // The backup can take a while on big vaults.
  const toast = document.createElement("div");
  toast.className = "export-zip-toast";
  toast.innerHTML = `
    <div class="export-zip-spinner"></div>
    <div class="export-zip-text">
      <div class="export-zip-title">📦 Exporting vault…</div>
      <div class="export-zip-sub">Creating a fresh ZIP backup. This may take a few seconds.</div>
    </div>
  `;
  document.body.appendChild(toast);

  try {
    // Trigger a fresh "six_hour" backup (the smallest/fastest tier that
    // produces a ZIP). The server returns once the backup completes.
    const res = await fetch("/api/backup?type=six_hour", { method: "POST" });
    const data = await res.json();

    toast.querySelector(".export-zip-spinner").style.display = "none";

    if (data && (data.success || data.timestamp)) {
      toast.querySelector(".export-zip-title").textContent = "✅ Backup ready!";
      const fileCount = data.fileCount ? ` · ${data.fileCount} files` : "";
      const duration = data.durationMs ? ` · ${Math.round(data.durationMs / 1000)}s` : "";
      toast.querySelector(".export-zip-sub").innerHTML =
        `Your vault has been backed up${fileCount}${duration}. ` +
        `Opening the backup manager…`;

      // Give the user a moment to read the success message, then open the
      // backup manager in a new tab so they can download the ZIP.
      setTimeout(() => {
        window.open("backup.html", "_blank");
        toast.remove();
      }, 1200);
    } else {
      toast.querySelector(".export-zip-title").textContent = "⚠️ Export incomplete";
      toast.querySelector(".export-zip-sub").innerHTML =
        `The backup didn't complete cleanly: ${escapeHtml(data && data.error ? data.error : "unknown error")}. ` +
        `You can still try the backup manager.`;
      toast.querySelector(".export-zip-text").insertAdjacentHTML(
        "beforeend",
        `<button class="export-zip-action-btn" id="exportZipOpenBtn">Open Backup Manager</button>`
      );
      toast.querySelector("#exportZipOpenBtn").addEventListener("click", () => {
        window.open("backup.html", "_blank");
        toast.remove();
      });
    }
  } catch (err) {
    toast.querySelector(".export-zip-spinner").style.display = "none";
    toast.querySelector(".export-zip-title").textContent = "❌ Export failed";
    toast.querySelector(".export-zip-sub").textContent = "Error: " + err.message;
    toast.querySelector(".export-zip-text").insertAdjacentHTML(
      "beforeend",
      `<button class="export-zip-action-btn" id="exportZipOpenBtn">Open Backup Manager Anyway</button>`
    );
    toast.querySelector("#exportZipOpenBtn").addEventListener("click", () => {
      window.open("backup.html", "_blank");
      toast.remove();
    });
  } finally {
    exportInProgress = false;
  }
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = String(str ?? "");
  return div.innerHTML;
}

// ---- Auto-init (so app.js does not need to wire this up) ----
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", setupExportZip);
} else {
  setupExportZip();
}
