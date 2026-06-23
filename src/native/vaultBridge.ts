/**
 * vaultBridge.ts — React Native side of the vault picker + sync.
 *
 * Strategy:
 *   Android's Storage Access Framework (SAF) returns content:// URIs that
 *   cannot be directly read by Node.js (which uses POSIX file paths). To
 *   bridge this, we:
 *
 *     1. Let the user pick a tree URI via DocumentPicker.pickDirectory().
 *     2. Walk that tree using the Storage Access Framework (via a small
 *        NativeModule written in Kotlin) and copy every file into the app's
 *        internal files directory: /data/data/<pkg>/files/vault/.
 *     3. Persist the resulting absolute POSIX path. Node reads/writes there
 *        directly, no SAF involved.
 *
 *   On the user's side, this means: when they pick a vault folder, all files
 *   are imported into the app's private storage. Edits inside the app write
 *   to the private copy. To push changes back to the original folder, the
 *   in-app UI offers an "Export to original folder" action (also implemented
 *   via the same native module — see SafSyncModule.kt).
 *
 *   We chose this approach over a live SAF bridge because:
 *     - Node's `fs`, `chokidar`, and `sharp` all expect real paths.
 *     - Live SAF access requires translating every fs call through a
 *       ContentResolver, which is slow and breaks many libraries.
 *     - For an Obsidian vault viewer/editor, a one-time import + on-demand
 *       export is sufficient and dramatically simpler.
 */

import {NativeModules, Platform, PermissionsAndroid} from 'react-native';
import {pickDirectory} from '@react-native-documents/picker';
import AsyncStorage from '@react-native-async-storage/async-storage';

const VAULT_PATH_KEY = '@vault_path';

// NativeModules.SafSync is implemented in android/app/src/main/java/com/obsidian/server/SafSyncModule.kt
//   - copyTreeToInternal(uri: String): Promise<String>   -> returns the destination absolute path
//   - exportToOriginalUri(uri: String, internalPath: String): Promise<void>
const SafSync = NativeModules.SafSync;

/**
 * Returns true if a vault path has been previously configured.
 */
export async function hasVaultPath(): Promise<boolean> {
  try {
    const p = await AsyncStorage.getItem(VAULT_PATH_KEY);
    return !!p && p.length > 0;
  } catch {
    return false;
  }
}

/**
 * Returns the configured vault path, or null.
 */
export async function getVaultPath(): Promise<string | null> {
  try {
    return await AsyncStorage.getItem(VAULT_PATH_KEY);
  } catch {
    return null;
  }
}

/**
 * Persist a new vault path.
 */
export async function setVaultPath(p: string): Promise<void> {
  await AsyncStorage.setItem(VAULT_PATH_KEY, p);
}

/**
 * On Android < 11, request the legacy READ/WRITE_EXTERNAL_STORAGE permissions.
 * On Android 11+, SAF tree-picking does not require any dangerous permission.
 *
 * Returns true if we can proceed.
 */
export async function ensureStoragePermissions(): Promise<boolean> {
  if (Platform.OS !== 'android') return true;
  const sdk = Platform.Version as number;
  if (sdk >= 30) {
    // Android 11+ — SAF tree picker needs no permission.
    return true;
  }
  try {
    const granted = await PermissionsAndroid.requestMultiple([
      PermissionsAndroid.PERMISSIONS.READ_EXTERNAL_STORAGE,
      PermissionsAndroid.PERMISSIONS.WRITE_EXTERNAL_STORAGE,
    ]);
    return (
      granted['android.permission.READ_EXTERNAL_STORAGE'] === 'granted' &&
      granted['android.permission.WRITE_EXTERNAL_STORAGE'] === 'granted'
    );
  } catch (err) {
    console.warn('[vaultBridge] permission request failed', err);
    return false;
  }
}

/**
 * Open the system folder picker and return the SAF tree URI the user chose.
 * Returns null if the user cancels.
 */
export async function pickVaultFolder(): Promise<string | null> {
  const ok = await ensureStoragePermissions();
  if (!ok) {
    throw new Error('Storage permissions were not granted.');
  }
  try {
    // pickDirectory() returns an object {uri: string} where uri is a content
    // URI like content://com.android.externalstorage.documents/tree/primary%3AObsidian
    const result = await pickDirectory();
    return (result as {uri: string}).uri;
  } catch (err: any) {
    // DocumentPicker raises "User canceled" — treat as null.
    if (String(err?.message || err).toLowerCase().includes('cancel')) {
      return null;
    }
    throw err;
  }
}

/**
 * Copy the entire picked SAF tree into the app's internal storage and return
 * the destination absolute POSIX path. The Node.js server reads/writes from
 * this path.
 *
 * Delegates to SafSyncModule.copyTreeToInternal() in Kotlin.
 */
export async function copySafTreeToInternal(treeUri: string): Promise<string> {
  if (!SafSync || !SafSync.copyTreeToInternal) {
    throw new Error('SafSync native module is not registered. Rebuild the Android app.');
  }
  const destPath: string = await SafSync.copyTreeToInternal(treeUri);
  return destPath;
}

/**
 * Push the contents of the internal vault back to the original SAF folder.
 * Optional convenience for users who want their on-device edits reflected in
 * the original folder they picked.
 */
export async function exportVaultToOriginal(): Promise<void> {
  const internalPath = await getVaultPath();
  if (!internalPath) {
    throw new Error('No vault configured.');
  }
  if (!SafSync || !SafSync.exportToOriginalUri) {
    throw new Error('SafSync.exportToOriginalUri is not available.');
  }
  // We need the user to re-pick the destination folder (we can't persist the
  // SAF permission indefinitely without explicit grants).
  const destUri = await pickVaultFolder();
  if (!destUri) return;
  await SafSync.exportToOriginalUri(destUri, internalPath);
}
