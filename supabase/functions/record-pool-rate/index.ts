// Supabase Edge Function: the single writer of the Blend pool's current
// supply APY (blend_pool_rates). Meant to run on a schedule (see the pg_cron
// + pg_net block at the bottom of ../../../scripts/supabase-schema.sql), not
// to be called by the app — the pool's rate is identical for every Earn
// user, so one scheduled reader beats every client independently hitting the
// Soroban RPC for the same number (see earn-blend.ts's getCachedPoolApy,
// which reads this table, and getPoolApy, which this mirrors — no Hermes
// workarounds needed here since Edge Functions run on Deno, not React
// Native).
//
// Only the latest rate is ever read (getCachedPoolApy), so this always
// upserts the same fixed row id instead of inserting a new row every run —
// otherwise the table grows forever for a number nothing reads historically.
//
// Deploy (from packages/app):
//   npx supabase login
//   npx supabase link --project-ref ggapuomnnocuumwrgfnt
//   npx supabase functions deploy record-pool-rate
//
// Manual test after deploy:
//   curl -X POST https://ggapuomnnocuumwrgfnt.supabase.co/functions/v1/record-pool-rate \
//     -H "Authorization: Bearer <anon-or-service-role-key>"
import { Address, Asset, xdr, scValToNative } from 'npm:@stellar/stellar-sdk@^16';
import { BLEND_POOL_ID, NETWORK_PASSPHRASE, USDC_ISSUER, SOROBAN_RPC } from '../_shared/network-config.ts';

const POOL_ID = BLEND_POOL_ID;
const USDC_SAC = new Asset('USDC', USDC_ISSUER).contractId(NETWORK_PASSPHRASE);

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
// Service role, not anon — this write should not depend on the demo-grade
// anon insert policy on blend_pool_rates; Edge Functions get this injected
// automatically, it's never shipped to the client.
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

// Fixed so every run updates the same row instead of inserting a new one.
const SINGLETON_ID = '00000000-0000-0000-0000-000000000001';

function b64(x: { toXDR(): Buffer | Uint8Array }): string {
  return btoa(String.fromCharCode(...new Uint8Array(x.toXDR())));
}

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

const fromStroops = (s: bigint) => Number(s) / 1e7;

/**
 * Mirrors earn-blend.ts's computeSupplyApy: Blend v2's interest-rate model.
 *   util = totalLiabilities / totalSupply
 *   ir   = piecewise slope of r_base..r_three around target util, x ir_mod
 *   APR  = ir * util * (1 - bstop_rate); APY = weekly-compounded APR
 */
function computeSupplyApy(resData: any, resConfig: any, bstopRate: number): number | null {
  if (!resData || !resConfig) return null;
  const SCALAR_12 = 10n ** 12n;
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

async function getPoolApy(): Promise<number | null> {
  const keys = [poolDataKey('ResData', USDC_SAC), poolDataKey('ResConfig', USDC_SAC), poolInstanceKey()];
  const res = await fetch(SOROBAN_RPC, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getLedgerEntries', params: { keys } }),
  });
  const json = await res.json();
  if (json.error) throw new Error(`getLedgerEntries: ${json.error.message ?? JSON.stringify(json.error)}`);

  const byKey: Record<string, any> = {};
  let bstopRate = 0;
  for (const e of json.result.entries ?? []) {
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
  return computeSupplyApy(byKey[keys[0]], byKey[keys[1]], bstopRate);
}

Deno.serve(async () => {
  try {
    const apy = await getPoolApy();
    if (apy === null) {
      return new Response(JSON.stringify({ error: 'reserve state unavailable' }), { status: 502 });
    }
    const upsert = await fetch(`${SUPABASE_URL}/rest/v1/blend_pool_rates?on_conflict=id`, {
      method: 'POST',
      headers: {
        apikey: SERVICE_ROLE_KEY,
        Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
        'Content-Type': 'application/json',
        Prefer: 'resolution=merge-duplicates,return=minimal',
      },
      body: JSON.stringify({ id: SINGLETON_ID, apy, created_at: new Date().toISOString() }),
    });
    if (!upsert.ok) {
      return new Response(JSON.stringify({ error: `upsert failed: ${await upsert.text()}` }), { status: 502 });
    }

    // Self-heal: drop any stray rows from before this went singleton (or any
    // that somehow slip in), so exactly one row ever exists.
    const cleanup = await fetch(`${SUPABASE_URL}/rest/v1/blend_pool_rates?id=neq.${SINGLETON_ID}`, {
      method: 'DELETE',
      headers: {
        apikey: SERVICE_ROLE_KEY,
        Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
        Prefer: 'return=minimal',
      },
    });
    if (!cleanup.ok) {
      return new Response(JSON.stringify({ error: `cleanup failed: ${await cleanup.text()}` }), { status: 502 });
    }

    return new Response(JSON.stringify({ apy }), { status: 200 });
  } catch (e) {
    return new Response(JSON.stringify({ error: String(e) }), { status: 500 });
  }
});
