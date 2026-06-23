/**
 * runtimeConfig.js — runtime-overridable config for the embedded server.
 *
 * The desktop version of the server reads vaultPath / backupDestination from
 * config.json sitting next to server.js. On Android, the user picks a vault
 * folder at runtime (via SAF), so the path is not known at bundle time.
 *
 * To keep the rest of the code (serverAssets/config.js, vault.js routes, etc.)
 * unchanged, this module:
 *
 *   1. On first require, loads config.json from the bundled nodejs-project/
 *      directory (it ships with safe defaults: vaultPath = ".").
 *   2. Exposes `setVaultPath(absPath)` so the RN side (via mobileBridge) can
 *      update the active vault path at runtime.
 *   3. Re-exports `vaultPath` / `backupRoot` as getters so consumers always
 *      see the latest value.
 *
 * `serverAssets/config.js` is patched (in this mobile bundle) to delegate to
 * this module instead of reading config.json directly. This keeps the patch
 * surface minimal — only one file in the original codebase changes.
 */

const path = require('path');
const fs = require('fs');

const BUNDLED_CONFIG_PATH = path.join(__dirname, 'config.json');

// Load the bundled defaults once. On the mobile bundle, config.json is
// shipped with vaultPath = "." and backupDestination = "./backup", so the
// server can boot even before the user picks a real folder.
let config = {vaultPath: '.', backupDestination: './backup'};
try {
  if (fs.existsSync(BUNDLED_CONFIG_PATH)) {
    config = JSON.parse(fs.readFileSync(BUNDLED_CONFIG_PATH, 'utf8'));
  }
} catch (err) {
  console.warn('[runtimeConfig] could not parse bundled config.json:', err.message);
}

// Resolve relative paths against the nodejs-project directory (the CWD inside
// nodejs-mobile is the nodejs-project/ folder).
let activeVaultPath = path.isAbsolute(config.vaultPath)
  ? config.vaultPath
  : path.resolve(__dirname, config.vaultPath);

let activeBackupRoot = path.isAbsolute(config.backupDestination)
  ? config.backupDestination
  : path.resolve(__dirname, config.backupDestination);

function getVaultPath() {
  return activeVaultPath;
}

function getBackupRoot() {
  return activeBackupRoot;
}

function setVaultPath(absPath) {
  if (typeof absPath !== 'string' || absPath.length === 0) {
    throw new Error('setVaultPath: absPath must be a non-empty string');
  }
  activeVaultPath = absPath;
  // Mirror the bundled config.json so any code that reads it directly still
  // sees the updated value.
  try {
    config.vaultPath = absPath;
  } catch (_) {}
  console.log(`[runtimeConfig] vaultPath set to: ${absPath}`);
}

function setBackupRoot(absPath) {
  if (typeof absPath !== 'string' || absPath.length === 0) return;
  activeBackupRoot = absPath;
  try {
    config.backupDestination = absPath;
  } catch (_) {}
}

module.exports = {
  config,
  getVaultPath,
  getBackupRoot,
  setVaultPath,
  setBackupRoot,
  // Static exports for backwards compatibility with code that imports
  // `{ vaultPath }` once at module load. NOTE: these are snapshots and will
  // NOT reflect later setVaultPath() calls — code that needs the live value
  // should call getVaultPath() instead. serverAssets/config.js (mobile patch)
  // uses the getters.
  get vaultPath() { return activeVaultPath; },
  get backupRoot() { return activeBackupRoot; },
  get DATA_DIR() { return path.join(__dirname, 'data'); },
  get CONFIG_FILE() { return BUNDLED_CONFIG_PATH; },
};
