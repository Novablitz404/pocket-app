# Remitt

A custodial USDC wallet on Stellar (Expo / React Native), with Soroban-powered savings
(Blend) and a Supabase Edge Functions backend.

## What it does

- **Wallet**: send, receive, and cash in/out USDC on Stellar. New accounts are lazily
  activated — nothing touches the chain until the first deposit — with reserves
  sponsored by Remitt's treasury so users never need to hold XLM.
- **Earn**: deposit USDC into the [Blend](https://www.blend.capital) lending pool
  (Soroban) to earn the pool's live supply APY; withdraw anytime.
- **Custodial recovery**: a treasury co-signer (weight 2) on every user account backs
  email-OTP + PIN account recovery, freeze, and close — no seed phrases.
- **Server-side treasury**: privileged operations (fee-bumping user transactions,
  account activation, recovery, closure) are signed by Supabase Edge Functions holding
  the treasury key server-side — the app itself never ships the treasury secret.

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
