// Shared channel-account pool helpers for the server-side custodial ops
// (recover-account, close-account) — the concurrency fix (see
// ~/.claude/.../memory/mainnet-build-plan.md Phase 2).
//
// These two functions build + sign their whole transaction server-side (no
// client-supplied inner tx, unlike activate-account), so they claim a channel
// account directly here rather than via the client-facing reserve-channel
// endpoint. Using a channel as the transaction SOURCE gives each concurrent
// recover/close its own sequence number instead of colliding on the treasury's
// single one (tx_bad_seq). The treasury keeps only its sponsor / merge-dest /
// fee-bump roles, none of which consume its sequence.
//
// claim_channel_account uses `for update skip locked` under the hood, so two
// concurrent claims never race the same row, and its lease self-heals a
// channel left busy by a crashed request. Always release in a finally block.
const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

const rpcHeaders = {
  apikey: SERVICE_ROLE_KEY,
  Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
  'Content-Type': 'application/json',
};

/** Atomically claims one free channel account from the pool. Returns its
 *  public key (use as the tx source) and secret (sign the tx with it). Throws
 *  if the pool is exhausted. Pair every success with releaseChannel() in a
 *  finally. */
export async function claimChannel(): Promise<{ publicKey: string; secret: string }> {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/claim_channel_account`, {
    method: 'POST',
    headers: rpcHeaders,
    body: '{}',
  });
  const rows = await res.json();
  if (!res.ok) throw new Error(typeof rows === 'string' ? rows : (rows?.message ?? 'channel claim failed'));
  const row = rows[0];
  if (!row) throw new Error('no channel accounts available');
  return { publicKey: row.public_key, secret: row.secret };
}

/** Releases a channel account back to the pool. Best-effort — the lease
 *  self-heals even if this call fails, so a failure here never wedges a
 *  channel permanently. */
export async function releaseChannel(publicKey: string): Promise<void> {
  await fetch(`${SUPABASE_URL}/rest/v1/rpc/release_channel_account`, {
    method: 'POST',
    headers: rpcHeaders,
    body: JSON.stringify({ p_public_key: publicKey }),
  }).catch(() => {});
}
