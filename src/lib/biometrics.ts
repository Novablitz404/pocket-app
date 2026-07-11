// Auth gate for sensitive actions (app open, send, cash out, Earn moves).
// Presents Remitt's own lock screen: Face ID / fingerprint fires as a system
// overlay on top of it, and the branded PIN pad is the fallback — the OS
// device-passcode screen is never used. Requires <LockProvider> at the root.
import { consumeLastUnlockedPin, presentLock } from '@/components/lock-screen';
import { hasPin } from '@/lib/pin';

/** True when the user authenticated. First call ever runs PIN setup instead. */
export async function ensureUnlocked(reason: string): Promise<boolean> {
  // Pre-PIN installs land here: creating the passcode is the unlock.
  if (!(await hasPin())) return presentLock({ mode: 'create', reason });
  return presentLock({ mode: 'unlock', reason });
}

/** One-time passcode setup right after onboarding, or right after account
 *  recovery (not skippable either way — a funded account shouldn't sit
 *  unlocked). `priorPin` is only meaningful post-recovery: the PIN the user
 *  just typed to pass recovery's own passcode step, forwarded so the new
 *  device's fresh PIN can sync against the already-existing server row
 *  (set_recovery_pin now requires proof to overwrite one). Omit for
 *  brand-new accounts, which have no server-side PIN yet to prove. */
export async function ensurePinSetup(priorPin?: string): Promise<void> {
  if (await hasPin()) return;
  await presentLock({ mode: 'create', cancelable: false, priorPin });
}

/** Settings/destructive actions: force PIN entry (no biometric shortcut) and
 *  return the typed digits, e.g. to prove ownership to a server-side check
 *  (closeAndReclaim's PIN gate). Returns null only when the device has no PIN
 *  set yet — nothing to prove, callers should treat that as "no PIN on file"
 *  and proceed without one. Throws if the user cancels entry, so a cancel
 *  can never be mistaken for the no-PIN case and let the action through. */
export async function confirmPasscode(reason: string): Promise<string | null> {
  if (!(await hasPin())) return null;
  const ok = await presentLock({ mode: 'unlock', reason, disableBiometrics: true });
  if (!ok) throw new Error('Passcode required.');
  return consumeLastUnlockedPin();
}

/** Settings: verify the current passcode (or biometrics), then set a new one.
 *  Forces PIN entry (no biometric shortcut) on the unlock step so the typed
 *  digits can be captured and forwarded as proof to the new PIN's sync —
 *  otherwise a Face ID pass would leave nothing to prove the change with. */
export async function changePasscode(): Promise<boolean> {
  let priorPin: string | undefined;
  if (await hasPin()) {
    const ok = await presentLock({ mode: 'unlock', reason: 'Change your passcode', disableBiometrics: true });
    if (!ok) return false;
    priorPin = consumeLastUnlockedPin() ?? undefined;
  }
  return presentLock({ mode: 'create', priorPin });
}
