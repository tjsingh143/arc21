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
--
-- TWO RULES ADDED IN PHASE 7, both of which this file now asserts because both
-- were reproduced against the running stack as defects:
--
--   * a table that has DEALT still takes players. `poll_matchmaking` only ever
--     considered rooms at `status = 'lobby'` and the buy-in sets a room to
--     `active`, so the second player to arrive at a tier always opened a brand
--     new table. Two people who both chose Casual four seconds apart never met,
--     and the mid-shoe join `joinPublicTable` implements — a seat appended to a
--     live engine state, dealt in at the next BETTING_OPEN — was unreachable;
--
--   * nobody opens a table alone. A lone player's first poll used to create a
--     room and answer `matched`, so `status = 'waiting'` lasted milliseconds
--     and the specification's Keep Waiting / Play Solo / Cancel offer after
--     twenty seconds could not be shown to anybody.
-- =============================================================================

begin;

create extension if not exists pgtap with schema extensions;
set search_path to public, extensions, pg_catalog;

select plan(36);

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
-- A LONE PLAYER WAITS. Nobody opens a public table by themselves.
-- --------------------------------------------------------------------------
-- The defect this replaces: the first poll created a room and answered
-- `matched`, so no player ever observed `waiting` and every control the
-- specification puts behind a twenty-second wait was unreachable code.
--
-- THE PRECONDITION IS ESTABLISHED, NOT ASSUMED. The claim under test is what
-- the allocator does when there is nowhere to sit, and whether this database
-- happens to be holding a joinable public table left behind by an earlier run
-- is no part of it. Asserting without this passed on a fresh database and
-- reported `matched` on a used one — the same "a test that fails on a dirty
-- database teaches people to ignore it" lesson as the row counts above, from
-- the other direction. Everything here rolls back with the transaction.

reset role;
update public.rooms set status = 'closed'
where visibility = 'public' and mode = 'public_table' and status in ('lobby', 'active');
update public.matchmaking_queue set status = 'cancelled'
where status = 'waiting' and user_id <> '0a000000-0000-4000-8000-000000000001';
set local role authenticated;
set local request.jwt.claims to
  '{"sub":"0a000000-0000-4000-8000-000000000001","role":"authenticated"}';

create temporary table first_poll as
select status, room_id, others_waiting from public.poll_matchmaking();

select is(
  (select status::text from first_poll),
  'waiting',
  'a lone player is still searching, not seated at a table of one'
);

select is(
  (select room_id from first_poll),
  null,
  'and no room was opened for them'
);

-- The REASON, reported rather than inferred. `others_waiting` is what the
-- decision turns on, and it used to be returned as a literal zero from the two
-- `matched` branches while being measured only in this one — a column that read
-- as a fact in one answer and as a placeholder in the others. It is now counted
-- once and reported by every branch, which is what lets the integration suite
-- state the rule relationally on a database it does not own.
select is(
  (select others_waiting from first_poll),
  0,
  'because the server counted nobody else at these stakes'
);

-- --------------------------------------------------------------------------
-- A SECOND PLAYER MAKES A TABLE, and both end up at it
-- --------------------------------------------------------------------------

set local request.jwt.claims to
  '{"sub":"0b000000-0000-4000-8000-000000000002","role":"authenticated"}';

select public.join_matchmaking('casual');

create temporary table second_seat as
select room_id, others_waiting from public.poll_matchmaking();

select isnt(
  (select room_id from second_seat),
  null,
  'the second player to arrive opens the table'
);

select is(
  (select others_waiting from second_seat),
  1,
  'and says so: it opened one because somebody was waiting for it'
);

-- Back to the first player, whose next poll finds the table that now exists.
set local request.jwt.claims to
  '{"sub":"0a000000-0000-4000-8000-000000000001","role":"authenticated"}';

create temporary table first_seat as
select room_id, queued_at_tier from public.poll_matchmaking();

select is(
  (select room_id from first_seat),
  (select room_id from second_seat),
  'and the player who was waiting joins it rather than opening a second'
);

select is(
  (select queued_at_tier from first_seat),
  1,
  'and is told how many were already sitting there'
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

-- `PT409`, not `P0001`. PostgREST maps SQLSTATE `PTnnn` to HTTP nnn, so this is
-- the one refusal the queue screen can tell from every other — and it is the
-- one whose answer is not "try again" but "your chips are at that other table".
-- Raised as `P0001` it arrived as HTTP 400 with a lowercase sentence and no
-- code, so the screen printed the server's words and offered nothing to do.
select throws_ok(
  $$ select public.join_matchmaking('casual') $$,
  'PT409', null,
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

-- A third player does not open a third table while one with room in it exists.
select is(
  (select room_id from third_seat),
  (select room_id from first_seat),
  'a later arrival fills the table that is already open'
);

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

-- --------------------------------------------------------------------------
-- A TABLE THAT HAS DEALT STILL TAKES PLAYERS
-- --------------------------------------------------------------------------
-- THE DEFECT, measured against the running stack with two real accounts before
-- this section existed. `poll_matchmaking` filtered on `status = 'lobby'` and
-- `JOIN_PUBLIC_TABLE` sets a room to `active` as it funds the first seat, so
-- the second player to arrive at a tier ALWAYS opened a new table:
--
--     A poll  -> matched, room 4285219d-…   (lobby)
--     A buys in                              (room -> active)
--     B poll  -> matched, room e67e20e4-…   <- a different table
--
-- Everything downstream followed from that. A "public table" was a solo table
-- with a queue in front of it, and the mid-shoe join `create-session` already
-- implements — a seat appended to a live engine state, dealt in at the next
-- BETTING_OPEN — could not be reached by any allocation.
--
-- Its own room and its own session, so nothing here disturbs the fixtures above.

reset role;

insert into auth.users (id, email, aud, role) values
  ('0e000000-0000-4000-8000-000000000005', 'mm-e@arc21.test', 'authenticated', 'authenticated'),
  ('0f000000-0000-4000-8000-000000000006', 'mm-f@arc21.test', 'authenticated', 'authenticated');

insert into public.game_sessions (id, mode, ruleset_id, tier, status, max_seats, started_at)
select '0e000000-0000-4000-8000-00000000cccc', 'public_table', r.id, 'standard', 'active', 5, now()
from public.rulesets r where r.ruleset_key = 'arc-standard@1';

-- A room mid-hand: `active`, with a live session and one funded seat at it.
insert into public.rooms (id, code, host_user_id, visibility, mode, max_seats, tier,
                          status, game_session_id)
values ('0e000000-0000-4000-8000-0000000dddd1', 'MMLIVE',
        '0e000000-0000-4000-8000-000000000005', 'public', 'public_table', 5, 'standard',
        'active', '0e000000-0000-4000-8000-00000000cccc');
insert into public.room_members (room_id, user_id, seat_index)
values ('0e000000-0000-4000-8000-0000000dddd1', '0e000000-0000-4000-8000-000000000005', 0);
insert into public.game_session_seats (game_session_id, seat_index, user_id, display_name, stack)
values ('0e000000-0000-4000-8000-00000000cccc', 0,
        '0e000000-0000-4000-8000-000000000005', 'Playing', 1900);

set local role authenticated;
set local request.jwt.claims to
  '{"sub":"0f000000-0000-4000-8000-000000000006","role":"authenticated"}';

select public.join_matchmaking('standard');

create temporary table live_table_seat as
select status, room_id, queued_at_tier from public.poll_matchmaking();

select is(
  (select room_id from live_table_seat),
  '0e000000-0000-4000-8000-0000000dddd1'::uuid,
  'a newcomer is seated at the table that is already playing'
);

select is(
  (select status::text from live_table_seat),
  'matched',
  'and is matched rather than left waiting for a table of their own'
);

-- --------------------------------------------------------------------------
-- NEVER OVERFILL. A full table is not a candidate.
-- --------------------------------------------------------------------------
-- The capacity decision is made under the per-tier advisory lock, and it is
-- checked AGAIN beside the money in `joinPublicTable` — a courtesy and a
-- control, the same pairing as the level gate.

reset role;

-- Fill the remaining four seats of that room with strangers.
-- Seats 0 and 1 are already held: the funded player, and the newcomer the
-- allocation above just placed. Three more fill it to `max_seats`.
insert into auth.users (id, email, aud, role)
select ('10000000-0000-4000-8000-00000000000' || s)::uuid,
       'mm-full-' || s || '@arc21.test', 'authenticated', 'authenticated'
from generate_series(2, 4) s;

insert into public.room_members (room_id, user_id, seat_index)
select '0e000000-0000-4000-8000-0000000dddd1',
       ('10000000-0000-4000-8000-00000000000' || s)::uuid,
       s
from generate_series(2, 4) s;

insert into auth.users (id, email, aud, role) values
  ('11000000-0000-4000-8000-000000000007', 'mm-g@arc21.test', 'authenticated', 'authenticated');

set local role authenticated;
set local request.jwt.claims to
  '{"sub":"11000000-0000-4000-8000-000000000007","role":"authenticated"}';

select public.join_matchmaking('standard');

create temporary table full_table_poll as
select status, room_id from public.poll_matchmaking();

select isnt(
  (select room_id from full_table_poll),
  '0e000000-0000-4000-8000-0000000dddd1'::uuid,
  'a table with five seats taken does not take a sixth player'
);

-- And with nowhere else to sit and nobody else waiting, they wait. That is the
-- other half of the same rule: a table is never opened for one person.
select is(
  (select status::text from full_table_poll),
  'waiting',
  'they wait instead, rather than opening a table of one'
);

-- --------------------------------------------------------------------------
-- A RESERVATION THAT IS NEVER TAKEN UP EXPIRES
-- --------------------------------------------------------------------------
-- `matchmaking_queue`'s own comment has said since the table was created that a
-- client which vanishes "must not hold a place forever and make a table look
-- busier than it is" — and the housekeeping only ever expired `waiting` rows.
-- Taking a matched seat up is a deliberate second step, because it is the tap
-- that spends 2,000 chips; close the app on that screen and the seat was held
-- for the life of the room. Observed while proving the allocation fix: a room
-- reported three seats taken with two people playing at it.
--
-- The release refuses where the player DOES hold a live seat at that room's
-- game. That one is not a reservation, it is a player.

reset role;

insert into auth.users (id, email, aud, role) values
  ('12000000-0000-4000-8000-000000000008', 'mm-h@arc21.test', 'authenticated', 'authenticated');

insert into public.rooms (id, code, host_user_id, visibility, mode, max_seats, tier, status)
values ('12000000-0000-4000-8000-0000000eeee1', 'MMHOLD',
        '12000000-0000-4000-8000-000000000008', 'public', 'public_table', 5, 'high', 'lobby');
insert into public.room_members (room_id, user_id, seat_index)
values ('12000000-0000-4000-8000-0000000eeee1', '12000000-0000-4000-8000-000000000008', 0);
insert into public.matchmaking_queue (user_id, tier, status, room_id, matched_at)
values ('12000000-0000-4000-8000-000000000008', 'high', 'matched',
        '12000000-0000-4000-8000-0000000eeee1', now() - interval '10 minutes');

select lives_ok(
  $$ select public.expire_stale_queue_entries() $$,
  'housekeeping runs'
);

select is(
  (select status::text from public.room_members
   where room_id = '12000000-0000-4000-8000-0000000eeee1'
     and user_id = '12000000-0000-4000-8000-000000000008'),
  'left',
  'an unfunded reservation older than the grace window releases its seat'
);

select is(
  (select status::text from public.matchmaking_queue
   where user_id = '12000000-0000-4000-8000-000000000008'),
  'expired',
  'and the enrolment behind it is finished'
);

-- The same age, but the player is actually SITTING at that room's table. The
-- seat is theirs and nothing may take it.
insert into public.game_sessions (id, mode, ruleset_id, tier, status, max_seats, started_at)
select '13000000-0000-4000-8000-00000000ffff', 'public_table', r.id, 'high', 'active', 5, now()
from public.rulesets r where r.ruleset_key = 'arc-standard@1';

insert into auth.users (id, email, aud, role) values
  ('13000000-0000-4000-8000-000000000009', 'mm-i@arc21.test', 'authenticated', 'authenticated');

insert into public.rooms (id, code, host_user_id, visibility, mode, max_seats, tier,
                          status, game_session_id)
values ('13000000-0000-4000-8000-0000000eeee2', 'MMSEAT',
        '13000000-0000-4000-8000-000000000009', 'public', 'public_table', 5, 'high',
        'active', '13000000-0000-4000-8000-00000000ffff');
insert into public.room_members (room_id, user_id, seat_index)
values ('13000000-0000-4000-8000-0000000eeee2', '13000000-0000-4000-8000-000000000009', 0);
insert into public.game_session_seats (game_session_id, seat_index, user_id, display_name, stack)
values ('13000000-0000-4000-8000-00000000ffff', 0,
        '13000000-0000-4000-8000-000000000009', 'Funded', 2000);
insert into public.matchmaking_queue (user_id, tier, status, room_id, matched_at)
values ('13000000-0000-4000-8000-000000000009', 'high', 'matched',
        '13000000-0000-4000-8000-0000000eeee2', now() - interval '10 minutes');

select public.expire_stale_queue_entries();

select is(
  (select status::text from public.room_members
   where room_id = '13000000-0000-4000-8000-0000000eeee2'
     and user_id = '13000000-0000-4000-8000-000000000009'),
  'joined',
  'but a player who has actually bought in keeps their seat'
);

select * from finish();
rollback;


