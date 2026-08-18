-- Private tables: rooms, seats, and the code you share with a friend.
--
-- THE ECONOMIC INVARIANT, first because everything else bends around it:
-- a private table NEVER touches the global wallet. Seats start on a fixed
-- session stack and nothing moves in or out. This is not a simplification —
-- it is the anti-collusion design. If friends could carry chips between a
-- private table and their wallets, two accounts could transfer a bankroll by
-- agreeing to lose, and every leaderboard downstream would be meaningless.
--
-- So there is no buy-in, no cash-out and no ledger entry anywhere in this file.
-- A room that mishandles chips cannot exist, because it has no way to reach
-- them.

-- Postgres has no CREATE TYPE IF NOT EXISTS, and a migration that cannot be
-- re-applied is one that blocks the next `db reset` half way through.
do $$ begin
  create type public.room_status as enum ('lobby', 'active', 'finishing', 'closed', 'expired');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.room_member_status as enum ('joined', 'left', 'kicked', 'disconnected');
exception when duplicate_object then null; end $$;

-- ---------------------------------------------------------------------------
-- Room codes
-- ---------------------------------------------------------------------------
-- Six characters from a 32-symbol alphabet with O/0 and I/1 removed, because a
-- code is read aloud and typed by hand. That is 32^6 ≈ 1.07 billion — sparse
-- enough that guessing is impractical against the small number of live rooms,
-- which is what actually matters here rather than raw entropy.

create or replace function public.generate_room_code()
returns text
language plpgsql
volatile
as $$
declare
  v_alphabet constant text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  v_code text;
  v_try  int := 0;
begin
  loop
    v_code := '';
    for i in 1..6 loop
      -- gen_random_bytes is the CSPRNG; random() would make live codes
      -- predictable from one observed code.
      v_code := v_code || substr(
        v_alphabet,
        1 + (get_byte(extensions.gen_random_bytes(1), 0) % length(v_alphabet)),
        1
      );
    end loop;

    exit when not exists (
      select 1 from public.rooms
      where code = v_code and status in ('lobby', 'active', 'finishing')
    );

    v_try := v_try + 1;
    if v_try > 50 then
      raise exception 'could not allocate a room code';
    end if;
  end loop;

  return v_code;
end;
$$;

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

create table if not exists public.rooms (
  id             uuid primary key default gen_random_uuid(),
  code           text not null,
  host_user_id   uuid not null references auth.users (id) on delete cascade,
  visibility     text not null default 'private' check (visibility in ('private', 'public')),
  mode           text not null default 'private_table',
  ruleset_id     uuid references public.rulesets (id),
  max_seats      int  not null default 5 check (max_seats between 2 and 5),
  status         public.room_status not null default 'lobby',
  game_session_id uuid references public.game_sessions (id),
  created_at     timestamptz not null default now(),
  expires_at     timestamptz not null default now() + interval '30 minutes'
);

-- A code only has to be unique among rooms someone could still join. Retiring
-- rooms release their codes, which keeps six characters viable indefinitely.
create unique index if not exists rooms_live_code_key
  on public.rooms (code)
  where status in ('lobby', 'active', 'finishing');

create table if not exists public.room_members (
  id           uuid primary key default gen_random_uuid(),
  room_id      uuid not null references public.rooms (id) on delete cascade,
  user_id      uuid not null references auth.users (id) on delete cascade,
  seat_index   int  not null check (seat_index >= 0),
  status       public.room_member_status not null default 'joined',
  is_ready     boolean not null default false,
  joined_at    timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  unique (room_id, user_id),
  unique (room_id, seat_index)
);

create index if not exists room_members_room_idx on public.room_members (room_id);
create index if not exists rooms_host_idx on public.rooms (host_user_id);

alter table public.rooms enable row level security;
alter table public.room_members enable row level security;

-- Membership is checked through a SECURITY DEFINER function rather than a
-- subquery inside the policy.
--
-- A policy on `room_members` that itself selects from `room_members` recurses:
-- Postgres evaluates the policy to answer the subquery, which evaluates the
-- policy again, and the whole thing dies with "infinite recursion detected in
-- policy". The function runs as its owner, so its lookup is not re-filtered.
-- Answers only about the CALLER. It takes no user id on purpose: a policy
-- helper that accepts one is executable by any signed-in player and becomes an
-- oracle for "is this person at that table", which is nobody else's business.
create or replace function public.caller_is_room_member(p_room_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1 from public.room_members
    where room_id = p_room_id and user_id = auth.uid() and status = 'joined'
  );
$$;

-- Members read their own room. There is deliberately no policy allowing a room
-- to be found by code through a plain select: joining goes through
-- `join_private_room`, so a client cannot enumerate live codes with a range
-- query.
drop policy if exists rooms_select_member on public.rooms;
create policy rooms_select_member on public.rooms
  for select using (public.caller_is_room_member(rooms.id));

drop policy if exists room_members_select_same_room on public.room_members;
create policy room_members_select_same_room on public.room_members
  for select using (public.caller_is_room_member(room_members.room_id));

grant select on public.rooms to authenticated;
grant select on public.room_members to authenticated;

comment on table public.rooms is
  'Private tables. No wallet movement is possible from here — seats use a fixed '
  'session stack, which is the anti-collusion rule, not a shortcut.';

-- ---------------------------------------------------------------------------
-- Creating, joining, leaving
-- ---------------------------------------------------------------------------

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

  -- One live room per host. Without this a player could spawn rooms endlessly,
  -- and every one of them would hold a code.
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

  -- Codes are typed by hand: fold case and drop spaces before matching, so a
  -- player who types "abc def" is not told their code is wrong.
  select * into v_room
  from public.rooms
  where code = upper(regexp_replace(coalesce(p_code, ''), '\s', '', 'g'))
    and status in ('lobby', 'active')
  -- Lock the room so two people taking the last seat cannot both succeed.
  for update;

  if not found then
    raise exception 'that table is not available' using errcode = 'P0002';
  end if;
  if v_room.expires_at < now() then
    raise exception 'that table is no longer available' using errcode = 'P0002';
  end if;
  if public.is_blocked_between(v_me, v_room.host_user_id) then
    raise exception 'that table is not available' using errcode = 'P0002';
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

  if v_taken >= v_room.max_seats then
    raise exception 'that table is full' using errcode = 'P0001';
  end if;

  -- Lowest free seat, so leaving and rejoining does not scatter people across
  -- the table.
  select coalesce(min(s), 0) into v_seat
  from generate_series(0, v_room.max_seats - 1) s
  where s not in (
    select seat_index from public.room_members
    where room_id = v_room.id and status = 'joined'
  );

  insert into public.room_members (room_id, user_id, seat_index)
  values (v_room.id, v_me, v_seat)
  on conflict (room_id, user_id) do update
    set status = 'joined', last_seen_at = now();

  return v_room;
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
    raise exception 'you are not at that table' using errcode = 'P0002';
  end if;
end;
$$;

create or replace function public.leave_room(p_room_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_me       uuid := auth.uid();
  v_room     public.rooms;
  v_next     uuid;
  v_remaining int;
begin
  if v_me is null then
    raise exception 'this requires an authenticated session' using errcode = '42501';
  end if;

  select * into v_room from public.rooms where id = p_room_id for update;
  if not found then return; end if;

  update public.room_members
  set status = 'left', is_ready = false
  where room_id = p_room_id and user_id = v_me;

  select count(*) into v_remaining
  from public.room_members
  where room_id = p_room_id and status = 'joined';

  if v_remaining = 0 then
    update public.rooms set status = 'closed' where id = p_room_id;
    return;
  end if;

  -- Host migration. The host owns the invite and the lobby, never the dealer or
  -- the shoe — those are the server's — so handing the role over cannot change
  -- how a hand plays out. Longest-connected member takes it.
  if v_room.host_user_id = v_me then
    select user_id into v_next
    from public.room_members
    where room_id = p_room_id and status = 'joined'
    order by joined_at
    limit 1;

    update public.rooms set host_user_id = v_next where id = p_room_id;
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- Reading a room
-- ---------------------------------------------------------------------------

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
    raise exception 'you are not at that table' using errcode = 'P0002';
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

-- ---------------------------------------------------------------------------
-- Housekeeping
-- ---------------------------------------------------------------------------

create or replace function public.expire_stale_rooms()
returns int
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_count int;
begin
  -- Safe to run at any time and from anywhere: a private room holds no escrow,
  -- so expiring one can never strand chips. The equivalent for a public table
  -- must reconcile stacks first and is deliberately not written here.
  update public.rooms
  set status = 'expired'
  where status = 'lobby' and expires_at < now();

  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

revoke execute on function
  public.create_private_room(int),
  public.join_private_room(text),
  public.set_room_ready(uuid, boolean),
  public.leave_room(uuid),
  public.get_room_state(uuid),
  public.generate_room_code(),
  public.expire_stale_rooms()
from public, anon;

grant execute on function
  public.create_private_room(int),
  public.join_private_room(text),
  public.set_room_ready(uuid, boolean),
  public.leave_room(uuid),
  public.get_room_state(uuid),
  public.caller_is_room_member(uuid)
to authenticated;
