// (serverAssets/routes/chat.js) AI chat using NVIDIA API with modular skills.
// Skills can be toggled on/off from the frontend. The system prompt is built
// dynamically from whichever skills are active.

const express = require("express");
const router = express.Router();
const fs = require("fs");
const path = require("path");

function getApiKey() {
  try {
    const configPath = path.join(__dirname, "..", "..", "config.json");
    const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
    return config.nvidiaApiKey || "";
  } catch (e) { return ""; }
}

const API_BASE = "https://integrate.api.nvidia.com/v1";
const DEFAULT_MODEL = "meta/llama-3.3-70b-instruct";

const CURATED_MODELS = [
  { id: "nvidia/llama-3.1-nemotron-ultra-253b-v1", rating: 5.0, cost: "High", desc: "NVIDIA's largest, most capable model" },
  { id: "nvidia/llama-3.3-nemotron-super-49b-v1.5", rating: 4.8, cost: "Medium", desc: "Best balance of speed and intelligence" },
  { id: "meta/llama-3.3-70b-instruct", rating: 4.5, cost: "Low", desc: "Meta's flagship 70B — fast and smart" },
  { id: "nvidia/llama-3.1-nemotron-70b-instruct", rating: 4.5, cost: "Low", desc: "NVIDIA-tuned Llama 70B" },
  { id: "mistralai/mistral-large-3-675b-instruct-2512", rating: 4.4, cost: "High", desc: "Mistral's largest model" },
  { id: "qwen/qwen3.5-397b-a17b", rating: 4.3, cost: "High", desc: "Qwen's flagship — great for reasoning" },
  { id: "deepseek-ai/deepseek-v4-pro", rating: 4.2, cost: "Medium", desc: "DeepSeek's pro model" },
  { id: "mistralai/mistral-medium-3.5-128b", rating: 4.0, cost: "Medium", desc: "Solid all-around performer" },
  { id: "meta/llama-3.1-8b-instruct", rating: 3.5, cost: "Free", desc: "Fast, lightweight, great for quick Q&A" },
  { id: "google/gemma-3-12b-it", rating: 3.8, cost: "Free", desc: "Google's compact model" },
];

// ======================================================
//  MODULAR SKILLS — loaded from /skills/*.md files
// ======================================================
// Each skill is a markdown file with YAML frontmatter:
//   ---
//   id: skill_id
//   name: Display Name
//   description: Short description
//   default_active: true          (optional, default false)
//   always_on: false              (optional: false | true | "when_note_context")
//   ---
//   (prompt content — everything after the frontmatter)
//
// To add a new skill, just drop a .md file into the skills/ folder.
// It will be automatically loaded on server start (and when the folder
// is changed — see the watcher below).

const SKILLS_DIR = path.join(__dirname, "..", "..", "skills");
let SKILLS = {};           // id -> { id, name, description, content, defaultActive, alwaysOn }
let DEFAULT_ACTIVE = [];   // array of skill ids that are on by default

function parseFrontmatter(text) {
  // Simple YAML frontmatter parser (handles key: value lines between --- markers)
  const fmMatch = text.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!fmMatch) return { meta: {}, body: text };
  const metaBlock = fmMatch[1];
  const body = fmMatch[2];
  const meta = {};
  for (const line of metaBlock.split("\n")) {
    const m = line.match(/^(\w+):\s*(.*)$/);
    if (m) {
      let val = m[2].trim();
      // Strip surrounding quotes
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      // Parse booleans
      if (val === "true") val = true;
      else if (val === "false") val = false;
      meta[m[1]] = val;
    }
  }
  return { meta, body };
}

function loadSkills() {
  const newSkills = {};
  const newDefaults = [];
  try {
    if (!fs.existsSync(SKILLS_DIR)) {
      console.warn(`⚠️  Skills directory not found: ${SKILLS_DIR}`);
      SKILLS = {};
      DEFAULT_ACTIVE = [];
      return;
    }
    const files = fs.readdirSync(SKILLS_DIR).filter(f => f.endsWith(".md"));
    for (const file of files) {
      try {
        const filePath = path.join(SKILLS_DIR, file);
        const text = fs.readFileSync(filePath, "utf8");
        const { meta, body } = parseFrontmatter(text);
        const id = meta.id || file.replace(/\.md$/, "");
        const skill = {
          id,
          name: meta.name || id,
          description: meta.description || "",
          content: body.trim(),
          defaultActive: meta.default_active === true,
          alwaysOn: meta.always_on,  // false | true | "when_note_context"
          file,  // for debugging
        };
        newSkills[id] = skill;
        if (skill.defaultActive) newDefaults.push(id);
        console.log(`  ✓ Loaded skill: ${id} (${file})`);
      } catch (e) {
        console.error(`  ✗ Failed to load skill ${file}:`, e.message);
      }
    }
  } catch (e) {
    console.error("Failed to scan skills directory:", e.message);
  }
  SKILLS = newSkills;
  DEFAULT_ACTIVE = newDefaults;
  console.log(`📚 Loaded ${Object.keys(SKILLS).length} skills from /skills (${DEFAULT_ACTIVE.length} active by default)`);
}

// Load skills on startup
loadSkills();

// Watch the skills folder for changes — auto-reload when files are
// added, removed, or edited. This means you can drop a new skill .md
// file into the folder and it immediately appears on the website
// without restarting the server.
try {
  if (fs.existsSync(SKILLS_DIR)) {
    fs.watch(SKILLS_DIR, { recursive: false }, (eventType, filename) => {
      if (!filename || !filename.endsWith(".md")) return;
      console.log(`📁 Skills folder changed (${eventType}: ${filename}) — reloading skills...`);
      // Small delay so the file write completes before we read
      setTimeout(loadSkills, 100);
    });
  }
} catch (e) {
  console.warn("Could not watch skills folder:", e.message);
}

// Per-session active skills (stored in memory)
const sessionSkills = new Map();

function getActiveSkills(sessionId) {
  if (sessionSkills.has(sessionId)) {
    return sessionSkills.get(sessionId);
  }
  return [...DEFAULT_ACTIVE];
}

// Build the system prompt from active skills.
// If `hasNoteContext` is true, skills with always_on="when_note_context"
// are force-included even if the user toggled them off.
function buildSystemPrompt(activeSkillIds, hasNoteContext) {
  // Start with the user's active skills
  const ids = [...activeSkillIds];
  // Force-include "when_note_context" skills if note context is present
  for (const id of Object.keys(SKILLS)) {
    const skill = SKILLS[id];
    if (skill.alwaysOn === "when_note_context" && hasNoteContext && !ids.includes(id)) {
      ids.push(id);
    }
  }
  // Also force-include always_on=true skills (unconditional)
  for (const id of Object.keys(SKILLS)) {
    const skill = SKILLS[id];
    if (skill.alwaysOn === true && !ids.includes(id)) {
      ids.push(id);
    }
  }

  let prompt = "";
  for (const id of ids) {
    if (SKILLS[id]) {
      prompt += SKILLS[id].content + "\n\n";
    }
  }
  prompt += "You are integrated into an Obsidian note viewer. The user is reading their notes and asking you questions. Use markdown formatting in your responses.";
  return prompt;
}

const conversations = new Map();
const MAX_MESSAGES = 20;

router.post("/chat", async (req, res) => {
  try {
    const { message, sessionId, noteContext, selectedText, model, skills, notePath } = req.body;

    if (!message || !message.trim()) {
      return res.status(400).json({ success: false, error: "Message is required" });
    }

    const apiKey = getApiKey();
    if (!apiKey) {
      return res.status(500).json({ success: false, error: "NVIDIA API key not found. Add 'nvidiaApiKey' to config.json" });
    }

    // Update active skills for this session if provided
    const sid = sessionId || "default";
    if (skills && Array.isArray(skills)) {
      sessionSkills.set(sid, skills);
    }
    const activeSkills = getActiveSkills(sid);

    const useModel = model || DEFAULT_MODEL;

    // Build system prompt from active skills.
    // If note context is present, "when_note_context" skills (like
    // note_advisor) are force-included even if the user toggled them off.
    const hasNoteContext = !!(noteContext && noteContext.trim());
    let systemPrompt = buildSystemPrompt(activeSkills, hasNoteContext);

    if (hasNoteContext) {
      const truncated = noteContext.length > 6000
        ? noteContext.substring(0, 6000) + "\n\n[... note truncated ...]"
        : noteContext;
      const noteTitle = notePath ? notePath.replace(/\\/g, '/').split('/').pop() : "Untitled";
      systemPrompt += `\n\nNOTE TITLE: ${noteTitle}\nThe user is currently viewing a note titled "${noteTitle}". Here is the note content:\n\n${truncated}`;
    }

    if (selectedText && selectedText.trim()) {
      systemPrompt += `\n\nThe user has selected this text and wants to ask about it:\n\n"${selectedText.substring(0, 2000)}"`;
    }

    let history = conversations.get(sid);
    if (!history) { history = []; conversations.set(sid, history); }
    history.push({ role: "user", content: message });
    if (history.length > MAX_MESSAGES) {
      history = history.slice(-(MAX_MESSAGES));
      conversations.set(sid, history);
    }

    console.log(`Chat: model=${useModel}, skills=[${activeSkills.join(",")}]`);

    // ---- Call NVIDIA with automatic model fallback ----
    // If the primary model returns 404 (model rotated/deprecated) or other
    // 4xx/5xx, we retry with the next curated model. The user sees a clean
    // human-readable error only if ALL fallbacks fail.
    const triedModels = new Set();
    const modelQueue = [useModel, ...CURATED_MODELS.map(m => m.id).filter(id => id !== useModel)];

    let apiResponse = null;
    let responseText = "";
    let lastStatus = 0;
    let lastErrorBody = "";

    for (const candidateModel of modelQueue) {
      if (triedModels.has(candidateModel)) continue;
      triedModels.add(candidateModel);
      try {
        const r = await fetch(`${API_BASE}/chat/completions`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${apiKey}`,
          },
          body: JSON.stringify({
            model: candidateModel,
            max_tokens: 4096,
            messages: [
              { role: "system", content: systemPrompt },
              ...history,
            ],
          }),
        });
        lastStatus = r.status;
        responseText = await r.text();
        if (r.ok) {
          apiResponse = r;
          if (candidateModel !== useModel) {
            console.log(`Chat: fell back to model=${candidateModel} (primary ${useModel} failed with ${lastStatus})`);
          }
          break;
        }
        lastErrorBody = responseText.substring(0, 200);
        // 401/403 = auth issue — don't bother trying other models, fail fast
        if (lastStatus === 401 || lastStatus === 403) break;
        // Otherwise (404 model-not-found, 429 rate-limit, 5xx server) try next model
        console.warn(`Chat: model ${candidateModel} returned ${lastStatus}, trying next...`);
      } catch (netErr) {
        // Network error — try next model
        console.warn(`Chat: model ${candidateModel} network error: ${netErr.message}`);
        lastErrorBody = netErr.message;
      }
    }

    if (!apiResponse) {
      // All models failed — produce a human-readable error
      let friendly;
      if (lastStatus === 401 || lastStatus === 403) {
        friendly = "Authentication failed — your NVIDIA API key may be invalid or expired. Check the 'nvidiaApiKey' in config.json.";
      } else if (lastStatus === 404) {
        friendly = `The AI model is currently unavailable on NVIDIA's side (model was rotated or deprecated). Tried ${triedModels.size} models — all returned 404. Try selecting a different model from the dropdown, or check https://build.nvidia.com for current model names.`;
      } else if (lastStatus === 429) {
        friendly = "Rate limit hit on NVIDIA API. Wait a moment and try again.";
      } else if (lastStatus >= 500) {
        friendly = `NVIDIA API server error (${lastStatus}). Their side is having issues — try again in a moment.`;
      } else {
        friendly = `Chat request failed (status ${lastStatus}). ${lastErrorBody}`;
      }
      throw new Error(friendly);
    }

    const data = JSON.parse(responseText);
    const aiResponse = data.choices?.[0]?.message?.content || "";

    if (!aiResponse) {
      throw new Error("Empty response from AI: " + JSON.stringify(data).substring(0, 200));
    }

    history.push({ role: "assistant", content: aiResponse });

    res.json({ success: true, response: aiResponse, messageCount: history.length });
  } catch (err) {
    console.error("Chat error:", err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ======================================================
//  STREAMING CHAT — POST /api/chat/stream
// ======================================================
// Same behavior as /chat, but streams the AI response to the client as
// Server-Sent Events (SSE) chunks. The existing /chat endpoint is kept
// unchanged for backward compatibility (and for the quiz flow, which
// doesn't need streaming).
//
// Wire format (one SSE `data:` line per event, blank line separates):
//   data: {"chunk":"<delta text>"}\n\n     → append to displayed message
//   data: {"error":"<message>"}\n\n        → fatal error, stream ends
//   data: [DONE]\n\n                       → end of stream (success)
//
// Client reads via fetch() + response.body.getReader() + TextDecoder,
// splitting on "\n\n" to recover each SSE event.
router.post("/chat/stream", async (req, res) => {
  try {
    const { message, sessionId, noteContext, selectedText, model, skills, notePath } = req.body;

    if (!message || !message.trim()) {
      res.status(400).json({ success: false, error: "Message is required" });
      return;
    }

    const apiKey = getApiKey();
    if (!apiKey) {
      res.status(500).json({ success: false, error: "NVIDIA API key not found. Add 'nvidiaApiKey' to config.json" });
      return;
    }

    // Update active skills for this session if provided
    const sid = sessionId || "default";
    if (skills && Array.isArray(skills)) {
      sessionSkills.set(sid, skills);
    }
    const activeSkills = getActiveSkills(sid);

    const useModel = model || DEFAULT_MODEL;
    const hasNoteContext = !!(noteContext && noteContext.trim());
    let systemPrompt = buildSystemPrompt(activeSkills, hasNoteContext);

    if (hasNoteContext) {
      const truncated = noteContext.length > 6000
        ? noteContext.substring(0, 6000) + "\n\n[... note truncated ...]"
        : noteContext;
      const noteTitle = notePath ? notePath.replace(/\\/g, '/').split('/').pop() : "Untitled";
      systemPrompt += `\n\nNOTE TITLE: ${noteTitle}\nThe user is currently viewing a note titled "${noteTitle}". Here is the note content:\n\n${truncated}`;
    }

    if (selectedText && selectedText.trim()) {
      systemPrompt += `\n\nThe user has selected this text and wants to ask about it:\n\n"${selectedText.substring(0, 2000)}"`;
    }

    let history = conversations.get(sid);
    if (!history) { history = []; conversations.set(sid, history); }

    console.log(`Chat stream: model=${useModel}, skills=[${activeSkills.join(",")}]`);

    // Set up SSE headers BEFORE the fetch so the client knows it's a stream.
    // Disable any proxy/compression buffering so chunks flush immediately.
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no"); // disable nginx buffering
    res.flushHeaders();

    // Build the outgoing messages once. We DON'T push to history yet —
    // only after the full response is assembled, so a failed/aborted
    // stream doesn't leave an orphan user message.
    const outgoingMessages = [
      { role: "system", content: systemPrompt },
      ...history,
      { role: "user", content: message },
    ];

    // Send to NVIDIA with streaming enabled. We do a single attempt on
    // the requested model — streaming + multi-model fallback is awkward
    // (you can't swap models mid-stream), and a non-ok response means we
    // haven't started streaming yet, so we can surface a clean error.
    const apiResponse = await fetch(`${API_BASE}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: useModel,
        max_tokens: 4096,
        stream: true,
        messages: outgoingMessages,
      }),
    });

    if (!apiResponse.ok) {
      let errText = "";
      try { errText = await apiResponse.text(); } catch (e) { errText = ""; }
      let friendly = errText.substring(0, 200);
      if (apiResponse.status === 401 || apiResponse.status === 403) {
        friendly = "Authentication failed — your NVIDIA API key may be invalid or expired. Check the 'nvidiaApiKey' in config.json.";
      } else if (apiResponse.status === 404) {
        friendly = `Model '${useModel}' is currently unavailable on NVIDIA's side (rotated or deprecated). Try selecting a different model from the dropdown.`;
      } else if (apiResponse.status === 429) {
        friendly = "Rate limit hit on NVIDIA API. Wait a moment and try again.";
      } else if (apiResponse.status >= 500) {
        friendly = `NVIDIA API server error (${apiResponse.status}). Their side is having issues — try again in a moment.`;
      }
      res.write(`data: ${JSON.stringify({ error: friendly })}\n\n`);
      res.write("data: [DONE]\n\n");
      res.end();
      return;
    }

    if (!apiResponse.body) {
      // Shouldn't happen with a 200, but guard anyway.
      res.write(`data: ${JSON.stringify({ error: "No response body from NVIDIA API." })}\n\n`);
      res.write("data: [DONE]\n\n");
      res.end();
      return;
    }

    // Read the streaming response from NVIDIA and forward chunks to the
    // client. NVIDIA sends standard OpenAI-style SSE: lines starting with
    // "data: " containing JSON, terminated by a "data: [DONE]" line.
    const reader = apiResponse.body.getReader();
    const decoder = new TextDecoder();
    let fullResponse = "";
    let buffer = "";
    let clientClosed = false;

    // Timeout watchdog: if no data arrives within 30 seconds, abort.
    // Some NVIDIA models hang without responding — we need to detect this
    // and return an error instead of leaving the chat stuck forever.
    const STREAM_TIMEOUT_MS = 30000;
    let watchdogTimer = setTimeout(() => {
      console.warn(`Chat stream timeout: no data for ${STREAM_TIMEOUT_MS / 1000}s, aborting`);
      try { reader.cancel(); } catch (e) {}
    }, STREAM_TIMEOUT_MS);

    // Reset the watchdog each time we receive data.
    const resetWatchdog = () => {
      if (watchdogTimer) clearTimeout(watchdogTimer);
      watchdogTimer = setTimeout(() => {
        console.warn(`Chat stream timeout: no data for ${STREAM_TIMEOUT_MS / 1000}s, aborting`);
        try { reader.cancel(); } catch (e) {}
      }, STREAM_TIMEOUT_MS);
    };

    req.on("close", () => {
      clientClosed = true;
      if (watchdogTimer) clearTimeout(watchdogTimer);
      try { reader.cancel(); } catch (e) {}
    });

    try {
      while (true) {
        if (clientClosed) break;
        const { done, value } = await reader.read();
        if (done) break;

        // Reset the watchdog — we got data, the model is alive
        resetWatchdog();

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop();

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || !trimmed.startsWith("data:")) continue;
          const data = trimmed.slice(5).trim();
          if (data === "[DONE]") {
            res.write("data: [DONE]\n\n");
            continue;
          }
          try {
            const parsed = JSON.parse(data);
            const delta = parsed.choices?.[0]?.delta?.content || "";
            if (delta) {
              fullResponse += delta;
              res.write(`data: ${JSON.stringify({ chunk: delta })}\n\n`);
            }
          } catch (e) { /* skip malformed */ }
        }
      }
    } catch (streamErr) {
      // If we timed out (reader was cancelled by the watchdog), send a
      // friendly error instead of the raw cancellation message.
      if (fullResponse.trim()) {
        // We got partial data — save what we have and note the timeout
        res.write(`data: ${JSON.stringify({ chunk: "\n\n⏱️ *Response timed out — the model stopped responding. Partial response shown above.*" })}\n\n`);
      } else {
        res.write(`data: ${JSON.stringify({ error: "The AI model timed out (no response for 30 seconds). Try selecting a different model from the dropdown." })}\n\n`);
      }
      console.error("Chat stream error:", streamErr.message);
    } finally {
      if (watchdogTimer) clearTimeout(watchdogTimer);
    }

    // Persist to conversation history only if we got something useful.
    if (fullResponse.trim()) {
      history.push({ role: "user", content: message });
      history.push({ role: "assistant", content: fullResponse });
      if (history.length > MAX_MESSAGES) {
        history = history.slice(-MAX_MESSAGES);
        conversations.set(sid, history);
      }
    }

    // Final terminator (idempotent if [DONE] was already sent inline).
    try { res.write("data: [DONE]\n\n"); } catch (e) {}
    res.end();
  } catch (err) {
    console.error("Chat stream error:", err.message);
    // Headers may or may not have been sent yet — handle both.
    if (!res.headersSent) {
      res.status(500).json({ success: false, error: err.message });
    } else {
      try {
        res.write(`data: ${JSON.stringify({ error: err.message })}\n\n`);
        res.write("data: [DONE]\n\n");
      } catch (e) {}
      res.end();
    }
  }
});

// Return available skills (metadata only — content is never sent to the client)
router.get("/chat/skills", (req, res) => {
  const skills = Object.entries(SKILLS).map(([id, skill]) => ({
    id,
    name: skill.name,
    description: skill.description,
    alwaysOn: skill.alwaysOn || false,  // false | true | "when_note_context"
  }));
  res.json({ success: true, skills, defaults: DEFAULT_ACTIVE });
});

// Return curated models
router.get("/chat/models", (req, res) => {
  res.json({ success: true, models: CURATED_MODELS });
});

router.delete("/chat/:sessionId", (req, res) => {
  conversations.delete(req.params.sessionId || "default");
  sessionSkills.delete(req.params.sessionId || "default");
  res.json({ success: true });
});

router.delete("/chat", (req, res) => {
  conversations.clear();
  sessionSkills.clear();
  res.json({ success: true });
});

// ======================================================
//  AI QUIZ MODE — generate USMLE-style MCQs from a note
// ======================================================
// POST /api/quiz/generate
//   body: { noteContext, noteTitle, count, model }
//   returns: { success, questions: [{ question, options: [4], correctIndex, explanation }] }
//
// POST /api/quiz/save
//   body: { notePath, noteTitle, questions }
//   Saves questions to data/quiz_bank.json for the practice question bank
//
// GET /api/quiz/bank
//   returns: { success, questions: [...] }
//
// DELETE /api/quiz/:id
//   removes a single question from the bank

const quizBankPath = path.join(__dirname, "..", "..", "data", "quiz_bank.json");

function loadQuizBank() {
  try {
    if (fs.existsSync(quizBankPath)) {
      return JSON.parse(fs.readFileSync(quizBankPath, "utf8"));
    }
  } catch (e) { console.error("Failed to load quiz bank:", e.message); }
  return { questions: [] };
}

function saveQuizBank(bank) {
  try {
    const dataDir = path.dirname(quizBankPath);
    if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(quizBankPath, JSON.stringify(bank, null, 2));
  } catch (e) { console.error("Failed to save quiz bank:", e.message); }
}

router.post("/quiz/generate", async (req, res) => {
  try {
    const { noteContext, noteTitle, count, model } = req.body;
    if (!noteContext || !noteContext.trim()) {
      return res.status(400).json({ success: false, error: "noteContext is required" });
    }

    const apiKey = getApiKey();
    if (!apiKey) {
      return res.status(500).json({ success: false, error: "NVIDIA API key not found." });
    }

    const useModel = model || DEFAULT_MODEL;
    const numQuestions = Math.min(10, Math.max(1, count || 5));

    const truncated = noteContext.length > 8000
      ? noteContext.substring(0, 8000) + "\n\n[... note truncated ...]"
      : noteContext;

    const prompt = `You are a USMLE exam question writer. Based on the following note content, generate ${numQuestions} multiple-choice questions that test the key concepts.

NOTE TITLE: ${noteTitle || "Untitled"}
NOTE CONTENT:
${truncated}

CRITICAL: You must respond with ONLY a valid JSON array. No markdown, no code fences, no explanations before or after. The response must be parseable by JSON.parse() directly.

Each question must be an object with this exact structure:
{
  "question": "The full question text here?",
  "options": ["Option A", "Option B", "Option C", "Option D"],
  "correctIndex": 0,
  "explanation": "Why the correct answer is correct and why the others are wrong.",
  "topic": "A short topic tag (e.g., 'Immunology', 'Pharmacology')"
}

Requirements:
- Exactly 4 options per question
- correctIndex is 0-3 (the index of the correct option in the options array)
- Questions should be USMLE-style (clinical vignettes, second-order reasoning)
- Explanations should be concise but thorough
- Mix of Step 1 (mechanism) and Step 2 (clinical) style as appropriate
- Test high-yield concepts from the note

Respond with ONLY the JSON array. Start with [ and end with ]. No other text.`;

    // Try the primary model, fall back if needed
    let apiResponse = null;
    let responseText = "";
    const triedModels = new Set();
    const modelQueue = [useModel, ...CURATED_MODELS.map(m => m.id).filter(id => id !== useModel)];

    for (const candidateModel of modelQueue) {
      if (triedModels.has(candidateModel)) continue;
      triedModels.add(candidateModel);
      try {
        const r = await fetch(`${API_BASE}/chat/completions`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${apiKey}`,
          },
          body: JSON.stringify({
            model: candidateModel,
            max_tokens: 4096,
            messages: [
              { role: "system", content: "You are a JSON-only API. Respond with valid JSON only." },
              { role: "user", content: prompt },
            ],
          }),
        });
        const text = await r.text();
        if (r.ok) {
          apiResponse = r;
          responseText = text;
          break;
        }
        if (r.status === 401 || r.status === 403) break;
      } catch (e) { /* try next */ }
    }

    if (!apiResponse) {
      return res.status(500).json({ success: false, error: "Failed to generate quiz. AI service unavailable." });
    }

    const data = JSON.parse(responseText);
    let aiText = data.choices?.[0]?.message?.content || "";

    // Strip markdown code fences if present
    aiText = aiText.replace(/```json\s*/gi, "").replace(/```\s*/g, "").trim();

    // Extract the JSON array (find first [ and last ])
    const start = aiText.indexOf("[");
    const end = aiText.lastIndexOf("]");
    if (start === -1 || end === -1) {
      return res.status(500).json({ success: false, error: "AI response was not valid JSON.", raw: aiText.substring(0, 500) });
    }

    const jsonStr = aiText.substring(start, end + 1);
    const questions = JSON.parse(jsonStr);

    // Validate structure
    const validQuestions = questions.filter(q =>
      q.question && Array.isArray(q.options) && q.options.length === 4 &&
      typeof q.correctIndex === "number" && q.correctIndex >= 0 && q.correctIndex <= 3
    );

    if (validQuestions.length === 0) {
      return res.status(500).json({ success: false, error: "AI generated no valid questions." });
    }

    res.json({ success: true, questions: validQuestions });
  } catch (err) {
    console.error("Quiz generate error:", err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

router.post("/quiz/save", (req, res) => {
  try {
    const { notePath, noteTitle, questions } = req.body;
    if (!questions || !Array.isArray(questions)) {
      return res.status(400).json({ success: false, error: "questions array is required" });
    }

    const bank = loadQuizBank();
    const timestamp = Date.now();

    for (const q of questions) {
      bank.questions.push({
        id: "q-" + timestamp + "-" + Math.random().toString(36).slice(2, 8),
        ...q,
        notePath: notePath || null,
        noteTitle: noteTitle || null,
        createdAt: timestamp,
        lastReviewed: null,
        timesAnswered: 0,
        timesCorrect: 0,
        source: q.source || "ai", // "ai" or "manual"
      });
    }

    saveQuizBank(bank);
    res.json({ success: true, count: questions.length, total: bank.questions.length });
  } catch (err) {
    console.error("Quiz save error:", err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Add a single question manually
router.post("/quiz/add", (req, res) => {
  try {
    const { question, options, correctIndex, explanation, topic, notePath, noteTitle } = req.body;
    if (!question || !Array.isArray(options) || options.length !== 4 || typeof correctIndex !== "number") {
      return res.status(400).json({ success: false, error: "question, options (array of 4), and correctIndex are required" });
    }

    const bank = loadQuizBank();
    const timestamp = Date.now();
    const q = {
      id: "q-" + timestamp + "-" + Math.random().toString(36).slice(2, 8),
      question,
      options,
      correctIndex,
      explanation: explanation || "",
      topic: topic || "General",
      notePath: notePath || null,
      noteTitle: noteTitle || null,
      createdAt: timestamp,
      lastReviewed: null,
      timesAnswered: 0,
      timesCorrect: 0,
      source: "manual",
    };
    bank.questions.push(q);
    saveQuizBank(bank);
    res.json({ success: true, question: q, total: bank.questions.length });
  } catch (err) {
    console.error("Quiz add error:", err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

router.get("/quiz/bank", (req, res) => {
  try {
    const bank = loadQuizBank();
    res.json({ success: true, questions: bank.questions });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.delete("/quiz/:id", (req, res) => {
  try {
    const bank = loadQuizBank();
    const before = bank.questions.length;
    bank.questions = bank.questions.filter(q => q.id !== req.params.id);
    const after = bank.questions.length;
    saveQuizBank(bank);
    res.json({ success: true, removed: before - after });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Update quiz question stats (after answering)
router.post("/quiz/:id/answer", (req, res) => {
  try {
    const { correct } = req.body;
    const bank = loadQuizBank();
    const q = bank.questions.find(q => q.id === req.params.id);
    if (!q) return res.status(404).json({ success: false, error: "Question not found" });
    q.timesAnswered = (q.timesAnswered || 0) + 1;
    if (correct) q.timesCorrect = (q.timesCorrect || 0) + 1;
    q.lastReviewed = Date.now();
    saveQuizBank(bank);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
