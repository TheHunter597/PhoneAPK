// ======================================================
//  DAILY REVIEW DASHBOARD (js/dashboard.js)
// ======================================================
// A landing page overlay that shows:
// - Stats: total notes, total questions, study streak
// - Due flashcards (from quiz bank questions not reviewed recently)
// - Recent notes (last 5 edited)
// - Quick actions: Take a quiz, Open graph view, etc.
//
// Opens via a button in the outline rail or via Ctrl+D.

let dashboardOverlay = null;
let dashboardAbortController = null;

export function setupDashboard() {
  // Add a dashboard button to the outline rail header
  const rail = document.getElementById("outline-rail");
  if (!rail) return;
  const header = rail.querySelector(".outline-rail-header");
  if (!header) return;

  const btn = document.createElement("button");
  btn.className = "outline-icon-btn dashboard-toggle-btn";
  btn.title = "Daily Review Dashboard (Ctrl+D)";
  btn.setAttribute("aria-label", "Open daily review dashboard");
  btn.innerHTML = `<i class="fas fa-home"></i>`;
  btn.addEventListener("click", openDashboard);

  // Insert at the start of the header (before gear)
  const gearBtn = header.querySelector("#outline-gear-btn");
  if (gearBtn) {
    header.insertBefore(btn, gearBtn);
  } else {
    header.appendChild(btn);
  }
}

export function openDashboard() {
  closeDashboard();

  dashboardOverlay = document.createElement("div");
  dashboardOverlay.className = "dashboard-overlay";
  dashboardOverlay.innerHTML = `
    <div class="dashboard-modal">
      <div class="dashboard-header">
        <span class="dashboard-title">📊 Daily Review Dashboard</span>
        <button class="dashboard-close-btn" id="dashboardCloseBtn" title="Close (Esc)">✕</button>
      </div>
      <div class="dashboard-content" id="dashboardContent">
        <p class="dashboard-loading">Loading your study stats…</p>
      </div>
    </div>
  `;
  document.body.appendChild(dashboardOverlay);

  dashboardOverlay.querySelector("#dashboardCloseBtn").addEventListener("click", closeDashboard);
  dashboardOverlay.addEventListener("click", (e) => {
    if (e.target === dashboardOverlay) closeDashboard();
  });

  loadDashboardData();
}

export function closeDashboard() {
  // Abort any in-flight fetches started by loadDashboardData (P8).
  if (dashboardAbortController) {
    try { dashboardAbortController.abort(); } catch (e) { /* already aborted */ }
    dashboardAbortController = null;
  }
  if (dashboardOverlay) {
    dashboardOverlay.remove();
    dashboardOverlay = null;
  }
}

async function loadDashboardData() {
  const content = dashboardOverlay.querySelector("#dashboardContent");

  // Abort any previous in-flight dashboard fetch (P8).
  if (dashboardAbortController) {
    try { dashboardAbortController.abort(); } catch (e) { /* ignore */ }
  }
  dashboardAbortController = new AbortController();

  // Gather data
  const allNotes = window._allNotes || {};
  const noteCount = Object.keys(allNotes).length;

  // Load quiz bank
  let quizCount = 0;
  let dueQuestions = [];
  try {
    const res = await fetch("/api/quiz/bank", { signal: dashboardAbortController.signal });
    const data = await res.json();
    if (data.success) {
      quizCount = data.questions.length;
      // "Due" = not reviewed in last 24 hours (or never reviewed)
      const oneDayAgo = Date.now() - 24 * 60 * 60 * 1000;
      dueQuestions = data.questions.filter(q => !q.lastReviewed || q.lastReviewed < oneDayAgo);
    }
  } catch (e) {
    // Aborted requests are expected when the user closes the dashboard — silence them.
    if (e && e.name === "AbortError") return;
    /* otherwise ignore — quiz stats are non-critical */
  } finally {
    dashboardAbortController = null;
  }

  // Study streak from localStorage
  const streak = calculateStreak();

  // Recent notes from localStorage (we track lastViewed timestamps)
  const recentNotes = getRecentNotes();

  // Build stats
  const totalLinks = countLinks(allNotes);

  content.innerHTML = `
    <div class="dashboard-stats">
      <div class="stat-card">
        <div class="stat-value">${noteCount}</div>
        <div class="stat-label">Notes</div>
      </div>
      <div class="stat-card">
        <div class="stat-value">${totalLinks}</div>
        <div class="stat-label">Note Links</div>
      </div>
      <div class="stat-card">
        <div class="stat-value">${quizCount}</div>
        <div class="stat-label">Saved Questions</div>
      </div>
      <div class="stat-card ${streak > 0 ? "stat-card-streak" : ""}">
        <div class="stat-value">${streak}🔥</div>
        <div class="stat-label">Day Streak</div>
      </div>
    </div>

    <div class="dashboard-stats" style="margin-top: 0.8rem;">
      <div class="stat-card stat-card-study">
        <div class="stat-value">${window._studyTracker ? window._studyTracker.formatTime(window._studyTracker.getTodaySeconds()) : "0s"}</div>
        <div class="stat-label">Today</div>
      </div>
      <div class="stat-card stat-card-study">
        <div class="stat-value">${window._studyTracker ? window._studyTracker.formatTime(window._studyTracker.getTotalSeconds()) : "0s"}</div>
        <div class="stat-label">All Time</div>
      </div>
      <div class="stat-card stat-card-study">
        <div class="stat-value">${window._studyTracker && window._studyTracker.isIdle() ? "⏸" : "▶"}</div>
        <div class="stat-label">${window._studyTracker && window._studyTracker.isIdle() ? "Idle" : "Active"}</div>
      </div>
    </div>

    <div class="dashboard-grid">
      <div class="dashboard-section">
        <h3>📝 Due for Review</h3>
        ${dueQuestions.length > 0
          ? `<p class="dashboard-section-desc">${dueQuestions.length} questions ready for review.</p>
             <button class="dashboard-action-btn" id="dashReviewBtn">📝 Practice ${Math.min(10, dueQuestions.length)} Questions</button>`
          : `<p class="dashboard-empty">No questions due. ${quizCount === 0 ? "Take a quiz to build your question bank!" : "You're all caught up! 🎉"}</p>`
        }
      </div>

      <div class="dashboard-section">
        <h3>🕐 Recent Notes</h3>
        ${recentNotes.length > 0
          ? `<div class="recent-notes-list">
              ${recentNotes.map(n => `
                <div class="recent-note-item" data-path="${escapeHtml(n.path)}">
                  <span class="recent-note-icon">📄</span>
                  <span class="recent-note-name">${escapeHtml(n.name)}</span>
                  <span class="recent-note-time">${formatTime(n.time)}</span>
                </div>
              `).join("")}
            </div>`
          : `<p class="dashboard-empty">No recently viewed notes.</p>`
        }
      </div>

      <div class="dashboard-section">
        <h3>🚀 Quick Actions</h3>
        <div class="quick-actions">
          <button class="quick-action-btn" id="dashQuizBtn">🧠 Take a Quiz</button>
          <button class="quick-action-btn" id="dashGraphBtn">🌐 Open Graph View</button>
          <button class="quick-action-btn" id="dashMindmapBtn">🧠 Mind Map Current Note</button>
          <button class="quick-action-btn" id="dashExportBtn">📦 Export All Notes</button>
        </div>
      </div>

      <div class="dashboard-section">
        <h3>📈 Study Activity</h3>
        <div class="activity-chart" id="activityChart">
          ${renderActivityChart()}
        </div>
      </div>
    </div>
  `;

  // Wire up actions
  const reviewBtn = content.querySelector("#dashReviewBtn");
  if (reviewBtn) {
    reviewBtn.addEventListener("click", async () => {
      // Fetch all questions and practice the due ones
      try {
        const res = await fetch("/api/quiz/bank");
        const data = await res.json();
        if (data.success) {
          const oneDayAgo = Date.now() - 24 * 60 * 60 * 1000;
          const due = data.questions.filter(q => !q.lastReviewed || q.lastReviewed < oneDayAgo);
          const shuffled = due.sort(() => Math.random() - 0.5).slice(0, 10);
          if (shuffled.length > 0) {
            closeDashboard();
            // Open quiz hub and render the due questions
            document.getElementById("quizHubBtn")?.click();
            setTimeout(() => {
              // We need to access the quiz module's renderQuiz — but it's internal.
              // For now, just open the quiz hub.
            }, 100);
          }
        }
      } catch (e) { /* ignore */ }
    });
  }

  content.querySelector("#dashQuizBtn")?.addEventListener("click", () => {
    closeDashboard();
    document.getElementById("quizHubBtn")?.click();
  });

  content.querySelector("#dashGraphBtn")?.addEventListener("click", () => {
    closeDashboard();
    document.querySelector(".graph-toggle-btn")?.click();
  });

  content.querySelector("#dashMindmapBtn")?.addEventListener("click", () => {
    closeDashboard();
    document.querySelector(".mindmap-toggle-btn")?.click();
  });

  // Export All Notes — dispatches an event handled by exportZip.js.
  content.querySelector("#dashExportBtn")?.addEventListener("click", () => {
    closeDashboard();
    document.dispatchEvent(new CustomEvent("exportAllNotes"));
  });

  // Wire up recent note clicks
  content.querySelectorAll(".recent-note-item").forEach(item => {
    item.addEventListener("click", () => {
      const path = item.dataset.path;
      closeDashboard();
      document.dispatchEvent(new CustomEvent("navigate", { detail: { path, pushHistory: true } }));
    });
  });
}

// ======================================================
//  HELPERS
// ======================================================

function calculateStreak() {
  // Track study days in localStorage: { days: ["2024-01-15", ...], lastView: timestamp }
  const data = JSON.parse(localStorage.getItem("studyStreak") || '{"days":[]}');
  const today = new Date().toISOString().slice(0, 10);
  if (!data.days.includes(today)) {
    data.days.push(today);
    data.lastView = Date.now();
    localStorage.setItem("studyStreak", JSON.stringify(data));
  }
  // Count consecutive days ending today
  let streak = 0;
  const dayMs = 24 * 60 * 60 * 1000;
  let checkDate = new Date();
  const daysSet = new Set(data.days);
  while (daysSet.has(checkDate.toISOString().slice(0, 10))) {
    streak++;
    checkDate = new Date(checkDate.getTime() - dayMs);
  }
  return streak;
}

function getRecentNotes() {
  // We track recent notes in localStorage whenever a note is opened
  const data = JSON.parse(localStorage.getItem("recentNotes") || "[]");
  return data.slice(0, 5);
}

// Call this when a note is opened to track it
export function trackRecentNote(path) {
  const data = JSON.parse(localStorage.getItem("recentNotes") || "[]");
  // Remove if already exists
  const filtered = data.filter(n => n.path !== path);
  // Add to front
  filtered.unshift({ path, name: path.split("/").pop(), time: Date.now() });
  // Keep last 20
  localStorage.setItem("recentNotes", JSON.stringify(filtered.slice(0, 20)));
}

function countLinks(noteMap) {
  let count = 0;
  const linkRegex = /\[\[([^\]]+)\]\]/g;
  for (const path of Object.keys(noteMap)) {
    const content = noteMap[path];
    if (!content) continue;
    let match;
    while ((match = linkRegex.exec(content)) !== null) {
      count++;
    }
  }
  return count;
}

function formatTime(timestamp) {
  const diff = Date.now() - timestamp;
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function renderActivityChart() {
  // Show last 7 days of activity
  const data = JSON.parse(localStorage.getItem("studyStreak") || '{"days":[]}');
  const daysSet = new Set(data.days);
  const today = new Date();
  const dayMs = 24 * 60 * 60 * 1000;
  let bars = "";
  for (let i = 6; i >= 0; i--) {
    const date = new Date(today.getTime() - i * dayMs);
    const dateStr = date.toISOString().slice(0, 10);
    const active = daysSet.has(dateStr);
    const dayLabel = date.toLocaleDateString("en", { weekday: "short" }).slice(0, 2);
    bars += `
      <div class="activity-bar ${active ? "active" : ""}">
        <div class="activity-bar-fill" style="height: ${active ? "100%" : "10%"};"></div>
        <div class="activity-bar-label">${dayLabel}</div>
      </div>
    `;
  }
  return `<div class="activity-bars">${bars}</div>`;
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = String(str);
  return div.innerHTML;
}
