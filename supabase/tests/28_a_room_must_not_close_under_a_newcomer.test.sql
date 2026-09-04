-- =============================================================================
-- Arc 21 — a public room must not close while somebody is being seated into it
--
-- THE DEFECT THIS PINS, found by CI on a documentation-only commit and then
-- reproduced deterministically with two transactions:
--
--     T1  begin; select release_room_seat(R, <the last member>);   -- not committed
--     T2  join_matchmaking('casual'); poll_matchmaking();          -- matched -> R
--     T1  commit;                                                  -- R is now closed
--
--     room status = closed
--     joined members = 1
--     newcomer membership = joined
--     newcomer queue entry = matched -> R
--
-- `poll_matchmaking` serialised allocation on a per-tier advisory lock and took
-- no lock on the room it handed out; `release_room_seat` takes the room row
-- `for update` and closes the room when it counts no `joined` member. Neither
-- excluded the other. The player was then matched into a CLOSED room, and
-- `joinPublicTable` refuses one SESSION_CLOSED before it looks at who is asking
-- — so every buy-in failed, and `join_matchmaking` handed the same entry back
-- each time. CI saw it as `six matched public rooms and none could be sat at:
-- 409 … SESSION_CLOSED`.
--
-- WHY THE ROOT CAUSE IS ASSERTED ON THE SOURCE AND NOT ON BEHAVIOUR. The race
-- needs two concurrent transactions and pgTAP runs in one session, so the
-- behavioural proof cannot live here; it is the interleaving above, recorded in
-- `docs/phase-reports/phase-11-verification.md`. What this file can do is refuse
-- a `poll_matchmaking` that has stopped taking the room's row lock — the same
-- move `19_rate_limits.test.sql` makes when it pattern-matches function bodies
-- for a window nobody should be carrying.
--
-- The RECOVERY half is behavioural and is asserted properly, in both
-- directions: a matched entry whose room has closed is spent, and one whose
-- room is open is still a reconnect.
--
-- Fixtures are scoped to ids this file owns and roll back with the transaction.
-- =============================================================================

begin;

create extension if not exists pgtap with schema extensions;
set search_path to public, extensions, pg_catalog;

select plan(6);

-- ---------------------------------------------------------------------------
-- The root cause: the candidate is confirmed under its own row lock
-- ---------------------------------------------------------------------------

select matches(
  (select prosrc from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'poll_matchmaking'),
  'from public\.rooms where id = v_candidate for update',
  'poll_matchmaking takes the candidate room''s row lock before seating anybody'
);

select matches(
  (select prosrc from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'poll_matchmaking'),
  'pg_advisory_xact_lock',
  'and still serialises allocation per tier, which the row lock does not replace'
);

-- ---------------------------------------------------------------------------
-- The recovery: a reservation at a CLOSED room is spent, not a reconnect
-- ---------------------------------------------------------------------------

insert into auth.users (id, email, aud, role) values
  ('3d000000-0000-4000-8000-00000000aaa1', 'closed-room@arc21.test', 'authenticated', 'authenticated'),
  ('3d000000-0000-4000-8000-00000000bbb2', 'open-room@arc21.test',   'authenticated', 'authenticated');

-- A closed room this file owns, with the membership still standing — which is
-- exactly what the race left behind, and what no path can produce any more.
insert into public.rooms (id, code, host_user_id, visibility, mode, max_seats, tier, status)
values ('3d000000-0000-4000-8000-00000000fff1', 'ZQ1AA1',
        '3d000000-0000-4000-8000-00000000aaa1', 'public', 'public_table', 5, 'casual', 'closed');

insert into public.room_members (room_id, user_id, seat_index, status)
values ('3d000000-0000-4000-8000-00000000fff1', '3d000000-0000-4000-8000-00000000aaa1', 0, 'joined');

insert into public.matchmaking_queue (user_id, tier, status, room_id, matched_at)
values ('3d000000-0000-4000-8000-00000000aaa1', 'casual', 'matched',
        '3d000000-0000-4000-8000-00000000fff1', now());

set local role authenticated;
set local request.jwt.claims to
  '{"sub":"3d000000-0000-4000-8000-00000000aaa1","role":"authenticated"}';

create temporary table closed_answer as
select status, room_id from public.join_matchmaking('casual');

select is(
  (select status::text from closed_answer),
  'waiting',
  'a matched entry naming a CLOSED room is replaced by a fresh enrolment'
);

select is(
  (select room_id from closed_answer),
  null,
  'and the fresh entry names no room, so nothing hands back the refusal again'
);

-- ---------------------------------------------------------------------------
-- And the reconnect it must not break. A player matched but not yet bought in
-- holds a `joined` membership at an OPEN room; giving them a second table is
-- the defect `20260823100000_one_live_seat.sql` exists to stop.
-- ---------------------------------------------------------------------------

reset role;

insert into public.rooms (id, code, host_user_id, visibility, mode, max_seats, tier, status)
values ('3d000000-0000-4000-8000-00000000fff2', 'ZQ2BB2',
        '3d000000-0000-4000-8000-00000000bbb2', 'public', 'public_table', 5, 'casual', 'active');

insert into public.room_members (room_id, user_id, seat_index, status)
values ('3d000000-0000-4000-8000-00000000fff2', '3d000000-0000-4000-8000-00000000bbb2', 0, 'joined');

insert into public.matchmaking_queue (user_id, tier, status, room_id, matched_at)
values ('3d000000-0000-4000-8000-00000000bbb2', 'casual', 'matched',
        '3d000000-0000-4000-8000-00000000fff2', now());

set local role authenticated;
set local request.jwt.claims to
  '{"sub":"3d000000-0000-4000-8000-00000000bbb2","role":"authenticated"}';

create temporary table open_answer as
select status, room_id from public.join_matchmaking('casual');

select is(
  (select status::text from open_answer),
  'matched',
  'a matched entry naming an OPEN room is still a reconnect'
);

select is(
  (select room_id from open_answer),
  '3d000000-0000-4000-8000-00000000fff2'::uuid,
  'and is given back the room they already hold'
);

select * from finish();
rollback;
