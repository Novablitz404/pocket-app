// Supabase Edge Function: Phase 1 of the mainnet build plan — closeAndReclaim
// moves server-side (see ~/.claude/.../memory/mainnet-build-plan.md).
//
// 2-of-3: closing sweeps the balance, drops the trustline + extra signers, and
// merges the account — none of which the user has to be present for (that's
// the whole point: it also has to work for abandoned "ghost" accounts with no
// reachable owner). The account's own two service signers authorize it:
// Remitt-KMS + compliance = weight 2 = threshold. The treasury only sources
// the tx (fee payer) and receives the merged reserves; it is NOT a signer on
// the user's account anymore.
//
// The extra signers ARE subentries, so accountMerge requires removing them
// first — yet those same signatures authorize the merge. That's fine: Stellar
// validates a tx's signatures against the account state at the START of the
// transaction (verified on testnet), so zeroing Remitt-KMS + compliance in
// earlier ops does not invalidate the weight-2 authorization of the merge.
//
// Because this runs over a bare HTTP endpoint (not only from the owning
// device), it would otherwise let ANY anon-key holder grief-close anyone's
// account. The gate: require the account's own recovery PIN (bcrypt-checked
// server-side via verify_recovery_pin, same table/lockout `recover_profile`
// already uses) — proof the caller is the owner, not just someone who knows
// the address. An address with no PIN row on file (pre-PIN or truly
// abandoned) still closes with no PIN, matching today's client-side
// behavior; that's a deliberate, pre-existing tradeoff, not a new one.
//
// CONCURRENCY FIX (channel-account pool): the transaction SOURCE is a claimed
// channel account, not the treasury — each concurrent close gets its own
// sequence number instead of colliding on the treasury's single one
// (tx_bad_seq). Every op is already sourced from the account being closed, and
// the treasury is only the accountMerge DESTINATION (+ USDC sweep recipient) —
// neither role needs the treasury to sign, so with the channel as tx source
// the treasury is no longer a signer here at all (signing it anyway would be a
// tx_bad_auth_extra). See _shared/channels.ts.
//
// Deploy (from packages/app):
//   npx supabase functions deploy close-account
//   (needs TREASURY_SECRET [merge dest/fee-bump elsewhere], COMPLIANCE_SECRET,
//   GOOGLE_SA_JSON + REMITT_KMS_KEY_VERSION [Remitt co-signer]; run the
//   verify_recovery_pin block in supabase-schema.sql; also needs the
//   channel_accounts table + claim/release RPCs + a seeded pool)
import { Buffer } from 'node:buffer';
import { Asset, BASE_FEE, Horizon, Keypair, Networks, Operation, TransactionBuilder, xdr } from 'npm:@stellar/stellar-sdk@^16';
import { kmsSign, REMITT_KMS_PUBLIC } from '../_shared/kms.ts';
import { claimChannel, releaseChannel } from '../_shared/channels.ts';

const HORIZON_URL = 'https://horizon-testnet.stellar.org';
const NETWORK_PASSPHRASE = Networks.TESTNET;
const USDC_CODE = 'USDC';
const USDC_ISSUER = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5';
const USDC = new Asset(USDC_CODE, USDC_ISSUER);

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const TREASURY_SECRET = Deno.env.get('TREASURY_SECRET')!;
const treasury = Keypair.fromSecret(TREASURY_SECRET);
// Compliance co-signer (testnet stand-in). In production this signature comes
// from the organizationally-separate compliance holder, not an env secret.
const COMPLIANCE_SECRET = Deno.env.get('COMPLIANCE_SECRET')!;
const compliance = Keypair.fromSecret(COMPLIANCE_SECRET);

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
  let channelPublicKey: string | undefined;
  try {
    const { address, pin } = await req.json();
    if (typeof address !== 'string') {
      return new Response(JSON.stringify({ error: 'address (string) required' }), { status: 400 });
    }

    if (!(await verifyPin(address, pin))) {
      return new Response(JSON.stringify({ error: 'Wrong passcode.' }), { status: 403 });
    }

    // Sweep balance, flatten thresholds, drop the trustline, remove every
    // non-master signer (Remitt-KMS + compliance), and merge into the treasury.
    // Authorized by those same two service signers (weight 2 = threshold),
    // valid against the tx-start snapshot even as the ops remove them.
    const account = await server.loadAccount(address);
    const usdcLine = account.balances.find(
      (b: any) => b.asset_code === USDC_CODE && b.asset_issuer === USDC_ISSUER,
    );
    const balance = usdcLine ? parseFloat(usdcLine.balance) : 0;

    // A claimed channel account is the tx SOURCE (its sequence gets consumed),
    // so concurrent closes don't collide on the treasury's sequence. The
    // treasury stays only the merge destination + USDC-sweep recipient (both
    // set explicitly on the ops below), so it doesn't sign this tx.
    const channel = await claimChannel();
    channelPublicKey = channel.publicKey;
    const channelKp = Keypair.fromSecret(channel.secret);

    const source = await server.loadAccount(channelPublicKey);
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
    // channel (tx source + fee) + compliance sign locally; the Remitt signature
    // comes from KMS to reach the weight-2 threshold on the user's account. The
    // treasury is only the merge destination here, so it does NOT sign.
    tx.sign(channelKp, compliance);
    const kmsSig = await kmsSign(tx.hash());
    tx.signatures.push(new xdr.DecoratedSignature({
      hint: Keypair.fromPublicKey(REMITT_KMS_PUBLIC).signatureHint(),
      signature: Buffer.from(kmsSig),
    }));
    const result = await submitClassic(b64(tx.toEnvelope()));
    return new Response(JSON.stringify(result), { status: 200 });
  } catch (e) {
    return new Response(JSON.stringify({ error: String(e) }), { status: 500 });
  } finally {
    if (channelPublicKey) await releaseChannel(channelPublicKey);
  }
});
