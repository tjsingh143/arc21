-- =============================================================================
-- Arc 21 — a way OUT of the sprint queue, and a result a player can read
--
-- Two holes, both measured against the running stack before this migration was
-- written, and both the same shape: a state the product can reach and provides
-- no answer for.
--
--   1. A PAID ENTRY THAT NEVER BECOMES A TOURNAMENT. Registration debits 500
--      chips and holds the player in the oldest sprint still short of players.
--      `registerSprint` returns that same entry to anybody already in a
--      `registering` or `running` tournament, so a player whose three
--      companions never arrived was locked to it permanently: the fee spent,
--      the screen reading "Waiting for 3 more players", and every other online
--      mode refusing them for as long as it lasted. The specification's own
--      error handling asks for the missing half — "if a committed tournament is
--      cancelled server-side, refund through ledger" — and a cancellation with
--      no trigger is not a behaviour. `tournament_refund` is that ledger reason.
--
--   2. A RESULT THAT VANISHES THE INSTANT IT EXISTS. `my_sprint_entry` filtered
--      on `t.status in ('registering', 'running')`, and finalisation sets the
--      status to `completed` in the same transaction as the last hand. So the
--      moment a tournament ended, the one lookup the client has for finding its
--      tournament stopped naming it — and the Sprint screen fell back to
--      offering a fresh entry with no placement, no prize and no standings
--      anywhere on it. The specification asks for a result page with placement,
--      final bankroll, prize and XP; it was unreachable.
--
-- Neither half moves a chip here. Every economic step still goes through
-- `apply_wallet_delta` from the session Edge Function, which locks the wallet
-- before honouring its idempotency key.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- The refund reason
-- ---------------------------------------------------------------------------
--
-- Deliberately its own label rather than a `tournament_entry` with the sign
-- flipped. A player reads their own ledger, and "Tournament entry +500" is a
-- sentence that has to be decoded; "Tournament refund +500" is not. It is also
-- what makes the refund's idempotency key legible next to the debit's:
-- `sprint_entry:<t>:<u>` took the chips and `sprint_refund:<t>:<u>` gives them
-- back, each at most once, whatever either side is asked to do.
--
-- `alter type … add value` is irreversible — Postgres has no `drop value` — and
-- `22_migration_recovery.test.sql` says so, along with why an unused label costs
-- nothing. Nothing in THIS migration writes the label: a value added inside a
-- transaction cannot be used by the same transaction.
alter type public.ledger_reason add value if not exists 'tournament_refund';

-- ---------------------------------------------------------------------------
-- The player's tournament, including the one that has just finished
-- ---------------------------------------------------------------------------
--
-- COPIED FROM `20260817200000_daily_challenge_and_sprint.sql`, which is the LAST
-- migration to define this function — checked with
-- `grep -l 'create or replace function public.my_sprint_entry' supabase/migrations/*.sql`
-- before a line of it was written, because `create or replace` replaces the
-- whole body and starting from an earlier definition silently reverts every
-- later change to it. That mistake has cost this project two debugging rounds
-- and one behaviour that failed nothing at all.
--
-- WHY A COMPLETED TOURNAMENT IS BOUNDED BY TIME rather than returned for ever.
-- The row has to survive long enough for the player to walk from the table back
-- to the Sprint screen and read what they won; it must not still be presented as
-- their current tournament a week later. A day is generous for the first and
-- unambiguous about the second, and it does not block a re-entry either way:
-- `registerSprint` looks only at `registering` and `running`, so a completed
-- entry is not a live one and the rematch button works while the result is on
-- screen.
--
-- The `left join` on `game_sessions` is unchanged, so a completed tournament
-- still carries its game id. The client must NOT offer to open that table: the
-- session is `completed` and every command against it is refused SESSION_CLOSED.
-- The standings are the result surface, and `sprint_standings` already serves a
-- completed tournament to anybody who was in it.
create or replace function public.my_sprint_entry()
returns table (
  tournament_id        uuid,
  entry_id             uuid,
  tournament_status    public.tournament_status,
  entry_status         public.tournament_entry_status,
  game_session_id      uuid,
  -- The player's SEAT at the tournament table, which is not the same thing as
  -- their entry. The table screen resolves the player's own hand and controls by
  -- seat id; handed an entry id it finds no seat and renders no buttons at all.
  game_session_seat_id uuid,
  entries_filled       integer,
  seats_required       integer,
  chips                bigint,
  placement            integer,
  tie_break_boundary   integer,
  tie_break_hands_used integer
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select
    t.id, e.id, t.status, e.status, g.id,
    (select seat.id from public.game_session_seats seat
     where seat.game_session_id = g.id and seat.user_id = e.user_id
     limit 1),
    -- A withdrawn entry is not somebody waiting, so it must not be counted
    -- towards the field. Before the withdrawal path existed every entry was a
    -- waiting player and `count(*)` was the same question.
    (select count(*)::int from public.tournament_entries x
     where x.tournament_id = t.id and x.status <> 'withdrawn'),
    t.max_entries,
    e.chips, e.placement, t.tie_break_boundary, t.tie_break_hands_used
  from public.tournament_entries e
  join public.tournaments t on t.id = e.tournament_id
  left join public.game_sessions g on g.tournament_id = t.id
  where e.user_id = (select auth.uid())
    and e.status <> 'withdrawn'
    and (
      t.status in ('registering', 'running')
      or (t.status = 'completed' and t.ends_at > now() - interval '1 day')
    )
  order by e.registered_at desc
  limit 1;
$$;

comment on function public.my_sprint_entry() is
  'The caller''s live sprint, or the one that finished within the last day so the '
  'result page has something to render. Never another player''s.';

-- A `create or replace` leaves the existing ACL alone, but stating the pair is
-- the rule this project follows without exception: a new function's default is
-- EXECUTE TO PUBLIC, and a migration that assumed otherwise is how `anon` came
-- to hold seventeen public functions.
revoke execute on function public.my_sprint_entry() from public, anon;
grant  execute on function public.my_sprint_entry() to authenticated;

-- ---------------------------------------------------------------------------
-- Standings must survive a withdrawal too
-- ---------------------------------------------------------------------------
--
-- Same copy-from-the-last-definition rule. `sprint_standings` is defined only in
-- `20260817200000`, and the single change is the `withdrawn` filter: a player
-- who took their fee back and left is not a competitor, and rendering them in
-- the standings with a zero stack would read as somebody who had gone broke.
create or replace function public.sprint_standings(p_tournament_id uuid)
returns table (
  entry_id              uuid,
  display_name          text,
  chips                 bigint,
  status                public.tournament_entry_status,
  placement             integer,
  eliminated_after_hand integer,
  in_tie_break          boolean,
  prize_chips           bigint,
  prize_xp              integer,
  is_you                boolean
)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_me uuid := auth.uid();
begin
  if v_me is null then
    raise exception 'this requires an authenticated session' using errcode = '42501';
  end if;

  if not exists (
    select 1 from public.tournament_entries e
    where e.tournament_id = p_tournament_id and e.user_id = v_me
  ) then
    raise exception 'you are not in that tournament' using errcode = '42501';
  end if;

  return query
    select e.id, p.display_name::text, e.chips, e.status, e.placement,
           e.eliminated_after_hand, e.in_tie_break, e.prize_chips, e.prize_xp,
           e.user_id = v_me
    from public.tournament_entries e
    join public.profiles p on p.id = e.user_id
    where e.tournament_id = p_tournament_id
      and e.status <> 'withdrawn'
    order by
      -- Survivors above the eliminated, then by stack. The same ordering the
      -- format module uses for placement, so the live table and the final result
      -- do not disagree about who is ahead.
      (e.eliminated_after_hand is not null),
      e.eliminated_after_hand desc nulls first,
      e.chips desc,
      e.id;
end;
$$;

revoke execute on function public.sprint_standings(uuid) from public, anon;
grant  execute on function public.sprint_standings(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- A withdrawn entry is not a tournament anybody played
-- ---------------------------------------------------------------------------
--
-- `my_competition_record` and `player_public_profile` already exclude
-- `withdrawn` from entries and wins — written before anything could produce one,
-- which is exactly why it is worth checking rather than assuming. Both were
-- read and both are correct; nothing to change, recorded here so the next
-- reader does not have to look.

-- The grant surface is unchanged in shape by this migration, but the gate is
-- cheap and a migration that touches EXECUTE says so.
select public.assert_client_authorization_surface();
