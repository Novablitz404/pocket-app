// Logs one point of the Blend pool's supply APY into blend_pool_rates.
//
// SUPERSEDED for scheduled/production use by the Supabase Edge Function at
// supabase/functions/record-pool-rate (deployed + scheduled via pg_cron —
// see the bottom of supabase-schema.sql), which needs no external machine to
// stay running. Keep this script around for local testing and for seeding
// history manually before that function is deployed.
//
// Either way, only ONE thing should be writing this table — the pool's rate
// is identical for every Earn user, so N users' devices independently
// reading the same Soroban reserve state and writing N near-duplicate rows
// is exactly what this design avoids (see earn_snapshots, which stays
// per-user because balances actually differ per user).
//
// Run: node scripts/record-pool-rate.mjs
import { readFileSync } from 'node:fs';
import { getPoolApy } from '../src/lib/earn-blend.ts';

const env = Object.fromEntries(
  readFileSync(new URL('../.env', import.meta.url), 'utf8')
    .split('\n')
    .filter((l) => l.includes('=') && !l.trimStart().startsWith('#'))
    .map((l) => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()]),
);
const SUPABASE_URL = env.EXPO_PUBLIC_SUPABASE_URL;
const ANON_KEY = env.EXPO_PUBLIC_SUPABASE_ANON_KEY;
if (!SUPABASE_URL || !ANON_KEY) {
  console.error('EXPO_PUBLIC_SUPABASE_URL / EXPO_PUBLIC_SUPABASE_ANON_KEY missing from .env');
  process.exit(1);
}

const apy = await getPoolApy();
if (apy === null) {
  console.error('Could not read pool reserve state (no ResData/ResConfig yet?)');
  process.exit(1);
}

const res = await fetch(`${SUPABASE_URL}/rest/v1/blend_pool_rates`, {
  method: 'POST',
  headers: { apikey: ANON_KEY, Authorization: `Bearer ${ANON_KEY}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ apy }),
});
if (!res.ok) throw new Error(`Supabase ${res.status}: ${await res.text()}`);
console.log(`Logged pool APY: ${(apy * 100).toFixed(3)}%`);
