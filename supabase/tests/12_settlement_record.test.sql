-- =============================================================================
-- Arc 21 — recording a settled hand
--
-- The XP cap and the streak arithmetic are the two parts of this that fail
-- quietly. A cap that does not bind produces a player with impossible XP; a
-- streak that adds when it should reset produces a "longest win streak" that
-- never happened. Neither raises an error, so both are tested at their edges.
-- =============================================================================

begin;

create extension if not exists pgtap with schema extensions;
set search_path to public, extensions, pg_catalog;

select plan(11);

select has_function('public', 'record_hand_settlement', 'the settlement writer exists');
select has_table('public', 'player_daily_xp', 'the daily XP allowance is recorded');

-- No client may author progression, however the row is reached.
select table_privs_are(
  'public', 'player_daily_xp', 'authenticated', array['SELECT'],
  'a player may read their allowance but never write it');

insert into auth.users (id, email, aud, role)
values ('44444444-4444-4444-4444-444444444444', 'settle@arc21.test',
        'authenticated', 'authenticated');

-- --------------------------------------------------------------------------
-- A first batch: two wins, no break
-- --------------------------------------------------------------------------

select is(
  (select xp_granted from public.record_hand_settlement(
     '44444444-4444-4444-4444-444444444444',
     2, 2, 0, 0, 0, 0, 0, 200::bigint, 100::bigint, 60::bigint,
     2, false, 10, date '2026-08-16', 300)),
  10,
  'a batch under the cap grants its full XP'
);

select is(
  (select current_win_streak from public.player_stats
   where user_id = '44444444-4444-4444-4444-444444444444'),
  2,
  'an unbroken batch extends the streak'
);

-- --------------------------------------------------------------------------
-- A batch containing a loss resets, then counts the wins after it
-- --------------------------------------------------------------------------

select lives_ok(
  $$ select public.record_hand_settlement(
       '44444444-4444-4444-4444-444444444444',
       3, 1, 2, 0, 0, 1, 0, 300::bigint, (-100)::bigint, 0::bigint,
       1, true, 15, date '2026-08-16', 300) $$,
  'a batch containing a loss is recorded'
);

select is(
  (select current_win_streak from public.player_stats
   where user_id = '44444444-4444-4444-4444-444444444444'),
  1,
  'a broken streak resets to the wins that came after the break'
);

select is(
  (select longest_win_streak from public.player_stats
   where user_id = '44444444-4444-4444-4444-444444444444'),
  2,
  'the longest streak keeps the earlier, better run'
);

-- --------------------------------------------------------------------------
-- The cap binds, and binds partially rather than all-or-nothing
-- --------------------------------------------------------------------------

select is(
  (select xp_granted from public.record_hand_settlement(
     '44444444-4444-4444-4444-444444444444',
     1, 1, 0, 0, 0, 0, 0, 100::bigint, 50::bigint, 50::bigint,
     1, false, 500, date '2026-08-16', 300)),
  275,
  'a batch crossing the cap grants only the remaining allowance'
);

select is(
  (select xp_granted from public.record_hand_settlement(
     '44444444-4444-4444-4444-444444444444',
     1, 1, 0, 0, 0, 0, 0, 100::bigint, 50::bigint, 50::bigint,
     1, false, 50, date '2026-08-16', 300)),
  0,
  'once the cap is reached the day grants nothing more'
);

-- A new UTC day is a fresh allowance. Tested explicitly because the day is a
-- parameter rather than read from the clock, and passing the wrong one would
-- silently hand a player a second allowance.
select is(
  (select xp_granted from public.record_hand_settlement(
     '44444444-4444-4444-4444-444444444444',
     1, 1, 0, 0, 0, 0, 0, 100::bigint, 50::bigint, 50::bigint,
     1, false, 40, date '2026-08-17', 300)),
  40,
  'the next UTC day starts a fresh allowance'
);

select * from finish();
rollback;
