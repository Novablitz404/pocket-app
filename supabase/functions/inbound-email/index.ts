// Supabase Edge Function: webhook receiver for Resend's Inbound feature.
// Resend POSTs an `email.received` event (metadata only — no body) whenever
// mail arrives at a receiving address on getpocket.xyz (e.g. support@,
// eric@). This fetches the full body via Resend's Retrieve Received Email
// API, then upserts it into `inbound_emails` for the admin dashboard's Email
// section to read/reply to.
//
// Deploy (from packages/app):
//   npx supabase functions deploy inbound-email --no-verify-jwt
// (--no-verify-jwt because Resend's webhook can't send a Supabase JWT; also
// set in config.toml so a plain `deploy` without the flag still gets it right.)
//
// Requires two Supabase secrets:
//   npx supabase secrets set RESEND_API_KEY=re_xxx
//   npx supabase secrets set RESEND_WEBHOOK_SECRET=whsec_xxx
// (RESEND_WEBHOOK_SECRET comes from the webhook's detail page in the Resend
// dashboard, after you register this function's URL for the email.received
// event — Settings → Webhooks → Add Webhook.)
const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const RESEND_API_KEY = Deno.env.get('RESEND_API_KEY')!;
const RESEND_WEBHOOK_SECRET = Deno.env.get('RESEND_WEBHOOK_SECRET')!;

function timingSafeEqual(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const ab = enc.encode(a);
  const bb = enc.encode(b);
  if (ab.length !== bb.length) return false;
  let diff = 0;
  for (let i = 0; i < ab.length; i++) diff |= ab[i] ^ bb[i];
  return diff === 0;
}

function base64ToBytes(b64: string): Uint8Array {
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}
function bytesToBase64(bytes: ArrayBuffer): string {
  return btoa(String.fromCharCode(...new Uint8Array(bytes)));
}

/** Resend webhooks are Svix-signed: HMAC-SHA256(secret, "id.timestamp.body"),
 *  base64, compared against one of the space-separated "v1,<sig>" values in
 *  the svix-signature header. Secret is "whsec_<base64>". */
async function verifySvix(req: Request, rawBody: string): Promise<boolean> {
  const svixId = req.headers.get('svix-id');
  const svixTimestamp = req.headers.get('svix-timestamp');
  const svixSignature = req.headers.get('svix-signature');
  if (!svixId || !svixTimestamp || !svixSignature) return false;

  const secretBytes = base64ToBytes(RESEND_WEBHOOK_SECRET.replace(/^whsec_/, ''));
  const key = await crypto.subtle.importKey(
    'raw',
    secretBytes,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signedContent = `${svixId}.${svixTimestamp}.${rawBody}`;
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(signedContent));
  const expected = bytesToBase64(mac);

  return svixSignature
    .split(' ')
    .some((part) => timingSafeEqual(part, `v1,${expected}`));
}

interface ReceivedAttachment {
  id: string;
  filename: string;
  content_type: string;
  content_disposition: string | null;
  content_id: string | null;
  size: number;
}

interface ReceivedEmail {
  id: string;
  from: string;
  to: string[];
  subject: string | null;
  html: string | null;
  text: string | null;
  headers?: Record<string, string>;
  attachments?: ReceivedAttachment[];
  created_at: string;
}

/** "Name <addr@x.com>" -> "addr@x.com", lowercased. */
function normalizeAddress(addr: string): string {
  const match = addr.match(/<([^>]+)>/);
  return (match ? match[1] : addr).trim().toLowerCase();
}

/** Strips repeated Re:/Fwd: prefixes so replies group with their original. */
function normalizeSubject(subject: string | null): string {
  let s = (subject ?? '').trim();
  for (;;) {
    const stripped = s.replace(/^(re|fwd?|fw)\s*:\s*/i, '');
    if (stripped === s) break;
    s = stripped.trim();
  }
  return s.toLowerCase();
}

/** Groups a Gmail-style thread by counterparty + normalized subject. Not
 *  Message-Id chaining (we'd need to capture our own sent replies' Message-Id
 *  for that) — good enough for a support/company inbox. */
function threadKeyFor(email: ReceivedEmail): string {
  return `${normalizeAddress(email.from)}|${normalizeSubject(email.subject)}`;
}

Deno.serve(async (req) => {
  try {
    const rawBody = await req.text();
    if (!(await verifySvix(req, rawBody))) {
      return new Response(JSON.stringify({ error: 'invalid signature' }), { status: 401 });
    }

    const event = JSON.parse(rawBody);
    if (event.type !== 'email.received') {
      return new Response(JSON.stringify({ ok: true, skipped: event.type }), { status: 200 });
    }

    const emailId = event.data.email_id as string;

    // The webhook payload is metadata-only — fetch the full body separately.
    const fetched = await fetch(`https://api.resend.com/emails/receiving/${emailId}`, {
      headers: { Authorization: `Bearer ${RESEND_API_KEY}` },
    });
    if (!fetched.ok) {
      throw new Error(`retrieve-received-email failed (${fetched.status}): ${await fetched.text()}`);
    }
    const email: ReceivedEmail = await fetched.json();

    const upsert = await fetch(`${SUPABASE_URL}/rest/v1/inbound_emails?on_conflict=resend_email_id`, {
      method: 'POST',
      headers: {
        apikey: SERVICE_ROLE_KEY,
        Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
        'Content-Type': 'application/json',
        Prefer: 'resolution=merge-duplicates,return=minimal',
      },
      body: JSON.stringify({
        resend_email_id: email.id,
        message_id: email.headers?.['message-id'] ?? email.headers?.['Message-Id'] ?? null,
        from_address: email.from,
        to_address: Array.isArray(email.to) ? email.to.join(', ') : email.to,
        subject: email.subject,
        html: email.html,
        text_body: email.text,
        received_at: email.created_at,
        thread_key: threadKeyFor(email),
        attachments: (email.attachments ?? []).map((a) => ({
          id: a.id,
          filename: a.filename,
          content_type: a.content_type,
          content_disposition: a.content_disposition,
          content_id: a.content_id,
          size: a.size,
        })),
      }),
    });
    if (!upsert.ok) {
      throw new Error(`upsert failed (${upsert.status}): ${await upsert.text()}`);
    }

    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  } catch (e) {
    return new Response(JSON.stringify({ error: String(e) }), { status: 500 });
  }
});
