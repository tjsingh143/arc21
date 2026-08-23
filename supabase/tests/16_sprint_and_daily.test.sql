-- =============================================================================
-- Arc 21 — the Sprint Tournament's structure, and today's daily challenge
--
-- Two things this file is careful about.
--
-- First, the format is asserted against `sprint_format()` field by field. The
-- client reads that function so a player sees the real configuration before
-- spending an entry fee, and `SPRINT` in
-- supabase/functions/_shared/tournament-format.ts mirrors it. A mirror nobody
-- checks is a second source of truth, so this is where the two are held together.
--
-- Second, scope. Assertions here count only THIS file's own fixtures, never
-- global rows: an earlier suite in this project reported 13 where it expected 1
-- because previous experiments had left rooms behind, and a test that fails on a
-- dirty database teaches people to ignore it.
-- =============================================================================

begin;

create extension if not exists pgtap with schema extensions;
set search_path to public, extensions, pg_catalog;

select plan(30);

-- ---------------------------------------------------------------------------
-- Every game mode is classified as wallet-backed or not
-- ---------------------------------------------------------------------------
--
-- `supabase/functions/_shared/session-economics.ts` decides which modes may move
-- chips into a wallet, and it lists the enum exhaustively so an unclassified mode
-- cannot default into either answer. This is the other half of that guard: adding
-- a label fails here until someone has placed it on one side or the other.
-- `career` was added in the closure mission and is NOT wallet-backed: a node's
-- 2,000 chips are a scoring medium, and crediting them would mint chips per
-- attempt.
--
-- It is not a stylistic assertion. Before that module existed, leaving a private
-- table credited its 5,000 session chips to the global wallet — 25,000 became
-- 30,000, repeatable — because nothing anywhere answered the question.
select enum_has_labels(
  'public', 'game_mode',
  array['practice', 'solo', 'private_table', 'public_table', 'tournament',
        'daily_challenge', 'career'],
  'every game mode is one session-economics knows about'
);

-- ---------------------------------------------------------------------------
-- The published format
-- ---------------------------------------------------------------------------

select has_function('public', 'sprint_format', 'the format is readable before entry');
select has_function('public', 'sprint_standings', array['uuid'], 'standings are a server function');
select has_function('public', 'my_sprint_entry', 'a player can find their own tournament');

select is((select seats from public.sprint_format()), 4, 'four players');
select is((select scheduled_hands from public.sprint_format()), 12, 'twelve scheduled hands');
select is((select starting_chips from public.sprint_format()), 10000::bigint, 'ten thousand equal stacks');
select is((select entry_fee_chips from public.sprint_format()), 500::bigint, 'a five hundred chip entry');
select is((select min_bet from public.sprint_format()), 100::bigint, 'minimum bet one hundred');
select is((select early_max_bet from public.sprint_format()), 2000::bigint, 'hands 1-8 cap at two thousand');
select is((select late_max_bet from public.sprint_format()), 5000::bigint, 'hands 9-12 cap at five thousand');
select is((select late_bets_from from public.sprint_format()), 9, 'the ceiling rises at hand nine');
select is((select elimination_hand from public.sprint_format()), 6, 'the elimination is after hand six');

-- The prize schedule, as the client renders it.
select is(
  (select jsonb_agg(value -> 'chips' order by (value ->> 'placement')::int)
   from public.sprint_format(), jsonb_array_elements(prize_structure) as value),
  '[2000, 1000, 500, 0]'::jsonb,
  'prizes are 2,000 / 1,000 / 500 / nothing'
);

-- ---------------------------------------------------------------------------
-- Structural columns the boundary logic depends on
-- ---------------------------------------------------------------------------

select has_column('public', 'tournaments', 'scheduled_hands_played',
  'scheduled hands are counted separately from hands dealt');
select has_column('public', 'tournaments', 'tie_break_boundary',
  'a sudden-death hand knows which boundary it is resolving');
select has_column('public', 'tournament_entries', 'eliminated_after_hand',
  'placement ordering needs the hand, not just the timestamp');

-- ---------------------------------------------------------------------------
-- Server-only functions are not reachable by a client
-- ---------------------------------------------------------------------------
-- These write progression and mint secrets. A client EXECUTE grant on any of
-- them would be a hole no amount of application logic could close.

select ok(
  not has_function_privilege('authenticated', 'public.award_milestone_xp(uuid, integer)', 'execute'),
  'a client cannot award itself XP'
);
select ok(
  not has_function_privilege('authenticated', 'public.ensure_daily_challenge_for(date)', 'execute'),
  'a client cannot mint a daily challenge, and so cannot choose its seed'
);
select ok(
  has_function_privilege('authenticated', 'public.ensure_todays_daily_challenge()', 'execute'),
  'but it can ask for today''s challenge through the checked wrapper'
);

-- ---------------------------------------------------------------------------
-- Today's daily challenge comes into being on demand
-- ---------------------------------------------------------------------------

insert into auth.users (id, email, aud, role) values
  ('0c000000-0000-4000-8000-000000000001', 'sprint-a@arc21.test', 'authenticated', 'authenticated');

set local role authenticated;
set local request.jwt.claims to
  '{"sub":"0c000000-0000-4000-8000-000000000001","role":"authenticated"}';

select lives_ok(
  $$ select public.ensure_todays_daily_challenge() $$,
  'a player opening the screen creates today''s challenge'
);

-- Asking twice is what a second player does, and what a reconnect does.
select lives_ok(
  $$ select public.ensure_todays_daily_challenge() $$,
  'and asking again is not an error'
);

select is(
  (select count(*)::int from public.daily_challenges
   where challenge_date = (now() at time zone 'utc')::date),
  1,
  'leaving exactly one challenge for the date'
);

-- The commitment is verified by a trigger on write, so a row existing at all is
-- proof the published hash matches the stored secret. This asserts the shape the
-- client actually reads.
select matches(
  (select seed_commitment from public.daily_challenges_public
   where challenge_date = (now() at time zone 'utc')::date),
  '^[0-9a-f]{64}$',
  'and publishing a SHA-256 commitment for it'
);

-- The seed itself must be unreachable. `select *` is refused by the privilege
-- system, not filtered by a policy, so there is no row-level mistake to make.
select throws_ok(
  $$ select seed_secret from public.daily_challenges $$,
  '42501', null,
  'while the seed stays unreadable to the player facing that shoe'
);

reset role;

-- The context is inside the secret, which is how the published commitment
-- commits to the DATE as well as the randomness. Checked as postgres, because
-- this is the one thing a client may never see.
select matches(
  (select seed_secret from public.daily_challenges
   where challenge_date = (now() at time zone 'utc')::date),
  '^arc21:daily:\d{4}-\d{2}-\d{2}:[0-9a-f]{64}$',
  'the seed carries its date context, so a commitment cannot be reused'
);

-- ---------------------------------------------------------------------------
-- The daily configuration, pinned
-- ---------------------------------------------------------------------------
--
-- `ensure_daily_challenge_for` writes these numbers, and `DAILY` in
-- supabase/functions/_shared/daily-challenge.ts states the same expected format.
-- The server READS the row rather than the constant, so a challenge minted with
-- different numbers is honoured — but the two must not drift silently, and this is
-- the assertion that stops them.
select is(
  (select hand_count from public.daily_challenges
   where challenge_date = (now() at time zone 'utc')::date),
  20,
  'twenty hands, matching DAILY.hands'
);

select is(
  (select starting_chips from public.daily_challenges
   where challenge_date = (now() at time zone 'utc')::date),
  5000::bigint,
  'five thousand challenge chips, matching DAILY.startingStack'
);

select is(
  (select reward_chips from public.daily_challenges
   where challenge_date = (now() at time zone 'utc')::date),
  1000::bigint,
  'a thousand chip reward for a completed ranked attempt'
);

select is(
  (select reward_xp from public.daily_challenges
   where challenge_date = (now() at time zone 'utc')::date),
  150,
  'and a hundred and fifty XP with it'
);

select * from finish();
rollback;
