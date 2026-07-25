import { Redirect } from 'expo-router';
import React, { useEffect, useState } from 'react';
import { ActivityIndicator, Image, StyleSheet, Text, View } from 'react-native';
import { Button } from '@/components/button';
import { ensureUnlocked } from '@/lib/biometrics';
import { isInviteRedeemed } from '@/lib/invite';
import { colors } from '@/lib/theme';
import { useWallet } from '@/lib/wallet-context';

export default function Gate() {
  const { loading, publicKey } = useWallet();
  // null = auth/invite check in flight, true/false = result. Only existing
  // accounts are locked — onboarding shouldn't open with a Face ID prompt.
  const [unlocked, setUnlocked] = useState<boolean | null>(null);
  // Only relevant on a fresh install (no publicKey yet) — gates the invite-
  // only beta before onboarding is reachable at all. Irrelevant once an
  // account exists on this device (recovery doesn't need re-inviting).
  const [inviteOk, setInviteOk] = useState<boolean | null>(null);

  const authenticate = async () => {
    setUnlocked(null);
    setUnlocked(await ensureUnlocked('Unlock Pocket'));
  };

  useEffect(() => {
    if (loading) return;
    if (!publicKey) {
      isInviteRedeemed().then(setInviteOk);
      setUnlocked(true);
      return;
    }
    authenticate();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading, publicKey]);

  if (loading || unlocked === null || (!publicKey && inviteOk === null)) {
    return (
      <View style={styles.center}>
        <ActivityIndicator color={colors.accent} />
      </View>
    );
  }

  if (!unlocked) {
    return (
      <View style={[styles.center, { padding: 32, gap: 16 }]}>
        <Image
          source={require('../../assets/pocket brand kit transparent/pocket_ver_wht.png')}
          style={styles.lockedLogo}
          resizeMode="contain"
        />
        <Text style={styles.lockedSub}>Unlock with Face ID, fingerprint, or your passcode.</Text>
        <Button title="Unlock" onPress={authenticate} style={{ alignSelf: 'stretch', marginTop: 8 }} />
      </View>
    );
  }

  if (publicKey) return <Redirect href="/(tabs)/home" />;
  return <Redirect href={inviteOk ? '/onboarding' : '/invite'} />;
}

const styles = StyleSheet.create({
  center: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.bg,
  },
  lockedLogo: { width: 320, height: 320 },
  lockedSub: { fontSize: 15, color: colors.sub, textAlign: 'center' },
});
