-- =============================================================================
-- Arc 21 — one live seat per player, at the queue as well as at the money
-- =============================================================================
--
-- THE DEFECT, reproduced against a running stack before this file existed.
--
--   JOIN A: 200 {"wallet":23000,"buyIn":2000}
--   join_matchmaking again: 200 {"status":"waiting"}   <- already seated
--   poll: 200 [{"status":"matched","room_id":"..."}]   <- a DIFFERENT room
--   JOIN B: 200 {"wallet":21000}                       <- charged twice
--
-- `join_matchmaking` reuses an existing enrolment so a reconnect does not pay
-- twice, and it looks for that enrolment by `status = 'waiting'`. A player who
-- has been matched holds a `matched` row, so the lookup missed, a second
-- enrolment was inserted, and `poll_matchmaking` allocated it a different room
-- because the first had left `lobby` the moment it opened. The buy-in
-- idempotency key is derived from the GAME, so two games are two keys and both
-- were honoured. The wallet paid for both.
--
-- THE RELATIONSHIP BETWEEN THE TWO FIXES. This one is a COURTESY, in exactly
-- the sense the tier's unlock level already is a few lines below: it keeps a
-- client out of a queue whose seat it could not take. The CONTROL is
-- `assertNoOtherLiveSeat` in `create-session`, which stands next to the debit.
-- The queue cannot be the only check, because being MATCHED is not being
-- seated: a matched player may open a solo table first and then take the public
-- seat, which is a second escrow reached through nothing but ordinary calls.
--
-- WHY THE WHOLE BODY IS HERE. `create or replace function` silently reverts
-- every later redefinition, so this starts from the LAST version of the
-- function — `20260818100000_rate_limits.sql`, not the original in
-- `20260817100000_matchmaking.sql` — and keeps its rate-limit charge intact.
--
-- WHERE THE CHECK SITS, and why it is before the charge. `enforce_rate_limit`
-- is consumed inside the caller's transaction, so an exception raised after it
-- rolls the consumption back and the attempt is not counted. That is the right
-- shape for a refusal (a window that cannot drain is a ban, not a limit) and it
-- costs nothing here: reaching this branch at all requires holding a live seat,
-- which requires having paid a buy-in.
-- =============================================================================

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
    raise exception 'you are already seated at a table' using errcode = 'P0001';
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

comment on function public.join_matchmaking(public.table_tier) is
  'Enrols a player in the public-table queue. Refuses a player who already '
  'holds a live seat, and reuses an existing waiting OR matched enrolment so a '
  'reconnect never allocates a second room. The seat itself is funded by '
  'create-session, which repeats the live-seat check beside the debit.';

-- `create or replace` preserves the ACL, so no grant moved. The pair is
-- re-issued anyway, because a default ACL of EXECUTE TO PUBLIC is the mistake
-- this project has made sixteen times, and the gate below is what proves it.
revoke execute on function public.join_matchmaking(public.table_tier) from public, anon;
grant  execute on function public.join_matchmaking(public.table_tier) to authenticated;

do $$ begin perform public.assert_client_authorization_surface(); end $$;

-- =============================================================================
-- Leaving a match, not just a wait
-- =============================================================================
--
-- Found while making the change above, and it has to be fixed in the same file
-- or that change makes it worse.
--
-- `leave_matchmaking` cancelled `status = 'waiting'` only. A MATCHED player —
-- allocated a lobby seat but not yet charged — therefore had no way out: their
-- queue row stayed `matched` and their `room_members` row stayed `joined`,
-- holding a seat in a lobby nobody would ever fill. Before this file that
-- stranding was invisible, because re-queueing simply created a new enrolment
-- and the client moved on. Now that a re-queue REUSES a matched entry, a player
-- who backed out would be handed the same dead match for ever.
--
-- What it must not do: take a SEATED player out of their table. Once the buy-in
-- is paid the player's chips are in that game's escrow, and the way out of a
-- table is `LEAVE_TABLE`, which cashes them back. So the membership is released
-- only when no live seat exists for that room's session; the queue row is
-- cleared either way, because the queue's work is finished in both cases.
-- =============================================================================

create or replace function public.leave_matchmaking()
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_me uuid := auth.uid();
begin
  if v_me is null then
    raise exception 'this requires an authenticated session' using errcode = '42501';
  end if;

  -- Release the lobby seat of any match that was never funded. Scoped to rooms
  -- this player was matched into, and refused where a seat is live.
  update public.room_members m
  set status = 'left'
  where m.user_id = v_me
    and m.status = 'joined'
    and m.room_id in (
      select q.room_id from public.matchmaking_queue q
      where q.user_id = v_me and q.status = 'matched' and q.room_id is not null
    )
    and not exists (
      select 1
      from public.rooms r
      join public.game_session_seats s on s.game_session_id = r.game_session_id
      where r.id = m.room_id
        and s.user_id = v_me
        and s.status <> 'left'
    );

  update public.matchmaking_queue
  set status = 'cancelled'
  where user_id = v_me and status in ('waiting', 'matched');
end;
$$;

comment on function public.leave_matchmaking() is
  'Cancels a waiting OR matched enrolment and releases the lobby seat of a '
  'match that was never funded. A player who has already bought in keeps their '
  'seat: the way out of a funded table is LEAVE_TABLE, which cashes them back.';

revoke execute on function public.leave_matchmaking() from public, anon;
grant  execute on function public.leave_matchmaking() to authenticated;

do $$ begin perform public.assert_client_authorization_surface(); end $$;
