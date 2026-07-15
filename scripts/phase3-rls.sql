-- Phase 3 schema deltas — paste into the Supabase SQL editor
-- (project ggapuomnnocuumwrgfnt). Idempotent; safe to re-run.
--
-- ⚠️ ORDER: ship the NEW app build FIRST. These revokes break the OLD client's
-- direct notification/request inserts (they now go through the fee-bump and
-- create-request Edge Functions instead). On testnet mid-dev that's expected.
--
-- What this closes: a "Money received" inbox row (a claim funds settled) can no
-- longer be forged by any anon- OR authenticated-token holder POSTing to the
-- table — only the Edge Functions (service_role) write notifications now, and
-- only fee-bump emits "received", after a real on-chain submit.

-- 1) notifications: server-written only; clients may still toggle only `read`.
drop policy if exists "notifications insert" on notifications;
drop policy if exists "notifications update" on notifications;
create policy "notifications update" on notifications for update using (true) with check (true);
revoke insert on notifications from anon, authenticated;
revoke update on notifications from anon, authenticated;
grant  update (read) on notifications to anon, authenticated;

-- 2) requests: created via the create-request Edge Function; clients may still
--    change only `status` (mark paid / declined).
drop policy if exists "requests insert" on requests;
drop policy if exists "requests update" on requests;
create policy "requests update" on requests for update using (true) with check (true);
revoke insert on requests from anon, authenticated;
revoke update on requests from anon, authenticated;
grant  update (status) on requests to anon, authenticated;

-- 3) blend_pool_rates: the Earn APY history is pool-wide and shown to every
--    user, so lock inserts to the record-pool-rate cron (service_role).
drop policy if exists "blend_pool_rates insert" on blend_pool_rates;
revoke insert on blend_pool_rates from anon, authenticated;

-- 4) offramp_payouts: off-ramp settlement queue. fee-bump enqueues a pending row
--    when a cash-out (USDC -> treasury) settles; the operator dashboard (Phase
--    2.1) disburses fiat and marks it paid. service_role only. tx_hash unique
--    => idempotent enqueue (a retry / reconciliation can't double-pay).
create table if not exists public.offramp_payouts (
  id            uuid primary key default gen_random_uuid(),
  address       text not null,                        -- user who cashed out (payment source)
  amount        numeric not null check (amount > 0),  -- USDC delivered to treasury
  memo          text,                                 -- cash-out memo / destination tag, if any
  tx_hash       text not null unique,                 -- settlement tx (dedup key)
  status        text not null default 'pending' check (status in ('pending', 'paid', 'failed')),
  operator_note text,
  created_at    timestamptz not null default now(),
  paid_at       timestamptz
);
create index if not exists offramp_payouts_status_idx on public.offramp_payouts (status, created_at);
alter table public.offramp_payouts enable row level security;
revoke all on public.offramp_payouts from anon, authenticated;
grant  all on public.offramp_payouts to service_role;
