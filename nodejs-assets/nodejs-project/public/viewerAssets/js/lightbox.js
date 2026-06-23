// ======================================================
//  IMAGE LIGHTBOX (with brightness support) (js/lightbox.js)
// ======================================================
export function setupLightbox() {
  const overlay = document.createElement("div");
  overlay.className = "image-lightbox";
  overlay.innerHTML = `
        <button class="close-btn">&times;</button>
        <div class="lightbox-content">
            <img src="" alt="lightbox" id="lightbox-img" />
        </div>
        <div class="zoom-indicator">100%</div>
        <div class="instructions">Scroll to zoom · Drag to pan · Double‑click to reset</div>
    `;
  document.body.appendChild(overlay);

  const img = overlay.querySelector("#lightbox-img");
  const closeBtn = overlay.querySelector(".close-btn");
  const zoomIndicator = overlay.querySelector(".zoom-indicator");
  const instructions = overlay.querySelector(".instructions");

  let scale = 1;
  let translateX = 0;
  let translateY = 0;
  let isDragging = false;
  let startX, startY, startTranslateX, startTranslateY;

  function updateTransform() {
    img.style.transform = `translate(${translateX}px, ${translateY}px) scale(${scale})`;
    zoomIndicator.textContent = Math.round(scale * 100) + "%";
    zoomIndicator.classList.add("show");
    clearTimeout(zoomIndicator._hideTimeout);
    zoomIndicator._hideTimeout = setTimeout(() => {
      zoomIndicator.classList.remove("show");
    }, 1500);
  }

  function resetTransform() {
    scale = 1;
    translateX = 0;
    translateY = 0;
    updateTransform();
  }

  function applyImageBrightnessToLightbox() {
    const brightness =
      parseFloat(localStorage.getItem("imgBrightness")) || 0.85;
    img.style.filter = `brightness(${brightness})`;
  }

  function openLightbox(src) {
    img.src = src;
    resetTransform();
    applyImageBrightnessToLightbox();
    overlay.classList.add("active");
    setTimeout(() => {
      instructions.style.opacity = "0";
    }, 4000);
  }

  function closeLightbox() {
    overlay.classList.remove("active");
    img.src = "";
    resetTransform();
    instructions.style.opacity = "1";
  }

  document.addEventListener("click", function (e) {
    // Don't open the lightbox when in editing mode
    if (window._isEditing === true) return;
    var editable = document.getElementById("editableNote");
    if (editable && editable.contains(e.target)) return;
    if (e.target.closest(".note-content img")) {
      const imgElement = e.target.closest(".note-content img");
      const src = imgElement.src;
      if (src) {
        e.preventDefault();
        openLightbox(src);
      }
    }
  });

  closeBtn.addEventListener("click", closeLightbox);

  overlay.addEventListener("click", function (e) {
    if (
      e.target === overlay ||
      e.target === overlay.querySelector(".lightbox-content")
    ) {
      closeLightbox();
    }
  });

  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape" && overlay.classList.contains("active")) {
      closeLightbox();
    }
  });

  overlay.addEventListener(
    "wheel",
    function (e) {
      if (!overlay.classList.contains("active")) return;
      e.preventDefault();
      const delta = e.deltaY > 0 ? -0.1 : 0.1;
      const newScale = Math.min(Math.max(scale + delta, 0.2), 5);
      if (newScale !== scale) {
        const rect = img.getBoundingClientRect();
        const mouseX = e.clientX - rect.left;
        const mouseY = e.clientY - rect.top;
        const ratioX = mouseX / rect.width;
        const ratioY = mouseY / rect.height;
        const oldScale = scale;
        const newScaleValue = newScale;
        const dx =
          (1 - newScaleValue / oldScale) *
          (rect.width / 2 - rect.width * ratioX);
        const dy =
          (1 - newScaleValue / oldScale) *
          (rect.height / 2 - rect.height * ratioY);
        translateX += dx;
        translateY += dy;
        scale = newScaleValue;
        updateTransform();
      }
    },
    { passive: false },
  );

  img.addEventListener("mousedown", function (e) {
    if (scale === 1) return;
    isDragging = true;
    startX = e.clientX;
    startY = e.clientY;
    startTranslateX = translateX;
    startTranslateY = translateY;
    img.style.cursor = "grabbing";
    e.preventDefault();
  });

  document.addEventListener("mousemove", function (e) {
    if (!isDragging) return;
    const dx = e.clientX - startX;
    const dy = e.clientY - startY;
    translateX = startTranslateX + dx;
    translateY = startTranslateY + dy;
    updateTransform();
  });

  document.addEventListener("mouseup", function () {
    if (isDragging) {
      isDragging = false;
      img.style.cursor = "grab";
    }
  });

  img.addEventListener("dblclick", function (e) {
    if (scale > 1) {
      resetTransform();
    } else {
      const rect = img.getBoundingClientRect();
      const x = (e.clientX - rect.left) / rect.width;
      const y = (e.clientY - rect.top) / rect.height;
      const oldScale = scale;
      const newScale = 2;
      const dx = (1 - newScale / oldScale) * (rect.width / 2 - rect.width * x);
      const dy =
        (1 - newScale / oldScale) * (rect.height / 2 - rect.height * y);
      translateX += dx;
      translateY += dy;
      scale = newScale;
      updateTransform();
    }
  });

  overlay.addEventListener("transitionend", function () {
    if (!overlay.classList.contains("active")) {
      resetTransform();
    }
  });
}
