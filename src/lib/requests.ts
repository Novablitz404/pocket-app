// In-app payment requests, backed by Supabase like directory.ts. A request is
// a row naming who's asking (fromAddress) and who's being asked (toAddress);
// the payer fulfills it by sending money through the normal send flow, which
// then calls markPaid. Gracefully no-ops until Supabase env vars are set.
import { ANON_KEY, SUPABASE_URL, directoryEnabled } from './directory';

const TABLE = 'requests';
const rest = (path: string) => `${SUPABASE_URL}/rest/v1/${path}`;
const headers = {
  apikey: ANON_KEY,
  Authorization: `Bearer ${ANON_KEY}`,
  'Content-Type': 'application/json',
};

export interface PaymentRequest {
  id: string;
  fromAddress: string; // requester, gets paid
  toAddress: string; // payer, gets asked
  amount: number;
  note?: string;
  status: 'pending' | 'paid' | 'declined';
  createdAt: string;
  expiresAt: string;
}

function fromRow(r: any): PaymentRequest {
  return {
    id: r.id,
    fromAddress: r.from_address,
    toAddress: r.to_address,
    amount: parseFloat(r.amount),
    note: r.note ?? undefined,
    status: r.status,
    createdAt: r.created_at,
    expiresAt: r.expires_at,
  };
}

/** Ask someone for money. Goes through the create-request Edge Function, which
 *  writes the row AND emits the payer's notification server-side (service_role)
 *  — the `requests`/`notifications` tables no longer accept anon INSERTs, so a
 *  request (and any notification) can't be forged by a bare client POST. The
 *  function handles the notification itself; callers should NOT also notify. */
export async function createRequest(
  fromAddress: string,
  toAddress: string,
  amount: number,
  note?: string,
): Promise<PaymentRequest> {
  if (!directoryEnabled) throw new Error('Requests are not available right now.');
  const res = await fetch(`${SUPABASE_URL}/functions/v1/create-request`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ fromAddress, toAddress, amount, note: note?.trim() || null }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body?.error ?? `Could not create the request (${res.status})`);
  }
  return fromRow(await res.json());
}

/** Unexpired pending requests asking this address for money, newest first. */
export async function getPendingRequests(toAddress: string): Promise<PaymentRequest[]> {
  if (!directoryEnabled) return [];
  try {
    const res = await fetch(
      rest(
        `${TABLE}?to_address=eq.${encodeURIComponent(toAddress)}&status=eq.pending&expires_at=gt.${encodeURIComponent(new Date().toISOString())}&order=created_at.desc`,
      ),
      { headers },
    );
    if (!res.ok) return [];
    return (await res.json()).map(fromRow);
  } catch {
    return [];
  }
}

/** Fulfilled by a real payment (see send.tsx). Best-effort: the money already
 *  moved, so a failed status update shouldn't surface as an error. */
export async function markPaid(id: string): Promise<void> {
  if (!directoryEnabled) return;
  try {
    await fetch(rest(`${TABLE}?id=eq.${encodeURIComponent(id)}`), {
      method: 'PATCH',
      headers,
      body: JSON.stringify({ status: 'paid' }),
    });
  } catch {
    // Best-effort.
  }
}

/** Silent decline: no notification back to the requester, it just stops
 *  showing up for the payer. */
export async function declineRequest(id: string): Promise<void> {
  if (!directoryEnabled) return;
  try {
    await fetch(rest(`${TABLE}?id=eq.${encodeURIComponent(id)}`), {
      method: 'PATCH',
      headers,
      body: JSON.stringify({ status: 'declined' }),
    });
  } catch {
    // Best-effort.
  }
}
