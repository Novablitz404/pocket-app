// On-ramp Phase O1: GATED server-side USDC delivery from the treasury float.
// This is the step a verified PHP deposit (detection, Phase O3) or an operator
// triggers to actually put USDC in a user's wallet — and it's the mainnet-shaped
// replacement for the client-side treasuryPayment stand-in (resolves hard wall
// #2: the treasury key never ships in the app bundle).
//
// SECURITY: delivery = money out of the float, so it must be IMPOSSIBLE for a
// user to self-trigger. Gated by ADMIN_SECRET (x-admin-secret), same as
// set-freeze — only the deposit-detection worker (which holds the secret) or an
// operator can call it. It never trusts a bare anon call.
//
// The account must already be ACTIVATED (USDC trustline exists) — activation
// needs the user's device key (2-of-3 setup), so it happens app-side before the
// deposit. Delivery here is a plain treasury->user USDC payment.
//
// CONCURRENCY: the treasury is the payment op SOURCE (it holds the USDC), which
// would collide on the treasury's sequence number under concurrent cash-ins.
// So — like the custody ops — the TX source is a claimed channel account (its
// sequence is consumed), the payment op is explicitly sourced from the treasury,
// and the treasury fee-bumps. Channels stay pure sequence providers.
//
// Deploy (from packages/app):
//   npx supabase functions deploy deliver-cash-in
//   (needs TREASURY_SECRET + ADMIN_SECRET secrets, the channel pool, and the
//   cash_in_intents table from scripts/onramp-schema.sql)
import { Buffer } from 'node:buffer';
import { Asset, BASE_FEE, Horizon, Keypair, Operation, TransactionBuilder } from 'npm:@stellar/stellar-sdk@^16';
import { claimChannel, releaseChannel } from '../_shared/channels.ts';
import { feeBumpEnvelope } from '../_shared/feebump.ts';
import { notifyAddress } from '../_shared/notify.ts';
import { HORIZON_URL, NETWORK_PASSPHRASE, USDC_CODE, USDC_ISSUER } from '../_shared/network-config.ts';
const USDC = new Asset(USDC_CODE, USDC_ISSUER);
const ADDRESS_RE = /^G[A-Z0-9]{55}$/;

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const TREASURY_SECRET = Deno.env.get('TREASURY_SECRET')!;
const ADMIN_SECRET = Deno.env.get('ADMIN_SECRET')!;
const treasury = Keypair.fromSecret(TREASURY_SECRET);
const server = new Horizon.Server(HORIZON_URL);

/** Constant-time compare so the admin secret can't be probed byte-by-byte. */
function timingSafeEqual(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const ab = enc.encode(a);
  const bb = enc.encode(b);
  if (ab.length !== bb.length) return false;
  let diff = 0;
  for (let i = 0; i < ab.length; i++) diff |= ab[i] ^ bb[i];
  return diff === 0;
}

const svc = { apikey: SERVICE_ROLE_KEY, Authorization: `Bearer ${SERVICE_ROLE_KEY}`, 'Content-Type': 'application/json' };

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

/** True if the account exists AND holds a USDC trustline (ready to receive). */
async function isReadyForUsdc(address: string): Promise<boolean> {
  try {
    const acct = await server.loadAccount(address);
    return acct.balances.some(
      (b: any) => b.asset_code === USDC_CODE && b.asset_issuer === USDC_ISSUER,
    );
  } catch {
    return false; // not created on-chain
  }
}

Deno.serve(async (req) => {
  let channelPublicKey: string | undefined;
  try {
    const provided = req.headers.get('x-admin-secret') ?? '';
    if (!ADMIN_SECRET || !timingSafeEqual(provided, ADMIN_SECRET)) {
      return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 });
    }

    const { address, amountUsdc, intentId } = await req.json();
    if (!ADDRESS_RE.test(address ?? '')) {
      return new Response(JSON.stringify({ error: 'valid Stellar address required' }), { status: 400 });
    }
    const amount = Number(amountUsdc);
    if (!Number.isFinite(amount) || amount <= 0) {
      return new Response(JSON.stringify({ error: 'amountUsdc must be a positive number' }), { status: 400 });
    }

    // If tied to an intent, refuse to double-deliver.
    if (intentId) {
      const res = await fetch(
        `${SUPABASE_URL}/rest/v1/cash_in_intents?id=eq.${encodeURIComponent(intentId)}&select=status`,
        { headers: svc },
      );
      const rows = await res.json();
      const status = rows?.[0]?.status;
      if (!status) return new Response(JSON.stringify({ error: 'intent not found' }), { status: 404 });
      if (status === 'delivered') {
        return new Response(JSON.stringify({ error: 'intent already delivered' }), { status: 409 });
      }
    }

    if (!(await isReadyForUsdc(address))) {
      return new Response(
        JSON.stringify({ error: 'account not activated (no USDC trustline) — activate before delivery' }),
        { status: 422 },
      );
    }

    // Channel-sourced, treasury-funded, treasury-fee-bumped USDC payment.
    const channel = await claimChannel();
    channelPublicKey = channel.publicKey;
    const channelKp = Keypair.fromSecret(channel.secret);

    const source = await server.loadAccount(channelPublicKey);
    const tx = new TransactionBuilder(source, { fee: BASE_FEE, networkPassphrase: NETWORK_PASSPHRASE })
      .addOperation(
        Operation.payment({ source: treasury.publicKey(), destination: address, asset: USDC, amount: amount.toFixed(7) }),
      )
      .setTimeout(60)
      .build();
    tx.sign(channelKp, treasury); // channel = tx source, treasury = payment op source
    const result = await submitClassic(feeBumpEnvelope(tx, treasury, NETWORK_PASSPHRASE));

    // Mark the intent delivered (best-effort; funds already moved).
    if (intentId) {
      await fetch(`${SUPABASE_URL}/rest/v1/cash_in_intents?id=eq.${encodeURIComponent(intentId)}`, {
        method: 'PATCH',
        headers: svc,
        body: JSON.stringify({ status: 'delivered', tx_hash: result.hash, delivered_at: new Date().toISOString() }),
      }).catch(() => {});
    }
    // Tell the user their cash-in landed.
    await notifyAddress(address, 'Cash in complete 💵', `$${amount.toFixed(2)} was added to your balance`, {
      type: 'cashin',
    }).catch(() => {});

    return new Response(JSON.stringify({ ...result, address, amount }), { status: 200 });
  } catch (e) {
    return new Response(JSON.stringify({ error: String(e) }), { status: 500 });
  } finally {
    if (channelPublicKey) await releaseChannel(channelPublicKey);
  }
});
