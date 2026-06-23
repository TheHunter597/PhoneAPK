// ======================================================
//  IMAGE VIEWER + EDITOR (js/imageEditor.js)
// ======================================================
// Renders images opened from the sidebar in the #content area, and provides
// a full canvas-based image editor with resize, crop, brightness, pen, text,
// and export tools.
//
// When an image is clicked in the sidebar, an "openImage" event is dispatched.
// This module listens for it and calls viewImage(path), which renders the
// image in #content with zoom/pan controls and an "Edit Image" button.
//
// The editor is a full-screen overlay with a toolbar and canvas. Edits are
// applied to a working canvas. Export saves the canvas back to the vault via
// POST /api/save-image (replaces the original file).

// ---- State ----
let currentImagePath = null;
let editorOverlay = null;

// ---- Helper: escape HTML ----
function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = String(str);
  return div.innerHTML;
}

// ---- Helper: escape for CSS attribute selector ----
function cssEscape(str) {
  return String(str).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

// ======================================================
//  IMAGE VIEWER (renders image in #content)
// ======================================================

export function viewImage(path) {
  const contentDiv = document.getElementById("content");
  if (!contentDiv) return;

  currentImagePath = path;
  // Cache-bust timestamp to force reload of updated images
  const imgUrl = "/vault/" + path.replace(/ /g, "%20") + "?t=" + Date.now();
  const fileName = path.split("/").pop();

  // Exit edit mode if active
  if (window._isEditing && window._exitEditMode) {
    window._exitEditMode(false);
  }

  contentDiv.innerHTML = `
    <div class="image-viewer-container">
      <div class="image-viewer-toolbar">
        <span class="image-viewer-title">🖼️ ${escapeHtml(fileName)}</span>
        <div class="image-viewer-actions">
          <button id="imgZoomIn" class="img-viewer-btn" title="Zoom in">🔍+</button>
          <button id="imgZoomOut" class="img-viewer-btn" title="Zoom out">🔍−</button>
          <button id="imgZoomReset" class="img-viewer-btn" title="Reset zoom">100%</button>
          <button id="imgEditBtn" class="img-viewer-btn img-edit-btn" title="Edit image">✏️ Edit Image</button>
        </div>
      </div>
      <div class="image-viewer-stage" id="imageViewerStage">
        <img id="imageViewerImg" src="${imgUrl}" alt="${escapeHtml(fileName)}" class="image-viewer-img" style="transform: scale(1);">
      </div>
    </div>
  `;

  // Wire up zoom controls
  let zoom = 1;
  const img = contentDiv.querySelector("#imageViewerImg");
  const stage = contentDiv.querySelector("#imageViewerStage");

  function setZoom(z) {
    zoom = Math.max(0.1, Math.min(8, z));
    img.style.transform = `scale(${zoom})`;
  }

  contentDiv.querySelector("#imgZoomIn").addEventListener("click", () => setZoom(zoom * 1.25));
  contentDiv.querySelector("#imgZoomOut").addEventListener("click", () => setZoom(zoom / 1.25));
  contentDiv.querySelector("#imgZoomReset").addEventListener("click", () => setZoom(1));

  // Scroll-to-zoom on the image stage
  stage.addEventListener("wheel", (e) => {
    e.preventDefault();
    if (e.deltaY < 0) setZoom(zoom * 1.1);
    else setZoom(zoom / 1.1);
  }, { passive: false });

  // Double-click to reset
  img.addEventListener("dblclick", () => setZoom(1));

  // Edit button → open editor
  contentDiv.querySelector("#imgEditBtn").addEventListener("click", () => {
    openImageEditor(path);
  });

  // Update sidebar active state + set current path
  if (window._setCurrentNotePath) window._setCurrentNotePath(path);
  document.querySelectorAll(".image-item.active, .note.active").forEach(el => el.classList.remove("active"));
  const sidebarItem = document.querySelector(`.image-item[data-path="${cssEscape(path)}"], .note[data-path="${cssEscape(path)}"]`);
  if (sidebarItem) sidebarItem.classList.add("active");

  localStorage.setItem("lastNote", path);
}

// ======================================================
//  IMAGE EDITOR — full-screen canvas-based editor
// ======================================================

export function openImageEditor(path) {
  closeImageEditor();
  // Set the flag so the main app's keyboard handler knows to bail
  window._isImageEditorOpen = true;

  // Build the image URL (cache-busted to get the latest version)
  const imgUrl = "/vault/" + path.replace(/ /g, "%20") + "?t=" + Date.now();

  editorOverlay = document.createElement("div");
  editorOverlay.className = "image-editor-overlay";
  editorOverlay.innerHTML = `
    <div class="editor-topbar">
      <div class="editor-topbar-left">
        <button id="editorCloseBtn" class="editor-btn" title="Close editor (Esc)">✕ Close</button>
        <span class="editor-filename">✏️ Editing: ${escapeHtml(path.split("/").pop())}</span>
      </div>
      <div class="editor-topbar-center">
        <button id="editorUndo" class="editor-btn" title="Undo (Ctrl+Z)">↶ Undo</button>
        <button id="editorRedo" class="editor-btn" title="Redo (Ctrl+Y)">↷ Redo</button>
        <span class="editor-zoom-display" id="editorZoomDisplay">100%</span>
        <button id="editorZoomOut" class="editor-btn" title="Zoom out">−</button>
        <button id="editorZoomIn" class="editor-btn" title="Zoom in">+</button>
        <button id="editorZoomReset" class="editor-btn" title="Reset zoom">1:1</button>
      </div>
      <div class="editor-topbar-right">
        <button id="editorSave" class="editor-btn editor-save-btn" title="Save to vault (stay in editor)">💾 Save</button>
        <button id="editorSaveExit" class="editor-btn editor-save-btn" title="Save and return to viewer">💾 Save & Exit</button>
        <button id="editorDownload" class="editor-btn" title="Download as file">⬇</button>
      </div>
    </div>
    <div class="editor-body">
      <div class="editor-toolbar">
        <button class="tool-btn active" data-tool="select" title="Select / Pan (V)">🖱️</button>
        <button class="tool-btn" data-tool="pen" title="Pen / Brush (P)">✏️</button>
        <button class="tool-btn" data-tool="eraser" title="Eraser (E)">🧹</button>
        <button class="tool-btn" data-tool="text" title="Text (T)">📝</button>
        <button class="tool-btn" data-tool="rect" title="Rectangle">⬜</button>
        <button class="tool-btn" data-tool="ellipse" title="Ellipse">⬭</button>
        <button class="tool-btn" data-tool="line" title="Line">📏</button>
        <button class="tool-btn" data-tool="crop" title="Crop (C) — Hold Shift for square">✂️</button>
        <hr class="tool-divider">
        <div class="tool-section">
          <label class="tool-label" id="sizeLabel">Size</label>
          <input type="range" id="brushSize" min="1" max="100" value="20" class="tool-slider">
          <span id="brushSizeVal" class="tool-val">20</span>
        </div>
        <div class="tool-section">
          <label class="tool-label">Color</label>
          <input type="color" id="toolColor" value="#1e293b" class="tool-color">
        </div>
        <div class="tool-section">
          <label class="tool-label">Opacity</label>
          <input type="range" id="toolOpacity" min="0" max="100" value="100" class="tool-slider">
          <span id="opacityVal" class="tool-val">100%</span>
        </div>
        <hr class="tool-divider">
        <div class="tool-section">
          <label class="tool-label">Brightness</label>
          <input type="range" id="adjBrightness" min="-100" max="100" value="0" class="tool-slider">
          <span id="brightnessVal" class="tool-val">0</span>
        </div>
        <div class="tool-section">
          <label class="tool-label">Contrast</label>
          <input type="range" id="adjContrast" min="-100" max="100" value="0" class="tool-slider">
          <span id="contrastVal" class="tool-val">0</span>
        </div>
        <div class="tool-section">
          <label class="tool-label">Saturation</label>
          <input type="range" id="adjSaturation" min="-100" max="100" value="0" class="tool-slider">
          <span id="saturationVal" class="tool-val">0</span>
        </div>
        <div class="tool-hint" id="adjustHint">Drag sliders for live preview. Changes commit when you release.</div>
        <hr class="tool-divider">
        <div class="tool-section">
          <label class="tool-label">Resize</label>
          <input type="number" id="resizeW" placeholder="W" class="resize-input" min="1">
          <span class="resize-x">×</span>
          <input type="number" id="resizeH" placeholder="H" class="resize-input" min="1">
          <label class="resize-lock-label">
            <input type="checkbox" id="resizeLock" checked> 🔗
          </label>
          <button id="resizeApplyBtn" class="editor-btn">Resize</button>
        </div>
        <hr class="tool-divider">
        <div class="tool-section">
          <label class="tool-label">Rotate</label>
          <button id="rotateLeftBtn" class="editor-btn" title="Rotate 90° left">↺</button>
          <button id="rotateRightBtn" class="editor-btn" title="Rotate 90° right">↻</button>
        </div>
        <div class="tool-section">
          <label class="tool-label">Flip</label>
          <button id="flipHBtn" class="editor-btn" title="Flip horizontal">↔</button>
          <button id="flipVBtn" class="editor-btn" title="Flip vertical">↕</button>
        </div>
        <hr class="tool-divider">
        <div class="tool-hint" id="toolHint">Select a tool to start editing.</div>
      </div>
      <div class="editor-canvas-area" id="editorCanvasArea">
        <canvas id="editorCanvas" class="editor-canvas"></canvas>
      </div>
    </div>
    <!-- Crop confirm/cancel buttons (shown after dragging crop selection) -->
    <div class="crop-confirm-bar" id="cropConfirmBar" style="display:none;">
      <span class="crop-confirm-label">Crop selection ready</span>
      <button id="cropConfirmBtn" class="editor-btn editor-save-btn">✓ Confirm Crop</button>
      <button id="cropCancelBtn" class="editor-btn">✕ Cancel</button>
    </div>
    <!-- Text formatting toolbar (shown when text tool is active) -->
    <div class="text-format-bar" id="textFormatBar" style="display:none;">
      <select id="textFontFamily" class="text-format-select">
        <option value="sans-serif">Sans-serif</option>
        <option value="serif">Serif</option>
        <option value="monospace">Monospace</option>
        <option value="Arial">Arial</option>
        <option value="Georgia">Georgia</option>
        <option value="Courier New">Courier New</option>
      </select>
      <button id="textBoldBtn" class="text-format-btn" title="Bold">𝐁</button>
      <button id="textItalicBtn" class="text-format-btn" title="Italic">𝐼</button>
      <span class="text-format-hint">Click on image to place text · Esc or click away to commit</span>
    </div>
  `;
  document.body.appendChild(editorOverlay);

  // ---- Listener cleanup tracking (T3-3) ----
  // Every document-level listener added inside this editor session is
  // tracked here and removed in closeImageEditor(). Without this, every
  // open/close cycle leaked 5+ listeners (Space/Shift keydown, keyup, mouseup
  // for pan, plus per-text-element mousemove/mouseup for dragging).
  const cleanupFns = [];
  editorOverlay._cleanup = cleanupFns;

  function addDocumentListener(event, handler) {
    document.addEventListener(event, handler);
    cleanupFns.push(() => document.removeEventListener(event, handler));
  }

  // ---- Load the image into the canvas ----
  const canvas = editorOverlay.querySelector("#editorCanvas");
  const ctx = canvas.getContext("2d");
  const img = new Image();
  img.crossOrigin = "anonymous";

  img.onload = () => {
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    ctx.drawImage(img, 0, 0);
    saveHistory();
    fitCanvasToView();
    // Initialize resize inputs
    editorOverlay.querySelector("#resizeW").value = canvas.width;
    editorOverlay.querySelector("#resizeH").value = canvas.height;
  };
  img.onerror = () => {
    window.showErrorModal("Image Load Failed", "Failed to load image: " + imgUrl);
  };
  img.src = imgUrl;

  // ---- Editor state ----
  let currentTool = "select";
  let isDrawing = false;
  let startX = 0, startY = 0;
  let brushSize = 20;
  let toolColor = "#1e293b";
  let toolOpacity = 1;
  let snapshot = null; // for drawing preview (shapes, crop)
  let editorZoom = 1;
  let isPanning = false;
  let panStartX = 0, panStartY = 0, panScrollLeft = 0, panScrollTop = 0;

  // Live adjustment state
  let adjustmentBase = null; // ImageData saved before adjustment starts
  let isAdjusting = false;

  // Crop state
  let cropRect = null;
  let cropActive = false; // true while dragging crop selection
  let shiftPressed = false;

  // Text overlay state
  let activeTextElement = null;
  let textBold = false;
  let textItalic = false;
  let textFontFamily = "sans-serif";

  // Undo/redo history
  const history = [];
  let historyIndex = -1;

  function saveHistory() {
    history.length = historyIndex + 1;
    history.push(canvas.toDataURL());
    historyIndex++;
    if (history.length > 10) {
      history.shift();
      historyIndex--;
    }
    updateUndoRedoButtons();
  }

  function undo() {
    commitAdjustments(); // commit any pending live adjustments
    if (historyIndex <= 0) return;
    historyIndex--;
    restoreFromHistory();
  }

  function redo() {
    if (historyIndex >= history.length - 1) return;
    historyIndex++;
    restoreFromHistory();
  }

  function restoreFromHistory() {
    const img2 = new Image();
    img2.onload = () => {
      canvas.width = img2.naturalWidth;
      canvas.height = img2.naturalHeight;
      ctx.drawImage(img2, 0, 0);
      updateUndoRedoButtons();
      fitCanvasToView();
    };
    img2.src = history[historyIndex];
  }

  function updateUndoRedoButtons() {
    const undoBtn = editorOverlay.querySelector("#editorUndo");
    const redoBtn = editorOverlay.querySelector("#editorRedo");
    if (undoBtn) undoBtn.disabled = historyIndex <= 0;
    if (redoBtn) redoBtn.disabled = historyIndex >= history.length - 1;
  }

  // ---- Canvas coordinate conversion (accounts for zoom) ----
  function getCanvasCoords(e) {
    const rect = canvas.getBoundingClientRect();
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;
    return {
      x: (e.clientX - rect.left) * scaleX,
      y: (e.clientY - rect.top) * scaleY,
    };
  }

  // ---- Fit canvas to the viewing area ----
  function fitCanvasToView() {
    const area = editorOverlay.querySelector("#editorCanvasArea");
    const maxW = area.clientWidth - 40;
    const maxH = area.clientHeight - 40;
    const scale = Math.min(maxW / canvas.width, maxH / canvas.height, 1);
    editorZoom = scale;
    applyZoom();
  }

  function applyZoom() {
    const w = canvas.width * editorZoom;
    const h = canvas.height * editorZoom;
    canvas.style.width = w + "px";
    canvas.style.height = h + "px";
    const display = editorOverlay.querySelector("#editorZoomDisplay");
    if (display) display.textContent = Math.round(editorZoom * 100) + "%";
  }

  function setZoom(z) {
    editorZoom = Math.max(0.05, Math.min(32, z));
    applyZoom();
  }

  // ---- Zoom controls ----
  editorOverlay.querySelector("#editorZoomIn").addEventListener("click", () => setZoom(editorZoom * 1.25));
  editorOverlay.querySelector("#editorZoomOut").addEventListener("click", () => setZoom(editorZoom / 1.25));
  editorOverlay.querySelector("#editorZoomReset").addEventListener("click", () => {
    editorZoom = 1;
    applyZoom();
  });

  // Ctrl+scroll to zoom (in canvas area)
  const canvasArea = editorOverlay.querySelector("#editorCanvasArea");
  canvasArea.addEventListener("wheel", (e) => {
    if (e.ctrlKey || e.metaKey) {
      e.preventDefault();
      if (e.deltaY < 0) setZoom(editorZoom * 1.1);
      else setZoom(editorZoom / 1.1);
    }
  }, { passive: false });

  // ---- Pan with Space+drag or middle mouse ----
  canvasArea.addEventListener("mousedown", (e) => {
    if (e.button === 1 || (e.button === 0 && (e.code === "Space" || document.body.classList.contains("space-panning")))) {
      isPanning = true;
      panStartX = e.clientX;
      panStartY = e.clientY;
      panScrollLeft = canvasArea.scrollLeft;
      panScrollTop = canvasArea.scrollTop;
      canvasArea.style.cursor = "grabbing";
      e.preventDefault();
    }
  });

  addDocumentListener("keydown", (e) => {
    if (e.code === "Space" && editorOverlay && !e.target.matches("input, textarea, select") && !e.target.isContentEditable) {
      document.body.classList.add("space-panning");
      canvasArea.style.cursor = "grab";
      e.preventDefault();
    }
    if (e.key === "Shift") shiftPressed = true;
  });

  addDocumentListener("keyup", (e) => {
    if (e.code === "Space") {
      document.body.classList.remove("space-panning");
      canvasArea.style.cursor = "";
    }
    if (e.key === "Shift") shiftPressed = false;
  });

  canvasArea.addEventListener("mousemove", (e) => {
    if (isPanning) {
      const dx = e.clientX - panStartX;
      const dy = e.clientY - panStartY;
      canvasArea.scrollLeft = panScrollLeft - dx;
      canvasArea.scrollTop = panScrollTop - dy;
    }
  });

  addDocumentListener("mouseup", () => {
    if (isPanning) {
      isPanning = false;
      canvasArea.style.cursor = "";
    }
  });

  // ---- Tool selection ----
  const toolHint = editorOverlay.querySelector("#toolHint");
  const textFormatBar = editorOverlay.querySelector("#textFormatBar");
  const sizeLabel = editorOverlay.querySelector("#sizeLabel");

  const toolHints = {
    select: "Pan with Space+drag or middle mouse. Ctrl+scroll to zoom.",
    pen: "Click and drag to draw freehand.",
    eraser: "Click and drag to erase.",
    text: "Click on image to place a text box. Type, then click away to commit.",
    rect: "Click and drag to draw a rectangle outline.",
    ellipse: "Click and drag to draw an ellipse outline.",
    line: "Click and drag to draw a line.",
    crop: "Click and drag to select crop area. Hold Shift for square. Release, then confirm.",
  };

  function selectTool(tool) {
    // Commit any active text element
    if (activeTextElement && tool !== "text") {
      commitText();
    }
    // Commit any pending adjustments
    commitAdjustments();

    currentTool = tool;
    editorOverlay.querySelectorAll(".tool-btn").forEach(b => b.classList.remove("active"));
    const btn = editorOverlay.querySelector(`.tool-btn[data-tool="${tool}"]`);
    if (btn) btn.classList.add("active");

    canvas.style.cursor = tool === "select" ? "default" : "crosshair";
    if (toolHint) toolHint.textContent = toolHints[tool] || "";

    // Show text format bar only for text tool
    if (textFormatBar) {
      textFormatBar.style.display = tool === "text" ? "flex" : "none";
    }

    // Update size label
    if (sizeLabel) {
      sizeLabel.textContent = tool === "text" ? "Font Size" : "Size";
    }

    // Cancel any active crop
    cancelCrop();
  }

  editorOverlay.querySelectorAll(".tool-btn").forEach(btn => {
    btn.addEventListener("click", () => selectTool(btn.dataset.tool));
  });

  // ---- Brush size / color / opacity ----
  const brushSizeSlider = editorOverlay.querySelector("#brushSize");
  const brushSizeVal = editorOverlay.querySelector("#brushSizeVal");
  brushSizeSlider.addEventListener("input", () => {
    brushSize = parseInt(brushSizeSlider.value, 10);
    brushSizeVal.textContent = brushSize;
    // If there's an active text element, update its font size
    if (activeTextElement) {
      activeTextElement.style.fontSize = (brushSize * editorZoom) + "px";
    }
  });

  const colorPicker = editorOverlay.querySelector("#toolColor");
  colorPicker.addEventListener("input", () => {
    toolColor = colorPicker.value;
    if (activeTextElement) {
      activeTextElement.style.color = toolColor;
    }
  });

  const opacitySlider = editorOverlay.querySelector("#toolOpacity");
  const opacityVal = editorOverlay.querySelector("#opacityVal");
  opacitySlider.addEventListener("input", () => {
    toolOpacity = parseInt(opacitySlider.value, 10) / 100;
    opacityVal.textContent = opacitySlider.value + "%";
    if (activeTextElement) {
      activeTextElement.style.opacity = toolOpacity;
    }
  });

  // ---- Text formatting ----
  editorOverlay.querySelector("#textFontFamily").addEventListener("change", (e) => {
    textFontFamily = e.target.value;
    if (activeTextElement) {
      activeTextElement.style.fontFamily = textFontFamily;
    }
  });

  editorOverlay.querySelector("#textBoldBtn").addEventListener("click", () => {
    textBold = !textBold;
    editorOverlay.querySelector("#textBoldBtn").classList.toggle("active", textBold);
    if (activeTextElement) {
      activeTextElement.style.fontWeight = textBold ? "bold" : "normal";
    }
  });

  editorOverlay.querySelector("#textItalicBtn").addEventListener("click", () => {
    textItalic = !textItalic;
    editorOverlay.querySelector("#textItalicBtn").classList.toggle("active", textItalic);
    if (activeTextElement) {
      activeTextElement.style.fontStyle = textItalic ? "italic" : "normal";
    }
  });

  // ---- LIVE ADJUSTMENT PREVIEW ----
  // As the user drags brightness/contrast/saturation sliders, we show a live
  // preview by applying the adjustment to a saved "base" state. When the user
  // releases the slider (change event), the adjusted image is committed to
  // history and becomes the new base. Sliders reset to 0 after commit.

  const brightnessSlider = editorOverlay.querySelector("#adjBrightness");
  const contrastSlider = editorOverlay.querySelector("#adjContrast");
  const saturationSlider = editorOverlay.querySelector("#adjSaturation");
  const brightnessValEl = editorOverlay.querySelector("#brightnessVal");
  const contrastValEl = editorOverlay.querySelector("#contrastVal");
  const saturationValEl = editorOverlay.querySelector("#saturationVal");

  function applyAdjustmentsToCanvas(baseData, b, c, s) {
    // Create a temp canvas with the base data, then apply adjustments
    const tempCanvas = document.createElement("canvas");
    tempCanvas.width = baseData.width;
    tempCanvas.height = baseData.height;
    const tempCtx = tempCanvas.getContext("2d");
    tempCtx.putImageData(baseData, 0, 0);

    if (b === 0 && c === 0 && s === 0) {
      ctx.putImageData(baseData, 0, 0);
      return;
    }

    const imageData = tempCtx.getImageData(0, 0, tempCanvas.width, tempCanvas.height);
    const data = imageData.data;
    const bFactor = b * 2.55;
    const cFactor = (259 * (c + 255)) / (255 * (259 - c));
    const sFactor = 1 + s / 100;

    for (let i = 0; i < data.length; i += 4) {
      data[i] = Math.max(0, Math.min(255, cFactor * (data[i] + bFactor - 128) + 128));
      data[i + 1] = Math.max(0, Math.min(255, cFactor * (data[i + 1] + bFactor - 128) + 128));
      data[i + 2] = Math.max(0, Math.min(255, cFactor * (data[i + 2] + bFactor - 128) + 128));
      const gray = 0.2989 * data[i] + 0.5870 * data[i + 1] + 0.1140 * data[i + 2];
      data[i] = Math.max(0, Math.min(255, gray + sFactor * (data[i] - gray)));
      data[i + 1] = Math.max(0, Math.min(255, gray + sFactor * (data[i + 1] - gray)));
      data[i + 2] = Math.max(0, Math.min(255, gray + sFactor * (data[i + 2] - gray)));
    }
    ctx.putImageData(imageData, 0, 0);
  }

  function onAdjustmentInput() {
    brightnessValEl.textContent = brightnessSlider.value;
    contrastValEl.textContent = contrastSlider.value;
    saturationValEl.textContent = saturationSlider.value;

    // Save base on first adjustment (when going from all-0 to something non-zero)
    if (!adjustmentBase) {
      adjustmentBase = ctx.getImageData(0, 0, canvas.width, canvas.height);
    }

    const b = parseInt(brightnessSlider.value, 10);
    const c = parseInt(contrastSlider.value, 10);
    const s = parseInt(saturationSlider.value, 10);
    applyAdjustmentsToCanvas(adjustmentBase, b, c, s);
  }

  function commitAdjustments() {
    if (!adjustmentBase) return;
    const b = parseInt(brightnessSlider.value, 10);
    const c = parseInt(contrastSlider.value, 10);
    const s = parseInt(saturationSlider.value, 10);
    if (b !== 0 || c !== 0 || s !== 0) {
      // The canvas already has the adjusted image — just save to history
      saveHistory();
    } else {
      // No change — restore base
      ctx.putImageData(adjustmentBase, 0, 0);
    }
    adjustmentBase = null;
    brightnessSlider.value = 0; brightnessValEl.textContent = "0";
    contrastSlider.value = 0; contrastValEl.textContent = "0";
    saturationSlider.value = 0; saturationValEl.textContent = "0";
  }

  brightnessSlider.addEventListener("input", onAdjustmentInput);
  contrastSlider.addEventListener("input", onAdjustmentInput);
  saturationSlider.addEventListener("input", onAdjustmentInput);

  // Commit on release (change event fires when mouse is released)
  brightnessSlider.addEventListener("change", commitAdjustments);
  contrastSlider.addEventListener("change", commitAdjustments);
  saturationSlider.addEventListener("change", commitAdjustments);

  // ---- TEXT TOOL (MS Paint style) ----
  // Clicking on the canvas with the text tool creates a contenteditable div
  // overlay. The user types directly into it. Clicking away or pressing Esc
  // "commits" the text — it's drawn onto the canvas at the div's position
  // with the matching font/color/size, and the div is removed.

  function createTextElement(canvasX, canvasY) {
    // Remove any existing active text element
    if (activeTextElement) commitText();

    const rect = canvas.getBoundingClientRect();
    const scaleX = rect.width / canvas.width;
    const scaleY = rect.height / canvas.height;

    const fontSize = brushSize; // in canvas pixels
    const displayFontSize = fontSize * scaleY; // in screen pixels

    const div = document.createElement("div");
    div.className = "text-overlay-element";
    div.contentEditable = "true";
    div.spellcheck = false;
    div.style.position = "absolute";
    div.style.left = (canvasX * scaleX) + "px";
    div.style.top = (canvasY * scaleY - displayFontSize) + "px"; // offset so text appears above click point
    div.style.color = toolColor;
    div.style.fontSize = displayFontSize + "px";
    div.style.fontFamily = textFontFamily;
    div.style.fontWeight = textBold ? "bold" : "normal";
    div.style.fontStyle = textItalic ? "italic" : "normal";
    div.style.opacity = toolOpacity;
    div.style.background = "rgba(255,255,255,0.01)";
    div.style.border = "1px dashed #4099ff";
    div.style.padding = "2px 4px";
    div.style.minWidth = "20px";
    div.style.minHeight = displayFontSize + "px";
    div.style.outline = "none";
    div.style.zIndex = "10";
    div.style.cursor = "move";
    div.style.whiteSpace = "nowrap";
    div.style.lineHeight = "1.2";

    // Position relative to the canvas area
    const canvasAreaEl = editorOverlay.querySelector("#editorCanvasArea");
    const areaRect = canvasAreaEl.getBoundingClientRect();
    const canvasRect = canvas.getBoundingClientRect();
    div.style.left = (canvasRect.left - areaRect.left + canvasX * scaleX) + "px";
    div.style.top = (canvasRect.top - areaRect.top + canvasY * scaleY - displayFontSize) + "px";

    canvasAreaEl.appendChild(div);
    activeTextElement = div;

    // Focus so user can type immediately
    setTimeout(() => {
      div.focus();
    }, 0);

    // Prevent canvas mousedown when clicking on the text element
    div.addEventListener("mousedown", (e) => {
      e.stopPropagation();
    });

    // Allow dragging to reposition
    let dragStartX = 0, dragStartY = 0, dragLeft = 0, dragTop = 0;
    let isDraggingText = false;
    div.addEventListener("mousedown", (e) => {
      isDraggingText = true;
      dragStartX = e.clientX;
      dragStartY = e.clientY;
      dragLeft = parseFloat(div.style.left);
      dragTop = parseFloat(div.style.top);
    });
    addDocumentListener("mousemove", (e) => {
      if (!isDraggingText) return;
      div.style.left = (dragLeft + e.clientX - dragStartX) + "px";
      div.style.top = (dragTop + e.clientY - dragStartY) + "px";
    });
    addDocumentListener("mouseup", () => {
      isDraggingText = false;
    });

    // Commit on Escape
    div.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        e.preventDefault();
        commitText();
      }
    });

    // Commit on blur (clicking elsewhere)
    div.addEventListener("blur", () => {
      // Small delay to allow click events to process
      setTimeout(() => {
        if (activeTextElement === div) commitText();
      }, 100);
    });
  }

  function commitText() {
    if (!activeTextElement) return;
    const div = activeTextElement;
    const text = div.textContent;
    const rect = canvas.getBoundingClientRect();
    const areaRect = editorOverlay.querySelector("#editorCanvasArea").getBoundingClientRect();

    // Convert div position (relative to canvas area) to canvas coordinates
    const divLeft = parseFloat(div.style.left);
    const divTop = parseFloat(div.style.top);
    const canvasLeft = rect.left - areaRect.left;
    const canvasTop = rect.top - areaRect.top;
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;

    const canvasX = (divLeft - canvasLeft) * scaleX;
    const canvasY = (divTop - canvasTop + brushSize * scaleY) * scaleY; // account for offset

    if (text.trim()) {
      // Draw the text onto the canvas
      ctx.save();
      ctx.globalAlpha = toolOpacity;
      ctx.globalCompositeOperation = "source-over";
      ctx.fillStyle = toolColor;
      ctx.font = `${textItalic ? "italic " : ""}${textBold ? "bold " : ""}${brushSize}px ${textFontFamily}`;
      ctx.textBaseline = "top";
      ctx.fillText(text, canvasX, canvasY);
      ctx.restore();
      saveHistory();
    }

    div.remove();
    activeTextElement = null;
  }

  // ---- CROP TOOL (Snipping Tool style) ----
  // Drag to select a crop region. A dark overlay dims everything outside
  // the selection. After releasing, a confirm/cancel bar appears.
  // Hold Shift to constrain to a square.

  function cancelCrop() {
    cropActive = false;
    cropRect = null;
    const confirmBar = editorOverlay.querySelector("#cropConfirmBar");
    if (confirmBar) confirmBar.style.display = "none";
    // Restore the canvas from the snapshot if we were mid-crop
    if (snapshot && currentTool === "crop") {
      ctx.putImageData(snapshot, 0, 0);
      snapshot = null;
    }
  }

  function confirmCrop() {
    if (!cropRect || cropRect.w < 5 || cropRect.h < 5) {
      cancelCrop();
      return;
    }
    // Restore from snapshot first (remove the overlay drawing)
    if (snapshot) {
      ctx.putImageData(snapshot, 0, 0);
      snapshot = null;
    }
    // Perform the crop
    const cropped = ctx.getImageData(cropRect.x, cropRect.y, cropRect.w, cropRect.h);
    canvas.width = cropRect.w;
    canvas.height = cropRect.h;
    ctx.putImageData(cropped, 0, 0);
    fitCanvasToView();
    cropRect = null;
    cropActive = false;
    const confirmBar = editorOverlay.querySelector("#cropConfirmBar");
    if (confirmBar) confirmBar.style.display = "none";
    saveHistory();
    // Update resize inputs
    editorOverlay.querySelector("#resizeW").value = canvas.width;
    editorOverlay.querySelector("#resizeH").value = canvas.height;
  }

  editorOverlay.querySelector("#cropConfirmBtn").addEventListener("click", confirmCrop);
  editorOverlay.querySelector("#cropCancelBtn").addEventListener("click", cancelCrop);

  // ---- Canvas drawing handlers ----
  canvas.addEventListener("mousedown", (e) => {
    if (currentTool === "select") return;
    if (e.button !== 0) return; // only left click

    const { x, y } = getCanvasCoords(e);
    startX = x;
    startY = y;

    // Text tool: place a text element instead of drawing
    if (currentTool === "text") {
      createTextElement(x, y);
      return;
    }

    isDrawing = true;

    // Save snapshot for shape/crop preview
    if (["rect", "ellipse", "line", "crop"].includes(currentTool)) {
      snapshot = ctx.getImageData(0, 0, canvas.width, canvas.height);
    }

    if (currentTool === "pen" || currentTool === "eraser") {
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      ctx.lineWidth = brushSize;
      ctx.globalAlpha = toolOpacity;
      if (currentTool === "eraser") {
        ctx.globalCompositeOperation = "destination-out";
        ctx.strokeStyle = "rgba(0,0,0,1)";
      } else {
        ctx.globalCompositeOperation = "source-over";
        ctx.strokeStyle = toolColor;
      }
    }

    if (currentTool === "crop") {
      cropActive = true;
      cropRect = { x, y, w: 0, h: 0 };
    }
  });

  canvas.addEventListener("mousemove", (e) => {
    if (!isDrawing && !cropActive) return;
    const { x, y } = getCanvasCoords(e);

    if (currentTool === "pen" || currentTool === "eraser") {
      ctx.lineTo(x, y);
      ctx.stroke();
    } else if (currentTool === "rect") {
      ctx.putImageData(snapshot, 0, 0);
      ctx.globalAlpha = toolOpacity;
      ctx.globalCompositeOperation = "source-over";
      ctx.strokeStyle = toolColor;
      ctx.lineWidth = brushSize;
      ctx.strokeRect(startX, startY, x - startX, y - startY);
    } else if (currentTool === "ellipse") {
      ctx.putImageData(snapshot, 0, 0);
      ctx.globalAlpha = toolOpacity;
      ctx.globalCompositeOperation = "source-over";
      ctx.strokeStyle = toolColor;
      ctx.lineWidth = brushSize;
      ctx.beginPath();
      const cx = (startX + x) / 2;
      const cy = (startY + y) / 2;
      let rx = Math.abs(x - startX) / 2;
      let ry = Math.abs(y - startY) / 2;
      // Shift = circle
      if (shiftPressed) {
        const r = Math.max(rx, ry);
        rx = r; ry = r;
      }
      ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
      ctx.stroke();
    } else if (currentTool === "line") {
      ctx.putImageData(snapshot, 0, 0);
      ctx.globalAlpha = toolOpacity;
      ctx.globalCompositeOperation = "source-over";
      ctx.strokeStyle = toolColor;
      ctx.lineWidth = brushSize;
      ctx.lineCap = "round";
      ctx.beginPath();
      ctx.moveTo(startX, startY);
      ctx.lineTo(x, y);
      ctx.stroke();
    } else if (currentTool === "crop" && cropActive) {
      // Draw crop overlay
      ctx.putImageData(snapshot, 0, 0);

      let cx = Math.min(startX, x);
      let cy = Math.min(startY, y);
      let cw = Math.abs(x - startX);
      let ch = Math.abs(y - startY);

      // Shift = square
      if (shiftPressed) {
        const size = Math.max(cw, ch);
        if (x < startX) cx = startX - size;
        if (y < startY) cy = startY - size;
        cw = size;
        ch = size;
      }

      // Dim everything outside the crop region
      ctx.fillStyle = "rgba(0, 0, 0, 0.6)";
      ctx.fillRect(0, 0, canvas.width, canvas.height);

      // Restore the crop region (clear the dimming inside the selection)
      ctx.putImageData(snapshot, cx, cy, 0, 0, 0, 0); // this doesn't work as expected
      // Actually, we need to clear the dimming inside the crop region and redraw the original
      // Better approach: draw the original image inside the crop region
      ctx.clearRect(cx, cy, cw, ch);
      // Redraw the original image portion
      const tempCanvas = document.createElement("canvas");
      tempCanvas.width = canvas.width;
      tempCanvas.height = canvas.height;
      const tempCtx = tempCanvas.getContext("2d");
      tempCtx.putImageData(snapshot, 0, 0);
      ctx.drawImage(tempCanvas, cx, cy, cw, ch, cx, cy, cw, ch);

      // Draw the crop border
      ctx.strokeStyle = "#4099ff";
      ctx.lineWidth = 2 / editorZoom; // keep border thin regardless of zoom
      ctx.setLineDash([8 / editorZoom, 4 / editorZoom]);
      ctx.strokeRect(cx, cy, cw, ch);
      ctx.setLineDash([]);

      cropRect = { x: cx, y: cy, w: cw, h: ch };
    }
  });

  canvas.addEventListener("mouseup", (e) => {
    if (currentTool === "crop" && cropActive) {
      cropActive = false;
      if (cropRect && cropRect.w > 5 && cropRect.h > 5) {
        // Show confirm bar
        const confirmBar = editorOverlay.querySelector("#cropConfirmBar");
        if (confirmBar) confirmBar.style.display = "flex";
      } else {
        cancelCrop();
      }
      isDrawing = false;
      return;
    }

    if (!isDrawing) return;
    isDrawing = false;
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = "source-over";

    saveHistory();
  });

  // Click outside text element to commit it.
  // NOTE: This handler fires AFTER the canvas mousedown handler (event bubbles
  // from canvas → canvasArea). When the text tool is active and the user
  // clicks on the canvas, the canvas handler creates a new text element. We
  // must NOT commit it here — so we skip if the target is the canvas and the
  // text tool is active (meaning a new text element is being placed).
  canvasArea.addEventListener("mousedown", (e) => {
    if (!activeTextElement) return;
    // If clicking on the canvas with text tool active, the canvas handler
    // will create a new text element — don't commit the current one here
    // (createTextElement handles committing the old one).
    if (e.target === canvas && currentTool === "text") return;
    if (e.target !== activeTextElement && !activeTextElement.contains(e.target)) {
      commitText();
    }
  });

  // ---- Resize ----
  const resizeW = editorOverlay.querySelector("#resizeW");
  const resizeH = editorOverlay.querySelector("#resizeH");
  const resizeLock = editorOverlay.querySelector("#resizeLock");

  resizeW.addEventListener("input", () => {
    if (resizeLock.checked && canvas.width > 0) {
      const ratio = canvas.width / canvas.height;
      resizeH.value = Math.round(parseInt(resizeW.value, 10) / ratio);
    }
  });
  resizeH.addEventListener("input", () => {
    if (resizeLock.checked && canvas.height > 0) {
      const ratio = canvas.width / canvas.height;
      resizeW.value = Math.round(parseInt(resizeH.value, 10) * ratio);
    }
  });

  editorOverlay.querySelector("#resizeApplyBtn").addEventListener("click", () => {
    commitText();
    commitAdjustments();
    const w = parseInt(resizeW.value, 10);
    const h = parseInt(resizeH.value, 10);
    if (!w || !h || w < 1 || h < 1) return;
    const tempCanvas = document.createElement("canvas");
    tempCanvas.width = w;
    tempCanvas.height = h;
    const tempCtx = tempCanvas.getContext("2d");
    tempCtx.imageSmoothingEnabled = true;
    tempCtx.imageSmoothingQuality = "high";
    tempCtx.drawImage(canvas, 0, 0, w, h);
    canvas.width = w;
    canvas.height = h;
    ctx.drawImage(tempCanvas, 0, 0);
    fitCanvasToView();
    saveHistory();
  });

  // ---- Rotate ----
  function rotate(deg) {
    commitText();
    commitAdjustments();
    const tempCanvas = document.createElement("canvas");
    const w = canvas.width, h = canvas.height;
    if (Math.abs(deg) === 90 || Math.abs(deg) === 270) {
      tempCanvas.width = h;
      tempCanvas.height = w;
    } else {
      tempCanvas.width = w;
      tempCanvas.height = h;
    }
    const tempCtx = tempCanvas.getContext("2d");
    tempCtx.translate(tempCanvas.width / 2, tempCanvas.height / 2);
    tempCtx.rotate(deg * Math.PI / 180);
    tempCtx.drawImage(canvas, -w / 2, -h / 2);
    canvas.width = tempCanvas.width;
    canvas.height = tempCanvas.height;
    ctx.drawImage(tempCanvas, 0, 0);
    fitCanvasToView();
    resizeW.value = canvas.width;
    resizeH.value = canvas.height;
    saveHistory();
  }

  editorOverlay.querySelector("#rotateLeftBtn").addEventListener("click", () => rotate(-90));
  editorOverlay.querySelector("#rotateRightBtn").addEventListener("click", () => rotate(90));

  // ---- Flip ----
  function flip(horizontal) {
    commitText();
    commitAdjustments();
    const tempCanvas = document.createElement("canvas");
    tempCanvas.width = canvas.width;
    tempCanvas.height = canvas.height;
    const tempCtx = tempCanvas.getContext("2d");
    if (horizontal) {
      tempCtx.translate(canvas.width, 0);
      tempCtx.scale(-1, 1);
    } else {
      tempCtx.translate(0, canvas.height);
      tempCtx.scale(1, -1);
    }
    tempCtx.drawImage(canvas, 0, 0);
    ctx.drawImage(tempCanvas, 0, 0);
    saveHistory();
  }

  editorOverlay.querySelector("#flipHBtn").addEventListener("click", () => flip(true));
  editorOverlay.querySelector("#flipVBtn").addEventListener("click", () => flip(false));

  // ---- Undo / Redo ----
  editorOverlay.querySelector("#editorUndo").addEventListener("click", undo);
  editorOverlay.querySelector("#editorRedo").addEventListener("click", redo);

  // ---- Save to vault ----
  async function saveImage(exitAfter) {
    commitText();
    commitAdjustments();

    const ext = path.split(".").pop().toLowerCase();
    const mime = ext === "jpg" || ext === "jpeg" ? "image/jpeg"
      : ext === "webp" ? "image/webp"
      : "image/png";
    const quality = (ext === "jpg" || ext === "jpeg") ? 0.92 : undefined;
    const dataUrl = canvas.toDataURL(mime, quality);

    try {
      const res = await fetch("/api/save-image", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path, dataUrl }),
      });
      const data = await res.json();
      if (data.success) {
        if (exitAfter) {
          closeImageEditor();
          // Re-render the image viewer with the updated image (cache-busted)
          viewImage(path);
        } else {
          // Just show a brief confirmation
          const btn = editorOverlay.querySelector("#editorSave");
          const origText = btn.textContent;
          btn.textContent = "✓ Saved";
          setTimeout(() => { btn.textContent = origText; }, 1500);
          // Update the viewer image in the background (if viewer is open behind the editor)
          const viewerImg = document.getElementById("imageViewerImg");
          if (viewerImg) {
            viewerImg.src = "/vault/" + path.replace(/ /g, "%20") + "?t=" + Date.now();
          }
        }
      } else {
        window.showErrorModal("Save Failed", "❌ Save failed: " + (data.error || "Unknown error"));
      }
    } catch (err) {
      window.showErrorModal("Save Error", "❌ Save error: " + err.message);
    }
  }

  editorOverlay.querySelector("#editorSave").addEventListener("click", () => saveImage(false));
  editorOverlay.querySelector("#editorSaveExit").addEventListener("click", () => saveImage(true));

  // ---- Download ----
  editorOverlay.querySelector("#editorDownload").addEventListener("click", () => {
    commitText();
    commitAdjustments();
    const ext = path.split(".").pop().toLowerCase();
    const mime = ext === "jpg" || ext === "jpeg" ? "image/jpeg"
      : ext === "webp" ? "image/webp"
      : "image/png";
    const dataUrl = canvas.toDataURL(mime, 0.92);
    const a = document.createElement("a");
    a.href = dataUrl;
    a.download = path.split("/").pop();
    a.click();
  });

  // ---- Close ----
  editorOverlay.querySelector("#editorCloseBtn").addEventListener("click", closeImageEditor);

  // ---- Keyboard shortcuts ----
  function handleKey(e) {
    if (!editorOverlay) return;
    // Don't intercept if typing in an input/textarea/contenteditable
    // (use isContentEditable for contenteditable divs — more reliable than
    // the [contenteditable] selector which misses some cases)
    if (e.target.matches("input, textarea, select") || e.target.isContentEditable) {
      if (e.key === "Escape" && activeTextElement) {
        commitText();
      }
      return;
    }

    if ((e.ctrlKey || e.metaKey) && e.key === "z" && !e.shiftKey) {
      e.preventDefault(); undo();
    } else if ((e.ctrlKey || e.metaKey) && (e.key === "y" || (e.key === "z" && e.shiftKey))) {
      e.preventDefault(); redo();
    } else if (e.key === "Escape") {
      if (cropRect) {
        cancelCrop();
      } else if (activeTextElement) {
        commitText();
      } else {
        closeImageEditor();
      }
    } else if (e.key === "Enter" && cropRect) {
      e.preventDefault();
      confirmCrop();
    } else if (!e.ctrlKey && !e.metaKey) {
      const toolMap = { v: "select", p: "pen", e: "eraser", t: "text", c: "crop" };
      const tool = toolMap[e.key.toLowerCase()];
      if (tool) {
        const btn = editorOverlay.querySelector(`.tool-btn[data-tool="${tool}"]`);
        if (btn) btn.click();
      }
    }
  }
  document.addEventListener("keydown", handleKey);
  editorOverlay._handleKey = handleKey;

  // Resize handler
  window.addEventListener("resize", fitCanvasToView);
  editorOverlay._fitCanvasToView = fitCanvasToView;
}

export function closeImageEditor() {
  if (editorOverlay) {
    // Run all registered cleanup fns (T3-3) — removes every document-level
    // listener that was added inside openImageEditor (Space/Shift keydown,
    // keyup, mouseup for pan, per-text-element mousemove/mouseup).
    if (editorOverlay._cleanup) {
      for (const fn of editorOverlay._cleanup) {
        try { fn(); } catch (e) { /* listener already removed */ }
      }
      editorOverlay._cleanup = null;
    }
    if (editorOverlay._handleKey) document.removeEventListener("keydown", editorOverlay._handleKey);
    if (editorOverlay._fitCanvasToView) window.removeEventListener("resize", editorOverlay._fitCanvasToView);
    editorOverlay.remove();
    editorOverlay = null;
    // Clear the flag so the main app's keyboard handler resumes
    window._isImageEditorOpen = false;
  }
}

// ======================================================
//  SETUP — listen for "openImage" events
// ======================================================
export function setupImageViewer() {
  document.addEventListener("openImage", (e) => {
    const { path } = e.detail;
    if (path) viewImage(path);
  });
}
