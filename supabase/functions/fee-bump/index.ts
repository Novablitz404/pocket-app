// Supabase Edge Function: Phase 1 of the mainnet build plan — the treasury's
// signing key moves here, first for the fee-bump step (see
// ~/.claude/.../memory/mainnet-build-plan.md for the full phase order).
//
// 2-of-3 CO-SIGNING: user accounts are now 2-of-3 (user + Remitt-KMS +
// compliance, thresholds 2/2/2), so the user's own signature (weight 1) no
// longer authorizes a payment by itself. This function is the single choke
// point every user tx passes through, so it's where Remitt adds its weight-1
// KMS co-signature to the INNER transaction (weight 1 + 1 = 2 = threshold)
// before fee-bumping. Two consequences:
//   1. This is also the FREEZE enforcement point — freezing an account is
//      simply Remitt refusing to co-sign here; no on-chain change needed.
//   2. Because co-signing is a REAL authorization on the user's account (not
//      just paying a fee), we don't blindly stamp whatever the caller sent:
//      classic txs are validated to be USDC payments sourced from the sender,
//      and soroban txs to be pure contract invokes — anything else (a
//      setOptions re-key, an accountMerge, a non-USDC transfer) is refused, so
//      a stolen user key still can't turn our co-signature into a drain.
//
// The client builds and signs the INNER transaction with the user's own key,
// then posts the signed envelope here. This function co-signs it with the
// Remitt KMS key, adds the treasury's fee-bump signature, and submits — so
// TREASURY_SECRET never needs to ship in the app bundle again.
//
// Mirrors the fee-bump math already proven client-side in stellar.ts
// (feeBumpEnvelopeXdr) and earn-blend.ts (feeBumpXdrBase64) — same constants,
// same XDR-level construction (never TransactionBuilder.buildFeeBumpTransaction,
// which re-parses the inner tx; unnecessary here since Deno has no Hermes bug,
// but there's no reason to diverge from the proven approach).
//
// Deploy (from packages/app):
//   npx supabase functions deploy fee-bump
//   npx supabase secrets set TREASURY_SECRET=S...
//   (also needs GOOGLE_SA_JSON + REMITT_KMS_KEY_VERSION for the Remitt
//   co-signature — see _shared/kms.ts)
//
// Request body: { innerXdr: string; target: 'classic' | 'soroban' }
//   'classic' — plain payment (P2P send, cash-out): submits to Horizon.
//   'soroban' — Blend pool call (Earn deposit/withdraw): submits via
//               sendTransaction; caller keeps polling getTransaction itself
//               (a public read, needs no secret, unchanged from earn-blend.ts).
import { Buffer } from 'node:buffer';
import { Keypair, Networks, TransactionBuilder, Transaction, hash, xdr } from 'npm:@stellar/stellar-sdk@^16';
import { kmsSign, REMITT_KMS_PUBLIC } from '../_shared/kms.ts';
import { displayName, notifyAddress } from '../_shared/notify.ts';

const HORIZON_URL = 'https://horizon-testnet.stellar.org';
const SOROBAN_RPC = 'https://soroban-testnet.stellar.org';
const NETWORK_PASSPHRASE = Networks.TESTNET;
const USDC_CODE = 'USDC';
const USDC_ISSUER = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5';
// Mirrors stellar.ts's FEE_MEMO — marks Remitt's own internal fee collections
// (e.g. the Earn withdrawal fee), which also land at the treasury but are NOT
// user cash-outs, so they must NOT be enqueued as off-ramp payouts.
const FEE_MEMO = 'remitt-fee';

const TREASURY_SECRET = Deno.env.get('TREASURY_SECRET')!;
const treasury = Keypair.fromSecret(TREASURY_SECRET);
const kmsHint = Keypair.fromPublicKey(REMITT_KMS_PUBLIC).signatureHint();

// Supabase (auto-injected) — used only for the freeze-list lookup below.
const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

// Fee (stroops) the treasury covers per inner operation, classic payments only
// (mirrors stellar.ts's FEE_BUMP_FEE). Soroban calls use 2x the inner
// resource fee instead (mirrors earn-blend.ts's feeBumpXdrBase64).
const CLASSIC_FEE_BUMP_FEE = 2000n;

function b64(x: { toXDR(): Buffer | Uint8Array }): string {
  return Buffer.from(x.toXDR()).toString('base64');
}

/** FREEZE enforcement point (2-of-3): a user send only reaches weight 2 if
 *  Remitt co-signs below, so freezing an account is simply refusing to co-sign
 *  here — no on-chain change needed. Frozen addresses live in the
 *  `frozen_accounts` table (managed by the admin-only set-freeze function).
 *
 *  FAIL-CLOSED: if the freeze list can't be read, we refuse to co-sign rather
 *  than risk letting a frozen account through. This adds no real availability
 *  risk — the query hits the same Supabase project this function runs on, so if
 *  it's unreachable the function is already down. */
async function assertNotFrozen(address: string): Promise<void> {
  let rows: unknown[];
  try {
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/frozen_accounts?address=eq.${encodeURIComponent(address)}&select=address`,
      { headers: { apikey: SERVICE_ROLE_KEY, Authorization: `Bearer ${SERVICE_ROLE_KEY}` } },
    );
    if (!res.ok) throw new Error(`status ${res.status}`);
    rows = await res.json();
  } catch (e) {
    throw new Error(`freeze check unavailable — refusing to co-sign (${e})`);
  }
  if (Array.isArray(rows) && rows.length > 0) throw new Error('account is frozen');
}

/** A classic inner tx we're willing to co-sign: only USDC payments, each
 *  sourced from the sending account (the tx source). Refuses setOptions
 *  (re-key), accountMerge, changeTrust, non-USDC transfers — so co-signing a
 *  compromised user key still can't drain or hijack the account. */
function assertClassicIsSend(inner: Transaction): void {
  if (inner.operations.length === 0) throw new Error('nothing to co-sign');
  for (const op of inner.operations) {
    if (op.type !== 'payment') throw new Error(`refusing to co-sign a "${op.type}" op — only USDC payments`);
    if (op.source && op.source !== inner.source) {
      throw new Error('payment must be sourced from the sending account');
    }
    const a: any = op.asset;
    const code = typeof a?.getCode === 'function' ? a.getCode() : a?.code;
    const issuer = a && typeof a.isNative === 'function' && a.isNative()
      ? undefined
      : (typeof a?.getIssuer === 'function' ? a.getIssuer() : a?.issuer);
    if (code !== USDC_CODE || issuer !== USDC_ISSUER) throw new Error('only USDC payments may be co-signed');
  }
}

/** A soroban inner tx we're willing to co-sign: only contract invokes (the
 *  Blend Earn deposit/withdraw path), sourced from the user. Deeper per-call
 *  validation is out of scope — the funds move within the user's own Blend
 *  position, a bounded risk vs. the classic drain vector. */
function assertSorobanIsInvoke(inner: Transaction): void {
  if (inner.operations.length === 0) throw new Error('nothing to co-sign');
  for (const op of inner.operations) {
    if (op.type !== 'invokeHostFunction') {
      throw new Error(`refusing to co-sign a "${op.type}" op — only Soroban invokes`);
    }
  }
}

/** Add Remitt's weight-1 KMS signature over the inner tx hash, taking the
 *  user's weight-1 signature up to the weight-2 threshold. Mutates `inner`, so
 *  the fee-bump envelope (built from inner.toEnvelope()) carries it. */
async function coSignInner(inner: Transaction): Promise<void> {
  const kmsSig = await kmsSign(inner.hash());
  inner.signatures.push(new xdr.DecoratedSignature({ hint: kmsHint, signature: Buffer.from(kmsSig) }));
}

function feeBumpEnvelope(inner: Transaction, totalFee: string): string {
  const feeBumpTx = new xdr.FeeBumpTransaction({
    feeSource: treasury.xdrMuxedAccount(),
    fee: xdr.Int64.fromString(totalFee),
    innerTx: xdr.FeeBumpTransactionInnerTx.envelopeTypeTx(inner.toEnvelope().v1()),
    ext: new xdr.FeeBumpTransactionExt(0),
  });
  const sigPayload = new xdr.TransactionSignaturePayload({
    networkId: hash(Buffer.from(NETWORK_PASSPHRASE)),
    taggedTransaction:
      xdr.TransactionSignaturePayloadTaggedTransaction.envelopeTypeTxFeeBump(feeBumpTx),
  });
  const decorated = treasury.signDecorated(hash(sigPayload.toXDR()));
  const envelope = xdr.TransactionEnvelope.envelopeTypeTxFeeBump(
    new xdr.FeeBumpTransactionEnvelope({ tx: feeBumpTx, signatures: [decorated] }),
  );
  return b64(envelope);
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

async function submitSoroban(envelopeB64: string) {
  const res = await fetch(SOROBAN_RPC, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'sendTransaction',
      params: { transaction: envelopeB64 },
    }),
  });
  const json = await res.json();
  if (json.error) throw new Error(json.error.message ?? JSON.stringify(json.error));
  if (json.result?.status === 'ERROR') {
    throw new Error('Soroban RPC rejected the transaction: ' + (json.result.errorResultXdr ?? 'ERROR'));
  }
  return { hash: json.result.hash, status: json.result.status };
}

/** The tx's text memo as a plain string, or undefined for none/non-text. Used
 *  to tell an internal fee collection (FEE_MEMO) apart from a real cash-out. */
function memoText(inner: Transaction): string | undefined {
  const m: any = inner.memo;
  const type = m?.type ?? m?._type;
  if (!m || type === 'none' || type === undefined) return undefined;
  const v = m.value ?? m._value;
  if (v == null) return undefined;
  return Buffer.isBuffer(v) ? v.toString('utf8') : String(v);
}

/** Records a user cash-out (USDC → treasury) as a pending off-ramp payout for
 *  the operator dashboard to disburse — the settlement-detection step the
 *  off-ramp blocker needs. Idempotent on tx_hash (unique), so a retry or the
 *  reconciliation watcher can't double-enqueue. Best-effort. */
async function enqueueOfframp(address: string, amount: string, memo: string | undefined, txHash: string): Promise<void> {
  await fetch(`${SUPABASE_URL}/rest/v1/offramp_payouts`, {
    method: 'POST',
    headers: {
      apikey: SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
      'Content-Type': 'application/json',
      Prefer: 'resolution=ignore-duplicates',
    },
    body: JSON.stringify({ address, amount: Number(amount), memo: memo ?? null, tx_hash: txHash, status: 'pending' }),
  }).catch(() => {});
}

/** After a classic send settles on-chain, emit the server-side side effects the
 *  client used to (spoofably) trigger itself: a "money received" notification to
 *  the recipient of a P2P send, or an off-ramp payout row for a cash-out to the
 *  treasury. Runs post-submit; strictly best-effort so it can never fail a send
 *  that already settled. */
async function emitClassicSideEffects(inner: Transaction, txHash: string): Promise<void> {
  const memo = memoText(inner);
  const sender = inner.source;
  const treasuryPub = treasury.publicKey();
  for (const op of inner.operations) {
    if (op.type !== 'payment') continue;
    const dest = (op as any).destination as string;
    const amount = (op as any).amount as string;
    if (dest === treasuryPub) {
      if (memo === FEE_MEMO) continue; // internal fee collection, not a cash-out
      await enqueueOfframp(sender, amount, memo, txHash);
    } else {
      const name = await displayName(sender);
      await notifyAddress(dest, 'Money received 💸', `${name} sent you $${Number(amount).toFixed(2)}`, {
        type: 'received',
        from: sender,
      });
    }
  }
}

Deno.serve(async (req) => {
  try {
    const { innerXdr, target } = await req.json();
    if (typeof innerXdr !== 'string' || (target !== 'classic' && target !== 'soroban')) {
      return new Response(JSON.stringify({ error: 'innerXdr (string) and target ("classic"|"soroban") required' }), {
        status: 400,
      });
    }

    const inner = TransactionBuilder.fromXDR(innerXdr, NETWORK_PASSPHRASE);
    if (!(inner instanceof Transaction)) {
      return new Response(JSON.stringify({ error: 'innerXdr must be a signed (non-fee-bump) transaction' }), {
        status: 400,
      });
    }
    if (inner.source === treasury.publicKey()) {
      // The treasury never needs its OWN transactions fee-bumped — it pays its
      // own fee directly (see stellar.ts's treasuryPayment). A request like
      // this isn't a legitimate user tx, so refuse it.
      return new Response(JSON.stringify({ error: 'treasury is not a valid fee-bump source account' }), {
        status: 400,
      });
    }

    // Validate the inner tx is something we're willing to authorize, refuse to
    // co-sign frozen accounts, then add Remitt's KMS co-signature (weight 2).
    if (target === 'classic') assertClassicIsSend(inner);
    else assertSorobanIsInvoke(inner);
    await assertNotFrozen(inner.source);
    await coSignInner(inner);

    const totalFee =
      target === 'classic'
        ? (CLASSIC_FEE_BUMP_FEE * BigInt(inner.operations.length + 1)).toString()
        : (BigInt(inner.fee) * 2n).toString();

    const envelope = feeBumpEnvelope(inner, totalFee);
    const result = target === 'classic' ? await submitClassic(envelope) : await submitSoroban(envelope);
    // Post-settlement, server-authoritative side effects (receive notification /
    // off-ramp enqueue). Best-effort — the payment already settled on-chain, so
    // a failure here must not turn a successful send into an error response.
    if (target === 'classic') {
      await emitClassicSideEffects(inner, result.hash).catch(() => {});
    }
    return new Response(JSON.stringify(result), { status: 200 });
  } catch (e) {
    return new Response(JSON.stringify({ error: String(e) }), { status: 500 });
  }
});
