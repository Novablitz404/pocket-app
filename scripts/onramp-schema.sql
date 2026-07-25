-- On-ramp (cash-in) — Phase O1 schema. Paste into the Supabase SQL editor
-- (project ggapuomnnocuumwrgfnt). Idempotent. Also folded into
-- scripts/supabase-schema.sql.
--
-- A cash-in INTENT records "user X intends to pay ₱N; deliver $M USDC when the
-- matching PHP deposit lands." Deposit detection (Phase O3) flips it matched →
-- the gated deliver-cash-in function pays the USDC and flips it delivered.
-- service_role only: the app creates intents through a gated Edge Function (O2)
-- and the delivery/status transitions are server-side — a user must never be
-- able to mark their own intent delivered (that would be free money).
create table if not exists public.cash_in_intents (
  id            uuid primary key default gen_random_uuid(),
  address       text not null,                         -- recipient user's Stellar address
  amount_php    numeric not null check (amount_php > 0),   -- what the user will pay in
  amount_usdc   numeric not null check (amount_usdc > 0),  -- what we deliver (quoted at intent time)
  match_ref     text,                                  -- unique hint shown to the user (e.g. centavo suffix)
  sender_name   text,                                  -- matched coins.ph sender name
  deposit_ref   text,                                  -- coins.ph referenceNumber once matched (dedup)
  status        text not null default 'pending'
                  check (status in ('pending', 'matched', 'delivered', 'expired', 'failed')),
  tx_hash       text,                                  -- USDC delivery tx
  operator_note text,
  created_at    timestamptz not null default now(),
  expires_at    timestamptz not null default now() + interval '2 hours',
  delivered_at  timestamptz
);
create index if not exists cash_in_intents_status_idx on public.cash_in_intents (status, created_at);
-- One intent per real coins.ph deposit — dedup so a re-scan can't double-deliver.
create unique index if not exists cash_in_intents_deposit_ref_key
  on public.cash_in_intents (deposit_ref) where deposit_ref is not null;

alter table public.cash_in_intents enable row level security;
revoke all on public.cash_in_intents from anon, authenticated;
grant  all on public.cash_in_intents to service_role;
