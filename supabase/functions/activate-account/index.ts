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
// CONCURRENCY FIX (channel-account pool): the transaction SOURCE is now a
// reserved channel account (see reserve-channel/index.ts), not the treasury —
// each concurrent activation gets its own sequence number instead of
// colliding on the treasury's single one. The treasury's role is unchanged
// (it's still the one sponsoring reserves and becoming the weight-2
// co-signer); it's just no longer the account whose sequence gets consumed.
// Because the ops' implicit source used to be "whatever the tx source is"
// (the treasury), begin/createAccount/endSponsoringFutureReserves now need
// an EXPLICIT source = treasury instead — see assertIsActivation below.
//
// Deploy (from packages/app):
//   npx supabase functions deploy activate-account
//   (reuses the TREASURY_SECRET already set for fee-bump; also needs the
//   channel_accounts table + claim/release RPCs from supabase-schema.sql,
//   and a pool seeded via scripts/setup-channel-accounts.mjs)
import { Buffer } from 'node:buffer';
import { Keypair, Networks, TransactionBuilder, Transaction } from 'npm:@stellar/stellar-sdk@^16';

const HORIZON_URL = 'https://horizon-testnet.stellar.org';
const NETWORK_PASSPHRASE = Networks.TESTNET;
const USDC_CODE = 'USDC';
const USDC_ISSUER = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const TREASURY_SECRET = Deno.env.get('TREASURY_SECRET')!;
const treasury = Keypair.fromSecret(TREASURY_SECRET);

// 2-of-3: the account ends up with three weight-1 signers (user master +
// Remitt-KMS + compliance) and thresholds 2/2/2, so ANY TWO can act and no
// single key can. The treasury is now ONLY the reserve sponsor here — it is
// NOT a signer on the user's account anymore (that role split off to the
// KMS-held Remitt signer, which holds no funds and does no sponsoring).
const REMITT_SIGNER = Deno.env.get('REMITT_SIGNER') ?? 'GDBG6KN5PJ3JHAZSDVK5WN4ISCJYHAS4MB4ETB5CBI3P623P3APQI447';
const COMPLIANCE_SIGNER = Deno.env.get('COMPLIANCE_SIGNER') ?? 'GCBIXSUNME5SKBMA6RCKEKF3PD35LFLTYW5YJNYBRHUUFL3CCFHWH55B';
const USER_MASTER_WEIGHT = 1;
const SIGNER_WEIGHT = 1;
const THRESHOLD_LOW = 2;
const THRESHOLD_MED = 2;
const THRESHOLD_HIGH = 2;

function b64(x: { toXDR(): Buffer | Uint8Array }): string {
  return Buffer.from(x.toXDR()).toString('base64');
}

/** Throws unless `inner` is EXACTLY the six-op activation shape this function
 *  is willing to co-sign, sourced from the given reserved channel account.
 *  The extra op vs. the old five is because a setOptions can only add ONE
 *  signer, and we now add two (Remitt-KMS + compliance) instead of one
 *  treasury signer. Returns the new account's public key. */
function assertIsActivation(inner: Transaction, channelPublicKey: string): string {
  if (inner.source !== channelPublicKey) {
    throw new Error('transaction source must be the reserved channel account');
  }
  const ops = inner.operations;
  if (ops.length !== 6) throw new Error(`expected 6 operations, got ${ops.length}`);

  const [begin, create, trust, opts1, opts2, end] = ops;

  if (begin.type !== 'beginSponsoringFutureReserves') throw new Error('op 0 must be beginSponsoringFutureReserves');
  if (begin.source !== treasury.publicKey()) throw new Error('beginSponsoringFutureReserves must be sourced from the treasury');
  const newAccount = begin.sponsoredId;

  if (create.type !== 'createAccount') throw new Error('op 1 must be createAccount');
  if (create.source !== treasury.publicKey()) throw new Error('createAccount must be sourced from the treasury');
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

  // op 3: user master weight 1, thresholds 2/2/2, add Remitt-KMS as weight-1 signer.
  if (opts1.type !== 'setOptions') throw new Error('op 3 must be setOptions');
  if (opts1.source !== newAccount) throw new Error('setOptions must be sourced from the new account');
  if (opts1.masterWeight !== USER_MASTER_WEIGHT) throw new Error('unexpected masterWeight');
  if (opts1.lowThreshold !== THRESHOLD_LOW || opts1.medThreshold !== THRESHOLD_MED || opts1.highThreshold !== THRESHOLD_HIGH) {
    throw new Error('unexpected thresholds');
  }
  if (opts1.signer?.ed25519PublicKey !== REMITT_SIGNER || opts1.signer?.weight !== SIGNER_WEIGHT) {
    throw new Error('op 3 must add the Remitt signer at weight 1');
  }
  if (opts1.homeDomain || opts1.inflationDest || opts1.clearFlags || opts1.setFlags) {
    throw new Error('setOptions must not touch homeDomain/inflationDest/flags');
  }

  // op 4: add compliance as weight-1 signer and nothing else.
  if (opts2.type !== 'setOptions') throw new Error('op 4 must be setOptions');
  if (opts2.source !== newAccount) throw new Error('setOptions must be sourced from the new account');
  if (opts2.signer?.ed25519PublicKey !== COMPLIANCE_SIGNER || opts2.signer?.weight !== SIGNER_WEIGHT) {
    throw new Error('op 4 must add the compliance signer at weight 1');
  }
  if (
    opts2.masterWeight !== undefined || opts2.lowThreshold !== undefined ||
    opts2.medThreshold !== undefined || opts2.highThreshold !== undefined ||
    opts2.homeDomain || opts2.inflationDest || opts2.clearFlags || opts2.setFlags
  ) {
    throw new Error('op 4 must only add the compliance signer');
  }

  if (end.type !== 'endSponsoringFutureReserves') throw new Error('op 5 must be endSponsoringFutureReserves');
  // Sourced from the NEW account, not the treasury — the sponsored account is
  // always the one that closes its own sponsorship window, regardless of
  // which account is the tx source.
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

/** The reserved channel account's secret, iff `channelPublicKey` is actually
 *  currently held busy in the pool — refuses an arbitrary/un-reserved public
 *  key so a caller can't claim to use a channel it never actually reserved
 *  via reserve-channel. */
async function loadReservedChannelSecret(channelPublicKey: string): Promise<string> {
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/channel_accounts?public_key=eq.${encodeURIComponent(channelPublicKey)}&busy=is.true&select=secret`,
    { headers: { apikey: SERVICE_ROLE_KEY, Authorization: `Bearer ${SERVICE_ROLE_KEY}` } },
  );
  if (!res.ok) throw new Error('channel account lookup failed');
  const rows = await res.json();
  if (!rows[0]) throw new Error('channel account is not currently reserved');
  return rows[0].secret;
}

async function releaseChannel(channelPublicKey: string) {
  await fetch(`${SUPABASE_URL}/rest/v1/rpc/release_channel_account`, {
    method: 'POST',
    headers: {
      apikey: SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ p_public_key: channelPublicKey }),
  }).catch(() => {}); // best-effort — the lease still self-heals if this fails too
}

Deno.serve(async (req) => {
  let channelPublicKey: string | undefined;
  try {
    const body = await req.json();
    const { innerXdr } = body;
    channelPublicKey = body.channelPublicKey;
    if (typeof innerXdr !== 'string' || typeof channelPublicKey !== 'string') {
      return new Response(JSON.stringify({ error: 'innerXdr and channelPublicKey (strings) required' }), {
        status: 400,
      });
    }

    const inner = TransactionBuilder.fromXDR(innerXdr, NETWORK_PASSPHRASE);
    if (!(inner instanceof Transaction)) {
      return new Response(JSON.stringify({ error: 'innerXdr must be a signed (non-fee-bump) transaction' }), {
        status: 400,
      });
    }

    const newAccount = assertIsActivation(inner, channelPublicKey);
    const channelSecret = await loadReservedChannelSecret(channelPublicKey);
    inner.sign(Keypair.fromSecret(channelSecret), treasury);
    const result = await submitClassic(b64(inner.toEnvelope()));
    return new Response(JSON.stringify({ ...result, account: newAccount }), { status: 200 });
  } catch (e) {
    return new Response(JSON.stringify({ error: String(e) }), { status: 400 });
  } finally {
    if (channelPublicKey) await releaseChannel(channelPublicKey);
  }
});
