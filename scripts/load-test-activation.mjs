// Load test for the channel-account pool (Instawards D1 proof artifact):
// fires N concurrent account activations and confirms every one lands with
// its own sequence number — zero tx_bad_seq, which is exactly the collision
// the channel-account pool exists to remove (see reserve-channel/index.ts
// and activate-account/index.ts).
//
// Each run generates N brand-new local keypairs and drives them through the
// SAME two-step flow the app itself uses: reserve-channel (claim a channel
// account + read its sequence) → build + sign the 5-op activation tx →
// activate-account (validates, adds the channel + treasury signatures,
// submits, releases the channel). This is real network traffic — it
// consumes N channel-account "slots" concurrently and creates N real
// testnet accounts, sponsored by the treasury.
//
// Run (from packages/app):
//   node scripts/load-test-activation.mjs [concurrency]
//
// Needs a channel-account pool of at least `concurrency` accounts already
// seeded (scripts/setup-channel-accounts.mjs) and both Edge Functions
// (reserve-channel, activate-account) already deployed.
import {
  Account,
  Asset,
  BASE_FEE,
  Keypair,
  Networks,
  Operation,
  TransactionBuilder,
} from '@stellar/stellar-sdk';
import { readFileSync } from 'node:fs';

const cfg = readFileSync(new URL('../src/lib/stellar-config.ts', import.meta.url), 'utf8');
const pick = (name) => cfg.match(new RegExp(`${name} = '([^']+)'`))[1];
const TREASURY_PUBLIC = pick('TREASURY_PUBLIC');
const USDC_ISSUER = pick('USDC_ISSUER');
const USDC = new Asset('USDC', USDC_ISSUER);

const env = readFileSync(new URL('../.env', import.meta.url), 'utf8');
const pickEnv = (name) => env.match(new RegExp(`${name}=(.*)`))?.[1]?.trim();
const SUPABASE_URL = pickEnv('EXPO_PUBLIC_SUPABASE_URL');
const ANON_KEY = pickEnv('EXPO_PUBLIC_SUPABASE_ANON_KEY');

const USER_MASTER_WEIGHT = 1;
const TREASURY_SIGNER_WEIGHT = 2;
const THRESHOLD_LOW = 1;
const THRESHOLD_MED = 1;
const THRESHOLD_HIGH = 2;

const concurrency = Number(process.argv[2] ?? 10);

async function activateOne(i) {
  const user = Keypair.random();

  // Step 1: reserve a channel account (own sequence number, no collision).
  const reserveRes = await fetch(`${SUPABASE_URL}/functions/v1/reserve-channel`, {
    method: 'POST',
    headers: { apikey: ANON_KEY, Authorization: `Bearer ${ANON_KEY}` },
  });
  const reserved = await reserveRes.json();
  if (!reserveRes.ok) throw new Error(`[${i}] reserve-channel: ${reserved?.error ?? reserveRes.status}`);
  const { channelPublicKey, sequence } = reserved;

  // Step 2: build + sign the activation tx against that exact channel + sequence.
  const source = new Account(channelPublicKey, sequence);
  const tx = new TransactionBuilder(source, { fee: BASE_FEE, networkPassphrase: Networks.TESTNET })
    .addOperation(Operation.beginSponsoringFutureReserves({ source: TREASURY_PUBLIC, sponsoredId: user.publicKey() }))
    .addOperation(Operation.createAccount({ source: TREASURY_PUBLIC, destination: user.publicKey(), startingBalance: '0' }))
    .addOperation(Operation.changeTrust({ source: user.publicKey(), asset: USDC }))
    .addOperation(
      Operation.setOptions({
        source: user.publicKey(),
        masterWeight: USER_MASTER_WEIGHT,
        lowThreshold: THRESHOLD_LOW,
        medThreshold: THRESHOLD_MED,
        highThreshold: THRESHOLD_HIGH,
        signer: { ed25519PublicKey: TREASURY_PUBLIC, weight: TREASURY_SIGNER_WEIGHT },
      }),
    )
    .addOperation(Operation.endSponsoringFutureReserves({ source: user.publicKey() }))
    .setTimeout(60)
    .build();
  tx.sign(user);
  const innerXdr = Buffer.from(tx.toEnvelope().toXDR()).toString('base64');

  // Step 3: activate-account adds the channel + treasury signatures and submits.
  const res = await fetch(`${SUPABASE_URL}/functions/v1/activate-account`, {
    method: 'POST',
    headers: { apikey: ANON_KEY, Authorization: `Bearer ${ANON_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ innerXdr, channelPublicKey }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`[${i}] activate-account: ${data?.error ?? res.status}`);
  return { i, account: data.account, hash: data.hash, channel: channelPublicKey };
}

console.log(`Firing ${concurrency} concurrent activations...`);
const started = Date.now();
const results = await Promise.allSettled(Array.from({ length: concurrency }, (_, i) => activateOne(i)));
const elapsed = ((Date.now() - started) / 1000).toFixed(1);

const succeeded = results.filter((r) => r.status === 'fulfilled');
const failed = results.filter((r) => r.status === 'rejected');
const badSeq = failed.filter((r) => /tx_bad_seq/i.test(String(r.reason)));

console.log(`\nDone in ${elapsed}s: ${succeeded.length}/${concurrency} succeeded, ${failed.length} failed.`);
if (badSeq.length > 0) {
  console.log(`\n⚠️  ${badSeq.length} failed with tx_bad_seq — the channel pool did NOT prevent a collision.`);
}
console.log('\nSuccessful activations (tx hash — Stellar Expert: https://stellar.expert/explorer/testnet/tx/<hash>):');
for (const r of succeeded) {
  console.log(`  ${r.value.hash}  (account ${r.value.account}, via channel ${r.value.channel})`);
}
if (failed.length > 0) {
  console.log('\nFailures:');
  for (const r of failed) console.log(`  ${r.reason}`);
}
console.log(
  `\n${badSeq.length === 0 ? '✅' : '❌'} zero tx_bad_seq: ${badSeq.length === 0}` +
    (failed.length > badSeq.length ? ` (${failed.length - badSeq.length} other, non-collision failures — see above)` : ''),
);
