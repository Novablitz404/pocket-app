// Supabase Edge Function: reserves a channel account for activate-account's
// concurrency fix (channel-account pool — see supabase-schema.sql's
// channel_accounts table and mainnet-build-plan Phase 2).
//
// The client can't build+sign activate-account's transaction without knowing
// which channel account (and its exact current sequence) will be used first
// — a Stellar signature covers the WHOLE transaction envelope (source,
// sequence, fee, every operation), not a single operation, so there's no way
// to sign now and have the network accept whichever channel gets picked
// later. This function atomically claims one free channel account
// (claim_channel_account RPC, `for update skip locked` under the hood, so two
// concurrent reservations never race the same row) and returns its current
// sequence; activate-account (called next) verifies the SAME channel account
// is still reserved before using it, and always releases it back to the pool
// when done, win or lose.
//
// Deploy: npx supabase functions deploy reserve-channel
import { Horizon } from 'npm:@stellar/stellar-sdk@^16';

const HORIZON_URL = 'https://horizon-testnet.stellar.org';
const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

const server = new Horizon.Server(HORIZON_URL);

async function release(publicKey: string) {
  await fetch(`${SUPABASE_URL}/rest/v1/rpc/release_channel_account`, {
    method: 'POST',
    headers: {
      apikey: SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ p_public_key: publicKey }),
  }).catch(() => {}); // best-effort — the lease still self-heals if this fails too
}

Deno.serve(async () => {
  let claimedKey: string | null = null;
  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/claim_channel_account`, {
      method: 'POST',
      headers: {
        apikey: SERVICE_ROLE_KEY,
        Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
        'Content-Type': 'application/json',
      },
      body: '{}',
    });
    const rows = await res.json();
    if (!res.ok) throw new Error(typeof rows === 'string' ? rows : (rows?.message ?? 'claim failed'));
    const row = rows[0];
    if (!row) throw new Error('no channel accounts available');
    claimedKey = row.public_key;

    const account = await server.loadAccount(row.public_key);
    return new Response(
      JSON.stringify({ channelPublicKey: row.public_key, sequence: account.sequenceNumber() }),
      { status: 200 },
    );
  } catch (e) {
    // Release immediately on failure instead of leaving the channel tied up
    // for the full lease window — only relevant if the claim itself
    // succeeded and a later step (the Horizon read) failed.
    if (claimedKey) await release(claimedKey);
    // 503: this is a capacity/availability failure (pool exhausted, or a
    // transient Horizon read failure), not a client input error.
    return new Response(JSON.stringify({ error: String(e) }), { status: 503 });
  }
});
