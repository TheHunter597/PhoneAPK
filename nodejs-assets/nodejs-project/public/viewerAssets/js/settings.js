// ======================================================
//  SETTINGS: APPLY FUNCTIONS (js/settings.js)
// ======================================================
import {
  loadShortcuts,
  getShortcut,
  setShortcut,
  parseKeyEvent,
  getActionFromKeyCombination,
} from "./shortcuts.js";

// ---- Image alignment helpers ----
const IMAGE_ALIGN_KEY = "imageAlignment";
const DEFAULT_ALIGN = "left";

export function getImageAlignment() {
  return localStorage.getItem(IMAGE_ALIGN_KEY) || DEFAULT_ALIGN;
}

export function applyImageAlignment() {
  const align = getImageAlignment();
  const containers = document.querySelectorAll(
    ".note-content, .editable-content",
  );
  containers.forEach((container) => {
    // Remove all alignment classes
    container.classList.remove(
      "img-align-left",
      "img-align-right",
      "img-align-center",
    );
    container.classList.add(`img-align-${align}`);
  });
}

// ---- Export apply functions ----
export function applyEmbedSettings() {
  const width = document.getElementById("embedWidthSlider").value + "%";
  const height = document.getElementById("embedHeightSlider").value + "px";
  document.querySelectorAll(".html-embed-container").forEach((c) => {
    c.style.width = width;
  });
  document.querySelectorAll(".html-embed-iframe").forEach((f) => {
    f.style.height = height;
  });
}

export function applyFontSettings() {
  const family = document.getElementById("fontFamilySelect").value;
  const weight = document.getElementById("fontWeightSlider").value;
  const size = document.getElementById("fontSizeSlider").value + "px";
  const contentDiv = document.querySelector(".note-content");
  if (contentDiv) {
    contentDiv.style.fontFamily = family;
    contentDiv.style.fontWeight = weight;
    contentDiv.style.fontSize = size;
  }
  const editable = document.querySelector(".editable-content");
  if (editable) {
    editable.style.fontFamily = family;
    editable.style.fontWeight = weight;
    editable.style.fontSize = size;
  }
}

let recordingActive = false;

export function renderShortcutSettings() {
  const container = document.getElementById("shortcuts-list");
  if (!container) return;
  const actions = {
    nextTab: "Next Tab",
    prevTab: "Previous Tab",
    closeTab: "Close Tab",
    saveNote: "Save Note",
    toggleEditMode: "Toggle Edit / View Mode",
    focusMode: "Focus Mode (Fullscreen)",
  };
  let html = "";
  for (const [action, label] of Object.entries(actions)) {
    const shortcut = getShortcut(action) || "Not set";
    html += `
      <div class="shortcut-row" data-action="${action}">
        <span class="shortcut-label">${label}</span>
        <span class="shortcut-key" id="shortcut-${action}">${shortcut}</span>
        <button class="shortcut-record-btn" data-action="${action}" ${recordingActive ? "disabled" : ""}>Record</button>
      </div>
    `;
  }
  container.innerHTML = html;

  container.querySelectorAll(".shortcut-record-btn").forEach((btn) => {
    btn.addEventListener("click", function (e) {
      if (recordingActive) return;
      const action = this.dataset.action;
      startRecording(action);
    });
  });
}

let recordingAction = null;
let recordingTimeout = null;

function startRecording(action) {
  if (recordingActive) return;
  recordingActive = true;
  document
    .querySelectorAll(".shortcut-record-btn")
    .forEach((b) => (b.disabled = true));

  if (recordingTimeout) clearTimeout(recordingTimeout);
  const keySpan = document.getElementById(`shortcut-${action}`);
  if (keySpan) keySpan.textContent = "Press keys...";
  recordingAction = action;

  const listener = function (e) {
    e.preventDefault();
    const combo = parseKeyEvent(e);
    if (combo) {
      const existingAction = getActionFromKeyCombination(combo);
      if (existingAction && existingAction !== action) {
        window.showErrorModal(
          "Shortcut Already Assigned",
          `Shortcut "${combo}" is already assigned to "${existingAction}". Please choose another.`,
        );
        resetRecording(action);
        return;
      }
      setShortcut(action, combo);
      recordingActive = false;
      document.removeEventListener("keydown", listener);
      renderShortcutSettings();
      return;
    }
  };
  document.addEventListener("keydown", listener);
  recordingTimeout = setTimeout(() => {
    document.removeEventListener("keydown", listener);
    resetRecording(action);
  }, 5000);
}

function resetRecording(action) {
  recordingActive = false;
  const shortcut = getShortcut(action) || "Not set";
  const keySpan = document.getElementById(`shortcut-${action}`);
  if (keySpan) keySpan.textContent = shortcut;
  recordingAction = null;
  if (recordingTimeout) clearTimeout(recordingTimeout);
  document
    .querySelectorAll(".shortcut-record-btn")
    .forEach((b) => (b.disabled = false));
}

export function setupSettings() {
  const settingsToggle = document.getElementById("settings-toggle");
  const settingsPanel = document.getElementById("settings-panel");

  // The settings-toggle button now lives in the outline rail (outline.js
  // attaches its own click handler). settingsToggle may be null here.
  if (settingsToggle) {
    settingsToggle.addEventListener("click", function (e) {
      e.stopPropagation();
      settingsPanel.classList.toggle("hidden");
    });
  }

  // Close the settings panel when clicking outside it (and outside the
  // outline rail's gear button, the desktop settings-toggle, and the mobile
  // top-bar buttons / backdrop — these all control the panel on mobile).
  document.addEventListener("click", function (e) {
    if (!settingsPanel.classList.contains("hidden")) {
      const gearBtn = document.getElementById("outline-gear-btn");
      const mobileSettingsBtn = document.getElementById("mobile-settings-btn");
      const mobileTopbar = document.getElementById("mobile-topbar");
      const mobileBackdrop = document.getElementById("mobile-backdrop");
      if (
        !settingsPanel.contains(e.target) &&
        e.target !== settingsToggle &&
        !settingsToggle?.contains(e.target) &&
        !gearBtn?.contains(e.target) &&
        !mobileSettingsBtn?.contains(e.target) &&
        !mobileTopbar?.contains(e.target) &&
        !mobileBackdrop?.contains(e.target)
      ) {
        settingsPanel.classList.add("hidden");
      }
    }
  });

  // ---- Dark Mode ----
  const darkModeToggle = document.getElementById("darkModeToggle");
  const savedDarkMode = localStorage.getItem("darkMode") === "true";
  if (savedDarkMode) {
    document.body.classList.add("dark-mode");
    darkModeToggle.checked = true;
  }
  darkModeToggle.addEventListener("change", function () {
    document.body.classList.toggle("dark-mode", this.checked);
    localStorage.setItem("darkMode", this.checked);
  });

  // ---- Content Width ----
  const widthSlider = document.getElementById("widthSlider");
  const widthLabel = document.getElementById("widthLabel");
  const contentDiv = document.querySelector(".note-content");
  const savedWidth = localStorage.getItem("contentWidth");
  if (savedWidth) {
    const val = parseInt(savedWidth, 10);
    widthSlider.value = val;
    widthLabel.textContent = val + "%";
    contentDiv.style.maxWidth = val + "%";
    const editable = document.querySelector(".editable-content");
    if (editable) editable.style.maxWidth = val + "%";
  }
  widthSlider.addEventListener("input", function () {
    const val = parseInt(this.value, 10);
    widthLabel.textContent = val + "%";
    contentDiv.style.maxWidth = val + "%";
    const editable = document.querySelector(".editable-content");
    if (editable) editable.style.maxWidth = val + "%";
    localStorage.setItem("contentWidth", val);
  });

  // ---- Image Alignment ----
  const alignRow = document.createElement("div");
  alignRow.className = "settings-row";
  alignRow.innerHTML = `
    <label for="imageAlignSelect">🖼️ Image Alignment</label>
    <select id="imageAlignSelect">
      <option value="left">Left</option>
      <option value="center">Center</option>
      <option value="right">Right</option>
    </select>
  `;
  // Insert after the width slider row (we need to find the parent)
  const widthRow = widthSlider.closest(".settings-row");
  if (widthRow && widthRow.parentNode) {
    widthRow.parentNode.insertBefore(alignRow, widthRow.nextSibling);
  } else {
    // fallback: append to settings panel
    document.getElementById("settings-panel").appendChild(alignRow);
  }
  const alignSelect = document.getElementById("imageAlignSelect");
  // Set initial value
  const savedAlign = getImageAlignment();
  alignSelect.value = savedAlign;
  alignSelect.addEventListener("change", function () {
    localStorage.setItem(IMAGE_ALIGN_KEY, this.value);
    applyImageAlignment();
  });

  // ---- Embed Width & Height ----
  const embedWidthSlider = document.getElementById("embedWidthSlider");
  const embedWidthLabel = document.getElementById("embedWidthLabel");
  const embedHeightSlider = document.getElementById("embedHeightSlider");
  const embedHeightLabel = document.getElementById("embedHeightLabel");
  const savedEmbedWidth = localStorage.getItem("embedWidth");
  if (savedEmbedWidth) {
    embedWidthSlider.value = savedEmbedWidth;
    embedWidthLabel.textContent = savedEmbedWidth + "%";
  }
  const savedEmbedHeight = localStorage.getItem("embedHeight");
  if (savedEmbedHeight) {
    embedHeightSlider.value = savedEmbedHeight;
    embedHeightLabel.textContent = savedEmbedHeight + "px";
  }
  embedWidthSlider.addEventListener("input", function () {
    const val = this.value;
    embedWidthLabel.textContent = val + "%";
    localStorage.setItem("embedWidth", val);
    applyEmbedSettings();
  });
  embedHeightSlider.addEventListener("input", function () {
    const val = this.value;
    embedHeightLabel.textContent = val + "px";
    localStorage.setItem("embedHeight", val);
    applyEmbedSettings();
  });

  // ---- Font Family, Weight, Size ----
  const fontFamilySelect = document.getElementById("fontFamilySelect");
  const fontWeightSlider = document.getElementById("fontWeightSlider");
  const fontWeightLabel = document.getElementById("fontWeightLabel");
  const fontSizeSlider = document.getElementById("fontSizeSlider");
  const fontSizeLabel = document.getElementById("fontSizeLabel");
  const savedFontFamily = localStorage.getItem("fontFamily");
  if (savedFontFamily) fontFamilySelect.value = savedFontFamily;
  const savedFontWeight = localStorage.getItem("fontWeight");
  if (savedFontWeight) {
    fontWeightSlider.value = savedFontWeight;
    fontWeightLabel.textContent = savedFontWeight;
  }
  const savedFontSize = localStorage.getItem("fontSize");
  if (savedFontSize) {
    fontSizeSlider.value = savedFontSize;
    fontSizeLabel.textContent = savedFontSize + "px";
  }
  fontFamilySelect.addEventListener("change", function () {
    localStorage.setItem("fontFamily", this.value);
    applyFontSettings();
  });
  fontWeightSlider.addEventListener("input", function () {
    const val = this.value;
    fontWeightLabel.textContent = val;
    localStorage.setItem("fontWeight", val);
    applyFontSettings();
  });
  fontSizeSlider.addEventListener("input", function () {
    const val = this.value;
    fontSizeLabel.textContent = val + "px";
    localStorage.setItem("fontSize", val);
    applyFontSettings();
  });

  // ---- Image Brightness ----
  const imgBrightnessSlider = document.getElementById("imgBrightnessSlider");
  const imgBrightnessLabel = document.getElementById("imgBrightnessLabel");
  const savedBrightness = localStorage.getItem("imgBrightness");
  if (savedBrightness !== null) {
    const val = parseFloat(savedBrightness);
    imgBrightnessSlider.value = val;
    applyImageBrightness();
  }
  imgBrightnessSlider.addEventListener("input", applyImageBrightness);

  function applyImageBrightness() {
    const val = parseFloat(imgBrightnessSlider.value);
    document.documentElement.style.setProperty("--img-brightness", val);
    imgBrightnessLabel.textContent = Math.round(val * 100) + "%";
    localStorage.setItem("imgBrightness", val);
    const lightboxImg = document.querySelector("#lightbox-img");
    if (lightboxImg && lightboxImg.src) {
      lightboxImg.style.filter = `brightness(${val})`;
    }
  }

  // ---- Shortcuts (collapsible) ----
  const shortcutsSection = document.getElementById("shortcuts-section");
  if (shortcutsSection) {
    // Replace the section content with a collapsible button + hidden list
    shortcutsSection.innerHTML = `
      <button id="shortcuts-toggle-btn" style="
        width: 100%; padding: 0.5rem; background: var(--surface-2, #f0f0f0);
        border: 1px solid var(--border, #ccc); border-radius: 6px;
        cursor: pointer; font-size: 0.85rem; font-weight: 600; color: var(--text, #333);
        display: flex; align-items: center; justify-content: space-between;
        transition: background 0.15s;
      ">⌨️ Keyboard Shortcuts <span id="shortcuts-arrow" style="transition: transform 0.2s;">▸</span></button>
      <div id="shortcuts-list" style="display: none; margin-top: 0.5rem;"></div>
    `;
    const toggleBtn = shortcutsSection.querySelector("#shortcuts-toggle-btn");
    const list = shortcutsSection.querySelector("#shortcuts-list");
    const arrow = shortcutsSection.querySelector("#shortcuts-arrow");
    toggleBtn.addEventListener("click", () => {
      const isOpen = list.style.display !== "none";
      list.style.display = isOpen ? "none" : "block";
      arrow.style.transform = isOpen ? "rotate(0deg)" : "rotate(90deg)";
      if (!isOpen) renderShortcutSettings();
    });
  }
  renderShortcutSettings();

  // ---- Creative features ----
  // Reading progress bar
  const progressRow = document.createElement("div");
  progressRow.className = "settings-row";
  progressRow.innerHTML = `
    <label for="readingProgressToggle">📊 Reading Progress</label>
    <input type="checkbox" id="readingProgressToggle" />
  `;
  settingsPanel.appendChild(progressRow);
  const progressToggle = document.getElementById("readingProgressToggle");
  const savedProgress = localStorage.getItem("readingProgress");
  if (savedProgress === "true") {
    progressToggle.checked = true;
    enableReadingProgress();
  }
  progressToggle.addEventListener("change", function () {
    localStorage.setItem("readingProgress", this.checked);
    if (this.checked) enableReadingProgress();
    else disableReadingProgress();
  });

  // Word count
  const wordCountRow = document.createElement("div");
  wordCountRow.className = "settings-row";
  wordCountRow.innerHTML = `
    <label for="wordCountToggle">📝 Word Count</label>
    <input type="checkbox" id="wordCountToggle" />
  `;
  settingsPanel.appendChild(wordCountRow);
  const wcToggle = document.getElementById("wordCountToggle");
  const savedWC = localStorage.getItem("wordCount");
  if (savedWC === "true") {
    wcToggle.checked = true;
    enableWordCount();
  }
  wcToggle.addEventListener("change", function () {
    localStorage.setItem("wordCount", this.checked);
    if (this.checked) enableWordCount();
    else disableWordCount();
  });

  // Line spacing
  const lineSpacingRow = document.createElement("div");
  lineSpacingRow.className = "settings-row";
  lineSpacingRow.innerHTML = `
    <label for="lineSpacingSlider">📏 Line Spacing</label>
    <input type="range" id="lineSpacingSlider" min="1.2" max="2.4" step="0.1" value="1.8" />
    <span id="lineSpacingLabel">1.8</span>
  `;
  settingsPanel.appendChild(lineSpacingRow);
  const lsSlider = document.getElementById("lineSpacingSlider");
  const lsLabel = document.getElementById("lineSpacingLabel");
  const savedLS = localStorage.getItem("lineSpacing");
  if (savedLS) { lsSlider.value = savedLS; lsLabel.textContent = savedLS; applyLineSpacing(); }
  lsSlider.addEventListener("input", function () {
    lsLabel.textContent = this.value;
    localStorage.setItem("lineSpacing", this.value);
    applyLineSpacing();
  });
  function applyLineSpacing() {
    const contentDiv = document.querySelector(".note-content");
    if (contentDiv) contentDiv.style.lineHeight = lsSlider.value;
    const editable = document.querySelector(".editable-content");
    if (editable) editable.style.lineHeight = lsSlider.value;
  }

  // ---- Farm Animals ----
  const animalsRow = document.createElement("div");
  animalsRow.className = "settings-row";
  animalsRow.innerHTML = `
    <label for="animalsToggle">🐄 Farm Animals</label>
    <input type="checkbox" id="animalsToggle" />
  `;
  settingsPanel.appendChild(animalsRow);
  const animalsToggle = document.getElementById("animalsToggle");
  const savedAnimals = localStorage.getItem("farmAnimals");
  if (savedAnimals === "true") {
    animalsToggle.checked = true;
    if (window._startAnimals) window._startAnimals();
  }
  animalsToggle.addEventListener("change", function () {
    localStorage.setItem("farmAnimals", this.checked);
    if (this.checked) {
      if (window._startAnimals) window._startAnimals();
    } else {
      if (window._stopAnimals) window._stopAnimals();
    }
  });

  // ---- Animations (T5) ----
  // Animations are OFF by default. When ON, the body.animations-enabled class
  // is added, which triggers the keyframe animations defined in new-features.css
  // (rec-card fade-in, rec-inserted-block slide-in, chat-msg slide-in,
  // overlay fade-in, etc.).
  const animationsRow = document.createElement("div");
  animationsRow.className = "settings-row";
  animationsRow.innerHTML = `
    <label for="animationsToggle">✨ Animations</label>
    <input type="checkbox" id="animationsToggle" />
  `;
  settingsPanel.appendChild(animationsRow);
  const animationsToggle = document.getElementById("animationsToggle");
  const savedAnimations = localStorage.getItem("animationsEnabled");
  if (savedAnimations === "true") {
    animationsToggle.checked = true;
    document.body.classList.add("animations-enabled");
  }
  animationsToggle.addEventListener("change", function () {
    localStorage.setItem("animationsEnabled", this.checked);
    document.body.classList.toggle("animations-enabled", this.checked);
  });

  // ---- Initial apply ----
  applyImageAlignment();
  applyLineSpacing();
}

// ======================================================
// CREATIVE FEATURES
// ======================================================

// --- Reading progress bar ---
let progressInterval = null;
function enableReadingProgress() {
  const bar = document.createElement("div");
  bar.id = "reading-progress-bar";
  bar.style.cssText = "position:fixed; top:0; left:0; height:3px; background:#2d7d46; z-index:9999; width:0%; transition:width 0.1s;";
  document.body.appendChild(bar);
  const update = () => {
    const mainEl = document.getElementById("main");
    if (!mainEl) return;
    const max = mainEl.scrollHeight - mainEl.clientHeight;
    const pct = max > 0 ? (mainEl.scrollTop / max) * 100 : 0;
    bar.style.width = pct + "%";
  };
  const mainEl = document.getElementById("main");
  if (mainEl) mainEl.addEventListener("scroll", update, { passive: true });
  update();
  progressInterval = setInterval(update, 200);
}
function disableReadingProgress() {
  const bar = document.getElementById("reading-progress-bar");
  if (bar) bar.remove();
  if (progressInterval) { clearInterval(progressInterval); progressInterval = null; }
}

// --- Word count ---
let wcInterval = null;
function enableWordCount() {
  const counter = document.createElement("div");
  counter.id = "word-count-display";
  counter.style.cssText = "position:fixed; bottom:50px; right:36px; z-index:100; background:rgba(30,30,30,0.85); color:#aaa; padding:0.3rem 0.8rem; border-radius:8px; font-size:0.75rem; font-family:var(--font); pointer-events:none; backdrop-filter:blur(4px);";
  document.body.appendChild(counter);
  const update = () => {
    const contentDiv = document.getElementById("content");
    if (!contentDiv) return;
    const text = contentDiv.textContent || "";
    const words = text.trim().split(/\s+/).filter(Boolean).length;
    const readTime = Math.max(1, Math.round(words / 200));
    counter.textContent = `${words} words · ${readTime} min read`;
  };
  update();
  wcInterval = setInterval(update, 1000);
}
function disableWordCount() {
  const counter = document.getElementById("word-count-display");
  if (counter) counter.remove();
  if (wcInterval) { clearInterval(wcInterval); wcInterval = null; }
}
