-- =============================================================================
-- Arc 21 — a public table keeps taking players, and nobody opens one alone
-- =============================================================================
--
-- TWO DEFECTS, both measured against the running stack before this file
-- existed, and both of them the same shape this repository keeps rediscovering:
-- a mechanism that is complete on one side of a boundary and unreachable from
-- the other.
--
-- -----------------------------------------------------------------------------
-- 1. A PUBLIC TABLE STOPPED TAKING PLAYERS THE MOMENT THE FIRST ONE PAID.
-- -----------------------------------------------------------------------------
--
-- `poll_matchmaking` only ever considered rooms at `status = 'lobby'`, and
-- `JOIN_PUBLIC_TABLE` sets the room to `active` as it funds the first seat. So
-- the ordinary sequence — one player queues, is matched, taps "Take the seat" a
-- second later, and a second player queues ten seconds after that — allocated
-- the second player a BRAND NEW ROOM every time. Measured, two accounts, live
-- stack:
--
--     A join_matchmaking  200
--     A poll              matched, room 4285219d-…  (status lobby)
--     A JOIN_PUBLIC_TABLE 200  buyIn 2000            (room -> active)
--     B join_matchmaking  200
--     B poll              matched, room e67e20e4-…  <- a different table
--
-- Two players who both chose Casual within four seconds of each other never
-- met. A "public table" was a solo table with a queue in front of it, and the
-- only way two people could share one was to both poll inside the window before
-- either bought in.
--
-- WHAT THAT MADE UNREACHABLE, which is the more serious half. `joinPublicTable`
-- in `create-session` already appends a seat to a LIVE engine state, with its
-- own funded stack and a version bump, and the specification's rule for it —
-- *"joining mid-hand: seat may be reserved, player joins gameplay at next
-- BETTING_OPEN"* — falls out of the engine dealing only to seats that have
-- locked a bet. That code was correct, typechecked and covered, and no
-- allocation could ever reach it, because a table with a hand in progress is
-- `active` and `active` was not a candidate.
--
-- -----------------------------------------------------------------------------
-- 2. NOBODY EVER WAITED, SO THE WHOLE WAITING UX WAS DEAD CODE.
-- -----------------------------------------------------------------------------
--
-- The specification asks for a search that broadens, and then
-- *"after ~20 seconds display Keep Waiting / Play Solo / Cancel"*. A player's
-- FIRST poll created a room and returned `matched`, so `status = 'waiting'` was
-- observable for a few milliseconds at most: `shouldOfferAlternatives`,
-- `describeWait`'s "Still looking — 14s", and every control behind them could
-- not be reached by anybody.
--
-- Opening a table for a lone player is also the wrong answer on its own terms.
-- A public table is *"two to five human seats"*; seating one person at an empty
-- one and calling it matchmaking is the closest this build came to the thing the
-- specification forbids outright — presenting a table as public play when there
-- is nobody there. Nothing was faked, but nothing was matched either.
--
-- So a room is now opened only when there is somebody to share it with: an
-- existing public table with room in it, or another player already waiting at
-- the same stakes. Otherwise the player WAITS, which is what makes Keep Waiting
-- and Play Solo mean something.
--
-- -----------------------------------------------------------------------------
-- WHAT DOES NOT CHANGE
-- -----------------------------------------------------------------------------
--
-- This file allocates seats and moves no chips, exactly as before. The buy-in
-- stays where it is — `apply_wallet_delta`, called from `create-session` under
-- a key derived from the game and the player. Capacity is still decided under
-- the per-tier advisory lock so concurrent pollers cannot both take the last
-- seat, and it is checked AGAIN beside the money in `joinPublicTable`, because
-- a courtesy that is missing is what lets a client reach the debit at all.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- A reservation that is never taken up has to expire
-- ---------------------------------------------------------------------------
--
-- `matchmaking_queue`'s own comment has said since the table was created that
-- "a client that vanishes must not hold a place forever and make a table look
-- busier than it is" — and the housekeeping only ever expired `waiting` rows.
-- A player who is MATCHED holds a `room_members` seat, and taking that seat up
-- is a deliberate second step: they must tap "Take the seat", because that is
-- the tap that spends 2,000 chips. Close the app on that screen and the seat
-- was held for the life of the room.
--
-- It mattered little while a funded table stopped taking players anyway. It
-- matters now: a five-seat table that keeps taking players for as long as it
-- runs is exactly the table a phantom member quietly shrinks. Observed while
-- proving the allocation fix — a room reported three seats taken with two
-- people playing at it, the third being an account from an earlier run that had
-- been matched and had never paid.
--
-- The release is `leave_matchmaking`'s, with the same refusal: a membership
-- whose player DOES hold a live seat at that room's game is never touched,
-- because that one is not a reservation, it is a player.

create or replace function public.retire_empty_lobby_room(p_room_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  update public.rooms r
  set status = 'closed'
  where r.id = p_room_id
    and r.status = 'lobby'
    and r.game_session_id is null
    and not exists (
      select 1 from public.room_members m
      where m.room_id = r.id and m.status = 'joined'
    );
end;
$$;

revoke execute on function public.retire_empty_lobby_room(uuid) from public, anon, authenticated;

comment on function public.retire_empty_lobby_room(uuid) is
  'Closes a lobby room that has no members and no game. Server-only: the '
  'argument names somebody else''s room.';

create or replace function public.expire_stale_queue_entries()
returns int
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_count int;
  v_rooms uuid[];
begin
  update public.matchmaking_queue
  set status = 'expired'
  where status = 'waiting' and expires_at < now();

  get diagnostics v_count = row_count;

  -- An unfunded reservation. Two minutes is long enough to read the card and
  -- decide, and short enough that a table is not held open by somebody who has
  -- gone.
  with abandoned as (
    select q.id, q.user_id, q.room_id
    from public.matchmaking_queue q
    where q.status = 'matched'
      and q.room_id is not null
      and q.matched_at < now() - interval '2 minutes'
      and not exists (
        select 1
        from public.rooms r
        join public.game_session_seats s on s.game_session_id = r.game_session_id
        where r.id = q.room_id
          and s.user_id = q.user_id
          and s.status <> 'left'
      )
  ), released as (
    update public.room_members m
    set status = 'left'
    from abandoned a
    where m.room_id = a.room_id and m.user_id = a.user_id and m.status = 'joined'
    returning m.room_id
  ), finished as (
    update public.matchmaking_queue q
    set status = 'expired'
    from abandoned a
    where q.id = a.id
    returning q.room_id
  )
  select coalesce(array_agg(distinct room_id), '{}'::uuid[]) into v_rooms from released;

  -- A reservation released by housekeeping empties a room exactly as leaving
  -- the queue does, so it retires one exactly as leaving the queue does.
  if array_length(v_rooms, 1) is not null then
    perform public.retire_empty_lobby_room(room_id)
    from unnest(v_rooms) as t(room_id);
  end if;

  return v_count;
end;
$$;

-- ---------------------------------------------------------------------------
-- Allocation
-- ---------------------------------------------------------------------------
--
-- The signature gains a column, so this is a drop and a create rather than a
-- replace. `others_waiting` is the honest answer to the question the waiting
-- screen was previously answering by assertion: it said "Nobody else is
-- queueing for these stakes right now" without having asked.

drop function if exists public.poll_matchmaking();

create function public.poll_matchmaking()
returns table (
  status public.queue_status,
  tier public.table_tier,
  room_id uuid,
  room_code text,
  waiting_since timestamptz,
  queued_at_tier int,
  others_waiting int
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
#variable_conflict use_column
declare
  v_me      uuid := auth.uid();
  v_entry   public.matchmaking_queue;
  v_room    public.rooms;
  v_seated  int;
  v_waiting int;
begin
  if v_me is null then
    raise exception 'this requires an authenticated session' using errcode = '42501';
  end if;

  perform public.expire_stale_queue_entries();

  select * into v_entry
  from public.matchmaking_queue
  where user_id = v_me and status in ('waiting', 'matched')
  order by enqueued_at desc
  limit 1;

  if not found then
    return;
  end if;

  /*
   * How many OTHER players are queueing for these stakes, counted once and
   * reported by EVERY branch below.
   *
   * It was a literal zero in the two `matched` branches, so the column meant
   * "other waiting players" in one answer and "nothing was measured" in the
   * others — a field read as a fact that was not one. It is also the number the
   * decision further down turns on, so returning it truthfully lets a caller
   * see the REASON for the answer it got: a room is opened only when there is
   * somebody to share it with, and this says whether there was.
   *
   * Snapshot semantics are fine here. A player who enrols between this count
   * and the allocation below is simply told to wait one more round, and their
   * own next poll finds the table. The advisory lock protects the thing that
   * needs protecting, which is creating the room.
   */
  select count(*) into v_waiting
  from public.matchmaking_queue q
  where q.tier = v_entry.tier
    and q.status = 'waiting'
    and q.user_id <> v_me
    and q.expires_at > now();

  -- Already seated: report where, and stop. Re-allocating would move a player
  -- who may already have paid a buy-in.
  if v_entry.status = 'matched' then
    select * into v_room from public.rooms where id = v_entry.room_id;
    return query select v_entry.status, v_entry.tier, v_entry.room_id, v_room.code,
                        v_entry.enqueued_at, 0, v_waiting;
    return;
  end if;

  /*
   * Serialise every allocation for this tier behind one advisory lock.
   *
   * The obvious implementation — `for update skip locked` on the candidate
   * table — is safe but wrong. Under contention each poller SKIPS the table
   * another is holding and opens its own, so six players arriving together
   * landed at five different tables. Measured, not theorised. That is the
   * opposite of matchmaking.
   *
   * A transaction-scoped advisory lock makes find-or-create atomic per tier:
   * concurrent pollers queue up, and each one sees the seat the previous took.
   * It is held only for the length of this allocation and released at commit.
   */
  perform pg_advisory_xact_lock(hashtext('matchmaking:' || v_entry.tier::text));

  /*
   * A table with room in it, whether or not it has dealt.
   *
   * `active` is the addition, and it is the whole of defect 1. A public table
   * that has started is still a public table: the specification reserves a seat
   * for a mid-shoe joiner and deals them in at the next BETTING_OPEN, which is
   * what `joinPublicTable` does with the seat this allocation hands it.
   *
   * The joins are what keep a DEAD table out of the list. A room whose session
   * has completed or been abandoned is not a candidate however its own row
   * reads, and a lobby room that has aged past `expires_at` is not one either —
   * that check is scoped to `lobby` deliberately, because an active table's
   * `expires_at` is thirty minutes from the moment it was created and a good
   * table outlives it.
   */
  select r.* into v_room
  from public.rooms r
  left join public.game_sessions g on g.id = r.game_session_id
  cross join lateral (
    select count(*) as taken from public.room_members m
    where m.room_id = r.id and m.status = 'joined'
  ) seats
  where r.visibility = 'public'
    and r.mode = 'public_table'
    and r.tier = v_entry.tier
    and r.status in ('lobby', 'active')
    and (r.status <> 'lobby' or r.expires_at > now())
    and (r.game_session_id is null or g.status in ('lobby', 'active'))
    /*
     * SOMEBODY HAS TO BE THERE. A room everybody has left is not a table, it is
     * a leftover — and matching a lone player into one produces exactly the
     * thing this file exists to stop: a "public table" with one person at it,
     * reached without ever observing `waiting`. Caught by running the public
     * suite twice: the second run's lone player was matched into an empty room
     * the first run had abandoned.
     */
    and seats.taken > 0
    and seats.taken < r.max_seats
  -- Oldest first, so tables fill rather than spreading everyone thin.
  order by r.created_at
  limit 1;

  if not found then
    /*
     * Nowhere to sit. Open a table only if somebody else is waiting for one.
     *
     * This is defect 2. Creating a room here unconditionally answered every
     * first poll with `matched`, so no player ever observed `waiting` and the
     * Keep Waiting / Play Solo / Cancel offer the specification asks for after
     * twenty seconds could not be reached by anybody.
     *
     * One other waiting player is enough: this poll opens the table and takes a
     * seat, and their next poll finds it through the branch above. The advisory
     * lock is what makes that safe — two simultaneous pollers cannot both
     * decide they are the one who opens it.
     */
    if v_waiting = 0 then
      -- Still looking. Nothing has been allocated and nothing charged.
      return query select 'waiting'::public.queue_status, v_entry.tier,
                          null::uuid, null::text, v_entry.enqueued_at, 0, v_waiting;
      return;
    end if;

    -- They are the host by accident of arriving first; the host owns nothing
    -- but the lobby.
    insert into public.rooms (code, host_user_id, visibility, mode, max_seats, tier)
    values (public.generate_room_code(), v_me, 'public', 'public_table', 5, v_entry.tier)
    returning * into v_room;
  end if;

  select count(*) into v_seated
  from public.room_members m
  where m.room_id = v_room.id and m.status = 'joined';

  insert into public.room_members (room_id, user_id, seat_index)
  values (
    v_room.id,
    v_me,
    coalesce((
      select min(s) from generate_series(0, v_room.max_seats - 1) s
      where s not in (
        select seat_index from public.room_members
        where room_id = v_room.id and status = 'joined'
      )
    ), 0)
  )
  on conflict (room_id, user_id) do update set status = 'joined';

  update public.matchmaking_queue
  set status = 'matched', room_id = v_room.id, matched_at = now()
  where id = v_entry.id;

  return query select 'matched'::public.queue_status, v_entry.tier, v_room.id, v_room.code,
                      v_entry.enqueued_at, v_seated, v_waiting;
end;
$$;

comment on function public.poll_matchmaking() is
  'Allocates a public seat, or reports that the search is still running. A '
  'table with capacity is joined whether or not it has dealt; a new one is '
  'opened only when another player is already waiting at the same stakes.';

-- A new function''s default ACL is EXECUTE TO PUBLIC, so the revoke is not
-- optional and the grant alone would leave this callable by `anon`.
revoke execute on function public.poll_matchmaking() from public, anon;
grant  execute on function public.poll_matchmaking() to authenticated;

-- ---------------------------------------------------------------------------
-- A room nobody is in is retired, not left standing
-- ---------------------------------------------------------------------------
--
-- `leave_matchmaking` releases an unfunded lobby seat by writing `room_members`
-- directly, so it never went through `release_room_seat` and never closed a
-- room it emptied. The result was an abandoned public room sitting in `lobby`
-- with nobody in it, holding its six-character code until `expires_at`.
--
-- That was invisible while such a room could not be joined. It is not now:
-- `poll_matchmaking` refuses a room with no members for the same reason, and
-- this closes the room so it stops being considered at all. Narrow on purpose —
-- only a room with NO game session, because a room whose table is running is
-- retired by `release_room_seat` when the last SEAT settles, and closing it on
-- a membership count would close it under the players.

-- The whole body, from the LAST definition — `20260823100000_one_live_seat.sql`
-- — with the retirement added after the release.
create or replace function public.leave_matchmaking()
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_me    uuid := auth.uid();
  v_rooms uuid[];
begin
  if v_me is null then
    raise exception 'this requires an authenticated session' using errcode = '42501';
  end if;

  -- Release the lobby seat of any match that was never funded. Scoped to rooms
  -- this player was matched into, and refused where a seat is live.
  with released as (
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
      )
    returning m.room_id
  )
  select coalesce(array_agg(room_id), '{}'::uuid[]) into v_rooms from released;

  update public.matchmaking_queue
  set status = 'cancelled'
  where user_id = v_me and status in ('waiting', 'matched');

  -- And a room the player was the last one in is retired rather than left
  -- standing empty, holding its code.
  if array_length(v_rooms, 1) is not null then
    perform public.retire_empty_lobby_room(room_id)
    from unnest(v_rooms) as t(room_id);
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- "You are already seated" is a refusal, not a fault
-- ---------------------------------------------------------------------------
--
-- `P0001` reaches the client as HTTP 400 with a lowercase sentence and no code
-- to branch on, so the queue screen printed the server's own words and offered
-- nothing to do about them — while `takeSeat`, one step later, has named the
-- way back since the active-session lookup shipped. `PT409` is the mapped code
-- (PostgREST maps SQLSTATE PTnnn to HTTP nnn), which lets the client tell this
-- one refusal from every other and say where the player's chips actually are.
--
-- THE WHOLE BODY IS HERE because `create or replace function` silently reverts
-- every later redefinition. This starts from the LAST version —
-- `20260823100000_one_live_seat.sql` — and changes one `using errcode`.

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

-- ---------------------------------------------------------------------------
-- A public table's seats belong to the queue, not to a code and not to a host
-- ---------------------------------------------------------------------------
--
-- Two ways into a public room that went around `poll_matchmaking` entirely.
-- Neither is an economic hole — every buy-in guard is downstream of both — but
-- both decide WHO SITS WITH WHOM at the tables the specification calls matched
-- play, and that decision is the queue's.
--
-- Each body below starts from the LAST definition of its function, because
-- `create or replace function` silently reverts every later redefinition:
-- `join_private_room` from `20260830130000_room_lifecycle_and_presence.sql`
-- (four migrations have redefined it) and `remove_room_member` from
-- `20260823170000_remove_room_member.sql`.

create or replace function public.join_private_room(p_code text)
returns public.rooms
language plpgsql
security definer
set search_path = public, pg_temp
as $$

declare
  v_me    uuid := auth.uid();
  v_room  public.rooms;
  v_seat  int;
  v_taken int;
begin
  if v_me is null then
    raise exception 'joining requires an authenticated session' using errcode = '42501';
  end if;

  -- Before the code is looked at, for the same reason as the friend graph: a
  -- limit consumed after the lookup would answer differently for a code that
  -- resolves.
  perform public.enforce_rate_limit('room_join');

  -- Codes are typed by hand: fold case and drop spaces before matching, so a
  -- player who types "abc def" is not told their code is wrong.
  select * into v_room
  from public.rooms
  where code = upper(regexp_replace(coalesce(p_code, ''), '\s', '', 'g'))
    and status in ('lobby', 'active')
  -- Lock the room so two people taking the last seat cannot both succeed.
  for update;

  -- One answer for every reason a code does not admit you: unknown, expired,
  -- blocked, removed, playing already or full. Returning rather than raising is
  -- what lets the attempt above be counted.
  if not found then return null; end if;
  if v_room.expires_at < now() then return null; end if;

  /*
   * A PUBLIC TABLE IS ENTERED THROUGH THE QUEUE, NEVER THROUGH ITS CODE.
   *
   * `poll_matchmaking` gives a matched player the room's six-character code
   * along with its id, and nothing here had ever looked at `visibility` — so
   * passing that code to a friend seated the two of them together at a public
   * table, ahead of whoever the queue would have matched. Not an economic hole
   * (every buy-in guard still applies, and blackjack moves no chips between
   * players) but it is a way around the one mechanism that decides who sits
   * with whom, on the tables the specification calls matched play.
   *
   * The same silent `null` as every other refusal here: a caller learns nothing
   * about whether a code exists.
   */
  if v_room.visibility = 'public' then return null; end if;
  if public.is_blocked_between(v_me, v_room.host_user_id) then return null; end if;

  -- Removed by the host, and it sticks. Same silent refusal as every other:
  -- a removed player is not told they were removed by a code that stops
  -- working, and a guesser learns nothing either way.
  if exists (
    select 1 from public.room_members
    where room_id = v_room.id and user_id = v_me and status = 'kicked'
  ) then
    return null;
  end if;

  -- Rejoining is not an error; it is how reconnection works.
  if exists (select 1 from public.room_members
             where room_id = v_room.id and user_id = v_me and status = 'joined') then
    update public.room_members set last_seen_at = now()
    where room_id = v_room.id and user_id = v_me;
    return v_room;
  end if;

  /*
   * ONCE THE TABLE HAS DEALT, THE SERVER OWNS THE GAME.
   *
   * Seats are fixed when the host deals, so a player arriving afterwards would
   * get a `room_members` row and no `game_session_seats` row — and the lobby,
   * which resolves its own seat from that table, would poll for one for ever
   * with nothing on screen to explain why. Reproduced against the running
   * stack: a third player joined a playing room, `get_room_state` listed them,
   * and their seat query returned `[]`.
   *
   * Below the "already joined" branch, so an ordinary reconnect never reaches
   * it, and past a player who HOLDS a seat in the session, which is the one
   * case where somebody not currently a joined member is not a newcomer — a
   * player whose membership was ended while their seat was still live gets back
   * in by typing the same code.
   */
  if v_room.game_session_id is not null
     and not exists (
       select 1 from public.game_session_seats s
       where s.game_session_id = v_room.game_session_id
         and s.user_id = v_me
         -- A SETTLED seat is not a reconnection. A player who cashed out has
         -- had their chips; letting the code seat them again as a room member
         -- with no live game seat is the same stranding as a newcomer's.
         and s.status <> 'left'
     ) then
    return null;
  end if;

  select count(*) into v_taken
  from public.room_members
  where room_id = v_room.id and status = 'joined';

  if v_taken >= v_room.max_seats then return null; end if;

  -- Lowest free seat, so leaving and rejoining does not scatter people across
  -- the table. `status = 'joined'` here is the same predicate as the partial
  -- unique index `room_members_live_seat_idx`.
  select coalesce(min(s), 0) into v_seat
  from generate_series(0, v_room.max_seats - 1) s
  where s not in (
    select seat_index from public.room_members
    where room_id = v_room.id and status = 'joined'
  );

  insert into public.room_members (room_id, user_id, seat_index)
  values (v_room.id, v_me, v_seat)
  on conflict (room_id, user_id) do update
    -- `seat_index` is re-assigned, not kept. A returning player's old seat may
    -- have been taken while they were away, and holding the stale number is
    -- how one returning player collided with the person now sitting there.
    set status = 'joined', seat_index = excluded.seat_index, last_seen_at = now();

  return v_room;
end;
$$;

create or replace function public.remove_room_member(p_room_id uuid, p_user_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$

declare
  v_me   uuid := auth.uid();
  v_room public.rooms;
begin
  if v_me is null then
    raise exception 'this requires an authenticated session' using errcode = '42501';
  end if;

  select * into v_room from public.rooms where id = p_room_id for update;
  -- No row, and no distinction between "no such room" and "not your room": a
  -- caller who is not the host learns nothing about whether the room exists.
  if not found then return false; end if;
  if v_room.host_user_id <> v_me then return false; end if;

  -- Only in the lobby, and only before a game exists. Once a hand is dealt the
  -- seats hold chips, and the server owns the game.
  if v_room.status <> 'lobby' or v_room.game_session_id is not null then
    return false;
  end if;

  /*
   * NOBODY HOSTS A PUBLIC TABLE.
   *
   * `rooms.host_user_id` at a public table is whoever the allocator happened to
   * seat first — "the host by accident of arriving first; the host owns nothing
   * but the lobby", as `poll_matchmaking` puts it. This function never asked,
   * so that accidental host could read the room with `get_room_state` and kick
   * the strangers matchmaking had just placed beside them, one by one, before
   * anybody bought in. The victims kept a `matched` queue entry pointing at a
   * room that then answered NOT_A_PARTICIPANT.
   *
   * Removal is a PRIVATE room's rule: you invited them, so you may uninvite
   * them. A queue decides a public table's seats.
   */
  if v_room.visibility = 'public' then return false; end if;

  -- Never the host. That is `leave_room`, which migrates the role.
  if p_user_id = v_me then return false; end if;

  update public.room_members
  set status = 'kicked', is_ready = false
  where room_id = p_room_id and user_id = p_user_id and status = 'joined';

  return found;
end;
$$;

-- `join_matchmaking` keeps the ACL `create or replace` preserved; the gate is
-- called anyway, because a migration that touches this surface should have to
-- prove it left the surface where it found it.
select public.assert_client_authorization_surface();
