#!/usr/bin/env node
/**
 * patch-nodejs-mobile.js — runtime patch for nodejs-mobile-react-native.
 *
 * The official nodejs-mobile-react-native v18.20.4 (last released Oct 2024)
 * was designed for RN 0.74-0.75 and has multiple incompatibilities with
 * RN 0.86 + New Architecture:
 *
 *   1. `RNNodeJsMobilePackage.java` references `com.facebook.react.bridge.JavaScriptModule`
 *      which was REMOVED from React Native in v0.47 (released 2017). This
 *      causes a hard compile error under RN 0.86: "unresolved reference:
 *      JavaScriptModule".
 *
 *   2. `android/build.gradle` uses `lintOptions { ... }` (deprecated in AGP 8,
 *      scheduled for removal in AGP 9). Renaming to `lint { ... }` is the
 *      forward-compatible fix.
 *
 *   3. The Java module uses the legacy `ReactContextBaseJavaModule` +
 *      `@ReactMethod` pattern which is still supported under the New Arch
 *      interop layer, but only if `bridgelessEnabled=false` (which is the
 *      default when New Arch is on but the module isn't a TurboModule).
 *
 * This script applies fixes #1 and #2 idempotently after `npm install`.
 * It's wired in via the root package.json's `postinstall` script.
 *
 * If the upstream package ships a fix in a future release, this script
 * detects that and skips the patch.
 */

'use strict';

const fs = require('fs');
const path = require('path');

// Locate nodejs-mobile-react-native in node_modules — supports both flat and
// hoisted layouts.
function findNodejsMobile(root) {
  const candidates = [
    path.join(root, 'node_modules/nodejs-mobile-react-native'),
    path.join(root, '..', 'node_modules/nodejs-mobile-react-native'),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return null;
}

const projectRoot = path.resolve(__dirname, '..');
const njsmDir = findNodejsMobile(projectRoot);

if (!njsmDir) {
  console.log('[patch-nodejs-mobile] nodejs-mobile-react-native not found — skipping.');
  process.exit(0);
}

console.log(`[patch-nodejs-mobile] patching ${njsmDir}`);

let patched = 0;

// ---------------------------------------------------------------------------
// Fix #1: Remove JavaScriptModule reference from RNNodeJsMobilePackage.java
// ---------------------------------------------------------------------------
const packageJavaPath = path.join(
  njsmDir,
  'android/src/main/java/com/janeasystems/rn_nodejs_mobile/RNNodeJsMobilePackage.java'
);

if (fs.existsSync(packageJavaPath)) {
  let src = fs.readFileSync(packageJavaPath, 'utf8');
  const original = src;

  // Remove the import of JavaScriptModule
  src = src.replace(
    /import\s+com\.facebook\.react\.bridge\.JavaScriptModule;\s*\n/g,
    ''
  );

  // Remove the createJSModules() method (deprecated since RN 0.47, removed in 0.86)
  src = src.replace(
    /\s*\/\/\s*Deprecated from RN 0\.47\s*\n\s*public\s+List<Class<\?\s*extends\s+JavaScriptModule>>\s+createJSModules\s*\(\s*\)\s*\{[^}]*\}\s*\n/g,
    '\n'
  );

  if (src !== original) {
    fs.writeFileSync(packageJavaPath, src, 'utf8');
    patched++;
    console.log('  ✓ removed JavaScriptModule reference from RNNodeJsMobilePackage.java');
  } else {
    // Check if the file already has the fix
    if (!src.includes('JavaScriptModule')) {
      console.log('  - JavaScriptModule already absent — skipping.');
    } else {
      console.log('  ! could not find expected pattern in RNNodeJsMobilePackage.java');
    }
  }
} else {
  console.log(`  ! ${packageJavaPath} not found`);
}

// ---------------------------------------------------------------------------
// Fix #2: Replace lintOptions { ... } with lint { ... } in build.gradle
// ---------------------------------------------------------------------------
const buildGradlePath = path.join(njsmDir, 'android/build.gradle');

if (fs.existsSync(buildGradlePath)) {
  let src = fs.readFileSync(buildGradlePath, 'utf8');
  const original = src;

  // Convert `lintOptions {` → `lint {`  (forward-compatible with AGP 9)
  src = src.replace(/\blintOptions\s*\{/g, 'lint {');

  if (src !== original) {
    fs.writeFileSync(buildGradlePath, src, 'utf8');
    patched++;
    console.log('  ✓ renamed lintOptions → lint in nodejs-mobile build.gradle');
  } else {
    console.log('  - lintOptions already absent in build.gradle — skipping.');
  }
} else {
  console.log(`  ! ${buildGradlePath} not found`);
}

// ---------------------------------------------------------------------------
// Fix #3: Add the `nodejs-mobile-react-native` package to the autolinked
// list manually if it's not detected by RN's autolinking (the package's
// `package.json` lacks the `codegenConfig` field that RN 0.86 uses to
// discover new-arch modules). We don't disable new arch globally — we just
// let this module compile in legacy mode.
//
// (This is a no-op for now — we'd need to add a turbo-module spec to actually
// make it work under pure bridgeless mode. For now, the interop layer
// handles it.)
// ---------------------------------------------------------------------------

console.log(`[patch-nodejs-mobile] done — ${patched} patch(es) applied.`);
