-- =============================================================================
-- Arc 21 — public matchmaking
--
-- Assertions here are scoped to this file's OWN fixtures, never to global row
-- counts. A first draft of these checks counted every room in the database and
-- reported 13 where it expected 1, because earlier experiments had left rooms
-- behind — a test that fails on a dirty database teaches people to ignore it.
--
-- The load-bearing assertion is the last one: matchmaking allocates seats and
-- moves no chips. The buy-in belongs to `apply_wallet_delta` in the session
-- function, which locks the wallet and honours an idempotency key. A second
-- chip-moving path here would double the surface for nothing.
-- =============================================================================

begin;

create extension if not exists pgtap with schema extensions;
set search_path to public, extensions, pg_catalog;

select plan(12);

select has_table('public', 'matchmaking_queue', 'the queue exists');
select has_function('public', 'join_matchmaking', 'joining is a server function');
select has_function('public', 'poll_matchmaking', 'allocation is a server function');

-- A player watches their own place and nothing else; the queue is not a
-- directory of who is playing what.
select table_privs_are(
  'public', 'matchmaking_queue', 'authenticated', array['SELECT'],
  'a player may read the queue but never write it');

insert into auth.users (id, email, aud, role) values
  ('0a000000-0000-4000-8000-000000000001', 'mm-a@arc21.test', 'authenticated', 'authenticated'),
  ('0b000000-0000-4000-8000-000000000002', 'mm-b@arc21.test', 'authenticated', 'authenticated');

set local role authenticated;
set local request.jwt.claims to
  '{"sub":"0a000000-0000-4000-8000-000000000001","role":"authenticated"}';

-- --------------------------------------------------------------------------
-- Queueing
-- --------------------------------------------------------------------------

select lives_ok(
  $$ select public.join_matchmaking('casual') $$,
  'a player joins the queue'
);

-- Tapping twice, or reconnecting, must not queue twice — the allocator would
-- otherwise seat the same person into two seats at one table.
select lives_ok(
  $$ select public.join_matchmaking('casual') $$,
  'joining again is not an error'
);

select is(
  (select count(*)::int from public.matchmaking_queue
   where user_id = '0a000000-0000-4000-8000-000000000001' and status = 'waiting'),
  1,
  'and leaves exactly one live entry'
);

-- The level gate is checked here as a courtesy and again beside the money.
select throws_ok(
  $$ select public.join_matchmaking('high') $$,
  'P0001', null,
  'the high table is refused below level 10'
);

-- --------------------------------------------------------------------------
-- Allocation puts the second player at the FIRST player's table
-- --------------------------------------------------------------------------

create temporary table first_seat as
select room_id from public.poll_matchmaking();

set local request.jwt.claims to
  '{"sub":"0b000000-0000-4000-8000-000000000002","role":"authenticated"}';

select public.join_matchmaking('casual');

create temporary table second_seat as
select room_id from public.poll_matchmaking();

select is(
  (select room_id from second_seat),
  (select room_id from first_seat),
  'the second player is seated at the first player''s table, not a new one'
);

-- Counted among THIS file's own users, not every seat at the table. Matchmaking
-- correctly fills a table that already has people at it, so a global count here
-- reports whoever else the database happens to be holding — which is how this
-- assertion first failed with 3 where it expected 2.
select is(
  (select count(*)::int from public.room_members
   where room_id = (select room_id from first_seat)
     and status = 'joined'
     and user_id in (
       '0a000000-0000-4000-8000-000000000001',
       '0b000000-0000-4000-8000-000000000002'
     )),
  2,
  'both of this test''s players hold a seat there'
);

-- --------------------------------------------------------------------------
-- The invariant
-- --------------------------------------------------------------------------

select is(
  (select count(*)::int from public.wallet_ledger
   where reason <> 'initial_grant'
     and user_id in (
       '0a000000-0000-4000-8000-000000000001',
       '0b000000-0000-4000-8000-000000000002'
     )),
  0,
  'matchmaking allocated seats and moved no chips — the buy-in is the session function''s job'
);

-- --------------------------------------------------------------------------
-- Filling, not spreading
-- --------------------------------------------------------------------------
-- The first implementation used `for update skip locked`, which is safe but
-- wrong: under contention each poller SKIPPED the table another was holding and
-- opened its own, so six players arriving together landed at FIVE tables.
-- Measured against the live stack, not theorised. Allocation is now serialised
-- per tier by an advisory lock, and six players fill one table before starting
-- a second.
select is(
  (select count(distinct room_id)::int from public.matchmaking_queue
   where status = 'matched'
     and user_id in (
       '0a000000-0000-4000-8000-000000000001',
       '0b000000-0000-4000-8000-000000000002'
     )),
  1,
  'two players at the same stakes share one table rather than opening two'
);

select * from finish();
rollback;
