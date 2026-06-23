import React from 'react';
import {
  SafeAreaView, View, Text, StyleSheet, StatusBar, TouchableOpacity, ActivityIndicator,
} from 'react-native';

interface Props {
  onPick: () => void;
  statusMessage: string;
}

/**
 * Shown the first time the app is launched (or whenever no vault folder has
 * been picked yet). Lets the user open the Android SAF folder picker.
 */
export function VaultPickerScreen({onPick, statusMessage}: Props) {
  const isWorking = statusMessage.startsWith('Importing') || statusMessage.startsWith('Pick a vault');
  return (
    <SafeAreaView style={styles.container}>
      <StatusBar barStyle="light-content" />
      <View style={styles.content}>
        <Text style={styles.emoji}>📁</Text>
        <Text style={styles.title}>Choose your Obsidian vault</Text>
        <Text style={styles.subtitle}>
          Pick the folder that contains your Obsidian notes. The app will import
          a private copy of your vault into the app so the embedded server can
          read and write to it.
        </Text>
        <Text style={styles.hint}>
          Tip: long-press a folder inside the picker to select it as the vault
          root.
        </Text>
        <TouchableOpacity style={styles.button} onPress={onPick} disabled={isWorking}>
          {isWorking ? (
            <ActivityIndicator color="#fff" />
          ) : (
            <Text style={styles.buttonText}>Pick vault folder</Text>
          )}
        </TouchableOpacity>
        <Text style={styles.status}>{statusMessage}</Text>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {flex: 1, backgroundColor: '#0f172a'},
  content: {flex: 1, justifyContent: 'center', alignItems: 'center', padding: 32},
  emoji: {fontSize: 72, marginBottom: 16},
  title: {color: '#f5f5f5', fontSize: 22, fontWeight: '700', textAlign: 'center', marginBottom: 12},
  subtitle: {color: '#cbd5e1', fontSize: 14, textAlign: 'center', lineHeight: 20, marginBottom: 12},
  hint: {color: '#94a3b8', fontSize: 12, textAlign: 'center', fontStyle: 'italic', marginBottom: 32},
  button: {
    backgroundColor: '#7c3aed', paddingVertical: 14, paddingHorizontal: 32,
    borderRadius: 12, minWidth: 220, alignItems: 'center',
  },
  buttonText: {color: '#fff', fontSize: 16, fontWeight: '600'},
  status: {color: '#94a3b8', fontSize: 12, marginTop: 24, textAlign: 'center'},
});
