// Admin-only: freeze / unfreeze an account (2-of-3 custody). Freezing writes
// the address into `frozen_accounts`; the fee-bump function then refuses to add
// Remitt's co-signature for it, so the user's weight-1 signature can never reach
// the weight-2 threshold — the send simply can't be assembled. No on-chain
// change, no signer/threshold edit. Unfreezing removes the row.
//
// This is a privileged operation (it can halt any user's sends), so it is gated
// by a shared ADMIN_SECRET presented in the `x-admin-secret` header — NOT by the
// anon key (which every app install has). The write goes through the service
// role, which bypasses RLS on frozen_accounts.
//
// Deploy (from packages/app):
//   npx supabase functions deploy set-freeze
//   npx supabase secrets set ADMIN_SECRET=<random>
//   (frozen_accounts table must exist — see scripts/supabase-schema.sql)
//
// Request: header x-admin-secret: <ADMIN_SECRET>
//   body { address: string, action: 'freeze' | 'unfreeze', reason?: string }
const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const ADMIN_SECRET = Deno.env.get('ADMIN_SECRET')!;

/** Constant-time string compare so the secret can't be probed byte-by-byte. */
function timingSafeEqual(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const ab = enc.encode(a);
  const bb = enc.encode(b);
  if (ab.length !== bb.length) return false;
  let diff = 0;
  for (let i = 0; i < ab.length; i++) diff |= ab[i] ^ bb[i];
  return diff === 0;
}

const restHeaders = {
  apikey: SERVICE_ROLE_KEY,
  Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
  'Content-Type': 'application/json',
};

Deno.serve(async (req) => {
  try {
    const provided = req.headers.get('x-admin-secret') ?? '';
    if (!ADMIN_SECRET || !timingSafeEqual(provided, ADMIN_SECRET)) {
      return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 });
    }

    const { address, action, reason } = await req.json();
    if (typeof address !== 'string' || (action !== 'freeze' && action !== 'unfreeze')) {
      return new Response(
        JSON.stringify({ error: 'address (string) and action ("freeze"|"unfreeze") required' }),
        { status: 400 },
      );
    }

    if (action === 'freeze') {
      // Upsert so re-freezing is idempotent (updates the reason/timestamp).
      const res = await fetch(`${SUPABASE_URL}/rest/v1/frozen_accounts`, {
        method: 'POST',
        headers: { ...restHeaders, Prefer: 'resolution=merge-duplicates,return=representation' },
        body: JSON.stringify({ address, reason: reason ?? null, frozen_at: new Date().toISOString() }),
      });
      if (!res.ok) throw new Error(`freeze write failed: ${res.status} ${await res.text()}`);
      return new Response(JSON.stringify({ address, frozen: true }), { status: 200 });
    }

    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/frozen_accounts?address=eq.${encodeURIComponent(address)}`,
      { method: 'DELETE', headers: restHeaders },
    );
    if (!res.ok) throw new Error(`unfreeze write failed: ${res.status} ${await res.text()}`);
    return new Response(JSON.stringify({ address, frozen: false }), { status: 200 });
  } catch (e) {
    return new Response(JSON.stringify({ error: String(e) }), { status: 500 });
  }
});
