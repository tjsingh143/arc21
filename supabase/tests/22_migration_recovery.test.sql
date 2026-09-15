-- =============================================================================
-- Arc 21 — recovery, as assertions rather than as prose
--
-- The specification asks for migrations that are "reversible where reasonable or
-- include documented recovery". `docs/DATABASE.md` carries the per-migration
-- position; this file asserts the three properties that recovery ACTUALLY rests
-- on, because a recovery note nobody has checked is a plan, not a capability.
--
-- This project has no down-migration framework and does not need one — thirty of
-- its thirty-two migrations are additive DDL, whose reversal is `drop`. What
-- matters is the small number of places where state was DERIVED, because those
-- are the ones a bad deploy could leave wrong. Each is asserted here to be
-- re-derivable, which is precisely what makes its recovery a single statement
-- rather than a restore from backup.
--
-- These are cheap whole-table checks. They are also the assertions most likely
-- to catch a real defect in something else: a wallet that has drifted from its
-- ledger is a chip-minting bug, whatever caused it.
-- =============================================================================

begin;

create extension if not exists pgtap with schema extensions;
set search_path to public, extensions, pg_catalog;

select plan(7);

-- ---------------------------------------------------------------------------
-- Money is rebuildable from the ledger
-- ---------------------------------------------------------------------------
--
-- The recovery position for every wallet, and the reason the ledger is
-- append-only rather than a running total somebody edits. If `wallets` is ever
-- wrong — a bad migration, a restore to the wrong point, a bug — the balance can
-- be recomputed from history without knowing what went wrong.
--
-- Scoped to nothing, deliberately: this one SHOULD look at every row, because
-- the claim is about all of them. It is a relationship, not a position, so it
-- does not expire as the database fills.

select is(
  (select count(*)::int from public.wallets w
   where w.balance <> (
     select coalesce(sum(l.delta), 0) from public.wallet_ledger l where l.user_id = w.user_id
   )),
  0,
  'every wallet balance equals the sum of its ledger, so a wallet can be rebuilt from history'
);

select is(
  (select count(*)::int from public.wallet_ledger where idempotency_key is null),
  0,
  'and every ledger row carries the key that makes replaying it safe'
);

-- ---------------------------------------------------------------------------
-- Progression is rebuildable from XP
-- ---------------------------------------------------------------------------
--
-- `20260817320000_derive_level_from_xp.sql` is one of only two migrations that
-- TRANSFORMED existing rows: it backfilled `profiles.level`, which had been
-- stored and never written, leaving every account at level 1. A backfill cannot
-- be reversed — the prior values are gone — but it does not need to be, because
-- it is re-derivable. That is the recovery, and this is the assertion that it
-- still is one.

select is(
  (select count(*)::int from public.profiles p
   where p.level <> public.level_from_total_xp(p.xp)),
  0,
  'every level agrees with the function that derives it, so the backfill can simply be run again'
);

-- ---------------------------------------------------------------------------
-- The rate-limit backfill is rebuildable from the column it came from
-- ---------------------------------------------------------------------------
--
-- The other transforming migration, added this phase.
-- `20260818100000_rate_limits.sql` moved username-rename enforcement from
-- `profiles.username_changed_at` to `rate_limit_events`, and seeded the new
-- table from the old column so that a player who renamed yesterday did not get a
-- free second rename. Recovery is the same statement run again; this asserts the
-- source column is still there to run it from.

select has_column(
  'public', 'profiles', 'username_changed_at',
  'the column the username backfill derives from still exists'
);

select is(
  (select count(*)::int from public.profiles p
   join public.rate_limit_policies rp on rp.action = 'profile_username_change'
   where p.username_changed_at > now() - rp.window_length
     and not exists (
       select 1 from public.rate_limit_events e
       where e.user_id = p.id and e.action = 'profile_username_change'
     )),
  0,
  'no recent rename is missing its event, so the backfill and the live path agree'
);

-- ---------------------------------------------------------------------------
-- The one genuinely irreversible operation
-- ---------------------------------------------------------------------------
--
-- `alter type … add value` cannot be undone: Postgres has no `drop value`, and
-- removing one would require rewriting every column of that type. There is
-- exactly one in the history — `recovery_grant`, in
-- `20260815190000_starting_wallet_and_recovery_reason.sql` — and the recovery
-- for it is that there is nothing to recover: an unused label costs nothing.
--
-- What WOULD cost something is a label disappearing while ledger rows still
-- referred to it. This asserts the labels the code writes are all present, so a
-- future migration recreating the type without one fails here first.

select bag_has(
  $$ select enumlabel::text from pg_enum e
     join pg_type t on t.oid = e.enumtypid where t.typname = 'ledger_reason' $$,
  $$ values ('initial_grant'), ('table_buy_in'), ('table_cash_out'),
            ('career_reward'), ('tournament_entry'), ('tournament_prize'),
            ('tournament_refund'),
            ('daily_challenge_reward'), ('recovery_grant'), ('correction') $$,
  'every ledger reason the server writes still exists as an enum label'
);

select is(
  (select count(*)::int from public.wallet_ledger l
   where not exists (
     select 1 from pg_enum e join pg_type t on t.oid = e.enumtypid
     where t.typname = 'ledger_reason' and e.enumlabel = l.reason::text
   )),
  0,
  'and no ledger row refers to a reason the type no longer has'
);

select * from finish();

rollback;
