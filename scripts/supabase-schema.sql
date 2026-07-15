-- Remitt username directory. Run in Supabase → SQL Editor.
-- Maps a wallet address to a username (and, later, an avatar).

create table if not exists profiles (
  address    text primary key,
  username   text not null,
  first_name text,
  last_name  text,
  email      text,
  country    text,
  avatar_url text,
  created_at timestamptz default now()
);

-- If the table already exists, add the name columns:
alter table profiles add column if not exists first_name text;
alter table profiles add column if not exists last_name text;

-- Recovery/contact anchor collected at onboarding (no verification yet).
-- Not selected by the app's directory fetch, so other users never see it.
alter table profiles add column if not exists email text;

-- ISO 3166-1 alpha-2, inferred from the device's region setting at signup
-- (never asked). Same privacy rule as email: not served by the directory fetch.
alter table profiles add column if not exists country text;

-- Set once the address's owner proves the inbox via Supabase Auth OTP
-- (see src/lib/auth.ts). Gates account recovery.
alter table profiles add column if not exists email_verified boolean not null default false;

-- Case-insensitive unique usernames.
create unique index if not exists profiles_username_lower_key
  on profiles (lower(username));

-- Row-level security: the app uses the public anon key, so allow anon to read
-- the directory and register/update its own row. (Demo-grade — tighten later
-- so a user can only write their own address, gated by auth.uid.)
alter table profiles enable row level security;

drop policy if exists "public read" on profiles;
create policy "public read" on profiles for select using (true);

drop policy if exists "public insert" on profiles;
create policy "public insert" on profiles for insert with check (true);

-- Column-scoped update: every profile field EXCEPT email_verified is
-- anon-writable (demo-grade, same as before). email_verified is deliberately
-- excluded — it's a trust signal ("this inbox was proven"), and letting any
-- anon-key holder flag any address as verified via plain PATCH would make it
-- forgeable. It can only change via mark_email_verified() below, which
-- requires the caller's own OTP-minted JWT.
drop policy if exists "public update" on profiles;
create policy "public update" on profiles for update using (true) with check (true);
revoke update on profiles from anon;
grant update (address, username, first_name, last_name, email, country, avatar_url) on profiles to anon;

-- Sets email_verified on the profile matching the CALLER'S OWN OTP session
-- (auth.jwt() ->> 'email') — same identity pattern as recover_profile below.
-- Anon cannot call it, so the anon key alone can't forge verification for an
-- address it doesn't control the inbox for.
create or replace function public.mark_email_verified()
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update profiles set email_verified = true where email = lower(auth.jwt() ->> 'email');
end;
$$;

revoke execute on function public.mark_email_verified() from public, anon;
grant execute on function public.mark_email_verified() to authenticated;

-- Gates cash-in: on-chain account activation now happens when the user
-- verifies (see stellar.ts's activateAccount), not on first cash-in attempt.
-- PLACEHOLDER, same as the app's other "click to verify" step for now — no
-- real identity check backs this yet, it's just a user-initiated confirm.
-- verify_account is anon-callable (same trust level as username
-- registration) because there's no real verification behind it to protect
-- yet. IMPORTANT: once this gates something with real financial/compliance
-- stakes (a real KYC provider, or once cash-in moves server-side), this
-- needs the SAME tightening mark_email_verified already got — an
-- anon-callable flip of a trust-signal column is exactly the class of bug
-- Phase 0 fixed for email_verified; don't leave this one open past the
-- placeholder stage.
alter table profiles add column if not exists account_verified boolean not null default false;

create or replace function public.verify_account(p_address text)
returns void
language sql
security definer
set search_path = public
as $$
  update profiles set account_verified = true where address = p_address;
$$;

grant execute on function public.verify_account(text) to anon, authenticated;

-- Recovery passcodes: the app's 4-digit PIN doubles as the second factor for
-- account recovery (email OTP proves the inbox, the PIN proves it's you).
-- Stored as a bcrypt hash. RLS is enabled with NO policies, so the REST API
-- can never read or write this table — only the SECURITY DEFINER functions
-- below touch it. A leaked anon key therefore can't fetch hashes to
-- brute-force the 10,000-combination space offline.
-- Supabase keeps extensions in their own schema, not public — the functions
-- below need search_path to include it or crypt()/gen_salt() won't resolve.
create extension if not exists pgcrypto with schema extensions;

create table if not exists recovery_pins (
  address      text primary key,
  pin_hash     text not null,          -- bcrypt via crypt(pin, gen_salt('bf'))
  failed       int not null default 0, -- consecutive wrong tries
  locked_until timestamptz,            -- recovery refused until this passes
  updated_at   timestamptz not null default now()
);

alter table recovery_pins enable row level security;

-- Called by the app whenever the passcode is set or changed. Demo-grade:
-- anon-callable keyed on address, like every other directory write — real
-- authorization arrives with the server-side treasury. Resets the lockout so
-- a fresh PIN starts clean.
--
-- p_old_pin closes a real gap: without it, anyone holding the anon key
-- (shipped in the app, not a secret) could silently overwrite ANY address's
-- recovery PIN with zero proof of ownership — the app's own UI already
-- requires the CURRENT PIN to change it (see biometrics.ts's
-- changePasscode), the database wasn't enforcing the same rule. A brand-new
-- address (no row yet) still sets its first PIN unauthenticated — same
-- trust level username registration already has.
create or replace function public.set_recovery_pin(p_address text, p_pin text, p_old_pin text default null)
returns void
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_existing recovery_pins%rowtype;
begin
  if p_pin !~ '^\d{4}$' then
    raise exception 'Passcode must be 4 digits.';
  end if;

  select * into v_existing from recovery_pins where address = p_address;
  if found and (p_old_pin is null or v_existing.pin_hash <> crypt(p_old_pin, v_existing.pin_hash)) then
    raise exception 'Current passcode required to change it.';
  end if;

  insert into recovery_pins (address, pin_hash, failed, locked_until, updated_at)
  values (p_address, crypt(p_pin, gen_salt('bf')), 0, null, now())
  on conflict (address) do update
    set pin_hash = excluded.pin_hash, failed = 0, locked_until = null, updated_at = now();
end;
$$;

grant execute on function public.set_recovery_pin(text, text, text) to anon, authenticated;

-- Gate for the close-account Edge Function (Phase 1 of the mainnet build
-- plan): the treasury closes+reclaims an account with NO user signature to
-- lean on, so this is what stands between "any anon-key holder" and
-- griefing an arbitrary address closed. Same table/lockout as recover_profile
-- below. No PIN row on file (pre-PIN or abandoned/ghost account) returns
-- true — matches the client's pre-existing behavior of being able to close
-- ghost accounts with no reachable owner. Restricted to service_role only:
-- this isn't meant to be called directly over PostgREST, only from within
-- the Edge Function after it's decided to act on the result.
create or replace function public.verify_recovery_pin(p_address text, p_pin text)
returns boolean
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_pin recovery_pins%rowtype;
begin
  select * into v_pin from recovery_pins where address = p_address;
  if not found then
    return true;
  end if;
  if v_pin.locked_until is not null and v_pin.locked_until > now() then
    raise exception 'Too many wrong passcodes. Try again in % minute(s).',
      greatest(1, ceil(extract(epoch from v_pin.locked_until - now()) / 60));
  end if;
  if p_pin is null or v_pin.pin_hash <> crypt(p_pin, v_pin.pin_hash) then
    update recovery_pins
      set failed = v_pin.failed + 1,
          locked_until = case when v_pin.failed + 1 >= 5 then now() + interval '15 minutes' end
      where address = p_address;
    return false;
  end if;
  update recovery_pins set failed = 0, locked_until = null where address = p_address;
  return true;
end;
$$;

revoke execute on function public.verify_recovery_pin(text, text) from public, anon, authenticated;
grant execute on function public.verify_recovery_pin(text, text) to service_role;

-- Account recovery lookup. Email is deliberately absent from the directory
-- fetch, so recovery resolves email → profile through this function instead:
-- it only returns the row whose email matches the CALLER'S Supabase Auth JWT
-- (the session minted by the OTP the user just passed), and only if that
-- email was verified on the profile. Anon cannot call it, so the anon key
-- alone can't enumerate emails.
--
-- Second factor: when the account has a recovery PIN on file the caller must
-- supply it; 5 wrong tries lock recovery for 15 minutes (counted server-side,
-- so wiping the app doesn't reset it). Accounts with no PIN row (pre-PIN
-- accounts, or the one-shot sync failed) recover on the email OTP alone.
drop function if exists public.recover_profile();
create or replace function public.recover_profile(p_pin text)
returns table (address text, username text, first_name text, last_name text, country text, avatar_url text)
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_profile profiles%rowtype;
  v_pin recovery_pins%rowtype;
begin
  select p.* into v_profile
  from profiles p
  where p.email = lower(auth.jwt() ->> 'email')
    and p.email_verified
  limit 1;
  if not found then
    return; -- empty set: no recoverable account for this email
  end if;

  select rp.* into v_pin from recovery_pins rp where rp.address = v_profile.address;
  if found then
    if v_pin.locked_until is not null and v_pin.locked_until > now() then
      raise exception 'Too many wrong passcodes. Try again in % minute(s).',
        greatest(1, ceil(extract(epoch from v_pin.locked_until - now()) / 60));
    end if;
    if v_pin.pin_hash <> crypt(p_pin, v_pin.pin_hash) then
      update recovery_pins rp
        set failed = v_pin.failed + 1,
            locked_until = case when v_pin.failed + 1 >= 5
                                then now() + interval '15 minutes' end
        where rp.address = v_profile.address;
      if v_pin.failed + 1 >= 5 then
        raise exception 'Too many wrong passcodes. Try again in 15 minute(s).';
      end if;
      raise exception 'Wrong passcode. % attempt(s) left.', 5 - (v_pin.failed + 1);
    end if;
    update recovery_pins rp set failed = 0, locked_until = null
      where rp.address = v_profile.address;
  end if;

  return query select v_profile.address, v_profile.username, v_profile.first_name,
                      v_profile.last_name, v_profile.country, v_profile.avatar_url;
end;
$$;

revoke execute on function public.recover_profile(text) from public, anon;
grant execute on function public.recover_profile(text) to authenticated;

-- In-app payment requests: "ask someone" for money. A row is written when the
-- requester submits, a push notifies the payer (data.type='request'), and
-- fulfillment marks the row 'paid' once send.tsx completes the actual
-- payment. Expires after 7 days (enforced app-side: fetchPending filters on
-- expires_at, nothing purges old rows). Same demo-grade anon policies as
-- profiles/push_tokens.
create table if not exists requests (
  id          uuid primary key default gen_random_uuid(),
  from_address text not null, -- requester (who gets paid)
  to_address   text not null, -- payer (who gets asked)
  amount      numeric not null check (amount > 0),
  note        text,
  status      text not null default 'pending' check (status in ('pending', 'paid', 'declined')),
  created_at  timestamptz not null default now(),
  expires_at  timestamptz not null default now() + interval '7 days'
);

create index if not exists requests_to_address_idx on requests (to_address);
create index if not exists requests_from_address_idx on requests (from_address);

alter table requests enable row level security;

drop policy if exists "requests read" on requests;
create policy "requests read" on requests for select using (true);

-- Phase 3: creating a request moved server-side (create-request Edge Function,
-- service_role) so a request row + its notification are written together and
-- can't be forged by a bare anon POST. Anon INSERT is revoked.
drop policy if exists "requests insert" on requests;

-- Anon may still mark a request paid/declined, but ONLY the status column
-- (column grant below), so amount/from/to can't be rewritten after the fact.
drop policy if exists "requests update" on requests;
create policy "requests update" on requests for update using (true) with check (true);
revoke insert on requests from anon, authenticated;
revoke update on requests from anon, authenticated;
grant update (status) on requests to anon, authenticated;

-- In-app notification inbox: written alongside every push send (same title/
-- body/data any given push carries), so events show up in the bell icon even
-- when push itself is unavailable (Expo Go, no EAS project yet — see
-- push-notifications-activation) or the device silently missed the push.
-- Same demo-grade anon policies as profiles/push_tokens.
create table if not exists notifications (
  id         uuid primary key default gen_random_uuid(),
  address    text not null, -- recipient
  title      text not null,
  body       text not null,
  data       jsonb,
  read       boolean not null default false,
  created_at timestamptz not null default now()
);

create index if not exists notifications_address_idx on notifications (address, created_at desc);

alter table notifications enable row level security;

drop policy if exists "notifications read" on notifications;
create policy "notifications read" on notifications for select using (true);

-- Phase 3: notifications are now written ONLY server-side (service_role) — by
-- fee-bump after a real on-chain settlement ("Money received"), the on-ramp
-- delivery path (cash-in), and create-request (payment requests). Anon INSERT
-- is revoked so a "money received" claim can no longer be forged by POSTing
-- straight to this table. (Read is left open pending the per-user-identity
-- model — see the RLS follow-up note at the end of this file.)
drop policy if exists "notifications insert" on notifications;

-- Anon may still mark a notification read, but ONLY the `read` column (column
-- grant below), so an attacker can't rewrite an existing row's title/body into
-- a fake alert.
drop policy if exists "notifications update" on notifications;
create policy "notifications update" on notifications for update using (true) with check (true);
-- Revoke from BOTH anon AND authenticated: a user can obtain an authenticated
-- JWT via email OTP, and Supabase grants `authenticated` table privileges by
-- default, so revoking only anon would leave the forge-a-notification hole open
-- to any logged-in token. service_role (the Edge Functions) keeps its grants.
revoke insert on notifications from anon, authenticated;
revoke update on notifications from anon, authenticated;
grant update (read) on notifications to anon, authenticated;

-- Earn growth history: an append-only log of each user's own (supplied,
-- net_deposited) pair, so the Earn screen can chart earnings over time.
-- Written by the app itself (see earn-ledger.ts's maybeRecordSnapshot,
-- throttled to ~1 row/15min per address) since only the user's own device
-- knows their balance — nothing server-side tracks per-user positions yet
-- (that arrives with the treasury backend). Same demo-grade anon policies as
-- profiles; no update/delete, it's a log.
--
-- Deliberately does NOT store the pool's APY — that's a pool-level property,
-- identical for every user, so logging it once per user-snapshot would mean
-- N users independently reading the same Soroban reserve state and writing
-- N near-duplicate rows. See blend_pool_rates below for the single-writer
-- version of that history.
create table if not exists earn_snapshots (
  id            uuid primary key default gen_random_uuid(),
  address       text not null,
  supplied      numeric not null,
  net_deposited numeric not null,
  created_at    timestamptz not null default now()
);

create index if not exists earn_snapshots_address_idx on earn_snapshots (address, created_at);

alter table earn_snapshots enable row level security;

drop policy if exists "earn_snapshots read" on earn_snapshots;
create policy "earn_snapshots read" on earn_snapshots for select using (true);

drop policy if exists "earn_snapshots insert" on earn_snapshots;
create policy "earn_snapshots insert" on earn_snapshots for insert with check (true);

-- Blend pool supply-APY history: one global time series, not one per user.
-- Written by the record-pool-rate Edge Function (supabase/functions/
-- record-pool-rate) on a schedule — a single reader of the pool's reserve
-- state, instead of every user's device independently hitting the Soroban
-- RPC for the same number. The function inserts with the service role key,
-- so the policy below is really just a demo-grade fallback / manual-testing
-- allowance (e.g. scripts/record-pool-rate.mjs run by hand). No address
-- column: this is pool-wide, shared by every Earn position.
create table if not exists blend_pool_rates (
  id         uuid primary key default gen_random_uuid(),
  apy        numeric not null,
  created_at timestamptz not null default now()
);

create index if not exists blend_pool_rates_created_at_idx on blend_pool_rates (created_at);

alter table blend_pool_rates enable row level security;

drop policy if exists "blend_pool_rates read" on blend_pool_rates;
create policy "blend_pool_rates read" on blend_pool_rates for select using (true);

-- Phase 3: this APY history is pool-wide and shown to EVERY Earn user, so a
-- forged row is a shared-integrity problem (a fake yield line for everyone).
-- Only the record-pool-rate Edge Function (service_role, pg_cron every 15 min)
-- should write it — revoke the demo-grade anon INSERT.
drop policy if exists "blend_pool_rates insert" on blend_pool_rates;
revoke insert on blend_pool_rates from anon, authenticated;

-- Schedule the deployed Edge Function every 15 minutes via pg_cron + pg_net.
-- Run this block AFTER `supabase functions deploy record-pool-rate` (it's a
-- no-op harmlessly re-runnable, but the URL/key below must be filled in —
-- see supabase/functions/record-pool-rate/index.ts for deploy instructions).
create extension if not exists pg_cron with schema extensions;
create extension if not exists pg_net with schema extensions;

-- Unschedule first so re-running this file doesn't create a duplicate job
-- under the same name (cron.schedule's named-job upsert isn't consistent
-- across pg_cron versions).
select cron.unschedule(jobid) from cron.job where jobname = 'record-pool-rate';

select cron.schedule(
  'record-pool-rate',
  '*/15 * * * *',
  $$
  select net.http_post(
    url := 'https://ggapuomnnocuumwrgfnt.supabase.co/functions/v1/record-pool-rate',
    headers := jsonb_build_object(
      'Authorization', 'Bearer REPLACE_WITH_ANON_OR_SERVICE_ROLE_KEY',
      'Content-Type', 'application/json'
    )
  );
  $$
);

-- Push notifications: one row per device (Expo push token), many devices per
-- address. Written by the app on start; read by the sender's app to notify a
-- payment recipient, and by scripts/send-announcement.mjs /
-- scripts/send-yield-digest.mjs. Same demo-grade anon policies as profiles.
create table if not exists push_tokens (
  token      text primary key, -- ExponentPushToken[...]
  address    text not null,
  platform   text,             -- 'ios' | 'android'
  updated_at timestamptz not null default now()
);

create index if not exists push_tokens_address_idx on push_tokens (address);

alter table push_tokens enable row level security;

drop policy if exists "push_tokens read" on push_tokens;
create policy "push_tokens read" on push_tokens for select using (true);

drop policy if exists "push_tokens insert" on push_tokens;
create policy "push_tokens insert" on push_tokens for insert with check (true);

drop policy if exists "push_tokens update" on push_tokens;
create policy "push_tokens update" on push_tokens for update using (true) with check (true);

drop policy if exists "push_tokens delete" on push_tokens;
create policy "push_tokens delete" on push_tokens for delete using (true);

-- Profile pictures live in the 'avatars' storage bucket (one <address>.jpg
-- per user, ~256px JPEG uploaded by the app). The bucket must be PUBLIC
-- (Storage → avatars → make public) so avatar_url works without signing.
-- The app writes with the anon key, so allow anon insert/update on the bucket
-- (demo-grade, same caveat as the profiles policies above).
drop policy if exists "avatars read" on storage.objects;
create policy "avatars read" on storage.objects
  for select using (bucket_id = 'avatars');

drop policy if exists "avatars insert" on storage.objects;
create policy "avatars insert" on storage.objects
  for insert with check (bucket_id = 'avatars');

drop policy if exists "avatars update" on storage.objects;
create policy "avatars update" on storage.objects
  for update using (bucket_id = 'avatars') with check (bucket_id = 'avatars');

-- Channel-account pool (Instawards D1 — concurrency fix for activate-account).
-- A Stellar account can only have one transaction in flight at a time; using
-- the treasury as activate-account's transaction source meant concurrent
-- signups collided on its single sequence number (tx_bad_seq). This table
-- holds a small pool of dedicated channel accounts (seeded by
-- scripts/setup-channel-accounts.mjs) that each provide their OWN sequence
-- number instead — the native Stellar pattern for this problem:
-- developers.stellar.org/docs/build/guides/transactions/channel-accounts.
--
-- No anon/authenticated grants at all: only the reserve-channel and
-- activate-account Edge Functions (service_role) ever touch this table.
create table if not exists channel_accounts (
  public_key   text primary key,
  secret       text not null,
  busy         boolean not null default false,
  locked_until timestamptz,
  created_at   timestamptz not null default now()
);

alter table channel_accounts enable row level security;

-- Atomically claims one free (or stale-leased) channel account and marks it
-- busy with a short lease — "skip locked" is what makes two concurrent
-- reservations never race the same row. The lease self-heals a channel stuck
-- busy if a request crashes before releasing it (release_channel_account
-- below); activate-account still always calls that explicitly on its way
-- out (success or failure) as the primary path, the lease is a backstop.
create or replace function public.claim_channel_account(p_lease_seconds int default 60)
returns table (public_key text, secret text)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_key text;
begin
  select ca.public_key into v_key
  from channel_accounts ca
  where not ca.busy or ca.locked_until < now()
  order by ca.public_key
  limit 1
  for update skip locked;

  if v_key is null then
    raise exception 'no channel accounts available';
  end if;

  update channel_accounts
    set busy = true, locked_until = now() + make_interval(secs => p_lease_seconds)
    where channel_accounts.public_key = v_key;

  return query select ca.public_key, ca.secret from channel_accounts ca where ca.public_key = v_key;
end;
$$;

revoke execute on function public.claim_channel_account(int) from public, anon, authenticated;
grant execute on function public.claim_channel_account(int) to service_role;

-- Releases a channel account back to the pool. Called unconditionally
-- (success or failure) by activate-account after it's done with a channel.
create or replace function public.release_channel_account(p_public_key text)
returns void
language sql
security definer
set search_path = public
as $$
  update channel_accounts set busy = false, locked_until = null where public_key = p_public_key;
$$;

revoke execute on function public.release_channel_account(text) from public, anon, authenticated;
grant execute on function public.release_channel_account(text) to service_role;

-- ---------------------------------------------------------------------------
-- Account freeze list (2-of-3 custody). Freezing is enforced OFF-CHAIN: since
-- every user send must be co-signed by Remitt-KMS in the fee-bump function,
-- freezing an account is simply Remitt refusing to co-sign it — no on-chain
-- transaction, no signer/threshold change. This table is the source of truth
-- that fee-bump checks (assertNotFrozen) before adding its co-signature.
--
-- Keyed by on-chain address (not profile), so it works for any account whether
-- or not it has a profiles row. RLS on with no anon/authenticated policies =>
-- only service_role (the Edge Functions) can read/write; the anon key can't
-- see or change the freeze list. Managed by the admin-only set-freeze function.
create table if not exists public.frozen_accounts (
  address    text primary key,
  reason     text,
  frozen_at  timestamptz not null default now()
);
alter table public.frozen_accounts enable row level security;
revoke all on public.frozen_accounts from anon, authenticated;
grant all on public.frozen_accounts to service_role;

-- ---------------------------------------------------------------------------
-- Off-ramp payout queue (Phase 3). A cash-out sends the user's USDC to the
-- treasury on Stellar; nothing yet converts that to fiat. fee-bump — the choke
-- point every user cash-out passes through — writes a pending row here the
-- moment it submits such a payment (see emitClassicSideEffects), so an operator
-- (Phase 2.1 dashboard) can disburse the fiat and mark it paid. This is the
-- settlement-detection step the off-ramp mainnet blocker needs; the same row is
-- what a partner-specific disbursement call would consume later.
--
-- tx_hash is unique so the enqueue is idempotent — a fee-bump retry or the
-- reconciliation watcher (which re-scans the treasury's incoming USDC) can
-- upsert without creating duplicate payouts. RLS on, service_role only (the
-- dashboard reads/writes it through an admin-gated Edge Function, never the
-- browser directly).
create table if not exists public.offramp_payouts (
  id            uuid primary key default gen_random_uuid(),
  address       text not null,                 -- the user who cashed out (payment source)
  amount        numeric not null check (amount > 0),  -- USDC delivered to the treasury
  memo          text,                          -- cash-out memo / destination tag, if any
  tx_hash       text not null unique,          -- settlement tx (dedup key)
  status        text not null default 'pending' check (status in ('pending', 'paid', 'failed')),
  operator_note text,
  created_at    timestamptz not null default now(),
  paid_at       timestamptz
);
create index if not exists offramp_payouts_status_idx on public.offramp_payouts (status, created_at);
alter table public.offramp_payouts enable row level security;
revoke all on public.offramp_payouts from anon, authenticated;
grant all on public.offramp_payouts to service_role;

-- ---------------------------------------------------------------------------
-- RLS FOLLOW-UP (Phase 3 residual — needs the per-user identity model, tracked
-- separately). The custodial app authenticates to Supabase with the shared anon
-- key, so RLS can't yet scope rows to their owner. Phase 3 closed the writes
-- that let anyone forge a MONEY-MOVEMENT claim (notifications/requests INSERT →
-- server-only; blend_pool_rates INSERT → cron-only). Still open, and deliberately
-- left until per-user JWTs exist:
--   * notifications/requests/profiles SELECT are open (using(true)) — a privacy
--     leak (read others' rows), not a spoof. Scope to auth.uid once users carry
--     their own JWT.
--   * push_tokens (register/update/delete open) — registering a token for
--     someone else's address could hijack their push. Bundle with Phase 5 push
--     activation (identity + address-ownership check), since push is dormant in
--     Expo Go today.
--   * earn_snapshots INSERT open — a user can only distort their OWN earnings
--     graph, so it's self-harm; move server-side when Earn settlement does.
