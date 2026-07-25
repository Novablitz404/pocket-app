# Pocket

A custodial USDC wallet on Stellar (Expo / React Native), with Soroban-powered savings
(Blend) and a Supabase Edge Functions backend. Pocket is a cash-app-style wallet: send
money to a username, hold a dollar balance, earn yield, and cash in/out to local rails —
without the user ever touching a seed phrase or holding XLM for gas.

> **Status:** invite-only beta, testnet. Mainnet launch is gated on the checklist tracked
> internally (key custody hardening, ramp integration, app-store distribution).

## What it does

- **Wallet**: send, receive, and cash in/out USDC on Stellar. Pay any Pocket user by
  username, or send to an external Stellar address. The account is created on-chain at
  signup — ready to receive from the first moment — with reserves and gas sponsored by
  Pocket so users never need to hold XLM.
- **Earn**: deposit USDC to earn a live supply APY through the **Pocket vault** — a
  pooled Soroban savings contract (in active development, `../contracts`) where Pocket
  takes a share of the yield, never the principal. Withdraw anytime.
- **Cash in / out**: on- and off-ramp to local fiat rails. We're finalizing the
  **coins.ph** integration for Philippines on-ramp and off-ramp, and **OwlPay** for US
  on-ramp and off-ramp — turning a bank/e-wallet transfer into a USDC balance and back.
- **2-of-3 custody (multisig + KMS/HSM)**: every user account is a Stellar 2-of-3 — the
  user's device key, a Pocket key held in Google Cloud KMS, and a compliance key (each
  weight 1, thresholds 2/2/2). Any two can act; no single key can. The treasury only
  sponsors reserves and pays gas — it is **not** a signer on user accounts, so a treasury
  leak can't move user funds. Backs email-OTP + PIN recovery, freeze, and close — no seed
  phrases. The Pocket signing key runs in Cloud KMS today; **before mainnet launch it
  moves to an HSM protection level** for hardware-backed key isolation.
- **Server-side signing**: privileged operations (co-signing user sends via KMS, account
  activation, recovery, closure, freeze) run in Supabase Edge Functions; the Pocket
  signing key lives in Google Cloud KMS and never ships in the app bundle.

See **[docs/security-custody.md](./docs/security-custody.md)** for the full custody
design (signing model, key custody, per-flow diagrams, security properties) and
**[docs/custody-testing.md](./docs/custody-testing.md)** for how each flow was verified
on testnet.

## Stack

- Expo / React Native (`src/app` — file-based routing, `src/lib` — Stellar + Supabase
  clients, `src/components`)
- [`@stellar/stellar-sdk`](https://github.com/stellar/js-stellar-sdk) for building and
  signing Stellar/Soroban transactions
- Supabase: Postgres (directory, recovery PINs, notifications, ramp intents), Auth (email
  OTP), Edge Functions (`supabase/functions/`) for treasury-signed operations, `pg_cron`
  for scheduled jobs
- Soroban smart contracts (`../contracts` — Rust) for the pooled Earn vault

## Setup

```bash
npm install
node scripts/setup-testnet.mjs         # generates a fresh testnet treasury keypair and
                                        # writes src/lib/stellar-config.ts (gitignored —
                                        # never commit it, it holds a private key)
node scripts/switch-network.mjs testnet # regenerate stellar-config.ts for a network
                                        # (testnet | mainnet)
npx expo start
```

Copy your Supabase project URL/anon key and the split Soroban RPC URLs into `.env`
(`EXPO_PUBLIC_SUPABASE_URL`, `EXPO_PUBLIC_SUPABASE_ANON_KEY`,
`EXPO_PUBLIC_SOROBAN_RPC_URL_TESTNET`, `EXPO_PUBLIC_SOROBAN_RPC_URL_MAINNET`) and run
`scripts/supabase-schema.sql` in the Supabase SQL editor. Deploy the Edge Functions in
`supabase/functions/` with `npx supabase functions deploy <name>` and set the required
secrets (`STELLAR_NETWORK`, `SOROBAN_RPC_URL_TESTNET`/`_MAINNET`, and the KMS/treasury
credentials) via `npx supabase secrets set <KEY>=...`.

## License

MIT — see [LICENSE](./LICENSE).
