-- =============================================================================
-- Arc 21 — a room must not close while somebody is being seated into it
--
-- THE DEFECT, reproduced deterministically with two transactions against the
-- running stack. `poll_matchmaking` serialises allocation on a per-tier advisory
-- lock and takes no lock on the room it hands out; `release_room_seat` takes the
-- room row `for update` and closes the room when it counts no `joined` member.
-- Neither excludes the other:
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
-- The player has been matched into a CLOSED room, holds a live membership in it,
-- and their queue entry names it. `joinPublicTable` checks the room's status
-- before it looks at who is asking -- correctly, because a closed room must take
-- no more buy-ins -- so every attempt is answered HTTP 409 SESSION_CLOSED, and
-- `join_matchmaking` hands the same entry back each time, until
-- `expire_stale_queue_entries` retires the reservation two minutes later.
--
-- FOUND BY CI, on a documentation-only commit: `six matched public rooms and
-- none could be sat at: 409 … SESSION_CLOSED`, one test of 302. That is the
-- third time in this project's life that a markdown-only commit has failed the
-- database job for a real reason, and the second time the reason was a public
-- room being treated as somebody else's.
--
-- TWO CHANGES, and they answer different questions.
--
--   * `poll_matchmaking` re-asks its candidate question while holding that
--     room's own row lock, so a room a concurrent leave is closing is no longer
--     a candidate. This is the root cause.
--   * `join_matchmaking` will not hand back a `matched` entry whose room is no
--     longer joinable, so a player already holding one -- or stranded by some
--     path nobody has written yet -- re-enrols instead of retrying a refusal.
--     This is the recovery, and it is the same predicate as
--     20260907120000's, widened from "the membership is gone" to "or the room
--     is closed".
--
-- Bodies are taken from the LAST migration to define each function --
-- 20260901120000 for `poll_matchmaking`, 20260907120000 for `join_matchmaking`
-- -- per the `create or replace` rule in CLAUDE.md.
-- =============================================================================

create or replace function public.poll_matchmaking()
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
  -- The candidate's id, kept across the row lock taken below.
  v_candidate uuid;
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

  /*
   * AND THEN ASK AGAIN, HOLDING THE ROOM'S OWN ROW LOCK.
   *
   * The advisory lock above serialises allocation against other POLLERS. It
   * does not exclude `release_room_seat`, which takes the room row `for update`
   * and closes the room when it counts no `joined` member — so the two could
   * interleave, and did:
   *
   *   T1  begin; release_room_seat(R, last member)   -- row locked, count = 0
   *   T2  poll_matchmaking()                         -- reads R as still open,
   *                                                  --   inserts a membership,
   *                                                  --   commits
   *   T1  update rooms set status = 'closed'; commit
   *
   * leaving a CLOSED room with a live `joined` member and a `matched` queue
   * entry naming it. That player's buy-in is then answered SESSION_CLOSED —
   * every time, because the entry keeps naming the same room — until
   * housekeeping retires the reservation two minutes later. Reproduced
   * deterministically with those two transactions, and it is what CI's
   * `six matched public rooms and none could be sat at: 409 SESSION_CLOSED`
   * was: the same closed room handed back six times.
   *
   * Taking the room row here puts both paths behind one lock, so a candidate
   * that a concurrent leave is closing is no longer a candidate. The lock is
   * taken AFTER the tier advisory lock and nothing takes them the other way
   * round, so the order matches `tests/contracts/room-lock-order.test.ts`'s
   * rule for the functions above it: rooms before anything else they touch.
   */
  if found then
    v_candidate := v_room.id;

    perform 1 from public.rooms where id = v_candidate for update;

    select r.* into v_room
    from public.rooms r
    left join public.game_sessions g on g.id = r.game_session_id
    cross join lateral (
      select count(*) as taken from public.room_members m
      where m.room_id = r.id and m.status = 'joined'
    ) seats
    where r.id = v_candidate
      and r.status in ('lobby', 'active')
      and (r.status <> 'lobby' or r.expires_at > now())
      and (r.game_session_id is null or g.status in ('lobby', 'active'))
      and seats.taken > 0
      and seats.taken < r.max_seats;
  end if;

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
      and (
        not exists (
          select 1 from public.room_members m
          where m.room_id = v_entry.room_id
            and m.user_id = v_me
            and m.status = 'joined'
        )
        /*
         * OR THE ROOM ITSELF IS NO LONGER JOINABLE.
         *
         * The membership test above covers a reservation this player gave up.
         * It does not cover a room that CLOSED underneath a membership they
         * still hold — which `poll_matchmaking` could produce before the row
         * lock added in this migration, and which any future path might
         * produce again. `joinPublicTable` refuses such a room SESSION_CLOSED
         * before it looks at who is asking, so handing the entry back is
         * handing back a refusal; the player re-enrols instead.
         */
        or not exists (
          select 1 from public.rooms r
          where r.id = v_entry.room_id
            and r.status in ('lobby', 'active')
        )
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

comment on function public.poll_matchmaking() is
  'Allocates a public seat, or reports that the search is still running. A '
  'table with capacity is joined whether or not it has dealt; a new one is '
  'opened only when another player is already waiting at the same stakes. The '
  'candidate is confirmed under its own row lock, so a room a concurrent leave '
  'is closing is never handed out.';

revoke execute on function public.poll_matchmaking() from public, anon;
grant  execute on function public.poll_matchmaking() to authenticated;

comment on function public.join_matchmaking(public.table_tier) is
  'Enrols this player at these stakes, or returns the search already running. A '
  'matched entry whose room membership has gone, or whose room has closed, is '
  'spent rather than a reconnect, and is replaced by a fresh enrolment.';

revoke execute on function public.join_matchmaking(public.table_tier) from public, anon;
grant  execute on function public.join_matchmaking(public.table_tier) to authenticated;

-- A migration that changes a grant asks the gate, as its last line.
select public.assert_client_authorization_surface();
