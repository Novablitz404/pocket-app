import AsyncStorage from '@react-native-async-storage/async-storage';
import { getLocales } from 'expo-localization';
import * as SecureStore from 'expo-secure-store';
import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import * as auth from './auth';
import { pickAndUploadAvatar, uploadAvatar } from './avatar';
import * as contactsLib from './contacts';
import type { Contact } from './contacts';
import * as directory from './directory';
import * as earnVault from './earn-vault';
import * as earnLedger from './earn-ledger';
import * as fx from './fx';
import * as push from './notifications';
import * as onramp from './onramp';
import { confirmPasscode } from './biometrics';
import { clearPin } from './pin';
import * as stellar from './stellar';
import type { ActivityItem } from './stellar';

const SECRET_KEY = 'remitt.secret';
// Exported for the lock screen: syncing the recovery PIN needs the address
// without pulling in the React context.
export const PUBLIC_KEY = 'remitt.public';
const USERNAME_KEY = 'remitt.username';
const FIRST_KEY = 'remitt.firstName';
const LAST_KEY = 'remitt.lastName';
const EMAIL_KEY = 'remitt.email';
const EMAIL_VERIFIED_KEY = 'remitt.emailVerified';
const ACCOUNT_VERIFIED_KEY = 'remitt.accountVerified';
const COUNTRY_KEY = 'remitt.country';
const LANGUAGE_KEY = 'remitt.language';
const AVATAR_KEY = 'remitt.avatarUrl';
const USERNAME_CHANGED_AT_KEY = 'remitt.usernameChangedAt';

/** A username change is allowed once every 30 days (signup doesn't count). */
export const USERNAME_CHANGE_COOLDOWN_MS = 30 * 24 * 60 * 60 * 1000;

/** ISO country code from the device's region setting (e.g. "PH"), or null if
 *  the locale doesn't carry one. Inferred silently — never asked at signup. */
function deviceCountry(): string | null {
  try {
    const region = getLocales()[0]?.regionCode;
    return region ? region.toUpperCase() : null;
  } catch {
    return null;
  }
}
const EARN_KEY = 'remitt.earn';

interface WalletState {
  loading: boolean;
  name: string | null; // full display name, e.g. "Erich Jann"
  firstName: string | null;
  lastName: string | null;
  username: string | null;
  email: string | null; // recovery/contact anchor collected at onboarding
  emailVerified: boolean; // inbox ownership proven via OTP (gates recovery)
  country: string | null; // ISO alpha-2; inferred at signup, user-overridable
  /** Local currency to show alongside USD balances (e.g. "PHP"), or null if
   *  there's none worth converting to for this user's country. */
  localCurrency: string | null;
  /** Units of localCurrency per 1 USD, from the shared FX snapshot (see
   *  src/lib/fx.ts) — null until loaded or if unavailable. */
  localRate: number | null;
  language: string | null; // preference only for now (no i18n yet)
  usernameChangedAt: number | null; // last change (ms epoch); gates the 30-day rule
  avatarUrl: string | null; // this user's profile picture (Supabase Storage)
  publicKey: string | null;
  balance: number;
  activity: ActivityItem[];
  refreshing: boolean;
  activated: boolean; // account created on-chain (now happens at signup, not first cash-in)
  accountVerified: boolean; // KYC-verified (placeholder until real coins.ph KYC lands) — will gate the coins.ph on/off-ramp, not deposits/withdrawals in general
  balanceLoaded: boolean; // first balance fetch has resolved
  contacts: Contact[]; // accounts we've exchanged P2P payments with (on-device)
  toggleFavorite: (address: string) => Promise<void>;
  nameFor: (address: string) => string | null; // display name from the directory
  profileFor: (address: string) => directory.Profile | null;
  resolveUsername: (username: string) => Promise<string | null>;
  createAccount: (firstName: string, lastName: string, username: string, email: string, avatarLocalUri?: string) => Promise<void>;
  /** Take over an existing account on this device after an email OTP proved
   *  ownership. `accessToken` is the Supabase session verifyEmailOtp returned;
   *  `pin` is the account's passcode (second factor, checked server-side). */
  recoverExistingAccount: (email: string, accessToken: string, pin: string) => Promise<void>;
  updateName: (firstName: string, lastName: string) => Promise<void>;
  changeUsername: (username: string) => Promise<void>;
  setCountry: (code: string) => Promise<void>;
  setLanguage: (lang: string) => Promise<void>;
  /** Pick + compress + upload a profile picture. False when cancelled. */
  changeAvatar: () => Promise<boolean>;
  /** Mark this account's email as verified. `accessToken` is the Supabase
   *  session verifyEmailOtp just returned — proves which email was verified
   *  server-side, since mark_email_verified() derives the address from it. */
  confirmEmailVerified: (accessToken: string) => Promise<void>;
  /** Placeholder KYC verification (no real identity check yet — real check
   *  will be coins.ph). Does NOT touch on-chain activation (that happens at
   *  account creation now); this only unlocks the coins.ph on/off-ramp once
   *  wired in. Idempotent: a no-op if already verified. */
  verifyAccount: () => Promise<void>;
  refresh: () => Promise<void>;
  sendMoney: (to: string, amount: number) => Promise<void>;
  /** Opens a cash-in intent for `amount` USDC and returns the ₱ quote + deposit
   *  target. Ensures the account is activated first. No money moves here —
   *  delivery is server-side once the peso deposit is detected. */
  addCash: (amount: number) => Promise<onramp.CashInIntent>;
  cashOut: (amount: number) => Promise<void>;
  earnDeposit: (amount: number) => Promise<void>;
  earnWithdraw: (amount?: number) => Promise<{ withdrawn: number }>;
  closeAccount: () => Promise<void>;
  reset: () => Promise<void>;
}

const WalletContext = createContext<WalletState | null>(null);

export function WalletProvider({ children }: { children: React.ReactNode }) {
  const [loading, setLoading] = useState(true);
  const [firstName, setFirstName] = useState<string | null>(null);
  const [lastName, setLastName] = useState<string | null>(null);
  const [username, setUsername] = useState<string | null>(null);
  const [email, setEmail] = useState<string | null>(null);
  const [emailVerified, setEmailVerified] = useState(false);
  const [country, setCountryState] = useState<string | null>(null);
  const [localRate, setLocalRate] = useState<number | null>(null);
  const [language, setLanguageState] = useState<string | null>(null);
  const [usernameChangedAt, setUsernameChangedAt] = useState<number | null>(null);
  const [avatarUrl, setAvatarUrl] = useState<string | null>(null);
  const [publicKey, setPublicKey] = useState<string | null>(null);
  const [balance, setBalance] = useState(0);
  const [activity, setActivity] = useState<ActivityItem[]>([]);
  const [refreshing, setRefreshing] = useState(false);
  const [activated, setActivated] = useState(false);
  const [accountVerified, setAccountVerified] = useState(false);
  const [balanceLoaded, setBalanceLoaded] = useState(false);
  const [dir, setDir] = useState<Record<string, directory.Profile>>({});
  const [contacts, setContacts] = useState<Contact[]>([]);

  const name = [firstName, lastName].filter(Boolean).join(' ').trim() || username;

  useEffect(() => {
    (async () => {
      try {
        const [pub, storedUser, storedFirst, storedLast, storedEmail, storedVerified, storedCountry, storedLanguage, storedChangedAt, storedAvatar, storedAccountVerified] = await Promise.all([
          SecureStore.getItemAsync(PUBLIC_KEY),
          AsyncStorage.getItem(USERNAME_KEY),
          AsyncStorage.getItem(FIRST_KEY),
          AsyncStorage.getItem(LAST_KEY),
          AsyncStorage.getItem(EMAIL_KEY),
          AsyncStorage.getItem(EMAIL_VERIFIED_KEY),
          AsyncStorage.getItem(COUNTRY_KEY),
          AsyncStorage.getItem(LANGUAGE_KEY),
          AsyncStorage.getItem(USERNAME_CHANGED_AT_KEY),
          AsyncStorage.getItem(AVATAR_KEY),
          AsyncStorage.getItem(ACCOUNT_VERIFIED_KEY),
        ]);
        if (pub) {
          // Backfill accounts created before country capture existed.
          const country = storedCountry ?? deviceCountry();
          if (!storedCountry && country) AsyncStorage.setItem(COUNTRY_KEY, country).catch(() => {});
          setPublicKey(pub);
          setUsername(storedUser);
          setFirstName(storedFirst);
          setLastName(storedLast);
          setEmail(storedEmail);
          setEmailVerified(storedVerified === '1');
          setCountryState(country);
          setLanguageState(storedLanguage ?? 'en');
          setUsernameChangedAt(storedChangedAt ? Number(storedChangedAt) : null);
          setAvatarUrl(storedAvatar);
          setAccountVerified(storedAccountVerified === '1');
          // Ensure the directory has this account (e.g. registered before the
          // directory existed) and load the current map.
          if (storedUser) {
            directory.registerUser({
              address: pub,
              username: storedUser,
              firstName: storedFirst ?? undefined,
              lastName: storedLast ?? undefined,
              email: storedEmail ?? undefined,
              country: country ?? undefined,
              avatarUrl: storedAvatar ?? undefined,
            });
          }
        }
        setDir(await directory.fetchDirectory());
        setContacts(await contactsLib.getContacts());
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  // Local currency is derived from country (rarely changes); the rate itself
  // is a shared, slow-moving snapshot (see fx.ts), so it's fetched ONCE here
  // keyed on the currency — not inside refresh(), which runs far more often
  // (every send/deposit/withdraw) and would otherwise re-hit Supabase for a
  // number that hasn't changed.
  const localCurrency = useMemo(() => fx.currencyForCountry(country), [country]);
  useEffect(() => {
    if (!localCurrency) {
      setLocalRate(null);
      return;
    }
    let cancelled = false;
    fx.getFxRate(localCurrency).then((rate) => {
      if (!cancelled) setLocalRate(rate);
    });
    return () => {
      cancelled = true;
    };
  }, [localCurrency]);

  const refresh = useCallback(async () => {
    const pub = publicKey ?? (await SecureStore.getItemAsync(PUBLIC_KEY));
    if (!pub) return;
    setRefreshing(true);
    try {
      const [exists, bal, acts, map] = await Promise.all([
        stellar.accountExists(pub),
        stellar.getBalance(pub),
        stellar.getActivity(pub),
        directory.fetchDirectory(),
      ]);
      setActivated(exists);
      setBalance(bal);
      setActivity(acts);
      setDir(map);
      setBalanceLoaded(true);
      // Fold P2P counterparties into the on-device contact list. Only
      // 'sent'/'received' qualify — cash-in/out (treasury) and Earn
      // (Soroban contract) never become contacts, nor does the owner's
      // own account (self-payments).
      const seen = acts
        .filter((a) => (a.kind === 'sent' || a.kind === 'received') && a.counterparty !== pub)
        .map((a) => ({ address: a.counterparty, lastAt: a.createdAt }));
      contactsLib.mergeContacts(seen, pub).then(setContacts).catch(() => {});
    } finally {
      setRefreshing(false);
    }
  }, [publicKey]);

  useEffect(() => {
    if (publicKey) refresh().catch(() => {});
  }, [publicKey, refresh]);

  // Register this device for push notifications once an account exists.
  // Safe on every start (upserts the token); no-ops until EAS is configured.
  useEffect(() => {
    if (publicKey) push.registerForPush(publicKey).catch(() => {});
  }, [publicKey]);

  // Live updates via Horizon's SSE payment stream: incoming money (e.g. sent
  // from another phone) appears on its own, no manual pull-to-refresh. On each
  // streamed payment we refetch balance + activity. Only meaningful once the
  // account exists on-chain.
  useEffect(() => {
    if (!publicKey || !activated) return;
    const stop = stellar.streamPayments(publicKey, () => {
      stellar.getBalance(publicKey).then(setBalance).catch(() => {});
      stellar.getActivity(publicKey).then(setActivity).catch(() => {});
    });
    return stop;
  }, [publicKey, activated]);

  const createAccount = useCallback(
    async (rawFirst: string, rawLast: string, rawUsername: string, rawEmail: string, avatarLocalUri?: string) => {
      // Normalize once so local state, storage, and the directory all match:
      // names Title Cased, username and email lowercased.
      const newFirst = directory.normalizeName(rawFirst);
      const newLast = directory.normalizeName(rawLast);
      const newUsername = directory.normalizeUsername(rawUsername);
      const newEmail = directory.normalizeEmail(rawEmail);
      const country = deviceCountry();

      // The keypair itself is generated locally (free); activation (sponsored
      // reserves + USDC trustline + 2-of-3 multisig) now happens immediately
      // here, at account creation, rather than being deferred to first
      // cash-in — so every account is fully on-chain and ready to receive
      // USDC (e.g. via the external-wallet address screen) the moment
      // onboarding finishes, with no separate "Verify to unlock" step.
      setBalanceLoaded(false);
      const { publicKey: pub, secret } = stellar.createWallet();
      await SecureStore.setItemAsync(SECRET_KEY, secret);
      await SecureStore.setItemAsync(PUBLIC_KEY, pub);
      await stellar.activateAccount(secret);
      // The photo was picked before the address existed; upload it now.
      // Best-effort: a failed upload shouldn't block opening the account
      // (the user can retry from Settings).
      let newAvatarUrl: string | null = null;
      if (avatarLocalUri) {
        try {
          newAvatarUrl = await uploadAvatar(pub, avatarLocalUri);
          await AsyncStorage.setItem(AVATAR_KEY, newAvatarUrl);
        } catch {
          newAvatarUrl = null;
        }
      }
      await AsyncStorage.multiSet([
        [USERNAME_KEY, newUsername],
        [FIRST_KEY, newFirst],
        [LAST_KEY, newLast],
        [EMAIL_KEY, newEmail],
        ...(country ? [[COUNTRY_KEY, country] as [string, string]] : []),
      ]);
      const profile: directory.Profile = {
        address: pub,
        username: newUsername,
        firstName: newFirst,
        lastName: newLast,
        email: newEmail,
        country: country ?? undefined,
        avatarUrl: newAvatarUrl ?? undefined,
      };
      await directory.registerUser(profile);
      setDir((prev) => ({ ...prev, [pub]: profile }));
      setUsername(newUsername);
      setFirstName(newFirst);
      setLastName(newLast);
      setEmail(newEmail);
      setCountryState(country);
      setLanguageState('en');
      setUsernameChangedAt(null);
      setAvatarUrl(newAvatarUrl);
      setPublicKey(pub);
    },
    [],
  );

  // Recovery: the email OTP already proved inbox ownership; the access token
  // it minted is the only way to resolve email → profile (recover_profile RPC).
  // A funded account keeps its on-chain address and is re-keyed to this
  // device; an account that never touched the chain has nothing to re-key, so
  // its profile row simply moves to a fresh keypair.
  const recoverExistingAccount = useCallback(
    async (rawEmail: string, accessToken: string, pin: string) => {
      const newEmail = directory.normalizeEmail(rawEmail);
      const profile = await auth.recoverProfile(accessToken, pin);
      if (!profile) {
        throw new Error(
          'No account with a verified email matches this address. If you never verified your email, recovery is not available.',
        );
      }

      setBalanceLoaded(false);
      const { publicKey: devicePub, secret } = stellar.createWallet();
      let accountAddress = profile.address;
      if (await stellar.accountExists(profile.address)) {
        // Server-side re-key (recover-account Edge Function): identity comes
        // from this same accessToken, which recoverProfile() above already
        // validated (email OTP + PIN) — the function re-derives the address
        // from it directly rather than trusting profile.address as input.
        await stellar.recoverAccount(accessToken, devicePub);
      } else {
        await directory.updateAddress(profile.address, devicePub);
        accountAddress = devicePub;
      }
      await SecureStore.setItemAsync(SECRET_KEY, secret);
      await SecureStore.setItemAsync(PUBLIC_KEY, accountAddress);

      const country = profile.country ?? deviceCountry();
      await AsyncStorage.multiSet([
        [USERNAME_KEY, profile.username],
        [FIRST_KEY, profile.firstName ?? ''],
        [LAST_KEY, profile.lastName ?? ''],
        [EMAIL_KEY, newEmail],
        [EMAIL_VERIFIED_KEY, '1'],
        ...(country ? [[COUNTRY_KEY, country] as [string, string]] : []),
        ...(profile.avatarUrl ? [[AVATAR_KEY, profile.avatarUrl] as [string, string]] : []),
      ]);
      setUsername(profile.username);
      setFirstName(profile.firstName ?? null);
      setLastName(profile.lastName ?? null);
      setEmail(newEmail);
      setEmailVerified(true);
      setCountryState(country);
      setLanguageState('en');
      setUsernameChangedAt(null);
      setAvatarUrl(profile.avatarUrl ?? null);
      // Last: flips the app into the signed-in state and kicks off the
      // balance/activity refresh and this device's push registration.
      setPublicKey(accountAddress);
    },
    [],
  );

  // Push the profile to the directory whenever a field is edited. Always sends
  // the full row: the upsert overwrites provided columns, so a partial body
  // would null out the rest.
  const syncProfile = useCallback(
    async (next: { firstName?: string | null; lastName?: string | null; username?: string | null; country?: string | null; avatarUrl?: string | null }) => {
      const pub = publicKey;
      const user = next.username !== undefined ? next.username : username;
      if (!pub || !user) return;
      const profile: directory.Profile = {
        address: pub,
        username: user,
        firstName: (next.firstName !== undefined ? next.firstName : firstName) ?? undefined,
        lastName: (next.lastName !== undefined ? next.lastName : lastName) ?? undefined,
        email: email ?? undefined,
        country: (next.country !== undefined ? next.country : country) ?? undefined,
        avatarUrl: (next.avatarUrl !== undefined ? next.avatarUrl : avatarUrl) ?? undefined,
      };
      await directory.registerUser(profile);
      setDir((prev) => ({ ...prev, [pub]: profile }));
    },
    [publicKey, username, firstName, lastName, email, country, avatarUrl],
  );

  const updateName = useCallback(
    async (rawFirst: string, rawLast: string) => {
      const newFirst = directory.normalizeName(rawFirst);
      const newLast = directory.normalizeName(rawLast);
      await AsyncStorage.multiSet([
        [FIRST_KEY, newFirst],
        [LAST_KEY, newLast],
      ]);
      await syncProfile({ firstName: newFirst, lastName: newLast });
      setFirstName(newFirst);
      setLastName(newLast);
    },
    [syncProfile],
  );

  const changeUsername = useCallback(
    async (rawUsername: string) => {
      const newUsername = directory.normalizeUsername(rawUsername);
      if (newUsername === username) return;
      if (usernameChangedAt && Date.now() - usernameChangedAt < USERNAME_CHANGE_COOLDOWN_MS) {
        const nextAt = new Date(usernameChangedAt + USERNAME_CHANGE_COOLDOWN_MS);
        throw new Error(
          `You can only change your username once a month. Try again on ${nextAt.toLocaleDateString()}.`,
        );
      }
      if (await directory.isUsernameTaken(newUsername)) {
        throw new Error(`"${newUsername}" is already in use. Try another.`);
      }
      const now = Date.now();
      await AsyncStorage.multiSet([
        [USERNAME_KEY, newUsername],
        [USERNAME_CHANGED_AT_KEY, String(now)],
      ]);
      await syncProfile({ username: newUsername });
      setUsername(newUsername);
      setUsernameChangedAt(now);
    },
    [username, usernameChangedAt, syncProfile],
  );

  const setCountry = useCallback(
    async (code: string) => {
      const next = code.trim().toUpperCase();
      await AsyncStorage.setItem(COUNTRY_KEY, next);
      await syncProfile({ country: next });
      setCountryState(next);
    },
    [syncProfile],
  );

  const setLanguage = useCallback(async (lang: string) => {
    await AsyncStorage.setItem(LANGUAGE_KEY, lang);
    setLanguageState(lang);
  }, []);

  const changeAvatar = useCallback(async () => {
    if (!publicKey) throw new Error('No account on this device');
    const url = await pickAndUploadAvatar(publicKey);
    if (!url) return false; // picker cancelled
    await AsyncStorage.setItem(AVATAR_KEY, url);
    await syncProfile({ avatarUrl: url });
    setAvatarUrl(url);
    return true;
  }, [publicKey, syncProfile]);

  const nameFor = useCallback(
    (address: string) => {
      const p = dir[address];
      return p ? directory.displayName(p) : null;
    },
    [dir],
  );

  const profileFor = useCallback((address: string) => dir[address] ?? null, [dir]);

  const toggleFavorite = useCallback(async (address: string) => {
    setContacts(await contactsLib.toggleFavorite(address));
  }, []);

  const confirmEmailVerified = useCallback(async (accessToken: string) => {
    setEmailVerified(true);
    await AsyncStorage.setItem(EMAIL_VERIFIED_KEY, '1');
    // mark_email_verified() derives the address from accessToken's own email
    // claim server-side — no address to pass, and nothing to fall back to
    // storage for (unlike the old anon-PATCH version, this isn't keyed on it).
    auth.markEmailVerified(accessToken).catch(() => {});
  }, []);

  const withSecret = useCallback(async (fn: (secret: string) => Promise<void>) => {
    const secret = await SecureStore.getItemAsync(SECRET_KEY);
    if (!secret) throw new Error('No account on this device');
    await fn(secret);
  }, []);

  // Placeholder KYC verification — no real identity check yet (real check
  // will be coins.ph). On-chain activation no longer lives here: every
  // account is already activated at creation (see createAccount). This just
  // flips the KYC flag that will gate the coins.ph on/off-ramp once wired in.
  const verifyAccount = useCallback(async () => {
    if (!publicKey) throw new Error('No account on this device');
    if (accountVerified) return;
    setAccountVerified(true);
    await AsyncStorage.setItem(ACCOUNT_VERIFIED_KEY, '1');
    auth.verifyAccount(publicKey).catch(() => {});
  }, [publicKey, accountVerified]);

  const sendMoney = useCallback(
    async (to: string, amount: number) => {
      if (!publicKey) throw new Error('No account on this device');
      await withSecret((secret) => stellar.send(publicKey, secret, to, amount));
      // The recipient's "Money received" notification is now emitted server-side
      // by the fee-bump Edge Function, right after the payment settles on-chain
      // (see supabase/functions/fee-bump). That's unspoofable — it can't be
      // forged by a client POST — and also fires for cash-ins, unlike this old
      // sender-triggered call. So there's nothing to notify from here anymore.
      await refresh();
    },
    [publicKey, withSecret, refresh],
  );

  const addCash = useCallback(
    async (amount: number) => {
      if (!publicKey) throw new Error('No account on this device');
      // Belt-and-suspenders: the account must be on-chain with a USDC trustline
      // before an intent, or delivery would later 422. Activation now happens
      // at account creation, so this only fires for a pre-existing account
      // created before that change shipped.
      if (!(await stellar.accountExists(publicKey))) {
        await withSecret((secret) => stellar.activateAccount(secret));
        await refresh();
      }
      // Open the intent. Delivery (and the balance change) happens later,
      // server-side, once the peso deposit is detected — so no refresh here.
      return onramp.createCashInIntent(publicKey, amount);
    },
    [publicKey, withSecret, refresh],
  );

  const reset = useCallback(async () => {
    // Stop notifying this device about an account it no longer holds.
    if (publicKey) push.removePushTokens(publicKey).catch(() => {});
    await Promise.all([
      SecureStore.deleteItemAsync(SECRET_KEY),
      SecureStore.deleteItemAsync(PUBLIC_KEY),
      AsyncStorage.multiRemove([USERNAME_KEY, FIRST_KEY, LAST_KEY, EMAIL_KEY, EMAIL_VERIFIED_KEY, COUNTRY_KEY, LANGUAGE_KEY, USERNAME_CHANGED_AT_KEY, AVATAR_KEY, EARN_KEY, ACCOUNT_VERIFIED_KEY, contactsLib.CONTACTS_KEY]),
      clearPin(),
    ]);
    setUsername(null);
    setFirstName(null);
    setLastName(null);
    setEmail(null);
    setEmailVerified(false);
    setCountryState(null);
    setLanguageState(null);
    setUsernameChangedAt(null);
    setAvatarUrl(null);
    setPublicKey(null);
    setBalance(0);
    setActivity([]);
    setContacts([]);
    setActivated(false);
    setAccountVerified(false);
    setBalanceLoaded(false);
  }, []);

  const cashOut = useCallback(
    async (amount: number) => {
      if (!publicKey) throw new Error('No account on this device');
      await withSecret((secret) => stellar.cashOut(publicKey, secret, amount));
      await refresh();
    },
    [publicKey, withSecret, refresh],
  );

  // After real money movement (deposit/withdraw), chart the fresh position
  // immediately — bypassing the focus-time snapshot throttle so the Earn chart
  // updates live instead of waiting out the 15-minute cooldown. Best-effort.
  const chartMovementNow = useCallback(async () => {
    if (!publicKey) return;
    try {
      const [supplied, net] = await Promise.all([
        earnVault.getSupplied(publicKey),
        earnLedger.getNetDeposited(publicKey),
      ]);
      await earnLedger.recordSnapshotNow(publicKey, supplied, net ?? 0);
    } catch {
      // The chart just gets its point at the next throttled snapshot instead.
    }
  }, [publicKey]);

  // Earn: deposit the user's USDC into the Pocket vault (Soroban, fee-bumped).
  const earnDeposit = useCallback(
    async (amount: number) => {
      if (!publicKey) throw new Error('No account on this device');
      if (amount > balance) throw new Error('Not enough balance');
      await withSecret((secret) => earnVault.deposit(publicKey, secret, amount));
      await earnLedger.recordDeposit(publicKey, amount);
      await chartMovementNow();
      await refresh();
    },
    [publicKey, balance, withSecret, refresh, chartMovementNow],
  );

  // Earn: withdraw from the vault position back to the wallet (the whole
  // position when no amount is given). There is NO separate withdrawal fee
  // anymore — Pocket's 12%-of-yield cut is share-price dilution inside the
  // vault, so nothing extra is collected here.
  const earnWithdraw = useCallback(async (amount?: number) => {
    if (!publicKey) throw new Error('No account on this device');
    let result = { withdrawn: 0 };
    await withSecret(async (secret) => {
      result =
        amount == null
          ? await earnVault.withdrawAll(publicKey, secret)
          : await earnVault.withdraw(publicKey, secret, amount);
    });
    // The off-chain principal ledger still drives the "earned" display (the
    // vault stores per-user shares, not per-user cost basis): a full
    // withdrawal zeroes it, a partial one reduces it by what was taken.
    if (amount == null) await earnLedger.resetDeposits(publicKey);
    else await earnLedger.recordWithdrawal(publicKey, amount);
    await chartMovementNow();
    await refresh();
    return result;
  }, [publicKey, withSecret, refresh, chartMovementNow]);

  // Close the account and reclaim reserves to the treasury, then wipe the
  // device. The treasury acts alone server-side (see closeAndReclaim), so the
  // current passcode is the proof this is the owner's own request, not
  // someone else calling the Edge Function directly with just the address.
  const closeAccount = useCallback(async () => {
    if (!publicKey) throw new Error('No account on this device');
    if (activated) {
      const pin = await confirmPasscode('Close your account');
      await stellar.closeAndReclaim(publicKey, pin ?? undefined);
    }
    await earnLedger.resetDeposits(publicKey);
    await Promise.all([
      SecureStore.deleteItemAsync(SECRET_KEY),
      SecureStore.deleteItemAsync(PUBLIC_KEY),
      AsyncStorage.multiRemove([USERNAME_KEY, FIRST_KEY, LAST_KEY, EMAIL_KEY, EMAIL_VERIFIED_KEY, COUNTRY_KEY, LANGUAGE_KEY, USERNAME_CHANGED_AT_KEY, AVATAR_KEY, EARN_KEY, ACCOUNT_VERIFIED_KEY, contactsLib.CONTACTS_KEY]),
      clearPin(),
    ]);
    setUsername(null);
    setFirstName(null);
    setLastName(null);
    setEmail(null);
    setEmailVerified(false);
    setCountryState(null);
    setLanguageState(null);
    setUsernameChangedAt(null);
    setAvatarUrl(null);
    setPublicKey(null);
    setBalance(0);
    setActivity([]);
    setContacts([]);
    setActivated(false);
    setAccountVerified(false);
    setBalanceLoaded(false);
  }, [publicKey, activated]);

  const value = useMemo(
    () => ({
      loading,
      name,
      firstName,
      lastName,
      username,
      email,
      emailVerified,
      country,
      localCurrency,
      localRate,
      language,
      usernameChangedAt,
      avatarUrl,
      publicKey,
      balance,
      activity,
      refreshing,
      activated,
      accountVerified,
      balanceLoaded,
      contacts,
      toggleFavorite,
      nameFor,
      profileFor,
      resolveUsername: directory.resolveUsername,
      createAccount,
      recoverExistingAccount,
      updateName,
      changeUsername,
      setCountry,
      setLanguage,
      changeAvatar,
      confirmEmailVerified,
      verifyAccount,
      refresh,
      sendMoney,
      addCash,
      cashOut,
      earnDeposit,
      earnWithdraw,
      closeAccount,
      reset,
    }),
    [loading, name, firstName, lastName, username, email, emailVerified, country, localCurrency, localRate, language, usernameChangedAt, avatarUrl, publicKey, balance, activity, refreshing, activated, accountVerified, balanceLoaded, contacts, toggleFavorite, nameFor, profileFor, createAccount, recoverExistingAccount, updateName, changeUsername, setCountry, setLanguage, changeAvatar, confirmEmailVerified, verifyAccount, refresh, sendMoney, addCash, cashOut, earnDeposit, earnWithdraw, closeAccount, reset],
  );

  return <WalletContext.Provider value={value}>{children}</WalletContext.Provider>;
}

export function useWallet(): WalletState {
  const ctx = useContext(WalletContext);
  if (!ctx) throw new Error('useWallet must be used within WalletProvider');
  return ctx;
}
