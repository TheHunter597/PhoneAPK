// (serverAssets/backup.js) Schedules automated backups via setInterval.
//
// Mobile patch: the desktop version uses node-cron for cron-syntax scheduling.
// node-cron pulls in dependencies that don't work well under nodejs-mobile's
// restricted environment. We replace it with a setInterval-based scheduler
// that fires the same backup types at the same intervals:
//   six_hour    → every 6 hours
//   daily       → every 24 hours
//   three_day   → every 72 hours
//   weekly      → every 168 hours
// Timezone handling is dropped (we use device-local time, which is the same
// timezone Obsidian on the phone would use).
//
// The retry/overdue logic is unchanged.

const {
  performBackup,
  getAllBackupState,
  startRetryScheduler,
  BACKUP_TYPES,
} = require("../scripts/backup");
const { vaultPath, backupRoot, config } = require("./config");

// Interval in milliseconds for each backup type.
const BACKUP_INTERVALS_MS = {
  six_hour: 6 * 60 * 60 * 1000,   // 6h
  daily: 24 * 60 * 60 * 1000,     // 24h
  three_day: 3 * 24 * 60 * 60 * 1000, // 72h
  weekly: 7 * 24 * 60 * 60 * 1000, // 168h
};

// For API compatibility with code that reads CRON_SCHEDULES / CRON_LABELS.
const CRON_SCHEDULES = {
  six_hour: "every 6h",
  daily: "every 24h",
  three_day: "every 72h",
  weekly: "every 168h",
};
const CRON_LABELS = {
  six_hour: "Every 6 hours",
  daily: "Daily",
  three_day: "Every 3 days",
  weekly: "Weekly",
};

const TIMEZONE = config.backupTimezone || config.timezone || undefined;

// Keep references to the active setInterval timers so scheduleBackups() can
// be called multiple times safely (we clear previous timers first).
const _timers = [];

function scheduleBackups() {
  // Clear any timers from a previous scheduleBackups() call (e.g. after a
  // vault path change at runtime).
  for (const t of _timers) clearInterval(t);
  _timers.length = 0;

  for (const type of BACKUP_TYPES) {
    const intervalMs = BACKUP_INTERVALS_MS[type];
    if (!intervalMs) continue;
    const timer = setInterval(async () => {
      console.log(`🔄 Starting scheduled ${type} backup at ${new Date().toISOString()}`);
      try {
        const result = await performBackup(vaultPath, backupRoot, type);
        if (result.success) {
          console.log(`✅ ${type} backup completed`);
        } else {
          console.error(`❌ ${type} backup failed: ${result.error}`);
        }
      } catch (err) {
        console.error(`❌ ${type} backup threw:`, err.message);
      }
    }, intervalMs);
    _timers.push(timer);
    console.log(
      `⏰ Scheduled ${type} backup: every ${intervalMs / 3600000}h` +
      (TIMEZONE ? ` (device tz=${TIMEZONE})` : ""),
    );
  }

  startRetryScheduler(vaultPath, backupRoot);

  // Overdue checker — runs every 15 minutes to catch backups that were
  // missed because the app was closed at the scheduled time.
  const overdueTimer = setInterval(
    async () => {
      try {
        await runOverdueBackups();
      } catch (err) {
        console.error("Overdue check error:", err.message);
      }
    },
    15 * 60 * 1000,
  );
  _timers.push(overdueTimer);
  console.log("⏰ Overdue backup checker started (every 15 minutes)");
}

function isOverdue(type, state) {
  if (!state || !state.lastRun) return true;
  const interval = BACKUP_INTERVALS_MS[type];
  if (!interval) return false;
  const lastRunMs = new Date(state.lastRun).getTime();
  return Date.now() - lastRunMs > interval + 5 * 60 * 1000;
}

async function runOverdueBackups() {
  const state = getAllBackupState(vaultPath);
  const overdue = BACKUP_TYPES.filter((t) => isOverdue(t, state[t]));
  if (overdue.length === 0) return;
  console.log(`🔄 Overdue backups detected: ${overdue.join(", ")}`);
  for (const type of overdue) {
    console.log(`🔄 Running overdue ${type} backup…`);
    const result = await performBackup(vaultPath, backupRoot, type);
    if (result.success) {
      console.log(`✅ Overdue ${type} backup completed.`);
    } else {
      console.error(`❌ Overdue ${type} backup failed: ${result.error}`);
    }
  }
}

async function runInitialBackupsIfNeeded() {
  await runOverdueBackups();
}

module.exports = {
  scheduleBackups,
  runInitialBackupsIfNeeded,
  runOverdueBackups,
  backupTypes: BACKUP_TYPES,
  cronSchedules: CRON_SCHEDULES,
  cronLabels: CRON_LABELS,
  timezone: TIMEZONE,
};
