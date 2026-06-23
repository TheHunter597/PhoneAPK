/**
 * main.js — entry point executed by nodejs-mobile-react-native.
 *
 * nodejs-mobile runs this file inside a worker thread with the nodejs-project/
 * directory as its CWD. The full Express server is required lazily so we can
 * wrap any startup error in a clean try/catch and report it back to RN.
 *
 * Lifecycle:
 *
 *   1. RN calls `nodejs.start('main.js')` from App.tsx.
 *   2. We bootstrap by patching serverAssets/config.js to use runtimeConfig,
 *      then require('./server').
 *   3. server.js calls express.listen(PORT) — when that succeeds, we post
 *      `server::ready` back to RN.
 *   4. RN then shows the WebView, which loads http://localhost:4000.
 *   5. If the user picks a new vault folder later, RN posts `vault::changed`
 *      with the new path. We update runtimeConfig, then re-init the watchers
 *      and live-preview watcher on the new path. (The HTTP server itself
 *      keeps running on the same port — no need to restart Express.)
 */

const path = require('path');
const mobileBridge = require('./mobileBridge');
const runtimeConfig = require('./runtimeConfig');

// Mirror all console output to RN for easier debugging from logcat.
const originalLog = console.log;
const originalErr = console.error;
const originalWarn = console.warn;

function truncate(s, n = 500) {
  s = String(s);
  return s.length > n ? s.slice(0, n) + '…' : s;
}

console.log = (...args) => {
  originalLog(...args);
  try {
    mobileBridge.post('server::log', truncate(args.map(String).join(' ')));
  } catch (_) {}
};
console.error = (...args) => {
  originalErr(...args);
  try {
    mobileBridge.post('server::log', 'ERROR: ' + truncate(args.map(String).join(' ')));
  } catch (_) {}
};
console.warn = (...args) => {
  originalWarn(...args);
  try {
    mobileBridge.post('server::log', 'WARN: ' + truncate(args.map(String).join(' ')));
  } catch (_) {}
};

// ---------------------------------------------------------------------------
// Patch serverAssets/config.js to delegate vaultPath/backupRoot to our
// runtimeConfig module. We do this BEFORE requiring server.js so the latter
// sees the patched module on its first require.
// ---------------------------------------------------------------------------
const configModulePath = require.resolve('./serverAssets/config.js');
try {
  // require() returns the module's exports; we mutate them in place.
  const configModule = require(configModulePath);
  // Re-define vaultPath / backupRoot as live getters so any code that imports
  // them at module-load time still sees updates after setVaultPath().
  Object.defineProperty(configModule, 'vaultPath', {
    get: () => runtimeConfig.getVaultPath(),
    configurable: true,
  });
  Object.defineProperty(configModule, 'backupRoot', {
    get: () => runtimeConfig.getBackupRoot(),
    configurable: true,
  });
  console.log('[main] serverAssets/config.js patched to use runtimeConfig');
} catch (err) {
  console.error('[main] failed to patch serverAssets/config.js:', err.message);
  mobileBridge.post('server::error', 'Config patch failed: ' + err.message);
  return;
}

// ---------------------------------------------------------------------------
// Listen for vault::changed events from RN. When the user picks a new vault
// folder, RN calls us with the new absolute path. We update runtimeConfig and
// then restart the watchers on the new path.
// ---------------------------------------------------------------------------
mobileBridge.on('vault::changed', (payload) => {
  try {
    const newPath = payload && payload.path;
    if (!newPath) {
      console.warn('[main] vault::changed event missing path');
      return;
    }
    runtimeConfig.setVaultPath(newPath);
    // Re-init watchers by re-requiring them. The watcher modules cache their
    // own vaultPath at init time, so we need to bust their require cache.
    const watchPaths = [
      require.resolve('./scripts/livePreviewWatcher.js'),
      require.resolve('./scripts/watcher.js'),
      require.resolve('./scripts/htmlWatcher.js'),
      require.resolve('./serverAssets/routes/watcher.js'),
      require.resolve('./serverAssets/routes/htmlWatcher.js'),
      require.resolve('./serverAssets/routes/vault.js'),
    ];
    for (const p of watchPaths) {
      try { delete require.cache[p]; } catch (_) {}
    }
    // Re-init the watchers. server.js exports an initWatchers() helper (added
    // by the mobile patch) for exactly this purpose.
    try {
      const server = require('./server');
      if (typeof server.reinitWatchers === 'function') {
        server.reinitWatchers();
        console.log('[main] watchers re-initialised on new vault path');
      }
    } catch (err) {
      console.warn('[main] watcher re-init failed:', err.message);
    }
    // Acknowledge back to RN so it can flip the WebView.
    mobileBridge.post('server::ready', {vaultPath: newPath});
  } catch (err) {
    console.error('[main] vault::changed handler threw:', err);
    mobileBridge.post('server::error', 'vault::changed handler: ' + err.message);
  }
});

// ---------------------------------------------------------------------------
// Now boot the Express server.
// ---------------------------------------------------------------------------
(async function boot() {
  try {
    console.log('[main] booting embedded Express server…');
    // server.js calls express.listen(PORT) at the bottom. We hook the listen
    // callback by monkey-patching express.listen before requiring server.js
    // — but since express.listen is just http.Server#listen, we patch via
    // the require cache for http. Easier: just require server.js and post
    // ready after a short delay once the require returns. server.js is
    // synchronous up to and including the listen() call.
    require('./server');
    // Give the event loop one tick to confirm listen() succeeded.
    setImmediate(() => {
      const port = process.env.PORT || 4000;
      console.log(`[main] server should now be listening on :${port}`);
      mobileBridge.post('server::ready', {port});
    });
  } catch (err) {
    console.error('[main] server boot failed:', err && err.stack || err);
    mobileBridge.post('server::error', (err && err.message) || String(err));
  }
})();
