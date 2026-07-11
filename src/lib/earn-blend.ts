// Earn, backed by the Blend lending protocol (Soroban). Users supply their
// USDC to a Blend pool to earn the pool's supply APY and can withdraw anytime.
// Remitt charges a fee on withdrawal (see WITHDRAW_FEE_RATE), collected by the
// wallet layer after the funds return to the user.
//
// Unlike classic payments, these are Soroban contract calls: build → simulate
// → assemble (adds resource fee + auth) → user signs → treasury fee-bumps
// (so the 0-XLM user pays nothing) → submit via the Soroban RPC.
//
// HERMES SAFETY — this file deliberately avoids two things that break under
// React Native's Hermes runtime (see the same workarounds in stellar.ts):
//   1. The SDK's rpc.Server: it serializes with toXDR('base64'), which Hermes
//      silently mangles (Uint8Array.toString ignores the encoding arg). All
//      RPC calls here go through plain fetch with explicit Buffer base64.
//   2. The Blend SDK (blend-sdk): its spec-based tx encoder throws "no such
//      entry: submit" on Hermes, so the pool `submit` call is hand-encoded and
//      pool state is read directly from ledger entries.
import { Buffer } from 'buffer';
import {
  Account,
  Address,
  BASE_FEE,
  Asset,
  Contract,
  Keypair,
  Networks,
  TransactionBuilder,
  nativeToScVal,
  rpc,
  scValToNative,
  xdr,
} from '@stellar/stellar-sdk';
import { ANON_KEY, SUPABASE_URL } from './directory.ts';
import { HORIZON_URL, USDC_CODE, USDC_ISSUER } from './stellar-config.ts';

const SOROBAN_RPC = 'https://soroban-testnet.stellar.org';
export const POOL_ID = 'CAPBMXIQTICKWFPWFDJWMAKBXBPJZUKLNONQH3MLPLLBKQ643CYN5PRW';
const PASSPHRASE = Networks.TESTNET;

const USDC_SAC = new Asset(USDC_CODE, USDC_ISSUER).contractId(PASSPHRASE);

// Blend request types (the on-chain enum; blend-sdk's RequestType, inlined).
const REQUEST_SUPPLY = 0;
const REQUEST_WITHDRAW = 1;

// Blend v2 fixed-point scalar for b_rate (12 decimals).
const SCALAR_12 = 10n ** 12n;

// Fraction of the withdrawn amount Remitt keeps as a fee. Charged only on
// withdrawal, by the wallet layer, after funds return to the user's account.
export const WITHDRAW_FEE_RATE = 0.005; // 0.5%

// Shown only if the live APY read fails (network error, missing reserve).
// The APY on the Earn screen is otherwise computed live from the pool's
// on-chain interest-rate state — see computeSupplyApy below.
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

// Load the source account (address + sequence number) from HORIZON, not the
// Soroban RPC — Horizon access is already proven to work on-device.
async function loadSourceAccount(accountPublicKey: string): Promise<Account> {
  const res = await fetch(`${HORIZON_URL}/accounts/${accountPublicKey}`);
  if (res.status === 404) {
    throw new Error('Your account has no deposits yet — add cash before using Earn.');
  }
  if (!res.ok) throw new Error(`Could not load your account (Horizon ${res.status}).`);
  const json = await res.json();
  return new Account(accountPublicKey, json.sequence);
}

// --- Pool state reads: direct getLedgerEntries, no blend-sdk. ---

/** base64 LedgerKey for a persistent contract-data entry of the pool. */
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

/** Read a u32-keyed value out of what scValToNative made of a Soroban map. */
function mapGet(m: any, index: number): bigint {
  if (!m) return 0n;
  if (m instanceof Map) return m.get(index) ?? m.get(String(index)) ?? 0n;
  return m[index] ?? m[String(index)] ?? 0n;
}

/** base64 LedgerKey for the pool's contract-instance entry (holds PoolConfig). */
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
  resData: any; // b_rate, d_rate, b_supply, d_supply, ir_mod (Blend v2 ResData)
  resConfig: any; // index, util, r_base..r_three (u32, 7 decimals)
  bstopRate: number; // pool bstop_rate as a float (e.g. 0.5)
}

interface PoolSnapshot extends ReserveState {
  positions: any; // the user's Positions entry, if any
}

/** Pool-wide reserve state only — no user position. This is the same for
 *  every Earn user, so callers that don't need a specific user's balance
 *  (e.g. the pool-rate history cron) should use this instead of
 *  loadPoolSnapshot, which would otherwise fetch a throwaway Positions key. */
async function loadReserveState(): Promise<ReserveState> {
  const keys = [poolDataKey('ResData', USDC_SAC), poolDataKey('ResConfig', USDC_SAC), poolInstanceKey()];
  const result = await rpcCall('getLedgerEntries', { keys });
  const byKey: Record<string, any> = {};
  let bstopRate = 0;
  for (const e of result.entries ?? []) {
    const data = xdr.LedgerEntryData.fromXDR(e.xdr, 'base64').contractData();
    if (e.key === keys[2]) {
      // PoolConfig lives in the contract's instance storage under "Config".
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

/** One getLedgerEntries round trip for everything the Earn screen needs:
 *  pool-wide reserve state plus this user's own position. */
async function loadPoolSnapshot(userPublicKey: string): Promise<PoolSnapshot> {
  const keys = [
    poolDataKey('ResData', USDC_SAC),
    poolDataKey('ResConfig', USDC_SAC),
    poolDataKey('Positions', userPublicKey),
    poolInstanceKey(),
  ];
  const result = await rpcCall('getLedgerEntries', { keys });
  const byKey: Record<string, any> = {};
  let bstopRate = 0;
  for (const e of result.entries ?? []) {
    const data = xdr.LedgerEntryData.fromXDR(e.xdr, 'base64').contractData();
    if (e.key === keys[3]) {
      // PoolConfig lives in the contract's instance storage under "Config".
      for (const entry of data.val().instance().storage() ?? []) {
        if (String(scValToNative(entry.key())) === 'Config') {
          bstopRate = Number(scValToNative(entry.val()).bstop_rate) / 1e7;
        }
      }
    } else {
      byKey[e.key] = scValToNative(data.val());
    }
  }
  return { resData: byKey[keys[0]], resConfig: byKey[keys[1]], positions: byKey[keys[2]], bstopRate };
}

function suppliedFromSnapshot({ resData, resConfig, positions }: PoolSnapshot): number {
  if (!resData || !resConfig || !positions) return 0; // no reserve or no position yet
  const index = Number(resConfig.index);
  const bTokens = mapGet(positions.supply, index) || mapGet(positions.collateral, index);
  if (bTokens <= 0n) return 0;
  // assets = bTokens * b_rate / 1e12 (Blend v2 fixed-point, floor)
  return fromStroops((bTokens * BigInt(resData.b_rate)) / SCALAR_12);
}

/**
 * The pool's live supply APY, from Blend v2's interest-rate model (mirrors
 * blend-sdk's Reserve.setRates, which breaks on Hermes):
 *   util   = totalLiabilities / totalSupply
 *   ir     = piecewise slope of r_base..r_three around target util, x ir_mod
 *   APR    = ir * util * (1 - bstop_rate);  APY = weekly-compounded APR
 * Returns null if the reserve state is unavailable.
 */
function computeSupplyApy({ resData, resConfig, bstopRate }: ReserveState): number | null {
  if (!resData || !resConfig) return null;
  const totalLiabilities = fromStroops((BigInt(resData.d_supply) * BigInt(resData.d_rate)) / SCALAR_12);
  const totalSupply = fromStroops((BigInt(resData.b_supply) * BigInt(resData.b_rate)) / SCALAR_12);
  if (totalSupply <= 0) return 0;
  const util = Math.min(totalLiabilities / totalSupply, 1);
  const irMod = Number(resData.ir_mod) / 1e7; // Blend v2: ir_mod has 7 decimals
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

/** The user's current savings balance (supplied USDC incl. accrued interest). */
export async function getSupplied(userPublicKey: string): Promise<number> {
  return suppliedFromSnapshot(await loadPoolSnapshot(userPublicKey));
}

/** The pool's live supply APY, with no user position involved — for the
 *  pool-rate history job (scripts/record-pool-rate.mjs), which logs one
 *  global time series rather than have every user's device read (and then
 *  redundantly re-log) the same pool-wide number. */
export async function getPoolApy(): Promise<number | null> {
  return computeSupplyApy(await loadReserveState());
}

/** Live supply APY + supplied balance for the Earn screen. */
export async function getEarnState(
  userPublicKey: string,
): Promise<{ apy: number; supplied: number }> {
  const snapshot = await loadPoolSnapshot(userPublicKey);
  return {
    apy: computeSupplyApy(snapshot) ?? FALLBACK_APY,
    supplied: suppliedFromSnapshot(snapshot),
  };
}

// --- Transaction path: build → simulate → assemble → sign → fee-bump → send. ---

/**
 * Ask the `fee-bump` Edge Function to wrap the (already-signed) inner Soroban
 * tx in a treasury fee-bump and submit it via sendTransaction. Same trust
 * model as stellar.ts's feeBumpAndSubmit: the user's Soroban-auth signature
 * on the inner tx is the authorization, so the treasury key only ever needs
 * to add a fee-bump signature — which is why it can live server-side now
 * instead of shipping in the app bundle. See supabase/functions/fee-bump.
 */
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

async function submitRequest(
  accountPublicKey: string,
  signingSecret: string,
  requestType: number,
  amount: number,
) {
  const account = await loadSourceAccount(accountPublicKey);

  // Hand-encoded pool call (Hermes-safe; see header comment):
  //   submit(from: address, spender: address, to: address, requests: vec<Request>)
  //   Request { address: address, amount: i128, request_type: u32 }  (keys alphabetical)
  const user = new Address(accountPublicKey).toScVal();
  const request = xdr.ScVal.scvMap([
    new xdr.ScMapEntry({
      key: xdr.ScVal.scvSymbol('address'),
      val: new Address(USDC_SAC).toScVal(),
    }),
    new xdr.ScMapEntry({
      key: xdr.ScVal.scvSymbol('amount'),
      val: nativeToScVal(toStroops(amount), { type: 'i128' }),
    }),
    new xdr.ScMapEntry({
      key: xdr.ScVal.scvSymbol('request_type'),
      val: xdr.ScVal.scvU32(requestType),
    }),
  ]);
  const op = new Contract(POOL_ID).call('submit', user, user, user, xdr.ScVal.scvVec([request]));

  const built = new TransactionBuilder(account, { fee: BASE_FEE, networkPassphrase: PASSPHRASE })
    .addOperation(op)
    .setTimeout(120)
    .build();

  // Simulate via plain fetch; parse the raw response for assembleTransaction.
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
  if (status !== 'SUCCESS') throw new Error('Blend transaction failed: ' + status);
}

/** Move USDC from the user's wallet into the Blend pool to start earning. */
export async function deposit(accountPublicKey: string, signingSecret: string, amount: number) {
  await submitRequest(accountPublicKey, signingSecret, REQUEST_SUPPLY, amount);
}

/**
 * Withdraw the entire savings balance back to the user's wallet. Returns the
 * amount withdrawn and the fee Remitt should collect on it (the wallet layer
 * performs the fee transfer after this resolves).
 */
export async function withdrawAll(
  accountPublicKey: string,
  signingSecret: string,
): Promise<{ withdrawn: number; fee: number }> {
  const supplied = await getSupplied(accountPublicKey);
  if (supplied <= 0) return { withdrawn: 0, fee: 0 };
  // Over-request; Blend clamps a withdrawal to the user's actual position.
  await submitRequest(accountPublicKey, signingSecret, REQUEST_WITHDRAW, supplied * 1.01);
  return { withdrawn: supplied, fee: supplied * WITHDRAW_FEE_RATE };
}
