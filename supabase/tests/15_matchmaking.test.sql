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

select plan(21);

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

-- --------------------------------------------------------------------------
-- One live seat per player
-- --------------------------------------------------------------------------
-- Reproduced against the running stack before the guard existed: a seated
-- player re-queued, was allocated a DIFFERENT room, and paid a second buy-in
-- out of the same wallet. The queue's refusal is a courtesy — the control is
-- `assertNoOtherLiveSeat` in `create-session`, beside the debit — but a
-- courtesy that is missing is what let the client reach the debit at all.

reset role;

insert into auth.users (id, email, aud, role) values
  ('0c000000-0000-4000-8000-000000000003', 'mm-c@arc21.test', 'authenticated', 'authenticated'),
  ('0d000000-0000-4000-8000-000000000004', 'mm-d@arc21.test', 'authenticated', 'authenticated');

insert into public.game_sessions (id, mode, ruleset_id, tier, status, max_seats, started_at)
select '0c000000-0000-4000-8000-00000000aaaa', 'public_table', r.id, 'casual', 'active', 5, now()
from public.rulesets r where r.ruleset_key = 'arc-standard@1';

insert into public.game_session_seats (game_session_id, seat_index, user_id, display_name, stack)
values ('0c000000-0000-4000-8000-00000000aaaa', 0,
        '0c000000-0000-4000-8000-000000000003', 'Seated', 2000);

set local role authenticated;
set local request.jwt.claims to
  '{"sub":"0c000000-0000-4000-8000-000000000003","role":"authenticated"}';

select throws_ok(
  $$ select public.join_matchmaking('casual') $$,
  'P0001', null,
  'a player holding a live seat is not queued for a second table'
);

select is(
  (select count(*)::int from public.matchmaking_queue
   where user_id = '0c000000-0000-4000-8000-000000000003'),
  0,
  'and no enrolment row was left behind by the refusal'
);

-- The guard is about a LIVE seat, not about ever having had one. A player whose
-- table has closed queues normally, or the refusal would be permanent.
reset role;
update public.game_sessions set status = 'completed', ended_at = now()
where id = '0c000000-0000-4000-8000-00000000aaaa';
set local role authenticated;
set local request.jwt.claims to
  '{"sub":"0c000000-0000-4000-8000-000000000003","role":"authenticated"}';

select lives_ok(
  $$ select public.join_matchmaking('casual') $$,
  'a player whose table has completed queues again'
);

-- --------------------------------------------------------------------------
-- A re-queue REUSES a matched enrolment
-- --------------------------------------------------------------------------
-- The lookup used to filter on `status = 'waiting'`, so a MATCHED player missed
-- it and a second enrolment was inserted — which the allocator then put in a
-- different room. That is the whole mechanism of the double buy-in.

create temporary table third_seat as
select room_id from public.poll_matchmaking();

select lives_ok(
  $$ select public.join_matchmaking('casual') $$,
  'a matched player may re-queue after a reconnect'
);

select is(
  (select count(*)::int from public.matchmaking_queue
   where user_id = '0c000000-0000-4000-8000-000000000003'
     and status in ('waiting', 'matched')),
  1,
  'and still holds exactly one live enrolment, not two'
);

-- --------------------------------------------------------------------------
-- Leaving a MATCH, not just a wait
-- --------------------------------------------------------------------------
-- `leave_matchmaking` cancelled `waiting` only, so a matched-but-unfunded
-- player could not release the lobby seat they were holding. Harmless while a
-- re-queue silently made a new entry; a permanent dead match now that it does
-- not.

select lives_ok(
  $$ select public.leave_matchmaking() $$,
  'a matched player can leave the queue'
);

-- Read as the owner, not as the player: `room_members_select_same_room` shows a
-- row only to somebody still IN that room, so a released seat is invisible to
-- the person who just released it. Asserting through the policy here would read
-- NULL and pass for the wrong reason.
reset role;
select is(
  (select status::text from public.room_members
   where user_id = '0c000000-0000-4000-8000-000000000003'
     and room_id = (select room_id from third_seat)),
  'left',
  'and the unfunded lobby seat is released'
);

-- But a FUNDED seat is not released by leaving the queue. The chips are in that
-- game's escrow and the way out is LEAVE_TABLE, which cashes them back.
insert into public.rooms (id, code, host_user_id, visibility, mode, max_seats, tier, game_session_id)
values ('0d000000-0000-4000-8000-0000000bbbbb', 'MMFUND',
        '0d000000-0000-4000-8000-000000000004', 'public', 'public_table', 5, 'casual',
        '0c000000-0000-4000-8000-00000000aaaa');
insert into public.room_members (room_id, user_id, seat_index)
values ('0d000000-0000-4000-8000-0000000bbbbb', '0d000000-0000-4000-8000-000000000004', 0);
insert into public.matchmaking_queue (user_id, tier, status, room_id, matched_at)
values ('0d000000-0000-4000-8000-000000000004', 'casual', 'matched',
        '0d000000-0000-4000-8000-0000000bbbbb', now());
update public.game_sessions set status = 'active'
where id = '0c000000-0000-4000-8000-00000000aaaa';
insert into public.game_session_seats (game_session_id, seat_index, user_id, display_name, stack)
values ('0c000000-0000-4000-8000-00000000aaaa', 1,
        '0d000000-0000-4000-8000-000000000004', 'Funded', 2000);

set local role authenticated;
set local request.jwt.claims to
  '{"sub":"0d000000-0000-4000-8000-000000000004","role":"authenticated"}';

select public.leave_matchmaking();

reset role;
select is(
  (select status::text from public.room_members
   where user_id = '0d000000-0000-4000-8000-000000000004'
     and room_id = '0d000000-0000-4000-8000-0000000bbbbb'),
  'joined',
  'a player who has already bought in keeps their seat'
);

select is(
  (select status::text from public.matchmaking_queue
   where user_id = '0d000000-0000-4000-8000-000000000004'),
  'cancelled',
  'though the queue entry itself is finished either way'
);

select * from finish();
rollback;

