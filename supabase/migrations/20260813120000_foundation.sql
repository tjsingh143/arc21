-- =============================================================================
-- Arc 21 — 0000 Foundation
--
-- Schemas, enum domains and shared helper functions.
--
-- Two rules govern every later migration in this directory:
--
--   1. Nothing in `public` is reachable by a client unless it was GRANTed
--      explicitly. Every table is created, then immediately REVOKEd from
--      `anon` / `authenticated`, then granted the narrowest privilege that the
--      product actually needs. Row Level Security filters rows; GRANTs decide
--      whether the verb exists at all. Both are used, because a policy alone is
--      a single point of failure.
--
--   2. The `private` schema is not reachable by any API role. It is not listed
--      in `[api] schemas` in config.toml, and it carries no USAGE grant for
--      anon, authenticated or even service_role. Server code reaches it through
--      SECURITY DEFINER functions in `public` owned by `postgres`.
-- =============================================================================

-- gen_random_uuid() is core in PG13+, but pgcrypto also supplies digest() which
-- the daily-challenge seed commitment verification uses server-side.
create extension if not exists pgcrypto with schema extensions;

-- -----------------------------------------------------------------------------
-- The server-only schema
-- -----------------------------------------------------------------------------

create schema if not exists private;

comment on schema private is
  'Server-only state. Holds future shoe order and the dealer hole card. Not exposed through the Data API and carries no grants to anon, authenticated or service_role. Reached only via SECURITY DEFINER functions owned by postgres.';

revoke all on schema private from public;
revoke all on schema private from anon, authenticated, service_role;
grant usage on schema private to postgres;

-- Belt and braces: even if a future migration forgets an explicit REVOKE, no
-- object created in `private` by `postgres` will be granted to an API role.
alter default privileges in schema private
  revoke all on tables from anon, authenticated, service_role;
alter default privileges in schema private
  revoke all on sequences from anon, authenticated, service_role;
alter default privileges in schema private
  revoke all on functions from anon, authenticated, service_role;

-- The same protection for `public`: default-deny, then grant per table.
--
-- `service_role` is in this list for a reason that is easy to miss. The stock
-- default ACL for a table created by `postgres` is
-- `{postgres=arwdDxtm/postgres,service_role=Dxtm/postgres}` — service_role gets
-- no SELECT/INSERT/UPDATE/DELETE, but it does get TRUNCATE, REFERENCES and
-- TRIGGER. TRUNCATE is not seen by any FOR EACH ROW guard, so the one verb a
-- leaked service key would otherwise retain on every table in this schema is
-- mass deletion. The server reaches this schema as `postgres` or through a
-- SECURITY DEFINER function owned by `postgres` (see DATABASE.md), so
-- service_role needs no table privilege at all.
alter default privileges in schema public
  revoke all on tables from anon, authenticated, service_role;
alter default privileges in schema public
  revoke all on sequences from anon, authenticated, service_role;

/*
 * AND FUNCTIONS — the line that was missing, which made the sentence above
 * ("the same protection for `public`") false for a whole schema.
 *
 * `private` three blocks up revokes tables, sequences AND functions. `public`
 * revoked only the first two, and the difference was invisible on this machine
 * for the life of the project because it depends on WHICH ROLE APPLIES THE
 * MIGRATIONS. `pg_default_acl` carries one row per (role, schema, object type):
 * the stock image ships `supabase_admin | public | f` granting EXECUTE to anon,
 * authenticated and service_role, and `postgres | public | f` granting it to
 * nobody. Apply the migrations as `postgres` and every function is private by
 * default; apply them as `supabase_admin` — which a newer CLI does — and every
 * function in this schema is EXECUTABLE BY ANON the moment it is created.
 *
 * Measured, and only ever by a real runner. The first CI run this project has
 * had stopped at `20260813121200_hardening.sql`, thirteenth of the set, with
 * `anon can execute unexpected public function(s)` naming twenty-three of them
 * — the trigger guards and the RLS helper predicates, including
 * `deny_client_write`, `guard_ledger_append_only` and
 * `guard_session_escrow_on_delete`. The gate was right and had never been asked
 * on a database built the way a deployment builds one.
 *
 * `revoke` on a DEFAULT privilege changes only what a NEW function starts with;
 * the explicit `revoke … from public, anon; grant … to authenticated;` pair
 * that every client-facing function already carries still does its own job.
 * This makes the pair's first half redundant rather than load-bearing, which is
 * the right way round.
 */
alter default privileges in schema public
  revoke all on functions from anon, authenticated, service_role;

-- -----------------------------------------------------------------------------
-- Enum domains
--
-- Names that mirror the shared engine (`shared/blackjack/types.ts`) keep the
-- engine's exact spelling so a row round-trips into a TypeScript union without
-- a translation layer that could drift.
-- -----------------------------------------------------------------------------

create type public.profile_privacy as enum ('public', 'friends', 'private');

create type public.game_mode as enum (
  'practice',
  'solo',
  'private_table',
  'public_table',
  'tournament',
  'daily_challenge'
);

create type public.table_tier as enum ('casual', 'standard', 'high');

create type public.game_session_status as enum (
  'lobby',
  'active',
  'completed',
  'abandoned'
);

create type public.seat_status as enum ('active', 'disconnected', 'left');

-- 'public' rows are visible to every participant; 'seat' rows only to the one
-- recipient (e.g. a private hint or an error addressed to one player).
create type public.event_visibility as enum ('public', 'seat');

create type public.ledger_reason as enum (
  'initial_grant',
  'table_buy_in',
  'table_cash_out',
  'career_reward',
  'tournament_entry',
  'tournament_prize',
  'daily_challenge_reward',
  'level_up_reward',
  'daily_top_up',
  'correction'
);

-- Mirrors HandOutcomeKind in shared/blackjack/types.ts.
create type public.hand_outcome_kind as enum (
  'WIN',
  'LOSS',
  'PUSH',
  'BLACKJACK',
  'BUST',
  'SURRENDER'
);

-- Mirrors PlayerHandStatus in shared/blackjack/types.ts.
create type public.player_hand_status as enum (
  'ACTIVE',
  'STOOD',
  'BUSTED',
  'SURRENDERED',
  'DOUBLED_COMPLETE',
  'BLACKJACK',
  'TWENTY_ONE',
  'RESOLVED'
);

-- Mirrors PlayerActionType in shared/blackjack/types.ts.
create type public.player_action_type as enum (
  'HIT',
  'STAND',
  'DOUBLE',
  'SPLIT',
  'SURRENDER'
);

create type public.insurance_decision as enum (
  'PENDING',
  'TAKEN',
  'DECLINED',
  'NOT_OFFERED'
);

create type public.friend_request_status as enum (
  'pending',
  'accepted',
  'declined',
  'cancelled'
);

create type public.career_status as enum ('locked', 'available', 'completed');

create type public.career_chapter as enum (
  'FOUNDATIONS',
  'THE_WORKSHOP',
  'SKYLINE'
);

create type public.tournament_format as enum (
  'single_elimination',
  'leaderboard'
);

create type public.tournament_status as enum (
  'scheduled',
  'registering',
  'running',
  'completed',
  'cancelled'
);

create type public.tournament_entry_status as enum (
  'registered',
  'active',
  'eliminated',
  'withdrawn'
);

create type public.tournament_match_status as enum (
  'pending',
  'running',
  'completed',
  'forfeited'
);

create type public.daily_entry_status as enum (
  'in_progress',
  'completed',
  'abandoned'
);

create type public.cosmetic_kind as enum ('avatar', 'card_back', 'table_theme');

-- Deliberately has no 'purchase' and no 'random' member. Arc 21 ships no chip
-- purchases, no loot boxes and no randomised unlocks; making that unrepresentable
-- in the type is stronger than a policy note in a document.
create type public.cosmetic_unlock_type as enum (
  'default',
  'level',
  'career_node',
  'career_chapter',
  'daily_streak',
  'tournament_placement',
  'achievement'
);

create type public.push_platform as enum ('ios', 'android');

create type public.notification_kind as enum (
  'friend_request',
  'friend_accepted',
  'table_invite',
  'your_turn',
  'tournament_starting',
  'tournament_result',
  'daily_challenge',
  'career_unlocked',
  'system'
);

-- -----------------------------------------------------------------------------
-- Helper functions
-- -----------------------------------------------------------------------------

-- True when the statement is executing under one of the API roles. Guard
-- triggers use this so a SECURITY DEFINER server routine (running as postgres)
-- can write protected columns while a client can never reach them.
create or replace function public.is_client_role()
returns boolean
language sql
stable
as $$
  select current_user in ('anon', 'authenticated');
$$;

comment on function public.is_client_role() is
  'True when executing as anon or authenticated. Used by guard triggers to protect server-owned columns.';

create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

-- Blocks every column change under a client role. Used on tables whose contents
-- are entirely server-owned but which still need to be readable.
create or replace function public.deny_client_write()
returns trigger
language plpgsql
as $$
begin
  if public.is_client_role() then
    raise exception 'table %.% is server-controlled and not client-writable',
      tg_table_schema, tg_table_name
      using errcode = '42501';
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end;
$$;

revoke execute on function public.is_client_role() from public;
revoke execute on function public.set_updated_at() from public;
revoke execute on function public.deny_client_write() from public;

-- The guard triggers below run as the invoking role, so the client roles need
-- EXECUTE on this one predicate or every legitimate client write — renaming
-- yourself, accepting a friend request, marking a notification read — fails with
-- a permission error. It discloses nothing: it reports the caller's own role
-- back to the caller.
grant execute on function public.is_client_role() to anon, authenticated;
