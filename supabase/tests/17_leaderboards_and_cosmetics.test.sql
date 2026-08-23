-- =============================================================================
-- Arc 21 — leaderboards, decisions and cosmetics
--
-- The two properties this file exists to hold:
--
--   1. A leaderboard NEVER carries an account identifier. SECURITY.md forbids
--      exposing one and a board is the easiest place to leak it, so the row type
--      itself is asserted rather than the contents of any particular query.
--   2. A client cannot write its own accuracy, its own XP or its own cosmetics.
--      Each of those has a server-only function, and the assertions below are on
--      the PRIVILEGE, not on the application code that happens to call it.
--
-- Fixtures are scoped to this file's own users throughout. A global count here
-- would report whatever the database happens to be holding, which is how the
-- daily-challenge suite in this project once started failing on a dirty database.
-- =============================================================================

begin;

create extension if not exists pgtap with schema extensions;
set search_path to public, extensions, pg_catalog;

select plan(39);

-- ---------------------------------------------------------------------------
-- Structure
-- ---------------------------------------------------------------------------

select has_table('public', 'player_decision_periods', 'decisions are bucketed by week');
select has_function('public', 'record_decisions',
  array['uuid', 'integer', 'integer', 'timestamptz'], 'grading is recorded by a server function');
select has_function('public', 'leaderboard_weekly_xp', array['integer'], 'weekly XP board exists');
select has_function('public', 'leaderboard_tournament_wins', array['integer'], 'tournament board exists');
select has_function('public', 'leaderboard_strategy_accuracy', array['integer'], 'accuracy board exists');
select has_function('public', 'leaderboard_daily_challenge', array['date', 'integer'], 'daily board exists');

-- The projection, asserted at the type rather than per query. A board cannot leak
-- a user id however it is written, because the shape it returns has no column for
-- one.
select bag_eq(
  $$ select attname::text from pg_attribute
     where attrelid = 'public.leaderboard_row'::regclass and attnum > 0 $$,
  $$ values ('rank'), ('display_name'), ('avatar_asset_key'), ('value'), ('detail'), ('is_you') $$,
  'a leaderboard row carries no user id and no email'
);

-- ---------------------------------------------------------------------------
-- The week boundary
-- ---------------------------------------------------------------------------

select is(public.utc_week_start('2026-08-17T00:00:00Z'::timestamptz), '2026-08-17'::date,
  'a Monday is its own week start');
select is(public.utc_week_start('2026-08-16T23:59:59Z'::timestamptz), '2026-08-10'::date,
  'and Sunday belongs to the week before it');
select is(public.utc_week_start('2026-08-23T12:00:00Z'::timestamptz), '2026-08-17'::date,
  'the following Sunday still belongs to the Monday that opened it');

-- ---------------------------------------------------------------------------
-- Nothing progression-related is client-writable
-- ---------------------------------------------------------------------------

select ok(not has_function_privilege('authenticated', 'public.record_decisions(uuid, integer, integer, timestamptz)', 'execute'),
  'a client cannot record its own decisions');
select ok(not has_function_privilege('authenticated', 'public.grant_earned_cosmetics_for(uuid)', 'execute'),
  'a client cannot grant cosmetics to an arbitrary account');
select ok(has_function_privilege('authenticated', 'public.grant_earned_cosmetics()', 'execute'),
  'but it can ask for its own, through the argument-free wrapper');
select table_privs_are('public', 'player_decision_periods', 'authenticated', array['SELECT'],
  'a player may read their own decision counts and never write them');

-- ---------------------------------------------------------------------------
-- The level curve
-- ---------------------------------------------------------------------------

select is(public.total_xp_for_level(1), 0::bigint, 'level 1 begins at nothing');
select is(public.total_xp_for_level(2), 100::bigint, 'level 2 costs the base amount');
select is(public.total_xp_for_level(3), 225::bigint, 'and each level costs 25 more than the last');
select is(public.level_from_total_xp(99), 1, 'one XP short of a threshold is the level below');
select is(public.level_from_total_xp(100), 2, 'and exactly the threshold is the level itself');
select is(public.level_from_total_xp(999999), 50, 'the curve stops at the cap rather than running on');

-- ---------------------------------------------------------------------------
-- Fixtures
-- ---------------------------------------------------------------------------

insert into auth.users (id, email, aud, role) values
  ('0d000000-0000-4000-8000-000000000001', 'lb-a@arc21.test', 'authenticated', 'authenticated'),
  ('0d000000-0000-4000-8000-000000000002', 'lb-b@arc21.test', 'authenticated', 'authenticated'),
  ('0d000000-0000-4000-8000-000000000003', 'lb-c@arc21.test', 'authenticated', 'authenticated');

-- `level` is DERIVED from `xp` by a trigger. The column existed for a long time
-- and nothing ever wrote it, so every account sat at level 1 — which meant the
-- high-stakes gate could not open and half the cosmetic catalogue could not
-- unlock.
update public.profiles set xp = 225 where id = '0d000000-0000-4000-8000-000000000001';

select is(
  (select level from public.profiles where id = '0d000000-0000-4000-8000-000000000001'),
  3,
  'writing XP derives the level, so the two cannot disagree'
);

-- Two qualifying players and one below the bar.
select public.record_decisions('0d000000-0000-4000-8000-000000000001', 200, 180);
select public.record_decisions('0d000000-0000-4000-8000-000000000002', 150, 141);
select public.record_decisions('0d000000-0000-4000-8000-000000000003', 60, 60);

select is(
  (select decisions_total from public.player_decision_periods
   where user_id = '0d000000-0000-4000-8000-000000000001'
     and period_start = public.utc_week_start()),
  200,
  'decisions land in the current week''s bucket'
);

select is(
  (select decisions_total from public.player_stats
   where user_id = '0d000000-0000-4000-8000-000000000001'),
  200,
  'and in the lifetime totals, which nothing wrote before this'
);

select throws_ok(
  $$ select public.record_decisions('0d000000-0000-4000-8000-000000000001', 5, 9) $$,
  '22023', null,
  'a batch claiming more optimal decisions than decisions is refused'
);

-- ---------------------------------------------------------------------------
-- The accuracy board
-- ---------------------------------------------------------------------------

set local role authenticated;
set local request.jwt.claims to
  '{"sub":"0d000000-0000-4000-8000-000000000001","role":"authenticated"}';

-- 141/150 is 94.00%, 180/200 is 90.00%. Basis points, integer-exact: no float
-- reaches a compared figure anywhere in this project.
-- Scoped to this file's own player, for the same reason the position assertion
-- below is: other accounts qualify for this board too. 180/200 is 90.00%, and
-- basis points keep it integer-exact — no float reaches a compared figure
-- anywhere in this project.
select is(
  (select value from public.leaderboard_strategy_accuracy(10000) where is_you),
  9000::bigint,
  'accuracy is reported in basis points, integer-exact'
);

select is(
  (select count(*)::int from public.leaderboard_strategy_accuracy(100)
   where detail = '60 decisions'),
  0,
  'and excludes a player who has not reached the hundred-decision bar'
);

select is(
  (select qualified from public.my_strategy_accuracy_progress()),
  true,
  'a qualifying player is told so'
);

-- Asserted as a RELATIONSHIP, not an absolute rank. Other accounts in the
-- database qualify for this board too, so pinning a number here would make the
-- test depend on whoever else happens to have played this week — the same trap
-- that broke the daily-challenge suite once the mode became playable. What the
-- function actually promises is that it agrees with the board, and that holds
-- however many other players are on it.
select is(
  (select row(rank, value)::text from public.my_leaderboard_position('strategy_accuracy')),
  (select row(rank, value)::text from public.leaderboard_strategy_accuracy(10000) where is_you),
  'a player''s own position agrees with the board''s own ordering'
);

select throws_ok(
  $$ select public.my_leaderboard_position('global_bankroll') $$,
  '22023', null,
  'a board that does not exist is refused rather than answered emptily'
);

reset role;

-- ---------------------------------------------------------------------------
-- Cosmetics
-- ---------------------------------------------------------------------------

select is(
  public.grant_earned_cosmetics_for('0d000000-0000-4000-8000-000000000002'),
  4,
  'a new player is granted the four default cosmetics'
);

select is(
  public.grant_earned_cosmetics_for('0d000000-0000-4000-8000-000000000002'),
  0,
  'and granting again gives nothing — a cosmetic is never re-granted'
);

-- Level 3 adds the level-3 avatar. Counted among this file's own user.
select is(
  (select count(*)::int from public.user_cosmetics
   where user_id = '0d000000-0000-4000-8000-000000000001'),
  0,
  'nothing is owned before the evaluator runs'
);

select ok(
  public.grant_earned_cosmetics_for('0d000000-0000-4000-8000-000000000001') > 4,
  'a level-3 player earns more than the defaults'
);

-- The acceptance criterion, asserted structurally. A cosmetic cannot affect play
-- because nothing about play reads one: no gameplay table references `cosmetics`.
select is(
  (select count(*)::int
   from information_schema.table_constraints tc
   join information_schema.constraint_column_usage ccu
     on ccu.constraint_name = tc.constraint_name and ccu.table_schema = tc.table_schema
   where tc.constraint_type = 'FOREIGN KEY'
     and ccu.table_name = 'cosmetics'
     and tc.table_name in ('game_sessions', 'game_session_seats', 'hands', 'rulesets',
                           'wallets', 'wallet_ledger', 'tournaments', 'daily_challenges')),
  0,
  'no gameplay or economy table references a cosmetic, so none can affect play'
);

-- ---------------------------------------------------------------------------
-- The eight career-gated cosmetics
-- ---------------------------------------------------------------------------
-- Three chapter finals by node code and five by chapter. All eight were
-- unobtainable: they gate on `career_progress`, and nothing anywhere wrote a
-- row into it. `tests/server/career.integration.test.ts` proves the writer
-- against the live stack; this proves the gate opens once rows exist, without
-- playing sixty hands to get there.

reset role;

insert into auth.users (id, email, aud, role) values
  ('0e000000-0000-4000-8000-00000000000c', 'cos-career@arc21.test', 'authenticated', 'authenticated');

select is(
  (select count(*)::int
   from public.cosmetics c
   where c.unlock_type in ('career_node', 'career_chapter')
     and public.cosmetic_is_earned('0e000000-0000-4000-8000-00000000000c', c.id)),
  0,
  'a new player has earned none of the career cosmetics'
);

-- Just the chapter final, completed. Its own gate opens; the chapter's does not.
insert into public.career_progress (user_id, career_node_id, status, stars, first_completed_at)
select '0e000000-0000-4000-8000-00000000000c', id, 'completed', 1, now()
from public.career_nodes where code = 'foundation-final';

select ok(
  public.cosmetic_is_earned(
    '0e000000-0000-4000-8000-00000000000c',
    (select id from public.cosmetics where unlock_config ->> 'careerNodeCode' = 'foundation-final')),
  'completing a chapter final earns the card back it gates'
);

select ok(
  not public.cosmetic_is_earned(
    '0e000000-0000-4000-8000-00000000000c',
    (select id from public.cosmetics
     where unlock_type = 'career_chapter' and unlock_config ->> 'chapter' = 'FOUNDATIONS'
     limit 1)),
  'but one node is not the chapter — five other nodes are still incomplete'
);

-- The whole chapter.
insert into public.career_progress (user_id, career_node_id, status, stars, first_completed_at)
select '0e000000-0000-4000-8000-00000000000c', id, 'completed', 1, now()
from public.career_nodes where chapter = 'FOUNDATIONS'
on conflict (user_id, career_node_id) do update set status = 'completed';

select ok(
  public.cosmetic_is_earned(
    '0e000000-0000-4000-8000-00000000000c',
    (select id from public.cosmetics
     where unlock_type = 'career_chapter' and unlock_config ->> 'chapter' = 'FOUNDATIONS'
     limit 1)),
  'completing every node in the chapter earns the chapter reward'
);

-- And the grant actually hands them over, rather than merely reporting them
-- earned. Two different questions, and the second is the one a player sees.
select ok(
  public.grant_earned_cosmetics_for('0e000000-0000-4000-8000-00000000000c') > 0,
  'the grant hands over what the career unlocked'
);

select * from finish();
rollback;
