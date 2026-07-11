import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import React, { useEffect, useRef, useState } from 'react';
import {
  Keyboard,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Button } from '@/components/button';
import { usePopup } from '@/components/popup';
import { sendEmailOtp, verifyEmailOtp } from '@/lib/auth';
import { colors, radius } from '@/lib/theme';
import { useWallet } from '@/lib/wallet-context';

const CODE_LENGTH = 6;
const RESEND_COOLDOWN_S = 30;

/** Email verification for EXISTING accounts (Settings → "Verify email"):
 *  a 6-digit OTP is mailed on mount (Supabase Auth via Resend); a correct
 *  code marks the email verified — the anchor account recovery hangs off.
 *  New signups verify inside onboarding instead, before the account exists. */
export default function VerifyEmail() {
  const { email, emailVerified, confirmEmailVerified } = useWallet();
  const popup = usePopup();
  const [code, setCode] = useState('');
  const [verifying, setVerifying] = useState(false);
  const [cooldown, setCooldown] = useState(0);
  const inputRef = useRef<TextInput>(null);
  const sentOnce = useRef(false);

  const done = () => {
    if (router.canGoBack()) router.back();
    else router.replace('/(tabs)/home');
  };

  const send = async () => {
    if (!email) return;
    try {
      await sendEmailOtp(email);
      setCooldown(RESEND_COOLDOWN_S);
    } catch (e: any) {
      popup.alert({ title: 'Could not send the code', message: e?.message ?? 'Please try again.' });
    }
  };

  // One code on arrival; the resend button handles the rest.
  useEffect(() => {
    if (sentOnce.current || !email || emailVerified) return;
    sentOnce.current = true;
    send();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [email]);

  useEffect(() => {
    if (cooldown <= 0) return;
    const t = setTimeout(() => setCooldown((s) => s - 1), 1000);
    return () => clearTimeout(t);
  }, [cooldown]);

  // Pop the keyboard after the sheet's slide-up settles (autoFocus on mount
  // can get swallowed by the modal transition).
  useEffect(() => {
    const t = setTimeout(() => inputRef.current?.focus(), 450);
    return () => clearTimeout(t);
  }, []);

  const verify = async (candidate: string) => {
    if (!email || verifying) return;
    setVerifying(true);
    try {
      const accessToken = await verifyEmailOtp(email, candidate);
      await confirmEmailVerified(accessToken);
      Keyboard.dismiss();
      await popup.alert({
        title: 'Email verified',
        message: 'Your account can now be recovered with this email if you ever lose your phone.',
        confirmText: 'Done',
      });
      done();
    } catch (e: any) {
      setCode('');
      popup.alert({ title: 'Wrong code', message: e?.message ?? 'Check the code and try again.' });
    } finally {
      setVerifying(false);
    }
  };

  const onChange = (raw: string) => {
    const digits = raw.replace(/\D/g, '').slice(0, CODE_LENGTH);
    setCode(digits);
    if (digits.length === CODE_LENGTH) verify(digits);
  };

  if (!email) return null;

  return (
    <SafeAreaView style={styles.safe} edges={['top', 'bottom']}>
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <View style={styles.header}>
          <Text style={styles.title}>Verify your email</Text>
          <Pressable onPress={done} hitSlop={12}>
            <Ionicons name="close" size={26} color={colors.ink} />
          </Pressable>
        </View>

        <Text style={styles.sub}>
          We sent a {CODE_LENGTH}-digit code to{'\n'}
          <Text style={styles.email}>{email}</Text>
        </Text>

        {/* The invisible input is stretched over the boxes, so any tap on
            them lands on the input itself and opens the keyboard. */}
        <View style={styles.boxesWrap}>
          <View style={styles.boxes}>
            {Array.from({ length: CODE_LENGTH }).map((_, i) => (
              <View key={i} style={[styles.box, i === code.length && styles.boxActive]}>
                <Text style={styles.boxDigit}>{code[i] ?? ''}</Text>
              </View>
            ))}
          </View>
          <TextInput
            ref={inputRef}
            style={styles.inputOverlay}
            value={code}
            onChangeText={onChange}
            keyboardType="number-pad"
            textContentType="oneTimeCode"
            autoComplete="one-time-code"
            caretHidden
            maxLength={CODE_LENGTH}
          />
        </View>

        <Pressable onPress={send} disabled={cooldown > 0} hitSlop={8}>
          <Text style={[styles.resend, cooldown > 0 && { color: colors.sub }]}>
            {cooldown > 0 ? `Resend code in ${cooldown}s` : 'Resend code'}
          </Text>
        </Pressable>

        <View style={{ flex: 1 }} />
        <Button
          title="Verify"
          onPress={() => verify(code)}
          disabled={code.length !== CODE_LENGTH}
          loading={verifying}
        />
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.bg, padding: 20 },
  header: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  title: { fontSize: 22, fontWeight: '800', color: colors.ink },
  sub: { fontSize: 15, color: colors.sub, marginTop: 16, lineHeight: 22 },
  email: { color: colors.ink, fontWeight: '700' },
  boxesWrap: { marginTop: 28 },
  boxes: { flexDirection: 'row', gap: 10, justifyContent: 'center' },
  inputOverlay: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    opacity: 0,
    fontSize: 1,
    color: 'transparent',
  },
  box: {
    width: 48,
    height: 58,
    borderRadius: radius.md,
    backgroundColor: colors.card,
    borderWidth: 1.5,
    borderColor: colors.border,
    alignItems: 'center',
    justifyContent: 'center',
  },
  boxActive: { borderColor: colors.accent },
  boxDigit: { fontSize: 26, fontWeight: '800', color: colors.ink },
  resend: {
    textAlign: 'center',
    color: colors.accentDark,
    fontWeight: '700',
    fontSize: 14,
    marginTop: 22,
  },
});
