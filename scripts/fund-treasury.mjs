// Funds the treasury with USDC by swapping XLM on the Stellar DEX.
// The treasury already holds testnet XLM (from friendbot) and a USDC
// trustline; this acquires USDC to distribute on user cash-ins.
//
// Run: node scripts/fund-treasury.mjs [amountUSDC]
import {
  Asset,
  BASE_FEE,
  Horizon,
  Keypair,
  Networks,
  Operation,
  TransactionBuilder,
} from '@stellar/stellar-sdk';
import { readFileSync } from 'node:fs';

const cfg = readFileSync(new URL('../src/lib/stellar-config.ts', import.meta.url), 'utf8');
const pick = (name) => cfg.match(new RegExp(`${name} = '([^']+)'`))[1];
const HORIZON_URL = pick('HORIZON_URL');
const USDC_ISSUER = pick('USDC_ISSUER');
const TREASURY_SECRET = pick('TREASURY_SECRET');

const want = process.argv[2] ?? '1000';
const server = new Horizon.Server(HORIZON_URL);
const USDC = new Asset('USDC', USDC_ISSUER);
const treasury = Keypair.fromSecret(TREASURY_SECRET);

console.log(`Swapping XLM → ${want} USDC on the DEX...`);
const account = await server.loadAccount(treasury.publicKey());
const tx = new TransactionBuilder(account, {
  fee: BASE_FEE,
  networkPassphrase: Networks.TESTNET,
})
  .addOperation(
    Operation.pathPaymentStrictReceive({
      sendAsset: Asset.native(),
      sendMax: (Number(want) * 3).toString(), // generous slippage buffer
      destination: treasury.publicKey(),
      destAsset: USDC,
      destAmount: want,
    }),
  )
  .setTimeout(60)
  .build();
tx.sign(treasury);

try {
  await server.submitTransaction(tx);
} catch (e) {
  console.error('Swap failed:', JSON.stringify(e?.response?.data?.extras?.result_codes ?? e.message));
  process.exit(1);
}

const after = await server.loadAccount(treasury.publicKey());
const bal = after.balances.find((b) => b.asset_code === 'USDC');
console.log('Done. Treasury USDC balance:', bal?.balance);
