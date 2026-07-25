// Seeds the channel-account pool used by activate-account's concurrency fix
// (see supabase-schema.sql's channel_accounts table + reserve-channel Edge
// Function). Generates N keypairs, funds each from the treasury in a single
// transaction (createAccount ops — cheap: just enough XLM for these accounts
// to pay their own tx fees as a transaction source, never anyone else's),
// then inserts them into channel_accounts via the Supabase REST API using
// the SERVICE ROLE key (that table has zero anon/authenticated grants by
// design — only Edge Functions and this one-time seeding script ever touch
// the secrets in it).
//
// Run (from packages/app):
//   SUPABASE_SERVICE_ROLE_KEY=<service-role key from Supabase dashboard → Settings → API> \
//     node scripts/setup-channel-accounts.mjs [count] [xlmPerAccount]
//
// Defaults: 10 channel accounts, 5 XLM each (plenty of headroom for
// thousands of activation transactions before needing a top-up).
import { BASE_FEE, Horizon, Keypair, Networks, Operation, TransactionBuilder } from '@stellar/stellar-sdk';
import { readFileSync } from 'node:fs';

const cfg = readFileSync(new URL('../src/lib/stellar-config.ts', import.meta.url), 'utf8');
const pick = (name) => cfg.match(new RegExp(`${name} = '([^']+)'`))[1];
const HORIZON_URL = pick('HORIZON_URL');
const { TREASURY_SECRET } = await import('./treasury-secret.mjs');

const env = readFileSync(new URL('../.env', import.meta.url), 'utf8');
const pickEnv = (name) => env.match(new RegExp(`${name}=(.*)`))?.[1]?.trim();
const SUPABASE_URL = pickEnv('EXPO_PUBLIC_SUPABASE_URL');
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SERVICE_ROLE_KEY) {
  console.error('Set SUPABASE_SERVICE_ROLE_KEY (Supabase dashboard → Settings → API → service_role).');
  process.exit(1);
}

const count = Number(process.argv[2] ?? 10);
const xlmPerAccount = process.argv[3] ?? '5';
if (count > 100) {
  console.error('Max 100 per run (one createAccount op per channel account, 100 ops/tx limit). Run it again for more.');
  process.exit(1);
}

const server = new Horizon.Server(HORIZON_URL);
const treasury = Keypair.fromSecret(TREASURY_SECRET);

const channels = Array.from({ length: count }, () => Keypair.random());
console.log(`Generating ${count} channel accounts, funding ${xlmPerAccount} XLM each from the treasury...`);

const account = await server.loadAccount(treasury.publicKey());
const builder = new TransactionBuilder(account, { fee: BASE_FEE, networkPassphrase: Networks.TESTNET });
for (const kp of channels) {
  builder.addOperation(Operation.createAccount({ destination: kp.publicKey(), startingBalance: xlmPerAccount }));
}
const tx = builder.setTimeout(60).build();
tx.sign(treasury);

try {
  await server.submitTransaction(tx);
} catch (e) {
  console.error('Funding failed:', JSON.stringify(e?.response?.data?.extras?.result_codes ?? e.message));
  process.exit(1);
}
console.log('Funded on-chain. Inserting into channel_accounts...');

const rows = channels.map((kp) => ({ public_key: kp.publicKey(), secret: kp.secret() }));
const res = await fetch(`${SUPABASE_URL}/rest/v1/channel_accounts`, {
  method: 'POST',
  headers: {
    apikey: SERVICE_ROLE_KEY,
    Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
    'Content-Type': 'application/json',
    Prefer: 'resolution=merge-duplicates',
  },
  body: JSON.stringify(rows),
});
if (!res.ok) {
  console.error('Insert failed:', await res.text());
  process.exit(1);
}
console.log(`Done. ${count} channel accounts in the pool.`);
