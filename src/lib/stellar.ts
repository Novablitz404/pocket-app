// All blockchain access lives in this file. Screens deal in dollars and
// activity items only — Stellar is the invisible backend.
//
// Account model (mainnet-accurate):
//   - New wallets are generated locally; nothing hits the chain until the
//     first deposit (lazy activation).
//   - On first deposit the treasury CREATES the account with SPONSORED
//     RESERVES, so the user's account holds ZERO XLM. The treasury holds the
//     reserves and reclaims them if the account is ever closed.
//   - The treasury is added as a co-signer (weight 2) with thresholds
//     low/med/high = 1/1/2. The user's own key (weight 1) transacts normally,
//     but the treasury can FREEZE, RECOVER (re-key), and RECLAIM the account
//     on its own — the custodial-with-recovery model.
//   - Every user transaction is FEE-BUMPED by the treasury, so the user never
//     needs XLM for fees either.
import { Buffer } from 'buffer';
import EventSource from 'react-native-sse';
import { Asset, BASE_FEE, Horizon, Keypair, Memo, Networks, Operation, TransactionBuilder } from '@stellar/stellar-sdk';
import { POOL_ID as BLEND_POOL_ID } from './earn-blend.ts';
import { ANON_KEY, SUPABASE_URL } from './directory.ts';
import { HORIZON_URL, TREASURY_PUBLIC, TREASURY_SECRET, USDC_CODE, USDC_ISSUER } from './stellar-config.ts';

const server = new Horizon.Server(HORIZON_URL);
const NETWORK = Networks.TESTNET;
const USDC = new Asset(USDC_CODE, USDC_ISSUER);
const treasuryKp = () => Keypair.fromSecret(TREASURY_SECRET);

// Treasury co-signer weight and account thresholds. med=1 lets the user
// transact alone; high=2 means only the treasury (weight 2) can change
// signers, freeze, or merge — the user can't lock the treasury out.
const TREASURY_SIGNER_WEIGHT = 2;
const USER_MASTER_WEIGHT = 1;
const THRESHOLD_LOW = 1;
const THRESHOLD_MED = 1;
const THRESHOLD_HIGH = 2;

// Minimum first deposit (USD) required to open an account. Product rule, not
// a chain constraint — the treasury fronts the XLM reserves regardless.
export const MIN_FIRST_DEPOSIT = 1;

export interface ActivityItem {
  id: string;
  kind: 'sent' | 'received' | 'cash-in' | 'cash-out' | 'earn-deposit' | 'earn-withdraw';
  amount: number;
  counterparty: string; // address; UI maps to friendly labels
  createdAt: string;
  txHash: string; // Stellar transaction hash, for the detail view's explorer link
  memo?: string; // user-entered note on a P2P send, if any
}

// Tx memo marking Remitt's own fee collections (e.g. the Earn withdrawal
// fee) so getActivity can hide them — users shouldn't see our fee transfers.
export const FEE_MEMO = 'remitt-fee';

// POST a base64 transaction envelope to Horizon. We submit via plain fetch
// because the SDK's HTTP client sends an empty envelope under React Native.
async function postTx(xdrBase64: string) {
  const res = await fetch(`${HORIZON_URL}/transactions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `tx=${encodeURIComponent(xdrBase64)}`,
  });
  const data = await res.json();
  if (!res.ok) {
    console.error('Horizon rejected tx:', JSON.stringify(data));
    const codes = data?.extras?.result_codes;
    throw new Error(codes ? JSON.stringify(codes) : data?.title ?? 'Transaction failed');
  }
  return data;
}

// The base64 encoding is done explicitly because tx.toXDR() falls back to
// Uint8Array.toString() on Hermes, which ignores the 'base64' argument.
async function submit(tx: { toEnvelope(): { toXDR(): Uint8Array } }) {
  return postTx(Buffer.from(tx.toEnvelope().toXDR()).toString('base64'));
}

/**
 * Ask the `fee-bump` Edge Function to wrap a user-signed inner transaction in
 * a treasury fee-bump and submit it. The user's own signature on the inner
 * tx IS the authorization (a fee-bump adds no spending power, only pays the
 * fee) — this is why TREASURY_SECRET can live server-side now instead of in
 * the app bundle. See supabase/functions/fee-bump/index.ts.
 */
async function feeBumpAndSubmit(inner: { toEnvelope(): { toXDR(): Uint8Array } }): Promise<void> {
  const innerXdr = Buffer.from(inner.toEnvelope().toXDR()).toString('base64');
  const res = await fetch(`${SUPABASE_URL}/functions/v1/fee-bump`, {
    method: 'POST',
    headers: { apikey: ANON_KEY, Authorization: `Bearer ${ANON_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ innerXdr, target: 'classic' }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data?.error ?? 'Fee-bump submission failed');
}

/**
 * Generates a wallet locally. No network call, no XLM — nothing touches the
 * chain until the user first funds the account (see cashIn). Instant.
 */
export function createWallet(): { publicKey: string; secret: string } {
  const kp = Keypair.random();
  return { publicKey: kp.publicKey(), secret: kp.secret() };
}

/** Whether the account has been created on-chain yet. */
export async function accountExists(publicKey: string): Promise<boolean> {
  try {
    await server.loadAccount(publicKey);
    return true;
  } catch (e: any) {
    if (e?.response?.status === 404 || e?.name === 'NotFoundError') return false;
    throw e;
  }
}

/** USD balance (USDC) for an account. Zero until the account is activated. */
export async function getBalance(publicKey: string): Promise<number> {
  let account;
  try {
    account = await server.loadAccount(publicKey);
  } catch (e: any) {
    if (e?.response?.status === 404 || e?.name === 'NotFoundError') return 0;
    throw e;
  }
  const line = account.balances.find(
    (b: any) => b.asset_code === USDC_CODE && b.asset_issuer === USDC_ISSUER,
  );
  return line ? parseFloat(line.balance) : 0;
}

/** Whether the account is frozen (treasury raised the med threshold). */
export async function isFrozen(publicKey: string): Promise<boolean> {
  try {
    const account = await server.loadAccount(publicKey);
    return account.thresholds.med_threshold > USER_MASTER_WEIGHT;
  } catch {
    return false;
  }
}

/**
 * Activation: sponsored, gasless account creation. The user's account ends
 * up holding 0 XLM; the treasury sponsors the base + trustline + signer
 * reserves. No payment op — on mainnet the on-ramp partner (GCash/MoneyGram/
 * debit card, or OwlPay for the remittance protocol side) delivers USDC
 * straight to this wallet once the trustline exists; the treasury never
 * hands out USDC itself. This is why activation is a separate call from
 * funding: unlike a fee-bump (where the treasury only pays the fee), here
 * the treasury is an operation SOURCE, so the server (see
 * supabase/functions/activate-account) re-validates the exact op list before
 * signing rather than trusting the caller — that's the whole reason this
 * moved out of `activateAndFund`'s single combined tx with a payment op.
 */
async function activateAccount(userSecret: string) {
  const user = Keypair.fromSecret(userSecret);
  const source = await server.loadAccount(TREASURY_PUBLIC);
  const tx = new TransactionBuilder(source, { fee: BASE_FEE, networkPassphrase: NETWORK })
    .addOperation(Operation.beginSponsoringFutureReserves({ sponsoredId: user.publicKey() }))
    .addOperation(Operation.createAccount({ destination: user.publicKey(), startingBalance: '0' }))
    .addOperation(Operation.changeTrust({ source: user.publicKey(), asset: USDC }))
    .addOperation(
      Operation.setOptions({
        source: user.publicKey(),
        masterWeight: USER_MASTER_WEIGHT,
        lowThreshold: THRESHOLD_LOW,
        medThreshold: THRESHOLD_MED,
        highThreshold: THRESHOLD_HIGH,
        signer: { ed25519PublicKey: TREASURY_PUBLIC, weight: TREASURY_SIGNER_WEIGHT },
      }),
    )
    .addOperation(Operation.endSponsoringFutureReserves({ source: user.publicKey() }))
    .setTimeout(60)
    .build();
  tx.sign(user);
  const innerXdr = Buffer.from(tx.toEnvelope().toXDR()).toString('base64');
  const res = await fetch(`${SUPABASE_URL}/functions/v1/activate-account`, {
    method: 'POST',
    headers: { apikey: ANON_KEY, Authorization: `Bearer ${ANON_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ innerXdr }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data?.error ?? 'Account activation failed');
}

/** Plain treasury → user USDC payment (treasury has XLM, pays its own fee). */
async function treasuryPayment(to: string, amount: number) {
  const treasury = treasuryKp();
  const source = await server.loadAccount(treasury.publicKey());
  const tx = new TransactionBuilder(source, { fee: BASE_FEE, networkPassphrase: NETWORK })
    .addOperation(Operation.payment({ destination: to, asset: USDC, amount: amount.toFixed(7) }))
    .setTimeout(60)
    .build();
  tx.sign(treasury);
  await submit(tx);
}

/**
 * Cash in: settles USD onto the user's account. First deposit activates the
 * account (sponsored, server-signed — see activateAccount); later deposits
 * are plain treasury payments.
 *
 * The payment below is a TESTNET-ONLY stand-in for a real on-ramp partner
 * (no partner integration exists yet — see [[owlpay-b-hybrid-decision]] for
 * the remittance-protocol side's plan). On mainnet, once a partner is wired
 * up, it delivers USDC directly to the user's wallet after activation and
 * this treasuryPayment call goes away entirely.
 */
export async function cashIn(userPublicKey: string, userSecret: string, amount: number) {
  if (await accountExists(userPublicKey)) {
    await treasuryPayment(userPublicKey, amount);
    return;
  }
  await activateAccount(userSecret);
  await treasuryPayment(userPublicKey, amount);
}

/**
 * A user-signed USDC payment, fee-bumped by the treasury so the user's
 * account never needs XLM. Used for P2P sends and cash-outs.
 *
 * `accountPublicKey` is the on-chain account (stable); `signingSecret` is the
 * key currently authorised on it. After a recovery these differ — the new
 * device key signs for the original account address.
 */
async function feeBumpedUserPayment(
  accountPublicKey: string,
  signingSecret: string,
  to: string,
  amount: number,
  memo?: string,
) {
  let step = 'start';
  try {
    step = 'loadAccount';
    const source = await server.loadAccount(accountPublicKey);
    step = 'payment-op';
    const paymentOp = Operation.payment({
      destination: to,
      asset: USDC,
      amount: amount.toFixed(7),
    });
    step = 'build';
    const builder = new TransactionBuilder(source, { fee: BASE_FEE, networkPassphrase: NETWORK })
      .addOperation(paymentOp)
      .setTimeout(60);
    if (memo) builder.addMemo(Memo.text(memo));
    const inner = builder.build();
    step = 'sign';
    inner.sign(Keypair.fromSecret(signingSecret));
    step = 'submit';
    await feeBumpAndSubmit(inner);
  } catch (e: any) {
    const msg = e?.message ?? String(e);
    console.error(`[send:${step}] MESSAGE >>> ${msg}`);
    throw new Error(`[${step}] ${msg}`);
  }
}

/** P2P send between users. */
export async function send(
  accountPublicKey: string,
  signingSecret: string,
  to: string,
  amount: number,
) {
  await feeBumpedUserPayment(accountPublicKey, signingSecret, to, amount);
}

/** Cash out: user's funds settle back to the treasury. Pass FEE_MEMO as the
 *  memo for internal fee collections so they stay out of the activity feed. */
export async function cashOut(
  accountPublicKey: string,
  signingSecret: string,
  amount: number,
  memo?: string,
) {
  await feeBumpedUserPayment(accountPublicKey, signingSecret, TREASURY_PUBLIC, amount, memo);
}

// --- Custodial controls. The treasury is a signer (weight 2) on every user
//     account, so it satisfies the high threshold and can act alone. In
//     production these keys live server-side behind auth; here they run
//     client-side for the demo. ---

/** Treasury-authored setOptions on a user account (treasury signs alone). */
async function treasurySetOptions(userPublicKey: string, opts: Record<string, unknown>) {
  const treasury = treasuryKp();
  const source = await server.loadAccount(treasury.publicKey());
  const tx = new TransactionBuilder(source, { fee: BASE_FEE, networkPassphrase: NETWORK })
    .addOperation(Operation.setOptions({ source: userPublicKey, ...opts }))
    .setTimeout(60)
    .build();
  tx.sign(treasury);
  await submit(tx);
}

/** Freeze: raise the med threshold so the user can't move funds without us. */
export async function freezeAccount(userPublicKey: string) {
  await treasurySetOptions(userPublicKey, { medThreshold: TREASURY_SIGNER_WEIGHT });
}

/** Unfreeze: restore normal thresholds. */
export async function unfreezeAccount(userPublicKey: string) {
  await treasurySetOptions(userPublicKey, { medThreshold: THRESHOLD_MED });
}

/**
 * Recovery: re-key the account to a new device via the recover-account Edge
 * Function. The treasury acts alone here (no user signature to lean on), so
 * identity comes from `accessToken` — the same Supabase Auth session
 * recoverProfile() already validated (email OTP + recovery PIN) before this
 * is ever called; the function re-derives the target address from that same
 * token server-side rather than trusting `userPublicKey` from the caller.
 */
export async function recoverAccount(accessToken: string, newDevicePublicKey: string) {
  const res = await fetch(`${SUPABASE_URL}/functions/v1/recover-account`, {
    method: 'POST',
    headers: { apikey: ANON_KEY, Authorization: `Bearer ${ANON_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ accessToken, newDevicePublicKey }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data?.error ?? 'Account recovery failed');
}

/**
 * Close the account and reclaim the sponsored reserves back to the treasury,
 * via the close-account Edge Function. The treasury acts alone (no user
 * signature to lean on — that's also what lets it reclaim abandoned "ghost"
 * accounts), so `pin` is the gate: server-verified against the account's own
 * recovery PIN (see verify_recovery_pin in supabase-schema.sql). Omit for an
 * address with no PIN on file — matches the pre-existing ghost-account path.
 */
export async function closeAndReclaim(accountPublicKey: string, pin?: string) {
  const res = await fetch(`${SUPABASE_URL}/functions/v1/close-account`, {
    method: 'POST',
    headers: { apikey: ANON_KEY, Authorization: `Bearer ${ANON_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ address: accountPublicKey, pin }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data?.error ?? 'Account closure failed');
}

/**
 * Live payment stream for an account via Horizon SSE. Calls `onPayment` each
 * time a payment touching the account is confirmed (sent or received), so the
 * UI updates without polling. Returns a function to close the stream.
 *
 * Uses react-native-sse because Hermes has no built-in EventSource. `cursor=now`
 * means only new payments are streamed; the initial state comes from a refresh.
 */
export function streamPayments(accountPublicKey: string, onPayment: () => void): () => void {
  const url = `${HORIZON_URL}/accounts/${accountPublicKey}/payments?cursor=now`;
  const es = new EventSource(url);
  const handler = (event: any) => {
    // Horizon sends keep-alive "hello"/"byebye" frames with no real payload.
    if (!event?.data || event.data === '"hello"' || event.data === '"byebye"') return;
    onPayment();
  };
  es.addEventListener('message', handler);
  return () => {
    es.removeAllEventListeners();
    es.close();
  };
}

/** Recent USDC activity, newest first. Empty until the account is activated.
 *  Includes Earn moves (Soroban transfers to/from the Blend pool) and hides
 *  Remitt's own fee collections (payments memo-tagged FEE_MEMO). */
export async function getActivity(publicKey: string): Promise<ActivityItem[]> {
  let res;
  try {
    res = await server
      .payments()
      .forAccount(publicKey)
      .join('transactions')
      .order('desc')
      .limit(50)
      .call();
  } catch (e: any) {
    if (e?.response?.status === 404 || e?.name === 'NotFoundError') return [];
    throw e;
  }

  const items: ActivityItem[] = [];
  for (const record of res.records as any[]) {
    if (record.type === 'invoke_host_function') {
      // Soroban tx: USDC moved via the Stellar Asset Contract. The only ones
      // we make are Blend pool deposits/withdrawals (Earn).
      for (const [i, change] of (record.asset_balance_changes ?? []).entries()) {
        if (change.type !== 'transfer') continue;
        if (change.asset_code !== USDC_CODE || change.asset_issuer !== USDC_ISSUER) continue;
        const toPool = change.from === publicKey && change.to === BLEND_POOL_ID;
        const fromPool = change.from === BLEND_POOL_ID && change.to === publicKey;
        if (!toPool && !fromPool) continue;
        items.push({
          id: `${record.id}-${i}`,
          kind: toPool ? 'earn-deposit' : 'earn-withdraw',
          amount: parseFloat(change.amount),
          counterparty: BLEND_POOL_ID,
          createdAt: record.created_at,
          txHash: record.transaction_hash,
        });
      }
      continue;
    }
    if (record.type !== 'payment') continue;
    if (record.asset_code !== USDC_CODE || record.asset_issuer !== USDC_ISSUER) continue;
    const outgoing = record.from === publicKey;
    const counterparty = outgoing ? record.to : record.from;
    const isTreasury = counterparty === TREASURY_PUBLIC;
    // With join('transactions') the SDK exposes the embedded tx (incl. memo)
    // as transaction_attr; skip our own fee transfers.
    const memo = record.transaction_attr?.memo ?? record.transaction?.memo;
    if (outgoing && isTreasury && memo === FEE_MEMO) continue;
    items.push({
      id: record.id,
      kind: isTreasury ? (outgoing ? 'cash-out' : 'cash-in') : outgoing ? 'sent' : 'received',
      amount: parseFloat(record.amount),
      counterparty,
      createdAt: record.created_at,
      txHash: record.transaction_hash,
      memo: memo && memo !== FEE_MEMO ? memo : undefined,
    });
  }
  return items;
}
