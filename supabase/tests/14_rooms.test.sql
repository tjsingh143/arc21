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

select plan(19);

select has_table('public', 'rooms', 'rooms exist');
select has_table('public', 'room_members', 'seats at a room exist');

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

select * from finish();
rollback;
