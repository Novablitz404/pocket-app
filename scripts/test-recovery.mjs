// Focused testnet verification of the account-recovery (re-key) path used by
// the "I already have an account" onboarding flow:
//   1. create + activate a throwaway user account ($2 cash-in)
//   2. recoverAccount(address, newDeviceKey) — treasury re-keys it
//   3. old device key must be rejected, new device key must transact
//   4. verify on-chain signer set (old master weight 0, new key weight 1,
//      new signer's reserve sponsored by the treasury)
//   5. clean up via closeAndReclaim
// Run: node scripts/test-recovery.mjs
import * as s from '../src/lib/stellar.ts';
import { Keypair, Horizon } from '@stellar/stellar-sdk';

const server = new Horizon.Server('https://horizon-testnet.stellar.org');

const w = s.createWallet();
await s.cashIn(w.publicKey, w.secret, 2);
console.log('1. activated', w.publicKey.slice(0, 8), '| USDC', await s.getBalance(w.publicKey));

const newDevice = Keypair.random();
await s.recoverAccount(w.publicKey, newDevice.publicKey());
console.log('2. recoverAccount submitted | new device', newDevice.publicKey().slice(0, 8));

let oldKeyRejected = false;
try {
  await s.cashOut(w.publicKey, w.secret, 0.5);
} catch (e) {
  oldKeyRejected = true;
  console.log('3a. old key rejected ✓ (', e.message.slice(0, 60), ')');
}
if (!oldKeyRejected) throw new Error('FAIL: old device key can still transact after recovery');

await s.cashOut(w.publicKey, newDevice.secret(), 0.5);
console.log('3b. new key cash-out ok | USDC', await s.getBalance(w.publicKey));

const acct = await server.loadAccount(w.publicKey);
const master = acct.signers.find((x) => x.key === w.publicKey);
const added = acct.signers.find((x) => x.key === newDevice.publicKey());
console.log('4. signers: master weight', master?.weight, '(want 0) | new key weight', added?.weight, '(want 1) | sponsor', added?.sponsor?.slice(0, 8) ?? 'none');
if (master?.weight !== 0 || added?.weight !== 1) throw new Error('FAIL: signer set wrong after recovery');

await s.closeAndReclaim(w.publicKey);
console.log('5. cleaned up | account gone?', !(await s.accountExists(w.publicKey)));
console.log('RECOVERY_OK');
