-- =============================================================================
-- Arc 21 — a departure ends the reservation that produced the seat
--
-- THE DEFECT THIS PINS, measured against the running stack. A player cashes out
-- of a public table and searches again. `release_room_seat` set their
-- `room_members` row to `left` and left `matchmaking_queue` reading `matched`,
-- naming the room they had just left — and `join_matchmaking` returns a live
-- entry rather than enrolling afresh, deliberately, because that is how a
-- reconnecting player finds the room they were already given.
--
-- So the client was shown "Seat found" for a table it was no longer a member
-- of, and `JOIN_PUBLIC_TABLE` answered HTTP 403 NOT_A_PARTICIPANT — every tap,
-- for the two minutes `expire_stale_queue_entries` waits before retiring an
-- unfunded reservation. A player who left a table could not take another one.
--
-- TWO ENDS, and this file asserts both, because they answer different
-- questions. `release_room_seat` is where the reservation is SPENT, so that is
-- where it is closed. `join_matchmaking` will not hand back a `matched` entry
-- whose membership has gone, WHATEVER emptied it — which is what makes the
-- guarantee hold for a room emptied by some path nobody has written yet. Each
-- is proved on its own here; the integration test drives the player's whole
-- round trip over HTTP.
--
-- The reconnect the branch exists for is asserted too. A fix that broke it
-- would allocate a SECOND table to a player who already had one, which is the
-- defect `20260823100000_one_live_seat.sql` was written for.
--
-- Fixtures are scoped to ids this file owns and roll back with the transaction.
-- =============================================================================

begin;

create extension if not exists pgtap with schema extensions;
set search_path to public, extensions, pg_catalog;

select plan(9);

insert into auth.users (id, email, aud, role) values
  ('2c000000-0000-4000-8000-0000000000a1', 'leave-a@arc21.test', 'authenticated', 'authenticated'),
  ('2c000000-0000-4000-8000-0000000000b2', 'leave-b@arc21.test', 'authenticated', 'authenticated');

-- THE PRECONDITION IS ESTABLISHED, NOT ASSUMED — the same move
-- `15_matchmaking.test.sql` makes, for the same reason: whether this database
-- happens to hold a joinable public table is no part of the claim under test.
update public.rooms set status = 'closed'
where visibility = 'public' and mode = 'public_table' and status in ('lobby', 'active');
update public.matchmaking_queue set status = 'cancelled' where status in ('waiting', 'matched');

set local role authenticated;
set local request.jwt.claims to
  '{"sub":"2c000000-0000-4000-8000-0000000000a1","role":"authenticated"}';
select public.join_matchmaking('casual');
create temporary table lone_poll as select status from public.poll_matchmaking();  -- waiting: nobody else yet

set local request.jwt.claims to
  '{"sub":"2c000000-0000-4000-8000-0000000000b2","role":"authenticated"}';
select public.join_matchmaking('casual');
create temporary table opened as select room_id from public.poll_matchmaking();

set local request.jwt.claims to
  '{"sub":"2c000000-0000-4000-8000-0000000000a1","role":"authenticated"}';
create temporary table joined_room as select room_id from public.poll_matchmaking();

select is(
  (select room_id from joined_room),
  (select room_id from opened),
  'both players hold a reservation at one table'
);

select is(
  (select status::text from public.matchmaking_queue
   where user_id = '2c000000-0000-4000-8000-0000000000a1' and status in ('waiting', 'matched')),
  'matched',
  'and the queue entry says so'
);

-- ---------------------------------------------------------------------------
-- LEAVING SPENDS IT. `release_room_seat` is server-only, so it is called as the
-- owner — which is how `cashOut` reaches it.
-- ---------------------------------------------------------------------------

reset role;
select public.release_room_seat(
  (select room_id from joined_room), '2c000000-0000-4000-8000-0000000000a1'
);

select is(
  (select status::text from public.room_members
   where room_id = (select room_id from joined_room)
     and user_id = '2c000000-0000-4000-8000-0000000000a1'),
  'left',
  'the membership is released'
);

select is(
  (select count(*)::int from public.matchmaking_queue
   where user_id = '2c000000-0000-4000-8000-0000000000a1' and status in ('waiting', 'matched')),
  0,
  'and the reservation is spent rather than left pointing at the table just left'
);

-- The other player is untouched: one seat closing is not the table closing.
select is(
  (select status::text from public.matchmaking_queue
   where user_id = '2c000000-0000-4000-8000-0000000000b2' and status in ('waiting', 'matched')),
  'matched',
  'the player still sitting there keeps theirs'
);

-- ---------------------------------------------------------------------------
-- SEARCHING AGAIN IS A NEW SEARCH
-- ---------------------------------------------------------------------------

set local role authenticated;
set local request.jwt.claims to
  '{"sub":"2c000000-0000-4000-8000-0000000000a1","role":"authenticated"}';

select is(
  (select status::text from public.join_matchmaking('casual')),
  'waiting',
  'the returning player enrols afresh instead of being handed the room they left'
);

-- ---------------------------------------------------------------------------
-- THE SECOND LOCK. A `matched` entry whose membership has gone is stale however
-- it got that way — staged here directly, because the point is that
-- `join_matchmaking` does not depend on `release_room_seat` having tidied up.
-- ---------------------------------------------------------------------------

reset role;
update public.matchmaking_queue
set status = 'matched', room_id = (select room_id from joined_room), matched_at = now()
where user_id = '2c000000-0000-4000-8000-0000000000a1' and status = 'waiting';

set local role authenticated;
set local request.jwt.claims to
  '{"sub":"2c000000-0000-4000-8000-0000000000a1","role":"authenticated"}';

select is(
  (select status::text from public.join_matchmaking('casual')),
  'waiting',
  'a matched entry with no membership behind it is not a reconnect'
);

-- ---------------------------------------------------------------------------
-- AND THE RECONNECT STILL WORKS. A player who was matched and has NOT bought in
-- holds a `joined` membership; handing them a second table is the defect
-- `20260823100000_one_live_seat.sql` exists to stop.
-- ---------------------------------------------------------------------------

set local request.jwt.claims to
  '{"sub":"2c000000-0000-4000-8000-0000000000b2","role":"authenticated"}';

create temporary table reconnected as select id, status, room_id from public.join_matchmaking('casual');

select is(
  (select status::text from reconnected),
  'matched',
  'a matched player who re-queues is still reconnecting, not enrolling again'
);

select is(
  (select room_id from reconnected),
  (select room_id from opened),
  'and is given back the room they already hold'
);

select * from finish();
rollback;
