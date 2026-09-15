-- =============================================================================
-- Arc 21 — rate limits
--
-- Three properties matter more than the numbers, and a test that only checks a
-- boundary proves none of them:
--
--   * the window ROLLS. A limit that resets on the hour can be doubled at 59
--     minutes past, so the assertions below place events at chosen ages either
--     side of the boundary rather than counting calls;
--   * one player's budget is their own;
--   * a refusal is not itself recorded, so a window always drains. Without that,
--     a caller hammering faster than the window would keep their own window
--     permanently full — a ban wearing a rate limit's clothes.
--
-- Everything here is scoped to users this file creates and to their own rows. It
-- counts nothing globally: a fixture that counts every row in a table fails the
-- day the feature ships.
--
-- `now()` is fixed for the duration of a transaction, which is what makes the
-- window boundaries exact rather than racy — an event inserted at
-- `now() - interval '61 minutes'` is exactly 61 minutes old at every statement
-- below.
-- =============================================================================

begin;

create extension if not exists pgtap with schema extensions;
set search_path to public, extensions, pg_catalog;

select plan(32);

-- ---------------------------------------------------------------------------
-- The limits live in one place
-- ---------------------------------------------------------------------------

select has_table('public', 'rate_limit_policies', 'the limits have a home');
select has_table('public', 'rate_limit_events', 'attempts are recorded');

-- Every action the product enforces has a configured policy. A typo in an
-- enforcement point would otherwise silently disable that limit — which is why
-- rate_limit_check RAISES on an unknown action rather than allowing it.
select bag_eq(
  $$ select distinct action from public.rate_limit_policies $$,
  $$ values ('friend_request'), ('room_create'), ('room_join'),
            ('matchmaking_enroll'), ('profile_username_change'),
            ('profile_display_name_change'), ('game_command_outside_game'),
            ('player_search') $$,
  'every action the specification names has a policy, and no action has one it does not'
);

-- `player_search` is phase 11's. Every OTHER social action was limited and the
-- directory search was not, so the two-character minimum inside `search_players`
-- was the only thing between an account and a walk of the player directory —
-- and that minimum was defeated by two metacharacters. Measured before the fix:
-- 108 calls, 445 distinct accounts, nothing refused.
select is(
  (select count(*)::int from public.rate_limit_policies where action = 'player_search'),
  2,
  'the player directory search is limited per minute AND per hour'
);

select ok(
  (select pg_get_functiondef(p.oid) ~ 'enforce_rate_limit\(''player_search''\)'
   from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'search_players'),
  'the limit is spent INSIDE search_players, where a modified client cannot skip it'
);

-- A `stable` function may not write, so the limit could not live inside a
-- `stable` search. The tempting shape — a limited wrapper beside an unlimited
-- body still granted to `authenticated` — is a control the client enforces and
-- the server does not.
select is(
  (select provolatile::text
   from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'search_players'),
  'v',
  'search_players is volatile, which is what makes the limit enforceable in it'
);

-- The specification asks for room creation "per minute/hour", so that action
-- carries two windows and the tighter one refuses first.
select is(
  (select count(*)::int from public.rate_limit_policies where action = 'room_create'),
  2,
  'room creation is limited per minute AND per hour'
);

-- The number that used to be a literal inside guard_profile_username. If it ever
-- goes back into a function body, this fails.
select is(
  (select window_length from public.rate_limit_policies where action = 'profile_username_change'),
  interval '30 days',
  'the username interval is configuration, not a literal in a function'
);

select is(
  (select count(*)::int
   from pg_proc p
   join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.proname in ('guard_profile_username', 'send_friend_request',
                       'create_private_room', 'join_private_room', 'join_matchmaking')
     and pg_get_functiondef(p.oid) ~ 'interval\s*''\d+\s*(minute|hour|day)'),
  0,
  'no enforcement point hard-codes a window of its own'
);

-- ---------------------------------------------------------------------------
-- A redefinition must not revert what a later migration added
-- ---------------------------------------------------------------------------
--
-- Adding a limit to these five meant `create or replace function`, which
-- replaces the WHOLE body. Two of them had already been redefined by later
-- migrations, and the first draft of `20260818100000_rate_limits.sql` copied the
-- earlier version of each — silently reverting the notification a friend request
-- writes, and the lobby expiry that runs when a room is created. The
-- notification regression was caught by an integration test; the room one was
-- caught by reading, because nothing covered it.
--
-- These two assertions are the cheap version of that reading. They do not check
-- behaviour, they check that the call is still IN the function, which is exactly
-- the thing a wholesale replacement removes.

select ok(
  (select pg_get_functiondef(p.oid) ~ 'notify_user'
   from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'send_friend_request'),
  'send_friend_request still notifies the recipient, as 20260817400000 made it'
);

select ok(
  (select pg_get_functiondef(p.oid) ~ 'expire_stale_rooms'
   from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'create_private_room'),
  'create_private_room still expires stale lobbies, as 20260816130000 made it'
);

-- ---------------------------------------------------------------------------
-- Nothing here is reachable by a client
-- ---------------------------------------------------------------------------

select is(
  (select count(*)::int
   from information_schema.role_table_grants
   where table_schema = 'public'
     and table_name in ('rate_limit_policies', 'rate_limit_events')
     and grantee in ('anon', 'authenticated')),
  0,
  'no client role holds any privilege on the policy or event tables'
);

select is(
  (select count(*)::int
   from pg_proc p
   join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.proname in ('consume_rate_limit', 'rate_limit_check', 'rate_limit_for')
     and (has_function_privilege('anon', p.oid, 'EXECUTE')
          or has_function_privilege('authenticated', p.oid, 'EXECUTE'))),
  0,
  'the functions that name a user id cannot be called by a client'
);

-- The one that IS granted, and the reason it is safe: it takes no user id.
select is(
  (select count(*)::int
   from pg_proc p
   join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.proname = 'enforce_rate_limit'
     and pg_get_function_arguments(p.oid) ~ 'uuid'),
  0,
  'the client-callable wrapper has no parameter through which one account could spend another''s budget'
);

-- ---------------------------------------------------------------------------
-- Fixtures — this file's own accounts, and nobody else's
-- ---------------------------------------------------------------------------

insert into auth.users (id, email, aud, role) values
  ('a11d0000-0000-4000-8000-000000000001', 'rl-one@arc21.test',   'authenticated', 'authenticated'),
  ('a11d0000-0000-4000-8000-000000000002', 'rl-two@arc21.test',   'authenticated', 'authenticated'),
  ('a11d0000-0000-4000-8000-000000000003', 'rl-three@arc21.test', 'authenticated', 'authenticated');

-- ---------------------------------------------------------------------------
-- The boundary
-- ---------------------------------------------------------------------------

-- Nineteen of the hour's twenty, all inside the window.
insert into public.rate_limit_events (user_id, action, occurred_at)
select 'a11d0000-0000-4000-8000-000000000001', 'friend_request', now() - interval '5 minutes'
from generate_series(1, 19);

select is(
  (public.rate_limit_check('a11d0000-0000-4000-8000-000000000001', 'friend_request')).allowed,
  true,
  'the twentieth attempt of twenty is allowed'
);

select is(
  (public.consume_rate_limit('a11d0000-0000-4000-8000-000000000001', 'friend_request')).allowed,
  true,
  'and taking it succeeds'
);

select is(
  (public.rate_limit_check('a11d0000-0000-4000-8000-000000000001', 'friend_request')).allowed,
  false,
  'the twenty-first is refused — the limit holds exactly at the boundary'
);

-- ---------------------------------------------------------------------------
-- A refusal is not recorded
-- ---------------------------------------------------------------------------

select is(
  (select count(*)::int from public.rate_limit_events
   where user_id = 'a11d0000-0000-4000-8000-000000000001' and action = 'friend_request'),
  20,
  'twenty events after twenty allowed attempts'
);

select lives_ok(
  $$ select public.consume_rate_limit('a11d0000-0000-4000-8000-000000000001', 'friend_request') $$,
  'a refused attempt reports a verdict rather than raising, at this level'
);

select is(
  (select count(*)::int from public.rate_limit_events
   where user_id = 'a11d0000-0000-4000-8000-000000000001' and action = 'friend_request'),
  20,
  'and records nothing, so the window drains rather than becoming a ban'
);

-- ---------------------------------------------------------------------------
-- The window rolls
-- ---------------------------------------------------------------------------

-- A full budget, every event 61 minutes old. Outside a one-hour rolling window,
-- so the budget is free — and this is the assertion a calendar bucket passes for
-- the wrong reason: at 59 minutes past the hour a bucket would ALSO be free.
insert into public.rate_limit_events (user_id, action, occurred_at)
select 'a11d0000-0000-4000-8000-000000000002', 'friend_request', now() - interval '61 minutes'
from generate_series(1, 20);

select is(
  (public.rate_limit_check('a11d0000-0000-4000-8000-000000000002', 'friend_request')).allowed,
  true,
  'a full budget aged past the window is spent and the player may act again'
);

-- The same budget at 59 minutes is still inside it. A calendar bucket that reset
-- on the hour would have allowed this one, which is the whole difference.
update public.rate_limit_events
set occurred_at = now() - interval '59 minutes'
where user_id = 'a11d0000-0000-4000-8000-000000000002' and action = 'friend_request';

select is(
  (public.rate_limit_check('a11d0000-0000-4000-8000-000000000002', 'friend_request')).allowed,
  false,
  'the same budget one minute inside the window is still spent'
);

select is(
  (public.rate_limit_check('a11d0000-0000-4000-8000-000000000002', 'friend_request')).retry_after,
  interval '1 minute',
  'and the caller is told how long until one slot frees'
);

-- Consuming prunes what can no longer matter, so the table holds at most one
-- window of history per player per action.
update public.rate_limit_events
set occurred_at = now() - interval '61 minutes'
where user_id = 'a11d0000-0000-4000-8000-000000000002' and action = 'friend_request';

select lives_ok(
  $$ select public.consume_rate_limit('a11d0000-0000-4000-8000-000000000002', 'friend_request') $$,
  'consuming after the window rolled succeeds'
);

select is(
  (select count(*)::int from public.rate_limit_events
   where user_id = 'a11d0000-0000-4000-8000-000000000002' and action = 'friend_request'),
  1,
  'and prunes the twenty spent events, leaving only the new one'
);

-- ---------------------------------------------------------------------------
-- One player's limit is their own
-- ---------------------------------------------------------------------------

select is(
  (public.rate_limit_check('a11d0000-0000-4000-8000-000000000003', 'friend_request')).allowed,
  true,
  'a third player is unaffected by either of the first two'
);

select is(
  (select count(*)::int from public.rate_limit_events
   where user_id = 'a11d0000-0000-4000-8000-000000000003'),
  0,
  'and has no events of their own'
);

-- ---------------------------------------------------------------------------
-- The refusal, as a client sees it
-- ---------------------------------------------------------------------------

set local role authenticated;
set local request.jwt.claims to
  '{"sub":"a11d0000-0000-4000-8000-000000000001","role":"authenticated"}';

-- PT429, so PostgREST answers HTTP 429. The pre-existing rename limit raised
-- 55000, which PostgREST renders as a 500 — a player who renamed twice in a
-- month was told the server had broken.
select throws_ok(
  $$ select public.enforce_rate_limit('friend_request') $$,
  'PT429', null,
  'a spent budget refuses with the SQLSTATE PostgREST maps to HTTP 429'
);

-- ---------------------------------------------------------------------------
-- A room join counts the attempts that FIND NOTHING
-- ---------------------------------------------------------------------------
--
-- This is the one that makes the limit real. A limit consumed inside the
-- caller's transaction is rolled back with it, so if an unknown code raised, a
-- code-guesser would never be charged and the limit would enforce nothing.
-- `join_private_room` returns no row instead, the attempt commits, and it counts.

set local request.jwt.claims to
  '{"sub":"a11d0000-0000-4000-8000-000000000003","role":"authenticated"}';

select ok(
  (select public.join_private_room('ZZZZZZ')) is null,
  'a code that does not resolve returns no row rather than raising'
);

select is(
  (select count(*)::int from (select public.join_private_room('QQQQQQ') from generate_series(1, 9)) s),
  9,
  'nine more guesses are answered the same way'
);

reset role;

select is(
  (select count(*)::int from public.rate_limit_events
   where user_id = 'a11d0000-0000-4000-8000-000000000003' and action = 'room_join'),
  10,
  'and every one of the ten failed guesses was charged'
);

set local role authenticated;
set local request.jwt.claims to
  '{"sub":"a11d0000-0000-4000-8000-000000000003","role":"authenticated"}';

select throws_ok(
  $$ select public.join_private_room('WWWWWW') $$,
  'PT429', null,
  'the eleventh guess in a minute is refused'
);

select * from finish();

rollback;
