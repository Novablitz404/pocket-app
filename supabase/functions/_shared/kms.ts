// Shared helper: sign a 32-byte Stellar transaction hash with the Remitt
// KMS-held Ed25519 key via Google Cloud KMS asymmetricSign. The private key
// never leaves KMS — this only ever gets a 64-byte signature back. Replaces
// the old `Keypair.fromSecret(TREASURY_SECRET)` signing for the Remitt
// co-signer role (recover / close / send co-sign).
//
// Needs two Supabase secrets:
//   GOOGLE_SA_JSON         — the service account key JSON (stringified)
//   REMITT_KMS_KEY_VERSION — full cryptoKeyVersion resource name, e.g.
//     projects/remitt-502317/locations/global/keyRings/remitt/cryptoKeys/remitt-signer/cryptoKeyVersions/1
import { Buffer } from 'node:buffer';

const SA = JSON.parse(Deno.env.get('GOOGLE_SA_JSON')!);
const KEY_VERSION = Deno.env.get('REMITT_KMS_KEY_VERSION')!;

/** Remitt's KMS signer public key (Stellar G-address). Public, safe to ship. */
export const REMITT_KMS_PUBLIC =
  Deno.env.get('REMITT_SIGNER') ?? 'GDBG6KN5PJ3JHAZSDVK5WN4ISCJYHAS4MB4ETB5CBI3P623P3APQI447';

function b64url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function pemToDer(pem: string): Uint8Array {
  const body = pem.replace(/-----[^-]+-----/g, '').replace(/\s+/g, '');
  return Uint8Array.from(atob(body), (c) => c.charCodeAt(0));
}

let cached: { token: string; exp: number } | null = null;

/** OAuth2 access token for the service account (JWT-bearer flow, RS256). */
async function getAccessToken(): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  if (cached && cached.exp - 60 > now) return cached.token;

  const enc = new TextEncoder();
  const header = b64url(enc.encode(JSON.stringify({ alg: 'RS256', typ: 'JWT' })));
  const claim = b64url(enc.encode(JSON.stringify({
    iss: SA.client_email,
    scope: 'https://www.googleapis.com/auth/cloud-platform',
    aud: SA.token_uri,
    iat: now,
    exp: now + 3600,
  })));
  const signingInput = `${header}.${claim}`;

  const key = await crypto.subtle.importKey(
    'pkcs8', pemToDer(SA.private_key),
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign'],
  );
  const sig = new Uint8Array(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, enc.encode(signingInput)));
  const jwt = `${signingInput}.${b64url(sig)}`;

  const res = await fetch(SA.token_uri, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: jwt,
    }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`token exchange failed: ${JSON.stringify(data)}`);
  cached = { token: data.access_token, exp: now + (data.expires_in ?? 3600) };
  return cached.token;
}

/** Sign a 32-byte tx hash with the Remitt KMS key. Returns raw 64-byte sig.
 *  For Ed25519 the hash goes in `data` (raw message), not `digest`. */
export async function kmsSign(hash: Uint8Array): Promise<Uint8Array> {
  const token = await getAccessToken();
  const res = await fetch(`https://cloudkms.googleapis.com/v1/${KEY_VERSION}:asymmetricSign`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ data: Buffer.from(hash).toString('base64') }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`KMS sign failed: ${JSON.stringify(data)}`);
  return new Uint8Array(Buffer.from(data.signature, 'base64'));
}
