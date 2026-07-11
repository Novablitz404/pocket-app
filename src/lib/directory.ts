// Username directory backed by Supabase (PostgREST). Maps a wallet address to
// a human username so the UI can show "sent erich" / "received jann" and let
// people send by username. Talks to Supabase's REST API directly — no
// supabase-js needed. Gracefully no-ops until the env vars are set.
//
// Set in packages/app/.env:
//   EXPO_PUBLIC_SUPABASE_URL=https://xxxx.supabase.co
//   EXPO_PUBLIC_SUPABASE_ANON_KEY=eyJ...
export const SUPABASE_URL = process.env.EXPO_PUBLIC_SUPABASE_URL ?? '';
export const ANON_KEY = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY ?? '';
export const directoryEnabled = Boolean(SUPABASE_URL && ANON_KEY);

const TABLE = 'profiles';
const rest = (path: string) => `${SUPABASE_URL}/rest/v1/${path}`;
const headers = {
  apikey: ANON_KEY,
  Authorization: `Bearer ${ANON_KEY}`,
  'Content-Type': 'application/json',
};

export interface Profile {
  address: string;
  username: string;
  firstName?: string;
  lastName?: string;
  /** Recovery/contact anchor. Stored in Supabase but never returned by
   *  fetchDirectory — other users don't see it. */
  email?: string;
  /** ISO 3166-1 alpha-2, inferred from device locale at signup (never asked).
   *  Same privacy rule as email: stored, not served back by fetchDirectory. */
  country?: string;
  /** Public URL into the Supabase 'avatars' storage bucket (with a ?v= cache
   *  buster). Unlike email/country this IS served to everyone — it's the
   *  profile picture shown next to the username. */
  avatarUrl?: string;
}

/** Usernames are always lowercase, no spaces, [a-z0-9._] only. */
export function normalizeUsername(raw: string): string {
  return raw.trim().toLowerCase().replace(/[^a-z0-9._]/g, '');
}

/** Emails are lowercased and trimmed. Format is only loosely checked here —
 *  no verification email is sent yet. */
export function normalizeEmail(raw: string): string {
  return raw.trim().toLowerCase();
}

export function isValidEmail(raw: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(raw.trim());
}

/** Names are Title Cased: first letter of each word up, the rest down.
 *  ASCII-safe regex (no \p{L}) so it can't throw on Hermes. */
export function normalizeName(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/(^|[\s'-])([a-z])/g, (_, sep, ch) => sep + ch.toUpperCase());
}

/** Friendly display name: full name if we have it, else the @username. */
export function displayName(p: Profile): string {
  const full = [p.firstName, p.lastName].filter(Boolean).join(' ').trim();
  return full || p.username;
}

/** Insert or update this account's profile (upsert on the address PK). */
export async function registerUser(p: Profile): Promise<void> {
  if (!directoryEnabled) return;
  try {
    await fetch(rest(TABLE), {
      method: 'POST',
      headers: { ...headers, Prefer: 'resolution=merge-duplicates' },
      body: JSON.stringify({
        address: p.address,
        username: normalizeUsername(p.username),
        first_name: p.firstName ? normalizeName(p.firstName) : null,
        last_name: p.lastName ? normalizeName(p.lastName) : null,
        email: p.email ? normalizeEmail(p.email) : null,
        country: p.country ? p.country.trim().toUpperCase() : null,
        avatar_url: p.avatarUrl ?? null,
      }),
    });
  } catch {
    // Directory is best-effort; the wallet works without it.
  }
}

/** Re-point a profile row at a new wallet address (PK update). Used by
 *  account recovery when the old account never existed on-chain: there is
 *  nothing to re-key, so the profile simply moves to a fresh keypair. */
export async function updateAddress(oldAddress: string, newAddress: string): Promise<void> {
  if (!directoryEnabled) return;
  const res = await fetch(rest(`${TABLE}?address=eq.${encodeURIComponent(oldAddress)}`), {
    method: 'PATCH',
    headers,
    body: JSON.stringify({ address: newAddress }),
  });
  if (!res.ok) throw new Error(`Could not update the account record (${res.status})`);
}

/** Whole directory as an address → profile map (small dataset for the demo). */
export async function fetchDirectory(): Promise<Record<string, Profile>> {
  if (!directoryEnabled) return {};
  try {
    const res = await fetch(rest(`${TABLE}?select=address,username,first_name,last_name,avatar_url`), { headers });
    if (!res.ok) return {};
    const rows: any[] = await res.json();
    const map: Record<string, Profile> = {};
    for (const r of rows) {
      map[r.address] = {
        address: r.address,
        username: r.username,
        firstName: r.first_name ?? undefined,
        lastName: r.last_name ?? undefined,
        avatarUrl: r.avatar_url ?? undefined,
      };
    }
    return map;
  } catch {
    return {};
  }
}

/** Resolve a username to its wallet address (case-insensitive). */
export async function resolveUsername(username: string): Promise<string | null> {
  if (!directoryEnabled) return null;
  try {
    const res = await fetch(
      rest(`${TABLE}?username=eq.${encodeURIComponent(normalizeUsername(username))}&select=address&limit=1`),
      { headers },
    );
    if (!res.ok) return null;
    const rows: Profile[] = await res.json();
    return rows[0]?.address ?? null;
  } catch {
    return null;
  }
}

/** Whether a username is already taken (case-insensitive). */
export async function isUsernameTaken(username: string): Promise<boolean> {
  return (await resolveUsername(username)) !== null;
}
