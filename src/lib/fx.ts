// Localized currency display for USDC balances. Same single-writer/
// many-readers shape as earn-ledger's getPoolRates for the Blend pool's APY:
// ONE scheduled Edge Function (supabase/functions/record-fx-rates, via
// pg_cron every 6h) fetches the external FX API and writes one snapshot row;
// every device just reads the latest row here instead of each user's app
// hitting the external FX API itself for the same numbers.
import { ANON_KEY, SUPABASE_URL, directoryEnabled } from './directory';

const rest = (path: string) => `${SUPABASE_URL}/rest/v1/${path}`;
const headers = { apikey: ANON_KEY, Authorization: `Bearer ${ANON_KEY}` };
const TABLE = 'fx_rates';

// ISO 3166-1 alpha-2 country -> ISO 4217 currency. Only needs entries for
// countries Remitt actually shows a local amount for; anything unmapped (or
// mapped to USD) means "no conversion to show" rather than a guess.
const COUNTRY_CURRENCY: Record<string, string> = {
  PH: 'PHP',
};

/** The local currency to show for `country` (ISO alpha-2), or null if there's
 *  none worth converting to (unmapped, or the country's currency is USD). */
export function currencyForCountry(country?: string | null): string | null {
  if (!country) return null;
  const code = COUNTRY_CURRENCY[country.toUpperCase()];
  return code && code !== 'USD' ? code : null;
}

/** Latest units-of-`currency`-per-1-USD rate from the shared snapshot, or
 *  null if unavailable (no rows yet, network hiccup, or the currency isn't
 *  in the snapshot). */
export async function getFxRate(currency: string): Promise<number | null> {
  if (!directoryEnabled) return null;
  try {
    const res = await fetch(rest(`${TABLE}?select=rates&order=created_at.desc&limit=1`), { headers });
    if (!res.ok) return null;
    const rows: { rates: Record<string, number> }[] = await res.json();
    const rate = rows[0]?.rates?.[currency];
    return typeof rate === 'number' ? rate : null;
  } catch {
    return null;
  }
}

/** `usdAmount` converted at `rate` and formatted in `currency` (e.g. "₱7,208.24").
 *  Falls back to a plain "CODE 1234.56" if the runtime can't format that
 *  currency (toLocaleString + style:'currency' is already used app-wide for
 *  USD via theme.ts's formatUsd, so this reuses the same approach). */
export function formatLocal(usdAmount: number, currency: string, rate: number): string {
  const value = usdAmount * rate;
  try {
    return value.toLocaleString('en-US', { style: 'currency', currency });
  } catch {
    return `${currency} ${value.toFixed(2)}`;
  }
}
