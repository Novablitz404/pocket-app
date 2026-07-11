// Net-deposit ledger for Earn, backed by Supabase (PostgREST) like
// directory.ts. Records how much principal each address has moved into the
// Blend pool so the app can show earnings: since interest is the only thing
// that changes a Blend position's value,
//   earned = suppliedNow (on-chain) - netDeposited (this ledger)
//
// Uses the same env vars as the directory (EXPO_PUBLIC_SUPABASE_URL /
// EXPO_PUBLIC_SUPABASE_ANON_KEY). Run once in the Supabase SQL editor:
//
//   create table if not exists earn_positions (
//     address text primary key,
//     net_deposited numeric not null default 0,
//     updated_at timestamptz not null default now()
//   );
//   alter table earn_positions enable row level security;
//   create policy "earn_positions anon access" on earn_positions
//     for all using (true) with check (true);
const SUPABASE_URL = process.env.EXPO_PUBLIC_SUPABASE_URL ?? '';
const ANON_KEY = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY ?? '';
export const earnLedgerEnabled = Boolean(SUPABASE_URL && ANON_KEY);

const TABLE = 'earn_positions';
const rest = (path: string) => `${SUPABASE_URL}/rest/v1/${path}`;
const headers = {
  apikey: ANON_KEY,
  Authorization: `Bearer ${ANON_KEY}`,
  'Content-Type': 'application/json',
};

/** Net principal this address has in Earn, or null if unknown (ledger
 *  disabled / request failed) — the UI hides the earned line on null. */
export async function getNetDeposited(address: string): Promise<number | null> {
  if (!earnLedgerEnabled) return null;
  try {
    const res = await fetch(
      rest(`${TABLE}?address=eq.${encodeURIComponent(address)}&select=net_deposited&limit=1`),
      { headers },
    );
    if (!res.ok) return null;
    const rows: { net_deposited: number | string }[] = await res.json();
    return rows.length ? Number(rows[0].net_deposited) : 0;
  } catch {
    return null;
  }
}

async function setNetDeposited(address: string, netDeposited: number): Promise<void> {
  await fetch(rest(TABLE), {
    method: 'POST',
    headers: { ...headers, Prefer: 'resolution=merge-duplicates' },
    body: JSON.stringify({
      address,
      net_deposited: netDeposited,
      updated_at: new Date().toISOString(),
    }),
  });
}

/** Add a confirmed deposit to the address's net principal. */
export async function recordDeposit(address: string, amount: number): Promise<void> {
  if (!earnLedgerEnabled) return;
  try {
    const current = (await getNetDeposited(address)) ?? 0;
    await setNetDeposited(address, current + amount);
  } catch {
    // Best-effort: the earned display degrades, the wallet still works.
  }
}

/** Zero the net principal after a full withdrawal (withdrawAll empties the
 *  on-chain position). */
export async function resetDeposits(address: string): Promise<void> {
  if (!earnLedgerEnabled) return;
  try {
    await setNetDeposited(address, 0);
  } catch {
    // Best-effort, same as above.
  }
}

const SNAPSHOT_TABLE = 'earn_snapshots';
const SNAPSHOT_MIN_INTERVAL_MS = 15 * 60 * 1000;
const POOL_RATE_TABLE = 'blend_pool_rates';

export interface EarnSnapshot {
  supplied: number;
  netDeposited: number;
  earned: number;
  createdAt: string;
}

/** Record a (supplied, net_deposited) point for the growth chart, but only if
 *  the last one is stale — the Earn screen calls this on every focus, and
 *  without a cooldown that would spam a point per app-open instead of a
 *  meaningful history. Skips entirely once supplied is 0 (nothing to chart).
 *  Deliberately per-user, unlike the pool's APY (see getPoolRates) — only
 *  this device knows this user's own balance. */
export async function maybeRecordSnapshot(
  address: string,
  supplied: number,
  netDeposited: number,
): Promise<void> {
  if (!earnLedgerEnabled || supplied <= 0) return;
  try {
    const res = await fetch(
      rest(`${SNAPSHOT_TABLE}?address=eq.${encodeURIComponent(address)}&select=created_at&order=created_at.desc&limit=1`),
      { headers },
    );
    if (res.ok) {
      const rows: { created_at: string }[] = await res.json();
      if (rows.length && Date.now() - new Date(rows[0].created_at).getTime() < SNAPSHOT_MIN_INTERVAL_MS) {
        return;
      }
    }
    await fetch(rest(SNAPSHOT_TABLE), {
      method: 'POST',
      headers,
      body: JSON.stringify({ address, supplied, net_deposited: netDeposited }),
    });
  } catch {
    // Best-effort: the chart just has one less point.
  }
}

/** Growth history for the Earn chart, oldest first. */
export async function getSnapshots(address: string): Promise<EarnSnapshot[]> {
  if (!earnLedgerEnabled) return [];
  try {
    const res = await fetch(
      rest(`${SNAPSHOT_TABLE}?address=eq.${encodeURIComponent(address)}&select=supplied,net_deposited,created_at&order=created_at.asc&limit=500`),
      { headers },
    );
    if (!res.ok) return [];
    const rows: { supplied: number | string; net_deposited: number | string; created_at: string }[] =
      await res.json();
    return rows.map((r) => ({
      supplied: Number(r.supplied),
      netDeposited: Number(r.net_deposited),
      earned: Math.max(0, Number(r.supplied) - Number(r.net_deposited)),
      createdAt: r.created_at,
    }));
  } catch {
    return [];
  }
}

export interface PoolRate {
  apy: number;
  createdAt: string;
}

/** The pool's supply-APY history, one global time series (not per-user).
 *  Written only by scripts/record-pool-rate.mjs on a schedule — this is a
 *  read-only accessor for the chart, not something the app itself writes to. */
export async function getPoolRates(): Promise<PoolRate[]> {
  if (!earnLedgerEnabled) return [];
  try {
    const res = await fetch(
      rest(`${POOL_RATE_TABLE}?select=apy,created_at&order=created_at.asc&limit=2000`),
      { headers },
    );
    if (!res.ok) return [];
    const rows: { apy: number | string; created_at: string }[] = await res.json();
    return rows.map((r) => ({ apy: Number(r.apy), createdAt: r.created_at }));
  } catch {
    return [];
  }
}
