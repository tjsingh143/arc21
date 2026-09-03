-- =============================================================================
-- Arc 21 — what one client request may ask the server to produce
--
-- Two ceilings, and the hard part of testing either is that a local database is
-- far below both of them. A leaderboard here holds a hundred-odd rows and a
-- ceiling of ten thousand is invisible; an account holds one device and a
-- ceiling of ten is invisible. Asserting `p_limit => 2147483647` returns
-- "everything" would pass identically with the clamp present and absent, which
-- is the empty-fixture mistake this repository has now made three times.
--
-- So both ceilings are tested by MOVING them. `leaderboard_page_maximum()` is
-- redefined to a number the fixture can exceed, inside the transaction, and the
-- rollback puts it back. That proves the clamp is wired to the constant AND that
-- the constant bounds the answer — which is the whole claim.
-- =============================================================================

begin;

create extension if not exists pgtap with schema extensions;
set search_path to public, extensions, pg_catalog;

select plan(18);

-- ---------------------------------------------------------------------------
-- The ceilings exist and are stated in one place each
-- ---------------------------------------------------------------------------

select has_function('public', 'leaderboard_page_maximum', 'the page ceiling has a name');
select has_function('public', 'push_tokens_per_account_maximum', 'so does the device ceiling');

-- Server-only. Nothing a client calls needs to read a constant, and the
-- authorization gate refuses a `public` function `authenticated` can execute
-- that its allowlist does not name — which is how these two came to be revoked.
select is(
  (select count(*)::int from (
     values ('leaderboard_page_maximum'), ('push_tokens_per_account_maximum')
   ) as f(name)
   where has_function_privilege('authenticated', ('public.' || f.name || '()')::regprocedure, 'execute')),
  0,
  'neither ceiling is callable by a client'
);

-- Every board reads the same constant. A board that grew its own literal would
-- pass every behavioural test in this file and drift the day somebody changed
-- the number.
select is(
  (select count(*)::int
   from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.proname in ('leaderboard_weekly_xp', 'leaderboard_tournament_wins',
                       'leaderboard_strategy_accuracy', 'leaderboard_daily_challenge',
                       'my_leaderboard_position')
     and pg_get_functiondef(p.oid) ~ 'leaderboard_page_maximum\(\)'),
  5,
  'all four boards and my_leaderboard_position read the ONE ceiling'
);

-- And none of them still bounds only from below. `greatest(p_limit, 1)` with no
-- `least` around it is the exact shape that shipped.
select is(
  (select count(*)::int
   from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.proname like 'leaderboard_%'
     and pg_get_functiondef(p.oid) ~ 'limit\s+greatest\('),
  0,
  'no board clamps its page from below only'
);

-- ---------------------------------------------------------------------------
-- The leaderboard ceiling actually bites
-- ---------------------------------------------------------------------------

insert into auth.users (id, email, aud, role) values
  ('bd000000-0000-4000-8000-000000000001', 'bounded-1@arc21.test', 'authenticated', 'authenticated'),
  ('bd000000-0000-4000-8000-000000000002', 'bounded-2@arc21.test', 'authenticated', 'authenticated'),
  ('bd000000-0000-4000-8000-000000000003', 'bounded-3@arc21.test', 'authenticated', 'authenticated'),
  ('bd000000-0000-4000-8000-000000000004', 'bounded-4@arc21.test', 'authenticated', 'authenticated'),
  ('bd000000-0000-4000-8000-000000000005', 'bounded-5@arc21.test', 'authenticated', 'authenticated');

-- Five ranked players of this file's own, with XP high enough that they sit at
-- the top of whatever else the database happens to hold. The assertions below
-- still never count global rows — they compare page sizes with each other.
insert into public.player_daily_xp (user_id, utc_day, repeatable_xp, milestone_xp)
select id, public.utc_week_start(), 900000 + (row_number() over (order by id)) * 1000, 0
from auth.users
where id::text like 'bd000000-%';

-- Ten thousand is invisible here, so move it. The board is redefined by nothing;
-- only the constant it reads changes, which is the point.
create or replace function public.leaderboard_page_maximum()
returns integer language sql immutable as $ceiling$ select 3 $ceiling$;

select is(
  (select count(*)::int from public.leaderboard_weekly_xp(2147483647, 0)),
  3,
  'a page of 2147483647 is answered with the ceiling, not with the board'
);

select is(
  (select count(*)::int from public.leaderboard_weekly_xp(2, 0)),
  2,
  'and a page BELOW the ceiling is still the page that was asked for'
);

select is(
  (select count(*)::int from public.leaderboard_weekly_xp(-5, 0)),
  1,
  'the lower bound survives: a negative page is one row, never all of them'
);

select is(
  (select count(*)::int from public.leaderboard_tournament_wins(2147483647, 0)),
  (select least(3, count(*)::int) from public.leaderboard_tournament_wins(2147483647, 0)),
  'the tournament board clamps to the same ceiling'
);

-- Paging is unaffected: the second page starts where the first stopped, which is
-- the property phase 9 established when it moved paging onto row_number().
select is(
  (select count(*)::int from (
     select display_name, value from public.leaderboard_weekly_xp(3, 0)
     intersect
     select display_name, value from public.leaderboard_weekly_xp(3, 3)
   ) as overlap),
  0,
  'two clamped pages still do not overlap'
);

create or replace function public.leaderboard_page_maximum()
returns integer language sql immutable as $ceiling$ select 10000 $ceiling$;

select is(
  public.leaderboard_page_maximum(),
  10000,
  'and the shipped ceiling is ten thousand'
);

-- ---------------------------------------------------------------------------
-- The device ceiling actually bites, and EVICTS rather than refusing
-- ---------------------------------------------------------------------------
--
-- Measured before this existed: 200 registrations for one account in 1.9 s,
-- with no ceiling in that number — only in how long the loop was left running.
-- Rows are the cheap half. `pending_push_deliveries` JOINS notifications to
-- tokens, so N registrations turn one notification into N outbound messages.

set local role authenticated;
set local request.jwt.claims to
  '{"sub":"bd000000-0000-4000-8000-000000000001","role":"authenticated"}';

select public.register_push_token('ExponentPushToken[bounded-' || g || ']', 'ios', 'device-' || g, '{your_turn}')
from generate_series(1, 40) as g;

select is(
  (select count(*)::int from public.push_tokens
   where user_id = 'bd000000-0000-4000-8000-000000000001'),
  10,
  'forty registrations leave ten, not forty'
);

/*
 * THE ONE JUST WRITTEN MUST ALWAYS SURVIVE, and this assertion is the reason
 * the delete names the token instead of trusting the ordering.
 *
 * The first version of the fix kept "the newest ten" and argued that the row
 * just inserted is always the newest. `now()` is FIXED for a transaction, so all
 * forty rows above carry the same `last_used_at`, the survivors were chosen by a
 * random uuid, and the registration the caller had just made was among the
 * thirty deleted — a device left with no working registration by the very call
 * that registered it. Written this way the assertion cannot pass by luck.
 */
select is(
  (select count(*)::int from public.push_tokens
   where user_id = 'bd000000-0000-4000-8000-000000000001'
     and token = 'ExponentPushToken[bounded-40]'),
  1,
  'the registration just made is one of the ten'
);

-- Eviction is by LAST USE, so a phone still in somebody's hand outlives one that
-- was replaced. Spread the survivors' timestamps so "oldest" means something,
-- then register an eleventh and ask which one went.
update public.push_tokens t
set last_used_at = now() - (interval '1 hour' * r.n)
from (
  select id, row_number() over (order by token) as n
  from public.push_tokens
  where user_id = 'bd000000-0000-4000-8000-000000000001'
) as r
where t.id = r.id;

select is(
  (select count(*)::int from public.push_tokens
   where user_id = 'bd000000-0000-4000-8000-000000000001'),
  10,
  'ten devices, each with a distinct last use'
);

create temporary table oldest_before on commit drop as
select token from public.push_tokens
where user_id = 'bd000000-0000-4000-8000-000000000001'
order by last_used_at asc limit 1;

select public.register_push_token('ExponentPushToken[bounded-eleventh]', 'ios', 'device-11', '{your_turn}');

select is(
  (select count(*)::int from public.push_tokens
   where user_id = 'bd000000-0000-4000-8000-000000000001'),
  10,
  'an eleventh device does not make eleven rows'
);

select is(
  (select count(*)::int from public.push_tokens p
   join oldest_before o on o.token = p.token
   where p.user_id = 'bd000000-0000-4000-8000-000000000001'),
  0,
  'and the one that went is the least recently used, not an arbitrary row'
);

select is(
  (select count(*)::int from public.push_tokens
   where user_id = 'bd000000-0000-4000-8000-000000000001'
     and token = 'ExponentPushToken[bounded-eleventh]'),
  1,
  'while the eleventh is registered and usable'
);

-- Re-registering a device the account already holds is an UPDATE, so it neither
-- adds a row nor evicts one. A phone that opens the app twice must not cost its
-- owner a device.
select public.register_push_token('ExponentPushToken[bounded-eleventh]', 'ios', 'device-11', '{your_turn}');

select is(
  (select count(*)::int from public.push_tokens
   where user_id = 'bd000000-0000-4000-8000-000000000001'),
  10,
  'and registering it again changes nothing, because that is an update'
);

reset role;

select * from finish();
rollback;
