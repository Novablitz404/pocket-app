// Supabase Edge Function: Phase 1 of the mainnet build plan — recoverAccount
// moves server-side (see ~/.claude/.../memory/mainnet-build-plan.md).
//
// The treasury acts here with NO user signature to lean on (it re-keys the
// account alone, using its weight-2 co-signer status), so identity has to
// come from somewhere else. It's already been proven once by the time the
// app reaches this call: recoverExistingAccount() first calls the
// recover_profile RPC with a Supabase Auth JWT (from the email OTP flow) and
// the recovery PIN, and only proceeds on success. Rather than re-check the
// PIN a second time here (which would double-count attempts against the same
// 5-try lockout), this function re-derives identity from that SAME JWT via
// GoTrue (the source of truth for "whose token is this"), then looks up the
// verified-email profile it belongs to — an address can't be re-keyed by
// anyone but the person who already passed that email's OTP, mirroring
// recover_profile's own `auth.jwt() ->> 'email'` pattern.
//
// Deploy (from packages/app):
//   npx supabase functions deploy recover-account
//   (reuses TREASURY_SECRET)
import { Buffer } from 'node:buffer';
import { BASE_FEE, Horizon, Keypair, Networks, Operation, TransactionBuilder } from 'npm:@stellar/stellar-sdk@^16';

const HORIZON_URL = 'https://horizon-testnet.stellar.org';
const NETWORK_PASSPHRASE = Networks.TESTNET;

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const TREASURY_SECRET = Deno.env.get('TREASURY_SECRET')!;
const treasury = Keypair.fromSecret(TREASURY_SECRET);

const USER_MASTER_WEIGHT = 1;

const server = new Horizon.Server(HORIZON_URL);

/** The verified email behind a Supabase Auth access token, per GoTrue itself
 *  (never decoded/trusted locally) — the same token recoverProfile() already
 *  validated PIN + email-ownership against. */
async function emailFromAccessToken(accessToken: string): Promise<string | null> {
  const res = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: { apikey: SERVICE_ROLE_KEY, Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) return null;
  const user = await res.json();
  return user?.email ? String(user.email).toLowerCase() : null;
}

async function addressForVerifiedEmail(email: string): Promise<string | null> {
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/profiles?email=eq.${encodeURIComponent(email)}&email_verified=is.true&select=address`,
    { headers: { apikey: SERVICE_ROLE_KEY, Authorization: `Bearer ${SERVICE_ROLE_KEY}` } },
  );
  if (!res.ok) throw new Error('Profile lookup failed');
  const rows = await res.json();
  return rows[0]?.address ?? null;
}

function b64(x: { toXDR(): Buffer | Uint8Array }): string {
  return Buffer.from(x.toXDR()).toString('base64');
}

async function submitClassic(envelopeB64: string) {
  const res = await fetch(`${HORIZON_URL}/transactions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `tx=${encodeURIComponent(envelopeB64)}`,
  });
  const data = await res.json();
  if (!res.ok) {
    const codes = data?.extras?.result_codes;
    throw new Error(codes ? JSON.stringify(codes) : data?.title ?? 'Horizon rejected the transaction');
  }
  return { hash: data.hash, ledger: data.ledger };
}

Deno.serve(async (req) => {
  try {
    const { accessToken, newDevicePublicKey } = await req.json();
    if (typeof accessToken !== 'string' || typeof newDevicePublicKey !== 'string') {
      return new Response(JSON.stringify({ error: 'accessToken and newDevicePublicKey (strings) required' }), {
        status: 400,
      });
    }

    const email = await emailFromAccessToken(accessToken);
    if (!email) return new Response(JSON.stringify({ error: 'Invalid or expired session' }), { status: 401 });

    const address = await addressForVerifiedEmail(email);
    if (!address) {
      return new Response(JSON.stringify({ error: 'No recoverable account for this email' }), { status: 404 });
    }

    // Mirrors stellar.ts's old recoverAccount exactly: treasury alone re-keys
    // the account to the new device and disables the old master key.
    const source = await server.loadAccount(treasury.publicKey());
    const tx = new TransactionBuilder(source, { fee: BASE_FEE, networkPassphrase: NETWORK_PASSPHRASE })
      .addOperation(Operation.beginSponsoringFutureReserves({ sponsoredId: address }))
      .addOperation(
        Operation.setOptions({
          source: address,
          signer: { ed25519PublicKey: newDevicePublicKey, weight: USER_MASTER_WEIGHT },
        }),
      )
      .addOperation(Operation.endSponsoringFutureReserves({ source: address }))
      .addOperation(Operation.setOptions({ source: address, masterWeight: 0 }))
      .setTimeout(60)
      .build();
    tx.sign(treasury);
    const result = await submitClassic(b64(tx.toEnvelope()));
    return new Response(JSON.stringify({ ...result, address }), { status: 200 });
  } catch (e) {
    return new Response(JSON.stringify({ error: String(e) }), { status: 500 });
  }
});
