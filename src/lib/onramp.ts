// On-ramp (cash-in) client, Phase O2. A cash-in is a two-party dance:
//   1. createCashInIntent — the user commits to "add $M"; the server quotes the
//      exact ₱ to pay (with a unique centavo tag) and opens a `pending` intent.
//   2. The user pays that exact ₱ into the deposit account (coins.ph InstaPay).
//   3. Deposit detection (Phase O3) matches the PHP deposit → the gated
//      deliver-cash-in function (Phase O1) pays USDC and flips the intent to
//      `delivered`. The app watches for that via pollIntent.
//
// No money moves from the client here — the treasury key is NOT in the app
// anymore (delivery is server-side). This module only creates the intent row
// and reads its status. Talks to Supabase directly, like directory.ts/requests.ts.
import { ANON_KEY, SUPABASE_URL, directoryEnabled } from './directory';

/** Approximate ₱/$ for the live entry-screen preview ONLY. The authoritative,
 *  exact amount (with the unique centavo tag) comes back from create-intent —
 *  never charge off this. Keep roughly in sync with the fn's PHP_PER_USD. */
export const APPROX_PHP_PER_USD = 58.5;

const rest = (path: string) => `${SUPABASE_URL}/rest/v1/${path}`;
const headers = {
  apikey: ANON_KEY,
  Authorization: `Bearer ${ANON_KEY}`,
  'Content-Type': 'application/json',
};

export type IntentStatus = 'pending' | 'matched' | 'delivered' | 'expired' | 'failed';

export interface CashInIntent {
  id: string;
  address: string;
  amountUsdc: number;
  amountPhp: number;
  status: IntentStatus;
  expiresAt: string;
  /** Where to send the pesos — shown to the user verbatim. */
  deposit: { label: string; account: string };
}

/** Open a cash-in intent for `amountUsdc`. Returns the ₱ quote + deposit target
 *  the user must pay to. Creating an intent moves no money; delivery is gated
 *  server-side (see supabase/functions/deliver-cash-in). */
export async function createCashInIntent(address: string, amountUsdc: number): Promise<CashInIntent> {
  if (!directoryEnabled) throw new Error('Deposits are not available right now.');
  const res = await fetch(`${SUPABASE_URL}/functions/v1/create-intent`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ address, amountUsdc }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body?.error ?? `Could not start deposit (${res.status})`);
  return body as CashInIntent;
}

/** Current status of an intent (poll target). Cheap read of the one row. */
export async function getIntentStatus(id: string): Promise<IntentStatus | null> {
  if (!directoryEnabled) return null;
  try {
    const res = await fetch(rest(`cash_in_intents?id=eq.${encodeURIComponent(id)}&select=status`), { headers });
    if (!res.ok) return null;
    const rows = await res.json();
    return (rows?.[0]?.status as IntentStatus) ?? null;
  } catch {
    return null;
  }
}

/** Poll an intent until it leaves `pending`/`matched` (delivered/expired/failed)
 *  or `timeoutMs` elapses. Resolves with the terminal status, or the last seen
 *  status on timeout. Cancel via the returned stop() if the screen unmounts. */
export function watchIntent(
  id: string,
  onStatus: (s: IntentStatus) => void,
  opts: { intervalMs?: number } = {},
): () => void {
  const interval = opts.intervalMs ?? 4000;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const tick = async () => {
    if (stopped) return;
    const s = await getIntentStatus(id);
    if (stopped) return;
    if (s) {
      onStatus(s);
      if (s === 'delivered' || s === 'expired' || s === 'failed') return; // terminal
    }
    timer = setTimeout(tick, interval);
  };
  tick();

  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
}
