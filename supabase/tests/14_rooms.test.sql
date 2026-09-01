-- =============================================================================
-- Arc 21 — private tables
--
-- The single most important assertion in this file is the last one: a private
-- table cannot move a chip into or out of a wallet. Everything else here is
-- ordinary lifecycle correctness; that one is the anti-collusion rule, and if
-- it ever fails, two accounts can transfer a bankroll by agreeing to lose.
-- =============================================================================

begin;

create extension if not exists pgtap with schema extensions;
set search_path to public, extensions, pg_catalog;

select plan(32);

select has_table('public', 'rooms', 'rooms exist');
select has_table('public', 'room_members', 'seats at a room exist');

-- --------------------------------------------------------------------------
-- A seat is occupied only while somebody is sitting in it
-- --------------------------------------------------------------------------
-- `leave_room` and `remove_room_member` both KEEP the member row, and both keep
-- its `seat_index`. A whole-table `unique (room_id, seat_index)` therefore made
-- a vacated seat unfillable: the next player to join was allocated the free
-- seat number, collided with the departed member's row and got 23505 at a table
-- with a seat visibly empty. Asserted here rather than only in the integration
-- test because the thing that must not come back is a SCHEMA decision.

select is(
  (select count(*)::int
   from pg_constraint c
   join pg_class t on t.oid = c.conrelid
   join pg_namespace n on n.oid = t.relnamespace
   where n.nspname = 'public' and t.relname = 'room_members' and c.contype = 'u'
     and pg_get_constraintdef(c.oid) = 'UNIQUE (room_id, seat_index)'),
  0,
  'no whole-table unique on (room_id, seat_index) — a departed member holds no seat'
);

select matches(
  (select indexdef from pg_indexes
   where schemaname = 'public' and tablename = 'room_members'
     and indexname = 'room_members_live_seat_idx'),
  $re$WHERE \(status = 'joined'$re$,
  'two JOINED members of one room still cannot share a seat'
);

-- --------------------------------------------------------------------------
-- Room codes
-- --------------------------------------------------------------------------

select matches(
  public.generate_room_code(),
  '^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{6}$',
  'a code is six characters from the unambiguous alphabet'
);

-- O/0 and I/1 are excluded because a code is read aloud and typed by hand.
select is(
  (select count(*)::int from generate_series(1, 40) g
   where public.generate_room_code() ~ '[O0I1]'),
  0,
  'and never contains O, 0, I or 1'
);

insert into auth.users (id, email, aud, role) values
  ('cccccccc-0000-4000-8000-000000000001', 'rm-host@arc21.test', 'authenticated', 'authenticated'),
  ('dddddddd-0000-4000-8000-000000000002', 'rm-guest@arc21.test', 'authenticated', 'authenticated'),
  ('eeeeeeee-0000-4000-8000-000000000003', 'rm-third@arc21.test', 'authenticated', 'authenticated');

set local role authenticated;
set local request.jwt.claims to
  '{"sub":"cccccccc-0000-4000-8000-000000000001","role":"authenticated"}';

select lives_ok(
  $$ select public.create_private_room(2) $$,
  'the host opens a table'
);

-- Captured while the host can still see it. RLS hides the room from everyone
-- not seated at it, so a guest genuinely cannot look the code up — they are
-- told it. Stashing it here is what "the host sent me the code" looks like.
create temporary table invite as
select id as room_id, code from public.rooms limit 1;

-- One live room per host, or a player could hold codes indefinitely.
select throws_ok(
  $$ select public.create_private_room(2) $$,
  'P0001', null,
  'a host cannot open a second table while one is live'
);

select throws_ok(
  $$ select public.create_private_room(9) $$,
  'P0001', null,
  'a private table seats between two and five'
);

-- --------------------------------------------------------------------------
-- Joining
-- --------------------------------------------------------------------------

set local request.jwt.claims to
  '{"sub":"dddddddd-0000-4000-8000-000000000002","role":"authenticated"}';

-- Typed by hand: lower case and a stray space must still find the table.
select lives_ok(
  $$ select public.join_private_room(
       lower(substr((select code from invite), 1, 3)) || ' ' ||
       lower(substr((select code from invite), 4, 3))) $$,
  'a code typed in lower case with a space still joins'
);

select is(
  (select count(*)::int from public.room_members
   where room_id = (select room_id from invite) and status = 'joined'),
  2,
  'both players hold a seat'
);

-- The room was created with two seats, so a third has nowhere to sit.
set local request.jwt.claims to
  '{"sub":"eeeeeeee-0000-4000-8000-000000000003","role":"authenticated"}';

-- These two used to assert two DIFFERENT exceptions — P0001 for a full table and
-- P0002 for an unknown code. That is a stronger claim than it looks, and it was
-- the wrong one: it says a caller working through six-character codes can tell
-- "this code names a real, live table that happens to be full" from "this code
-- names nothing". That is the oracle the friend graph's shared "no such player"
-- wording exists to prevent, one feature over.
--
-- `join_private_room` now returns NO ROW for every reason a code does not admit
-- you — unknown, expired, blocked, full — so the assertions below are the same
-- test made stricter: not merely that each is refused, but that the two refusals
-- are INDISTINGUISHABLE.
--
-- Returning rather than raising is also what makes the per-minute join limit
-- real: a raise rolls the whole call back, including the record of the attempt,
-- so a guesser would never be charged for a guess. See 19_rate_limits.test.sql,
-- which asserts that ten failed guesses are counted.

select ok(
  (select public.join_private_room((select code from invite))) is null,
  'a full table admits nobody'
);

select ok(
  (select public.join_private_room('ZZZZZZ')) is null,
  'and an unknown code is refused the same way, so the two cannot be told apart'
);

-- --------------------------------------------------------------------------
-- Host migration
-- --------------------------------------------------------------------------
-- The host owns the invite and the lobby, never the dealer or the shoe, so
-- handing the role over cannot change how a hand plays out.

set local request.jwt.claims to
  '{"sub":"cccccccc-0000-4000-8000-000000000001","role":"authenticated"}';

select lives_ok(
  $$ select public.leave_room((select room_id from invite)) $$,
  'the host leaves'
);

-- Asserted as the GUEST. Once the host leaves, their membership is 'left' and
-- RLS stops showing them the room — correctly — so the departed host is the one
-- caller who cannot verify this.
set local request.jwt.claims to
  '{"sub":"dddddddd-0000-4000-8000-000000000002","role":"authenticated"}';

select is(
  (select host_user_id from public.rooms where id = (select room_id from invite)),
  'dddddddd-0000-4000-8000-000000000002'::uuid,
  'the longest-connected remaining player inherits the room'
);

-- ---------------------------------------------------------------------------
-- "Host can remove a member only while in lobby"
-- ---------------------------------------------------------------------------
-- `room_member_status` has carried a `kicked` label since this file's own
-- migration and nothing ever set it: there was no function to remove anybody,
-- so the specification's rule held only because the capability was absent.
--
-- The clause that matters is "only while in lobby". Once a hand is dealt the
-- seats hold chips and the server owns the game, so a host who could eject a
-- player mid-session could take their table stack — the same shape of defect as
-- a client that could move chips.

reset role;

insert into auth.users (id, email, aud, role) values
  ('0f000000-0000-4000-8000-00000000000d', 'kick-host@arc21.test', 'authenticated', 'authenticated'),
  ('0f000000-0000-4000-8000-00000000000e', 'kick-guest@arc21.test', 'authenticated', 'authenticated');

insert into public.rooms (id, code, host_user_id, visibility, mode, max_seats)
values ('0f000000-0000-4000-8000-0000000fffff', 'KICKME',
        '0f000000-0000-4000-8000-00000000000d', 'private', 'private_table', 5);
insert into public.room_members (room_id, user_id, seat_index) values
  ('0f000000-0000-4000-8000-0000000fffff', '0f000000-0000-4000-8000-00000000000d', 0),
  ('0f000000-0000-4000-8000-0000000fffff', '0f000000-0000-4000-8000-00000000000e', 1);

-- A member cannot remove anybody, including the host.
set local role authenticated;
set local request.jwt.claims to
  '{"sub":"0f000000-0000-4000-8000-00000000000e","role":"authenticated"}';

select is(
  public.remove_room_member('0f000000-0000-4000-8000-0000000fffff',
                            '0f000000-0000-4000-8000-00000000000d'),
  false,
  'a member cannot remove the host'
);

-- The host cannot remove themselves: that is `leave_room`, which migrates the
-- host role. Doing it here would leave the room hostless.
set local request.jwt.claims to
  '{"sub":"0f000000-0000-4000-8000-00000000000d","role":"authenticated"}';

select is(
  public.remove_room_member('0f000000-0000-4000-8000-0000000fffff',
                            '0f000000-0000-4000-8000-00000000000d'),
  false,
  'the host cannot remove themselves through this path'
);

select is(
  public.remove_room_member('0f000000-0000-4000-8000-0000000fffff',
                            '0f000000-0000-4000-8000-00000000000e'),
  true,
  'the host removes a member while the room is a lobby'
);

reset role;
select is(
  (select status::text from public.room_members
   where room_id = '0f000000-0000-4000-8000-0000000fffff'
     and user_id = '0f000000-0000-4000-8000-00000000000e'),
  'kicked',
  'and the seat is recorded as kicked, not merely left'
);

-- Once the room is playing, nobody can be removed. The seats hold chips.
insert into public.room_members (room_id, user_id, seat_index) values
  ('0f000000-0000-4000-8000-0000000fffff', '0f000000-0000-4000-8000-00000000000e', 1)
on conflict (room_id, user_id) do update set status = 'joined';
insert into public.game_sessions (id, mode, ruleset_id, tier, status, max_seats, started_at)
select '0f000000-0000-4000-8000-0000000eeeee', 'private_table', r.id, 'standard', 'active', 5, now()
from public.rulesets r where r.ruleset_key = 'arc-standard@1';
update public.rooms
set status = 'active', game_session_id = '0f000000-0000-4000-8000-0000000eeeee'
where id = '0f000000-0000-4000-8000-0000000fffff';

set local role authenticated;
set local request.jwt.claims to
  '{"sub":"0f000000-0000-4000-8000-00000000000d","role":"authenticated"}';

select is(
  public.remove_room_member('0f000000-0000-4000-8000-0000000fffff',
                            '0f000000-0000-4000-8000-00000000000e'),
  false,
  'once the table is playing the host cannot eject anybody'
);

reset role;
select is(
  (select status::text from public.room_members
   where room_id = '0f000000-0000-4000-8000-0000000fffff'
     and user_id = '0f000000-0000-4000-8000-00000000000e'),
  'joined',
  'and their seat, with its chips, is untouched'
);

-- --------------------------------------------------------------------------
-- A room's life ends with its game
-- --------------------------------------------------------------------------
--
-- `leave_room` was the ONLY thing in the schema that had ever written
-- `status = 'closed'`, and it is reachable from the lobby only: once the host
-- deals, every client is at `/table/[gameId]` and leaves by CASH_OUT, which
-- settles the seat and ends the session without touching the room. So a
-- played-out room sat at `active` for ever, holding its six-character code,
-- and `create_private_room` answered its host "you already have a table open"
-- permanently. `expire_stale_rooms()` could not help: it only looked at
-- `status = 'lobby'`.
--
-- The three assertions below are the whole rule. A finished table's room is
-- retired; a room whose session is STILL RUNNING is not, however long ago
-- anybody looked at it; and a room whose seats have not all settled is not
-- either, because retiring one out from under unreconciled escrow is chips
-- nobody can reach.

-- The room above is `active` with a live session. Nothing should touch it.
select is(
  (select status::text from public.rooms
   where id = '0f000000-0000-4000-8000-0000000fffff'),
  'active',
  'a room whose session is still running is left alone by the sweep'
);

select lives_ok(
  $$ select public.expire_stale_rooms() $$,
  'the sweep runs against a live table without raising'
);

select is(
  (select status::text from public.rooms
   where id = '0f000000-0000-4000-8000-0000000fffff'),
  'active',
  'and it is STILL active afterwards — a running game keeps its room'
);

-- Now end the session, but leave one seat unsettled. Escrow, in the general
-- case, is exactly what must stop a room being retired.
insert into public.game_session_seats
  (game_session_id, seat_index, user_id, display_name, stack, buy_in, status)
values
  ('0f000000-0000-4000-8000-0000000eeeee', 0,
   '0f000000-0000-4000-8000-00000000000d', 'Kick host', 5000, 0, 'active');

update public.game_sessions
set status = 'completed', ended_at = now()
where id = '0f000000-0000-4000-8000-0000000eeeee';

select is(
  (select public.expire_stale_rooms()),
  0,
  'a completed session with a seat still held retires nothing'
);

select is(
  (select status::text from public.rooms
   where id = '0f000000-0000-4000-8000-0000000fffff'),
  'active',
  'and the room stays open while a seat is unsettled'
);

-- Settle it, exactly as `settleTableClosure` does.
update public.game_session_seats
set status = 'left', left_at = now(), stack = 0
where game_session_id = '0f000000-0000-4000-8000-0000000eeeee';

select is(
  (select public.expire_stale_rooms()),
  1,
  'a finished table with every seat settled retires exactly one room'
);

select is(
  (select status::text from public.rooms
   where id = '0f000000-0000-4000-8000-0000000fffff'),
  'closed',
  'and the room is closed, so its code returns to the pool'
);

-- --------------------------------------------------------------------------
-- A PUBLIC TABLE'S SEATS BELONG TO THE QUEUE
-- --------------------------------------------------------------------------
-- Two ways into a public room that went around `poll_matchmaking` entirely.
-- Neither is an economic hole — every buy-in guard is downstream of both — but
-- both decide WHO SITS WITH WHOM at the tables the specification calls matched
-- play, and that decision belongs to the queue.

reset role;

insert into auth.users (id, email, aud, role) values
  ('20000000-0000-4000-8000-000000000001', 'pubroom-host@arc21.test', 'authenticated', 'authenticated'),
  ('20000000-0000-4000-8000-000000000002', 'pubroom-friend@arc21.test', 'authenticated', 'authenticated'),
  ('20000000-0000-4000-8000-000000000003', 'pubroom-matched@arc21.test', 'authenticated', 'authenticated');

-- A public room exactly as `poll_matchmaking` opens one: the "host" is whoever
-- the allocator happened to seat first.
insert into public.rooms (id, code, host_user_id, visibility, mode, max_seats, tier, status)
values ('20000000-0000-4000-8000-00000000aaa1', 'PUBQUE',
        '20000000-0000-4000-8000-000000000001', 'public', 'public_table', 5, 'casual', 'lobby');
insert into public.room_members (room_id, user_id, seat_index) values
  ('20000000-0000-4000-8000-00000000aaa1', '20000000-0000-4000-8000-000000000001', 0),
  ('20000000-0000-4000-8000-00000000aaa1', '20000000-0000-4000-8000-000000000003', 1);

-- THE CODE. `poll_matchmaking` hands a matched player the room's six characters
-- along with its id, and `join_private_room` had never looked at `visibility` —
-- so passing that code to a friend seated the two of them together at a public
-- table, ahead of whoever the queue would have matched.
set local role authenticated;
set local request.jwt.claims to
  '{"sub":"20000000-0000-4000-8000-000000000002","role":"authenticated"}';

select is(
  (select id from public.join_private_room('PUBQUE')),
  null,
  'a public table''s room code does not admit anybody: the queue decides'
);

reset role;
select is(
  (select count(*)::int from public.room_members
   where room_id = '20000000-0000-4000-8000-00000000aaa1'
     and user_id = '20000000-0000-4000-8000-000000000002'),
  0,
  'and no membership was created by the attempt'
);

-- THE HOST. `rooms.host_user_id` at a public table is an accident of arrival
-- order — "the host owns nothing but the lobby" — and `remove_room_member`
-- never asked, so that accidental host could kick the strangers the allocator
-- had just placed beside them, one at a time, before anybody bought in.
set local role authenticated;
set local request.jwt.claims to
  '{"sub":"20000000-0000-4000-8000-000000000001","role":"authenticated"}';

select is(
  (select public.remove_room_member('20000000-0000-4000-8000-00000000aaa1',
                                    '20000000-0000-4000-8000-000000000003')),
  false,
  'nobody hosts a public table, so nobody may be removed from one'
);

reset role;
select is(
  (select status::text from public.room_members
   where room_id = '20000000-0000-4000-8000-00000000aaa1'
     and user_id = '20000000-0000-4000-8000-000000000003'),
  'joined',
  'and the player the queue matched keeps their seat'
);

select * from finish();
rollback;

