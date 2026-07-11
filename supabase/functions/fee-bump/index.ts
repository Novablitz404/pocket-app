// Supabase Edge Function: Phase 1 of the mainnet build plan — the treasury's
// signing key moves here, first for the fee-bump step (see
// ~/.claude/.../memory/mainnet-build-plan.md for the full phase order).
//
// The client builds and signs the INNER transaction with the user's own key
// (that signature is the actual authorization — a fee-bump adds no spending
// power, it only pays the network fee), then posts the signed envelope here.
// This function adds the treasury's fee-bump signature and submits, so
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
//
// Request body: { innerXdr: string; target: 'classic' | 'soroban' }
//   'classic' — plain payment (P2P send, cash-out): submits to Horizon.
//   'soroban' — Blend pool call (Earn deposit/withdraw): submits via
//               sendTransaction; caller keeps polling getTransaction itself
//               (a public read, needs no secret, unchanged from earn-blend.ts).
import { Buffer } from 'node:buffer';
import { Keypair, Networks, TransactionBuilder, Transaction, hash, xdr } from 'npm:@stellar/stellar-sdk@^16';

const HORIZON_URL = 'https://horizon-testnet.stellar.org';
const SOROBAN_RPC = 'https://soroban-testnet.stellar.org';
const NETWORK_PASSPHRASE = Networks.TESTNET;

const TREASURY_SECRET = Deno.env.get('TREASURY_SECRET')!;
const treasury = Keypair.fromSecret(TREASURY_SECRET);

// Fee (stroops) the treasury covers per inner operation, classic payments only
// (mirrors stellar.ts's FEE_BUMP_FEE). Soroban calls use 2x the inner
// resource fee instead (mirrors earn-blend.ts's feeBumpXdrBase64).
const CLASSIC_FEE_BUMP_FEE = 2000n;

function b64(x: { toXDR(): Buffer | Uint8Array }): string {
  return Buffer.from(x.toXDR()).toString('base64');
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
      // own fee directly (see stellar.ts's treasuryPayment/treasurySetOptions).
      // A request like this isn't a legitimate user tx, so refuse it.
      return new Response(JSON.stringify({ error: 'treasury is not a valid fee-bump source account' }), {
        status: 400,
      });
    }

    const totalFee =
      target === 'classic'
        ? (CLASSIC_FEE_BUMP_FEE * BigInt(inner.operations.length + 1)).toString()
        : (BigInt(inner.fee) * 2n).toString();

    const envelope = feeBumpEnvelope(inner, totalFee);
    const result = target === 'classic' ? await submitClassic(envelope) : await submitSoroban(envelope);
    return new Response(JSON.stringify(result), { status: 200 });
  } catch (e) {
    return new Response(JSON.stringify({ error: String(e) }), { status: 500 });
  }
});
