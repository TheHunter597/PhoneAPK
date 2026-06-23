// ======================================================
//  AI QUIZ MODE + QUESTION BANK (js/quizMode.js)
// ======================================================
// Two main features:
// 1. AI Quiz — generates USMLE-style MCQs from the current note, presents
//    them in a modal overlay, scores answers, shows explanations.
// 2. Question Bank — saved questions from past quizzes, browse/review/delete.
//
// A floating button at the top-right of the page opens the quiz hub, which
// has two tabs: "Take Quiz" (generate from current note) and "Question Bank"
// (browse saved questions).

let quizOverlay = null;
let quizAbortController = null;
let quizBankAbortController = null;

export function setupQuizMode() {
  // Don't create a separate button — the unified AI button handles both
  // AI Chat and AI Quiz via a single dropdown at the top-right of the page.
  // This function is kept as a no-op for backwards compatibility with any
  // callers (e.g. app.js) that invoke it during setup.
  //
  // The unified button is auto-created below by createUnifiedAIButton(),
  // which runs on DOMContentLoaded (or immediately if the DOM is ready).
}

// ======================================================
//  QUIZ HUB — main overlay with two tabs
// ======================================================

function openQuizHub() {
  closeQuizHub();

  quizOverlay = document.createElement("div");
  quizOverlay.className = "quiz-overlay";
  quizOverlay.innerHTML = `
    <div class="quiz-modal">
      <div class="quiz-header">
        <span class="quiz-title">🧠 AI Quiz Mode</span>
        <button class="quiz-close-btn" id="quizCloseBtn" title="Close (Esc)">✕</button>
      </div>
      <div class="quiz-tabs">
        <button class="quiz-tab active" data-tab="take">📝 Take Quiz</button>
        <button class="quiz-tab" data-tab="bank">📚 Question Bank</button>
      </div>
      <div class="quiz-content" id="quizContent">
        <!-- Take Quiz tab -->
        <div class="quiz-pane active" id="quizPaneTake">
          <p class="quiz-description">Generate USMLE-style multiple-choice questions from the current note. The AI will test the key concepts and explain each answer.</p>
          <div class="quiz-form">
            <label class="quiz-label">
              Number of questions:
              <select id="quizCount" class="quiz-select">
                <option value="3">3 questions</option>
                <option value="5" selected>5 questions</option>
                <option value="7">7 questions</option>
                <option value="10">10 questions</option>
              </select>
            </label>
            <div id="quizNoteInfo" class="quiz-note-info"></div>
            <button id="quizGenerateBtn" class="quiz-generate-btn">🚀 Generate Quiz</button>
          </div>
        </div>
        <!-- Question Bank tab -->
        <div class="quiz-pane" id="quizPaneBank">
          <div id="quizBankContent" class="quiz-bank-content">
            <p class="quiz-loading">Loading question bank…</p>
          </div>
        </div>
      </div>
    </div>
  `;
  document.body.appendChild(quizOverlay);

  // Wire up close
  quizOverlay.querySelector("#quizCloseBtn").addEventListener("click", closeQuizHub);
  quizOverlay.addEventListener("click", (e) => {
    if (e.target === quizOverlay) closeQuizHub();
  });

  // Wire up tabs
  quizOverlay.querySelectorAll(".quiz-tab").forEach(tab => {
    tab.addEventListener("click", () => {
      quizOverlay.querySelectorAll(".quiz-tab").forEach(t => t.classList.remove("active"));
      quizOverlay.querySelectorAll(".quiz-pane").forEach(p => p.classList.remove("active"));
      tab.classList.add("active");
      const paneId = tab.dataset.tab === "take" ? "quizPaneTake" : "quizPaneBank";
      quizOverlay.querySelector("#" + paneId).classList.add("active");
      if (tab.dataset.tab === "bank") loadQuestionBank();
    });
  });

  // Show current note info
  const notePath = window._getCurrentNotePath ? window._getCurrentNotePath() : null;
  const noteInfo = quizOverlay.querySelector("#quizNoteInfo");
  if (notePath) {
    noteInfo.innerHTML = `📋 Current note: <strong>${escapeHtml(notePath)}</strong>`;
  } else {
    noteInfo.innerHTML = `⚠️ No note is currently open. Open a note first to generate a quiz from it.`;
  }

  // Wire up generate button
  quizOverlay.querySelector("#quizGenerateBtn").addEventListener("click", generateQuiz);
}

function closeQuizHub() {
  // Abort any in-flight quiz generation or bank fetch (P8).
  if (quizAbortController) {
    try { quizAbortController.abort(); } catch (e) { /* already aborted */ }
    quizAbortController = null;
  }
  if (quizBankAbortController) {
    try { quizBankAbortController.abort(); } catch (e) { /* already aborted */ }
    quizBankAbortController = null;
  }
  if (quizOverlay) {
    quizOverlay.remove();
    quizOverlay = null;
  }
}

// ======================================================
//  GENERATE QUIZ — calls /api/quiz/generate
// ======================================================

async function generateQuiz() {
  const notePath = window._getCurrentNotePath ? window._getCurrentNotePath() : null;
  if (!notePath) {
    window.showModal("No Note Open", "Please open a note first, then generate a quiz.", { icon: "ℹ️" });
    return;
  }

  const noteContent = window._getNoteContent ? window._getNoteContent(notePath) : null;
  if (!noteContent) {
    window.showErrorModal("Note Load Failed", "Could not load the current note's content.");
    return;
  }

  const count = parseInt(quizOverlay.querySelector("#quizCount").value, 10);
  const model = localStorage.getItem("chatModel") || "meta/llama-3.3-70b-instruct";
  const generateBtn = quizOverlay.querySelector("#quizGenerateBtn");

  // Show loading state
  generateBtn.disabled = true;
  generateBtn.textContent = "⏳ Generating...";
  const content = quizOverlay.querySelector("#quizContent");
  content.innerHTML = `
    <div class="quiz-loading-state">
      <div class="quiz-spinner"></div>
      <p>Generating ${count} questions from your note…</p>
      <p class="quiz-loading-hint">This may take 10-20 seconds. The AI is writing USMLE-style questions.</p>
    </div>
  `;

  // Abort any previous in-flight generation, then start a new one (P8).
  if (quizAbortController) {
    try { quizAbortController.abort(); } catch (e) { /* ignore */ }
  }
  quizAbortController = new AbortController();

  try {
    const res = await fetch("/api/quiz/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        noteContext: noteContent,
        noteTitle: notePath.split("/").pop(),
        count,
        model,
      }),
      signal: quizAbortController.signal,
    });
    const data = await res.json();

    if (data.success && data.questions.length > 0) {
      renderQuiz(data.questions, notePath, false);
    } else {
      content.innerHTML = `
        <div class="quiz-error-state">
          <p>❌ Failed to generate quiz:</p>
          <p class="quiz-error-msg">${escapeHtml(data.error || "Unknown error")}</p>
          <button class="quiz-retry-btn" id="quizRetryBtn">Try Again</button>
        </div>
      `;
      quizOverlay.querySelector("#quizRetryBtn").addEventListener("click", () => {
        openQuizHub();
        generateQuiz();
      });
    }
  } catch (err) {
    // Aborted requests are expected when the user closes the hub — silence them.
    if (err && err.name === "AbortError") return;
    // If the overlay was closed mid-fetch, there's nothing to render into.
    if (!quizOverlay) return;
    content.innerHTML = `
      <div class="quiz-error-state">
        <p>❌ Connection error:</p>
        <p class="quiz-error-msg">${escapeHtml(err.message)}</p>
        <button class="quiz-retry-btn" id="quizRetryBtn">Try Again</button>
      </div>
    `;
    quizOverlay.querySelector("#quizRetryBtn").addEventListener("click", () => {
      openQuizHub();
      generateQuiz();
    });
  } finally {
    if (generateBtn) {
      generateBtn.disabled = false;
      generateBtn.textContent = "🚀 Generate Quiz";
    }
    quizAbortController = null;
  }
}

// ======================================================
//  RENDER QUIZ — show questions, handle answers, score
// ======================================================

function renderQuiz(questions, notePath, isPracticeMode) {
  let currentQ = 0;
  let answers = []; // { questionId, selected, correct }
  let answeredCount = 0;

  const content = quizOverlay.querySelector("#quizContent");

  // Shuffle options for each question so the correct answer isn't always first.
  // We pre-compute the shuffled order for all questions up front so it stays
  // consistent when navigating back/forward.
  const shuffledQuestions = questions.map(q => {
    // Create array of [option, originalIndex] pairs
    const indexed = q.options.map((opt, i) => ({ opt, origIdx: i }));
    // Fisher-Yates shuffle
    for (let i = indexed.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [indexed[i], indexed[j]] = [indexed[j], indexed[i]];
    }
    // Find the new position of the correct answer
    const newCorrectIndex = indexed.findIndex(item => item.origIdx === q.correctIndex);
    return {
      ...q,
      options: indexed.map(item => item.opt),
      correctIndex: newCorrectIndex,
      // Keep original options for the review screen
      _originalOptions: q.options,
      _originalCorrectIndex: q.correctIndex,
    };
  });

  function renderQuestion() {
    const q = shuffledQuestions[currentQ];
    const progress = `${currentQ + 1} / ${questions.length}`;
    const score = answers.filter(a => a.correct).length;

    content.innerHTML = `
      <div class="quiz-active">
        <div class="quiz-progress-bar">
          <div class="quiz-progress-fill" style="width: ${((currentQ + 1) / questions.length) * 100}%"></div>
        </div>
        <div class="quiz-question-header">
          <span class="quiz-progress-text">Question ${progress}</span>
          <span class="quiz-score">Score: ${score}/${answeredCount}</span>
        </div>
        <div class="quiz-topic">${escapeHtml(q.topic || "General")}</div>
        <div class="quiz-question-text">${escapeHtml(q.question)}</div>
        <div class="quiz-options" id="quizOptions">
          ${q.options.map((opt, i) => `
            <button class="quiz-option" data-index="${i}">
              <span class="quiz-option-letter">${String.fromCharCode(65 + i)}</span>
              <span class="quiz-option-text">${escapeHtml(opt)}</span>
            </button>
          `).join("")}
        </div>
        <div class="quiz-explanation" id="quizExplanation" style="display:none;"></div>
        <div class="quiz-nav" id="quizNav" style="display:none;">
          ${currentQ > 0 ? '<button class="quiz-nav-btn quiz-prev-btn" id="quizPrevBtn">← Previous</button>' : ''}
          ${currentQ < questions.length - 1
            ? '<button class="quiz-nav-btn quiz-next-btn" id="quizNextBtn">Next →</button>'
            : '<button class="quiz-nav-btn quiz-finish-btn" id="quizFinishBtn">🏁 Finish Quiz</button>'}
        </div>
      </div>
    `;

    // Wire up options
    const optionsEl = content.querySelector("#quizOptions");
    const explanationEl = content.querySelector("#quizExplanation");
    const navEl = content.querySelector("#quizNav");

    optionsEl.querySelectorAll(".quiz-option").forEach(btn => {
      btn.addEventListener("click", () => {
        const selected = parseInt(btn.dataset.index, 10);
        const correct = selected === q.correctIndex;

        // Disable all options
        optionsEl.querySelectorAll(".quiz-option").forEach(b => {
          b.disabled = true;
          const idx = parseInt(b.dataset.index, 10);
          if (idx === q.correctIndex) {
            b.classList.add("correct");
          } else if (idx === selected) {
            b.classList.add("incorrect");
          }
        });

        // Show explanation
        explanationEl.innerHTML = `
          <div class="quiz-explanation-box ${correct ? "correct" : "incorrect"}">
            <div class="quiz-explanation-header">
              ${correct ? "✅ Correct!" : "❌ Incorrect"}
            </div>
            <div class="quiz-explanation-text">${escapeHtml(q.explanation)}</div>
          </div>
        `;
        explanationEl.style.display = "block";
        navEl.style.display = "flex";

        // Record answer
        answers[currentQ] = { selected, correct };
        answeredCount++;

        // Update score display
        const scoreEl = content.querySelector(".quiz-score");
        if (scoreEl) {
          const newScore = answers.filter(a => a.correct).length;
          scoreEl.textContent = `Score: ${newScore}/${answeredCount}`;
        }
      });
    });

    // Wire up nav buttons
    const prevBtn = content.querySelector("#quizPrevBtn");
    const nextBtn = content.querySelector("#quizNextBtn");
    const finishBtn = content.querySelector("#quizFinishBtn");

    if (prevBtn) prevBtn.addEventListener("click", () => { currentQ--; renderQuestion(); });
    if (nextBtn) nextBtn.addEventListener("click", () => { currentQ++; renderQuestion(); });
    if (finishBtn) finishBtn.addEventListener("click", () => finishQuiz(shuffledQuestions, answers, notePath, isPracticeMode));
  }

  renderQuestion();
}

function finishQuiz(questions, answers, notePath, isPracticeMode) {
  const score = answers.filter(a => a && a.correct).length;
  const total = questions.length;
  const percentage = Math.round((score / total) * 100);

  const content = quizOverlay.querySelector("#quizContent");
  content.innerHTML = `
    <div class="quiz-results">
      <div class="quiz-results-header">
        <div class="quiz-results-score ${percentage >= 70 ? "pass" : "fail"}">${percentage}%</div>
        <div class="quiz-results-detail">${score} / ${total} correct</div>
      </div>
      <div class="quiz-results-message">
        ${percentage >= 90 ? "🏆 Outstanding! You've mastered this note." :
          percentage >= 70 ? "👍 Good work! Review the missed questions below." :
          percentage >= 50 ? "📚 Keep studying — review the explanations below." :
          "💪 Don't give up! Re-read the note and try again."}
      </div>
      <div class="quiz-results-actions">
        ${isPracticeMode ? '' : '<button class="quiz-save-btn" id="quizSaveBtn">💾 Save to Question Bank</button>'}
        <button class="quiz-retake-btn" id="quizRetakeBtn">🔄 New Quiz</button>
      </div>
      <div class="quiz-results-review">
        <h3>Review</h3>
        ${questions.map((q, i) => {
          const a = answers[i];
          const correct = a && a.correct;
          return `
            <div class="quiz-review-item ${correct ? "correct" : "incorrect"}">
              <div class="quiz-review-question">${i + 1}. ${escapeHtml(q.question)}</div>
              <div class="quiz-review-answer">
                ${correct
                  ? `✅ <strong>${String.fromCharCode(65 + q.correctIndex)}:</strong> ${escapeHtml(q.options[q.correctIndex])}`
                  : a
                  ? `❌ Your answer: ${String.fromCharCode(65 + a.selected)} | Correct: ${String.fromCharCode(65 + q.correctIndex)}: ${escapeHtml(q.options[q.correctIndex])}`
                  : `⏭️ Skipped | Correct: ${String.fromCharCode(65 + q.correctIndex)}: ${escapeHtml(q.options[q.correctIndex])}`}
              </div>
              <div class="quiz-review-explanation">${escapeHtml(q.explanation)}</div>
            </div>
          `;
        }).join("")}
      </div>
    </div>
  `;

  quizOverlay.querySelector("#quizRetakeBtn").addEventListener("click", () => {
    openQuizHub();
  });

  const saveBtn = quizOverlay.querySelector("#quizSaveBtn");
  if (saveBtn) saveBtn.addEventListener("click", async () => {
    const btn = quizOverlay.querySelector("#quizSaveBtn");
    btn.disabled = true;
    btn.textContent = "⏳ Saving...";
    try {
      const res = await fetch("/api/quiz/save", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          notePath,
          noteTitle: notePath.split("/").pop(),
          questions,
        }),
      });
      const data = await res.json();
      if (data.success) {
        btn.textContent = `✅ Saved ${data.count} questions (total: ${data.total})`;
      } else {
        btn.textContent = "❌ Save failed";
        window.showErrorModal("Save Failed", "Save failed: " + (data.error || "Unknown"));
      }
    } catch (err) {
      btn.textContent = "❌ Save error";
      window.showErrorModal("Save Error", "Save error: " + err.message);
    }
  });
}

// ======================================================
//  QUESTION BANK — browse saved questions
// ======================================================

// Track the active scope and all questions
let activeScope = "all"; // "note", "section", "all"
let allBankQuestions = [];

async function loadQuestionBank() {
  const content = quizOverlay.querySelector("#quizBankContent");
  if (!content) return;

  content.innerHTML = `<p class="quiz-loading">Loading question bank…</p>`;

  if (quizBankAbortController) {
    try { quizBankAbortController.abort(); } catch (e) { /* ignore */ }
  }
  quizBankAbortController = new AbortController();

  try {
    const res = await fetch("/api/quiz/bank", { signal: quizBankAbortController.signal });
    const data = await res.json();

    if (!data.success) {
      content.innerHTML = `<p class="quiz-error">❌ Failed to load: ${escapeHtml(data.error)}</p>`;
      return;
    }

    allBankQuestions = data.questions;
    renderQuestionBank();
  } catch (err) {
    if (err && err.name === "AbortError") return;
    if (!quizOverlay) return;
    content.innerHTML = `<p class="quiz-error">❌ Error: ${escapeHtml(err.message)}</p>`;
  } finally {
    quizBankAbortController = null;
  }
}

// Get the current note path and section
function getCurrentNoteInfo() {
  const notePath = window._getCurrentNotePath ? window._getCurrentNotePath() : null;
  if (!notePath) return { notePath: null, noteName: null, section: null };
  const normalized = notePath.replace(/\\/g, '/');
  const parts = normalized.split('/');
  const noteName = parts.pop();
  const section = parts.length > 0 ? parts.join('/') : null;
  return { notePath: normalized, noteName, section };
}

// Filter questions by the active scope
function getScopedQuestions() {
  const { notePath, section } = getCurrentNoteInfo();
  if (activeScope === "note" && notePath) {
    return allBankQuestions.filter(q => {
      if (!q.notePath) return false;
      return q.notePath.replace(/\\/g, '/').toLowerCase() === notePath.toLowerCase();
    });
  }
  if (activeScope === "section" && section) {
    return allBankQuestions.filter(q => {
      if (!q.notePath) return false;
      const qParts = q.notePath.replace(/\\/g, '/').split('/');
      qParts.pop(); // remove note name
      const qSection = qParts.join('/');
      return qSection.toLowerCase() === section.toLowerCase();
    });
  }
  return allBankQuestions; // "all"
}

// Render the question bank with scope buttons, practice, and add buttons
function renderQuestionBank() {
  const content = quizOverlay.querySelector("#quizBankContent");
  if (!content) return;

  const { noteName, section } = getCurrentNoteInfo();
  const scoped = getScopedQuestions();

  if (allBankQuestions.length === 0) {
    content.innerHTML = `
      <div class="quiz-bank-empty">
        <p>📭 Your question bank is empty.</p>
        <p>Take a quiz and click "Save to Question Bank" to build your collection, or add a question manually.</p>
        <button class="quiz-bank-add-btn" id="quizBankAddBtn">➕ Add Question Manually</button>
      </div>
    `;
    wireAddButton();
    return;
  }

  // Group scoped questions by topic
  const byTopic = {};
  for (const q of scoped) {
    const topic = q.topic || "General";
    if (!byTopic[topic]) byTopic[topic] = [];
    byTopic[topic].push(q);
  }

  const sectionLabel = section ? section.split('/').pop() : 'Root';

  let html = `
    <div class="quiz-bank-scope-bar">
      <button class="quiz-scope-btn ${activeScope === 'note' ? 'active' : ''}" data-scope="note" ${!noteName ? 'disabled' : ''}>
        📄 This Note${noteName ? ` (${noteName})` : ''}
      </button>
      <button class="quiz-scope-btn ${activeScope === 'section' ? 'active' : ''}" data-scope="section" ${!section ? 'disabled' : ''}>
        📁 This Section${section ? ` (${sectionLabel})` : ''}
      </button>
      <button class="quiz-scope-btn ${activeScope === 'all' ? 'active' : ''}" data-scope="all">
        🌐 All Notes
      </button>
    </div>
    <div class="quiz-bank-stats">
      <span>📊 ${scoped.length} questions</span>
      <span>🏷️ ${Object.keys(byTopic).length} topics</span>
      <div class="quiz-bank-stats-actions">
        <button class="quiz-bank-add-btn" id="quizBankAddBtn">➕ Add Question</button>
        <button class="quiz-bank-review-btn" id="quizBankReviewBtn" ${scoped.length === 0 ? 'disabled' : ''}>📝 Practice All</button>
      </div>
    </div>
  `;

  if (scoped.length === 0) {
    html += `<div class="quiz-bank-empty"><p>No questions in this scope. Try a different scope or add one manually.</p></div>`;
  } else {
    for (const topic of Object.keys(byTopic).sort()) {
      const qs = byTopic[topic];
      html += `
        <div class="quiz-bank-topic">
          <div class="quiz-bank-topic-header">
            <span class="quiz-bank-topic-name">${escapeHtml(topic)}</span>
            <span class="quiz-bank-topic-count">${qs.length}</span>
          </div>
          ${qs.map(q => `
            <div class="quiz-bank-item" data-id="${q.id}">
              <div class="quiz-bank-item-q">${escapeHtml(q.question)}</div>
              <div class="quiz-bank-item-meta">
                ${q.source === 'manual' ? '<span class="quiz-bank-item-badge quiz-badge-manual">✍️ Manual</span>' : '<span class="quiz-bank-item-badge quiz-badge-ai">🤖 AI</span>'}
                <span class="quiz-bank-item-source">${q.noteTitle ? escapeHtml(q.noteTitle) : "Unknown source"}</span>
                ${q.timesAnswered > 0 ? `<span class="quiz-bank-item-stats">Answered ${q.timesAnswered}× · ${Math.round((q.timesCorrect / q.timesAnswered) * 100)}% correct</span>` : ""}
                <button class="quiz-bank-item-delete" data-id="${q.id}" title="Delete">🗑️</button>
              </div>
            </div>
          `).join("")}
        </div>
      `;
    }
  }

  content.innerHTML = html;

  // Wire up scope buttons
  content.querySelectorAll(".quiz-scope-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      if (btn.disabled) return;
      activeScope = btn.dataset.scope;
      renderQuestionBank();
    });
  });

  // Wire up delete buttons
  content.querySelectorAll(".quiz-bank-item-delete").forEach(btn => {
    btn.addEventListener("click", async (e) => {
      e.stopPropagation();
      const id = btn.dataset.id;
      window.showModal("Delete Question", "Are you sure you want to delete this question? This cannot be undone.", {
        icon: "🗑️",
        buttons: [
          { text: "Delete", primary: true, action: async () => {
            try {
              const res = await fetch(`/api/quiz/${id}`, { method: "DELETE" });
              const data = await res.json();
              if (data.success) {
                allBankQuestions = allBankQuestions.filter(q => q.id !== id);
                renderQuestionBank();
              }
            } catch (err) {
              window.showErrorModal("Delete Failed", err.message);
            }
          }},
          { text: "Cancel" }
        ]
      });
    });
  });

  // Wire up practice all button
  const reviewBtn = content.querySelector("#quizBankReviewBtn");
  if (reviewBtn) {
    reviewBtn.addEventListener("click", () => {
      const pool = getScopedQuestions();
      if (pool.length === 0) return;
      showPracticeCountModal(pool);
    });
  }

  // Wire up add button
  wireAddButton();

  // Wire up clicking a question to practice it
  content.querySelectorAll(".quiz-bank-item").forEach(item => {
    item.addEventListener("click", () => {
      const id = item.dataset.id;
      const q = allBankQuestions.find(qq => qq.id === id);
      if (q) renderQuiz([q], null, true);
    });
  });
}

// Show the practice count selection modal
function showPracticeCountModal(pool) {
  const counts = [5, 7, 10, 15, 20, 25, 30];
  const available = pool.length;

  let buttonsHtml = '<div class="quiz-count-grid">';
  for (const n of counts) {
    const disabled = n > available;
    buttonsHtml += `<button class="quiz-count-btn ${disabled ? 'quiz-count-disabled' : ''}" data-count="${n}" ${disabled ? 'disabled' : ''}>${n}</button>`;
  }
  buttonsHtml += '</div>';

  window.showModal("Practice Session",
    `How many questions do you want to practice?\n\n${available} questions available in the current scope.\n\n${buttonsHtml}`,
    {
      icon: "📝",
      rawHtml: true,
      buttons: [
        { text: "Cancel" }
      ]
    }
  );

  // Wire up the count buttons
  setTimeout(() => {
    document.querySelectorAll(".quiz-count-btn:not(.quiz-count-disabled)").forEach(btn => {
      btn.addEventListener("click", () => {
        const count = parseInt(btn.dataset.count, 10);
        const shuffled = [...pool].sort(() => Math.random() - 0.5).slice(0, count);
        // Remove the modal overlay
        const overlay = document.getElementById("globalModalOverlay");
        if (overlay) overlay.remove();
        renderQuiz(shuffled, null, true);
      });
    });
  }, 50);
}

// Wire up the "Add Question" button
function wireAddButton() {
  const btn = document.getElementById("quizBankAddBtn");
  if (!btn || btn.dataset.wired) return;
  btn.dataset.wired = '1';
  btn.addEventListener("click", showAddQuestionForm);
}

// Show the add question form
function showAddQuestionForm() {
  const { notePath, noteName } = getCurrentNoteInfo();

  window.showModal("Add Question", `
    <div class="quiz-add-form">
      <label>Question *</label>
      <textarea id="addQQuestion" placeholder="Enter your question..." rows="3"></textarea>
      <label>Option A *</label>
      <input type="text" id="addQOpt0" placeholder="Option A">
      <label>Option B *</label>
      <input type="text" id="addQOpt1" placeholder="Option B">
      <label>Option C *</label>
      <input type="text" id="addQOpt2" placeholder="Option C">
      <label>Option D *</label>
      <input type="text" id="addQOpt3" placeholder="Option D">
      <label>Correct Answer *</label>
      <select id="addQCorrect">
        <option value="0">A</option>
        <option value="1">B</option>
        <option value="2">C</option>
        <option value="3">D</option>
      </select>
      <label>Explanation</label>
      <textarea id="addQExplain" placeholder="Why is this the correct answer?" rows="2"></textarea>
      <label>Topic</label>
      <input type="text" id="addQTopic" placeholder="e.g., Immunology, Pharmacology" value="General">
      <label>Associated Note</label>
      <input type="text" id="addQNote" placeholder="Note name" value="${noteName || ''}">
    </div>
  `, {
    icon: "➕",
    rawHtml: true,
    buttons: [
      { text: "Save Question", primary: true, action: async () => {
        const question = document.getElementById("addQQuestion").value.trim();
        const options = [
          document.getElementById("addQOpt0").value.trim(),
          document.getElementById("addQOpt1").value.trim(),
          document.getElementById("addQOpt2").value.trim(),
          document.getElementById("addQOpt3").value.trim(),
        ];
        const correctIndex = parseInt(document.getElementById("addQCorrect").value, 10);
        const explanation = document.getElementById("addQExplain").value.trim();
        const topic = document.getElementById("addQTopic").value.trim() || "General";
        const noteTitle = document.getElementById("addQNote").value.trim();

        if (!question || options.some(o => !o)) {
          window.showErrorModal("Missing Fields", "Question text and all 4 options are required.");
          return;
        }

        try {
          const res = await fetch("/api/quiz/add", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              question, options, correctIndex, explanation, topic,
              notePath: notePath || null,
              noteTitle: noteTitle || null,
            }),
          });
          const data = await res.json();
          if (data.success) {
            // Refresh the bank
            await loadQuestionBank();
          } else {
            window.showErrorModal("Save Failed", data.error || "Unknown error");
          }
        } catch (err) {
          window.showErrorModal("Save Error", err.message);
        }
      }},
      { text: "Cancel" }
    ]
  });
}

// ======================================================
//  HELPERS
// ======================================================

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = String(str);
  return div.innerHTML;
}

// ======================================================
//  UNIFIED AI BUTTON (T6 — consolidates AI Chat + AI Quiz)
// ======================================================
// Replaces the old separate floating #quizHubBtn button and the outline-rail
// .chat-toggle-btn with a single floating button at the top-right of the page.
// Clicking it opens a dropdown with two options:
//   - "AI Chat & Recommendations" → triggers .chat-toggle-btn.click()
//     (the chat toggle button still exists in the outline rail, but is hidden
//      via CSS in chat.css; its click handler still works on hidden elements)
//   - "AI Quiz & Question Bank"   → calls openQuizHub()
//
// Auto-initializes on DOMContentLoaded (or immediately if DOM is ready).

function createUnifiedAIButton() {
  if (document.getElementById("unifiedAIBtn")) return;

  const btn = document.createElement("button");
  btn.id = "unifiedAIBtn";
  btn.className = "unified-ai-btn";
  btn.title = "AI Features";
  btn.innerHTML = `🤖`;
  btn.setAttribute("aria-label", "AI Features");

  const dropdown = document.createElement("div");
  dropdown.className = "ai-dropdown";
  dropdown.id = "aiDropdown";
  dropdown.innerHTML = `
    <div class="ai-dropdown-item" id="aiDropdownChat">
      <span class="ai-dropdown-icon">💬</span>
      <span>AI Chat & Recommendations</span>
    </div>
    <div class="ai-dropdown-item" id="aiDropdownQuiz">
      <span class="ai-dropdown-icon">🧠</span>
      <span>AI Quiz & Question Bank</span>
    </div>
  `;

  // Append to body — the button uses position:fixed so its DOM parent
  // doesn't affect layout. Position is controlled by CSS (right: 28px,
  // to the left of the 16px outline rail).
  document.body.appendChild(btn);
  document.body.appendChild(dropdown);

  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    dropdown.classList.toggle("open");
  });

  // Close the dropdown when the user clicks anywhere else on the page.
  document.addEventListener("click", () => {
    dropdown.classList.remove("open");
  });

  // Prevent clicks inside the dropdown from bubbling up and closing it.
  dropdown.addEventListener("click", (e) => e.stopPropagation());

  document.getElementById("aiDropdownChat").addEventListener("click", () => {
    dropdown.classList.remove("open");
    // Toggle the chat panel by simulating a click on the (hidden)
    // .chat-toggle-btn in the outline rail. JS-triggered clicks work on
    // display:none elements.
    const chatToggle = document.querySelector(".chat-toggle-btn");
    if (chatToggle) chatToggle.click();
  });

  document.getElementById("aiDropdownQuiz").addEventListener("click", () => {
    dropdown.classList.remove("open");
    openQuizHub();
  });
}

// Auto-init the unified AI button as soon as the DOM is ready.
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", createUnifiedAIButton);
} else {
  createUnifiedAIButton();
}
