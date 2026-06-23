// ======================================================
//  AI CHAT ASSISTANT (js/chat.js) — NVIDIA API + Multi-chat + Context menu
// ======================================================

let chatPanel = null;
let chatMessages = null;
let chatInput = null;
let chatSendBtn = null;
let chatToggleBtn = null;
let chatClearBtn = null;
let chatContextToggle = null;
let chatModelSelect = null;
let chatListBtn = null;
let chatListPanel = null;
let chatNewBtn = null;
let chatBackBtn = null;
let sessionId = "viewer-" + Date.now();
let isOpen = false;
let isWaiting = false;
let availableModels = [];
let currentModel = "meta/llama-3.3-70b-instruct";
let availableSkills = [];
let activeSkills = ["usmle_explainer", "zero_error", "note_advisor"];

// ---- Pending recommendations (id -> {target, anchor, title, content, notePath}) ----
// Populated when renderMarkdown() encounters @@REC ... @@ENDREC blocks.
// The Accept button reads from here to insert the content into the note.
// `notePath` records which note was active when the rec was rendered, so the
// Accept handler can detect if the user has since switched notes.
const pendingRecommendations = new Map();

// Module-level scratch variable: the note path for the in-flight renderMarkdown
// call. renderRecommendationCard reads this (if not passed an explicit notePath)
// to stamp rec cards with their originating note.
let currentRenderNotePath = null;

// Session-only set of dismissed recommendation IDs. NOT persisted to
// localStorage — cleared on note switch (see "navigate" listener in setupChat)
// so dismissed recs become active again when the user moves to another note.
const dismissedRecs = new Set();

// Regex for recommendation markers. Extracted BEFORE HTML escaping so the
// markers stay pristine. Content between markers is rendered as markdown.
// Format:
//   @@REC target="MODE" anchor="ANCHOR_TEXT" title="SHORT_TITLE"
//   [markdown content]
//   @@ENDREC
const REC_REGEX = /@@REC\s+target="([^"]*)"(?:\s+anchor="([^"]*)")?\s+title="([^"]+)"(?:\s+note="([^"]*)")?\s*\n([\s\S]*?)@@ENDREC/g;

// ---- Conversation storage (localStorage) ----
let conversations = {}; // { id: { id, title, messages: [], model, createdAt } }
let currentChatId = null;

function loadConversations() {
  try {
    const stored = localStorage.getItem("chatConversations");
    if (stored) conversations = JSON.parse(stored);
  } catch (e) { conversations = {}; }
}

function saveConversations() {
  try {
    localStorage.setItem("chatConversations", JSON.stringify(conversations));
  } catch (e) {}
}

function createNewChat() {
  const id = "chat-" + Date.now();
  const chat = {
    id,
    title: "New chat",
    messages: [],
    model: currentModel,
    createdAt: Date.now(),
  };
  conversations[id] = chat;
  currentChatId = id;
  sessionId = id;
  saveConversations();
  return chat;
}

function getCurrentChat() {
  if (!currentChatId || !conversations[currentChatId]) {
    return createNewChat();
  }
  return conversations[currentChatId];
}

function deleteChat(id) {
  delete conversations[id];
  saveConversations();
  if (currentChatId === id) {
    const ids = Object.keys(conversations);
    if (ids.length > 0) {
      switchToChat(ids[0]);
    } else {
      createNewChat();
      renderChatMessages();
    }
  }
  renderChatList();
}

function switchToChat(id) {
  if (!conversations[id]) return;
  currentChatId = id;
  sessionId = id;
  currentModel = conversations[id].model || currentModel;
  renderChatMessages();
  if (chatListPanel) chatListPanel.classList.remove("open");
}

function renderChatList() {
  if (!chatListPanel) return;
  const list = chatListPanel.querySelector(".chat-list-items");
  if (!list) return;
  list.innerHTML = "";
  const ids = Object.keys(conversations).sort((a, b) =>
    (conversations[b].createdAt || 0) - (conversations[a].createdAt || 0)
  );
  if (ids.length === 0) {
    list.innerHTML = '<div class="chat-list-empty">No conversations yet</div>';
    return;
  }
  for (const id of ids) {
    const chat = conversations[id];
    const item = document.createElement("div");
    item.className = "chat-list-item" + (id === currentChatId ? " active" : "");
    const title = chat.title || "New chat";
    const preview = chat.messages.length > 0
      ? chat.messages[0].content.substring(0, 40) + "..."
      : "No messages";
    item.innerHTML = `
      <div class="chat-list-item-title">${escapeHtml(title)}</div>
      <div class="chat-list-item-preview">${escapeHtml(preview)}</div>
      <button class="chat-list-item-delete" data-id="${id}" title="Delete">🗑️</button>
    `;
    item.addEventListener("click", (e) => {
      if (e.target.classList.contains("chat-list-item-delete")) return;
      switchToChat(id);
    });
    list.appendChild(item);
  }
  list.querySelectorAll(".chat-list-item-delete").forEach(btn => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      deleteChat(btn.dataset.id);
    });
  });
}

function renderChatMessages() {
  const chat = getCurrentChat();
  if (!chatMessages) return;
  chatMessages.innerHTML = "";
  if (chat.messages.length === 0) {
    addMessage("assistant", "Hi! I'm your AI study assistant. I can see your current note and answer questions about it. What would you like to know?");
  } else {
    for (const msg of chat.messages) {
      const msgEl = document.createElement("div");
      msgEl.className = `chat-msg chat-msg-${msg.role}`;
      const avatar = document.createElement("div");
      avatar.className = "chat-avatar";
      avatar.textContent = msg.role === "user" ? "🧑" : "🤖";
      const bubble = document.createElement("div");
      bubble.className = "chat-bubble";
      if (msg.role === "user") bubble.textContent = msg.content;
      else bubble.innerHTML = renderMarkdown(msg.content);
      msgEl.appendChild(avatar);
      msgEl.appendChild(bubble);
      chatMessages.appendChild(msgEl);
    }
    chatMessages.scrollTop = chatMessages.scrollHeight;
    wireRecommendationButtons(chatMessages);
  }
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = String(str);
  return div.innerHTML;
}

// Parse a GFM-style markdown table (header row + separator row + data rows).
// Returns { html } or null if the lines don't form a valid table.
function parseTable(block) {
  const lines = block.split('\n').map(l => l.trim()).filter(l => l.length > 0);
  if (lines.length < 2) return null;
  // Every row must start and end with |
  if (!lines.every(l => l.startsWith('|') && l.endsWith('|'))) return null;
  // Second row must be the separator: | --- | :---: | ---: | etc.
  const sepOk = /^\|[\s:|-]+\|$/.test(lines[1]) && lines[1].includes('-');
  if (!sepOk) return null;

  const parseRow = (line) =>
    line.replace(/^\|/, '').replace(/\|$/, '').split('|').map(c => c.trim());

  const header = parseRow(lines[0]);
  const rows = lines.slice(2).map(parseRow);

  let html = '<table class="chat-table"><thead><tr>';
  header.forEach(c => { html += `<th>${c}</th>`; });
  html += '</tr></thead><tbody>';
  rows.forEach(row => {
    while (row.length < header.length) row.push('');
    html += '<tr>' + row.map(c => `<td>${c}</td>`).join('') + '</tr>';
  });
  html += '</tbody></table>';
  return html;
}

// Inner renderer: escapes HTML, parses code blocks + tables + inline formatting.
// Does NOT handle @@REC markers (those are extracted by renderMarkdown before
// calling this). This separation lets us call renderMarkdownInner on
// recommendation content without re-triggering marker extraction.
function renderMarkdownInner(text) {
  // 1. Escape HTML (safe against injection from AI/note content)
  let html = escapeHtml(text);

  // 2. Extract fenced code blocks (protect from table/inline parsing)
  const codeBlocks = [];
  html = html.replace(/```(\w*)\n([\s\S]*?)```/g, (m, lang, code) => {
    const placeholder = `\u0000CB${codeBlocks.length}\u0000`;
    codeBlocks.push(
      `<pre style="background:#0d0d0d;color:#d4d4d4;padding:0.8rem;border-radius:6px;overflow-x:auto;font-size:0.82rem;margin:0.5rem 0;border:1px solid #ffffff1a;"><code>${code.trim()}</code></pre>`
    );
    return `\n${placeholder}\n`;
  });

  // 3. Parse markdown tables (GFM). A table is a run of 2+ consecutive lines
  // where every line starts and ends with |. We extract them to placeholders
  // so the \n→<br> pass below doesn't corrupt the table HTML.
  const tables = [];
  html = html.replace(/((?:^\|[^\n]*\|\s*\n?){2,})/gm, (m, block) => {
    const tbl = parseTable(block);
    if (!tbl) return m;
    const placeholder = `\u0000TBL${tables.length}\u0000`;
    tables.push(tbl);
    return `\n${placeholder}\n`;
  });

  // 4. Inline formatting
  html = html.replace(/`([^`]+)`/g, '<code style="background:#2a2a2a;color:#f08a8a;padding:0.1rem 0.3rem;border-radius:3px;font-size:0.85em;">$1</code>');
  html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  html = html.replace(/\*([^*\n]+)\*/g, '<em>$1</em>');
  // Blockquotes
  html = html.replace(/^&gt; (.+)$/gm, '<blockquote style="border-left:3px solid #4099ff;padding-left:0.6rem;margin:0.4rem 0;color:#adadad;">$1</blockquote>');
  // Lists (simple: - item or 1. item)
  html = html.replace(/(?:^- (.+)$\n?)+/gm, (m) => {
    const items = m.trim().split('\n').map(l => l.replace(/^- /, '').trim());
    return '<ul style="margin:0.3rem 0 0.3rem 1rem;padding:0;">' + items.map(i => `<li>${i}</li>`).join('') + '</ul>';
  });
  html = html.replace(/(?:^\d+\. (.+)$\n?)+/gm, (m) => {
    const items = m.trim().split('\n').map(l => l.replace(/^\d+\. /, '').trim());
    return '<ol style="margin:0.3rem 0 0.3rem 1rem;padding:0;">' + items.map(i => `<li>${i}</li>`).join('') + '</ol>';
  });
  // Headers
  html = html.replace(/^### (.+)$/gm, '<h4 style="margin:0.5rem 0;font-size:0.95rem;color:#f8f8f8;">$1</h4>');
  html = html.replace(/^## (.+)$/gm, '<h3 style="margin:0.5rem 0;font-size:1rem;color:#f8f8f8;">$1</h3>');
  html = html.replace(/^# (.+)$/gm, '<h3 style="margin:0.5rem 0;font-size:1.1rem;color:#f8f8f8;">$1</h3>');
  // Horizontal rule
  html = html.replace(/^---$/gm, '<hr style="border:none;border-top:1px solid #ffffff1a;margin:0.6rem 0;">');

  // 5. Convert remaining newlines to <br>
  html = html.replace(/\n/g, '<br>');

  // 6. Restore tables and code blocks
  html = html.replace(/\u0000TBL(\d+)\u0000/g, (m, i) => tables[parseInt(i, 10)] || '');
  html = html.replace(/\u0000CB(\d+)\u0000/g, (m, i) => codeBlocks[parseInt(i, 10)] || '');

  // 7. Clean up extra <br> around block elements
  html = html.replace(/<br>(\s*<(?:table|pre|ul|ol|blockquote|h[3-4]|hr))/g, '$1');
  html = html.replace(/(<\/(?:table|pre|ul|ol|blockquote)>)(\s*<br>)/g, '$1');

  return html;
}

// Render a recommendation as an insertable card with Accept/Dismiss buttons.
// `notePath` (optional) records which note this rec was intended for; if
// omitted, falls back to currentRenderNotePath (set by renderMarkdown).
function renderRecommendationCard(target, anchor, title, content, noteName) {
  const id = 'rec-' + Math.random().toString(36).slice(2, 10);
  const path = currentRenderNotePath;
  // Store BOTH the AI-provided note name AND the current path.
  // The noteName from the AI is the most reliable identifier (it's what
  // the AI was told the note is called). The path is a fallback.
  pendingRecommendations.set(id, {
    target, anchor: anchor || '', title, content, accepted: false,
    notePath: path || null,
    noteName: noteName || (path ? path.replace(/\\/g, '/').split('/').pop() : null)
  });
  const renderedContent = renderMarkdownInner(content);
  const targetLabel =
    target === 'at-end'   ? 'Insert at: end of note' :
    target === 'at-start' ? 'Insert at: beginning of note' :
    target === 'before'   ? `Insert before: "${anchor}"` :
    target === 'after'    ? `Insert after: "${anchor}"` :
    `Insert: ${target}`;
  const hasAnchor = !!anchor && (target === 'before' || target === 'after');
  const targetClickAttrs = hasAnchor
    ? `data-anchor="${escapeHtml(anchor)}" title="Click to jump to this section in the note" style="cursor:pointer;"`
    : '';
  return `<div class="rec-card" data-rec-id="${id}">
    <div class="rec-card-header">
      <span class="rec-card-icon">\u{1F4A1}</span>
      <span class="rec-card-title">${escapeHtml(title)}</span>
    </div>
    <div class="rec-card-target" ${targetClickAttrs}>${escapeHtml(targetLabel)}</div>
    <div class="rec-card-content">${renderedContent}</div>
    <div class="rec-card-actions">
      <button class="rec-accept-btn" data-rec-id="${id}">\u2705 Accept &amp; Insert</button>
      <button class="rec-copy-btn" data-rec-id="${id}">\u2398 Copy</button>
      <button class="rec-dismiss-btn" data-rec-id="${id}">\u2715 Dismiss</button>
    </div>
  </div>`;
}

// Top-level markdown renderer. Extracts @@REC recommendation blocks first
// (so the markers are pristine), then renders the surrounding markdown via
// renderMarkdownInner, then restores the recommendation cards.
function renderMarkdown(text) {
  if (!text) return '';
  // Track which note this render is for, so renderRecommendationCard can stamp
  // it onto newly-created rec cards. Used by the Accept handler to detect if
  // the user has switched notes before accepting.
  currentRenderNotePath = window._getCurrentNotePath ? window._getCurrentNotePath() : null;
  const recs = [];
  // Reset regex state (it's a global regex with /g flag — lastIndex persists)
  REC_REGEX.lastIndex = 0;
  let working = text.replace(REC_REGEX, (m, target, anchor, title, noteName, content) => {
    const idx = recs.length;
    recs.push({
      target: target.trim(),
      anchor: (anchor || '').trim(),
      title: title.trim(),
      content: content.trim(),
      noteName: (noteName || '').trim() // AI-provided note name (may be empty for old-format recs)
    });
    return `\u0000REC${idx}\u0000`;
  });

  let html = renderMarkdownInner(working);

  // Restore recommendation cards
  html = html.replace(/\u0000REC(\d+)\u0000/g, (m, i) => {
    const r = recs[parseInt(i, 10)];
    return renderRecommendationCard(r.target, r.anchor, r.title, r.content, r.noteName);
  });

  return html;
}

// Scroll the note view to a heading or text matching `anchor`.
// Works in both view mode (#content) and edit mode (#editableNote).
// Flashes the matched element briefly so the user can spot it.
function scrollToAnchor(anchor) {
  if (!anchor) return;
  const main = document.getElementById('main');
  if (!main) return;

  // Determine which container to search
  const container = window._isEditing
    ? document.getElementById('editableNote')
    : document.getElementById('content');
  if (!container) return;

  // Strip leading ## markers from the anchor — the AI sends "## Heading"
  // but the rendered heading text is just "Heading"
  const needle = anchor.toLowerCase().replace(/^#+\s*/, '').trim();
  if (!needle) return;

  // Try headings first (most common case — anchors are usually headings)
  const headings = container.querySelectorAll('h1, h2, h3, h4, h5, h6');
  for (const h of headings) {
    if (h.textContent.toLowerCase().includes(needle)) {
      const rect = h.getBoundingClientRect();
      const mainRect = main.getBoundingClientRect();
      main.scrollTop += rect.top - mainRect.top - 40;
      h.classList.add('rec-anchor-flash');
      setTimeout(() => h.classList.remove('rec-anchor-flash'), 2500);
      return;
    }
  }

  // Fall back to any text node containing the anchor
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT, null);
  let node;
  while ((node = walker.nextNode())) {
    if (node.textContent.toLowerCase().includes(needle)) {
      let el = node.parentElement;
      while (el && el !== container) {
        if (el.offsetTop) break;
        el = el.parentElement;
      }
      if (el && el !== container) {
        const rect = el.getBoundingClientRect();
        const mainRect = main.getBoundingClientRect();
        main.scrollTop += rect.top - mainRect.top - 40;
        el.classList.add('rec-anchor-flash');
        setTimeout(() => el.classList.remove('rec-anchor-flash'), 2500);
      }
      return;
    }
  }

  // Not found — the anchor doesn't exist in the current note (maybe the AI
  // hallucinated it, or the note was edited since the recommendation was made)
  window.showErrorModal('Anchor Not Found', 'Could not find "' + anchor + '" in the current note. The section may have been renamed or removed.');
}

// Wire up Accept/Revert/Dismiss buttons + clickable target label on any
// recommendation cards in the given container.
function wireRecommendationButtons(container) {
  if (!container) return;

  // ---- Accept / Revert toggle button ----
  container.querySelectorAll('.rec-accept-btn').forEach(btn => {
    if (btn.dataset.wired) return;
    btn.dataset.wired = '1';
    btn.addEventListener('click', async () => {
      const id = btn.dataset.recId;
      const rec = pendingRecommendations.get(id);
      if (!rec) return;

      if (rec.accepted) {
        // ---- REVERT ----
        btn.disabled = true;
        btn.textContent = '\u23F3 Reverting...';
        try {
          const result = window._revertRecommendation
            ? window._revertRecommendation(id)
            : { success: false, error: 'Revert is not available.' };
          if (result && result.success) {
            rec.accepted = false;
            btn.disabled = false;
            btn.textContent = '\u2705 Accept &amp; Insert';
            btn.classList.remove('revert-state');
            btn.closest('.rec-card').classList.remove('accepted');
            // Re-show the dismiss button
            const dismissBtn = btn.parentElement.querySelector('.rec-dismiss-btn');
            if (dismissBtn) dismissBtn.style.display = '';
          } else {
            btn.disabled = false;
            btn.textContent = '\u21A9 Revert';
            window.showErrorModal('Revert Failed', 'Could not revert: ' + (result && result.error ? result.error : 'Unknown error'));
          }
        } catch (err) {
          btn.disabled = false;
          btn.textContent = '\u21A9 Revert';
          window.showErrorModal('Revert Error', 'Error reverting: ' + err.message);
        }
      } else {
        // ---- ACCEPT ----
        // Pre-check: if the user has switched notes since this recommendation
        // was created, the anchor text won't be found in the current note and
        // insertion would silently fail (or insert into the wrong note). Surface
        // a helpful error naming the intended note before even trying.
        //
        // Compare by NOTE NAME (last path segment) rather than exact path,
        // because the path may have been normalized differently (backslashes
        // vs forward slashes, folder prefix differences, etc.).
        const currentPath = window._getCurrentNotePath ? window._getCurrentNotePath() : null;
        const currentName = currentPath ? currentPath.replace(/\\/g, '/').split('/').pop().toLowerCase() : '';
        // Use the AI-provided note name as the primary identifier, fall back to path
        const intendedName = rec.noteName ? rec.noteName.toLowerCase() : (rec.notePath ? rec.notePath.replace(/\\/g, '/').split('/').pop().toLowerCase() : currentName);
        const effectiveNotePath = rec.notePath || currentPath;
        if (intendedName && intendedName !== currentName) {
          const noteName = rec.noteName || (effectiveNotePath ? effectiveNotePath.replace(/\\/g, '/').split('/').pop() : 'the original note');
          const currentNoteName = currentPath ? currentPath.replace(/\\/g, '/').split('/').pop() : '(unknown)';
          window.showModal("Wrong Note",
            `This recommendation was created for note "${noteName}". You are currently in note "${currentNoteName}". Switch to "${noteName}" to insert it.`,
            {
              icon: "⚠️",
              buttons: [
                { text: "Go to \"" + noteName + "\"", primary: true, action: () => {
                  if (effectiveNotePath) {
                    document.dispatchEvent(new CustomEvent("navigate", { detail: { path: effectiveNotePath, pushHistory: true } }));
                  }
                }},
                { text: "Close" }
              ]
            }
          );
          return;
        }
        btn.disabled = true;
        btn.textContent = '\u23F3 Inserting...';
        try {
          const result = window._acceptRecommendation
            ? await window._acceptRecommendation(rec.target, rec.anchor, rec.content, id, effectiveNotePath)
            : { success: false, error: 'Recommendation insertion is not available.' };
          if (result && result.success) {
            rec.accepted = true;
            // Store the recId returned by the editor (in case it generated one)
            if (result.recId) rec.editorRecId = result.recId;
            btn.disabled = false;
            btn.textContent = '\u21A9 Revert';
            btn.classList.add('revert-state');
            btn.closest('.rec-card').classList.add('accepted');
            // Hide the dismiss button while accepted (revert replaces it)
            const dismissBtn = btn.parentElement.querySelector('.rec-dismiss-btn');
            if (dismissBtn) dismissBtn.style.display = 'none';
          } else {
            btn.disabled = false;
            btn.textContent = '\u2705 Accept &amp; Insert';
            if (result && result.wrongNote) {
              // Case 1: User is on a different note — show "Go to note" button
              const noteName = result.intendedNoteName || result.notePath.split('/').pop();
              window.showModal('Wrong Note',
                result.error,
                {
                  icon: "⚠️",
                  buttons: [
                    { text: "Go to \"" + noteName + "\"", primary: true, action: () => {
                      document.dispatchEvent(new CustomEvent("navigate", { detail: { path: result.notePath, pushHistory: true } }));
                    }},
                    { text: "Close" }
                  ]
                }
              );
            } else {
              // Case 2: On the right note but anchor not found — show error
              window.showErrorModal('Section Not Found', result && result.error ? result.error : 'Unknown error');
            }
          }
        } catch (err) {
          btn.disabled = false;
          btn.textContent = '\u2705 Accept &amp; Insert';
          window.showErrorModal('Insert Error', 'Error inserting recommendation: ' + err.message);
        }
      }
    });
  });

  // ---- Clickable target label → scroll to anchor ----
  container.querySelectorAll('.rec-card-target[data-anchor]').forEach(label => {
    if (label.dataset.wired) return;
    label.dataset.wired = '1';
    label.addEventListener('click', () => {
      const anchor = label.dataset.anchor;
      if (anchor) scrollToAnchor(anchor);
    });
  });

  // ---- Copy button ----
  // Writes BOTH text/plain (raw markdown) and text/html (rendered HTML) to
  // the clipboard. The editor's paste handler checks for raw markdown tables
  // and callouts in the text/plain data — if found, it inserts as a raw
  // markdown block (preserving the table syntax). The text/html is a
  // fallback for rich-text editors that don't check text/plain.
  container.querySelectorAll('.rec-copy-btn').forEach(btn => {
    if (btn.dataset.wired) return;
    btn.dataset.wired = '1';
    btn.addEventListener('click', async () => {
      const id = btn.dataset.recId;
      const rec = pendingRecommendations.get(id);
      if (!rec) return;
      try {
        // Render the markdown to HTML for the text/html clipboard type
        const renderedHtml = renderMarkdownInner(rec.content);

        // Use the Clipboard API with both text/plain and text/html
        const clipboardItem = new ClipboardItem({
          'text/plain': new Blob([rec.content], { type: 'text/plain' }),
          'text/html': new Blob([renderedHtml], { type: 'text/html' }),
        });
        await navigator.clipboard.write([clipboardItem]);

        const origText = btn.textContent;
        btn.textContent = '\u2713 Copied!';
        setTimeout(() => { btn.textContent = origText; }, 2000);
      } catch (e) {
        // Fallback: use a temporary textarea + execCommand (text/plain only)
        const ta = document.createElement('textarea');
        ta.value = rec.content;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        try { document.execCommand('copy'); btn.textContent = '\u2713 Copied!'; setTimeout(() => { btn.textContent = '\u2398 Copy'; }, 2000); }
        catch (e2) { window.showErrorModal('Copy Failed', 'Could not copy to clipboard.'); }
        ta.remove();
      }
    });
  });

  // ---- Dismiss button (toggle: click to dismiss, click again to restore) ----
  // Dismissals are session-only — stored in `dismissedRecs` (a Set, NOT
  // localStorage). Cleared on note switch (see "navigate" listener in setupChat)
  // so recs become active again when the user moves to another note.
  container.querySelectorAll('.rec-dismiss-btn').forEach(btn => {
    if (btn.dataset.wired) return;
    btn.dataset.wired = '1';
    btn.addEventListener('click', () => {
      const card = btn.closest('.rec-card');
      if (!card) return;
      const id = card.dataset.recId;
      if (dismissedRecs.has(id)) {
        // Restore
        dismissedRecs.delete(id);
        card.classList.remove('dismissed');
        card.style.opacity = '';
        card.style.pointerEvents = '';
        btn.textContent = '\u2715 Dismiss';
      } else {
        // Dismiss (session-only)
        dismissedRecs.add(id);
        card.classList.add('dismissed');
        // Override the CSS `pointer-events: none` on .dismissed so the user can
        // still click the card / Restore button to re-activate it.
        card.style.opacity = '0.4';
        card.style.pointerEvents = 'auto';
        btn.textContent = '\u21BA Restore';
      }
    });
  });
}

function addMessage(role, content) {
  const chat = getCurrentChat();
  chat.messages.push({ role, content });
  // Auto-title from first user message
  if (role === "user" && (chat.title === "New chat" || !chat.title)) {
    chat.title = content.substring(0, 40) + (content.length > 40 ? "..." : "");
  }
  saveConversations();

  const msgEl = document.createElement("div");
  msgEl.className = `chat-msg chat-msg-${role}`;
  const avatar = document.createElement("div");
  avatar.className = "chat-avatar";
  avatar.textContent = role === "user" ? "🧑" : "🤖";
  const bubble = document.createElement("div");
  bubble.className = "chat-bubble";
  if (role === "user") bubble.textContent = content;
  else bubble.innerHTML = renderMarkdown(content);
  msgEl.appendChild(avatar);
  msgEl.appendChild(bubble);
  chatMessages.appendChild(msgEl);
  chatMessages.scrollTop = chatMessages.scrollHeight;
  if (role === "assistant") wireRecommendationButtons(msgEl);
}

function addTypingIndicator() {
  const msg = document.createElement("div");
  msg.className = "chat-msg chat-msg-assistant chat-typing";
  msg.innerHTML = `<div class="chat-avatar">🤖</div><div class="chat-bubble"><span class="typing-dot"></span><span class="typing-dot"></span><span class="typing-dot"></span></div>`;
  chatMessages.appendChild(msg);
  chatMessages.scrollTop = chatMessages.scrollHeight;
  return msg;
}

function getCurrentNoteContext() {
  if (!window._getCurrentNotePath) return null;
  const path = window._getCurrentNotePath();
  if (!path) return null;
  let content = null;
  if (window._getNoteContent) content = window._getNoteContent(path);
  if (content === undefined || content === null) {
    const contentDiv = document.getElementById("content");
    if (!contentDiv) return null;
    content = contentDiv.textContent;
  }
  return { title: path.split("/").pop(), content: content.substring(0, 6000) };
}

function getSelectedText() {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return null;
  const text = sel.toString().trim();
  return (text && text.length >= 2) ? text : null;
}

// ---- Abort controller for cancelling in-flight requests ----
let currentAbortController = null;
let currentStreamReader = null; // tracked so we can cancel the stream reader

async function sendMessage(presetMessage) {
  const message = (presetMessage || chatInput.value).trim();
  if (!message || isWaiting) return;
  chatInput.value = "";
  chatInput.style.height = "auto";
  isWaiting = true;
  chatSendBtn.disabled = true;
  // Switch the send button to a "stop" button while waiting
  chatSendBtn.textContent = "⏹";
  chatSendBtn.title = "Stop generating";
  chatSendBtn.classList.add("stop-state");

  addMessage("user", message);
  // Create the assistant message bubble IMMEDIATELY (empty), so we can stream
  // chunks into it as they arrive. The bubble starts with the typing indicator.
  const chat = getCurrentChat();
  const assistantMsg = { role: "assistant", content: "" };
  chat.messages.push(assistantMsg);
  saveConversations();

  const msgEl = document.createElement("div");
  msgEl.className = "chat-msg chat-msg-assistant";
  const avatar = document.createElement("div");
  avatar.className = "chat-avatar";
  avatar.textContent = "🤖";
  const bubble = document.createElement("div");
  bubble.className = "chat-bubble";
  bubble.innerHTML = '<span class="typing-dot"></span><span class="typing-dot"></span><span class="typing-dot"></span>';
  msgEl.appendChild(avatar);
  msgEl.appendChild(bubble);
  chatMessages.appendChild(msgEl);
  chatMessages.scrollTop = chatMessages.scrollHeight;

  let noteContext = null;
  if (chatContextToggle && chatContextToggle.checked) {
    noteContext = getCurrentNoteContext();
  }
  const selectedText = getSelectedText();

  // AbortController so the user can cancel the in-flight stream
  currentAbortController = new AbortController();
  let fullResponse = "";
  let recCheckTimer = null;

  try {
    const res = await fetch("/api/chat/stream", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message,
        sessionId: currentChatId,
        noteContext: noteContext ? noteContext.content : null,
        // Send the active note path so the server can track which note the
        // recommendation was intended for (echoed back in @@REC responses).
        notePath: window._getCurrentNotePath ? window._getCurrentNotePath() : null,
        selectedText,
        model: currentModel,
        skills: activeSkills,
      }),
      signal: currentAbortController.signal,
    });

    if (!res.ok || !res.body) {
      // Non-streaming error response — try to parse a JSON error message.
      let errMsg = "HTTP " + res.status;
      try {
        const errData = await res.json();
        if (errData && errData.error) errMsg = errData.error;
      } catch (e) {}
      throw new Error(errMsg);
    }

    const reader = res.body.getReader();
    currentStreamReader = reader; // track so cancelCurrentRequest can cancel it
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      // Split into complete lines; keep the trailing partial line in buffer.
      const lines = buffer.split("\n");
      buffer = lines.pop();

      for (const line of lines) {
        if (line.startsWith("data: ")) {
          const data = line.slice(6).trim();
          if (data === "[DONE]") continue;
          try {
            const parsed = JSON.parse(data);
            if (parsed.error) {
              fullResponse = "❌ Error: " + parsed.error;
              break;
            }
            if (parsed.chunk) {
              fullResponse += parsed.chunk;
              currentRenderNotePath = window._getCurrentNotePath ? window._getCurrentNotePath() : null;
              bubble.innerHTML = renderMarkdown(fullResponse);

              // Only auto-scroll if the user is near the bottom (within 80px).
              // If they've scrolled up to read, don't force them back down.
              const isNearBottom = chatMessages.scrollHeight - chatMessages.scrollTop - chatMessages.clientHeight < 80;
              if (isNearBottom) {
                chatMessages.scrollTop = chatMessages.scrollHeight;
              }

              if (recCheckTimer) clearTimeout(recCheckTimer);
              recCheckTimer = setTimeout(() => {
                wireRecommendationButtons(msgEl);
              }, 500);
            }
          } catch (e) { /* skip malformed chunk line */ }
        }
      }
    }

    // Final update — persist the full response and do one final render + wire.
    assistantMsg.content = fullResponse;
    saveConversations();
    currentRenderNotePath = window._getCurrentNotePath ? window._getCurrentNotePath() : null;
    bubble.innerHTML = renderMarkdown(fullResponse);
    wireRecommendationButtons(msgEl);
    renderChatList();
  } catch (err) {
    if (err.name === "AbortError") {
      // Save partial response if we got anything; otherwise remove the empty
      // assistant message we created at the top.
      if (fullResponse) {
        assistantMsg.content = fullResponse + "\n\n⏹ *Generation stopped.*";
        saveConversations();
        currentRenderNotePath = window._getCurrentNotePath ? window._getCurrentNotePath() : null;
        bubble.innerHTML = renderMarkdown(fullResponse + "\n\n⏹ *Generation stopped.*");
        wireRecommendationButtons(msgEl);
      } else {
        chat.messages.pop(); // remove the empty assistant msg
        saveConversations();
        msgEl.remove();
        addMessage("assistant", "⏹ *Request cancelled.*");
      }
    } else {
      chat.messages.pop();
      saveConversations();
      msgEl.remove();
      addMessage("assistant", "❌ Connection error: " + err.message);
    }
  } finally {
    if (recCheckTimer) clearTimeout(recCheckTimer);
    isWaiting = false;
    currentAbortController = null;
    currentStreamReader = null;
    chatSendBtn.disabled = false;
    chatSendBtn.textContent = "➤";
    chatSendBtn.title = "Send";
    chatSendBtn.classList.remove("stop-state");
    chatInput.focus();
    renderChatList();
  }
}

// Cancel the current AI request (called when the stop button is clicked)
function cancelCurrentRequest() {
  // Abort the fetch (in case it's still connecting)
  if (currentAbortController) {
    currentAbortController.abort();
  }
  // Cancel the stream reader (in case we're already reading the body)
  if (currentStreamReader) {
    currentStreamReader.cancel().catch(() => {});
  }
}

async function clearChat() {
  const chat = getCurrentChat();
  chat.messages = [];
  chat.title = "New chat";
  saveConversations();
  renderChatMessages();
  renderChatList();
  try { await fetch(`/api/chat/${currentChatId}`, { method: "DELETE" }); } catch (e) {}
}

async function loadModels() {
  try {
    const res = await fetch("/api/chat/models");
    const data = await res.json();
    if (data.success && data.models) {
      availableModels = data.models;
      if (chatModelSelect) {
        chatModelSelect.innerHTML = "";
        for (const m of data.models) {
          const opt = document.createElement("option");
          opt.value = m.id;
          opt.textContent = `${m.id} — ⭐${m.rating} (${m.cost})`;
          if (m.id === currentModel) opt.selected = true;
          chatModelSelect.appendChild(opt);
        }
      }
    }
  } catch (e) { console.warn("Could not load models:", e); }
}

async function loadSkills() {
  try {
    const res = await fetch("/api/chat/skills");
    const data = await res.json();
    if (data.success && data.skills) {
      availableSkills = data.skills;
      // Restore saved active skills from localStorage
      const saved = localStorage.getItem("activeSkills");
      if (saved) {
        try { activeSkills = JSON.parse(saved); } catch (e) {}
      } else {
        activeSkills = data.defaults || ["usmle_explainer", "zero_error", "note_advisor"];
      }
      renderSkillsPanel();
    }
  } catch (e) { console.warn("Could not load skills:", e); }
}

function renderSkillsPanel() {
  const panel = document.getElementById("chatSkillsPanel");
  if (!panel) return;
  let html = '<div class="skills-panel-title">Active Skills</div>';
  for (const skill of availableSkills) {
    const isActive = activeSkills.includes(skill.id);
    const alwaysOn = skill.alwaysOn;
    // Skills with always_on=true are locked (can't be toggled off)
    // Skills with always_on="when_note_context" show a note that they're
    // auto-activated when a note is sent
    const isLocked = alwaysOn === true;
    const isAutoOnNote = alwaysOn === "when_note_context";
    const lockBadge = isLocked
      ? '<span class="skill-badge skill-badge-locked" title="This skill is always on">🔒 always</span>'
      : isAutoOnNote
      ? '<span class="skill-badge skill-badge-auto" title="Auto-activated when a note is sent as context">📎 auto</span>'
      : '';
    html += `
      <div class="skill-row${isLocked ? ' skill-locked' : ''}" data-id="${skill.id}">
        <label class="skill-toggle">
          <input type="checkbox" id="skill-${skill.id}" ${isActive || isLocked ? "checked" : ""} ${isLocked ? "disabled" : ""}>
          <span class="skill-name">${skill.name}</span>
          ${lockBadge}
        </label>
        <div class="skill-desc">${skill.description}</div>
      </div>
    `;
  }
  panel.innerHTML = html;
  // Wire up toggles (skip locked skills)
  for (const skill of availableSkills) {
    if (skill.alwaysOn === true) continue;  // can't toggle locked skills
    const cb = panel.querySelector(`#skill-${skill.id}`);
    if (cb) {
      cb.addEventListener("change", () => {
        if (cb.checked && !activeSkills.includes(skill.id)) {
          activeSkills.push(skill.id);
        } else if (!cb.checked) {
          activeSkills = activeSkills.filter(s => s !== skill.id);
        }
        localStorage.setItem("activeSkills", JSON.stringify(activeSkills));
      });
    }
  }
}

// ---- Chat panel resize (drag the left edge) ----
// Mirrors the sidebar resize logic in sidebar.js. The chat panel sits on the
// right edge of the screen; dragging the handle left widens the panel, right
// narrows it. Width is stored in localStorage and restored on load.
function setupChatResize() {
  if (!chatPanel) return;
  const handle = chatPanel.querySelector("#chatResizeHandle");
  if (!handle) return;

  let isResizing = false;
  let startX = 0;
  let startWidth = 0;

  handle.addEventListener("mousedown", (e) => {
    isResizing = true;
    startX = e.clientX;
    startWidth = chatPanel.offsetWidth;
    document.body.style.userSelect = "none";
    document.body.style.cursor = "col-resize";
    handle.classList.add("active");
    // Disable the slide transition while dragging so it doesn't lag
    chatPanel.style.transition = "none";
    document.addEventListener("mousemove", onMouseMove);
    document.addEventListener("mouseup", onMouseUp);
    e.preventDefault();
    e.stopPropagation();
  });

  // Touch support
  handle.addEventListener("touchstart", (e) => {
    if (e.touches.length !== 1) return;
    isResizing = true;
    startX = e.touches[0].clientX;
    startWidth = chatPanel.offsetWidth;
    handle.classList.add("active");
    chatPanel.style.transition = "none";
    document.addEventListener("touchmove", onTouchMove, { passive: false });
    document.addEventListener("touchend", onMouseUp);
    e.preventDefault();
    e.stopPropagation();
  }, { passive: false });

  function applyWidth(newWidth) {
    if (newWidth < 300) newWidth = 300;
    if (newWidth > 760) newWidth = 760;
    document.documentElement.style.setProperty("--chat-width", newWidth + "px");
  }

  function onMouseMove(e) {
    if (!isResizing) return;
    // Chat is on the right edge, so dragging left (delta negative) widens it.
    const delta = startX - e.clientX;
    applyWidth(startWidth + delta);
  }

  function onTouchMove(e) {
    if (!isResizing || e.touches.length !== 1) return;
    e.preventDefault();
    const delta = startX - e.touches[0].clientX;
    applyWidth(startWidth + delta);
  }

  function onMouseUp() {
    isResizing = false;
    document.body.style.userSelect = "";
    document.body.style.cursor = "";
    handle.classList.remove("active");
    chatPanel.style.transition = "";
    document.removeEventListener("mousemove", onMouseMove);
    document.removeEventListener("mouseup", onMouseUp);
    document.removeEventListener("touchmove", onTouchMove);
    document.removeEventListener("touchend", onMouseUp);
    const w = chatPanel.offsetWidth;
    if (w >= 300 && w <= 760) {
      localStorage.setItem("chatWidth", String(w));
    }
  }
}

export function setupChat() {
  if (chatPanel) return;

  loadConversations();

  // Don't auto-create a new chat on every page load — only create one if
  // there are no existing conversations.
  const ids = Object.keys(conversations);
  if (ids.length === 0) {
    createNewChat();
  } else {
    // Switch to the most recent conversation
    ids.sort((a, b) => (conversations[b].createdAt || 0) - (conversations[a].createdAt || 0));
    currentChatId = ids[0];
    sessionId = currentChatId;
  }

  chatPanel = document.createElement("div");
  chatPanel.id = "chat-panel";
  chatPanel.className = "chat-panel";
  chatPanel.innerHTML = `
    <div class="chat-resize-handle" id="chatResizeHandle" title="Drag to resize"></div>
    <div class="chat-header">
      <button id="chatListBtn" class="chat-header-btn" title="Chat history">☰</button>
      <span class="chat-title">🤖 AI Assistant</span>
      <div class="chat-header-buttons">
        <button id="chatClearBtn" class="chat-header-btn" title="Clear">🗑️</button>
        <button id="chatSkillsBtn" class="chat-header-btn" title="Skills">⚙️</button>
        <button id="chatCloseBtn" class="chat-header-btn" title="Close">✕</button>
      </div>
    </div>
    <div id="chatSkillsPanel" class="chat-skills-panel" style="display:none;"></div>
    <div class="chat-toolbar">
      <label class="chat-context-label" title="Send current note as context">
        <input type="checkbox" id="chatContextToggle" checked>
        <span>📎 Note</span>
      </label>
      <select id="chatModelSelect" class="chat-model-select" title="AI Model">
        <option value="meta/llama-3.3-70b-instruct">meta/llama-3.3-70b-instruct — ⭐4.5 (Low)</option>
      </select>
    </div>
    <div id="chatMessages" class="chat-messages"></div>
    <div class="chat-input-area">
      <textarea id="chatInput" class="chat-input" placeholder="Ask about your notes..." rows="1"></textarea>
      <button id="chatSendBtn" class="chat-send-btn">➤</button>
    </div>
  `;
  document.body.appendChild(chatPanel);

  // Restore saved chat width
  const savedWidth = localStorage.getItem("chatWidth");
  if (savedWidth) {
    const w = parseInt(savedWidth, 10);
    if (w >= 300 && w <= 760) {
      document.documentElement.style.setProperty("--chat-width", w + "px");
    }
  }
  setupChatResize();

  // Chat list panel (slide-in from left of chat panel)
  chatListPanel = document.createElement("div");
  chatListPanel.className = "chat-list-panel";
  chatListPanel.innerHTML = `
    <div class="chat-list-header">
      <button id="chatBackBtn" class="chat-header-btn" title="Back">←</button>
      <span>Conversations</span>
      <button id="chatNewBtn" class="chat-header-btn" title="New chat">➕</button>
    </div>
    <div class="chat-list-items"></div>
  `;
  chatPanel.appendChild(chatListPanel);

  chatMessages = chatPanel.querySelector("#chatMessages");
  chatInput = chatPanel.querySelector("#chatInput");
  chatSendBtn = chatPanel.querySelector("#chatSendBtn");
  chatClearBtn = chatPanel.querySelector("#chatClearBtn");
  chatContextToggle = chatPanel.querySelector("#chatContextToggle");
  chatModelSelect = chatPanel.querySelector("#chatModelSelect");
  chatListBtn = chatPanel.querySelector("#chatListBtn");
  chatNewBtn = chatListPanel.querySelector("#chatNewBtn");
  chatBackBtn = chatListPanel.querySelector("#chatBackBtn");

  renderChatMessages();

  // Send button: when not waiting, sends a message. When waiting (stop-state),
  // cancels the current AI request instead.
  chatSendBtn.addEventListener("click", () => {
    if (isWaiting) {
      cancelCurrentRequest();
    } else {
      sendMessage();
    }
  });
  chatInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendMessage(); }
  });
  chatInput.addEventListener("input", () => {
    chatInput.style.height = "auto";
    chatInput.style.height = Math.min(chatInput.scrollHeight, 120) + "px";
  });
  chatClearBtn.addEventListener("click", clearChat);
  chatPanel.querySelector("#chatCloseBtn").addEventListener("click", () => toggleChat(false));

  chatModelSelect.addEventListener("change", () => {
    currentModel = chatModelSelect.value;
    localStorage.setItem("chatModel", currentModel);
    const chat = getCurrentChat();
    chat.model = currentModel;
    saveConversations();
  });

  const savedModel = localStorage.getItem("chatModel");
  if (savedModel) { currentModel = savedModel; }

  // Chat list events
  chatListBtn.addEventListener("click", () => {
    chatListPanel.classList.toggle("open");
    renderChatList();
  });
  chatNewBtn.addEventListener("click", () => {
    createNewChat();
    renderChatMessages();
    renderChatList();
    chatListPanel.classList.remove("open");
  });
  chatBackBtn.addEventListener("click", () => {
    chatListPanel.classList.remove("open");
  });

  loadModels();
  loadSkills();

  // Skills button toggle
  const skillsBtn = chatPanel.querySelector("#chatSkillsBtn");
  if (skillsBtn) {
    skillsBtn.addEventListener("click", () => {
      const panel = document.getElementById("chatSkillsPanel");
      if (panel) panel.style.display = panel.style.display === "none" ? "block" : "none";
    });
  }

  // Toggle button in outline rail
  const rail = document.getElementById("outline-rail");
  if (rail) {
    const header = rail.querySelector(".outline-rail-header");
    if (header) {
      chatToggleBtn = document.createElement("button");
      chatToggleBtn.className = "outline-icon-btn chat-toggle-btn";
      chatToggleBtn.title = "AI Assistant";
      chatToggleBtn.innerHTML = `<i class="fas fa-comment-dots"></i>`;
      chatToggleBtn.addEventListener("click", () => toggleChat());
      const editBtn = header.querySelector("#outline-edit-btn");
      if (editBtn && editBtn.nextSibling) header.insertBefore(chatToggleBtn, editBtn.nextSibling);
      else header.appendChild(chatToggleBtn);
    }
  }

  // ---- Right-click context menu on note content ----
  setupNoteContextMenu();

  // ---- Re-activate dismissed recommendations when the user switches notes ----
  // Dismissals are session-only (stored in `dismissedRecs`, not localStorage).
  // When the user navigates to a different note, clear all dismissals so recs
  // become active again. We listen for "noteChanged" (dispatched by vault.js
  // AFTER navigation completes) — NOT "navigate" (which TRIGGERS navigation
  // and would fire before the note is actually loaded).
  document.addEventListener("noteChanged", () => {
    dismissedRecs.clear();
    document.querySelectorAll(".rec-card.dismissed").forEach(card => {
      card.classList.remove("dismissed");
      card.style.opacity = "";
      card.style.pointerEvents = "";
      const btn = card.querySelector(".rec-dismiss-btn");
      if (btn) btn.textContent = "\u2715 Dismiss";
    });
  });
}

function setupNoteContextMenu() {
  const main = document.getElementById("main");
  if (!main) return;

  main.addEventListener("contextmenu", (e) => {
    // Only show custom menu when text is selected
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return;
    const text = sel.toString().trim();
    if (!text || text.length < 2) return;

    e.preventDefault();

    // Create context menu
    const menu = document.createElement("div");
    menu.className = "note-context-menu";
    menu.innerHTML = `
      <div class="note-ctx-item" data-action="ask">🤖 Ask AI about this</div>
      <div class="note-ctx-item" data-action="add">💬 Add to chat</div>
    `;
    menu.style.left = e.clientX + "px";
    menu.style.top = e.clientY + "px";
    document.body.appendChild(menu);

    // Position adjustment
    const rect = menu.getBoundingClientRect();
    if (rect.right > window.innerWidth) {
      menu.style.left = (window.innerWidth - rect.width - 4) + "px";
    }
    if (rect.bottom > window.innerHeight) {
      menu.style.top = (window.innerHeight - rect.height - 4) + "px";
    }

    menu.querySelectorAll(".note-ctx-item").forEach(item => {
      item.addEventListener("click", () => {
        const action = item.dataset.action;
        menu.remove();
        const selectedText = text;

        // Open chat if not open
        if (!isOpen) toggleChat(true);

        if (action === "ask") {
          // Send immediately with the selected text
          setTimeout(() => {
            sendMessage(`Explain this:\n\n${selectedText}`);
          }, 300);
        } else if (action === "add") {
          // Add as context (put in input box for the user to add their question)
          chatInput.value = `[Selected text from note]:\n${selectedText}\n\n`;
          chatInput.focus();
          chatInput.setSelectionRange(chatInput.value.length, chatInput.value.length);
          chatInput.style.height = "auto";
          chatInput.style.height = Math.min(chatInput.scrollHeight, 120) + "px";
        }
      });
    });

    // Remove on click elsewhere
    setTimeout(() => {
      document.addEventListener("click", function removeMenu() {
        menu.remove();
        document.removeEventListener("click", removeMenu);
      });
    }, 0);
  });
}

export function toggleChat(forceOpen) {
  if (forceOpen === undefined) isOpen = !isOpen;
  else isOpen = forceOpen;
  if (chatPanel) chatPanel.classList.toggle("open", isOpen);
  if (isOpen) setTimeout(() => chatInput && chatInput.focus(), 300);
}
