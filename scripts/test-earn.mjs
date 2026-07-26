// End-to-end Earn test on testnet, exercising the REAL app path:
//   sponsored 2-of-3 account (user + Remitt-KMS + compliance, thresholds
//   2/2/2)  ->  vault deposit/withdraw via src/lib/earn-vault.ts  ->  which
//   posts to the fee-bump Edge Function, so the KMS co-signature (weight 1)
//   is REQUIRED to take the user's weight-1 signature up to the threshold-2.
//   A single-key account wouldn't test that; this one does.
//
// Run (from packages/app):
//   node --experimental-strip-types scripts/test-earn.mjs
import {
  Asset, BASE_FEE, Horizon, Keypair, Networks, Operation, TransactionBuilder,
} from '@stellar/stellar-sdk';
import { readFileSync } from 'node:fs';
import * as earn from '../src/lib/earn-vault.ts';

const cfg = readFileSync(new URL('../src/lib/stellar-config.ts', import.meta.url), 'utf8');
const pick = (n) => cfg.match(new RegExp(`${n} = '([^']+)'`))[1];
const horizon = new Horizon.Server('https://horizon-testnet.stellar.org');
const USDC = new Asset('USDC', pick('USDC_ISSUER'));
const { TREASURY_SECRET } = await import('./treasury-secret.mjs');
const treasury = Keypair.fromSecret(TREASURY_SECRET);

// The other two signers of the 2-of-3 (must match src/lib/stellar.ts and the
// activate-account Edge Function). The KMS signer's PRIVATE key is never here
// — that's the whole point: only the fee-bump function can produce its
// signature, so this test only passes if that server-side co-sign works.
const REMITT_KMS_SIGNER = 'GDBG6KN5PJ3JHAZSDVK5WN4ISCJYHAS4MB4ETB5CBI3P623P3APQI447';
const COMPLIANCE_SIGNER = 'GCBIXSUNME5SKBMA6RCKEKF3PD35LFLTYW5YJNYBRHUUFL3CCFHWH55B';

/** Create a sponsored 2-of-3 account and fund it with `amount` USDC, in one
 *  treasury-sponsored tx (mirrors the activate-account Edge Function's op
 *  list). Authorized against the account's initial 1/1/1 thresholds, so the
 *  user's single signature covers its own ops before the raise to 2/2/2. */
async function makeSponsored2of3User(amount) {
  const user = Keypair.random();
  const src = await horizon.loadAccount(treasury.publicKey());
  const tx = new TransactionBuilder(src, { fee: BASE_FEE, networkPassphrase: Networks.TESTNET })
    .addOperation(Operation.beginSponsoringFutureReserves({ sponsoredId: user.publicKey() }))
    .addOperation(Operation.createAccount({ destination: user.publicKey(), startingBalance: '0' }))
    .addOperation(Operation.changeTrust({ source: user.publicKey(), asset: USDC }))
    // user master weight 1, thresholds 2/2/2, add Remitt-KMS signer (weight 1)
    .addOperation(Operation.setOptions({
      source: user.publicKey(),
      masterWeight: 1,
      lowThreshold: 2,
      medThreshold: 2,
      highThreshold: 2,
      signer: { ed25519PublicKey: REMITT_KMS_SIGNER, weight: 1 },
    }))
    // add compliance signer (weight 1) -> now 3 signers, any 2 can act
    .addOperation(Operation.setOptions({
      source: user.publicKey(),
      signer: { ed25519PublicKey: COMPLIANCE_SIGNER, weight: 1 },
    }))
    .addOperation(Operation.endSponsoringFutureReserves({ source: user.publicKey() }))
    .addOperation(Operation.payment({ destination: user.publicKey(), asset: USDC, amount: amount.toFixed(7) }))
    .setTimeout(90).build();
  tx.sign(treasury, user);
  await horizon.submitTransaction(tx);

  // Sanity: confirm the account really is 2-of-3 before proceeding.
  const acc = await horizon.loadAccount(user.publicKey());
  if (acc.signers.length !== 3 || acc.thresholds.med_threshold !== 2) {
    throw new Error(`account is not 2-of-3: signers=${acc.signers.length} med=${acc.thresholds.med_threshold}`);
  }
  return user;
}

console.log('Net APY (fraction):', await earn.getPoolApy().then((a) => (a == null ? null : a * (1 - 0.12))));
const user = await makeSponsored2of3User(20);
console.log('user', user.publicKey().slice(0, 8), '| 2-of-3 confirmed | supplied before:', await earn.getSupplied(user.publicKey()));

console.log('Depositing $15 into the vault (via fee-bump KMS co-sign)...');
await earn.deposit(user.publicKey(), user.secret(), 15);
const afterDeposit = await earn.getSupplied(user.publicKey());
console.log('supplied after deposit:', afterDeposit);
if (afterDeposit < 14.9) throw new Error(`deposit did not land: supplied=${afterDeposit}`);

console.log('Withdrawing all (via fee-bump KMS co-sign)...');
const res = await earn.withdrawAll(user.publicKey(), user.secret());
console.log('withdrawn:', res.withdrawn);
const afterWithdraw = await earn.getSupplied(user.publicKey());
console.log('supplied after withdraw:', afterWithdraw);
if (afterWithdraw > 0.01) throw new Error(`withdraw left a residual: supplied=${afterWithdraw}`);

// Confirm the USDC actually returned to the user's wallet (Blend's to=user).
const acc = await horizon.loadAccount(user.publicKey());
const usdcBal = Number((acc.balances.find((b) => b.asset_code === 'USDC') || {}).balance || 0);
console.log('user USDC wallet balance after full cycle:', usdcBal.toFixed(7));
if (usdcBal < 19.9) throw new Error(`USDC did not return to wallet: ${usdcBal}`);

console.log('EARN_TEST_OK (2-of-3 app path: deposit + withdraw through fee-bump KMS co-sign)');
