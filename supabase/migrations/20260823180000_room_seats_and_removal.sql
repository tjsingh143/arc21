-- =============================================================================
-- Arc 21 — a seat is occupied only while somebody is sitting in it, and a
--          removal is remembered
-- =============================================================================
--
-- TWO DEFECTS, ONE CAUSE: `room_members` keeps the row when a player leaves or
-- is removed, and both halves of the schema disagreed about what that row means.
--
-- 1. A VACATED SEAT COULD NOT BE REFILLED. `leave_room` sets `status = 'left'`
--    and keeps `seat_index`; `remove_room_member` sets `status = 'kicked'` and
--    keeps it too. `join_private_room` allocates "the lowest seat no JOINED
--    member holds" — the right rule — but the table carried
--    `unique (room_id, seat_index)` across EVERY row whatever its status. So
--    the most ordinary sequence a private table has, somebody leaves and
--    somebody else takes the free seat, failed:
--
--      A joins:  200
--      A leaves: 204
--      B joins:  409 {"code":"23505", …
--                "Key (room_id, seat_index)=(…, 1) already exists."}
--
--    A table refused a join for as long as anybody had ever left it, at a table
--    with a seat visibly free. Reproduced against the running stack, by
--    client-reachable RPCs only, before this migration existed.
--
--    The fix is to say what was meant: a seat is held while its holder is
--    JOINED. The whole-table constraint becomes a partial unique index over
--    exactly the rows the allocator treats as occupying a seat. THE INDEX
--    PREDICATE AND THE ALLOCATOR'S PREDICATE MUST STAY THE SAME SENTENCE — if a
--    later change makes `disconnected` hold a seat, it holds it in both places.
--
-- 2. A REMOVED PLAYER WALKED STRAIGHT BACK IN. `remove_room_member` shipped in
--    `20260823170000` with six pgTAP assertions, all passing, and removed
--    nobody in practice: `join_private_room` ends in
--    `on conflict (room_id, user_id) do update set status = 'joined'`, so the
--    removed player typed the same six characters and was seated again. pgTAP
--    proved the row said `kicked`; nothing proved it STAYED kicked, which is
--    the only thing a host removing somebody is asking for.
--
-- Redefined FROM `20260818100000_rate_limits.sql`, the last migration to define
-- `join_private_room` — `create or replace function` silently reverts every
-- later redefinition, and that one carries the `enforce_rate_limit('room_join')`
-- charge plus the returns-no-row refusal contract that makes the limit
-- enforceable. Both are preserved verbatim below.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- A seat is held while its holder is joined
-- -----------------------------------------------------------------------------

alter table public.room_members
  drop constraint if exists room_members_room_id_seat_index_key;

create unique index if not exists room_members_live_seat_idx
  on public.room_members (room_id, seat_index)
  where status = 'joined';

comment on index public.room_members_live_seat_idx is
  'Two joined members of one room never share a seat. Deliberately PARTIAL: a '
  'left or removed member keeps their row (so a return is a rejoin, and a '
  'removal is remembered) but stops occupying the seat. The predicate matches '
  'the one join_private_room allocates against — change both together.';

-- -----------------------------------------------------------------------------
-- `join_private_room` — refuses a removed player, and re-seats a returning one
-- -----------------------------------------------------------------------------

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
  -- blocked, removed or full. Returning rather than raising is what lets the
  -- attempt above be counted.
  if not found then return null; end if;
  if v_room.expires_at < now() then return null; end if;
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

  select count(*) into v_taken
  from public.room_members
  where room_id = v_room.id and status = 'joined';

  if v_taken >= v_room.max_seats then return null; end if;

  -- Lowest free seat, so leaving and rejoining does not scatter people across
  -- the table. `status = 'joined'` here is the same predicate as the partial
  -- unique index above.
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

revoke execute on function public.join_private_room(text) from public, anon;
grant  execute on function public.join_private_room(text) to authenticated;

-- A migration that changes a grant calls the gate as its last line: a
-- migration-time DO block only ever sees the state at its own position in the
-- ordering, and this one is after every grant so far.
do $$ begin perform public.assert_client_authorization_surface(); end $$;
