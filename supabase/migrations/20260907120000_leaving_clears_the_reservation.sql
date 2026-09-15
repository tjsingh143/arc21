-- =============================================================================
-- Arc 21 — leaving a public table must not leave a reservation behind
--
-- THE DEFECT, measured against the running stack. A player cashes out of a
-- public table and taps Play again. `release_room_seat` had set their
-- `room_members` row to `left` and left `matchmaking_queue` reading `matched`,
-- pointing at the room they had just left — and `join_matchmaking` returns a
-- live entry rather than enrolling afresh, deliberately, because "a matched
-- player who re-queues is reconnecting to the room they were already given".
--
-- So the client was shown "Seat found" for a table it was no longer a member
-- of, and `JOIN_PUBLIC_TABLE` answered
--
--     HTTP 403 NOT_A_PARTICIPANT  "You do not hold a seat at this table."
--
-- which `matchmaking-store.ts` renders while LEAVING the "Take the seat"
-- control on screen — so every further tap was refused the same way. It clears
-- itself after two minutes, when `expire_stale_queue_entries` retires an
-- unfunded reservation; until then the player cannot get a public seat at all.
--
-- Found while reverifying phase 11's seat-index work: `26_seat_index_reuse` and
-- the churn it pins are about the seat a departure FREES, and this is the
-- reservation the same departure leaves behind.
--
-- BOTH ENDS, because they answer different questions. `release_room_seat` is
-- where the reservation is spent, so that is where it is closed; and
-- `join_matchmaking` will not hand back a `matched` entry whose membership has
-- gone, whatever emptied it. The second is what makes the guarantee hold for a
-- room emptied by some path nobody has written yet.
--
-- Bodies are taken from the LAST migration to define each function --
-- 20260830130000 for `release_room_seat`, 20260901120000 for
-- `join_matchmaking` -- per the `create or replace` rule in CLAUDE.md.
-- =============================================================================

create or replace function public.release_room_seat(p_room_id uuid, p_user_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_room      public.rooms;
  v_next      uuid;
  v_remaining int;
begin
  if p_user_id is null then
    raise exception 'releasing a seat needs an account' using errcode = '42501';
  end if;

  select * into v_room from public.rooms where id = p_room_id for update;
  if not found then return; end if;

  update public.room_members
  set status = 'left', is_ready = false
  where room_id = p_room_id and user_id = p_user_id and status = 'joined';

  /*
   * THE ALLOCATION THAT PRODUCED THIS SEAT IS FINISHED WITH.
   *
   * `matchmaking_queue` still says `matched` at this point, and
   * `join_matchmaking` returns a live entry rather than enrolling again — so
   * without this line a player who left a public table and searched again
   * inside two minutes was handed back the room they had just left, shown
   * "Seat found", and refused the buy-in. Two minutes because that is how long
   * `expire_stale_queue_entries` waits before retiring an unfunded
   * reservation, which is the only thing that was clearing this.
   *
   * Harmless where matchmaking is not involved: a private room's members hold
   * no queue entry naming it, so the update touches nothing.
   */
  update public.matchmaking_queue
  set status = 'cancelled'
  where user_id = p_user_id and room_id = p_room_id and status in ('waiting', 'matched');

  select count(*) into v_remaining
  from public.room_members
  where room_id = p_room_id and status = 'joined';

  if v_remaining = 0 then
    update public.rooms set status = 'closed' where id = p_room_id;
    return;
  end if;

  -- Host migration. The host owns the invite and the lobby, never the dealer or
  -- the shoe — those are the server's — so handing the role over cannot change
  -- how a hand plays out, and NOTHING here touches the game session.
  -- Longest-connected member takes it.
  if v_room.host_user_id = p_user_id then
    select user_id into v_next
    from public.room_members
    where room_id = p_room_id and status = 'joined'
    order by joined_at
    limit 1;

    update public.rooms set host_user_id = v_next where id = p_room_id;
  end if;
end;
$$;

create or replace function public.join_matchmaking(p_tier public.table_tier)
returns public.matchmaking_queue
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_me    uuid := auth.uid();
  v_entry public.matchmaking_queue;
  v_level int;
  v_seat  uuid;
begin
  if v_me is null then
    raise exception 'matchmaking requires an authenticated session' using errcode = '42501';
  end if;

  perform public.expire_stale_queue_entries();

  -- One live seat per player. Checked here AND beside the buy-in; this one
  -- stops a client queueing for a seat it would then be refused, and the one in
  -- `create-session` is what actually protects the wallet.
  select s.game_session_id into v_seat
  from public.game_session_seats s
  join public.game_sessions g on g.id = s.game_session_id
  where s.user_id = v_me
    and s.status <> 'left'
    and g.status in ('lobby', 'active')
  limit 1;

  if v_seat is not null then
    raise exception 'you are already seated at a table' using errcode = 'PT409';
  end if;

  -- The tier's unlock level is checked here AND again when the seat is funded.
  -- This one is a courtesy so a player is not queued into a table they cannot
  -- sit at; the one that matters is the one next to the money.
  select level into v_level from public.profiles where id = v_me;
  if p_tier = 'high' and coalesce(v_level, 1) < 10 then
    raise exception 'the high table unlocks at level 10' using errcode = 'P0001';
  end if;

  -- Re-queueing is not an error: it is what a client does after a reconnect.
  -- Both live statuses are considered, not just 'waiting'. A matched player who
  -- re-queues is reconnecting to the room they were already given, and treating
  -- that as a fresh enrolment is what allocated a second table.
  select * into v_entry
  from public.matchmaking_queue
  where user_id = v_me and status in ('waiting', 'matched')
  order by enqueued_at desc
  limit 1;

  if found then
    if v_entry.tier <> p_tier and v_entry.status = 'waiting' then
      -- Changing your mind about the stakes cancels the old wait rather than
      -- leaving a player queued for two tables at once. Only while WAITING: a
      -- matched seat is already allocated and is not silently abandoned.
      update public.matchmaking_queue set status = 'cancelled'
      where id = v_entry.id;
    elsif v_entry.status = 'matched'
      and not exists (
        select 1 from public.room_members m
        where m.room_id = v_entry.room_id
          and m.user_id = v_me
          and m.status = 'joined'
      )
    then
      /*
       * THE RESERVATION IS SPENT. See the migration header: a `matched` entry
       * whose membership has gone is a room this player is no longer at, and
       * returning it hands the client a "Seat found" card for a table that
       * answers the buy-in NOT_A_PARTICIPANT.
       *
       * Membership rather than the seat, because the case the branch above
       * defends is a player who was matched and has NOT bought in yet — a
       * reconnect, exactly as its comment says. That player holds a `joined`
       * row, put there by the allocation itself, so they still take the
       * reconnect path.
       *
       * A live seat cannot be involved either way: the guard above has already
       * raised PT409 for anybody holding one.
       */
      update public.matchmaking_queue set status = 'cancelled'
      where id = v_entry.id;
    else
      -- Not a new enrolment, so nothing is charged.
      return v_entry;
    end if;
  end if;

  -- Charged here, immediately before the row that makes it an enrolment.
  perform public.enforce_rate_limit('matchmaking_enroll');

  insert into public.matchmaking_queue (user_id, tier)
  values (v_me, p_tier)
  returning * into v_entry;

  return v_entry;
end;
$$;

comment on function public.release_room_seat(uuid, uuid) is
  'Releases one member''s room seat, migrates the host if they held it, closes '
  'the room when it empties, and cancels the matchmaking reservation that '
  'produced the seat. Server-only: the argument names somebody else''s room.';

revoke execute on function public.release_room_seat(uuid, uuid) from public, anon, authenticated;

comment on function public.join_matchmaking(public.table_tier) is
  'Enrols this player at these stakes, or returns the search already running. A '
  'matched entry whose room membership has gone is spent, not a reconnect, and '
  'is replaced by a fresh enrolment.';

revoke execute on function public.join_matchmaking(public.table_tier) from public, anon;
grant  execute on function public.join_matchmaking(public.table_tier) to authenticated;

-- A migration that changes a grant asks the gate, as its last line.
select public.assert_client_authorization_surface();
