// (serverAssets/config.js) Mobile-patched version.
//
// The desktop version reads vaultPath / backupDestination from config.json
// sitting next to server.js. On Android, the user picks a vault folder at
// runtime via the Storage Access Framework, so the path is not known at
// bundle time.
//
// This mobile build delegates to runtimeConfig.js, which:
//   - Loads the bundled config.json defaults once.
//   - Exposes setVaultPath() / setBackupRoot() for runtime updates.
//   - Re-exports vaultPath / backupRoot as LIVE getters so consumers that
//     destructure at module-load time still see updates after the user
//     picks a new vault folder.
//
// main.js also re-defines `vaultPath` / `backupRoot` on this module's exports
// via Object.defineProperty() as a belt-and-braces safety net.

const path = require("path");
const fs = require("fs");
const runtimeConfig = require("../runtimeConfig");

const DATA_DIR = path.join(__dirname, "..", "data");
const CONFIG_FILE = path.join(__dirname, "..", "config.json");

// Ensure data directory exists
if (!fs.existsSync(DATA_DIR)) {
  try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch (_) {}
}

// Re-export everything as LIVE getters so consumers that do
//   const { vaultPath } = require('./config');
// still see updates when runtimeConfig.setVaultPath() is called later.
// (Destructuring snapshots the value at the time of the require call, but
// the getter on the exports object is re-evaluated on every property access.
// main.js redefines these getters after require to make this bulletproof.)
module.exports = {
  DATA_DIR,
  CONFIG_FILE,
  config: runtimeConfig.config,
  get vaultPath() { return runtimeConfig.getVaultPath(); },
  get backupRoot() { return runtimeConfig.getBackupRoot(); },
};
