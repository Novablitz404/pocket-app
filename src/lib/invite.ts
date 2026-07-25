// Gates account creation during the invite-only mainnet beta (public
// TestFlight/APK links, controlled access via a one-time code instead — see
// beta_invite_codes + redeem_invite_code in scripts/supabase-schema.sql).
// Device-local only: once redeemed here, this device skips the gate on every
// future launch, same as the app's other one-time local flags.
import AsyncStorage from '@react-native-async-storage/async-storage';
import { ANON_KEY, SUPABASE_URL, directoryEnabled } from './directory';

const REDEEMED_KEY = 'remitt.inviteRedeemed';

export async function isInviteRedeemed(): Promise<boolean> {
  return (await AsyncStorage.getItem(REDEEMED_KEY)) === '1';
}

/** Returns true if the code was valid and unused (and is now burned).
 *  Returns false for a wrong/already-used code — never throws for that case,
 *  only for a network/server failure. */
export async function redeemInviteCode(rawCode: string): Promise<boolean> {
  const code = rawCode.trim().toUpperCase();
  if (!code) return false;
  if (!directoryEnabled) throw new Error('Invite codes are not available right now.');

  const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/redeem_invite_code`, {
    method: 'POST',
    headers: {
      apikey: ANON_KEY,
      Authorization: `Bearer ${ANON_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ p_code: code }),
  });
  if (!res.ok) throw new Error('Could not check that code. Please try again.');
  const ok = await res.json();
  if (ok) await AsyncStorage.setItem(REDEEMED_KEY, '1');
  return Boolean(ok);
}
