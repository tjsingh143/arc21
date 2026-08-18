-- =============================================================================
-- Arc 21 — the Daily Challenge's tie-breaks
--
-- The specification ranks the daily board on score, then ACCURACY, then EV LOST,
-- and only then on submission time. Until this phase it ranked on score and
-- submission time, and `docs/AUDIT.md` carried the row as ABSENT.
--
-- Ordering is exactly the kind of thing an integration test cannot pin down: two
-- accounts playing the same shoe with the same strategy produce the same
-- accuracy, so a real attempt can prove the numbers are RECORDED but not that
-- they are USED. So the recording is proved end to end in
-- `tests/server/game-command.integration.test.ts`, and the ordering is proved
-- here, against entries whose every field is chosen.
--
-- The fixture owns its own challenge DATE and its own accounts, and every count
-- below is filtered to them. A file that asserted a position on the live board
-- would pass today and fail the first day somebody played.
-- =============================================================================

begin;

create extension if not exists pgtap with schema extensions;
set search_path to public, extensions, pg_catalog;

select plan(15);

-- ---------------------------------------------------------------------------
-- The columns, and who may write them
-- ---------------------------------------------------------------------------

select has_column('public', 'daily_entries', 'decisions_total',
  'an attempt records how many decisions it was graded on');
select has_column('public', 'daily_entries', 'decisions_optimal',
  'and how many matched the chart');
select has_column('public', 'daily_entries', 'ev_lost_micros',
  'and what the mistakes cost');

-- EV is fractional and the column is not, which is the same rule that keeps
-- chips integral: no floating-point column exists anywhere in this schema, and
-- an ordering key computed in floating point can rank two identical records
-- differently on two machines.
select is(
  (select data_type from information_schema.columns
   where table_schema = 'public' and table_name = 'daily_entries'
     and column_name = 'ev_lost_micros'),
  'bigint',
  'EV lost is stored in millionths as an integer, not as a float'
);

select ok(
  not has_function_privilege(
    'authenticated',
    'public.record_daily_attempt_decisions(uuid, integer, integer, bigint)',
    'execute'
  ),
  'no client can assert its own accuracy: the recorder is unreachable from a session'
);

-- ---------------------------------------------------------------------------
-- Fixtures — one challenge date this file owns, and six accounts
-- ---------------------------------------------------------------------------

insert into auth.users (id, email, aud, role) values
  ('d0d0d0d0-0000-4000-8000-00000000000a', 'tb-a@arc21.test', 'authenticated', 'authenticated'),
  ('d0d0d0d0-0000-4000-8000-00000000000b', 'tb-b@arc21.test', 'authenticated', 'authenticated'),
  ('d0d0d0d0-0000-4000-8000-00000000000c', 'tb-c@arc21.test', 'authenticated', 'authenticated'),
  ('d0d0d0d0-0000-4000-8000-00000000000d', 'tb-d@arc21.test', 'authenticated', 'authenticated'),
  ('d0d0d0d0-0000-4000-8000-00000000000e', 'tb-e@arc21.test', 'authenticated', 'authenticated'),
  ('d0d0d0d0-0000-4000-8000-00000000000f', 'tb-f@arc21.test', 'authenticated', 'authenticated');

update public.profiles set display_name = 'Entrant A' where id = 'd0d0d0d0-0000-4000-8000-00000000000a';
update public.profiles set display_name = 'Entrant B' where id = 'd0d0d0d0-0000-4000-8000-00000000000b';
update public.profiles set display_name = 'Entrant C' where id = 'd0d0d0d0-0000-4000-8000-00000000000c';
update public.profiles set display_name = 'Entrant D' where id = 'd0d0d0d0-0000-4000-8000-00000000000d';
update public.profiles set display_name = 'Entrant E' where id = 'd0d0d0d0-0000-4000-8000-00000000000e';
update public.profiles set display_name = 'Entrant F' where id = 'd0d0d0d0-0000-4000-8000-00000000000f';

-- A date far enough out that nothing else in this repository, and no real play,
-- will ever share it.
select public.ensure_daily_challenge_for(date '2031-03-03');

/*
 * Six attempts, arranged so that each pair differs in exactly ONE field.
 *
 *   A  6,000  —          —      the score still wins outright
 *   B  5,000  95%     100µ  earliest of the tied group
 *   C  5,000  95%     500µ  same accuracy as B, dearer mistakes
 *   D  5,000  90%       0µ  cheapest mistakes of all, and still below C:
 *                             accuracy is the higher tie-break
 *   F  5,000  95%     100µ  identical to B, submitted later
 *   E  5,000  ungraded  0µ  no decisions at all
 *
 * Expected: A, B, F, C, D, E.
 *
 * E is the case worth stating out loud. An attempt with nothing graded is not
 * "0% accurate", it is unmeasured — and `desc` alone puts NULLs FIRST in
 * Postgres, which would hand the top of the tie to the player the board knows
 * least about. `desc nulls last` is what puts them at the bottom, and this row
 * is the assertion that it is there.
 */
insert into public.daily_entries
  (daily_challenge_id, user_id, status, hands_played, final_chips, score,
   decisions_total, decisions_optimal, ev_lost_micros, completed_at)
select c.id, v.user_id, 'completed', 20, v.score, v.score,
       v.total, v.optimal, v.ev, v.done
from public.daily_challenges c,
  (values
    ('d0d0d0d0-0000-4000-8000-00000000000a'::uuid, 6000::bigint, 100, 50,  9000::bigint, timestamptz '2031-03-03 10:00:00Z'),
    ('d0d0d0d0-0000-4000-8000-00000000000b'::uuid, 5000::bigint, 100, 95,   100::bigint, timestamptz '2031-03-03 10:00:00Z'),
    ('d0d0d0d0-0000-4000-8000-00000000000c'::uuid, 5000::bigint, 100, 95,   500::bigint, timestamptz '2031-03-03 09:00:00Z'),
    ('d0d0d0d0-0000-4000-8000-00000000000d'::uuid, 5000::bigint, 100, 90,     0::bigint, timestamptz '2031-03-03 08:00:00Z'),
    ('d0d0d0d0-0000-4000-8000-00000000000e'::uuid, 5000::bigint,   0,  0,     0::bigint, timestamptz '2031-03-03 07:00:00Z'),
    ('d0d0d0d0-0000-4000-8000-00000000000f'::uuid, 5000::bigint, 100, 95,   100::bigint, timestamptz '2031-03-03 11:00:00Z')
  ) as v(user_id, score, total, optimal, ev, done)
where c.challenge_date = date '2031-03-03';

-- ---------------------------------------------------------------------------
-- The ordering
-- ---------------------------------------------------------------------------

select results_eq(
  $$ select display_name::text
     from public.leaderboard_daily_challenge(date '2031-03-03', 100) $$,
  $$ values ('Entrant A'), ('Entrant B'), ('Entrant F'),
            ('Entrant C'), ('Entrant D'), ('Entrant E') $$,
  'score, then accuracy, then EV lost, then submission time — the specification''s order'
);

-- Each step of that order, named, so a failure says which rule broke rather than
-- just "the list is wrong".

select is(
  (select rank from public.leaderboard_daily_challenge(date '2031-03-03', 100)
   where display_name = 'Entrant A'),
  1,
  'the ending bankroll is still the primary metric and outranks every tie-break'
);

select ok(
  (select rank from public.leaderboard_daily_challenge(date '2031-03-03', 100)
   where display_name = 'Entrant C')
  <
  (select rank from public.leaderboard_daily_challenge(date '2031-03-03', 100)
   where display_name = 'Entrant D'),
  'a higher accuracy outranks cheaper mistakes: accuracy is the first tie-break'
);

select ok(
  (select rank from public.leaderboard_daily_challenge(date '2031-03-03', 100)
   where display_name = 'Entrant B')
  <
  (select rank from public.leaderboard_daily_challenge(date '2031-03-03', 100)
   where display_name = 'Entrant C')
  ,
  'at equal accuracy, the cheaper mistakes win: EV lost is the second tie-break'
);

select ok(
  (select rank from public.leaderboard_daily_challenge(date '2031-03-03', 100)
   where display_name = 'Entrant B')
  <
  (select rank from public.leaderboard_daily_challenge(date '2031-03-03', 100)
   where display_name = 'Entrant F'),
  'and submission time still separates two otherwise identical attempts, last'
);

select is(
  (select rank from public.leaderboard_daily_challenge(date '2031-03-03', 100)
   where display_name = 'Entrant E'),
  6,
  'an attempt with nothing graded ranks below every measured one, not above them'
);

-- The tie-break is visible. An ordering a player cannot see reads as an
-- arbitrary one, and "why am I below someone on the same score" is exactly the
-- question this board now has an answer to.
select is(
  (select detail from public.leaderboard_daily_challenge(date '2031-03-03', 100)
   where display_name = 'Entrant B'),
  '20 hands · 95% accurate',
  'and the row says what it was ranked on'
);

select is(
  (select detail from public.leaderboard_daily_challenge(date '2031-03-03', 100)
   where display_name = 'Entrant E'),
  '20 hands',
  'while an ungraded attempt claims no accuracy rather than claiming zero'
);

-- ---------------------------------------------------------------------------
-- Recording
-- ---------------------------------------------------------------------------
--
-- A replay has no entry row, which is how an unranked run cannot overwrite a
-- ranked score. The recorder must therefore be a no-op rather than an error when
-- it is handed a session with nothing in progress — enforced by never writing,
-- exactly like the rest of this mode.

select lives_ok(
  $$ select public.record_daily_attempt_decisions(
       '00000000-0000-4000-8000-000000000000'::uuid, 1, 1, 0) $$,
  'recording against a session with no attempt in progress writes nothing and does not fail'
);

select throws_ok(
  $$ select public.record_daily_attempt_decisions(
       '00000000-0000-4000-8000-000000000000'::uuid, 1, 2, 0) $$,
  '22023', null,
  'but claiming more optimal decisions than decisions is refused outright'
);

select * from finish();

rollback;
