-- =============================================================================
-- Arc 21 — AI Tables (Astra Refresh C)
-- =============================================================================
--
-- A new session mode, `ai_table`: one person and computer-controlled seats at a
-- single server-authoritative table, unranked, in a closed economy. The engine,
-- the shoe, the dealer, legality and settlement are exactly the ones every other
-- table uses; this migration adds only what the database must know to tell a
-- computer player from a person, and to keep one where it belongs.
--
-- WHY A COLUMN AND NOT A CONVENTION. `game_session_seats.user_id` is already
-- null for "an unoccupied or non-account seat", and it is set to null when an
-- account is deleted (`on delete set null`, so a game other people played is
-- not deleted under them). A null user id therefore cannot mean "computer
-- player" without also meaning two other things. Nor can a display name — names
-- are free text that people choose. `is_ai` is the only thing that says it.
--
-- WHAT THE DATABASE NOW REFUSES, whatever the server's code does:
--
--   * an AI seat that belongs to an account          (CHECK)
--   * an AI seat with a buy-in                       (CHECK)
--   * an AI seat at any table that is not an AI table (trigger)
--   * a second PERSON at an AI table                  (trigger)
--
-- The third is the specification's own line, enforced rather than described:
-- "Ranked public multiplayer and ranked tournaments must not silently substitute
-- bots", "No hidden bots presented as humans", "Never silently insert AI into a
-- ranked public game". A computer player cannot be stored at a public, private,
-- tournament, daily, career or Quick Play table by any route.
--
-- THE ECONOMY IS NOT IN THIS FILE, because there is nothing to add: an AI table
-- writes no ledger row and holds no escrow. Every seat's stack is created at the
-- table and destroyed with it; `session-economics.ts` keeps `ai_table` out of
-- `WALLET_BACKED_MODES`, so `settleTableClosure` returns nothing to any wallet.
--
-- No existing row is rewritten. `is_ai` defaults to false, which is true of every
-- seat that exists today. No client grant changes: `game_session_seats` stays
-- server-written, readable by the seat's own table only.
-- =============================================================================

-- ONE TRANSACTION, deliberately — no `commit; begin;` split.
--
-- Since PostgreSQL 12 `add value` may run inside a transaction; the new label
-- just cannot be USED until that transaction commits. Nothing below uses it:
-- `'ai_table'` appears only inside the PL/pgSQL body of
-- `guard_ai_seat_placement`, which is parsed when the trigger first fires, long
-- after this commits.
--
-- The split is not merely unnecessary here, it is unsafe. The Supabase CLI sends
-- a migration file as ONE batch whose final Sync commits only an IMPLICIT
-- transaction. A `commit;` inside the file commits what came before it, and a
-- `begin;` opens an EXPLICIT block that the Sync leaves open — so when the CLI
-- closes the connection, everything after the `begin;` is rolled back,
-- including the migration-history row, while the CLI reports success. Measured
-- on this file's first draft with `supabase migration up --local`: the label
-- was committed and the column, both constraints, the trigger and the history
-- row were not. A deploy of a lone pending file goes through that same path.
alter type public.game_mode add value if not exists 'ai_table';

-- -----------------------------------------------------------------------------
-- The explicit marker
-- -----------------------------------------------------------------------------

alter table public.game_session_seats
  add column is_ai boolean not null default false;

comment on column public.game_session_seats.is_ai is
  'True for a computer-controlled participant at an AI table, false for every '
  'person. The only way to tell the two apart: user_id is also null for a deleted '
  'account, and display_name is free text.';

comment on column public.game_session_seats.user_id is
  'The person in this seat. Null for a computer player (is_ai), for a seat whose '
  'account was deleted, or for an unoccupied seat.';

-- A computer player is never an account. If it could carry one, every per-account
-- path — statistics, XP, a cash-out, `my_active_session()` — would treat it as a
-- person.
alter table public.game_session_seats
  add constraint game_session_seats_ai_seat_has_no_account
  check (not is_ai or user_id is null);

-- And it never buys in: it has no wallet to buy in from.
alter table public.game_session_seats
  add constraint game_session_seats_ai_seat_has_no_buy_in
  check (not is_ai or buy_in = 0);

-- -----------------------------------------------------------------------------
-- Where a computer player may sit
-- -----------------------------------------------------------------------------

create or replace function public.guard_ai_seat_placement()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_mode public.game_mode;
begin
  select g.mode into v_mode
  from public.game_sessions g
  where g.id = new.game_session_id;

  -- Only an AI table seats a computer player. `is distinct from` so that a seat
  -- naming no session at all is refused too, rather than slipping past a null.
  if new.is_ai and v_mode is distinct from 'ai_table' then
    raise exception 'an AI seat may only be placed at an AI table (session %, mode %)',
      new.game_session_id, v_mode
      using errcode = '23514';
  end if;

  -- And an AI table seats exactly one person. A second account at one would be a
  -- person sharing a table with computer players they did not choose, in an
  -- economy built for one; and the table's own lifecycle — it ends when its
  -- person leaves — assumes there is only one.
  if not new.is_ai and v_mode = 'ai_table' and exists (
    select 1 from public.game_session_seats s
    where s.game_session_id = new.game_session_id
      and not s.is_ai
      and s.id <> new.id
  ) then
    raise exception 'an AI table seats exactly one person (session %)', new.game_session_id
      using errcode = '23514';
  end if;

  return new;
end;
$$;

comment on function public.guard_ai_seat_placement() is
  'Refuses a computer-player seat anywhere but an AI table, and a second person at one.';

-- Server-only, like every other guard. A trigger function needs no EXECUTE grant
-- to fire, and a default ACL would be EXECUTE TO PUBLIC, which the gate below
-- refuses.
revoke execute on function public.guard_ai_seat_placement() from public, anon, authenticated;

-- Fires on the columns that decide placement and no others, so the stack and
-- status updates every command makes do not pay for it. Named to sort after
-- `game_session_seats_deny_client_write`, so a client write is refused by the
-- older guard first.
create trigger game_session_seats_guard_ai_placement
  before insert or update of is_ai, game_session_id on public.game_session_seats
  for each row execute function public.guard_ai_seat_placement();

-- The grant surface is unchanged, but a migration that adds a function says so
-- by asking the gate, as its last statement.
select public.assert_client_authorization_surface();
