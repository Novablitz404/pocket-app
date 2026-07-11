// Broadcast a push notification to every registered Remitt device, via the
// Expo push API. Tokens come from the push_tokens table (see
// supabase-schema.sql); Supabase credentials come from packages/app/.env.
//
// Run: node scripts/send-announcement.mjs "Title" "Body text"
import { readFileSync } from 'node:fs';

const [title, body] = process.argv.slice(2);
if (!title || !body) {
  console.error('Usage: node scripts/send-announcement.mjs "Title" "Body text"');
  process.exit(1);
}

const env = Object.fromEntries(
  readFileSync(new URL('../.env', import.meta.url), 'utf8')
    .split('\n')
    .filter((l) => l.includes('=') && !l.trimStart().startsWith('#'))
    .map((l) => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()]),
);
const SUPABASE_URL = env.EXPO_PUBLIC_SUPABASE_URL;
const ANON_KEY = env.EXPO_PUBLIC_SUPABASE_ANON_KEY;
if (!SUPABASE_URL || !ANON_KEY) {
  console.error('EXPO_PUBLIC_SUPABASE_URL / EXPO_PUBLIC_SUPABASE_ANON_KEY missing from .env');
  process.exit(1);
}
const headers = { apikey: ANON_KEY, Authorization: `Bearer ${ANON_KEY}`, 'Content-Type': 'application/json' };
const rest = (path) => `${SUPABASE_URL}/rest/v1/${path}`;

// Broadcast to every profile (not just push-registered devices), so the
// in-app inbox reaches everyone even before EAS/push exist on their build.
const [tokensRes, profilesRes] = await Promise.all([
  fetch(rest('push_tokens?select=token'), { headers }),
  fetch(rest('profiles?select=address'), { headers }),
]);
if (!tokensRes.ok) throw new Error(`Supabase ${tokensRes.status}: ${await tokensRes.text()}`);
if (!profilesRes.ok) throw new Error(`Supabase ${profilesRes.status}: ${await profilesRes.text()}`);
const tokens = (await tokensRes.json()).map((r) => r.token);
const addresses = (await profilesRes.json()).map((r) => r.address);
console.log(`Sending "${title}" to ${tokens.length} device(s), ${addresses.length} inbox(es)...`);

for (let i = 0; i < addresses.length; i += 500) {
  await fetch(rest('notifications'), {
    method: 'POST',
    headers,
    body: JSON.stringify(
      addresses.slice(i, i + 500).map((address) => ({
        address,
        title,
        body,
        data: { type: 'announcement' },
      })),
    ),
  });
}

// Expo accepts up to 100 messages per request.
const dead = [];
for (let i = 0; i < tokens.length; i += 100) {
  const batch = tokens.slice(i, i + 100);
  const push = await fetch('https://exp.host/--/api/v2/push/send', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(
      batch.map((to) => ({ to, title, body, sound: 'default', data: { type: 'announcement' } })),
    ),
  });
  const json = await push.json();
  (json.data ?? []).forEach((ticket, idx) => {
    if (ticket.status === 'error') {
      console.error(`  ${batch[idx]}: ${ticket.message}`);
      if (ticket.details?.error === 'DeviceNotRegistered') dead.push(batch[idx]);
    }
  });
}

// Prune tokens Expo says are gone (app uninstalled, permissions revoked).
for (const token of dead) {
  await fetch(rest(`push_tokens?token=eq.${encodeURIComponent(token)}`), {
    method: 'DELETE',
    headers,
  });
}
if (dead.length) console.log(`Pruned ${dead.length} dead token(s).`);
console.log('Done.');
