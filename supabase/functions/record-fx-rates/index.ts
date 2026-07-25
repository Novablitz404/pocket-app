// Supabase Edge Function: the single writer of the FX-rate snapshot
// (fx_rates). Meant to run on a schedule (see the pg_cron + pg_net block at
// the bottom of ../../../scripts/supabase-schema.sql), not to be called by
// the app — FX rates are identical for every user (unlike a per-user
// balance), so one scheduled fetch beats every client independently hitting
// the external FX API for the same numbers.
//
// Unlike record-pool-rate (which keeps a history for the Earn chart),
// fx_rates only ever needs the latest snapshot, so this always upserts the
// same fixed row id instead of inserting a new row every run — otherwise the
// table would grow forever for data nothing reads historically.
//
// Source: open.er-api.com — free, no API key, no signup. Rates move slowly
// compared to Blend's APY, so this is scheduled every 6 hours, not 15 min.
//
// Deploy (from packages/app):
//   npx supabase functions deploy record-fx-rates
//
// Manual test after deploy:
//   curl -X POST https://ggapuomnnocuumwrgfnt.supabase.co/functions/v1/record-fx-rates \
//     -H "Authorization: Bearer <anon-or-service-role-key>"
const FX_API_URL = 'https://open.er-api.com/v6/latest/USD';

// Fixed so every run updates the same row instead of inserting a new one.
const SINGLETON_ID = '00000000-0000-0000-0000-000000000001';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
// Service role, not anon — this write should not depend on the demo-grade
// anon insert policy on fx_rates; Edge Functions get this injected
// automatically, it's never shipped to the client.
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

Deno.serve(async () => {
  try {
    const res = await fetch(FX_API_URL);
    if (!res.ok) throw new Error(`FX API responded ${res.status}`);
    const data = await res.json();
    if (data.result !== 'success' || !data.rates || typeof data.rates !== 'object') {
      throw new Error('unexpected FX API response shape: ' + JSON.stringify(data).slice(0, 200));
    }

    const upsert = await fetch(`${SUPABASE_URL}/rest/v1/fx_rates?on_conflict=id`, {
      method: 'POST',
      headers: {
        apikey: SERVICE_ROLE_KEY,
        Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
        'Content-Type': 'application/json',
        Prefer: 'resolution=merge-duplicates,return=minimal',
      },
      body: JSON.stringify({
        id: SINGLETON_ID,
        base: data.base_code ?? 'USD',
        rates: data.rates,
        created_at: new Date().toISOString(),
      }),
    });
    if (!upsert.ok) {
      throw new Error(`upsert failed (${upsert.status}): ${await upsert.text()}`);
    }

    // Self-heal: drop any stray rows from before this went singleton (or any
    // that somehow slip in), so exactly one row ever exists.
    const cleanup = await fetch(`${SUPABASE_URL}/rest/v1/fx_rates?id=neq.${SINGLETON_ID}`, {
      method: 'DELETE',
      headers: {
        apikey: SERVICE_ROLE_KEY,
        Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
        Prefer: 'return=minimal',
      },
    });
    if (!cleanup.ok) {
      throw new Error(`cleanup failed (${cleanup.status}): ${await cleanup.text()}`);
    }

    return new Response(
      JSON.stringify({ ok: true, currencies: Object.keys(data.rates).length }),
      { status: 200 },
    );
  } catch (e) {
    return new Response(JSON.stringify({ error: String(e) }), { status: 500 });
  }
});
