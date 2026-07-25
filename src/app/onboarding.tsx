import { Ionicons } from '@expo/vector-icons';
import { Image as CachedImage } from 'expo-image';
import { router } from 'expo-router';
import React, { useEffect, useRef, useState } from 'react';
import {
  Image,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import Animated, { SlideInLeft, SlideInRight, SlideOutLeft, SlideOutRight } from 'react-native-reanimated';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Button } from '@/components/button';
import { sendEmailOtp, verifyEmailOtp } from '@/lib/auth';
import { pickAvatarImage } from '@/lib/avatar';
import { ensurePinSetup } from '@/lib/biometrics';
import { usePopup } from '@/components/popup';
import { isUsernameTaken, isValidEmail, normalizeUsername } from '@/lib/directory';
import { colors, radius } from '@/lib/theme';
import { useWallet } from '@/lib/wallet-context';

const LOGO_WELCOME = require('../../assets/images/pocket-icon-welcome.png');

const CODE_LENGTH = 6;
const RESEND_COOLDOWN_S = 30;

// Three-phase onboarding: welcome (logo + pitch), details form, then email
// verification — the account is only created after the code checks out, so
// every account starts life with a verified email.
export default function Onboarding() {
  const { createAccount, confirmEmailVerified } = useWallet();
  const popup = usePopup();
  const [step, setStep] = useState<'welcome' | 'details' | 'verify'>('welcome');
  // Skip the slide-in the very first time welcome mounts (the screen itself
  // fades in via the router); slide only when navigating between phases.
  const [navigated, setNavigated] = useState(false);
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [username, setUsername] = useState('');
  const [email, setEmail] = useState('');
  const [avatarUri, setAvatarUri] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [code, setCode] = useState('');
  const [cooldown, setCooldown] = useState(0);
  const codeInputRef = useRef<TextInput>(null);

  useEffect(() => {
    if (cooldown <= 0) return;
    const t = setTimeout(() => setCooldown((s) => s - 1), 1000);
    return () => clearTimeout(t);
  }, [cooldown]);

  // Pop the keyboard once the verify step has slid in (autoFocus on mount
  // gets lost inside the entering animation).
  useEffect(() => {
    if (step !== 'verify') return;
    const t = setTimeout(() => codeInputRef.current?.focus(), 450);
    return () => clearTimeout(t);
  }, [step]);

  const pickAvatar = async () => {
    try {
      const uri = await pickAvatarImage();
      if (uri) setAvatarUri(uri);
    } catch (e: any) {
      popup.alert({ title: 'Could not open photos', message: e?.message ?? 'Please try again.' });
    }
  };

  const ready =
    firstName.trim().length >= 1 &&
    lastName.trim().length >= 1 &&
    username.trim().length >= 2 &&
    isValidEmail(email);

  // Submit = validate + email the code. Nothing is created yet.
  const submit = async () => {
    setCreating(true);
    try {
      const handle = username.trim();
      if (await isUsernameTaken(handle)) {
        popup.alert({ title: 'Username taken', message: `"${handle}" is already in use. Try another.` });
        return;
      }
      await sendEmailOtp(email.trim());
      setCooldown(RESEND_COOLDOWN_S);
      setCode('');
      setStep('verify');
    } catch (e: any) {
      popup.alert({ title: 'Something went wrong', message: e?.message ?? 'Please try again.' });
    } finally {
      setCreating(false);
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

  // A correct code is what actually opens the account: create → mark the
  // email verified → passcode → home.
  const verifyAndCreate = async (candidate: string) => {
    if (creating) return;
    setCreating(true);
    try {
      const accessToken = await verifyEmailOtp(email.trim(), candidate);
      await createAccount(firstName.trim(), lastName.trim(), username.trim(), email.trim(), avatarUri ?? undefined);
      await confirmEmailVerified(accessToken);
      // Lock the new account behind a passcode before it holds money.
      await ensurePinSetup();
      router.replace('/(tabs)/home');
    } catch (e: any) {
      setCode('');
      popup.alert({ title: 'Could not verify', message: e?.message ?? 'Check the code and try again.' });
    } finally {
      setCreating(false);
    }
  };

  const onCodeChange = (raw: string) => {
    const digits = raw.replace(/\D/g, '').slice(0, CODE_LENGTH);
    setCode(digits);
    if (digits.length === CODE_LENGTH) verifyAndCreate(digits);
  };

  if (step === 'welcome') {
    return (
      <SafeAreaView style={styles.safe}>
        <Animated.View
          key="welcome"
          entering={navigated ? SlideInLeft : undefined}
          exiting={SlideOutLeft}
          style={styles.container}
        >
          <View style={styles.welcomeHero}>
            <CachedImage
              source={LOGO_WELCOME}
              style={styles.logo}
              contentFit="contain"
              cachePolicy="memory"
            />
            <Text style={styles.headline}>
              Your digital world,{'\n'}
              <Text style={{ color: colors.accentDark }}>in your pocket.</Text>
            </Text>
            <Text style={styles.sub}>
              Send, earn, and save digital dollars instantly.{'\n'}No bank required.
            </Text>
          </View>
          <Button
            title="Open my account"
            onPress={() => {
              setNavigated(true);
              setStep('details');
            }}
          />
          <Pressable onPress={() => router.push('/recover')} hitSlop={8}>
            <Text style={styles.recoverLink}>I already have an account</Text>
          </Pressable>
          <Text style={styles.finePrint}>Free to open · No minimums · Transfer anytime</Text>
        </Animated.View>
      </SafeAreaView>
    );
  }

  if (step === 'verify') {
    return (
      <SafeAreaView style={styles.safe}>
        <KeyboardAvoidingView
          style={{ flex: 1 }}
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        >
          <Animated.View key="verify" entering={SlideInRight} exiting={SlideOutRight} style={styles.container}>
            <View style={styles.detailsHeader}>
              <Pressable onPress={() => setStep('details')} hitSlop={12}>
                <Ionicons name="arrow-back" size={26} color={colors.ink} />
              </Pressable>
              <View style={{ width: 26 }} />
            </View>
            <View style={styles.verifyCenter}>
              <Text style={styles.detailsTitle}>Verify your email</Text>
              <Text style={[styles.detailsSub, { textAlign: 'center' }]}>
                We sent a {CODE_LENGTH}-digit code to{'\n'}
                <Text style={styles.verifyEmail}>{email.trim().toLowerCase()}</Text>
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
              title="Verify & open my account"
              onPress={() => verifyAndCreate(code)}
              disabled={code.length !== CODE_LENGTH}
              loading={creating}
            />
            <Text style={styles.finePrint}>Your account is created once the code checks out.</Text>
          </Animated.View>
        </KeyboardAvoidingView>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.safe}>
      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <Animated.View key="details" entering={SlideInRight} exiting={SlideOutRight} style={styles.container}>
          <View style={styles.detailsHeader}>
            <Pressable onPress={() => setStep('welcome')} hitSlop={12}>
              <Ionicons name="arrow-back" size={26} color={colors.ink} />
            </Pressable>
            <View style={{ width: 26 }} />
          </View>
          <Text style={styles.detailsTitle}>Set up your account</Text>
          <Text style={styles.detailsSub}>This takes less than a minute.</Text>
          <View style={{ gap: 12, marginTop: 24 }}>
            <Pressable onPress={pickAvatar} style={({ pressed }) => [styles.avatarPick, pressed && { opacity: 0.7 }]}>
              {avatarUri ? (
                <Image source={{ uri: avatarUri }} style={styles.avatarImage} />
              ) : (
                <View style={styles.avatarPlaceholder}>
                  <Ionicons name="camera-outline" size={36} color={colors.sub} />
                </View>
              )}
              <Text style={styles.avatarLabel}>{avatarUri ? 'Change photo' : 'Add a photo (optional)'}</Text>
            </Pressable>
            <View style={styles.row}>
              <TextInput
                style={[styles.input, { flex: 1 }]}
                placeholder="First name"
                placeholderTextColor={colors.sub}
                value={firstName}
                onChangeText={setFirstName}
                autoCapitalize="words"
                returnKeyType="next"
              />
              <TextInput
                style={[styles.input, { flex: 1 }]}
                placeholder="Last name"
                placeholderTextColor={colors.sub}
                value={lastName}
                onChangeText={setLastName}
                autoCapitalize="words"
                returnKeyType="next"
              />
            </View>
            <TextInput
              style={styles.input}
              placeholder="Choose a username"
              placeholderTextColor={colors.sub}
              value={username}
              onChangeText={(t) => setUsername(normalizeUsername(t))}
              autoCapitalize="none"
              autoCorrect={false}
              returnKeyType="next"
            />
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
            />
          </View>
          <View style={{ flex: 1 }} />
          <Button title="Submit" onPress={submit} loading={creating} disabled={!ready} />
          <Text style={styles.finePrint}>
            Free to open · No minimums · Transfer anytime
          </Text>
        </Animated.View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.bg },
  container: { flex: 1, padding: 24 },
  welcomeHero: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  logo: { width: 280, height: 280, marginBottom: 36 },
  headline: {
    fontSize: 34,
    fontWeight: '800',
    color: colors.ink,
    lineHeight: 42,
    textAlign: 'center',
  },
  sub: {
    fontSize: 16,
    color: colors.sub,
    marginTop: 16,
    lineHeight: 24,
    textAlign: 'center',
  },
  detailsHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 24,
  },
  detailsTitle: { fontSize: 28, fontWeight: '800', color: colors.ink },
  detailsSub: { fontSize: 15, color: colors.sub, marginTop: 8, lineHeight: 22 },
  verifyCenter: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  verifyEmail: { color: colors.ink, fontWeight: '700' },
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
  resend: {
    textAlign: 'center',
    color: colors.accentDark,
    fontWeight: '700',
    fontSize: 14,
    marginTop: 24,
  },
  row: { flexDirection: 'row', gap: 12 },
  input: {
    height: 56,
    borderRadius: radius.md,
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.border,
    paddingHorizontal: 18,
    fontSize: 17,
    color: colors.ink,
  },
  finePrint: { textAlign: 'center', color: colors.sub, fontSize: 13, marginTop: 10, marginBottom: 8 },
  recoverLink: {
    textAlign: 'center',
    color: colors.accentDark,
    fontWeight: '700',
    fontSize: 15,
    marginTop: 16,
  },
  avatarPick: { flexDirection: 'column', alignItems: 'center', gap: 8, alignSelf: 'center' },
  avatarImage: { width: 96, height: 96, borderRadius: 48, backgroundColor: colors.border },
  avatarPlaceholder: {
    width: 96,
    height: 96,
    borderRadius: 48,
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.border,
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarLabel: { fontSize: 14, fontWeight: '600', color: colors.sub },
});
