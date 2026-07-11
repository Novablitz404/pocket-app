// App-level passcode (4 digits). Stored as a salted SHA-256 hash in
// SecureStore — never the PIN itself. Verification is throttled: after
// MAX_ATTEMPTS wrong tries the pad locks for LOCKOUT_MS. This is the fallback
// behind Face ID / fingerprint in the branded lock screen; forgot-PIN is
// "reset the device and recover" (the wallet key never leaves SecureStore).
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Crypto from 'expo-crypto';
import * as SecureStore from 'expo-secure-store';

const HASH_KEY = 'remitt.pin.hash';
const SALT_KEY = 'remitt.pin.salt';
const FAILS_KEY = 'remitt.pin.fails';
const LOCKED_UNTIL_KEY = 'remitt.pin.lockedUntil';

export const PIN_LENGTH = 4;
const MAX_ATTEMPTS = 5;
const LOCKOUT_MS = 30_000;

export type VerifyResult =
  | { ok: true }
  | { ok: false; remaining: number }
  | { ok: false; lockedForMs: number };

async function hash(pin: string, salt: string): Promise<string> {
  return Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, `${salt}:${pin}`);
}

export async function hasPin(): Promise<boolean> {
  return (await SecureStore.getItemAsync(HASH_KEY)) !== null;
}

export async function setPin(pin: string): Promise<void> {
  const bytes = await Crypto.getRandomBytesAsync(16);
  const salt = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  await SecureStore.setItemAsync(SALT_KEY, salt);
  await SecureStore.setItemAsync(HASH_KEY, await hash(pin, salt));
  await AsyncStorage.multiRemove([FAILS_KEY, LOCKED_UNTIL_KEY]);
}

export async function clearPin(): Promise<void> {
  await Promise.all([
    SecureStore.deleteItemAsync(HASH_KEY),
    SecureStore.deleteItemAsync(SALT_KEY),
    AsyncStorage.multiRemove([FAILS_KEY, LOCKED_UNTIL_KEY]),
  ]);
}

/** Milliseconds until the pad unlocks again, or 0 when attempts are allowed. */
export async function lockedForMs(): Promise<number> {
  const until = Number((await AsyncStorage.getItem(LOCKED_UNTIL_KEY)) ?? 0);
  return Math.max(0, until - Date.now());
}

export async function verifyPin(pin: string): Promise<VerifyResult> {
  const locked = await lockedForMs();
  if (locked > 0) return { ok: false, lockedForMs: locked };

  const [stored, salt] = await Promise.all([
    SecureStore.getItemAsync(HASH_KEY),
    SecureStore.getItemAsync(SALT_KEY),
  ]);
  // No PIN set: treat as passing so a half-cleared state can't brick the app.
  if (!stored || !salt) return { ok: true };

  if ((await hash(pin, salt)) === stored) {
    await AsyncStorage.multiRemove([FAILS_KEY, LOCKED_UNTIL_KEY]);
    return { ok: true };
  }

  const fails = Number((await AsyncStorage.getItem(FAILS_KEY)) ?? 0) + 1;
  if (fails >= MAX_ATTEMPTS) {
    await AsyncStorage.multiSet([
      [FAILS_KEY, '0'],
      [LOCKED_UNTIL_KEY, String(Date.now() + LOCKOUT_MS)],
    ]);
    return { ok: false, lockedForMs: LOCKOUT_MS };
  }
  await AsyncStorage.setItem(FAILS_KEY, String(fails));
  return { ok: false, remaining: MAX_ATTEMPTS - fails };
}
