// (scripts/backup.js) Robust vault backup with:
//  - Global mutex (no concurrent backups colliding on the same backupRoot)
//  - Atomic state file writes (temp + rename)
//  - Atomic backup swap (old backup survives until the new one is fully ready)
//  - Configurable ZIP level (default fast level 1, was 9)
//  - No artificial throttle (was 10ms/file = huge slowdown on big vaults)
//  - Detailed state: lastError, durationMs, fileCount, retryCount, nextRetryAt
//  - Retry with exponential backoff (5m, 15m, 1h, 4h, 24h) and a max of 5

const fs = require("fs-extra");
const path = require("path");

// Try to load archiver for ZIP support.
let archiverLib = null;
try {
  const mod = require("archiver");
  if (typeof mod === "function") {
    archiverLib = mod;
  } else if (mod && typeof mod.default === "function") {
    archiverLib = mod.default;
  } else {
    console.warn(
      "⚠️ archiver is installed but does not export a function. ZIP will be skipped.",
    );
  }
} catch (e) {
  console.warn("⚠️ archiver is not installed. ZIP will be skipped.");
}

const IGNORED_DIRS = new Set([
  ".git",
  ".claude",
  ".claudian",
  ".trash",
  "node_modules",
]);
const DATA_DIR = path.join(__dirname, "..", "data");

// Vault-specific state file. The vault name is derived from the vault path
// (last folder segment, sanitized for use as a filename). This ensures each
// vault has its own backup state — switching vaults doesn't lose the backup
// history of the previous vault.
function getVaultName(vaultPath) {
  return path.basename(vaultPath).replace(/[^a-zA-Z0-9_-]/g, "_") || "default";
}

function getStateFile(vaultPath) {
  const vaultName = getVaultName(vaultPath);
  return path.join(DATA_DIR, `backup_state_${vaultName}.json`);
}

// Legacy state file (for migration)
const STATE_FILE_LEGACY = path.join(DATA_DIR, "backup_state.json");

// ZIP compression level (1 = fastest, 9 = smallest). Level 1 is ~10x faster
// than level 9 with only marginally larger output — important for big vaults.
const ZIP_LEVEL = 1;

// Retry backoff schedule (ms): 5min, 15min, 1h, 4h, 24h.
const RETRY_DELAYS = [
  5 * 60 * 1000,
  15 * 60 * 1000,
  60 * 60 * 1000,
  4 * 60 * 60 * 1000,
  24 * 60 * 60 * 1000,
];
const MAX_RETRIES = RETRY_DELAYS.length;

const BACKUP_TYPES = ["six_hour", "daily", "three_day", "weekly"];

// ---------------------------------------------------------------------------
// Global mutex: only one backup runs at a time. Backups write to the same
// backupRoot and the previous code could collide when (e.g.) daily + weekly
// both fired at Sunday midnight.
// ---------------------------------------------------------------------------
let backupLock = Promise.resolve();
function withBackupLock(fn) {
  const run = backupLock.then(fn, fn); // run regardless of previous outcome
  backupLock = run.catch(() => {}); // swallow so the lock never breaks
  return run;
}

// ---------------------------------------------------------------------------
// State (per backup type)
// ---------------------------------------------------------------------------
let backupState = {};
for (const t of BACKUP_TYPES) {
  backupState[t] = {
    lastRun: null,
    lastSuccess: null,
    success: false,
    lastError: null,
    durationMs: 0,
    fileCount: 0,
    retryCount: 0,
    nextRetryAt: null,
  };
}

// State is loaded per-vault. We keep a cache keyed by vault name.
const stateCache = {};

function loadState(vaultPath) {
  const stateFile = getStateFile(vaultPath);
  // Check cache first
  if (stateCache[vaultPath]) return stateCache[vaultPath];

  let state = {};
  for (const t of BACKUP_TYPES) {
    state[t] = {
      lastRun: null,
      lastSuccess: null,
      success: false,
      lastError: null,
      durationMs: 0,
      fileCount: 0,
      retryCount: 0,
      nextRetryAt: null,
    };
  }

  try {
    // Try vault-specific state file first
    if (fs.existsSync(stateFile)) {
      const data = JSON.parse(fs.readFileSync(stateFile, "utf8"));
      for (const t of BACKUP_TYPES) {
        if (data[t]) {
          state[t] = { ...state[t], ...data[t] };
          if (state[t].success && state[t].lastRun && !state[t].lastSuccess) {
            state[t].lastSuccess = state[t].lastRun;
          }
        }
      }
    } else if (fs.existsSync(STATE_FILE_LEGACY)) {
      // Migrate from legacy state file (first time loading a vault that used
      // the old single-state-file system)
      console.log("📦 Migrating backup state from legacy file...");
      const data = JSON.parse(fs.readFileSync(STATE_FILE_LEGACY, "utf8"));
      for (const t of BACKUP_TYPES) {
        if (data[t]) {
          state[t] = { ...state[t], ...data[t] };
        }
      }
    }
  } catch (err) {
    console.warn("Could not load backup state:", err.message);
  }

  stateCache[vaultPath] = state;
  return state;
}

function saveState(vaultPath) {
  try {
    fs.ensureDirSync(DATA_DIR);
    const stateFile = getStateFile(vaultPath);
    const tmp = stateFile + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(stateCache[vaultPath] || {}, null, 2));
    fs.renameSync(tmp, stateFile);
  } catch (err) {
    console.error("Could not save backup state:", err.message);
  }
}

// Initialize state for the default vault (loaded lazily in performBackup)

// ---------------------------------------------------------------------------
// Copy helpers
// ---------------------------------------------------------------------------
function copyFilter(src) {
  const basename = path.basename(src);
  // Ignore explicitly-listed dirs AND any dotfolder (.obsidian, .stfolder, etc.)
  return !IGNORED_DIRS.has(basename) && !basename.startsWith(".");
}

async function copyVault(src, dest) {
  // fs.copy is already async and handles backpressure; no artificial throttle.
  await fs.copy(src, dest, {
    filter: copyFilter,
    overwrite: true,
    errorOnExist: false,
    preserveTimestamps: true,
  });
  return await countFiles(dest);
}

async function countFiles(dir) {
  let count = 0;
  try {
    const items = await fs.readdir(dir, { withFileTypes: true });
    for (const item of items) {
      const full = path.join(dir, item.name);
      if (item.isDirectory()) {
        count += await countFiles(full);
      } else {
        count++;
      }
    }
  } catch (err) {
    // ignore — directory may have been removed mid-scan
  }
  return count;
}

async function zipDirectory(sourceDir, zipPath) {
  if (!archiverLib) return false;
  return new Promise((resolve) => {
    const output = fs.createWriteStream(zipPath);
    const archive = archiverLib("zip", { zlib: { level: ZIP_LEVEL } });
    let settled = false;
    const done = (ok) => {
      if (settled) return;
      settled = true;
      if (!ok) fs.remove(zipPath).catch(() => {});
      resolve(ok);
    };
    output.on("close", () => done(true));
    output.on("error", () => done(false));
    archive.on("error", (err) => {
      console.error("ZIP error:", err.message);
      done(false);
    });
    archive.pipe(output);
    archive.directory(sourceDir, false);
    archive.finalize();
  });
}

// ---------------------------------------------------------------------------
// Perform a single backup (atomic: old backup is NOT removed until the new
// one is fully ready).
// ---------------------------------------------------------------------------
async function performBackup(vaultPath, backupRoot, type) {
  return withBackupLock(async () => {
    const startedAt = Date.now();
    // Vault-specific backup subfolder: backupRoot/[vaultName]/
    const vaultName = getVaultName(vaultPath);
    const vaultBackupDir = path.join(backupRoot, vaultName);
    const tempDir = path.join(vaultBackupDir, `temp_${type}`);
    const finalDest = path.join(vaultBackupDir, type);
    const zipPath = path.join(vaultBackupDir, `${type}.zip`);
    const zipNewPath = path.join(vaultBackupDir, `${type}.zip.new`);

    // Load vault-specific state
    const backupState = loadState(vaultPath);

    try {
      if (!fs.existsSync(vaultPath)) {
        throw new Error(`Vault path does not exist: ${vaultPath}`);
      }
      await fs.ensureDir(vaultBackupDir);

      // Clean leftovers from a previous crashed run (temp dir + .new zip).
      await fs.remove(tempDir).catch(() => {});
      await fs.remove(zipNewPath).catch(() => {});

      // 1. Copy vault → temp dir.
      await fs.ensureDir(tempDir);
      const fileCount = await copyVault(vaultPath, tempDir);

      // 2. Zip to a .new file (so the old zip survives if this fails).
      let zipped = false;
      if (archiverLib) {
        zipped = await zipDirectory(tempDir, zipNewPath);
      }

      // 3. Atomic swap: put the new backup in place, THEN remove the old one.
      if (zipped) {
        await fs.remove(zipPath).catch(() => {});
        await fs.move(zipNewPath, zipPath, { overwrite: true });
        await fs.remove(tempDir).catch(() => {});
        await fs.remove(finalDest).catch(() => {});
      } else {
        // ZIP unavailable/failed → keep uncompressed folder as the backup.
        await fs.remove(finalDest).catch(() => {});
        await fs.move(tempDir, finalDest, { overwrite: true });
        await fs.remove(zipPath).catch(() => {});
      }

      const durationMs = Date.now() - startedAt;
      const now = new Date().toISOString();
      backupState[type] = {
        lastRun: now,
        lastSuccess: now,
        success: true,
        lastError: null,
        durationMs,
        fileCount,
        retryCount: 0,
        nextRetryAt: null,
      };
      stateCache[vaultPath] = backupState;
      saveState(vaultPath);
      console.log(
        `✅ ${type} backup completed for vault "${vaultName}": ${fileCount} files, ${durationMs}ms, ${zipped ? "zipped" : "uncompressed"}`,
      );
      return {
        success: true,
        timestamp: now,
        type,
        durationMs,
        fileCount,
        zipped,
      };
    } catch (err) {
      const durationMs = Date.now() - startedAt;
      const now = new Date().toISOString();
      const prev = backupState[type] || {};
      const retryCount = (prev.retryCount || 0) + 1;
      const nextRetryAt =
        retryCount <= MAX_RETRIES
          ? new Date(Date.now() + RETRY_DELAYS[retryCount - 1]).toISOString()
          : null;

      backupState[type] = {
        lastRun: now,
        lastSuccess: prev.lastSuccess || null,
        success: false,
        lastError: err.message,
        durationMs,
        fileCount: 0,
        retryCount,
        nextRetryAt,
      };
      stateCache[vaultPath] = backupState;
      saveState(vaultPath);
      console.error(`❌ ${type} backup failed for vault "${vaultName}" (${durationMs}ms):`, err.message);

      // Clean up partial temp artifacts (old backup is untouched).
      await fs.remove(tempDir).catch(() => {});
      await fs.remove(zipNewPath).catch(() => {});

      return {
        success: false,
        timestamp: now,
        type,
        error: err.message,
        durationMs,
      };
    }
  });
}

function getBackupState(type, vaultPath) {
  const state = loadState(vaultPath);
  return state[type] || { lastRun: null, success: false };
}

function getAllBackupState(vaultPath) {
  const state = loadState(vaultPath);
  return JSON.parse(JSON.stringify(state));
}

/**
 * Retry failed backups whose nextRetryAt has elapsed. Called periodically by
 * the retry scheduler.
 */
async function retryFailedBackups(vaultPath, backupRoot) {
  const now = Date.now();
  const backupState = loadState(vaultPath);
  for (const type of BACKUP_TYPES) {
    const state = backupState[type];
    if (!state.success && state.nextRetryAt) {
      const nextTime = new Date(state.nextRetryAt).getTime();
      if (now >= nextTime) {
        console.log(
          `🔄 Retrying failed ${type} backup (attempt ${state.retryCount + 1}/${MAX_RETRIES})`,
        );
        await performBackup(vaultPath, backupRoot, type);
      }
    } else if (!state.success && !state.nextRetryAt && state.lastRun) {
      const lastRunTime = new Date(state.lastRun).getTime();
      if (now - lastRunTime > 6 * 60 * 60 * 1000) {
        console.log(`🔄 Scheduled retry for exhausted ${type} backup`);
        await performBackup(vaultPath, backupRoot, type);
      }
    }
  }
}

function startRetryScheduler(vaultPath, backupRoot) {
  // Check every 5 minutes for due retries (more responsive than the old 30min).
  setInterval(
    async () => {
      try {
        await retryFailedBackups(vaultPath, backupRoot);
      } catch (err) {
        console.error("Retry scheduler error:", err.message);
      }
    },
    5 * 60 * 1000,
  );
  console.log("🔄 Backup retry scheduler started (checks every 5 minutes)");
}

module.exports = {
  performBackup,
  getBackupState,
  getAllBackupState,
  startRetryScheduler,
  BACKUP_TYPES,
};
