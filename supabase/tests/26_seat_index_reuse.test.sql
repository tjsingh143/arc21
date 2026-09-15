-- =============================================================================
-- Arc 21 — a seat index freed by a departure is reusable
--
-- THE DEFECT THIS PINS. `JOIN_PUBLIC_TABLE` allocated a seat index as
-- `max(seat_index) + 1` over every row the session had ever held, and the old
-- `game_session_seats_unique_index` reserved an index for a seat that had left.
-- `seat_index` is `check (seat_index between 0 and 6)`, so the EIGHTH person
-- ever to sit at a public table was handed index 7 and the insert was refused
-- by the check — reaching the player as HTTP 500 rather than as a refusal.
--
-- It is not the full-table case, which answers TABLE_FULL correctly. The shape
-- that matters is a table with seats FREE: two live seats, five departed, three
-- seats advertised and nobody able to take one. A public table stays `active`
-- while anybody is at it and keeps being allocated by matchmaking, so from the
-- eighth arrival onwards it answered 500 to everybody, permanently.
--
-- Two claims, and the file needs both: a departed seat must NOT reserve its
-- index, and two LIVE seats must still never share one. A test that only made
-- the first would pass against a table with no uniqueness at all.
--
-- Fixtures are scoped to ids this file owns and rolled back, per the lesson
-- `05_daily_challenge.test.sql` cost: a pgTAP file that counts global rows
-- fails as soon as the feature ships.
-- =============================================================================

begin;

create extension if not exists pgtap with schema extensions;
set search_path to public, extensions, pg_catalog;

select plan(7);

-- ---------------------------------------------------------------------------
-- The constraint is the PARTIAL one, and the total one is gone
-- ---------------------------------------------------------------------------

select hasnt_index(
  'public', 'game_session_seats', 'game_session_seats_unique_index',
  'the index that reserved a departed seat''s slot is gone'
);

select has_index(
  'public', 'game_session_seats', 'game_session_seats_live_index',
  'and a partial unique index has taken its place'
);

select is(
  (select pg_get_expr(i.indpred, i.indrelid)
   from pg_index i
   join pg_class c on c.oid = i.indexrelid
   where c.relname = 'game_session_seats_live_index'),
  '(status <> ''left''::seat_status)',
  'scoped to seats that have not left'
);

-- ---------------------------------------------------------------------------
-- A table this file owns: seven players through it, five of them gone
-- ---------------------------------------------------------------------------

insert into public.game_sessions (id, mode, status, max_seats, tier, ruleset_id)
values (
  '2c0ffee0-0000-4000-8000-00000000feed', 'public_table', 'active', 5, 'casual',
  (select id from public.rulesets limit 1)
);

insert into public.game_session_seats (game_session_id, seat_index, display_name, status)
select '2c0ffee0-0000-4000-8000-00000000feed', i, 'seat ' || i,
       case when i < 5 then 'left'::public.seat_status else 'active'::public.seat_status end
from generate_series(0, 6) as i;

select is(
  (select count(*)::int from public.game_session_seats
   where game_session_id = '2c0ffee0-0000-4000-8000-00000000feed' and status <> 'left'),
  2,
  'two live seats, so three of the five are free'
);

-- ---------------------------------------------------------------------------
-- The allocator `create-session` uses, run here as the function writes it
-- ---------------------------------------------------------------------------

select is(
  (select min(candidate.seat_index)::int
   from generate_series(0, 4) as candidate(seat_index)
   where not exists (
     select 1 from public.game_session_seats held
     where held.game_session_id = '2c0ffee0-0000-4000-8000-00000000feed'
       and held.seat_index = candidate.seat_index
       and held.status <> 'left')),
  0,
  'the eighth arrival is given seat 0, freed by the first player to leave'
);

insert into public.game_session_seats (game_session_id, seat_index, display_name, status)
values ('2c0ffee0-0000-4000-8000-00000000feed', 0, 'the eighth player', 'active');

select is(
  (select count(*)::int from public.game_session_seats
   where game_session_id = '2c0ffee0-0000-4000-8000-00000000feed' and seat_index = 0),
  2,
  'and the departed player''s row is still there, because it is history'
);

-- ---------------------------------------------------------------------------
-- THE BREACH. Two LIVE seats on one index is still refused — without this the
-- test above would pass against a table with no uniqueness at all.
-- ---------------------------------------------------------------------------

-- No savepoint around this one. `CLAUDE.md` records that a breach test must
-- issue its savepoint OUTSIDE `throws_ok`, which is true when the breach must
-- really be applied — and here it must not: `throws_ok` runs the statement in
-- its own subtransaction and the refusal undoes it. A `rollback to savepoint`
-- after it also rolls back pgTAP's record OF the assertion, which is how this
-- file first reported "planned 7 tests but ran 6" with seven visible `ok` lines.

select throws_ok(
  $$insert into public.game_session_seats
      (game_session_id, seat_index, display_name, status)
    values ('2c0ffee0-0000-4000-8000-00000000feed', 0, 'a second live seat', 'active')$$,
  '23505',
  null,
  'two live seats may still never share an index'
);

select * from finish();
rollback;
