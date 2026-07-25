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
import Animated, { SlideInRight, SlideOutRight } from 'react-native-reanimated';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Button } from '@/components/button';
import { usePopup } from '@/components/popup';
import { sendEmailOtp, verifyEmailOtp } from '@/lib/auth';
import { ensurePinSetup } from '@/lib/biometrics';
import { isValidEmail } from '@/lib/directory';
import { colors, radius } from '@/lib/theme';
import { useWallet } from '@/lib/wallet-context';


const CODE_LENGTH = 6;
const RESEND_COOLDOWN_S = 30;

const PIN_LENGTH = 4;

/** Account recovery ("I already have an account"): the email OTP proves the
 *  inbox, the 4-digit passcode proves it's you (checked server-side against
 *  a bcrypt hash, 5 tries then a 15-minute lockout), then the account is
 *  re-keyed to this device — funds and username come back, the old phone's
 *  key stops working. */
export default function Recover() {
  const { recoverExistingAccount } = useWallet();
  const popup = usePopup();
  const [step, setStep] = useState<'email' | 'code' | 'pin'>('email');
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [pin, setPin] = useState('');
  // Session minted by the OTP; unlocks the email → profile lookup on the server.
  const [accessToken, setAccessToken] = useState('');
  const [busy, setBusy] = useState(false);
  const [cooldown, setCooldown] = useState(0);
  const codeInputRef = useRef<TextInput>(null);
  const pinInputRef = useRef<TextInput>(null);

  useEffect(() => {
    if (cooldown <= 0) return;
    const t = setTimeout(() => setCooldown((s) => s - 1), 1000);
    return () => clearTimeout(t);
  }, [cooldown]);

  // Pop the keyboard once the code/pin step has slid in (autoFocus on mount
  // gets lost inside the entering animation).
  useEffect(() => {
    if (step === 'email') return;
    const ref = step === 'code' ? codeInputRef : pinInputRef;
    const t = setTimeout(() => ref.current?.focus(), 450);
    return () => clearTimeout(t);
  }, [step]);

  const sendCode = async () => {
    setBusy(true);
    try {
      await sendEmailOtp(email.trim());
      setCooldown(RESEND_COOLDOWN_S);
      setCode('');
      setStep('code');
    } catch (e: any) {
      popup.alert({ title: 'Could not send the code', message: e?.message ?? 'Please try again.' });
    } finally {
      setBusy(false);
    }
  };

  const resendCode = async () => {
    try {
      await sendEmailOtp(email.trim());
      setCooldown(RESEND_COOLDOWN_S);
    } catch (e: any) {
      popup.alert({ title: 'Could not send the code', message: e?.message ?? 'Please try again.' });
    }
  };

  // A correct code hands back a session token; the passcode step then uses it
  // for the email → account lookup and the re-key to this device.
  const verifyCode = async (candidate: string) => {
    if (busy) return;
    setBusy(true);
    try {
      const token = await verifyEmailOtp(email.trim(), candidate);
      setAccessToken(token);
      setPin('');
      setStep('pin');
    } catch (e: any) {
      setCode('');
      popup.alert({ title: 'Wrong code', message: e?.message ?? 'Check the code and try again.' });
    } finally {
      setBusy(false);
    }
  };

  const recover = async (candidatePin: string) => {
    if (busy) return;
    setBusy(true);
    try {
      await recoverExistingAccount(email.trim(), accessToken, candidatePin);
      Keyboard.dismiss();
      // The recovered account holds money — lock it before showing it. This
      // becomes the account's new recovery passcode; candidatePin (just
      // proven correct by recoverExistingAccount's own check) is forwarded
      // so the sync can pass set_recovery_pin's now-required proof — without
      // it, the very first post-recovery PIN change would be silently
      // rejected server-side, leaving the OLD pin as the "real" one forever.
      await ensurePinSetup(candidatePin);
      router.replace('/(tabs)/home');
    } catch (e: any) {
      setPin('');
      popup.alert({ title: 'Could not recover', message: e?.message ?? 'Please try again.' });
    } finally {
      setBusy(false);
    }
  };

  const onCodeChange = (raw: string) => {
    const digits = raw.replace(/\D/g, '').slice(0, CODE_LENGTH);
    setCode(digits);
    if (digits.length === CODE_LENGTH) verifyCode(digits);
  };

  const onPinChange = (raw: string) => {
    const digits = raw.replace(/\D/g, '').slice(0, PIN_LENGTH);
    setPin(digits);
    if (digits.length === PIN_LENGTH) recover(digits);
  };

  if (step === 'code') {
    return (
      <SafeAreaView style={styles.safe}>
        <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
          <Animated.View key="code" entering={SlideInRight} exiting={SlideOutRight} style={styles.container}>
            <View style={styles.header}>
              <Pressable onPress={() => setStep('email')} hitSlop={12}>
                <Ionicons name="arrow-back" size={26} color={colors.ink} />
              </Pressable>
              <View style={{ width: 26 }} />
            </View>
            <View style={styles.center}>
              <Text style={styles.title}>Check your email</Text>
              <Text style={[styles.sub, { textAlign: 'center' }]}>
                We sent a {CODE_LENGTH}-digit code to{'\n'}
                <Text style={styles.emailText}>{email.trim().toLowerCase()}</Text>
              </Text>
              {/* The invisible input is stretched over the boxes, so any tap
                  on them lands on the input itself and opens the keyboard. */}
              <View style={styles.codeWrap}>
                <View style={styles.codeBoxes}>
                  {Array.from({ length: CODE_LENGTH }).map((_, i) => (
                    <View key={i} style={[styles.codeBox, i === code.length && styles.codeBoxActive]}>
                      <Text style={styles.codeDigit}>{code[i] ?? ''}</Text>
                    </View>
                  ))}
                </View>
                <TextInput
                  ref={codeInputRef}
                  style={styles.codeInputOverlay}
                  value={code}
                  onChangeText={onCodeChange}
                  keyboardType="number-pad"
                  textContentType="oneTimeCode"
                  autoComplete="one-time-code"
                  caretHidden
                  maxLength={CODE_LENGTH}
                />
              </View>
              <Pressable onPress={resendCode} disabled={cooldown > 0} hitSlop={8}>
                <Text style={[styles.resend, cooldown > 0 && { color: colors.sub }]}>
                  {cooldown > 0 ? `Resend code in ${cooldown}s` : 'Resend code'}
                </Text>
              </Pressable>
            </View>
            <Button
              title="Continue"
              onPress={() => verifyCode(code)}
              disabled={code.length !== CODE_LENGTH}
              loading={busy}
            />
            <Text style={styles.finePrint}>One more step after this: your Pocket passcode.</Text>
          </Animated.View>
        </KeyboardAvoidingView>
      </SafeAreaView>
    );
  }

  if (step === 'pin') {
    return (
      <SafeAreaView style={styles.safe}>
        <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
          <Animated.View key="pin" entering={SlideInRight} exiting={SlideOutRight} style={styles.container}>
            <View style={styles.header}>
              <Pressable onPress={() => setStep('email')} hitSlop={12}>
                <Ionicons name="arrow-back" size={26} color={colors.ink} />
              </Pressable>
              <View style={{ width: 26 }} />
            </View>
            <View style={styles.center}>
              <Text style={styles.title}>Enter your passcode</Text>
              <Text style={[styles.sub, { textAlign: 'center' }]}>
                The 4-digit passcode you use to{'\n'}unlock Pocket.
              </Text>
              {/* Same invisible-input trick as the code step; the digits render
                  as dots — it's a passcode, not a mailed code. */}
              <View style={styles.codeWrap}>
                <View style={styles.codeBoxes}>
                  {Array.from({ length: PIN_LENGTH }).map((_, i) => (
                    <View key={i} style={[styles.codeBox, i === pin.length && styles.codeBoxActive]}>
                      {pin[i] ? <View style={styles.pinDot} /> : null}
                    </View>
                  ))}
                </View>
                <TextInput
                  ref={pinInputRef}
                  style={styles.codeInputOverlay}
                  value={pin}
                  onChangeText={onPinChange}
                  keyboardType="number-pad"
                  secureTextEntry
                  caretHidden
                  maxLength={PIN_LENGTH}
                />
              </View>
            </View>
            <Button
              title="Recover my account"
              onPress={() => recover(pin)}
              disabled={pin.length !== PIN_LENGTH}
              loading={busy}
            />
            <Text style={styles.finePrint}>
              Recovering moves your account to this phone. Your old phone will no longer have access.
            </Text>
          </Animated.View>
        </KeyboardAvoidingView>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.safe}>
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <View style={styles.container}>
          <View style={styles.header}>
            <Pressable onPress={() => router.back()} hitSlop={12}>
              <Ionicons name="arrow-back" size={26} color={colors.ink} />
            </Pressable>
            <View style={{ width: 26 }} />
          </View>
          <Text style={styles.title}>Recover your account</Text>
          <Text style={styles.sub}>
            Enter the email on your account and we&apos;ll send you a code. Your money and username
            come back with it.
          </Text>
          <TextInput
            style={styles.input}
            placeholder="Email"
            placeholderTextColor={colors.sub}
            value={email}
            onChangeText={setEmail}
            autoCapitalize="none"
            autoCorrect={false}
            autoComplete="email"
            keyboardType="email-address"
            returnKeyType="done"
            autoFocus
            onSubmitEditing={() => isValidEmail(email) && sendCode()}
          />
          <View style={{ flex: 1 }} />
          <Button title="Send code" onPress={sendCode} loading={busy} disabled={!isValidEmail(email)} />
          <Text style={styles.finePrint}>Only works if you verified your email on the old phone.</Text>
        </View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.bg },
  container: { flex: 1, padding: 24 },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 24,
  },
  title: { fontSize: 28, fontWeight: '800', color: colors.ink },
  sub: { fontSize: 15, color: colors.sub, marginTop: 8, lineHeight: 22 },
  emailText: { color: colors.ink, fontWeight: '700' },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  input: {
    height: 56,
    borderRadius: radius.md,
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.border,
    paddingHorizontal: 18,
    fontSize: 17,
    color: colors.ink,
    marginTop: 24,
  },
  codeWrap: { marginTop: 28 },
  codeBoxes: { flexDirection: 'row', gap: 10, justifyContent: 'center' },
  codeInputOverlay: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    opacity: 0,
    fontSize: 1,
    color: 'transparent',
  },
  codeBox: {
    width: 48,
    height: 58,
    borderRadius: radius.md,
    backgroundColor: colors.card,
    borderWidth: 1.5,
    borderColor: colors.border,
    alignItems: 'center',
    justifyContent: 'center',
  },
  codeBoxActive: { borderColor: colors.accent },
  codeDigit: { fontSize: 26, fontWeight: '800', color: colors.ink },
  pinDot: { width: 14, height: 14, borderRadius: radius.full, backgroundColor: colors.ink },
  resend: {
    textAlign: 'center',
    color: colors.accentDark,
    fontWeight: '700',
    fontSize: 14,
    marginTop: 24,
  },
  finePrint: { textAlign: 'center', color: colors.sub, fontSize: 13, marginTop: 10, marginBottom: 8 },
});
