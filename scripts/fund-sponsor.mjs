// Stage 2 funding bridge: tops up the Sponsor G-account's XLM from Treasury
// fee revenue (which is denominated in USDC).
//
// Full path:
//   1. Treasury.claim_all_fees()  — realize accrued vault fee-shares into USDC
//      held by the Treasury contract           (admin-gated: remitt-admin)
//   2. Treasury.sweep(to=Sponsor, amount)      — move USDC contract -> Sponsor
//      (admin-gated; SAC transfer to the classic Sponsor account, which holds a
//       USDC trustline)
//   3. Sponsor SDEX pathPaymentStrictSend USDC -> XLM, destination = self, with
//      a slippage floor                          (Sponsor-key-signed)
//
// Why the swap is on the classic SDEX and not inside the contract: a Soroban
// contract CANNOT place classic offers or path payments — SDEX is a classic-
// layer feature. The Sponsor is a classic G-account, so it does the swap
// natively (the reverse swap already ships in fund-treasury.mjs). This also
// keeps all swap/slippage risk OFF the pooled-fund Treasury contract.
//
// Only sweep what Sponsor actually needs for gas/reserves — fee revenue that
// transits the always-online Sponsor hot key is bounded by `amount`, never the
// whole treasury balance.
//
// Run:
//   node scripts/fund-sponsor.mjs <amountUSDC> [--claim] [--slippage 0.005]
//   node scripts/fund-sponsor.mjs <amountUSDC> --swap-only   # skip 1+2, swap USDC already in Sponsor
import {
  Asset,
  BASE_FEE,
  Horizon,
  Keypair,
  Networks,
  Operation,
  TransactionBuilder,
} from '@stellar/stellar-sdk';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const cfg = readFileSync(new URL('../src/lib/stellar-config.ts', import.meta.url), 'utf8');
const pick = (name) => cfg.match(new RegExp(`${name} = '([^']+)'`))[1];
const HORIZON_URL = pick('HORIZON_URL');
const USDC_ISSUER = pick('USDC_ISSUER');
const TREASURY_ID = pick('TREASURY_ID'); // the Treasury CONTRACT
const SPONSOR_PUBLIC = pick('TREASURY_PUBLIC'); // the Sponsor G-account (legacy key name)
const { TREASURY_SECRET: SPONSOR_SECRET } = await import('./treasury-secret.mjs');

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const opt = (name, def) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : def;
};
const positional = args.filter((a) => !a.startsWith('--') && args[args.indexOf(a) - 1]?.startsWith('--') !== true);
const amountUSDC = positional[0];
if (!amountUSDC || Number.isNaN(Number(amountUSDC)) || Number(amountUSDC) <= 0) {
  console.error('Usage: node scripts/fund-sponsor.mjs <amountUSDC> [--claim] [--slippage 0.005] [--swap-only]');
  process.exit(1);
}
// Default 0.5%: fine for mainnet USDC/XLM, one of Stellar's deepest markets
// (path payments route SDEX order book + AMM pools). On thin testnet liquidity
// you may need to widen this (validation used 0.15). On a persistent
// op_under_dest_min we re-quote + retry rather than widening blindly.
const slippage = Number(opt('--slippage', '0.005'));
const swapOnly = flag('--swap-only');
const doClaim = flag('--claim');
const stroops = Math.round(Number(amountUSDC) * 1e7).toString();

const server = new Horizon.Server(HORIZON_URL);
const USDC = new Asset('USDC', USDC_ISSUER);
const sponsor = Keypair.fromSecret(SPONSOR_SECRET);
if (sponsor.publicKey() !== SPONSOR_PUBLIC) {
  console.error('Sponsor secret does not match TREASURY_PUBLIC in stellar-config.ts');
  process.exit(1);
}

const invoke = (fn, ...fnArgs) =>
  execFileSync(
    'stellar',
    ['contract', 'invoke', '--id', TREASURY_ID, '--source', 'remitt-admin', '--network', 'testnet', '--', fn, ...fnArgs],
    { encoding: 'utf8' },
  ).trim();

// ---- 1 + 2: realize + sweep fee revenue from the Treasury contract ----
if (!swapOnly) {
  if (doClaim) {
    console.log('claim_all_fees: realizing accrued vault fee-shares into USDC...');
    const claimed = invoke('claim_all_fees');
    console.log(`  claimed USDC (stroops): ${claimed}`);
  }
  const available = invoke('usdc_balance');
  console.log(`Treasury contract realized USDC (stroops): ${available}`);
  if (BigInt(available.replace(/"/g, '')) < BigInt(stroops)) {
    console.error(
      `Treasury only holds ${available} stroops USDC; cannot sweep ${stroops}. ` +
        `Run with --claim first (needs accrued yield), or lower the amount.`,
    );
    process.exit(1);
  }
  console.log(`sweep: moving ${amountUSDC} USDC from Treasury contract -> Sponsor ${SPONSOR_PUBLIC}...`);
  invoke('sweep', '--to', SPONSOR_PUBLIC, '--amount', stroops);
}

// ---- 3: swap USDC -> XLM on the classic SDEX, into the Sponsor itself ----
// Re-quote + retry on op_under_dest_min: the price can move between quote and
// execution, so on a tight slippage bound the right response is a fresh quote,
// not a wider tolerance. We keep `slippage` fixed and just re-quote a few times.
console.log(`SDEX: swapping ${amountUSDC} USDC -> XLM (dest = Sponsor self, slippage ${slippage * 100}%)...`);
const MAX_ATTEMPTS = 4;
let swapped = false;
for (let attempt = 1; attempt <= MAX_ATTEMPTS && !swapped; attempt++) {
  const paths = await server
    .strictSendPaths(USDC, amountUSDC, [Asset.native()])
    .call()
    .catch(() => ({ records: [] }));
  const best = paths.records?.[0];
  if (!best) {
    console.error('No SDEX path found USDC -> XLM for this amount (thin liquidity?). Try a smaller amount.');
    process.exit(1);
  }
  const destMin = (Number(best.destination_amount) * (1 - slippage)).toFixed(7);
  console.log(
    `  attempt ${attempt}/${MAX_ATTEMPTS}: best SDEX return ${best.destination_amount} XLM; destMin ${destMin} XLM`,
  );

  const account = await server.loadAccount(sponsor.publicKey());
  const tx = new TransactionBuilder(account, { fee: BASE_FEE, networkPassphrase: Networks.TESTNET })
    .addOperation(
      Operation.pathPaymentStrictSend({
        sendAsset: USDC,
        sendAmount: amountUSDC,
        destination: sponsor.publicKey(),
        destAsset: Asset.native(),
        destMin,
      }),
    )
    .setTimeout(60)
    .build();
  tx.sign(sponsor);

  try {
    await server.submitTransaction(tx);
    swapped = true;
  } catch (e) {
    const codes = e?.response?.data?.extras?.result_codes;
    const opCode = codes?.operations?.[0];
    if (opCode === 'op_under_dest_min' && attempt < MAX_ATTEMPTS) {
      console.log('  price moved past destMin — re-quoting and retrying...');
      continue;
    }
    console.error('SDEX swap failed:', JSON.stringify(codes ?? e.message));
    console.error('  (persistent op_under_dest_min = real market move / thin moment; widen --slippage deliberately if intended.)');
    process.exit(1);
  }
}

const after = await server.loadAccount(sponsor.publicKey());
const xlm = after.balances.find((b) => b.asset_type === 'native');
const usdc = after.balances.find((b) => b.asset_code === 'USDC');
console.log(`Done. Sponsor now holds ${xlm?.balance} XLM, ${usdc?.balance} USDC.`);
