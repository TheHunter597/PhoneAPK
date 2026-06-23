#!/usr/bin/env bash
#
# build-and-sign-apk.sh — automate the Android APK build for the
# Obsidian Server mobile app.
#
# Usage:
#   ./build-and-sign-apk.sh                 # release build (requires keystore.properties)
#   ./build-and-sign-apk.sh --debug        # debug build (uses debug.keystore, no config needed)
#   ./build-and-sign-apk.sh --install      # build + install to a connected device
#
# Prerequisites (one-time setup):
#   1. Android Studio (or just the command-line tools) installed.
#      https://developer.android.com/studio
#   2. ANDROID_HOME set to the SDK root, e.g.
#        export ANDROID_HOME=$HOME/Android/Sdk
#   3. Java 17+ (OpenJDK 21 recommended).
#   4. Node.js 20+ and Yarn or npm.
#   5. For release builds: create android/keystore.properties with:
#        storeFile=<absolute path to your release.keystore>
#        storePassword=<password>
#        keyAlias=<alias>
#        keyPassword=<password>
#      Generate the keystore with:
#        keytool -genkeypair -v -keystore release.keystore \
#          -alias obsidian-tools -keyalg RSA -keysize 4096 -validity 10000
#
# Output:
#   android/app/build/outputs/apk/release/app-release.apk  (or debug/...)
#
# The APK is installable on any arm64-v8a or x86_64 Android device running
# Android 7.0 (API 24) or later.

set -euo pipefail

# ---- color helpers -----------------------------------------------------------
red()   { printf "\033[31m%s\033[0m\n" "$*"; }
green() { printf "\033[32m%s\033[0m\n" "$*"; }
yellow(){ printf "\033[33m%s\033[0m\n" "$*"; }
bold()  { printf "\033[1m%s\033[0m\n" "$*"; }

# ---- locate project root -----------------------------------------------------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$SCRIPT_DIR"
if [[ ! -f "$PROJECT_ROOT/package.json" ]]; then
  red "ERROR: could not find package.json — script must be run from the project root."
  exit 1
fi
cd "$PROJECT_ROOT"

# ---- parse args --------------------------------------------------------------
BUILD_TYPE="release"
DO_INSTALL=0
for arg in "$@"; do
  case "$arg" in
    --debug)  BUILD_TYPE="debug" ;;
    --release)BUILD_TYPE="release" ;;
    --install)DO_INSTALL=1 ;;
    *) red "ERROR: unknown argument '$arg'"; exit 1 ;;
  esac
done

bold "==> Obsidian Server Android — $BUILD_TYPE build"

# ---- sanity-check prerequisites ----------------------------------------------
echo "==> Checking prerequisites…"

if [[ -z "${ANDROID_HOME:-}" && -z "${ANDROID_SDK_ROOT:-}" ]]; then
  red "ERROR: ANDROID_HOME is not set."
  red "       Install the Android SDK and run:"
  red "         export ANDROID_HOME=\$HOME/Android/Sdk"
  exit 1
fi

if ! command -v node >/dev/null 2>&1; then
  red "ERROR: node is not installed."
  exit 1
fi
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if [[ "$NODE_MAJOR" -lt 20 ]]; then
  red "ERROR: Node.js 20+ required (found $(node --version))."
  exit 1
fi

if ! command -v java >/dev/null 2>&1; then
  red "ERROR: java is not installed."
  exit 1
fi
JAVA_MAJOR="$(java -version 2>&1 | awk -F[\".] '/version/ {print $2; exit}')"
if [[ "$JAVA_MAJOR" -lt 17 ]]; then
  red "ERROR: Java 17+ required (found Java $JAVA_MAJOR)."
  exit 1
fi

if [[ "$BUILD_TYPE" == "release" && ! -f "android/keystore.properties" ]]; then
  yellow "WARNING: android/keystore.properties not found."
  yellow "         The release APK will be signed with the debug key, which lets"
  yellow "         you install it on your own devices but is NOT suitable for"
  yellow "         Play Store distribution."
  yellow ""
  yellow "         To create a proper release keystore, run:"
  yellow "           keytool -genkeypair -v -keystore release.keystore \\"
  yellow "             -alias obsidian-tools -keyalg RSA -keysize 4096 -validity 10000"
  yellow "         Then create android/keystore.properties with the path + passwords."
  echo ""
fi

green "Prerequisites OK."

# ---- install JS dependencies -------------------------------------------------
echo "==> Installing JS dependencies (npm install)…"
npm install --no-audit --no-fund

# ---- install nodejs-project deps (the embedded Node server bundle) -----------
echo "==> Installing embedded Node server dependencies…"
# nodejs-mobile-react-native ships a postinstall that copies the nodejs-project
# dependencies into the right place at build time. We just need to make sure
# the nodejs-project's own package.json is resolvable.
cd nodejs-assets/nodejs-project
# Install only the runtime deps for the embedded server. We skip optional
# native deps because we use the WASM build of sharp.
npm install --omit=dev --no-audit --no-fund
cd "$PROJECT_ROOT"

# ---- build the APK -----------------------------------------------------------
echo "==> Building $BUILD_TYPE APK with Gradle…"
cd android

# Make sure the Gradle wrapper script exists and is executable.
if [[ ! -x ./gradlew ]]; then
  red "ERROR: android/gradlew not found or not executable."
  red "       Run 'npx react-native init --directory /tmp/rn-tmp && cp /tmp/rn-tmp/android/gradlew . && cp -r /tmp/rn-tmp/android/gradle ./gradle'"
  exit 1
fi

if [[ "$BUILD_TYPE" == "release" ]]; then
  ./gradlew assembleRelease --no-daemon
  APK_PATH="app/build/outputs/apk/release/app-release.apk"
else
  ./gradlew assembleDebug --no-daemon
  APK_PATH="app/build/outputs/apk/debug/app-debug.apk"
fi

cd "$PROJECT_ROOT"

if [[ ! -f "android/$APK_PATH" ]]; then
  red "ERROR: APK not found at android/$APK_PATH — build likely failed."
  exit 1
fi

# ---- copy the APK to a known location ----------------------------------------
mkdir -p download
cp "android/$APK_PATH" "download/obsidian-tools-$BUILD_TYPE.apk"
APK_SIZE=$(du -h "download/obsidian-tools-$BUILD_TYPE.apk" | awk '{print $1}')

green "==> Build succeeded!"
echo ""
bold "APK: download/obsidian-tools-$BUILD_TYPE.apk  ($APK_SIZE)"
echo ""

# ---- optionally install -------------------------------------------------------
if [[ "$DO_INSTALL" -eq 1 ]]; then
  if ! command -v adb >/dev/null 2>&1; then
    red "ERROR: adb not found in PATH. Install platform-tools:"
    red "       \$ANDROID_HOME/cmdline-tools/latest/bin/sdkmanager platform-tools"
    exit 1
  fi
  echo "==> Installing to connected device…"
  adb install -r "download/obsidian-tools-$BUILD_TYPE.apk"
  green "==> Installed. Launch with:"
  echo "    adb shell am start -n com.obsidian.server/.MainActivity"
fi

echo ""
echo "Next steps:"
echo "  1. Transfer the APK to your Android device (USB, Google Drive, etc.)."
echo "  2. Open the APK on your device (enable 'Install unknown apps' for your file manager)."
echo "  3. Launch 'Obsidian Tools' from your app drawer."
echo "  4. On first launch, tap 'Pick vault folder' and select your Obsidian vault."
echo "  5. The app imports your vault and starts the embedded server — your notes"
echo "     should appear in the WebView within ~5 seconds."
