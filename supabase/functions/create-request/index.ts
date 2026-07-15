// Supabase Edge Function: Phase 3 — payment requests move server-side so the
// `requests` AND `notifications` tables can both drop their demo-grade anon
// INSERT policies (see supabase-schema.sql). It writes the request row and
// emits the "Payment request 💌" notification in one place, via service_role.
//
// Security note / known gap: without a per-user identity (the app uses the
// shared anon key, custodial model), this function trusts the caller-supplied
// `fromAddress` — a malicious client could still claim a request is "from"
// someone else. That's the same identity gap the whole directory has today and
// is tracked separately. What this DOES close: a request notification (and any
// notification) can no longer be forged by POSTing straight to the tables, and
// crucially a "Money received" settlement claim can now ONLY come from fee-bump
// after a real on-chain submit. A request is explicitly a request, never a
// settlement, so the residual from-spoof can't fake received money.
//
// Deploy (from packages/app):
//   npx supabase functions deploy create-request
import { displayName, notifyAddress } from '../_shared/notify.ts';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const ADDRESS_RE = /^G[A-Z0-9]{55}$/;

Deno.serve(async (req) => {
  try {
    const { fromAddress, toAddress, amount, note } = await req.json();
    if (!ADDRESS_RE.test(fromAddress ?? '') || !ADDRESS_RE.test(toAddress ?? '')) {
      return new Response(JSON.stringify({ error: 'fromAddress and toAddress must be Stellar addresses' }), { status: 400 });
    }
    if (fromAddress === toAddress) {
      return new Response(JSON.stringify({ error: 'cannot request money from yourself' }), { status: 400 });
    }
    const amt = Number(amount);
    if (!Number.isFinite(amt) || amt <= 0) {
      return new Response(JSON.stringify({ error: 'amount must be a positive number' }), { status: 400 });
    }
    const cleanNote = typeof note === 'string' && note.trim() ? note.trim().slice(0, 200) : null;

    // Insert the request row (service_role — anon can no longer insert here).
    const res = await fetch(`${SUPABASE_URL}/rest/v1/requests`, {
      method: 'POST',
      headers: {
        apikey: SERVICE_ROLE_KEY,
        Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
        'Content-Type': 'application/json',
        Prefer: 'return=representation',
      },
      body: JSON.stringify({
        from_address: fromAddress,
        to_address: toAddress,
        amount: amt.toFixed(2),
        note: cleanNote,
      }),
    });
    if (!res.ok) {
      const body = await res.text();
      return new Response(JSON.stringify({ error: `Could not create the request: ${body}` }), { status: 500 });
    }
    const row = (await res.json())[0];

    // Notify the payer (best-effort, server-authoritative).
    const name = await displayName(fromAddress);
    const usd = amt.toLocaleString(undefined, { style: 'currency', currency: 'USD' });
    await notifyAddress(
      toAddress,
      'Payment request 💌',
      `${name} asked you for ${usd}${cleanNote ? ` · ${cleanNote}` : ''}`,
      { type: 'request', requestId: row.id, from: fromAddress, fromName: name, amount: amt.toFixed(2) },
    );

    return new Response(JSON.stringify(row), { status: 200 });
  } catch (e) {
    return new Response(JSON.stringify({ error: String(e) }), { status: 500 });
  }
});
