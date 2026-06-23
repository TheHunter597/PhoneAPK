// ======================================================
//  STUDY TIME TRACKER (js/studyTracker.js)
// ======================================================
// Tracks active study time: counts time only when the user is actively
// interacting (mouse move, key press, click, scroll). If idle for 3 minutes,
// stops the clock. Designed for zero performance impact:
//   - Activity listeners use throttled timestamps (no heavy processing)
//   - Single 30s interval to check idle state and accumulate time
//   - All data in localStorage (no server calls)
//
// Shows total study time in the Daily Review Dashboard.
//
// Auto-initializes on DOMContentLoaded — no setup needed.

const IDLE_THRESHOLD_MS = 3 * 60 * 1000; // 3 minutes
const CHECK_INTERVAL_MS = 30 * 1000; // check every 30 seconds
const ACTIVITY_THROTTLE_MS = 5000; // only update timestamp max once per 5s

let lastActivityTime = Date.now();
let lastActivityUpdate = 0;
let isIdle = false;
let checkTimer = null;

// Storage keys
const KEY_TOTAL = "studyTimeTotal"; // total seconds studied (all-time)
const KEY_TODAY = "studyTimeToday"; // { date: "YYYY-MM-DD", seconds: N }
const KEY_SESSION_START = "studyTimeSessionStart"; // timestamp when current session started

function loadTotal() {
  return parseInt(localStorage.getItem(KEY_TOTAL) || "0", 10);
}

function saveTotal(seconds) {
  localStorage.setItem(KEY_TOTAL, String(seconds));
}

function loadToday() {
  try {
    const data = JSON.parse(localStorage.getItem(KEY_TODAY) || "{}");
    const today = new Date().toISOString().slice(0, 10);
    if (data.date !== today) {
      return { date: today, seconds: 0 };
    }
    return data;
  } catch (e) {
    return { date: new Date().toISOString().slice(0, 10), seconds: 0 };
  }
}

function saveToday(data) {
  localStorage.setItem(KEY_TODAY, JSON.stringify(data));
}

function recordActivity() {
  // Throttle: only update the timestamp once per 5 seconds to avoid
  // any performance impact from rapid mouse movements.
  const now = Date.now();
  if (now - lastActivityUpdate < ACTIVITY_THROTTLE_MS) return;
  lastActivityUpdate = now;
  lastActivityTime = now;
  
  // If we were idle, we're now active again
  if (isIdle) {
    isIdle = false;
  }
}

function checkIdleAndAccumulate() {
  const now = Date.now();
  const timeSinceActivity = now - lastActivityTime;
  
  if (timeSinceActivity < IDLE_THRESHOLD_MS) {
    // User is active — accumulate time
    isIdle = false;
    // Add CHECK_INTERVAL_MS seconds (or less if we just became active)
    const secondsToAdd = Math.round(CHECK_INTERVAL_MS / 1000);
    
    const total = loadTotal();
    saveTotal(total + secondsToAdd);
    
    const today = loadToday();
    today.seconds += secondsToAdd;
    saveToday(today);
  } else {
    // User is idle — don't accumulate time
    isIdle = true;
  }
}

function init() {
  // Set up activity listeners (all passive, all throttled)
  // Use capture phase to catch all events, but the handler is trivially
  // cheap (just a timestamp comparison + assignment).
  document.addEventListener("mousemove", recordActivity, { passive: true, capture: true });
  document.addEventListener("keydown", recordActivity, { passive: true, capture: true });
  document.addEventListener("click", recordActivity, { passive: true, capture: true });
  document.addEventListener("scroll", recordActivity, { passive: true, capture: true });
  
  // Also count visibility — if the tab is hidden, don't accumulate
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      // Tab hidden — set lastActivityTime to 0 so we go idle immediately
      lastActivityTime = 0;
    } else {
      // Tab visible again — reset activity time
      lastActivityTime = Date.now();
      lastActivityUpdate = 0;
    }
  });
  
  // Start the check interval
  checkTimer = setInterval(checkIdleAndAccumulate, CHECK_INTERVAL_MS);
  
  // Initialize today's data
  loadToday();
  
  // Expose for the dashboard
  window._studyTracker = {
    getTotalSeconds: () => loadTotal(),
    getTodaySeconds: () => loadToday().seconds,
    isIdle: () => isIdle,
    getIdleThreshold: () => IDLE_THRESHOLD_MS,
    formatTime: formatTime,
  };
}

function formatTime(seconds) {
  if (seconds < 60) return seconds + "s";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return minutes + "m";
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  return hours + "h " + mins + "m";
}

// Auto-init
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init);
} else {
  init();
}
