/**
 * App.tsx — root React Native component.
 *
 * Lifecycle:
 * 1. Request storage permissions (Android 11+ uses MANAGE_EXTERNAL_STORAGE-style
 *    flow via SAF, no dangerous permission required for tree-pick; on Android <11
 *    we request READ/WRITE_EXTERNAL_STORAGE).
 * 2. Start the embedded Node.js server in a background thread via nodejs-mobile.
 *    The Node process reads its vaultPath from a JS-level "bridge config" that
 *    we inject through the nodejs-mobile messaging channel.
 * 3. Wait for the server to signal "ready" (it posts back once express.listen()
 *    succeeds). Show a spinner / status during this phase.
 * 4. Render a WebView pointing to http://localhost:4000/.
 * 5. If the user has not yet picked a vault folder, show a VaultPicker overlay
 *    instead of the WebView. After picking, restart the Node server with the
 *    new path.
 *
 * The Node server is fully embedded — it ships inside the APK under
 * nodejs-assets/nodejs-project/ and is started by nodejs-mobile-react-native.
 */

import React, {useEffect, useRef, useState, useCallback} from 'react';
import {
  ActivityIndicator,
  Alert,
  Platform,
  SafeAreaView,
  StatusBar,
  StyleSheet,
  Text,
  View,
  NativeModules,
  NativeEventEmitter,
  PermissionsAndroid,
  Linking,
  Button,
} from 'react-native';
import {WebView} from 'react-native-webview';
import nodejs from 'nodejs-mobile-react-native';
import {pickVaultFolder, copySafTreeToInternal, hasVaultPath, getVaultPath, setVaultPath} from './native/vaultBridge';
import {ServerStatusScreen} from './screens/ServerStatusScreen';
import {VaultPickerScreen} from './screens/VaultPickerScreen';

const SERVER_PORT = 4000;
const SERVER_URL = `http://localhost:${SERVER_PORT}`;

type AppPhase =
  | 'starting-node'    // Node process is booting up
  | 'node-ready'       // Node has started, server may be listening
  | 'need-vault'       // No vault path configured — show picker
  | 'running'          // Server is up + vault is set — show WebView
  | 'error';

export default function App() {
  const [phase, setPhase] = useState<AppPhase>('starting-node');
  const [statusMessage, setStatusMessage] = useState('Starting Node.js runtime…');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [webviewKey, setWebviewKey] = useState(0);  // bump to force reload
  const nodeStartedRef = useRef(false);

  // --------------------------------------------------------------
  // Node <-> RN event bus wiring.
  // --------------------------------------------------------------
  useEffect(() => {
    // Register a single listener for all events from the Node side.
    // Event names come from the embedded server's mobileBridge.js.
    nodejs.channel.addListener('server::ready', () => {
      console.log('[RN] server::ready');
      setStatusMessage('Server listening — checking vault…');
      // If we already have a vault path configured, jump straight to running.
      // Otherwise prompt the user to pick one.
      hasVaultPath().then((has) => {
        if (has) {
          setPhase('running');
        } else {
          setPhase('need-vault');
        }
      });
    });

    nodejs.channel.addListener('server::error', (msg: string) => {
      console.error('[RN] server::error', msg);
      setErrorMessage(msg);
      setPhase('error');
    });

    nodejs.channel.addListener('server::log', (msg: string) => {
      console.log('[Node]', msg);
    });
  }, []);

  // --------------------------------------------------------------
  // Start the Node.js runtime once on mount.
  // --------------------------------------------------------------
  useEffect(() => {
    if (nodeStartedRef.current) return;
    nodeStartedRef.current = true;

    // The main entry inside nodejs-assets/nodejs-project/main.js will be run.
    nodejs.start('main.js');
    console.log('[RN] nodejs.start() called');
  }, []);

  // --------------------------------------------------------------
  // Vault picker handler.
  // --------------------------------------------------------------
  const handlePickVault = useCallback(async () => {
    try {
      setStatusMessage('Pick a vault folder…');
      const pickedUri = await pickVaultFolder();
      if (!pickedUri) {
        setStatusMessage('No folder picked');
        return;
      }
      setStatusMessage('Importing vault into app storage… (this may take a moment)');
      // Copy the entire SAF tree into the app's internal files directory so
      // that Node.js has unrestricted fs access. We expose the destination
      // path back to Node via the bridge config file.
      const internalPath = await copySafTreeToInternal(pickedUri);
      await setVaultPath(internalPath);
      setStatusMessage('Vault ready. Restarting server…');
      // Tell the Node side to reload config + restart Express with the new path.
      nodejs.channel.post('vault::changed', {path: internalPath});
      // Give it a moment to rebind, then flip to running + reload WebView.
      setTimeout(() => {
        setWebviewKey((k) => k + 1);
        setPhase('running');
      }, 800);
    } catch (err: any) {
      console.error('[RN] handlePickVault failed', err);
      Alert.alert('Vault import failed', err?.message ?? String(err));
      setStatusMessage('Vault import failed');
    }
  }, []);

  // --------------------------------------------------------------
  // Render.
  // --------------------------------------------------------------
  if (phase === 'error') {
    return (
      <SafeAreaView style={styles.container}>
        <StatusBar barStyle="dark-content" />
        <View style={styles.center}>
          <Text style={styles.errorTitle}>Server failed to start</Text>
          <Text style={styles.errorBody}>{errorMessage}</Text>
          <Button title="Retry" onPress={() => {
            setErrorMessage(null);
            setPhase('starting-node');
            nodeStartedRef.current = false;
            setTimeout(() => {
              nodeStartedRef.current = true;
              nodejs.start('main.js');
            }, 100);
          }} />
        </View>
      </SafeAreaView>
    );
  }

  if (phase === 'need-vault') {
    return (
      <VaultPickerScreen onPick={handlePickVault} statusMessage={statusMessage} />
    );
  }

  if (phase !== 'running') {
    return (
      <ServerStatusScreen message={statusMessage} />
    );
  }

  // phase === 'running' — show the WebView.
  return (
    <SafeAreaView style={styles.container}>
      <StatusBar barStyle="dark-content" />
      <WebView
        key={webviewKey}
        source={{uri: SERVER_URL}}
        style={styles.webview}
        // Allow loading from localhost (cleartext) — declared in AndroidManifest.
        originWhitelist={['http://localhost', 'http://127.0.0.1', SERVER_URL]}
        // Inject a small JS bridge so the page can ask RN to open a folder picker
        // (used by the "Change vault" button in the in-app UI).
        injectedJavaScript={INJECTED_BRIDGE_JS}
        onMessage={(e) => {
          try {
            const msg = JSON.parse(e.nativeEvent.data);
            if (msg.type === 'pick-vault') handlePickVault();
          } catch (_) {}
        }}
        // Disable the in-app browser from intercepting our localhost requests.
        javaScriptEnabled
        domStorageEnabled
        allowFileAccess
        mixedContentMode="always"
        // Show a spinner while the page is loading.
        renderLoading={() => (
          <View style={styles.loadingOverlay}>
            <ActivityIndicator size="large" color="#7c3aed" />
          </View>
        )}
        startInLoadingState
      />
    </SafeAreaView>
  );
}

const INJECTED_BRIDGE_JS = `
(function(){
  if (window.__rnBridgeInstalled) return;
  window.__rnBridgeInstalled = true;
  window.__pickVaultFolder = function() {
    window.ReactNativeWebView && window.ReactNativeWebView.postMessage(JSON.stringify({type:'pick-vault'}));
  };
})();
`;

const styles = StyleSheet.create({
  container: {flex: 1, backgroundColor: '#0f172a'},
  webview: {flex: 1, backgroundColor: '#0f172a'},
  center: {flex: 1, justifyContent: 'center', alignItems: 'center', padding: 24},
  errorTitle: {color: '#fca5a5', fontSize: 18, fontWeight: '700', marginBottom: 8},
  errorBody: {color: '#e5e7eb', textAlign: 'center', marginBottom: 16},
  loadingOverlay: {
    position: 'absolute', left: 0, right: 0, top: 0, bottom: 0,
    alignItems: 'center', justifyContent: 'center',
    backgroundColor: '#0f172a',
  },
});
