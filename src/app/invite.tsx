import { router } from 'expo-router';
import React, { useState } from 'react';
import { KeyboardAvoidingView, Platform, StyleSheet, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Button } from '@/components/button';
import { usePopup } from '@/components/popup';
import { redeemInviteCode } from '@/lib/invite';
import { colors, radius } from '@/lib/theme';

// Invite-only beta gate: shown before onboarding on a fresh install whenever
// this device hasn't redeemed a code yet (see Gate in index.tsx). Publicly
// distributable TestFlight/APK links stay controlled since account creation
// is unreachable without a valid one-time code.
export default function Invite() {
  const popup = usePopup();
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (!code.trim() || busy) return;
    setBusy(true);
    try {
      const ok = await redeemInviteCode(code);
      if (ok) {
        router.replace('/onboarding');
      } else {
        popup.alert({ title: 'Invalid code', message: "That code isn't valid, or has already been used." });
      }
    } catch (e: any) {
      popup.alert({ title: 'Something went wrong', message: e?.message ?? 'Please try again.' });
    } finally {
      setBusy(false);
    }
  };

  return (
    <SafeAreaView style={styles.safe} edges={['top', 'bottom']}>
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <View style={styles.body}>
          <Text style={styles.title}>You&rsquo;re invited</Text>
          <Text style={styles.subtitle}>Pocket is in a private beta right now. Enter your invite code to continue.</Text>
          <TextInput
            style={styles.input}
            value={code}
            onChangeText={setCode}
            placeholder="Invite code"
            placeholderTextColor={colors.sub}
            autoCapitalize="characters"
            autoCorrect={false}
            returnKeyType="go"
            onSubmitEditing={submit}
          />
        </View>
        <View style={styles.bottom}>
          <Button title="Continue" onPress={submit} disabled={!code.trim()} loading={busy} />
        </View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.bg, padding: 20 },
  body: { flex: 1, justifyContent: 'center' },
  title: { fontSize: 26, fontWeight: '800', color: colors.ink, textAlign: 'center' },
  subtitle: { fontSize: 15, color: colors.sub, textAlign: 'center', marginTop: 10, marginBottom: 28, lineHeight: 21 },
  input: {
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.card,
    borderRadius: radius.md,
    paddingVertical: 14,
    paddingHorizontal: 16,
    fontSize: 18,
    fontWeight: '700',
    color: colors.ink,
    textAlign: 'center',
    letterSpacing: 2,
  },
  bottom: {},
});
