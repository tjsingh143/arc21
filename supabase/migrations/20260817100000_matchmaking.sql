-- Public matchmaking: a queue, and seats allocated from it.
--
-- The economic difference from a private table is the whole point of this file.
-- A private table's chips belong to the table and cannot reach a wallet. A
-- PUBLIC table is the opposite: the seat is funded by a real buy-in debited from
-- the global wallet, and the remainder is credited back on a safe leave.
--
-- So this file allocates seats and nothing else. It does not move a single
-- chip. The buy-in stays where it already is — `apply_wallet_delta`, called from
-- the session Edge Function, which locks the wallet, honours an idempotency key
-- and has been attacked from five directions. Adding a second chip-moving path
-- here would double the surface for no benefit.

do $$ begin
  create type public.queue_status as enum ('waiting', 'matched', 'cancelled', 'expired');
exception when duplicate_object then null; end $$;

-- Public tables are stakes-segregated; private ones are not, so this is
-- nullable rather than defaulted. A private room carrying a tier would imply
-- its chips came from a wallet, and they never do.
alter table public.rooms add column if not exists tier public.table_tier;

comment on column public.rooms.tier is
  'Stakes for a public table. NULL for private tables, whose chips are the '
  'table''s own and never come from a wallet.';

create table if not exists public.matchmaking_queue (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references auth.users (id) on delete cascade,
  tier         public.table_tier not null,
  status       public.queue_status not null default 'waiting',
  -- Set when a seat is found, so the client can be told where to go.
  room_id      uuid references public.rooms (id),
  enqueued_at  timestamptz not null default now(),
  matched_at   timestamptz,
  -- A queue entry is not immortal: a client that vanishes must not hold a place
  -- forever and make a table look busier than it is.
  expires_at   timestamptz not null default now() + interval '5 minutes'
);

-- One live entry per player. Without this, tapping twice queues twice and the
-- allocator seats the same person into two seats at the same table.
create unique index if not exists matchmaking_queue_one_live_per_user
  on public.matchmaking_queue (user_id)
  where status = 'waiting';

create index if not exists matchmaking_queue_tier_idx
  on public.matchmaking_queue (tier, status, enqueued_at);

alter table public.matchmaking_queue enable row level security;

-- A player may watch their own place in the queue and nothing else. The queue
-- is not a directory of who is playing what.
drop policy if exists matchmaking_queue_select_own on public.matchmaking_queue;
create policy matchmaking_queue_select_own on public.matchmaking_queue
  for select using (user_id = auth.uid());

grant select on public.matchmaking_queue to authenticated;

comment on table public.matchmaking_queue is
  'Players waiting for a public seat. Allocates seats only — chips move through '
  'apply_wallet_delta in the session function, never from here.';

-- ---------------------------------------------------------------------------
-- Housekeeping
-- ---------------------------------------------------------------------------

create or replace function public.expire_stale_queue_entries()
returns int
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_count int;
begin
  update public.matchmaking_queue
  set status = 'expired'
  where status = 'waiting' and expires_at < now();

  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

-- ---------------------------------------------------------------------------
-- Joining and leaving the queue
-- ---------------------------------------------------------------------------

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
begin
  if v_me is null then
    raise exception 'matchmaking requires an authenticated session' using errcode = '42501';
  end if;

  perform public.expire_stale_queue_entries();

  -- The tier's unlock level is checked here AND again when the seat is funded.
  -- This one is a courtesy so a player is not queued into a table they cannot
  -- sit at; the one that matters is the one next to the money.
  select level into v_level from public.profiles where id = v_me;
  if p_tier = 'high' and coalesce(v_level, 1) < 10 then
    raise exception 'the high table unlocks at level 10' using errcode = 'P0001';
  end if;

  -- Re-queueing is not an error: it is what a client does after a reconnect.
  select * into v_entry
  from public.matchmaking_queue
  where user_id = v_me and status = 'waiting';

  if found then
    if v_entry.tier <> p_tier then
      -- Changing your mind about the stakes cancels the old wait rather than
      -- leaving a player queued for two tables at once.
      update public.matchmaking_queue set status = 'cancelled'
      where id = v_entry.id;
    else
      return v_entry;
    end if;
  end if;

  insert into public.matchmaking_queue (user_id, tier)
  values (v_me, p_tier)
  returning * into v_entry;

  return v_entry;
end;
$$;

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

  update public.matchmaking_queue
  set status = 'cancelled'
  where user_id = v_me and status = 'waiting';
end;
$$;

-- ---------------------------------------------------------------------------
-- Allocation
-- ---------------------------------------------------------------------------

create or replace function public.poll_matchmaking()
returns table (
  status public.queue_status,
  tier public.table_tier,
  room_id uuid,
  room_code text,
  waiting_since timestamptz,
  queued_at_tier int
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
#variable_conflict use_column
declare
  v_me     uuid := auth.uid();
  v_entry  public.matchmaking_queue;
  v_room   public.rooms;
  v_seated int;
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

  -- Already seated: report where, and stop. Re-allocating would move a player
  -- who may already have paid a buy-in.
  if v_entry.status = 'matched' then
    select * into v_room from public.rooms where id = v_entry.room_id;
    return query select v_entry.status, v_entry.tier, v_entry.room_id, v_room.code,
                        v_entry.enqueued_at, 0;
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

  -- Oldest first, so tables fill rather than spreading everyone thin.
  select r.* into v_room
  from public.rooms r
  where r.visibility = 'public'
    and r.mode = 'public_table'
    and r.status = 'lobby'
    and r.tier = v_entry.tier
    and (
      select count(*) from public.room_members m
      where m.room_id = r.id and m.status = 'joined'
    ) < r.max_seats
  order by r.created_at
  limit 1;

  if not found then
    -- No table to join, so this player starts one and waits in it. They are the
    -- host by accident of arriving first; the host owns nothing but the lobby.
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
                      v_entry.enqueued_at, v_seated;
end;
$$;

revoke execute on function
  public.join_matchmaking(public.table_tier),
  public.leave_matchmaking(),
  public.poll_matchmaking(),
  public.expire_stale_queue_entries()
from public, anon;

grant execute on function
  public.join_matchmaking(public.table_tier),
  public.leave_matchmaking(),
  public.poll_matchmaking()
to authenticated;
