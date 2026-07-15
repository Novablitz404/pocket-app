// Server-side notification helper — the trustworthy replacement for the
// spoofable client-side notifyAddress (src/lib/notifications.ts). Writes the
// inbox row via SERVICE_ROLE (so the `notifications` table's anon INSERT policy
// can be revoked — see supabase-schema.sql Phase 3), then best-effort pushes to
// the recipient's registered devices via Expo. Never throws: a notification
// failure must never fail the money-movement flow that triggered it.
//
// Why server-side: a "Money received 💸" inbox row is a claim that funds
// settled. Emitting it only from here (e.g. fee-bump, right after a real
// on-chain submit) means such a claim can no longer be forged by any anon-key
// holder POSTing to the notifications table directly.
const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const EXPO_PUSH_API = 'https://exp.host/--/api/v2/push/send';

const svcHeaders = {
  apikey: SERVICE_ROLE_KEY,
  Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
  'Content-Type': 'application/json',
};
const svcRead = { apikey: SERVICE_ROLE_KEY, Authorization: `Bearer ${SERVICE_ROLE_KEY}` };

/** Display name for an address, from its profile (first_name, else username),
 *  else a friendly fallback. Best-effort — returns the fallback on any error. */
export async function displayName(address: string, fallback = 'Someone'): Promise<string> {
  try {
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/profiles?address=eq.${encodeURIComponent(address)}&select=first_name,username`,
      { headers: svcRead },
    );
    if (!res.ok) return fallback;
    const rows = await res.json();
    return rows[0]?.first_name || rows[0]?.username || fallback;
  } catch {
    return fallback;
  }
}

/** Insert the inbox row (service_role) + push to the address's registered
 *  devices. Best-effort: swallows all errors so it can never fail the caller. */
export async function notifyAddress(
  address: string,
  title: string,
  body: string,
  data: Record<string, unknown> = {},
): Promise<void> {
  try {
    await fetch(`${SUPABASE_URL}/rest/v1/notifications`, {
      method: 'POST',
      headers: svcHeaders,
      body: JSON.stringify({ address, title, body, data }),
    });
  } catch { /* best-effort inbox write */ }

  try {
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/push_tokens?address=eq.${encodeURIComponent(address)}&select=token`,
      { headers: svcRead },
    );
    if (!res.ok) return;
    const rows: { token: string }[] = await res.json();
    if (rows.length === 0) return;
    await fetch(EXPO_PUSH_API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(rows.map((r) => ({ to: r.token, title, body, sound: 'default', data }))),
    });
  } catch { /* best-effort push */ }
}
