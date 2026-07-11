import * as s from '../src/lib/stellar.ts';
import { Keypair, Horizon } from '@stellar/stellar-sdk';
import { readFileSync } from 'node:fs';

const cfg = readFileSync(new URL('../src/lib/stellar-config.ts', import.meta.url), 'utf8');
const TREASURY_PUBLIC = cfg.match(/TREASURY_PUBLIC = '([^']+)'/)[1];
const server = new Horizon.Server('https://horizon-testnet.stellar.org');
const treasuryXlm = async () => {
  const a = await server.loadAccount(TREASURY_PUBLIC);
  return parseFloat(a.balances.find((b) => !b.asset_code).balance);
};

const w = s.createWallet();
await s.cashIn(w.publicKey, w.secret, 20);
console.log('setup: user', w.publicKey.slice(0, 8), '| USDC', await s.getBalance(w.publicKey));

// 5. FREEZE
await s.freezeAccount(w.publicKey);
console.log('5. frozen?', await s.isFrozen(w.publicKey));
const victim = s.createWallet();
await s.cashIn(victim.publicKey, victim.secret, 1);
let blocked = false;
try {
  await s.send(w.publicKey, w.secret, victim.publicKey, 5);
} catch {
  blocked = true;
}
console.log('   send while frozen blocked?', blocked, '(should be true)');

// 6. UNFREEZE
await s.unfreezeAccount(w.publicKey);
await s.send(w.publicKey, w.secret, victim.publicKey, 5);
console.log('6. unfrozen, send ok | user USDC', await s.getBalance(w.publicKey));

// 7. RECOVER — account address stays w.publicKey; signing key becomes newDevice
const newDevice = Keypair.random();
await s.recoverAccount(w.publicKey, newDevice.publicKey());
let oldKeyDead = false;
try {
  await s.send(w.publicKey, w.secret, victim.publicKey, 1);
} catch {
  oldKeyDead = true;
}
console.log('7. recovered | old key rejected?', oldKeyDead, '(should be true)');
await s.send(w.publicKey, newDevice.secret(), victim.publicKey, 1);
console.log('   new device can send | user USDC', await s.getBalance(w.publicKey));

// 8. CLOSE + RECLAIM (treasury-authored; no user key needed — ghost reclaim)
const before = await treasuryXlm();
await s.closeAndReclaim(w.publicKey);
const after = await treasuryXlm();
console.log(
  '8. closed | account gone?',
  !(await s.accountExists(w.publicKey)),
  '| treasury XLM reclaimed +',
  (after - before).toFixed(4),
);
console.log('SMOKE_PART2_OK');
