// On-ramp Phase O2: create a cash-in INTENT. The user says "I want $M USDC";
// this quotes the clean ₱ they must pay and writes a `pending` cash_in_intents
// row (service_role). The app shows deposit instructions (pay EXACTLY this ₱
// amount) and polls the intent until deposit detection (Phase O3) matches the
// PHP deposit and the gated deliver-cash-in function (Phase O1) flips it to
// `delivered`.
//
// MATCHING (no centavo tag): a deposit is matched to an intent by
//   amount_php  +  sender name (→ the intent owner's profile)  within the window.
// To keep that unambiguous we enforce ONE OPEN INTENT PER USER: creating a new
// intent SUPERSEDES (expires) any prior pending one for the same address, so a
// user can never have two same-amount intents in flight. Cross-user collisions
// (two different people, same name, same amount, same window) are vanishingly
// rare and fall to the operator exceptions queue rather than auto-delivering.
// Dedup on the coins.ph referenceNumber (unique index on deposit_ref) stops a
// re-poll from double-paying.
//
// SECURITY: creating an intent moves NO money — it's just a quote + a row — so
// it's safe to call with the shared anon key (same custodial trust model as
// create-request). Delivery is gated separately (ADMIN_SECRET on
// deliver-cash-in), and a user can never mark their own intent delivered.
// The residual identity gap (caller-supplied address) is the same one the whole
// directory has; it can't be used to steal — at worst you pay ₱ to fund someone
// else's wallet.
//
// Deploy (from packages/app):
//   npx supabase functions deploy create-intent
//   (needs the cash_in_intents table from scripts/onramp-schema.sql; optional
//   secrets PHP_PER_USD, COINSPH_DEPOSIT_LABEL/ACCOUNT to tune the quote + the
//   deposit target shown to the user)
const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

// Beta quote knobs. Pass-through, zero Remitt margin (see onramp-build-plan):
// amount_php = amount_usdc * PHP_PER_USD (clean FX quote, no centavo tag).
const PHP_PER_USD = Number(Deno.env.get('PHP_PER_USD') ?? '58.5');
// Where the user sends the pesos (the improvised coins.ph float account). Shown
// verbatim in the app; swap for the official partner details when they land.
const DEPOSIT_LABEL = Deno.env.get('COINSPH_DEPOSIT_LABEL') ?? 'coins.ph (InstaPay)';
const DEPOSIT_ACCOUNT = Deno.env.get('COINSPH_DEPOSIT_ACCOUNT') ?? '';

const ADDRESS_RE = /^G[A-Z0-9]{55}$/;
const MAX_USDC = 2000; // beta per-intent cap

const svc = {
  apikey: SERVICE_ROLE_KEY,
  Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
  'Content-Type': 'application/json',
};

/** Expire any still-open intent for this address so there is at most ONE open
 *  intent per user — the invariant that lets us match on amount + name without a
 *  centavo tag. Best-effort; a leftover doesn't corrupt anything, it just risks
 *  an ambiguous match that would land in the exceptions queue. */
async function supersedeOpenIntents(address: string): Promise<void> {
  await fetch(
    `${SUPABASE_URL}/rest/v1/cash_in_intents?address=eq.${encodeURIComponent(address)}&status=eq.pending`,
    {
      method: 'PATCH',
      headers: { ...svc, Prefer: 'return=minimal' },
      body: JSON.stringify({ status: 'expired', operator_note: 'superseded by a newer intent' }),
    },
  ).catch(() => {});
}

Deno.serve(async (req) => {
  try {
    const { address, amountUsdc } = await req.json();
    if (!ADDRESS_RE.test(address ?? '')) {
      return new Response(JSON.stringify({ error: 'a valid Stellar address is required' }), { status: 400 });
    }
    const usdc = Number(amountUsdc);
    if (!Number.isFinite(usdc) || usdc <= 0) {
      return new Response(JSON.stringify({ error: 'amountUsdc must be a positive number' }), { status: 400 });
    }
    if (usdc > MAX_USDC) {
      return new Response(JSON.stringify({ error: `amount exceeds the ₱ limit for now (max $${MAX_USDC})` }), { status: 400 });
    }

    // Clean FX quote — the exact ₱ the user pays, no centavo tag.
    const amountPhp = Number((usdc * PHP_PER_USD).toFixed(2));

    // One open intent per user: retire any prior pending one first so a deposit
    // can't match two intents for the same person.
    await supersedeOpenIntents(address);

    const res = await fetch(`${SUPABASE_URL}/rest/v1/cash_in_intents`, {
      method: 'POST',
      headers: { ...svc, Prefer: 'return=representation' },
      body: JSON.stringify({
        address,
        amount_php: amountPhp,
        amount_usdc: usdc,
        status: 'pending',
      }),
    });
    if (!res.ok) {
      const body = await res.text();
      return new Response(JSON.stringify({ error: `could not create the intent: ${body}` }), { status: 500 });
    }
    const row = (await res.json())[0];

    return new Response(
      JSON.stringify({
        id: row.id,
        address: row.address,
        amountUsdc: Number(row.amount_usdc),
        amountPhp: Number(row.amount_php),
        status: row.status,
        expiresAt: row.expires_at,
        deposit: { label: DEPOSIT_LABEL, account: DEPOSIT_ACCOUNT },
      }),
      { status: 200 },
    );
  } catch (e) {
    return new Response(JSON.stringify({ error: String(e) }), { status: 500 });
  }
});
