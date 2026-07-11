// Push notifications via Expo's push service, backed by Supabase like
// directory.ts. Each device stores its Expo push token in a push_tokens table
// keyed by token (one row per device, many devices per address). Anyone who
// wants to notify a user — the sender's app after a P2P payment, or the
// announcement/yield scripts in scripts/ — looks up the address's tokens and
// POSTs to Expo's push API. Expo relays through APNs/FCM, so notifications
// arrive even when the app is closed.
//
// Requires a development build (remote push doesn't work in Expo Go since
// SDK 53) and an EAS projectId in app.json (extra.eas.projectId). Until both
// exist this module gracefully no-ops, same as the directory.
import Constants from 'expo-constants';
import * as Device from 'expo-device';
import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';
import { ANON_KEY, SUPABASE_URL, directoryEnabled } from './directory';

const TABLE = 'push_tokens';
const INBOX_TABLE = 'notifications';
const rest = (path: string) => `${SUPABASE_URL}/rest/v1/${path}`;
const headers = {
  apikey: ANON_KEY,
  Authorization: `Bearer ${ANON_KEY}`,
  'Content-Type': 'application/json',
};

export interface InboxNotification {
  id: string;
  title: string;
  body: string;
  data: Record<string, unknown>;
  read: boolean;
  createdAt: string;
}

function fromInboxRow(r: any): InboxNotification {
  return {
    id: r.id,
    title: r.title,
    body: r.body,
    data: r.data ?? {},
    read: r.read,
    createdAt: r.created_at,
  };
}

/** Recent inbox entries for this account, newest first. Populated by every
 *  notifyAddress call regardless of whether push itself is reachable — the
 *  bell icon works the same in Expo Go as it will after the EAS dev build. */
export async function getNotifications(address: string): Promise<InboxNotification[]> {
  if (!directoryEnabled) return [];
  try {
    const res = await fetch(
      rest(`${INBOX_TABLE}?address=eq.${encodeURIComponent(address)}&order=created_at.desc&limit=50`),
      { headers },
    );
    if (!res.ok) return [];
    return (await res.json()).map(fromInboxRow);
  } catch {
    return [];
  }
}

export async function markNotificationRead(id: string): Promise<void> {
  if (!directoryEnabled) return;
  try {
    await fetch(rest(`${INBOX_TABLE}?id=eq.${encodeURIComponent(id)}`), {
      method: 'PATCH',
      headers,
      body: JSON.stringify({ read: true }),
    });
  } catch {
    // Best-effort.
  }
}

export async function markAllNotificationsRead(address: string): Promise<void> {
  if (!directoryEnabled) return;
  try {
    await fetch(rest(`${INBOX_TABLE}?address=eq.${encodeURIComponent(address)}&read=eq.false`), {
      method: 'PATCH',
      headers,
      body: JSON.stringify({ read: true }),
    });
  } catch {
    // Best-effort.
  }
}

const EXPO_PUSH_API = 'https://exp.host/--/api/v2/push/send';

// Foreground behavior: show the banner even while the app is open (the SSE
// stream already refreshes the balance; the banner is still nice feedback).
if (Platform.OS !== 'web') {
  Notifications.setNotificationHandler({
    handleNotification: async () => ({
      shouldPlaySound: true,
      shouldSetBadge: false,
      shouldShowBanner: true,
      shouldShowList: true,
    }),
  });
}

/** EAS project id, required by getExpoPushTokenAsync. Absent until EAS is
 *  set up (npx eas init), in which case push registration no-ops. */
function easProjectId(): string | null {
  return (
    (Constants as any)?.expoConfig?.extra?.eas?.projectId ??
    (Constants as any)?.easConfig?.projectId ??
    null
  );
}

/**
 * Ask for permission, fetch this device's Expo push token and store it in
 * Supabase under the given address. Safe to call on every app start — the
 * upsert refreshes updated_at and re-links the token if the address changed
 * (new account on the same device). No-ops on web, simulators, Expo Go, or
 * when EAS/Supabase aren't configured yet.
 */
export async function registerForPush(address: string): Promise<void> {
  if (Platform.OS === 'web' || !Device.isDevice || !directoryEnabled) return;
  const projectId = easProjectId();
  if (!projectId) return;
  try {
    // Android 13+ shows the permission prompt only once a channel exists.
    if (Platform.OS === 'android') {
      await Notifications.setNotificationChannelAsync('default', {
        name: 'Payments & updates',
        importance: Notifications.AndroidImportance.MAX,
        vibrationPattern: [0, 250, 250, 250],
      });
    }
    const { status: existing } = await Notifications.getPermissionsAsync();
    let status = existing;
    if (existing !== 'granted') {
      ({ status } = await Notifications.requestPermissionsAsync());
    }
    if (status !== 'granted') return;

    const token = (await Notifications.getExpoPushTokenAsync({ projectId })).data;
    await fetch(rest(TABLE), {
      method: 'POST',
      headers: { ...headers, Prefer: 'resolution=merge-duplicates' },
      body: JSON.stringify({
        token,
        address,
        platform: Platform.OS,
        updated_at: new Date().toISOString(),
      }),
    });
  } catch {
    // Push is best-effort; the wallet works without it.
  }
}

/** Forget this address's tokens (account reset / closed on this device). */
export async function removePushTokens(address: string): Promise<void> {
  if (!directoryEnabled) return;
  try {
    await fetch(rest(`${TABLE}?address=eq.${encodeURIComponent(address)}`), {
      method: 'DELETE',
      headers,
    });
  } catch {
    // Best-effort.
  }
}

/**
 * Notify an address of an event: always writes an inbox row (the bell icon's
 * source of truth, works whether or not push is reachable), then also pushes
 * to every registered device via Expo's push API when one exists. Called by
 * the *sender's* app right after a successful P2P payment or a payment
 * request, so the other party hears about it even with their app closed.
 * Fire-and-forget: never throws, never blocks the caller's flow.
 */
export async function notifyAddress(
  address: string,
  title: string,
  body: string,
  data?: Record<string, unknown>,
): Promise<void> {
  if (!directoryEnabled) return;
  fetch(rest(INBOX_TABLE), {
    method: 'POST',
    headers,
    body: JSON.stringify({ address, title, body, data: data ?? {} }),
  }).catch(() => {});
  try {
    const res = await fetch(
      rest(`${TABLE}?address=eq.${encodeURIComponent(address)}&select=token`),
      { headers },
    );
    if (!res.ok) return;
    const rows: { token: string }[] = await res.json();
    if (rows.length === 0) return;
    await fetch(EXPO_PUSH_API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(
        rows.map((r) => ({
          to: r.token,
          title,
          body,
          sound: 'default',
          data: data ?? {},
        })),
      ),
    });
  } catch {
    // Best-effort.
  }
}
