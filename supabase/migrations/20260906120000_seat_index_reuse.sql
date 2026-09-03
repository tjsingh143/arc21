-- A seat index freed by a departure must be reusable, or a busy public table
-- becomes unjoinable while advertising free seats.
--
-- THE DEFECT. `JOIN_PUBLIC_TABLE` allocated with
-- `coalesce(max(seat_index) + 1, 0)` over EVERY row of the session, and
-- `game_session_seats_unique_index` reserved an index for a seat that had long
-- since left. `seat_index` is `check (seat_index between 0 and 6)`, so the
-- EIGHTH person ever to sit at a public table was handed index 7 and the insert
-- was refused by the check — which the Edge Function surfaces as HTTP 500
-- INTERNAL, not as a refusal a player can do anything about.
--
-- This is NOT the full-table case; that one is handled correctly and answers
-- TABLE_FULL. Measured with two live seats and five departed ones, so the
-- occupancy guard saw three seats free and the insert failed anyway:
--
--     live_seats | rows_ever | highest
--              2 |         7 |       6
--     ERROR: new row for relation "game_session_seats" violates check
--            constraint "game_session_seats_seat_index_check"
--
-- A public table stays `active` while anybody is sitting at it and keeps being
-- allocated by matchmaking, so from the eighth arrival onwards it offers seats
-- to everybody and answers 500 to all of them, for as long as it lives.
--
-- The uniqueness that matters is over LIVE seats: two people must never hold one
-- index at the same time, and a departed seat's row is history rather than an
-- occupant — it is deliberately kept, because `display_name` is a copy taken
-- when the seat opened and a game other people played is not deleted under them.
-- So the constraint becomes a PARTIAL unique index and the allocator picks the
-- lowest index no LIVE seat holds. `create-session` makes the matching change;
-- the two are asserted together in `26_seat_index_reuse.test.sql`.

alter table public.game_session_seats
  drop constraint if exists game_session_seats_unique_index;

create unique index if not exists game_session_seats_live_index
  on public.game_session_seats (game_session_id, seat_index)
  where status <> 'left';

comment on index public.game_session_seats_live_index is
  'One LIVE seat per index. A departed seat keeps its row as history and frees its slot, so a table that has had more than seven players through it is still joinable.';
