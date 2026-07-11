import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import * as LocalAuthentication from 'expo-local-authentication';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Image, Modal, Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import { FullWindowOverlay } from 'react-native-screens';
import * as SecureStore from 'expo-secure-store';
import { syncRecoveryPin } from '@/lib/auth';
import * as pin from '@/lib/pin';
import { colors, radius } from '@/lib/theme';
import { PUBLIC_KEY } from '@/lib/wallet-context';

// Remitt's own lock UI: a full-screen branded passcode pad. Face ID /
// fingerprint fires as a small system overlay ON TOP of this screen (the
// sheet itself can't be reskinned — the OS draws it so users can trust it),
// and our PIN pad is the fallback beneath it, replacing the OS device-passcode
// screen entirely.
//
// Mount <LockProvider> once at the root. Screens never use this directly —
// they call ensureUnlocked() from lib/biometrics, which presents this via a
// module-level registry (so no hooks are needed at call sites).

export interface LockRequest {
  /** 'unlock' verifies; 'create' runs the enter→confirm setup flow. */
  mode: 'unlock' | 'create';
  /** Shown under the title, e.g. "Send $25.00". */
  reason?: string;
  /** Hide the Cancel action (first-time setup after onboarding). */
  cancelable?: boolean;
  /** 'create' only: the PIN just proven correct (via a prior 'unlock', or
   *  supplied out-of-band, e.g. account recovery's PIN step) — forwarded to
   *  the server as proof when the new PIN syncs, since set_recovery_pin now
   *  requires the current PIN to overwrite an existing row. Omit for a
   *  brand-new account with no server-side PIN to prove yet. */
  priorPin?: string;
  /** 'unlock' only: skip the Face ID/fingerprint auto-fire and force typing
   *  the PIN — needed wherever the caller has to capture the actual digits
   *  afterward (changePasscode, via consumeLastUnlockedPin), since a
   *  biometric pass proves identity but yields no PIN value to forward. */
  disableBiometrics?: boolean;
}

type Presenter = (request: LockRequest) => Promise<boolean>;
let presenter: Presenter | null = null;

/** Present the lock screen; resolves true when the user passed the gate. */
export function presentLock(request: LockRequest): Promise<boolean> {
  if (!presenter) return Promise.resolve(true); // provider not mounted: don't brick
  return presenter(request);
}

// The digits just verified during an 'unlock', so callers that immediately
// chain into a 'create' (biometrics.ts's changePasscode) can pass them along
// as priorPin without exposing a wider PIN-reading API. In-memory only,
// consumed once — never persisted.
let lastUnlockedPin: string | null = null;

/** Reads and clears the PIN captured by the most recent successful 'unlock'.
 *  Returns null if nothing was captured (e.g. biometrics-only unlock). */
export function consumeLastUnlockedPin(): string | null {
  const p = lastUnlockedPin;
  lastUnlockedPin = null;
  return p;
}

/** Face ID / fingerprint only — our PIN pad is the fallback, never the OS one. */
async function tryBiometrics(reason: string): Promise<boolean> {
  try {
    const [hasHardware, enrolled] = await Promise.all([
      LocalAuthentication.hasHardwareAsync(),
      LocalAuthentication.isEnrolledAsync(),
    ]);
    if (!hasHardware || !enrolled) return false;
    const result = await LocalAuthentication.authenticateAsync({
      promptMessage: reason,
      cancelLabel: 'Use passcode',
      disableDeviceFallback: true,
    });
    return result.success;
  } catch {
    return false;
  }
}

async function biometricsAvailable(): Promise<boolean> {
  try {
    const [hasHardware, enrolled] = await Promise.all([
      LocalAuthentication.hasHardwareAsync(),
      LocalAuthentication.isEnrolledAsync(),
    ]);
    return hasHardware && enrolled;
  } catch {
    return false;
  }
}

const PAD_KEYS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', 'bio', '0', 'del'] as const;

interface ActiveLock extends LockRequest {
  resolve: (ok: boolean) => void;
}

export function LockProvider({ children }: { children: React.ReactNode }) {
  const [active, setActive] = useState<ActiveLock | null>(null);
  // 'enter' verifies (unlock) or takes the new PIN (create); 'confirm' re-takes it.
  const [phase, setPhase] = useState<'enter' | 'confirm'>('enter');
  const [digits, setDigits] = useState('');
  const [firstPin, setFirstPin] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [lockedSec, setLockedSec] = useState(0);
  const [bioAvailable, setBioAvailable] = useState(false);
  const checking = useRef(false);

  const present = useCallback((request: LockRequest) => {
    return new Promise<boolean>((resolve) => {
      setPhase('enter');
      setDigits('');
      setFirstPin('');
      setError(null);
      setActive({ ...request, resolve });
    });
  }, []);

  useEffect(() => {
    presenter = present;
    return () => {
      presenter = null;
    };
  }, [present]);

  const finish = useCallback(
    (ok: boolean) => {
      active?.resolve(ok);
      setActive(null);
    },
    [active],
  );

  // Fire Face ID / fingerprint automatically when an unlock is presented.
  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    (async () => {
      const available = await biometricsAvailable();
      if (cancelled) return;
      const bioAllowed = available && active.mode === 'unlock' && !active.disableBiometrics;
      setBioAvailable(bioAllowed);
      if (bioAllowed) {
        const ok = await tryBiometrics(active.reason ?? 'Unlock Remitt');
        if (!cancelled && ok) finish(true);
      }
      // Surface an existing cooldown (e.g. app reopened mid-lockout).
      if (active.mode === 'unlock') {
        const ms = await pin.lockedForMs();
        if (!cancelled && ms > 0) setLockedSec(Math.ceil(ms / 1000));
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);

  // Tick the lockout countdown down to zero.
  useEffect(() => {
    if (lockedSec <= 0) return;
    const t = setTimeout(() => setLockedSec((s) => s - 1), 1000);
    return () => clearTimeout(t);
  }, [lockedSec]);

  const onComplete = useCallback(
    async (entered: string) => {
      if (checking.current || !active) return;
      checking.current = true;
      try {
        if (active.mode === 'create') {
          if (phase === 'enter') {
            setFirstPin(entered);
            setPhase('confirm');
            setDigits('');
            setError(null);
            return;
          }
          if (entered !== firstPin) {
            Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error).catch(() => {});
            setPhase('enter');
            setDigits('');
            setFirstPin('');
            setError("Those didn't match. Start over.");
            return;
          }
          await pin.setPin(entered);
          // Mirror the new passcode server-side as the recovery second
          // factor. Fire-and-forget: recovery tolerates a missing PIN row.
          // priorPin proves the change to set_recovery_pin when a row
          // already exists (see LockRequest.priorPin).
          const priorPin = active.priorPin;
          SecureStore.getItemAsync(PUBLIC_KEY)
            .then((address) => (address ? syncRecoveryPin(address, entered, priorPin) : undefined))
            .catch(() => {});
          finish(true);
          return;
        }
        const result = await pin.verifyPin(entered);
        if (result.ok) {
          lastUnlockedPin = entered;
          finish(true);
          return;
        }
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error).catch(() => {});
        setDigits('');
        if ('lockedForMs' in result) {
          setLockedSec(Math.ceil(result.lockedForMs / 1000));
          setError(null);
        } else {
          setError(
            result.remaining === 1
              ? 'Wrong passcode. 1 attempt left.'
              : `Wrong passcode. ${result.remaining} attempts left.`,
          );
        }
      } finally {
        checking.current = false;
      }
    },
    [active, phase, firstPin, finish],
  );

  const press = (key: (typeof PAD_KEYS)[number]) => {
    if (!active || lockedSec > 0) return;
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
    if (key === 'bio') {
      tryBiometrics(active.reason ?? 'Unlock Remitt').then((ok) => ok && finish(true));
      return;
    }
    if (key === 'del') {
      setDigits((d) => d.slice(0, -1));
      return;
    }
    setDigits((d) => {
      if (d.length >= pin.PIN_LENGTH) return d;
      const next = d + key;
      if (next.length === pin.PIN_LENGTH) {
        // Let the last dot render before verifying.
        setTimeout(() => onComplete(next), 80);
      }
      return next;
    });
  };

  const title =
    active?.mode === 'create'
      ? phase === 'enter'
        ? 'Create your passcode'
        : 'Confirm your passcode'
      : 'Enter your passcode';
  const subtitle =
    active?.mode === 'create'
      ? 'Protects your money on this phone.'
      : active?.reason ?? 'Unlock Remitt';

  const screen = active && (
    <View style={styles.screen}>
      <View style={styles.top}>
        <Image
          source={require('../../assets/images/splash-icon.png')}
          style={styles.logo}
          resizeMode="contain"
        />
        <Text style={styles.title}>{title}</Text>
        <Text style={styles.subtitle}>{subtitle}</Text>
        <View style={styles.dots}>
          {Array.from({ length: pin.PIN_LENGTH }, (_, i) => (
            <View key={i} style={[styles.dot, i < digits.length && styles.dotFilled]} />
          ))}
        </View>
        {lockedSec > 0 ? (
          <Text style={styles.error}>Too many attempts. Try again in {lockedSec}s.</Text>
        ) : error ? (
          <Text style={styles.error}>{error}</Text>
        ) : (
          <Text style={styles.error}> </Text>
        )}
      </View>
      <View style={styles.pad}>
        {PAD_KEYS.map((key) => {
          const hidden = (key === 'bio' && !bioAvailable) || (key === 'del' && digits.length === 0);
          return (
            <Pressable
              key={key}
              onPress={() => press(key)}
              disabled={hidden || lockedSec > 0}
              style={({ pressed }) => [styles.key, pressed && !hidden && { backgroundColor: colors.border }]}
            >
              {hidden ? null : key === 'bio' ? (
                <Ionicons name="finger-print" size={28} color={colors.accentDark} />
              ) : key === 'del' ? (
                <Ionicons name="backspace-outline" size={26} color={colors.ink} />
              ) : (
                <Text style={[styles.keyLabel, lockedSec > 0 && { color: colors.sub }]}>{key}</Text>
              )}
            </Pressable>
          );
        })}
      </View>
      {active.cancelable !== false ? (
        <Pressable onPress={() => finish(false)} style={styles.cancel}>
          <Text style={styles.cancelLabel}>Cancel</Text>
        </Pressable>
      ) : (
        <View style={styles.cancel} />
      )}
    </View>
  );

  return (
    <>
      {children}
      {/* Same layering trick as popup.tsx: send/cash-out are native modal
          sheets on iOS, and a plain RN Modal can't present above them —
          FullWindowOverlay can. Android's Modal already floats above all. */}
      {Platform.OS === 'ios'
        ? active && (
            <FullWindowOverlay>
              <View style={StyleSheet.absoluteFill}>{screen}</View>
            </FullWindowOverlay>
          )
        : (
            <Modal
              visible={active !== null}
              animationType="fade"
              onRequestClose={() => active?.cancelable !== false && finish(false)}
            >
              {screen}
            </Modal>
          )}
    </>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg, paddingHorizontal: 28, paddingBottom: 24 },
  // Everything above the pad — logo, title, dots — sits vertically centered.
  top: { alignItems: 'center', justifyContent: 'center', flex: 1 },
  logo: { width: 96, height: 82 },
  title: { fontSize: 24, fontWeight: '800', color: colors.ink, marginTop: 24 },
  subtitle: { fontSize: 15, color: colors.sub, marginTop: 8, textAlign: 'center' },
  dots: { flexDirection: 'row', gap: 18, marginTop: 32 },
  dot: {
    width: 16,
    height: 16,
    borderRadius: radius.full,
    borderWidth: 1.5,
    borderColor: colors.border,
    backgroundColor: colors.card,
  },
  dotFilled: { backgroundColor: colors.accent, borderColor: colors.accent },
  error: { fontSize: 14, color: colors.danger, marginTop: 20, fontWeight: '600' },
  pad: { flexDirection: 'row', flexWrap: 'wrap' },
  key: {
    width: '33.33%',
    height: 68,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 16,
  },
  keyLabel: { fontSize: 26, fontWeight: '600', color: colors.ink },
  cancel: { alignItems: 'center', paddingVertical: 16 },
  cancelLabel: { fontSize: 15, fontWeight: '700', color: colors.sub },
});
