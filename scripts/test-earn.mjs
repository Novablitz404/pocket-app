// Exercises src/lib/earn-blend.ts end-to-end on testnet with a sponsored
// (0-XLM) user. Run: node --experimental-strip-types scripts/test-earn.mjs
import {
  Asset, BASE_FEE, Horizon, Keypair, Networks, Operation, TransactionBuilder,
} from '@stellar/stellar-sdk';
import { readFileSync } from 'node:fs';
import * as earn from '../src/lib/earn-blend.ts';

const cfg = readFileSync(new URL('../src/lib/stellar-config.ts', import.meta.url), 'utf8');
const pick = (n) => cfg.match(new RegExp(`${n} = '([^']+)'`))[1];
const horizon = new Horizon.Server('https://horizon-testnet.stellar.org');
const USDC = new Asset('USDC', pick('USDC_ISSUER'));
const treasury = Keypair.fromSecret(pick('TREASURY_SECRET'));

async function makeSponsoredUser(amount) {
  const user = Keypair.random();
  const src = await horizon.loadAccount(treasury.publicKey());
  const tx = new TransactionBuilder(src, { fee: BASE_FEE, networkPassphrase: Networks.TESTNET })
    .addOperation(Operation.beginSponsoringFutureReserves({ sponsoredId: user.publicKey() }))
    .addOperation(Operation.createAccount({ destination: user.publicKey(), startingBalance: '0' }))
    .addOperation(Operation.changeTrust({ source: user.publicKey(), asset: USDC }))
    .addOperation(Operation.endSponsoringFutureReserves({ source: user.publicKey() }))
    .addOperation(Operation.payment({ destination: user.publicKey(), asset: USDC, amount: amount.toFixed(7) }))
    .setTimeout(60).build();
  tx.sign(treasury, user);
  await horizon.submitTransaction(tx);
  return user;
}

console.log('Pool APY (fraction):', await earn.getApy());
const user = await makeSponsoredUser(20);
console.log('user', user.publicKey().slice(0, 8), '| supplied before:', await earn.getSupplied(user.publicKey()));

console.log('Depositing $15 into Blend...');
await earn.deposit(user.publicKey(), user.secret(), 15);
console.log('supplied after deposit:', await earn.getSupplied(user.publicKey()));

console.log('Withdrawing all...');
const res = await earn.withdrawAll(user.publicKey(), user.secret());
console.log('withdrawn:', res.withdrawn, '| fee:', res.fee);
console.log('supplied after withdraw:', await earn.getSupplied(user.publicKey()));
console.log('EARN_TEST_OK');
