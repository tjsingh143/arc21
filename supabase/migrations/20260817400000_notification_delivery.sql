-- =============================================================================
-- Arc 21 — 1400 Notification delivery
--
-- The tables have existed since 1100 and nothing has ever written a row. This
-- file is the writer, the delivery record and the read surface.
--
-- Three rules shape it.
--
-- 1. A notification is SERVER-WRITTEN. `notify_user` is revoked from every
--    client role, so a modified client cannot post itself a "tournament
--    starting" or forge one from a stranger. The only thing a client may change
--    on a notification is `read_at`, and that is now enforced by comparing the
--    whole row rather than by listing columns — the old guard named six columns,
--    and every column added after it would have been silently writable.
--
-- 2. A payload carries DEEP-LINK PARAMETERS AND NOTHING ELSE. `data` is checked
--    against a key allowlist with short scalar values, so a daily-challenge
--    seed, a shoe order or a hole card cannot ride out through a push message
--    even by accident. The 1100 migration stated that in a comment; a comment is
--    not a constraint.
--
-- 3. DELIVERY IS RECORDED HONESTLY. Without APNs/FCM credentials nothing is
--    actually pushed, and marking those rows "sent" would make the sender
--    untestable and the audit trail a lie. They are marked `mocked`, and
--    `sent_at` stays null unless a real push left the building.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Delivery state
-- -----------------------------------------------------------------------------

create type public.notification_delivery as enum (
  -- Written, not yet drained by the sender.
  'pending',
  -- Handed to Expo and accepted for delivery.
  'sent',
  -- A development build with no push credentials. Deliberately distinct from
  -- 'sent': nothing left the server.
  'mocked',
  -- Nobody to push to. The player has not granted permission, or has no device
  -- registered for this kind. Not a failure.
  'no_device',
  -- Expo rejected it, or the token is dead. The in-app row still stands.
  'failed'
);

comment on type public.notification_delivery is
  'How a notification was delivered. `mocked` means no push credentials existed and nothing was actually sent.';

-- -----------------------------------------------------------------------------
-- Payload safety
-- -----------------------------------------------------------------------------

-- True when `data` carries only deep-link parameters.
--
-- Keys are an allowlist and values must be short scalars, which is what makes
-- "a seed can never ride in a payload" a property of the schema rather than a
-- promise in a comment. A shoe is an array; an array fails here.
create or replace function public.notification_data_is_safe(p_data jsonb)
returns boolean
language sql
immutable
as $$
  select case
    when p_data is null then false
    when jsonb_typeof(p_data) <> 'object' then false
    else coalesce((
      select bool_and(
               e.key = any (array[
                 'room_code',
                 'tournament_id',
                 'game_id',
                 'entry_id',
                 'challenge_date',
                 'from_user_id',
                 'from_display_name',
                 'placement'
               ])
               and jsonb_typeof(e.value) in ('string', 'number')
               and length(e.value #>> '{}') <= 64
             )
      from jsonb_each(p_data) e
    ), true)
  end;
$$;

comment on function public.notification_data_is_safe(jsonb) is
  'Deep-link parameters only: allowlisted keys, short scalar values. Rejects arrays and nested objects, which is how a shoe or a seed would have to travel.';

-- -----------------------------------------------------------------------------
-- Columns
-- -----------------------------------------------------------------------------

alter table public.notifications
  add column delivery public.notification_delivery not null default 'pending',
  add column delivery_detail text check (delivery_detail is null or char_length(delivery_detail) <= 200),
  -- Collapses repeats. Inviting the same friend to the same table twice is one
  -- notification, not two, and a reconnect loop cannot flood a device.
  add column dedupe_key text check (dedupe_key is null or char_length(dedupe_key) <= 200),
  add constraint notifications_data_is_deep_link_only
    check (public.notification_data_is_safe(data));

create unique index notifications_dedupe_idx
  on public.notifications (user_id, dedupe_key)
  where dedupe_key is not null;

create index notifications_pending_idx
  on public.notifications (created_at)
  where delivery = 'pending';

comment on column public.notifications.dedupe_key is
  'Collapses repeats for one user. Null means every write is its own notification.';

-- Which kinds this DEVICE wants pushed.
--
-- Device-scoped rather than account-scoped on purpose: the phone in a pocket and
-- the tablet on a shelf reasonably want different things, and the toggles the
-- player sees in Settings are stored on the device that owns them.
alter table public.push_tokens
  add column allowed_kinds public.notification_kind[] not null default '{}';

comment on column public.push_tokens.allowed_kinds is
  'Per-device kind allowlist, mirroring the Settings toggles. Empty means this device is registered but wants nothing pushed.';

-- -----------------------------------------------------------------------------
-- The client update guard, rewritten
-- -----------------------------------------------------------------------------

-- Only `read_at` may change, and that is now expressed as "nothing else may
-- change" instead of a list of six columns. The list version was already stale:
-- `delivery`, `delivery_detail` and `dedupe_key` above would all have been
-- writable by a client through the existing UPDATE policy, and the next column
-- would have been too.
create or replace function public.guard_notification_client_update()
returns trigger
language plpgsql
as $$
begin
  if public.is_client_role() then
    if (to_jsonb(new) - 'read_at') is distinct from (to_jsonb(old) - 'read_at') then
      raise exception 'only read_at may be changed on a notification'
        using errcode = '42501';
    end if;
  end if;
  return new;
end;
$$;

revoke execute on function public.guard_notification_client_update() from public;

-- -----------------------------------------------------------------------------
-- Writing a notification
-- -----------------------------------------------------------------------------

-- The single writer. Server-only: revoked from anon and authenticated, called
-- from SECURITY DEFINER routines and from the Edge Functions as `postgres`.
--
-- Returns the notification id, or null when the write was collapsed into an
-- existing row by `p_dedupe_key`. A caller that needs to know whether it created
-- something can test for null; nothing needs to, today.
create or replace function public.notify_user(
  p_user_id    uuid,
  p_kind       public.notification_kind,
  p_title      text,
  p_body       text,
  p_data       jsonb default '{}'::jsonb,
  p_dedupe_key text default null
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_id uuid;
begin
  if p_user_id is null then
    raise exception 'a notification needs a recipient' using errcode = 'P0001';
  end if;
  if not public.notification_data_is_safe(coalesce(p_data, '{}'::jsonb)) then
    -- Raised rather than stripped. A caller trying to attach something that is
    -- not a deep-link parameter has a bug worth seeing, and quietly dropping the
    -- key would hide it.
    raise exception 'notification data may carry deep-link parameters only'
      using errcode = 'P0001';
  end if;

  insert into public.notifications (user_id, kind, title, body, data, dedupe_key)
  values (p_user_id, p_kind, p_title, p_body, coalesce(p_data, '{}'::jsonb), p_dedupe_key)
  on conflict (user_id, dedupe_key) where dedupe_key is not null
    do nothing
  returning id into v_id;

  return v_id;
end;
$$;

revoke execute on function
  public.notify_user(uuid, public.notification_kind, text, text, jsonb, text)
from public, anon, authenticated;

comment on function public.notify_user(uuid, public.notification_kind, text, text, jsonb, text) is
  'The only writer of notifications. Server-only: a client cannot post itself a notification or forge one from another player.';

-- -----------------------------------------------------------------------------
-- Push token registration
-- -----------------------------------------------------------------------------

-- A device registers itself and says which kinds it wants.
--
-- The token is the identity of the device, not of the account: a phone handed to
-- somebody else re-registers under the new session, and the row moves with it
-- rather than pushing the first account's notifications to the second's screen.
create or replace function public.register_push_token(
  p_token     text,
  p_platform  public.push_platform,
  p_device_id text default null,
  p_kinds     public.notification_kind[] default '{}'
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_me uuid := auth.uid();
begin
  if v_me is null then
    raise exception 'registering a device requires an authenticated session' using errcode = '42501';
  end if;
  if p_token is null or char_length(p_token) < 8 or char_length(p_token) > 512 then
    raise exception 'that does not look like a push token' using errcode = 'P0001';
  end if;

  insert into public.push_tokens (user_id, token, platform, device_id, allowed_kinds, is_active)
  values (v_me, p_token, p_platform, p_device_id, coalesce(p_kinds, '{}'), true)
  on conflict (token) do update
    set user_id       = v_me,
        platform      = excluded.platform,
        device_id     = excluded.device_id,
        allowed_kinds = excluded.allowed_kinds,
        is_active     = true,
        last_used_at  = now();
end;
$$;

-- Turning notifications off, or signing out. The row is deactivated rather than
-- deleted so a re-grant does not have to wait for a fresh token from the OS.
create or replace function public.retire_push_token(p_token text)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_me uuid := auth.uid();
begin
  if v_me is null then
    raise exception 'retiring a device requires an authenticated session' using errcode = '42501';
  end if;

  update public.push_tokens
  set is_active = false, allowed_kinds = '{}', last_used_at = now()
  where user_id = v_me and token = p_token;
end;
$$;

revoke execute on function
  public.register_push_token(text, public.push_platform, text, public.notification_kind[]),
  public.retire_push_token(text)
from public, anon;

grant execute on function
  public.register_push_token(text, public.push_platform, text, public.notification_kind[]),
  public.retire_push_token(text)
to authenticated;

-- -----------------------------------------------------------------------------
-- Reading your own notifications
-- -----------------------------------------------------------------------------

create or replace function public.my_notifications(p_limit integer default 50)
returns table (
  id         uuid,
  kind       public.notification_kind,
  title      text,
  body       text,
  data       jsonb,
  read_at    timestamptz,
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
    raise exception 'reading notifications requires an authenticated session' using errcode = '42501';
  end if;

  return query
  select n.id, n.kind, n.title, n.body, n.data, n.read_at, n.created_at
  from public.notifications n
  where n.user_id = v_me
  order by n.created_at desc
  limit greatest(1, least(coalesce(p_limit, 50), 100));
end;
$$;

create or replace function public.unread_notification_count()
returns integer
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_me uuid := auth.uid();
begin
  if v_me is null then
    raise exception 'counting notifications requires an authenticated session' using errcode = '42501';
  end if;

  return (
    select count(*)::integer from public.notifications
    where user_id = v_me and read_at is null
  );
end;
$$;

create or replace function public.mark_notifications_read(p_ids uuid[] default null)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_me    uuid := auth.uid();
  v_count integer;
begin
  if v_me is null then
    raise exception 'marking read requires an authenticated session' using errcode = '42501';
  end if;

  -- A null id list means "everything", which is what the "Mark all read" control
  -- sends. It is scoped to the caller either way.
  update public.notifications
  set read_at = now()
  where user_id = v_me
    and read_at is null
    and (p_ids is null or id = any (p_ids));

  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

revoke execute on function
  public.my_notifications(integer),
  public.unread_notification_count(),
  public.mark_notifications_read(uuid[])
from public, anon;

grant execute on function
  public.my_notifications(integer),
  public.unread_notification_count(),
  public.mark_notifications_read(uuid[])
to authenticated;

-- -----------------------------------------------------------------------------
-- The sender's view
-- -----------------------------------------------------------------------------

-- What the push sender drains. Server-only.
--
-- One row per (notification, device): a player signed in on a phone and a tablet
-- gets one in-app notification and two push messages, which is what they would
-- expect. A notification whose recipient has no active device for that kind
-- returns no row at all and is closed out as `no_device` by the sender.
create or replace function public.pending_push_deliveries(p_limit integer default 100)
returns table (
  notification_id uuid,
  token           text,
  platform        public.push_platform,
  kind            public.notification_kind,
  title           text,
  body            text,
  data            jsonb
)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  return query
  select n.id, t.token, t.platform, n.kind, n.title, n.body, n.data
  from public.notifications n
  join public.push_tokens t
    on t.user_id = n.user_id
   and t.is_active
   and n.kind = any (t.allowed_kinds)
  where n.delivery = 'pending'
  order by n.created_at
  limit greatest(1, least(coalesce(p_limit, 100), 500));
end;
$$;

-- Notifications with nothing to push to. Split from the query above so the
-- sender can close them out without guessing at the difference between "no
-- device" and "not drained yet".
create or replace function public.pending_without_device(p_limit integer default 100)
returns setof uuid
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  return query
  select n.id
  from public.notifications n
  where n.delivery = 'pending'
    and not exists (
      select 1 from public.push_tokens t
      where t.user_id = n.user_id
        and t.is_active
        and n.kind = any (t.allowed_kinds)
    )
  order by n.created_at
  limit greatest(1, least(coalesce(p_limit, 100), 500));
end;
$$;

create or replace function public.record_push_delivery(
  p_id       uuid,
  p_delivery public.notification_delivery,
  p_detail   text default null
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  update public.notifications
  set delivery         = p_delivery,
      delivery_detail  = left(p_detail, 200),
      -- `sent_at` means a push was actually accepted by the push service. A
      -- mocked or device-less delivery leaves it null, so "how many pushes have
      -- we really sent" stays an answerable question.
      sent_at          = case when p_delivery = 'sent' then now() else sent_at end
  where id = p_id;
end;
$$;

-- A dead token reported by the push service. Retiring it is not the client's
-- job — the client has no way to know.
create or replace function public.deactivate_push_token(p_token text)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  update public.push_tokens
  set is_active = false
  where token = p_token;
end;
$$;

revoke execute on function
  public.pending_push_deliveries(integer),
  public.pending_without_device(integer),
  public.record_push_delivery(uuid, public.notification_delivery, text),
  public.deactivate_push_token(text)
from public, anon, authenticated;

-- -----------------------------------------------------------------------------
-- Inviting a friend to a private table
-- -----------------------------------------------------------------------------

-- The one notification a player can cause directly, so it is the one that needs
-- the most checking. All four hold:
--
--   * the caller is a joined member of a live room,
--   * the target is a confirmed friend — a room code is not a licence to message
--     strangers,
--   * neither has blocked the other,
--   * the same invite twice is one notification.
--
-- The room code travels in the payload because that is the deep link, and a code
-- alone is not authorisation: `join_private_room` re-checks membership, capacity,
-- expiry and blocks when the link is opened.
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
    raise exception 'no such player' using errcode = 'P0002';
  end if;
  if public.is_blocked_between(v_me, p_friend) then
    raise exception 'no such player' using errcode = 'P0002';
  end if;

  select * into v_room
  from public.rooms
  where id = p_room_id and status in ('lobby', 'active');

  if not found or v_room.expires_at < now() then
    raise exception 'that table is not available' using errcode = 'P0002';
  end if;

  if not exists (
    select 1 from public.room_members
    where room_id = p_room_id and user_id = v_me and status = 'joined'
  ) then
    raise exception 'you are not at that table' using errcode = 'P0002';
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

revoke execute on function public.invite_friend_to_room(uuid, uuid) from public, anon;
grant execute on function public.invite_friend_to_room(uuid, uuid) to authenticated;

-- -----------------------------------------------------------------------------
-- Friend graph notifications
-- -----------------------------------------------------------------------------

-- `send_friend_request` and `accept_friend_request` are replaced wholesale
-- rather than wrapped, because a trigger on `friend_requests` could not tell the
-- difference between the request path and the "they already asked us, so accept
-- instead" path — which must notify the other person that they are friends now,
-- not that they have a request waiting.
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

revoke execute on function
  public.send_friend_request(uuid),
  public.accept_friend_request(uuid)
from public, anon;

grant execute on function
  public.send_friend_request(uuid),
  public.accept_friend_request(uuid)
to authenticated;
