// ======================================================
//  COW COMPANION (js/animals.js) — One polished cow
// ======================================================
//
// A single cute cow that roams the viewport in 2D with:
//  - Gradient-shaded body (3D look)
//  - Two-segment articulated legs (upper + lower, with knee joints)
//  - Wagging tail
//  - Blinking eyes
//  - Proper sleeping pose (lying down, legs folded, Zzz)
//  - Eating pose (head down, munching grass)
//  - Realistic speeds (slow walking, not hyperactive)

const STATES = ["walking", "eating", "sleeping", "walking", "walking", "tired"];

let cow = null;
let isRunning = false;
let tickInterval = null;
let container = null;
let blinkTimer = null;

function rand(min, max) { return Math.random() * (max - min) + min; }
function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }
function clamp(v, min, max) { return Math.max(min, Math.min(max, v)); }

// ======================================================
//  COW SVG — detailed, with gradients, connected legs, tail
// ======================================================

function cowSVG() {
  return `
  <svg viewBox="0 0 120 90" class="cow-svg" xmlns="http://www.w3.org/2000/svg">
    <defs>
      <linearGradient id="cowBodyGrad" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="#ffffff"/>
        <stop offset="60%" stop-color="#f5f5f5"/>
        <stop offset="100%" stop-color="#e0e0e0"/>
      </linearGradient>
      <linearGradient id="cowHeadGrad" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="#ffffff"/>
        <stop offset="100%" stop-color="#e8e8e8"/>
      </linearGradient>
      <linearGradient id="cowLegGrad" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="#3a3a3a"/>
        <stop offset="100%" stop-color="#1a1a1a"/>
      </linearGradient>
      <radialGradient id="cowShadowGrad">
        <stop offset="0%" stop-color="rgba(0,0,0,0.25)"/>
        <stop offset="100%" stop-color="rgba(0,0,0,0)"/>
      </radialGradient>
    </defs>

    <!-- Shadow -->
    <ellipse class="cow-shadow" cx="55" cy="82" rx="35" ry="5" fill="url(#cowShadowGrad)"/>

    <!-- Tail (behind body) -->
    <g class="cow-tail">
      <path d="M78,28 Q90,25 92,35 Q93,42 88,45" fill="none" stroke="#3a3a3a" stroke-width="2.5" stroke-linecap="round"/>
      <circle cx="88" cy="45" r="3.5" fill="#3a3a3a"/>
    </g>

    <!-- Back legs (behind body) -->
    <g class="cow-legs-back">
      <!-- Back-left leg: upper + lower -->
      <g class="leg-pair leg-back-left" transform="translate(68, 40)">
        <rect class="leg-upper" x="-2.5" y="0" width="5" height="16" rx="2.5" fill="url(#cowLegGrad)"/>
        <g class="leg-lower-joint" transform="translate(0, 16)">
          <rect class="leg-lower" x="-2.5" y="0" width="5" height="14" rx="2.5" fill="url(#cowLegGrad)"/>
          <ellipse class="hoof" cx="0" cy="14" rx="3.5" ry="2" fill="#1a1a1a"/>
        </g>
      </g>
      <!-- Back-right leg -->
      <g class="leg-pair leg-back-right" transform="translate(75, 40)">
        <rect class="leg-upper" x="-2.5" y="0" width="5" height="16" rx="2.5" fill="url(#cowLegGrad)"/>
        <g class="leg-lower-joint" transform="translate(0, 16)">
          <rect class="leg-lower" x="-2.5" y="0" width="5" height="14" rx="2.5" fill="url(#cowLegGrad)"/>
          <ellipse class="hoof" cx="0" cy="14" rx="3.5" ry="2" fill="#1a1a1a"/>
        </g>
      </g>
    </g>

    <!-- Body -->
    <ellipse class="cow-body" cx="50" cy="35" rx="34" ry="17" fill="url(#cowBodyGrad)" stroke="#ccc" stroke-width="0.5"/>

    <!-- Black spots -->
    <ellipse class="cow-spot spot1" cx="40" cy="28" rx="8" ry="6" fill="#2a2a2a" opacity="0.85"/>
    <ellipse class="cow-spot spot2" cx="62" cy="36" rx="6" ry="5" fill="#2a2a2a" opacity="0.85"/>
    <ellipse class="cow-spot spot3" cx="48" cy="42" rx="4" ry="3" fill="#2a2a2a" opacity="0.8"/>

    <!-- Udder -->
    <ellipse class="cow-udder" cx="55" cy="48" rx="6" ry="4" fill="#ffb3c1" opacity="0.85"/>

    <!-- Front legs (in front of body) -->
    <g class="cow-legs-front">
      <!-- Front-left leg -->
      <g class="leg-pair leg-front-left" transform="translate(28, 40)">
        <rect class="leg-upper" x="-2.5" y="0" width="5" height="16" rx="2.5" fill="url(#cowLegGrad)"/>
        <g class="leg-lower-joint" transform="translate(0, 16)">
          <rect class="leg-lower" x="-2.5" y="0" width="5" height="14" rx="2.5" fill="url(#cowLegGrad)"/>
          <ellipse class="hoof" cx="0" cy="14" rx="3.5" ry="2" fill="#1a1a1a"/>
        </g>
      </g>
      <!-- Front-right leg -->
      <g class="leg-pair leg-front-right" transform="translate(36, 40)">
        <rect class="leg-upper" x="-2.5" y="0" width="5" height="16" rx="2.5" fill="url(#cowLegGrad)"/>
        <g class="leg-lower-joint" transform="translate(0, 16)">
          <rect class="leg-lower" x="-2.5" y="0" width="5" height="14" rx="2.5" fill="url(#cowLegGrad)"/>
          <ellipse class="hoof" cx="0" cy="14" rx="3.5" ry="2" fill="#1a1a1a"/>
        </g>
      </g>
    </g>

    <!-- Head group (separate so it can move independently) -->
    <g class="cow-head-group" transform="translate(16, 28)">
      <!-- Ears (behind head) -->
      <ellipse class="cow-ear ear-left" cx="-4" cy="-7" rx="3" ry="5" fill="#f0f0f0" stroke="#ddd" stroke-width="0.5" transform="rotate(-35 -4 -7)"/>
      <ellipse class="cow-ear ear-right" cx="10" cy="-7" rx="3" ry="5" fill="#f0f0f0" stroke="#ddd" stroke-width="0.5" transform="rotate(35 10 -7)"/>

      <!-- Horns -->
      <path d="M0,-8 Q-4,-15 0,-17" fill="none" stroke="#e8d5b7" stroke-width="2.5" stroke-linecap="round"/>
      <path d="M6,-8 Q10,-15 6,-17" fill="none" stroke="#e8d5b7" stroke-width="2.5" stroke-linecap="round"/>

      <!-- Head -->
      <ellipse class="cow-head" cx="3" cy="0" rx="12" ry="10" fill="url(#cowHeadGrad)" stroke="#ccc" stroke-width="0.5"/>

      <!-- Black patch on head -->
      <path d="M-2,-6 Q5,-8 8,-3 Q6,0 0,-1 Q-3,-3 -2,-6" fill="#2a2a2a" opacity="0.85"/>

      <!-- Snout -->
      <ellipse class="cow-snout" cx="-4" cy="4" rx="6" ry="5" fill="#ffc8d1" opacity="0.9"/>
      <circle class="nostril" cx="-6" cy="3" r="0.9" fill="#b36677"/>
      <circle class="nostril" cx="-2" cy="4" r="0.9" fill="#b36677"/>

      <!-- Eye (with blink) -->
      <g class="cow-eye-group">
        <ellipse class="cow-eye" cx="5" cy="-2" rx="2.5" ry="3" fill="#fff"/>
        <circle class="cow-pupil" cx="5.5" cy="-1.5" r="1.5" fill="#1a1a1a"/>
        <circle class="cow-eye-shine" cx="6" cy="-2.5" r="0.6" fill="#fff"/>
        <rect class="cow-eyelid" x="2" y="-5" width="6" height="0" rx="1" fill="url(#cowHeadGrad)"/>
      </g>
    </g>
  </svg>`;
}

// ======================================================
//  COW CLASS
// ======================================================

class Cow {
  constructor() {
    this.state = "walking";
    // 2D position (% of viewport)
    this.x = 15;
    this.y = 75;
    // 2D velocity (slow, calm cow)
    this.vx = rand(0.08, 0.15);
    this.vy = 0;
    this.stateTimer = 0;
    this.stateDuration = rand(5000, 12000); // 5-12 seconds per state
    this.wanderTimer = 0;
    this.facing = 1; // 1 = right, -1 = left
    this.blinkCooldown = rand(2000, 5000);

    // Create DOM element
    this.el = document.createElement("div");
    this.el.className = "animal animal-cow";
    this.el.innerHTML = cowSVG();
    this.el.style.width = "100px";
    this.el.style.height = "75px";
    this.updatePosition();
    this.applyState();
    container.appendChild(this.el);
  }

  applyState() {
    this.el.classList.remove(
      "state-walking", "state-eating", "state-sleeping", "state-running", "state-tired"
    );
    this.el.classList.add("state-" + this.state);

    // Clear particles
    this.el.querySelectorAll(".particle").forEach(p => p.remove());

    if (this.state === "sleeping") {
      for (let i = 0; i < 3; i++) {
        const z = document.createElement("span");
        z.className = "particle zzz";
        z.textContent = "z";
        z.style.animationDelay = (i * 0.6) + "s";
        z.style.fontSize = (0.8 + i * 0.3) + "rem";
        this.el.appendChild(z);
      }
    } else if (this.state === "eating") {
      for (let i = 0; i < 3; i++) {
        const m = document.createElement("span");
        m.className = "particle munch";
        m.textContent = "🌿";
        m.style.animationDelay = (i * 0.5) + "s";
        this.el.appendChild(m);
      }
    } else if (this.state === "tired") {
      const s = document.createElement("span");
      s.className = "particle sweat";
      s.textContent = "💦";
      this.el.appendChild(s);
    }

    // Adjust speed based on state
    if (this.state === "eating" || this.state === "sleeping") {
      this.vx = 0; this.vy = 0;
    } else if (this.state === "tired") {
      this.vx *= 0.3; this.vy *= 0.3;
    } else if (this.state === "walking") {
      const speed = Math.hypot(this.vx, this.vy);
      if (speed < 0.05) {
        this.vx = rand(0.06, 0.15) * (Math.random() > 0.5 ? 1 : -1);
        this.vy = rand(-0.02, 0.02);
      }
    }
  }

  tick(dt) {
    this.stateTimer += dt;
    this.wanderTimer += dt;
    this.blinkCooldown -= dt;

    // Blink
    if (this.blinkCooldown <= 0) {
      this.blink();
      this.blinkCooldown = rand(2000, 6000);
    }

    // State transition
    if (this.stateTimer >= this.stateDuration) {
      let newState = this.state;
      let tries = 0;
      while (newState === this.state && tries < 5) {
        newState = pick(STATES);
        tries++;
      }
      this.state = newState;
      this.stateTimer = 0;
      this.stateDuration = rand(5000, 12000);
      this.applyState();
    }

    // Random wandering — gentle direction changes
    if (this.wanderTimer > 800 && (this.state === "walking" || this.state === "tired")) {
      this.wanderTimer = 0;
      this.vx += rand(-0.03, 0.03);
      this.vy += rand(-0.02, 0.02);
      // Clamp to slow cow speed
      const speed = Math.hypot(this.vx, this.vy);
      const maxSpeed = this.state === "tired" ? 0.08 : 0.2;
      if (speed > maxSpeed) {
        this.vx = (this.vx / speed) * maxSpeed;
        this.vy = (this.vy / speed) * maxSpeed;
      }
    }

    // Move
    if (this.vx !== 0 || this.vy !== 0) {
      this.x += this.vx * (dt / 30);
      this.y += this.vy * (dt / 30);

      // Bounce off viewport edges (keep cow in lower 60% of screen)
      if (this.x < 3) { this.x = 3; this.vx = Math.abs(this.vx); }
      if (this.x > 94) { this.x = 94; this.vx = -Math.abs(this.vx); }
      if (this.y < 35) { this.y = 35; this.vy = Math.abs(this.vy); }
      if (this.y > 88) { this.y = 88; this.vy = -Math.abs(this.vy); }

      this.updatePosition();
    }
  }

  blink() {
    const eyelid = this.el.querySelector(".cow-eyelid");
    if (!eyelid) return;
    eyelid.style.transition = "height 0.08s ease-in";
    eyelid.setAttribute("height", "6");
    setTimeout(() => {
      eyelid.style.transition = "height 0.12s ease-out";
      eyelid.setAttribute("height", "0");
    }, 100);
  }

  updatePosition() {
    this.el.style.left = this.x + "%";
    this.el.style.top = this.y + "%";

    // Face direction of horizontal movement
    const newFacing = this.vx < -0.01 ? -1 : 1;
    if (newFacing !== this.facing) {
      this.facing = newFacing;
      this.el.dataset.facing = newFacing;
    }
  }

  remove() {
    if (this.el && this.el.parentNode) {
      this.el.parentNode.removeChild(this.el);
    }
  }
}

// ======================================================
//  PUBLIC API
// ======================================================

export function startAnimals() {
  if (isRunning) return;
  isRunning = true;

  container = document.getElementById("animal-container");
  if (!container) {
    container = document.createElement("div");
    container.id = "animal-container";
    container.className = "animal-container";
    document.body.appendChild(container);
  }
  container.style.display = "block";

  cow = new Cow();

  let lastTime = Date.now();
  tickInterval = setInterval(() => {
    const now = Date.now();
    const dt = Math.min(now - lastTime, 100);
    lastTime = now;
    if (cow) cow.tick(dt);
  }, 50);
}

export function stopAnimals() {
  if (!isRunning) return;
  isRunning = false;
  if (tickInterval) { clearInterval(tickInterval); tickInterval = null; }
  if (cow) { cow.remove(); cow = null; }
  if (container) container.style.display = "none";
}

export function isAnimalsRunning() {
  return isRunning;
}
