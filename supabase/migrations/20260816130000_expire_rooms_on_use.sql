-- Actually expire stale rooms.
--
-- `expire_stale_rooms()` was written and then never called by anything, which
-- made the 30-minute lobby timeout a comment rather than a behaviour: an
-- abandoned lobby kept its code indefinitely, and six characters are only
-- plentiful while retired rooms give theirs back.
--
-- It runs opportunistically on the two paths that touch rooms at all, rather
-- than on a schedule. A private room holds no escrow, so expiring one can never
-- strand chips — which is exactly why this is safe to do inline and why the
-- equivalent for a wallet-backed table will not be.

create or replace function public.create_private_room(p_max_seats int default 5)
returns public.rooms
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_me   uuid := auth.uid();
  v_room public.rooms;
begin
  if v_me is null then
    raise exception 'creating a table requires an authenticated session' using errcode = '42501';
  end if;
  if p_max_seats < 2 or p_max_seats > 5 then
    raise exception 'a private table seats between 2 and 5 players' using errcode = 'P0001';
  end if;

  -- Before the "one live room" check, so a player whose old lobby simply timed
  -- out is not told they already have a table open.
  perform public.expire_stale_rooms();

  if exists (
    select 1 from public.rooms
    where host_user_id = v_me and status in ('lobby', 'active', 'finishing')
  ) then
    raise exception 'you already have a table open' using errcode = 'P0001';
  end if;

  insert into public.rooms (code, host_user_id, max_seats)
  values (public.generate_room_code(), v_me, p_max_seats)
  returning * into v_room;

  insert into public.room_members (room_id, user_id, seat_index, is_ready)
  values (v_room.id, v_me, 0, true);

  return v_room;
end;
$$;

revoke execute on function public.create_private_room(int) from public, anon;
grant execute on function public.create_private_room(int) to authenticated;
