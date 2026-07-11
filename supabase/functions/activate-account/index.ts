// Supabase Edge Function: Phase 1 of the mainnet build plan — account
// activation, the mainnet-shaped half of "cash-in" (see
// ~/.claude/.../memory/mainnet-build-plan.md). On mainnet an on-ramp partner
// (GCash/MoneyGram/debit card, or OwlPay per the remittance-protocol side of
// this project) delivers USDC straight to the user's wallet — the treasury
// never hands out USDC itself. Its only remaining job is sponsoring the new
// account into existence: create it, open the USDC trustline, and add
// itself as the weight-2 co-signer, all reserve-sponsored so the user's
// account holds zero XLM. That's what this function signs and submits.
//
// UNLIKE fee-bump, the treasury is an operation SOURCE here, not just the fee
// payer — signing authorizes whatever the inner tx's ops actually do. So this
// function does NOT trust the caller's operation list the way fee-bump trusts
// the user's own payment: it re-validates the exact five operations (type,
// order, every field) before signing, and refuses anything else — in
// particular, no payment/pathPayment op can ever appear with the treasury as
// its source, which would hand out treasury funds to an arbitrary caller.
//
// The user's own signature (already on the envelope when it arrives, since
// changeTrust/setOptions/endSponsoringFutureReserves are user-sourced ops on
// a brand-new keypair) is unchecked here beyond what the network itself
// enforces at submission — an invalid one just fails submission cleanly.
//
// Deploy (from packages/app):
//   npx supabase functions deploy activate-account
//   (reuses the TREASURY_SECRET already set for fee-bump)
import { Buffer } from 'node:buffer';
import { Keypair, Networks, TransactionBuilder, Transaction } from 'npm:@stellar/stellar-sdk@^16';

const HORIZON_URL = 'https://horizon-testnet.stellar.org';
const NETWORK_PASSPHRASE = Networks.TESTNET;
const USDC_CODE = 'USDC';
const USDC_ISSUER = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5';

const TREASURY_SECRET = Deno.env.get('TREASURY_SECRET')!;
const treasury = Keypair.fromSecret(TREASURY_SECRET);

const USER_MASTER_WEIGHT = 1;
const TREASURY_SIGNER_WEIGHT = 2;
const THRESHOLD_LOW = 1;
const THRESHOLD_MED = 1;
const THRESHOLD_HIGH = 2;

function b64(x: { toXDR(): Buffer | Uint8Array }): string {
  return Buffer.from(x.toXDR()).toString('base64');
}

/** Throws unless `inner` is EXACTLY the five-op activation shape this
 *  function is willing to co-sign. Returns the new account's public key. */
function assertIsActivation(inner: Transaction): string {
  if (inner.source !== treasury.publicKey()) {
    throw new Error('transaction source must be the treasury');
  }
  const ops = inner.operations;
  if (ops.length !== 5) throw new Error(`expected 5 operations, got ${ops.length}`);

  const [begin, create, trust, opts, end] = ops;

  if (begin.type !== 'beginSponsoringFutureReserves') throw new Error('op 0 must be beginSponsoringFutureReserves');
  const newAccount = begin.sponsoredId;

  if (create.type !== 'createAccount') throw new Error('op 1 must be createAccount');
  if (create.destination !== newAccount) throw new Error('createAccount destination must match sponsoredId');
  if (parseFloat(create.startingBalance) !== 0) throw new Error('createAccount must fund zero XLM (sponsored reserves only)');

  if (trust.type !== 'changeTrust') throw new Error('op 2 must be changeTrust');
  if (trust.source !== newAccount) throw new Error('changeTrust must be sourced from the new account');
  // Parsed from XDR, `line` is a plain {code, issuer} object, not an Asset instance.
  if (trust.line?.code !== USDC_CODE || trust.line?.issuer !== USDC_ISSUER) {
    throw new Error('changeTrust must be for USDC');
  }
  if (trust.limit !== undefined && trust.limit !== '922337203685.4775807') {
    throw new Error('changeTrust must not set a reduced limit');
  }

  if (opts.type !== 'setOptions') throw new Error('op 3 must be setOptions');
  if (opts.source !== newAccount) throw new Error('setOptions must be sourced from the new account');
  if (opts.masterWeight !== USER_MASTER_WEIGHT) throw new Error('unexpected masterWeight');
  if (opts.lowThreshold !== THRESHOLD_LOW || opts.medThreshold !== THRESHOLD_MED || opts.highThreshold !== THRESHOLD_HIGH) {
    throw new Error('unexpected thresholds');
  }
  if (opts.signer?.ed25519PublicKey !== treasury.publicKey() || opts.signer?.weight !== TREASURY_SIGNER_WEIGHT) {
    throw new Error('setOptions must add the treasury as the sole weight-2 signer');
  }
  if (opts.homeDomain || opts.inflationDest || opts.clearFlags || opts.setFlags) {
    throw new Error('setOptions must not touch homeDomain/inflationDest/flags');
  }

  if (end.type !== 'endSponsoringFutureReserves') throw new Error('op 4 must be endSponsoringFutureReserves');
  if (end.source !== newAccount) throw new Error('endSponsoringFutureReserves must be sourced from the new account');

  return newAccount;
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
    const { innerXdr } = await req.json();
    if (typeof innerXdr !== 'string') {
      return new Response(JSON.stringify({ error: 'innerXdr (string) required' }), { status: 400 });
    }

    const inner = TransactionBuilder.fromXDR(innerXdr, NETWORK_PASSPHRASE);
    if (!(inner instanceof Transaction)) {
      return new Response(JSON.stringify({ error: 'innerXdr must be a signed (non-fee-bump) transaction' }), {
        status: 400,
      });
    }

    const newAccount = assertIsActivation(inner);
    inner.sign(treasury);
    const result = await submitClassic(b64(inner.toEnvelope()));
    return new Response(JSON.stringify({ ...result, account: newAccount }), { status: 200 });
  } catch (e) {
    return new Response(JSON.stringify({ error: String(e) }), { status: 400 });
  }
});
