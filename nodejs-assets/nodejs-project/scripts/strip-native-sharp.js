/**
 * scripts/strip-native-sharp.js — postinstall hook for the embedded Node server.
 *
 * When `npm install` runs in nodejs-assets/nodejs-project/ during the APK
 * build, sharp installs whichever @img/sharp-* prebuilt matches the BUILD
 * HOST (e.g. @img/sharp-linux-x64 on a Linux dev machine). That native
 * build will NOT load on Android (different libc, different ABI).
 *
 * This script:
 *   1. Lists every @img/sharp-* package that was installed.
 *   2. Deletes any that are NOT @img/sharp-wasm32.
 *   3. Logs what was removed.
 *
 * After this runs, sharp's runtime binding loader (in sharp/lib/libvips.js)
 * falls through to the wasm32 build, which works on any architecture.
 *
 * This is the officially-recommended workaround for using sharp on platforms
 * without a native prebuilt — see:
 *   https://sharp.pixelplumbing.com/install#custom-prebuilt-binaries
 */

const fs = require("fs");
const path = require("path");

const NM_DIR = path.join(__dirname, "..", "node_modules", "@img");
if (!fs.existsSync(NM_DIR)) {
  console.log("[strip-native-sharp] node_modules/@img not found — nothing to do.");
  process.exit(0);
}

const KEEP = new Set(["sharp-wasm32"]);

const entries = fs.readdirSync(NM_DIR, { withFileTypes: true });
let removed = 0;
for (const entry of entries) {
  if (!entry.isDirectory()) continue;
  if (!entry.name.startsWith("sharp-")) continue;
  if (KEEP.has(entry.name)) {
    console.log(`[strip-native-sharp] keeping @img/${entry.name}`);
    continue;
  }
  const full = path.join(NM_DIR, entry.name);
  try {
    fs.rmSync(full, { recursive: true, force: true });
    console.log(`[strip-native-sharp] removed @img/${entry.name}`);
    removed++;
  } catch (err) {
    console.warn(`[strip-native-sharp] could not remove @img/${entry.name}: ${err.message}`);
  }
}

console.log(`[strip-native-sharp] done — removed ${removed} platform-specific prebuilt(s).`);
