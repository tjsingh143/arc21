-- =============================================================================
-- Arc 21 — a refusal is not a server fault
-- =============================================================================
--
-- `CLAUDE.md` already carries this exact lesson, learned once and not applied
-- everywhere it applies:
--
--   > **PostgREST maps SQLSTATE `PTnnn` to HTTP nnn.** Use `PT429` for a
--   > rate-limit refusal. The username limit raised `55000`, which PostgREST
--   > renders as **HTTP 500**: a player who renamed twice in a month was told
--   > the server had broken.
--
-- Every deliberate refusal in the friend graph and the room lobby raises
-- `P0002` (`no_data_found`), and PostgREST has no mapping for it either, so all
-- of them render as HTTP 500 too. Measured against the running stack, over the
-- REST path the app actually uses:
--
--   send_friend_request  → a stranger's id      500  P0002 "no such player"
--   accept_friend_request → nothing pending     500  P0002 "there is no pending request…"
--   get_room_state       → a room you left      500  P0002 "you are not at that table"
--   set_room_ready       → a room you left      500  P0002 "you are not at that table"
--
-- while the refusals that happen to use `P0001` answered 400 correctly beside
-- them. Two places in this repository state the belief that made it invisible —
-- `rooms-gateway.ts` ("PostgreSQL `no_data_found`; PostgREST renders it as HTTP
-- 404") and a comment in the room integration suite ("P0002 → PostgREST 404").
-- Both are wrong, and both were written by somebody reasoning about it rather
-- than sending one request.
--
-- WHAT IT ACTUALLY COSTS. The client keys on the SQLSTATE in the body rather
-- than the status, so the wording a player sees is already right — which is
-- exactly why this survived. What it breaks is everything that reads a status:
-- a 5xx rate is the standard signal that a service is unhealthy, and a build
-- where ordinary play — tapping "add" on somebody who has deleted their
-- account, opening a lobby you were removed from — emits server errors has no
-- usable one. It also invites the next person to add a retry on 5xx, which
-- would hammer a server that is answering correctly.
--
-- `PT404` throughout: PostgREST renders it as HTTP 404, and the body still
-- carries `"code":"PT404"` for the client to key on. The MESSAGES are untouched
-- — "no such player" remains deliberately identical for a missing account and a
-- block, because distinguishing them tells an attacker the account exists and
-- who blocked them.
--
-- Every function below is copied from the LAST migration to define it, with the
-- errcode changed and nothing else:
--
--   send_friend_request    20260818100000_rate_limits.sql
--   accept_friend_request  20260817400000_notification_delivery.sql
--   invite_friend_to_room  20260817400000_notification_delivery.sql
--   get_room_state         20260816110000_rooms.sql
--   set_room_ready         20260816110000_rooms.sql
--
-- `join_private_room` is absent because it no longer raises at all: it returns
-- no row for every reason a code does not admit you, which is what makes the
-- room-join rate limit chargeable.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- The friend graph
-- -----------------------------------------------------------------------------

create or replace function public.send_friend_request(p_to uuid)
returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_me   uuid := auth.uid();
  v_name text;
begin
  if v_me is null then
    raise exception 'sending a request requires an authenticated session' using errcode = '42501';
  end if;

  -- Before any lookup of p_to. A limit consumed after a lookup would answer
  -- differently for an account that exists, which is precisely the probe the
  -- shared "no such player" wording exists to prevent.
  perform public.enforce_rate_limit('friend_request');

  if p_to = v_me then
    raise exception 'you cannot add yourself' using errcode = 'P0001';
  end if;
  if not exists (select 1 from public.profiles where id = p_to) then
    raise exception 'no such player' using errcode = 'PT404';
  end if;
  if public.is_blocked_between(v_me, p_to) then
    -- Deliberately the same wording a missing account would produce. Telling an
    -- attacker "you are blocked" confirms the account exists and who blocked
    -- them; the specification asks for no free-text contact for this reason.
    raise exception 'no such player' using errcode = 'PT404';
  end if;

  if public.are_friends(v_me, p_to) then
    return 'friends';
  end if;

  select coalesce(display_name, username::text) into v_name
  from public.profiles where id = v_me;

  -- They already asked us: accept rather than creating a mirrored request.
  -- Two people tapping "add" at the same time must end up friends, not with a
  -- pair of pending requests neither can resolve.
  if exists (select 1 from public.friend_requests
             where sender_id = p_to and receiver_id = v_me and status = 'pending') then
    perform public.accept_friend_request(p_to);
    return 'friends';
  end if;

  -- Idempotent: asking twice is not an error and does not stack rows.
  if exists (select 1 from public.friend_requests
             where sender_id = v_me and receiver_id = p_to and status = 'pending') then
    return 'outgoing_pending';
  end if;

  insert into public.friend_requests (sender_id, receiver_id, status)
  values (v_me, p_to, 'pending')
  on conflict do nothing;

  -- Deduped on the pair, so withdrawing and re-sending does not buzz them again.
  perform public.notify_user(
    p_to,
    'friend_request',
    'Friend request',
    coalesce(v_name, 'Someone') || ' wants to be friends.',
    jsonb_build_object('from_user_id', v_me::text),
    'friend_request:' || v_me::text
  );

  return 'outgoing_pending';
end;
$$;

create or replace function public.accept_friend_request(p_from uuid)
returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_me   uuid := auth.uid();
  v_name text;
begin
  if v_me is null then
    raise exception 'accepting requires an authenticated session' using errcode = '42501';
  end if;
  if public.is_blocked_between(v_me, p_from) then
    raise exception 'no such player' using errcode = 'PT404';
  end if;

  update public.friend_requests
  set status = 'accepted', responded_at = now()
  where sender_id = p_from and receiver_id = v_me and status = 'pending';

  if not found and not public.are_friends(v_me, p_from) then
    raise exception 'there is no pending request from that player' using errcode = 'PT404';
  end if;

  -- Any request pointing the other way is settled by the same acceptance.
  update public.friend_requests
  set status = 'accepted', responded_at = now()
  where sender_id = v_me and receiver_id = p_from and status = 'pending';

  insert into public.friendships (user_id_a, user_id_b)
  values (least(v_me, p_from), greatest(v_me, p_from))
  on conflict do nothing;

  select coalesce(display_name, username::text) into v_name
  from public.profiles where id = v_me;

  -- The person who asked hears back. The person who accepted already knows.
  perform public.notify_user(
    p_from,
    'friend_accepted',
    'Friend request accepted',
    coalesce(v_name, 'Someone') || ' accepted your friend request.',
    jsonb_build_object('from_user_id', v_me::text),
    'friend_accepted:' || v_me::text
  );

  -- The pending-request notification has been answered; leaving it unread would
  -- send the player back to a request that no longer exists.
  update public.notifications
  set read_at = coalesce(read_at, now())
  where user_id = v_me
    and kind = 'friend_request'
    and dedupe_key = 'friend_request:' || p_from::text;

  return 'friends';
end;
$$;

-- -----------------------------------------------------------------------------
-- The lobby
-- -----------------------------------------------------------------------------

create or replace function public.invite_friend_to_room(p_room_id uuid, p_friend uuid)
returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_me   uuid := auth.uid();
  v_room public.rooms;
  v_name text;
begin
  if v_me is null then
    raise exception 'inviting requires an authenticated session' using errcode = '42501';
  end if;
  if p_friend = v_me then
    raise exception 'you cannot invite yourself' using errcode = 'P0001';
  end if;
  if not public.are_friends(v_me, p_friend) then
    -- Same wording a missing account gets elsewhere in the friend graph.
    raise exception 'no such player' using errcode = 'PT404';
  end if;
  if public.is_blocked_between(v_me, p_friend) then
    raise exception 'no such player' using errcode = 'PT404';
  end if;

  select * into v_room
  from public.rooms
  where id = p_room_id and status in ('lobby', 'active');

  if not found or v_room.expires_at < now() then
    raise exception 'that table is not available' using errcode = 'PT404';
  end if;

  if not exists (
    select 1 from public.room_members
    where room_id = p_room_id and user_id = v_me and status = 'joined'
  ) then
    raise exception 'you are not at that table' using errcode = 'PT404';
  end if;

  select coalesce(display_name, username::text) into v_name
  from public.profiles where id = v_me;

  perform public.notify_user(
    p_friend,
    'table_invite',
    'Table invite',
    coalesce(v_name, 'A friend') || ' invited you to a private table.',
    jsonb_build_object('room_code', v_room.code, 'from_user_id', v_me::text),
    'table_invite:' || p_room_id::text
  );

  return 'invited';
end;
$$;

create or replace function public.get_room_state(p_room_id uuid)
returns table (
  room_id uuid,
  code text,
  status public.room_status,
  host_user_id uuid,
  max_seats int,
  game_session_id uuid,
  member_user_id uuid,
  member_username text,
  member_display_name text,
  member_seat_index int,
  member_is_ready boolean,
  member_is_host boolean
)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
-- The RETURNS TABLE column names shadow real columns of the same name inside
-- the body, which makes `room_id` ambiguous. Prefer the column.
#variable_conflict use_column
declare
  v_me uuid := auth.uid();
begin
  if v_me is null then
    raise exception 'this requires an authenticated session' using errcode = '42501';
  end if;
  if not exists (
    select 1 from public.room_members m
    where m.room_id = p_room_id and m.user_id = v_me and m.status = 'joined'
  ) then
    raise exception 'you are not at that table' using errcode = 'PT404';
  end if;

  return query
  select r.id, r.code, r.status, r.host_user_id, r.max_seats, r.game_session_id,
         m.user_id, p.username::text, p.display_name, m.seat_index, m.is_ready,
         (m.user_id = r.host_user_id)
  from public.rooms r
  join public.room_members m on m.room_id = r.id and m.status = 'joined'
  join public.profiles p on p.id = m.user_id
  where r.id = p_room_id
  order by m.seat_index;
end;
$$;

create or replace function public.set_room_ready(p_room_id uuid, p_ready boolean)
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

  update public.room_members
  set is_ready = p_ready, last_seen_at = now()
  where room_id = p_room_id and user_id = v_me and status = 'joined';

  if not found then
    raise exception 'you are not at that table' using errcode = 'PT404';
  end if;
end;
$$;

-- No grant changes: every one of these functions keeps the privileges it already
-- had, and `create or replace function` preserves an existing ACL. The gate is
-- called anyway, because a migration that touches this surface should have to
-- prove it left the surface where it found it.

select public.assert_client_authorization_surface();
