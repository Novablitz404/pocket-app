// Supabase Edge Function: Phase 1 of the mainnet build plan — closeAndReclaim
// moves server-side (see ~/.claude/.../memory/mainnet-build-plan.md).
//
// Unlike fee-bump/activate-account, the treasury acts here with NO user
// signature to lean on at all — it alone can sweep the balance, drop
// signers, and merge the account (that's the whole point: it also has to
// work for abandoned "ghost" accounts with no reachable owner). Once this
// runs over a bare HTTP endpoint instead of only from the owning device, that
// same feature becomes a way for ANY anon-key holder to grief-close anyone's
// account. The gate: require the account's own recovery PIN (bcrypt-checked
// server-side via verify_recovery_pin, same table/lockout `recover_profile`
// already uses) — proof the caller is the owner, not just someone who knows
// the address. An address with no PIN row on file (pre-PIN or truly
// abandoned) still closes with no PIN, matching today's client-side
// behavior; that's a deliberate, pre-existing tradeoff, not a new one.
//
// Deploy (from packages/app):
//   npx supabase functions deploy close-account
//   (reuses TREASURY_SECRET; run the verify_recovery_pin block in
//   supabase-schema.sql first)
import { Buffer } from 'node:buffer';
import { Asset, BASE_FEE, Horizon, Keypair, Networks, Operation, TransactionBuilder } from 'npm:@stellar/stellar-sdk@^16';

const HORIZON_URL = 'https://horizon-testnet.stellar.org';
const NETWORK_PASSPHRASE = Networks.TESTNET;
const USDC_CODE = 'USDC';
const USDC_ISSUER = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5';
const USDC = new Asset(USDC_CODE, USDC_ISSUER);

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const TREASURY_SECRET = Deno.env.get('TREASURY_SECRET')!;
const treasury = Keypair.fromSecret(TREASURY_SECRET);

const server = new Horizon.Server(HORIZON_URL);

async function verifyPin(address: string, pin: string | undefined): Promise<boolean> {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/verify_recovery_pin`, {
    method: 'POST',
    headers: {
      apikey: SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ p_address: address, p_pin: pin ?? null }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(typeof data === 'string' ? data : data?.message ?? 'PIN check failed');
  return data === true;
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
    const { address, pin } = await req.json();
    if (typeof address !== 'string') {
      return new Response(JSON.stringify({ error: 'address (string) required' }), { status: 400 });
    }

    if (!(await verifyPin(address, pin))) {
      return new Response(JSON.stringify({ error: 'Wrong passcode.' }), { status: 403 });
    }

    // Mirrors stellar.ts's old closeAndReclaim exactly, just executed here
    // instead of on-device: sweep balance, flatten thresholds, drop the
    // trustline, remove every non-master signer, merge into the treasury.
    const account = await server.loadAccount(address);
    const usdcLine = account.balances.find(
      (b: any) => b.asset_code === USDC_CODE && b.asset_issuer === USDC_ISSUER,
    );
    const balance = usdcLine ? parseFloat(usdcLine.balance) : 0;

    const source = await server.loadAccount(treasury.publicKey());
    const builder = new TransactionBuilder(source, { fee: BASE_FEE, networkPassphrase: NETWORK_PASSPHRASE });

    if (balance > 0.0000001) {
      builder.addOperation(
        Operation.payment({
          source: address,
          destination: treasury.publicKey(),
          asset: USDC,
          amount: balance.toFixed(7),
        }),
      );
    }
    builder.addOperation(
      Operation.setOptions({ source: address, lowThreshold: 1, medThreshold: 1, highThreshold: 1 }),
    );
    if (usdcLine) {
      builder.addOperation(Operation.changeTrust({ source: address, asset: USDC, limit: '0' }));
    }
    for (const signer of account.signers) {
      if (signer.type === 'ed25519_public_key' && signer.key !== address) {
        builder.addOperation(
          Operation.setOptions({ source: address, signer: { ed25519PublicKey: signer.key, weight: 0 } }),
        );
      }
    }
    builder.addOperation(Operation.accountMerge({ source: address, destination: treasury.publicKey() }));

    const tx = builder.setTimeout(60).build();
    tx.sign(treasury);
    const result = await submitClassic(b64(tx.toEnvelope()));
    return new Response(JSON.stringify(result), { status: 200 });
  } catch (e) {
    return new Response(JSON.stringify({ error: String(e) }), { status: 500 });
  }
});
