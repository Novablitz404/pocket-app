// Earn, backed by the Pocket Earn vault (Soroban). Users deposit USDC into
// Pocket's own pooled vault contract (VAULT_ID) rather than calling Blend
// directly; the vault makes ONE aggregate Blend supply on everyone's behalf
// and charges 12% of yield via dilutive fee-shares minted to the Treasury
// (the vault's fee_recipient). There is NO separate withdrawal fee anymore —
// Pocket's cut is invisible share-price dilution baked into the vault, so
// `withdraw` returns just the amount paid out.
//
// Unlike classic payments, these are Soroban contract calls: build → simulate
// → assemble (adds resource fee + auth) → user signs → treasury fee-bumps
// (so the 0-XLM user pays nothing) → submit via the Soroban RPC.
//
// HERMES SAFETY — same two workarounds as earn-blend.ts / stellar.ts:
//   1. No SDK rpc.Server: all RPC via plain fetch with explicit Buffer base64
//      (Hermes mangles toXDR('base64')).
//   2. Contract calls are hand-encoded (no blend-sdk / no generated client) —
//      pool reserve state is read straight from ledger entries; vault balances
//      are read by simulating the vault's own view functions.
import { Buffer } from 'buffer';
import {
  Account,
  Address,
  BASE_FEE,
  Contract,
  Keypair,
  TransactionBuilder,
  nativeToScVal,
  rpc,
  scValToNative,
  xdr,
} from '@stellar/stellar-sdk';
import { ANON_KEY, SUPABASE_URL } from './directory.ts';
import { BLEND_POOL_ID, HORIZON_URL, NETWORK_PASSPHRASE, USDC_CODE, USDC_ISSUER, VAULT_ID } from './stellar-config.ts';

// Two RPC URLs (not one) so testnet keeps working while a mainnet build
// exists side by side. Which one applies follows NETWORK_PASSPHRASE — i.e.
// whichever network stellar-config.ts was last generated for — rather than a
// second, separately-set env flag that could drift out of sync with it.
const IS_MAINNET = (NETWORK_PASSPHRASE as string) === 'Public Global Stellar Network ; September 2015';
const SOROBAN_RPC =
  (IS_MAINNET ? process.env.EXPO_PUBLIC_SOROBAN_RPC_URL_MAINNET : process.env.EXPO_PUBLIC_SOROBAN_RPC_URL_TESTNET) ??
  (IS_MAINNET ? 'https://soroban-rpc.stellar.org' : 'https://soroban-testnet.stellar.org');
export const POOL_ID = BLEND_POOL_ID; // for APY reads (the vault supplies here)
export { VAULT_ID };
const PASSPHRASE = NETWORK_PASSPHRASE;

// The USDC reserve inside the pool is keyed by its SAC address (same as the
// vault's own on-chain USDC_SAC). Used only for the pool-wide APY reads.
import { Asset } from '@stellar/stellar-sdk';
const USDC_SAC = new Asset(USDC_CODE, USDC_ISSUER).contractId(PASSPHRASE);

// Blend v2 fixed-point scalar for b_rate (12 decimals).
const SCALAR_12 = 10n ** 12n;

// Pocket keeps 12% of the yield (matches the vault's fee_bps = 1200). The Earn
// screen shows NET APY — gross pool APY × (1 - this) — so users see what they
// actually earn after Pocket's cut.
export const POCKET_YIELD_FEE = 0.12;

// Shown only if the live APY read fails (network error, missing reserve).
export const FALLBACK_APY = 0.06;

const toStroops = (n: number) => BigInt(Math.round(n * 1e7));
const fromStroops = (s: bigint) => Number(s) / 1e7;

/** Plain-fetch JSON-RPC call (Hermes-safe; no SDK serialization involved). */
async function rpcCall<T = any>(method: string, params: Record<string, unknown>): Promise<T> {
  const res = await fetch(SOROBAN_RPC, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const json = await res.json();
  if (json.error) throw new Error(`${method}: ${json.error.message ?? JSON.stringify(json.error)}`);
  return json.result;
}

/** Explicit base64 for any XDR object — never rely on toXDR('base64'). */
const b64 = (x: { toXDR(): Buffer | Uint8Array }) => Buffer.from(x.toXDR()).toString('base64');

// Load the source account (address + sequence) from HORIZON, not the Soroban
// RPC — Horizon access is already proven to work on-device.
async function loadSourceAccount(accountPublicKey: string): Promise<Account> {
  const res = await fetch(`${HORIZON_URL}/accounts/${accountPublicKey}`);
  if (res.status === 404) {
    throw new Error('Your account is not set up yet.');
  }
  if (!res.ok) throw new Error(`Could not load your account (Horizon ${res.status}).`);
  const json = await res.json();
  return new Account(accountPublicKey, json.sequence);
}

// --- Pool-wide APY: direct getLedgerEntries against the Blend pool (unchanged
//     from earn-blend.ts — the vault supplies into this same pool, so the
//     GROSS supply APY is still the pool's; the net-of-fee haircut is applied
//     at display time). ---

function poolDataKey(sym: string, addr: string): string {
  return b64(
    xdr.LedgerKey.contractData(
      new xdr.LedgerKeyContractData({
        contract: new Address(POOL_ID).toScAddress(),
        key: xdr.ScVal.scvVec([xdr.ScVal.scvSymbol(sym), new Address(addr).toScVal()]),
        durability: xdr.ContractDataDurability.persistent(),
      }),
    ),
  );
}

function poolInstanceKey(): string {
  return b64(
    xdr.LedgerKey.contractData(
      new xdr.LedgerKeyContractData({
        contract: new Address(POOL_ID).toScAddress(),
        key: xdr.ScVal.scvLedgerKeyContractInstance(),
        durability: xdr.ContractDataDurability.persistent(),
      }),
    ),
  );
}

interface ReserveState {
  resData: any;
  resConfig: any;
  bstopRate: number;
}

async function loadReserveState(): Promise<ReserveState> {
  const keys = [poolDataKey('ResData', USDC_SAC), poolDataKey('ResConfig', USDC_SAC), poolInstanceKey()];
  const result = await rpcCall('getLedgerEntries', { keys });
  const byKey: Record<string, any> = {};
  let bstopRate = 0;
  for (const e of result.entries ?? []) {
    const data = xdr.LedgerEntryData.fromXDR(e.xdr, 'base64').contractData();
    if (e.key === keys[2]) {
      for (const entry of data.val().instance().storage() ?? []) {
        if (String(scValToNative(entry.key())) === 'Config') {
          bstopRate = Number(scValToNative(entry.val()).bstop_rate) / 1e7;
        }
      }
    } else {
      byKey[e.key] = scValToNative(data.val());
    }
  }
  return { resData: byKey[keys[0]], resConfig: byKey[keys[1]], bstopRate };
}

/**
 * The pool's live GROSS supply APY, from Blend v2's interest-rate model
 * (mirrors blend-sdk's Reserve.setRates, which breaks on Hermes):
 *   util = totalLiabilities / totalSupply
 *   ir   = piecewise slope of r_base..r_three around target util, x ir_mod
 *   APR  = ir * util * (1 - bstop_rate);  APY = weekly-compounded APR
 */
function computeSupplyApy({ resData, resConfig, bstopRate }: ReserveState): number | null {
  if (!resData || !resConfig) return null;
  const totalLiabilities = fromStroops((BigInt(resData.d_supply) * BigInt(resData.d_rate)) / SCALAR_12);
  const totalSupply = fromStroops((BigInt(resData.b_supply) * BigInt(resData.b_rate)) / SCALAR_12);
  if (totalSupply <= 0) return 0;
  const util = Math.min(totalLiabilities / totalSupply, 1);
  const irMod = Number(resData.ir_mod) / 1e7;
  const target = Number(resConfig.util) / 1e7;
  const rBase = Number(resConfig.r_base) / 1e7;
  const rOne = Number(resConfig.r_one) / 1e7;
  const rTwo = Number(resConfig.r_two) / 1e7;
  const rThree = Number(resConfig.r_three) / 1e7;

  let ir: number;
  if (util <= target) {
    ir = irMod * (rBase + (target > 0 ? util / target : 0) * rOne);
  } else if (util <= 0.95) {
    ir = irMod * (rBase + rOne + ((util - target) / (0.95 - target)) * rTwo);
  } else {
    ir = irMod * (rBase + rOne + rTwo) + ((util - 0.95) / 0.05) * rThree;
  }
  const supplyApr = ir * util * (1 - bstopRate);
  return (1 + supplyApr / 52) ** 52 - 1;
}

/** Apply Pocket's yield fee to a gross pool APY -> the net APY users earn. */
const toNetApy = (grossApy: number) => grossApy * (1 - POCKET_YIELD_FEE);

/** The pool's live GROSS supply APY (no user position). Used by the
 *  record-pool-rate scripts that write blend_pool_rates; app UI should use
 *  getEarnState (net) instead. */
export async function getPoolApy(): Promise<number | null> {
  return computeSupplyApy(await loadReserveState());
}

/** The pool's cached GROSS supply APY from the shared snapshot (written every
 *  15 min by the record-pool-rate cron) — a cheap Supabase read instead of
 *  every device hitting Soroban RPC for the same number. */
export async function getCachedPoolApy(): Promise<number | null> {
  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/blend_pool_rates?select=apy&limit=1`, {
      headers: { apikey: ANON_KEY, Authorization: `Bearer ${ANON_KEY}` },
    });
    if (!res.ok) return null;
    const rows: { apy: number | string }[] = await res.json();
    const apy = rows[0]?.apy;
    return apy != null ? Number(apy) : null;
  } catch {
    return null;
  }
}

// --- Vault balance reads: simulate the vault's own view functions. This is
//     guaranteed to match the contract exactly (it does the cross-contract
//     Blend read internally) rather than re-encoding the vault's storage
//     layout client-side. ---

/** Read-only simulate of a contract view, returning its native value. `source`
 *  just needs to be an existing account to build the tx; nothing is charged
 *  or submitted. */
async function simulateView(contractId: string, source: string, fnName: string, args: xdr.ScVal[]): Promise<any> {
  const account = await loadSourceAccount(source);
  const op = new Contract(contractId).call(fnName, ...args);
  const built = new TransactionBuilder(account, { fee: BASE_FEE, networkPassphrase: PASSPHRASE })
    .addOperation(op)
    .setTimeout(60)
    .build();
  const rawSim = await rpcCall('simulateTransaction', { transaction: b64(built.toEnvelope()) });
  const sim = rpc.parseRawSimulation(rawSim);
  if (rpc.Api.isSimulationError(sim)) throw new Error(sim.error);
  const retval = sim.result?.retval;
  if (!retval) return null;
  return scValToNative(retval);
}

const asBigInt = (v: any): bigint => (typeof v === 'bigint' ? v : BigInt(v ?? 0));

/** The user's current savings balance (their vault shares valued in USDC,
 *  including accrued yield, net of Pocket's already-diluted fee). */
export async function getSupplied(userPublicKey: string): Promise<number> {
  const value = await simulateView(VAULT_ID, userPublicKey, 'value_of', [new Address(userPublicKey).toScVal()]);
  return fromStroops(asBigInt(value));
}

/** The user's raw vault share count (needed to size partial withdrawals). */
async function getShares(userPublicKey: string): Promise<bigint> {
  return asBigInt(await simulateView(VAULT_ID, userPublicKey, 'balance_of', [new Address(userPublicKey).toScVal()]));
}

/** NET supply APY (after Pocket's 12% yield cut) + the user's supplied
 *  balance, for the Earn screen. */
export async function getEarnState(userPublicKey: string): Promise<{ apy: number; supplied: number }> {
  const [cachedApy, supplied] = await Promise.all([getCachedPoolApy(), getSupplied(userPublicKey)]);
  let gross = cachedApy;
  if (gross == null) gross = await getPoolApy();
  return { apy: toNetApy(gross ?? FALLBACK_APY), supplied };
}

// --- Transaction path: build → simulate → assemble → sign → fee-bump → send. ---

async function feeBumpAndSend(inner: any): Promise<{ hash: string; status: string }> {
  const res = await fetch(`${SUPABASE_URL}/functions/v1/fee-bump`, {
    method: 'POST',
    headers: { apikey: ANON_KEY, Authorization: `Bearer ${ANON_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ innerXdr: b64(inner.toEnvelope()), target: 'soroban' }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data?.error ?? 'Fee-bump submission failed');
  return data;
}

/**
 * Sim→execution footprint race (same one earn-blend.ts works around): Blend
 * skips its EmisData write when no ledger time has passed since the pool's
 * last interaction, so a simulation in that same ledger yields a footprint
 * WITHOUT the EmisData key — then the tx executes a ledger later where the
 * write IS needed and traps. A single retry with a fresh simulation succeeds.
 */
async function invokeEarn(
  contractId: string,
  accountPublicKey: string,
  signingSecret: string,
  fnName: string,
  args: xdr.ScVal[],
) {
  try {
    return await invokeEarnOnce(contractId, accountPublicKey, signingSecret, fnName, args);
  } catch (e: any) {
    if (!String(e?.message ?? '').startsWith('Earn transaction failed')) throw e;
    await new Promise((r) => setTimeout(r, 7000));
    return await invokeEarnOnce(contractId, accountPublicKey, signingSecret, fnName, args);
  }
}

async function invokeEarnOnce(
  contractId: string,
  accountPublicKey: string,
  signingSecret: string,
  fnName: string,
  args: xdr.ScVal[],
) {
  const account = await loadSourceAccount(accountPublicKey);
  const op = new Contract(contractId).call(fnName, ...args);

  const built = new TransactionBuilder(account, { fee: BASE_FEE, networkPassphrase: PASSPHRASE })
    .addOperation(op)
    .setTimeout(120)
    .build();

  const rawSim = await rpcCall('simulateTransaction', { transaction: b64(built.toEnvelope()) });
  if (rawSim.error) throw new Error('Simulation failed: ' + rawSim.error);
  const sim = rpc.parseRawSimulation(rawSim);
  if (rpc.Api.isSimulationError(sim)) throw new Error(sim.error);
  const inner = rpc.assembleTransaction(built, sim).build();
  inner.sign(Keypair.fromSecret(signingSecret)); // from == source, covers Soroban auth

  const sent = await feeBumpAndSend(inner);

  let status = 'NOT_FOUND';
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 1500));
    const get = await rpcCall('getTransaction', { hash: sent.hash });
    status = get.status;
    if (status !== 'NOT_FOUND') break;
  }
  if (status !== 'SUCCESS') throw new Error('Earn transaction failed: ' + status);
}

const i128 = (v: bigint) => nativeToScVal(v, { type: 'i128' });
const addr = (a: string) => new Address(a).toScVal();

/** Deposit USDC from the user's wallet into the Pocket vault to start earning. */
export async function deposit(accountPublicKey: string, signingSecret: string, amount: number) {
  await invokeEarn(VAULT_ID, accountPublicKey, signingSecret, 'deposit', [addr(accountPublicKey), i128(toStroops(amount))]);
}

/**
 * Withdraw `amount` USDC of savings back to the user's wallet. The vault
 * operates on exact shares, so we size the burn proportionally from the
 * user's live position (`shares × amount / supplied`), flooring — a tiny
 * rounding shortfall lands with the user, never the vault. If the request is
 * for essentially the whole balance, route to `withdrawAll` to avoid leaving
 * dust shares behind. There is no separate fee (Pocket's cut is already
 * diluted into the share price), so this returns just the amount withdrawn.
 */
export async function withdraw(
  accountPublicKey: string,
  signingSecret: string,
  amount: number,
): Promise<{ withdrawn: number }> {
  const supplied = await getSupplied(accountPublicKey);
  if (supplied <= 0) return { withdrawn: 0 };
  if (amount >= supplied - 1e-7) {
    return withdrawAll(accountPublicKey, signingSecret);
  }
  const shares = await getShares(accountPublicKey);
  const burn = (shares * toStroops(amount)) / toStroops(supplied);
  if (burn <= 0n) return { withdrawn: 0 };
  await invokeEarn(VAULT_ID, accountPublicKey, signingSecret, 'withdraw', [addr(accountPublicKey), i128(burn)]);
  return { withdrawn: amount };
}

/** Withdraw the entire savings balance back to the user's wallet. */
export async function withdrawAll(
  accountPublicKey: string,
  signingSecret: string,
): Promise<{ withdrawn: number }> {
  const supplied = await getSupplied(accountPublicKey);
  if (supplied <= 0) return { withdrawn: 0 };
  await invokeEarn(VAULT_ID, accountPublicKey, signingSecret, 'withdraw_all', [addr(accountPublicKey)]);
  return { withdrawn: supplied };
}
