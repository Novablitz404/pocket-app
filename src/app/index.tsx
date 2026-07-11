import { Redirect } from 'expo-router';
import React, { useEffect, useState } from 'react';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';
import { Button } from '@/components/button';
import { ensureUnlocked } from '@/lib/biometrics';
import { colors } from '@/lib/theme';
import { useWallet } from '@/lib/wallet-context';

export default function Gate() {
  const { loading, publicKey } = useWallet();
  // null = auth in flight, true/false = result. Only existing accounts are
  // locked — onboarding shouldn't open with a Face ID prompt.
  const [unlocked, setUnlocked] = useState<boolean | null>(null);

  const authenticate = async () => {
    setUnlocked(null);
    setUnlocked(await ensureUnlocked('Unlock Remitt'));
  };

  useEffect(() => {
    if (loading) return;
    if (!publicKey) {
      setUnlocked(true);
      return;
    }
    authenticate();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading, publicKey]);

  if (loading || unlocked === null) {
    return (
      <View style={styles.center}>
        <ActivityIndicator color={colors.accent} />
      </View>
    );
  }

  if (!unlocked) {
    return (
      <View style={[styles.center, { padding: 32, gap: 16 }]}>
        <Text style={styles.lockedTitle}>Remitt is locked</Text>
        <Text style={styles.lockedSub}>Unlock with Face ID, fingerprint, or your passcode.</Text>
        <Button title="Unlock" onPress={authenticate} style={{ alignSelf: 'stretch', marginTop: 8 }} />
      </View>
    );
  }

  return <Redirect href={publicKey ? '/(tabs)/home' : '/onboarding'} />;
}

const styles = StyleSheet.create({
  center: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.bg,
  },
  lockedTitle: { fontSize: 24, fontWeight: '800', color: colors.ink },
  lockedSub: { fontSize: 15, color: colors.sub, textAlign: 'center' },
});
