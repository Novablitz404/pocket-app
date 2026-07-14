// Email verification via Supabase Auth's email OTP, talking to the GoTrue
// REST API directly like directory.ts does with PostgREST. Supabase generates
// and checks the 6-digit codes; delivery goes through the project's SMTP
// provider (Resend). Requires in the Supabase dashboard:
//   - Auth → Providers → Email enabled
//   - Auth → Email Templates → Magic Link body contains {{ .Token }}
//   - Auth → SMTP settings → smtp.resend.com / user "resend" / API key
import { ANON_KEY, SUPABASE_URL, directoryEnabled, normalizeEmail } from './directory';

const auth = (path: string) => `${SUPABASE_URL}/auth/v1/${path}`;
const headers = {
  apikey: ANON_KEY,
  Authorization: `Bearer ${ANON_KEY}`,
  'Content-Type': 'application/json',
};

async function authError(res: Response): Promise<string> {
  try {
    const json = await res.json();
    return json.msg ?? json.error_description ?? json.message ?? `Error ${res.status}`;
  } catch {
    return `Error ${res.status}`;
  }
}

/** Email a 6-digit code. Throws with a readable message on failure
 *  (rate limits, bad address, SMTP misconfiguration). */
export async function sendEmailOtp(email: string): Promise<void> {
  if (!directoryEnabled) throw new Error('Verification is not available right now.');
  const res = await fetch(auth('otp'), {
    method: 'POST',
    headers,
    body: JSON.stringify({ email: normalizeEmail(email), create_user: true }),
  });
  if (!res.ok) throw new Error(await authError(res));
}

/** Check the code the user typed. Throws on a wrong or expired code. Returns
 *  the session's access token: verification flows discard it (proving inbox
 *  ownership is all they need), account recovery passes it to
 *  recoverProfile() to look up the profile behind the email. */
export async function verifyEmailOtp(email: string, token: string): Promise<string> {
  if (!directoryEnabled) throw new Error('Verification is not available right now.');
  const res = await fetch(auth('verify'), {
    method: 'POST',
    headers,
    body: JSON.stringify({ type: 'email', email: normalizeEmail(email), token: token.trim() }),
  });
  if (!res.ok) throw new Error(await authError(res));
  const session = await res.json();
  return session.access_token ?? '';
}

/** The profile a just-verified email can recover, or null if there is none
 *  (unknown email, or the account never verified it). Calls the
 *  recover_profile() RPC with the OTP session's JWT — the database matches on
 *  the token's own email claim, so a caller can only ever see their own row.
 *  `pin` is the second factor: checked server-side against the bcrypt hash,
 *  with a 15-minute lockout after 5 wrong tries (throws with the message). */
export async function recoverProfile(accessToken: string, pin: string): Promise<{
  address: string;
  username: string;
  firstName?: string;
  lastName?: string;
  country?: string;
  avatarUrl?: string;
} | null> {
  if (!directoryEnabled) throw new Error('Recovery is not available right now.');
  const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/recover_profile`, {
    method: 'POST',
    headers: { ...headers, Authorization: `Bearer ${accessToken}` },
    body: JSON.stringify({ p_pin: pin }),
  });
  if (!res.ok) throw new Error(await authError(res));
  const rows: any[] = await res.json();
  const r = rows[0];
  if (!r) return null;
  return {
    address: r.address,
    username: r.username,
    firstName: r.first_name ?? undefined,
    lastName: r.last_name ?? undefined,
    country: r.country ?? undefined,
    avatarUrl: r.avatar_url ?? undefined,
  };
}

/** Mirror the passcode to the server as the recovery second factor (bcrypt'd
 *  inside the set_recovery_pin function — the hash never reaches any client).
 *  Called by the lock screen whenever the PIN is set or changed. `oldPin` is
 *  required to overwrite an EXISTING server-side PIN (proof the caller
 *  already knows it, closing off silent takeover of anyone's recovery PIN by
 *  a bare anon key) — omit only when the address has never set one before.
 *  Best-effort: an account with no server PIN recovers on the email OTP
 *  alone, so a failed sync degrades security, never locks the user out. */
export async function syncRecoveryPin(address: string, pin: string, oldPin?: string): Promise<void> {
  if (!directoryEnabled) return;
  try {
    await fetch(`${SUPABASE_URL}/rest/v1/rpc/set_recovery_pin`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ p_address: address, p_pin: pin, p_old_pin: oldPin ?? null }),
    });
  } catch {
    // Best-effort.
  }
}

/** Marks the profile behind the CALLER'S OWN just-verified OTP session as
 *  email-verified, via the mark_email_verified() RPC — it derives the
 *  address from the JWT's email claim, so an address can't be flagged
 *  verified by anyone but the person who actually passed that email's OTP.
 *  (Previously a plain anon PATCH on email_verified; that let ANY anon-key
 *  holder forge verification for any address — accessToken closes that.)
 *  Best-effort: the local flag in wallet-context is the source of truth for
 *  the UI regardless of whether this sync succeeds. */
export async function markEmailVerified(accessToken: string): Promise<void> {
  if (!directoryEnabled) return;
  try {
    await fetch(`${SUPABASE_URL}/rest/v1/rpc/mark_email_verified`, {
      method: 'POST',
      headers: { ...headers, Authorization: `Bearer ${accessToken}` },
      body: '{}',
    });
  } catch {
    // Best-effort.
  }
}

/** Placeholder account verification — no real identity check behind it yet,
 *  just a user-initiated confirm that unlocks cash-in. Best-effort, same as
 *  the other flag syncs above: the local flag in wallet-context is the
 *  source of truth for this device's UI regardless of whether this succeeds. */
export async function verifyAccount(address: string): Promise<void> {
  if (!directoryEnabled) return;
  try {
    await fetch(`${SUPABASE_URL}/rest/v1/rpc/verify_account`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ p_address: address }),
    });
  } catch {
    // Best-effort.
  }
}
