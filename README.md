# Remitt

A custodial USDC wallet on Stellar (Expo / React Native), with Soroban-powered savings
(Blend) and a Supabase Edge Functions backend.

## What it does

- **Wallet**: send, receive, and cash in/out USDC on Stellar. New accounts are lazily
  activated — nothing touches the chain until the first deposit — with reserves
  sponsored by Remitt's treasury so users never need to hold XLM.
- **Earn**: deposit USDC into the [Blend](https://www.blend.capital) lending pool
  (Soroban) to earn the pool's live supply APY; withdraw anytime.
- **2-of-3 custody (multisig + KMS)**: every user account is a Stellar 2-of-3 — the
  user's device key, a Remitt key held in Google Cloud KMS, and a compliance key (each
  weight 1, thresholds 2/2/2). Any two can act; no single key can. The treasury only
  sponsors reserves and pays gas — it is **not** a signer on user accounts, so a
  treasury leak can't move user funds. Backs email-OTP + PIN recovery, freeze, and
  close — no seed phrases.
- **Server-side signing**: privileged operations (co-signing user sends via KMS,
  account activation, recovery, closure, freeze) run in Supabase Edge Functions; the
  Remitt signing key lives in Google Cloud KMS and never ships in the app bundle.

See **[docs/security-custody.md](./docs/security-custody.md)** for the full custody
design (signing model, key custody, per-flow diagrams, security properties) and
**[docs/custody-testing.md](./docs/custody-testing.md)** for how each flow was verified
on testnet.

## Stack

- Expo / React Native (`src/app` — file-based routing, `src/lib` — Stellar + Supabase
  clients, `src/components`)
- [`@stellar/stellar-sdk`](https://github.com/stellar/js-stellar-sdk) for building and
  signing Stellar/Soroban transactions
- Supabase: Postgres (directory, recovery PINs, notifications), Auth (email OTP),
  Edge Functions (`supabase/functions/`) for treasury-signed operations, `pg_cron` for
  scheduled jobs

## Setup

```bash
npm install
node scripts/setup-testnet.mjs   # generates a fresh testnet treasury keypair and
                                  # writes src/lib/stellar-config.ts (gitignored —
                                  # never commit this file, it holds a private key)
npx expo start
```

Copy `.env.example`-style Supabase project URL/anon key into `.env`
(`EXPO_PUBLIC_SUPABASE_URL`, `EXPO_PUBLIC_SUPABASE_ANON_KEY`) and run
`scripts/supabase-schema.sql` in the Supabase SQL editor. Deploy the Edge Functions in
`supabase/functions/` with `npx supabase functions deploy <name>` and set
`TREASURY_SECRET` via `npx supabase secrets set TREASURY_SECRET=...`.

## License

MIT — see [LICENSE](./LICENSE).
