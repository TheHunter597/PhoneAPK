# Obsidian Tools — Standalone Android APK

A self-contained Android app that bundles the entire **Obsidian Tools Node.js/Express server** and runs it on-device via [`nodejs-mobile-react-native`](https://github.com/nodejs-mobile/nodejs-mobile-react-native). The frontend (served by Express) is displayed inside a `react-native-webview`. **No Termux, no PC server, no internet connection required** — the app is fully self-contained.

---

## Architecture at a glance

```
┌──────────────────────────────────────────────────────────────┐
│                    Android APK (single file)                 │
│                                                              │
│  ┌────────────────────────────┐    ┌──────────────────────┐  │
│  │ React Native UI layer      │    │ Node.js (background) │  │
│  │                            │    │ via nodejs-mobile     │  │
│  │  ┌──────────────────────┐  │    │                      │  │
│  │  │ WebView ─────────────┼──┼────┼──► http://localhost:  │  │
│  │  │  (loads Express UI) │  │    │    4000/ (Express     │  │
│  │  └──────────────────────┘  │    │    serving the       │  │
│  │                            │    │    public/ folder)   │  │
│  │  VaultPickerScreen         │    │                      │  │
│  │  ServerStatusScreen        │    │  Vault: /data/data/  │  │
│  │                            │    │   <pkg>/files/vault/ │  │
│  │  SafSyncModule (Kotlin)    │    │                      │  │
│  │   - pickDirectory()        │    │  Sharp (WASM)        │  │
│  │   - copyTreeToInternal()   │    │  Polling watcher     │  │
│  │   - exportToOriginalUri()  │    │  setInterval backups │  │
│  └────────────┬───────────────┘    └──────────┬───────────┘  │
│               │                               │              │
│               └────────── channel ────────────┘              │
│                  (RN ↔ Node bridge,                           │
│                   events: server::ready,                      │
│                   vault::changed, …)                          │
│                                                              │
│  android.app files:                                          │
│   - MainApplication.kt  (RN host + SafSyncPackage)           │
│   - MainActivity.kt     (ReactActivity host)                 │
│   - SafSyncModule.kt    (SAF tree-copy bridge)               │
└──────────────────────────────────────────────────────────────┘
```

The APK is a single installable file. After install, the user launches the app, taps **"Pick vault folder"**, and Android's Storage Access Framework folder picker appears. The selected folder is recursively copied into the app's private storage (`/data/data/com.obsidian.server/files/vault/`) so Node.js can read/write it with regular `fs` calls. The embedded Express server then serves the vault UI inside a WebView.

---

## What changed vs. the desktop build

| Concern | Desktop (`Server-v62/Server/`) | Mobile (this repo) |
|---------|-------------------------------|---------------------|
| `sharp` (image processing) | Native binary, downloaded at `npm install` for the host platform | **`@img/sharp-wasm32`** — pure WebAssembly build, runs on any architecture. A `postinstall` script (`scripts/strip-native-sharp.js`) removes any platform-specific prebuilt that npm downloaded for the build host, leaving only the WASM build. |
| `chokidar` (file watching) | Native `fsevents` (macOS) / `inotify` (Linux) | **`pollingWatcher.js`** — minimal chokidar-compatible polling watcher. Same `.on('add' / 'change' / 'unlink' / 'addDir' / 'unlinkDir')` API. No native deps. |
| `node-cron` (backup scheduling) | `node-cron` parses cron expressions | **`setInterval`** — each backup type runs on a simple interval (6h / 24h / 72h / 168h). Same backup logic in `scripts/backup.js`, same retry/overdue detection. |
| `config.json` `vaultPath` | Hardcoded Windows path (`C:/Users/...`) | **Runtime-injected.** `serverAssets/config.js` now delegates to `runtimeConfig.js`, which exposes `getVaultPath()` / `setVaultPath()`. The RN side calls `setVaultPath()` after the user picks a folder via SAF. All route files use the live getter so a runtime change is visible without restarting Express. |
| `z-ai-web-dev-sdk` (AI chat) | Unchanged | Unchanged (pure JS, works on Android). |
| Frontend delivery | Express serves `public/` over HTTP to a browser | Express serves `public/` over HTTP to localhost:4000, rendered inside a `react-native-webview`. |

---

## Project structure

```
ServerAndroid/
├── package.json                  ← React Native app deps
├── index.js                      ← RN entrypoint (registers App)
├── app.json                      ← RN app name
├── babel.config.js
├── metro.config.js
├── tsconfig.json
├── build-and-sign-apk.sh         ← one-shot APK build script
├── README.md                     ← (this file)
│
├── src/                          ← React Native TypeScript source
│   ├── App.tsx                   ← root component (lifecycle, WebView host)
│   ├── screens/
│   │   ├── VaultPickerScreen.tsx
│   │   └── ServerStatusScreen.tsx
│   ├── native/
│   │   └── vaultBridge.ts        ← RN-side SAF picker + sync logic
│   └── ...
│
├── android/                      ← Native Android project (Gradle)
│   ├── build.gradle
│   ├── settings.gradle
│   ├── gradle.properties         ← hermesEnabled, newArchEnabled, etc.
│   ├── gradlew / gradlew.bat     ← Gradle 8.10.2 wrapper
│   ├── gradle/wrapper/
│   │   ├── gradle-wrapper.jar
│   │   └── gradle-wrapper.properties
│   └── app/
│       ├── build.gradle          ← signing, ABI filters, BuildConfig
│       ├── proguard-rules.pro
│       ├── debug.keystore        ← (bundled, gitignored in real projects)
│       └── src/main/
│           ├── AndroidManifest.xml
│           ├── java/com/obsidian/server/
│           │   ├── MainApplication.kt   ← RN host + package registration
│           │   ├── MainActivity.kt      ← ReactActivity
│           │   ├── SafSyncModule.kt     ← SAF tree-copy / export Kotlin module
│           │   └── SafSyncPackage.kt    ← ReactPackage registration
│           └── res/
│               ├── values/{strings,colors,styles}.xml
│               ├── drawable/ic_launcher_*.xml
│               ├── mipmap-*/ic_launcher*.xml
│               └── xml/file_provider_paths.xml
│
└── nodejs-assets/
    └── nodejs-project/           ← Embedded Node.js server (bundled in APK)
        ├── package.json          ← Server-only deps (sharp, express, …)
        ├── main.js               ← nodejs-mobile entrypoint (boot + bridge wiring)
        ├── mobileBridge.js       ← RN ↔ Node event-bus helper
        ├── runtimeConfig.js      ← Live vaultPath / backupRoot getters + setters
        ├── pollingWatcher.js     ← chokidar-compatible polling watcher
        ├── server.js             ← Mobile-patched server.js (reinitWatchers())
        ├── config.json           ← Safe mobile defaults (vaultPath=".")
        ├── serverAssets/
        │   ├── config.js         ← Mobile-patched: delegates to runtimeConfig
        │   ├── backup.js         ← setInterval-based (no node-cron)
        │   └── routes/           ← All routes patched to use live vaultPath getter
        ├── scripts/              ← chokidar → pollingWatcher, sharp unchanged (uses WASM via shim)
        │   ├── watcher.js
        │   ├── livePreviewWatcher.js
        │   ├── htmlWatcher.js
        │   ├── scraper.js
        │   ├── backup.js
        │   ├── linker.js
        │   ├── brokenLinks.js
        │   ├── brokenLinkFixer.js
        │   └── strip-native-sharp.js  ← postinstall: removes non-WASM sharp prebuilts
        ├── public/               ← Static frontend (unchanged from desktop)
        └── data/                 ← Persistent state (backup_state.json, etc.)
```

---

## Prerequisites

To build the APK you need **all** of the following on the build machine:

1. **Node.js 20 LTS or newer** — https://nodejs.org/
2. **Java 17 or newer** (OpenJDK 21 recommended) — `java --version` should report ≥17.
3. **Android SDK** with:
   - Platform 35 (Android 15)
   - Build-Tools 35.0.0
   - NDK 27.1.12297006
   - CMake 3.22.1
   - Platform-Tools (for `adb`)
   
   Easiest: install **Android Studio** and let it download everything on first launch. Then set:
   ```bash
   export ANDROID_HOME=$HOME/Android/Sdk
   export PATH=$PATH:$ANDROID_HOME/platform-tools:$ANDROID_HOME/cmdline-tools/latest/bin
   ```
4. **Kotlin 2.0+** — bundled with Android Studio, no separate install needed.
5. **(For release builds) A signing keystore.** Generate one with:
   ```bash
   keytool -genkeypair -v \
     -keystore release.keystore \
     -alias obsidian-tools \
     -keyalg RSA -keysize 4096 \
     -validity 10000
   ```
   Then create `android/keystore.properties`:
   ```properties
   storeFile=/absolute/path/to/release.keystore
   storePassword=your-store-password
   keyAlias=obsidian-tools
   keyPassword=your-key-password
   ```

---

## Build the APK

### Option A — one-shot script (recommended)

```bash
cd ServerAndroid
./build-and-sign-apk.sh            # release build (uses keystore.properties if present, else debug-signed)
./build-and-sign-apk.sh --debug    # debug build (debug-signed, dev-friendly)
./build-and-sign-apk.sh --install  # build + install to a connected device via adb
```

The script:
- verifies prerequisites (Node, Java, ANDROID_HOME)
- runs `npm install` at the project root
- runs `npm install` inside `nodejs-assets/nodejs-project/` (which triggers the `postinstall` script that strips non-WASM sharp prebuilts)
- invokes `./gradlew assembleRelease` (or `assembleDebug`)
- copies the final APK to `download/obsidian-tools-{release|debug}.apk`

### Option B — manual steps

```bash
# 1. Install root RN deps
cd ServerAndroid
npm install

# 2. Install embedded server deps (runs postinstall → strips non-WASM sharp)
cd nodejs-assets/nodejs-project
npm install --omit=dev
cd ../..

# 3. Build the APK
cd android
./gradlew assembleRelease       # or assembleDebug

# 4. Grab the APK
cp app/build/outputs/apk/release/app-release.apk ../download/obsidian-tools.apk
```

---

## Install & test on-device

### Install

1. Transfer `download/obsidian-tools-release.apk` to your Android phone (USB, Google Drive, etc.).
2. On the phone, open the APK. Android will warn about "unknown apps" — allow your file manager to install.
3. Launch **Obsidian Tools** from your app drawer.

### First-launch test plan

| Step | Expected behaviour |
|------|--------------------|
| 1. Launch the app | Dark splash screen with spinner; status: "Starting Node.js runtime…" |
| 2. Wait ~3 s | Status: "Server listening — checking vault…" then "Pick vault folder" prompt |
| 3. Tap "Pick vault folder" | Android SAF folder picker opens |
| 4. Navigate to your Obsidian vault, long-press the folder, tap "Select" | Status: "Importing vault into app storage…" — large vaults take a few seconds per 1000 files (progress is logged to logcat) |
| 5. Import completes | Status: "Vault ready. Restarting server…" |
| 6. Wait ~1 s | The Express UI loads inside the WebView — your notes appear in the sidebar |
| 7. Tap any note | Note opens in the editor/viewer |
| 8. Edit a note, tap Save | Note is written to `/data/data/com.obsidian.server/files/vault/...` and persists across app restarts |
| 9. Add a new `.png` image to a note (via the editor's upload button) | Image is converted to WebP via **sharp WASM** and stored under `assets/` next to the note |
| 10. Edit a note in the app, then close and reopen the app | Note content is preserved (proves the vault read/write path works through the app-private storage) |

### Verify the server is running

From a computer with `adb` connected:

```bash
# Forward port 4000 from the phone to the PC
adb forward tcp:4000 tcp:4000

# Test the API
curl http://localhost:4000/api/vault-tree | jq .

# Watch server logs
adb logcat -s ReactNativeJS:V SafSyncModule:V
```

### Optional: export back to the original SAF folder

By default, edits made inside the app stay in the app's private storage. To push them back to the original folder you picked:

1. In the app, tap **"Export to original folder"** (exposed via the in-app settings — wire this to `exportVaultToOriginal()` from `src/native/vaultBridge.ts`).
2. SAF picker opens again; select the same original folder.
3. The Kotlin `SafSyncModule.exportToOriginalUri()` walks the internal vault and writes each file back to the SAF tree.

---

## How the runtime vault path change works

The trickiest part of the port was making the server's `vaultPath` changeable at runtime, because the desktop code destructures it once at module load:

```js
const { vaultPath } = require("./config");   // ← snapshot, never updates
```

We solved this in three layers:

1. **`runtimeConfig.js`** — holds the active `vaultPath` in a module-level variable, exposes `getVaultPath()` / `setVaultPath()`.

2. **`serverAssets/config.js`** (mobile-patched) — re-exports `vaultPath` / `backupRoot` as **live getters** on its `module.exports` object that delegate to `runtimeConfig`. Any code that does `config.vaultPath` (property access) sees the latest value. (Code that destructures still snapshots — see step 3.)

3. **All route files** (`serverAssets/routes/*.js`, patched by `scripts/patch_routes_v2.py`) — replace `const { vaultPath } = require("../config")` with `const config = require("../config")`, then qualify every bare `vaultPath` reference as `config.vaultPath`. This forces a property access on every use, hitting the live getter.

4. **`server.js`** (mobile-patched) — exposes `reinitWatchers()`, which stops the old live-preview watcher (it captures `vaultPath` at construction time) and starts a new one on the current path. The Express `/vault` static mount is also replaced with a per-request middleware that resolves `express.static(currentVault)` on every hit.

5. **`main.js`** (nodejs-mobile entrypoint) — listens for `vault::changed` events from RN, calls `runtimeConfig.setVaultPath(newPath)`, then calls `server.reinitWatchers()`. Acknowledges with `server::ready` so RN flips the WebView.

---

## Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| `npm install` fails with `EACCES` | File permission issue | Run `chown -R $USER ~/.npm` or use a node version manager (nvm) |
| `gradlew: Permission denied` | Wrapper script not executable | `chmod +x android/gradlew` |
| Gradle build fails with `SDK location not found` | `ANDROID_HOME` not set | `export ANDROID_HOME=$HOME/Android/Sdk` |
| Build fails with `Failed to resolve: com.facebook.react:react-native-gradle-plugin` | RN gradle plugin not downloaded | Run `npm install` at the project root first |
| Build fails with `More than one file was found with OS independent path 'lib/arm64-v8a/libnodejs-mobile.so'` | ABI filter conflict | Ensure `abiFilters "arm64-v8a", "x86_64"` in `app/build.gradle` (don't include 32-bit ABIs) |
| App launches but WebView shows "ERR_CONNECTION_REFUSED" | Node server didn't start | Check `adb logcat -s ReactNativeJS:V` for `server::error` events |
| Sharp error: `Could not load the "sharp" module using the wasm32 runtime` | `@img/sharp-wasm32` not installed, or platform-specific prebuilt not stripped | Re-run `cd nodejs-assets/nodejs-project && npm install` — the `postinstall` script handles this |
| Vault picker hangs on "Importing vault into app storage…" | Very large vault, or SAF permission expired | Wait; for >10k files, expect ~1 min per 1000 files. Check `adb logcat -s SafSyncModule:V` for progress |
| `E_SAF_COPY: Permission denied` in logcat | User picked a folder the app doesn't have SAF access to | Re-pick the folder; on Android 11+, SAF grants access only to the picked subtree |

---

## License

Same as the upstream Obsidian Tools server. The mobile-specific additions (Kotlin modules, polling watcher, runtime config) are released under the same license.

---

## Acknowledgements

This port builds on:

- [nodejs-mobile-react-native](https://github.com/nodejs-mobile/nodejs-mobile-react-native) — embedded Node.js runtime for React Native.
- [sharp](https://sharp.pixelplumbing.com/) — image processing, used here via its WebAssembly build.
- [@react-native-documents/picker](https://github.com/react-native-documents/document-picker) — cross-platform SAF folder picker.
- [react-native-webview](https://github.com/react-native-webview/react-native-webview) — embedded browser view.
