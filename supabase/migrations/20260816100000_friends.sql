-- Friends: search, request, accept, remove, block.
--
-- Every operation is a SECURITY DEFINER function taking the *other* person's id
-- and reading the caller from the session. None of them accepts a "from" — an
-- API where the client names both sides of a relationship is one where a
-- modified client sends friend requests as somebody else.
--
-- Friendships are stored once, not twice, with the pair ordered so that
-- (a, b) and (b, a) are the same row. Two rows per friendship is the usual way
-- these tables end up half-deleted.

-- ---------------------------------------------------------------------------
-- Blocks
-- ---------------------------------------------------------------------------
-- `are_friends(p_a, p_b)` already exists and orders the pair with
-- least/greatest; it is reused rather than redefined. Re-creating it here with
-- different parameter names fails outright ("cannot change name of input
-- parameter"), which is a useful reminder that a function's parameter names are
-- part of its signature.

create or replace function public.is_blocked_between(p_a uuid, p_b uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  -- Either direction. A block is not a request to be ignored politely; neither
  -- party may act on the other afterwards.
  select exists (
    select 1 from public.blocks
    where (blocker_id = p_a and blocked_id = p_b)
       or (blocker_id = p_b and blocked_id = p_a)
  );
$$;

-- ---------------------------------------------------------------------------
-- Search
-- ---------------------------------------------------------------------------

create or replace function public.search_players(p_query text)
returns table (
  id uuid,
  username text,
  display_name text,
  level integer,
  relationship text
)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_me uuid := auth.uid();
  v_q  text := lower(btrim(coalesce(p_query, '')));
begin
  if v_me is null then
    raise exception 'searching requires an authenticated session' using errcode = '42501';
  end if;

  -- A one-character query would return most of the table; make the caller be
  -- specific rather than paging through everybody.
  if length(v_q) < 2 then
    return;
  end if;

  return query
  select p.id,
         p.username::text,
         p.display_name,
         p.level,
         case
           when public.are_friends(v_me, p.id) then 'friends'
           when exists (select 1 from public.friend_requests r
                        where r.sender_id = v_me and r.receiver_id = p.id and r.status = 'pending')
             then 'outgoing_pending'
           when exists (select 1 from public.friend_requests r
                        where r.sender_id = p.id and r.receiver_id = v_me and r.status = 'pending')
             then 'incoming_pending'
           else 'none'
         end
  from public.profiles p
  where p.id <> v_me
    -- Blocked people do not appear in search at all, in either direction.
    and not public.is_blocked_between(v_me, p.id)
    and (p.username::text like v_q || '%' or lower(p.display_name) like '%' || v_q || '%')
  order by
    -- Exact handle first, then prefix matches, then display-name matches.
    (p.username::text = v_q) desc,
    (p.username::text like v_q || '%') desc,
    p.username
  limit 25;
end;
$$;

-- ---------------------------------------------------------------------------
-- Requests
-- ---------------------------------------------------------------------------

create or replace function public.send_friend_request(p_to uuid)
returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_me uuid := auth.uid();
begin
  if v_me is null then
    raise exception 'sending a request requires an authenticated session' using errcode = '42501';
  end if;
  if p_to = v_me then
    raise exception 'you cannot add yourself' using errcode = 'P0001';
  end if;
  if not exists (select 1 from public.profiles where id = p_to) then
    raise exception 'no such player' using errcode = 'P0002';
  end if;
  if public.is_blocked_between(v_me, p_to) then
    -- Deliberately the same wording a missing account would produce. Telling an
    -- attacker "you are blocked" confirms the account exists and who blocked
    -- them; the specification asks for no free-text contact for this reason.
    raise exception 'no such player' using errcode = 'P0002';
  end if;

  if public.are_friends(v_me, p_to) then
    return 'friends';
  end if;

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
  v_me uuid := auth.uid();
begin
  if v_me is null then
    raise exception 'accepting requires an authenticated session' using errcode = '42501';
  end if;
  if public.is_blocked_between(v_me, p_from) then
    raise exception 'no such player' using errcode = 'P0002';
  end if;

  update public.friend_requests
  set status = 'accepted', responded_at = now()
  where sender_id = p_from and receiver_id = v_me and status = 'pending';

  if not found and not public.are_friends(v_me, p_from) then
    raise exception 'there is no pending request from that player' using errcode = 'P0002';
  end if;

  -- Any request pointing the other way is settled by the same acceptance.
  update public.friend_requests
  set status = 'accepted', responded_at = now()
  where sender_id = v_me and receiver_id = p_from and status = 'pending';

  insert into public.friendships (user_id_a, user_id_b)
  values (least(v_me, p_from), greatest(v_me, p_from))
  on conflict do nothing;

  return 'friends';
end;
$$;

create or replace function public.decline_friend_request(p_from uuid)
returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_me uuid := auth.uid();
begin
  if v_me is null then
    raise exception 'declining requires an authenticated session' using errcode = '42501';
  end if;

  update public.friend_requests
  set status = 'declined', responded_at = now()
  where sender_id = p_from and receiver_id = v_me and status = 'pending';

  -- Declining something already gone is not an error: the button may have been
  -- tapped twice, or the sender may have withdrawn it first.
  return 'none';
end;
$$;

create or replace function public.remove_friend(p_other uuid)
returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_me uuid := auth.uid();
begin
  if v_me is null then
    raise exception 'removing requires an authenticated session' using errcode = '42501';
  end if;

  delete from public.friendships
  where user_id_a = least(v_me, p_other) and user_id_b = greatest(v_me, p_other);

  -- Old accepted rows would otherwise make a future request look like a replay.
  delete from public.friend_requests
  where (sender_id = v_me and receiver_id = p_other)
     or (sender_id = p_other and receiver_id = v_me);

  return 'none';
end;
$$;

create or replace function public.block_player(p_other uuid)
returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_me uuid := auth.uid();
begin
  if v_me is null then
    raise exception 'blocking requires an authenticated session' using errcode = '42501';
  end if;
  if p_other = v_me then
    raise exception 'you cannot block yourself' using errcode = 'P0001';
  end if;

  -- Blocking implies removing: a block that left the friendship in place would
  -- leave the blocked player still able to see them in a friend list.
  perform public.remove_friend(p_other);

  insert into public.blocks (blocker_id, blocked_id)
  values (v_me, p_other)
  on conflict do nothing;

  return 'blocked';
end;
$$;

create or replace function public.unblock_player(p_other uuid)
returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_me uuid := auth.uid();
begin
  if v_me is null then
    raise exception 'unblocking requires an authenticated session' using errcode = '42501';
  end if;

  delete from public.blocks where blocker_id = v_me and blocked_id = p_other;
  -- Unblocking restores nothing. They are strangers again, not friends.
  return 'none';
end;
$$;

-- ---------------------------------------------------------------------------
-- Reading your own graph
-- ---------------------------------------------------------------------------

create or replace function public.list_friends()
returns table (
  id uuid,
  username text,
  display_name text,
  level integer,
  last_seen_at timestamptz
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
    raise exception 'listing friends requires an authenticated session' using errcode = '42501';
  end if;

  return query
  select p.id, p.username::text, p.display_name, p.level, p.last_seen_at
  from public.friendships f
  join public.profiles p
    on p.id = case when f.user_id_a = v_me then f.user_id_b else f.user_id_a end
  where v_me in (f.user_id_a, f.user_id_b)
  order by p.display_name;
end;
$$;

create or replace function public.list_friend_requests()
returns table (
  direction text,
  other_id uuid,
  username text,
  display_name text,
  created_at timestamptz
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
    raise exception 'listing requests requires an authenticated session' using errcode = '42501';
  end if;

  return query
  select case when r.receiver_id = v_me then 'incoming' else 'outgoing' end,
         case when r.receiver_id = v_me then r.sender_id else r.receiver_id end,
         p.username::text, p.display_name, r.created_at
  from public.friend_requests r
  join public.profiles p
    on p.id = case when r.receiver_id = v_me then r.sender_id else r.receiver_id end
  where r.status = 'pending'
    and v_me in (r.sender_id, r.receiver_id)
    and not public.is_blocked_between(v_me, p.id)
  order by r.created_at desc;
end;
$$;

-- ---------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------
-- Every function derives the caller from the session, so a signed-in player may
-- execute them all; none can be pointed at a third party's relationships.

revoke execute on function
  public.search_players(text),
  public.send_friend_request(uuid),
  public.accept_friend_request(uuid),
  public.decline_friend_request(uuid),
  public.remove_friend(uuid),
  public.block_player(uuid),
  public.unblock_player(uuid),
  public.list_friends(),
  public.list_friend_requests(),
  public.is_blocked_between(uuid, uuid)
from public, anon;

grant execute on function
  public.search_players(text),
  public.send_friend_request(uuid),
  public.accept_friend_request(uuid),
  public.decline_friend_request(uuid),
  public.remove_friend(uuid),
  public.block_player(uuid),
  public.unblock_player(uuid),
  public.list_friends(),
  public.list_friend_requests()
to authenticated;
