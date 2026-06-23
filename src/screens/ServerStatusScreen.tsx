import React from 'react';
import {
  SafeAreaView, View, ActivityIndicator, Text, StyleSheet, StatusBar,
} from 'react-native';

interface Props {
  message: string;
}

/**
 * Full-screen spinner shown while the embedded Node.js runtime is booting
 * or while the server is rebinding to a new vault path.
 */
export function ServerStatusScreen({message}: Props) {
  return (
    <SafeAreaView style={styles.container}>
      <StatusBar barStyle="light-content" />
      <View style={styles.center}>
        <ActivityIndicator size="large" color="#a78bfa" />
        <Text style={styles.title}>Obsidian Tools</Text>
        <Text style={styles.message}>{message}</Text>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {flex: 1, backgroundColor: '#0f172a'},
  center: {flex: 1, justifyContent: 'center', alignItems: 'center', padding: 32},
  title: {color: '#f5f5f5', fontSize: 22, fontWeight: '700', marginTop: 24},
  message: {color: '#cbd5e1', fontSize: 14, marginTop: 8, textAlign: 'center'},
});
