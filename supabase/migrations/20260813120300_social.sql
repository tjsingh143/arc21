-- =============================================================================
-- Arc 21 — 0300 Friends, friendships and blocks
--
-- A friend request is readable by exactly two people: the sender and the
-- receiver. Nobody else — not a friend of either, not another table
-- participant — can see that it exists.
--
-- Friendship rows are never written directly by a client. Accepting a request
-- is a status change on a row you received; the friendship it produces is
-- created by a SECURITY DEFINER trigger, so the edge cannot be forged by
-- writing the friendship table directly.
-- =============================================================================

create table public.friend_requests (
  id           uuid primary key default gen_random_uuid(),
  sender_id    uuid not null references public.profiles (id) on delete cascade,
  receiver_id  uuid not null references public.profiles (id) on delete cascade,
  status       public.friend_request_status not null default 'pending',
  created_at   timestamptz not null default now(),
  responded_at timestamptz,

  constraint friend_requests_not_self check (sender_id <> receiver_id)
);

comment on table public.friend_requests is
  'Readable only by the sender and the receiver.';

-- At most one live request per ordered pair; history of resolved ones is kept.
create unique index friend_requests_one_pending_idx
  on public.friend_requests (sender_id, receiver_id)
  where status = 'pending';

create index friend_requests_receiver_idx
  on public.friend_requests (receiver_id, status);
create index friend_requests_sender_idx
  on public.friend_requests (sender_id, status);

-- -----------------------------------------------------------------------------
-- Friendships — one row per pair, canonically ordered so the edge is unique
-- -----------------------------------------------------------------------------

create table public.friendships (
  id         uuid primary key default gen_random_uuid(),
  user_id_a  uuid not null references public.profiles (id) on delete cascade,
  user_id_b  uuid not null references public.profiles (id) on delete cascade,
  created_at timestamptz not null default now(),

  constraint friendships_canonical_order check (user_id_a < user_id_b),
  constraint friendships_unique_pair unique (user_id_a, user_id_b)
);

comment on table public.friendships is
  'Undirected friend edge, stored once with user_id_a < user_id_b. Created only by server code.';

create index friendships_user_b_idx on public.friendships (user_id_b);

-- -----------------------------------------------------------------------------
-- Blocks
-- -----------------------------------------------------------------------------

create table public.blocks (
  id         uuid primary key default gen_random_uuid(),
  blocker_id uuid not null references public.profiles (id) on delete cascade,
  blocked_id uuid not null references public.profiles (id) on delete cascade,
  created_at timestamptz not null default now(),

  constraint blocks_not_self check (blocker_id <> blocked_id),
  constraint blocks_unique_pair unique (blocker_id, blocked_id)
);

comment on table public.blocks is
  'Directed block. Readable only by the blocker: a blocked user is never told.';

create index blocks_blocked_idx on public.blocks (blocked_id);

-- -----------------------------------------------------------------------------
-- Relationship predicates
--
-- SECURITY DEFINER so a policy can consult them without recursing into the
-- policies of the table being consulted.
--
-- These two take an arbitrary pair of account ids, which is exactly what makes
-- them dangerous to expose. RLS policy expressions are evaluated as the
-- *invoking* role, so a policy that calls a function needs the client role to
-- hold EXECUTE on it — and a function that is executable by `authenticated` is
-- a PostgREST RPC endpoint (`POST /rest/v1/rpc/has_blocked`). Granting these
-- to `authenticated` therefore handed every client a queryable oracle over the
-- whole social graph: any pair, in either direction, with the caller involved
-- in neither. That defeats the RLS on `friendships` and `blocks` completely.
--
-- They are consequently server-only. The client-reachable predicates are the
-- caller-scoped wrappers below, which take only the counterparty and derive
-- the viewer from `auth.uid()`, exactly as `is_session_participant` does.
-- -----------------------------------------------------------------------------

create or replace function public.are_friends(p_a uuid, p_b uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select p_a is not null
     and p_b is not null
     and exists (
           select 1
           from public.friendships f
           where f.user_id_a = least(p_a, p_b)
             and f.user_id_b = greatest(p_a, p_b)
         );
$$;

create or replace function public.has_blocked(p_blocker uuid, p_blocked uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select p_blocker is not null
     and p_blocked is not null
     and exists (
           select 1
           from public.blocks b
           where b.blocker_id = p_blocker
             and b.blocked_id = p_blocked
         );
$$;

-- Server-only. These take an arbitrary pair and must never be client-callable:
-- EXECUTE for `authenticated` makes them a PostgREST RPC oracle over the whole
-- social graph (POST /rest/v1/rpc/has_blocked with any two ids), which defeats
-- the RLS on `friendships` and `blocks` entirely.
revoke execute on function public.are_friends(uuid, uuid) from public;
revoke execute on function public.has_blocked(uuid, uuid) from public;
revoke execute on function public.are_friends(uuid, uuid) from authenticated;
revoke execute on function public.has_blocked(uuid, uuid) from authenticated;

-- -----------------------------------------------------------------------------
-- Caller-scoped predicates — the only social helpers a client may execute.
--
-- Each derives the viewer from auth.uid() and takes only the counterparty, so
-- there is no pair to probe: a client can only ever ask about its own
-- relationships. RLS policy expressions are evaluated as the invoking role, so
-- policies call these rather than the two-argument functions above.
-- -----------------------------------------------------------------------------

create or replace function public.viewer_has_blocked(p_other uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select public.has_blocked((select auth.uid()), p_other);
$$;

create or replace function public.viewer_is_blocked_by(p_other uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select public.has_blocked(p_other, (select auth.uid()));
$$;

create or replace function public.viewer_is_friend_of(p_other uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select public.are_friends((select auth.uid()), p_other);
$$;

revoke execute on function public.viewer_has_blocked(uuid) from public;
revoke execute on function public.viewer_is_blocked_by(uuid) from public;
revoke execute on function public.viewer_is_friend_of(uuid) from public;
grant execute on function public.viewer_has_blocked(uuid) to authenticated;
grant execute on function public.viewer_is_blocked_by(uuid) to authenticated;
grant execute on function public.viewer_is_friend_of(uuid) to authenticated;

-- -----------------------------------------------------------------------------
-- Request lifecycle guards
-- -----------------------------------------------------------------------------

create or replace function public.guard_friend_request_transition()
returns trigger
language plpgsql
as $$
begin
  if not public.is_client_role() then
    return new;
  end if;

  if old.status <> 'pending' then
    raise exception 'friend request has already been resolved' using errcode = '42501';
  end if;

  if new.sender_id is distinct from old.sender_id
     or new.receiver_id is distinct from old.receiver_id then
    raise exception 'friend request participants are immutable' using errcode = '42501';
  end if;

  if new.status = 'cancelled' then
    if auth.uid() <> old.sender_id then
      raise exception 'only the sender may cancel a friend request' using errcode = '42501';
    end if;
  elsif new.status in ('accepted', 'declined') then
    if auth.uid() <> old.receiver_id then
      raise exception 'only the receiver may accept or decline a friend request'
        using errcode = '42501';
    end if;
  else
    raise exception 'unsupported friend request transition' using errcode = '42501';
  end if;

  new.responded_at := now();
  return new;
end;
$$;

-- Accepting a request is what creates the friendship. The client never writes
-- the friendships table itself.
create or replace function public.create_friendship_on_accept()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.status = 'accepted' and old.status is distinct from 'accepted' then
    insert into public.friendships (user_id_a, user_id_b)
    values (
      least(new.sender_id, new.receiver_id),
      greatest(new.sender_id, new.receiver_id)
    )
    on conflict on constraint friendships_unique_pair do nothing;
  end if;
  return new;
end;
$$;

-- Blocking severs the relationship in both directions and withdraws anything
-- still pending, so a block cannot be undone by an in-flight request.
create or replace function public.apply_block_side_effects()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  delete from public.friendships
  where user_id_a = least(new.blocker_id, new.blocked_id)
    and user_id_b = greatest(new.blocker_id, new.blocked_id);

  update public.friend_requests
  set status = 'cancelled', responded_at = now()
  where status = 'pending'
    and (
      (sender_id = new.blocker_id and receiver_id = new.blocked_id)
      or (sender_id = new.blocked_id and receiver_id = new.blocker_id)
    );

  return new;
end;
$$;

revoke execute on function public.guard_friend_request_transition() from public;
revoke execute on function public.create_friendship_on_accept() from public;
revoke execute on function public.apply_block_side_effects() from public;

create trigger friend_requests_guard_transition
  before update on public.friend_requests
  for each row execute function public.guard_friend_request_transition();

create trigger friend_requests_create_friendship
  after update on public.friend_requests
  for each row execute function public.create_friendship_on_accept();

create trigger blocks_apply_side_effects
  after insert on public.blocks
  for each row execute function public.apply_block_side_effects();

-- -----------------------------------------------------------------------------
-- Privileges
-- -----------------------------------------------------------------------------

revoke all on table public.friend_requests from anon, authenticated;
revoke all on table public.friendships from anon, authenticated;
revoke all on table public.blocks from anon, authenticated;

grant select, insert on table public.friend_requests to authenticated;
grant update (status) on table public.friend_requests to authenticated;

grant select, delete on table public.friendships to authenticated;
grant select, insert, delete on table public.blocks to authenticated;

-- -----------------------------------------------------------------------------
-- Row Level Security
-- -----------------------------------------------------------------------------

alter table public.friend_requests enable row level security;
alter table public.friendships enable row level security;
alter table public.blocks enable row level security;

create policy friend_requests_select_participants
  on public.friend_requests for select
  to authenticated
  using (
    sender_id = (select auth.uid())
    or receiver_id = (select auth.uid())
  );

create policy friend_requests_insert_as_sender
  on public.friend_requests for insert
  to authenticated
  with check (
    sender_id = (select auth.uid())
    and receiver_id <> (select auth.uid())
    and status = 'pending'
    and not public.viewer_is_blocked_by(receiver_id)
    and not public.viewer_has_blocked(receiver_id)
    and not public.viewer_is_friend_of(receiver_id)
  );

create policy friend_requests_update_participants
  on public.friend_requests for update
  to authenticated
  using (
    sender_id = (select auth.uid())
    or receiver_id = (select auth.uid())
  )
  with check (
    sender_id = (select auth.uid())
    or receiver_id = (select auth.uid())
  );

create policy friendships_select_own
  on public.friendships for select
  to authenticated
  using (
    user_id_a = (select auth.uid())
    or user_id_b = (select auth.uid())
  );

create policy friendships_delete_own
  on public.friendships for delete
  to authenticated
  using (
    user_id_a = (select auth.uid())
    or user_id_b = (select auth.uid())
  );

create policy blocks_select_own
  on public.blocks for select
  to authenticated
  using (blocker_id = (select auth.uid()));

create policy blocks_insert_own
  on public.blocks for insert
  to authenticated
  with check (blocker_id = (select auth.uid()));

create policy blocks_delete_own
  on public.blocks for delete
  to authenticated
  using (blocker_id = (select auth.uid()));

-- -----------------------------------------------------------------------------
-- Profile visibility, now that friendships and blocks exist
-- -----------------------------------------------------------------------------

create policy profiles_select_visible
  on public.profiles for select
  to authenticated
  using (
    id <> (select auth.uid())
    and privacy <> 'private'
    and not public.viewer_is_blocked_by(id)
    and not public.viewer_has_blocked(id)
    and (
      privacy = 'public'
      or public.viewer_is_friend_of(id)
    )
  );
