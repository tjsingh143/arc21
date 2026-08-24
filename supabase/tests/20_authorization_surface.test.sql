-- =============================================================================
-- Arc 21 — the authorization surface, systematically
--
-- The existing pgTAP files cover many tables well and none of them covers ALL of
-- them. This one is deliberately the other shape: it makes claims about the
-- whole schema at once, so a table added tomorrow is inside the assertion the
-- day it is created rather than the day somebody remembers to add it.
--
-- It is the test half of `assert_client_authorization_surface()`, which the
-- migrations call at deploy time. The duplication is the point: a check that
-- runs on deploy is stronger than a test somebody may not run, and a test is
-- easier to debug than a failed migration. Running the same function from both
-- places means they cannot disagree.
--
-- The audit this file encodes is written out per table in `docs/SECURITY.md`.
-- =============================================================================

begin;

create extension if not exists pgtap with schema extensions;
set search_path to public, extensions, pg_catalog;

select plan(17);

-- ---------------------------------------------------------------------------
-- The gate, run as a test
-- ---------------------------------------------------------------------------

select has_function(
  'public', 'assert_client_authorization_surface',
  'the authorization gate is a callable function, not a DO block frozen at one point in the migration order'
);

select lives_ok(
  $$ select public.assert_client_authorization_surface() $$,
  'the whole client authorization surface is as intended'
);

-- A gate nobody has seen fail is a gate nobody should trust. Each breach below is
-- applied, checked, and rolled back to a savepoint.
--
-- The savepoint is issued OUTSIDE `throws_ok`, because pgTAP runs its argument
-- through EXECUTE and Postgres refuses transaction commands there — the first
-- draft of this file put them inside and died with "EXECUTE of transaction
-- commands is not implemented".

savepoint breach;
grant execute on function public.leaderboard_weekly_xp(integer) to anon;
select throws_ok(
  $$ select public.assert_client_authorization_surface() $$,
  'P0001', null,
  'the gate refuses a leaderboard handed to signed-out callers'
);
rollback to savepoint breach;

savepoint breach;
grant insert on table public.wallets to authenticated;
select throws_ok(
  $$ select public.assert_client_authorization_surface() $$,
  'P0001', null,
  'the gate refuses a write privilege on the wallet'
);
rollback to savepoint breach;

savepoint breach;
grant update (balance) on table public.wallets to authenticated;
select throws_ok(
  $$ select public.assert_client_authorization_surface() $$,
  'P0001', null,
  'the gate refuses a COLUMN-level write on the wallet, which table-level checks cannot see'
);
rollback to savepoint breach;

savepoint breach;
create function public.zz_forgot_to_revoke() returns int language sql as 'select 1';
select throws_ok(
  $$ select public.assert_client_authorization_surface() $$,
  'P0001', null,
  'the gate refuses a new function left with Postgres''s default EXECUTE TO PUBLIC'
);
rollback to savepoint breach;

savepoint breach;
alter table public.wallet_ledger disable row level security;
select throws_ok(
  $$ select public.assert_client_authorization_surface() $$,
  'P0001', null,
  'the gate refuses a table with RLS switched off'
);
rollback to savepoint breach;

savepoint breach;
grant usage on schema private to authenticated;
select throws_ok(
  $$ select public.assert_client_authorization_surface() $$,
  'P0001', null,
  'the gate refuses a client role reaching the private schema'
);
rollback to savepoint breach;

-- ---------------------------------------------------------------------------
-- Every table in public, not a list of tables somebody maintained
-- ---------------------------------------------------------------------------

select is(
  (select count(*)::int from pg_class c
   join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relkind = 'r'),
  35,
  'the audit in docs/SECURITY.md covers every table: 34, plus career_attempts'
);

select is(
  (select count(*)::int from pg_class c
   join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity),
  0,
  'row level security is enabled on every one of them'
);

-- A table that is readable by a client but has no SELECT policy is either dead
-- or about to be "fixed" by somebody adding a permissive one. Neither is a state
-- to leave lying around.
select is(
  (select coalesce(string_agg(distinct g.table_name, ', '), '')
   from information_schema.role_table_grants g
   join pg_class c on c.relname = g.table_name
   join pg_namespace n on n.oid = c.relnamespace and n.nspname = 'public'
   where g.table_schema = 'public'
     and g.grantee in ('anon', 'authenticated')
     and g.privilege_type = 'SELECT'
     and c.relkind = 'r'
     and not exists (
       select 1 from pg_policy p
       where p.polrelid = c.oid and p.polcmd in ('r', '*')
     )),
  '',
  'no table is readable by a client without a policy that says which rows'
);

-- The reverse: a policy that permits something no grant allows is a comment
-- pretending to be enforcement. It is not an error, but it should be deliberate,
-- and the two tables that are in this state are so ON PURPOSE — the rate-limit
-- tables carry RLS with no policy and no grant, which is deny-all stated plainly.
select bag_eq(
  $$ select c.relname::text from pg_class c
     join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public' and c.relkind = 'r'
       and not exists (select 1 from pg_policy p where p.polrelid = c.oid) $$,
  $$ values ('rate_limit_policies'), ('rate_limit_events') $$,
  'exactly two tables have no policy at all, and both are deny-all by design'
);

-- ---------------------------------------------------------------------------
-- The rules the whole schema rests on
-- ---------------------------------------------------------------------------

select is(
  (select count(*)::int
   from information_schema.role_table_grants
   where table_schema = 'public'
     and grantee in ('anon', 'authenticated')
     and privilege_type in ('INSERT', 'UPDATE', 'DELETE')
     and table_name in (
       'wallets', 'wallet_ledger', 'game_sessions', 'game_session_seats',
       'game_events', 'hand_records', 'hand_players', 'player_actions',
       'player_stats', 'player_mode_stats', 'player_daily_xp',
       'player_decision_periods', 'daily_challenges', 'daily_entries',
       'tournaments', 'tournament_entries', 'tournament_matches',
       'career_nodes', 'career_progress', 'cosmetics', 'user_cosmetics',
       'rulesets', 'rooms', 'room_members', 'matchmaking_queue',
       'rate_limit_policies', 'rate_limit_events'
     )),
  0,
  'no client role may write any of the 27 server-owned tables'
);

-- The six tables a client MAY write, named explicitly so that adding a seventh is
-- a decision somebody has to make here as well as in a migration.
select bag_eq(
  $$ select distinct g.table_name::text
     from information_schema.role_table_grants g
     where g.table_schema = 'public'
       and g.grantee in ('anon', 'authenticated')
       and g.privilege_type in ('INSERT', 'UPDATE', 'DELETE') $$,
  $$ values ('friend_requests'), ('friendships'), ('blocks'), ('loadouts'),
            ('push_tokens'), ('notifications') $$,
  'exactly six tables take a client write, and profiles takes a column-level one'
);

-- `anon` reads only the catalogue: the rules, the career map, the cosmetics and
-- the tournament list. Nothing about a person.
select bag_eq(
  $$ select distinct g.table_name::text
     from information_schema.role_table_grants g
     where g.table_schema = 'public' and g.grantee = 'anon' $$,
  $$ values ('rulesets'), ('career_nodes'), ('cosmetics'), ('tournaments') $$,
  'a signed-out caller can read the catalogue and nothing that belongs to a player'
);

select is(
  (select count(*)::int from pg_proc p
   join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and has_function_privilege('anon', p.oid, 'EXECUTE')),
  1,
  'and can execute exactly one function — the predicate that reports its own role'
);

-- ---------------------------------------------------------------------------
-- The set of client-readable tables is CLOSED
-- ---------------------------------------------------------------------------
-- Enforced here rather than in `tests/server/rls-idor.integration.test.ts`,
-- which is where a reader would look for it. That file sweeps every one of
-- these tables with two real JWTs and asserts what a stranger gets back — but it
-- talks to PostgREST, PostgREST does not expose `information_schema`, and its
-- first attempt at proving its own coverage ended up comparing its four lists
-- with themselves. A check that matches nothing reads as enforcement; this
-- repository has hit that three times now.
--
-- So the catalogue is read HERE, where it is one query away, and the list below
-- is the same one that file classifies. A new table with a SELECT grant fails
-- this test, and whoever adds it has to go and decide what a stranger may see of
-- it before the suite is green again.
select bag_eq(
  $$ select distinct g.table_name::text
     from information_schema.role_table_grants g
     join pg_class c on c.relname = g.table_name
     join pg_namespace n on n.oid = c.relnamespace and n.nspname = 'public'
     where g.table_schema = 'public'
       and g.grantee in ('anon', 'authenticated')
       and g.privilege_type = 'SELECT'
       and c.relkind = 'r' $$,
  $$ values
      -- owned: a stranger sees none of it
      ('wallets'), ('wallet_ledger'), ('player_stats'), ('player_mode_stats'),
      ('player_daily_xp'), ('player_decision_periods'), ('career_attempts'),
      ('career_progress'), ('daily_entries'), ('loadouts'), ('push_tokens'),
      ('notifications'), ('user_cosmetics'), ('matchmaking_queue'), ('blocks'),
      ('friendships'), ('tournament_entries'),
      -- shared: a participant sees it, a stranger does not
      ('game_sessions'), ('game_session_seats'), ('game_events'), ('rooms'),
      ('room_members'),
      -- open: catalogue or directory, readable on purpose
      ('career_nodes'), ('cosmetics'), ('rulesets'), ('profiles'),
      -- relationship, and the competition's public shape
      ('friend_requests'), ('tournaments'), ('tournament_matches'),
      -- V1.1, architected for and written by nothing: "hand history/replay"
      -- is under DO NOT LET THESE DELAY MVP
      ('hand_records'), ('hand_players'), ('player_actions') $$,
  'every client-readable table is one the IDOR sweep classifies'
);

select * from finish();

rollback;
