/**
 * mobileBridge.js — small RN <-> Node messaging helper built on top of the
 * `rn-bridge` builtin module that ships with nodejs-mobile-react-native.
 *
 * nodejs-mobile-react-native exposes a bidirectional event channel between
 * the React Native side and the embedded Node.js runtime via the `rn-bridge`
 * builtin module. We wrap it in a tiny facade so the rest of our code can
 * use a consistent API.
 *
 * Events (we send TO RN):
 *   - server::ready    {port}            — Express is listening
 *   - server::error    <string>          — fatal boot error
 *   - server::log      <string>          — console mirror (truncated)
 *
 * Events (we receive FROM RN):
 *   - vault::changed   {path}            — user picked a new vault folder
 *
 * On the RN side, `nodejs.channel.addListener(name, cb)` and
 * `nodejs.channel.post(name, payload)` are used to send/receive these same
 * events. See src/App.tsx and src/native/vaultBridge.ts.
 */

let rnBridge = null;
try {
  // `rn-bridge` is a builtin module shipped by nodejs-mobile-react-native.
  // It's available without npm install — nodejs-mobile injects it into the
  // module resolution path at startup.
  rnBridge = require('rn-bridge');
} catch (err) {
  // We're not running inside nodejs-mobile (e.g. local test on dev machine).
  // Fall back to a no-op bridge so the rest of the code can still load.
  console.warn('[mobileBridge] rn-bridge not available — running in standalone mode.');
  rnBridge = {
    channel: {
      post: () => {},
      on: () => {},
      send: () => {},
    },
  };
}

const channel = rnBridge.channel;

function postToRn(name, payload) {
  try {
    channel.post(name, payload);
  } catch (err) {
    // Don't let bridge failures crash the server.
    console.warn('[mobileBridge] post failed:', err.message);
  }
}

function onFromRn(name, handler) {
  try {
    channel.on(name, (payload) => {
      try {
        handler(payload);
      } catch (err) {
        console.error(`[mobileBridge] handler for ${name} threw:`, err);
      }
    });
  } catch (err) {
    console.warn(`[mobileBridge] on(${name}) failed:`, err.message);
  }
}

module.exports = {
  postToRn,
  onFromRn,
  // Aliases that match the underlying rn-bridge naming convention.
  post: postToRn,
  on: onFromRn,
  // Direct access for advanced use.
  channel,
};
