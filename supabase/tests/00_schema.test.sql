-- =============================================================================
-- Arc 21 — schema shape and structural invariants
--
-- pgTAP is created inside the test transaction and rolled back with it, so the
-- extension is never installed into a deployed database.
-- =============================================================================

begin;

create extension if not exists pgtap with schema extensions;
set search_path to public, extensions, pg_catalog;

select plan(43);

-- -----------------------------------------------------------------------------
-- Every MVP table exists
-- -----------------------------------------------------------------------------

select has_table('public', t, format('table public.%I exists', t))
from unnest(array[
  'profiles', 'player_stats', 'player_mode_stats', 'player_daily_xp',
  'wallets', 'wallet_ledger',
  'friend_requests', 'friendships', 'blocks',
  'rulesets', 'game_sessions', 'game_session_seats', 'game_events',
  'hand_records', 'hand_players', 'player_actions',
  'career_nodes', 'career_progress',
  'tournaments', 'tournament_entries', 'tournament_matches',
  'daily_challenges', 'daily_entries',
  'cosmetics', 'user_cosmetics', 'loadouts',
  'push_tokens', 'notifications'
]) as t;

select has_table(
  'private', 'game_state_private',
  'the private engine state table exists in the private schema'
);

-- -----------------------------------------------------------------------------
-- Structural conventions
-- -----------------------------------------------------------------------------

select is(
  (
    select count(*)
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    left join pg_constraint pk
      on pk.conrelid = c.oid and pk.contype = 'p'
    where n.nspname = 'public'
      and c.relkind = 'r'
      and (
        pk.oid is null
        or array_length(pk.conkey, 1) <> 1
        or (
          select a.atttypid
          from pg_attribute a
          where a.attrelid = c.oid and a.attnum = pk.conkey[1]
        ) <> 'uuid'::regtype
      )
  )::int,
  0,
  'every table in public has a single-column uuid primary key'
);

select is(
  (
    select count(*)
    from information_schema.columns
    where table_schema in ('public', 'private')
      and data_type = 'timestamp without time zone'
  )::int,
  0,
  'no naive timestamp columns: every time column is timestamptz'
);

select is(
  (
    select count(*)
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relkind = 'r'
      and not c.relrowsecurity
  )::int,
  0,
  'row level security is enabled on every table in public'
);

select has_column('private', 'game_state_private', 'game_session_id', 'private state is keyed by game_session_id');
select has_column('private', 'game_state_private', 'engine_state',    'private state holds engine_state');
select has_column('private', 'game_state_private', 'version',         'private state holds version');
select has_column('private', 'game_state_private', 'updated_at',      'private state holds updated_at');

select col_is_pk('private', 'game_state_private', 'game_session_id',
  'game_session_id is the primary key of the private engine state');

-- -----------------------------------------------------------------------------
-- Money invariants exist as constraints, not as conventions
-- -----------------------------------------------------------------------------

select col_is_unique(
  'public', 'wallet_ledger', 'idempotency_key',
  'wallet_ledger.idempotency_key is unique'
);

select isnt_empty(
  $$ select 1 from pg_constraint
     where conrelid = 'public.wallets'::regclass
       and contype = 'c'
       and conname = 'wallets_balance_non_negative' $$,
  'wallets carries a balance >= 0 check constraint'
);

select isnt_empty(
  $$ select 1 from pg_constraint
     where conrelid = 'public.hand_players'::regclass
       and contype = 'c'
       and conname = 'hand_players_net_is_credit_minus_wager' $$,
  'hand settlement arithmetic is enforced by a check constraint'
);

select is(
  (
    select count(*)
    from information_schema.columns
    where table_schema = 'public'
      and data_type in ('real', 'double precision')
  )::int,
  0,
  'no floating point column exists anywhere in the public schema'
);

-- -----------------------------------------------------------------------------
-- Product guarantees encoded in the type system
-- -----------------------------------------------------------------------------

select is(
  (
    select count(*)
    from pg_enum e
    join pg_type t on t.oid = e.enumtypid
    where t.typname = 'cosmetic_unlock_type'
      and e.enumlabel in ('purchase', 'random', 'loot_box', 'gacha', 'chance')
  )::int,
  0,
  'no cosmetic unlock type expresses a purchase or a random draw'
);

select is(
  (
    select count(*)
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'cosmetics'
      and column_name in ('price', 'cost', 'price_chips', 'gems')
  )::int,
  0,
  'the cosmetics catalogue has no price column'
);

select * from finish();

rollback;
