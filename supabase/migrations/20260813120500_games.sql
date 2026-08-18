-- =============================================================================
-- Arc 21 — 0500 Game sessions, seats, events, and the private engine state
--
-- THIS FILE CONTAINS THE MOST SECURITY-CRITICAL OBJECT IN THE DATABASE.
--
-- `private.game_state_private` holds the serialised `BlackjackGameState`: the
-- undealt shoe in order, and the dealer's hole card before reveal. Anyone who
-- can read one row of it can win every hand for the rest of the shoe.
--
-- Four independent barriers stand in front of it:
--
--   1. It lives in the `private` schema, which is not listed in
--      `[api] schemas` in config.toml, so PostgREST will not route to it at all.
--   2. The schema carries no USAGE grant for anon, authenticated or
--      service_role — only postgres.
--   3. The table carries no privileges for those roles either.
--   4. RLS is enabled with no policies, so even a role that somehow reached it
--      would match zero rows.
--
-- What clients receive instead is `public.game_events`, which stores only
-- payloads that have already passed through `toPublicState` in
-- shared/blackjack/public-state.ts. Nothing writes a raw engine state here.
-- =============================================================================

create table public.game_sessions (
  id                  uuid primary key default gen_random_uuid(),
  mode                public.game_mode not null,
  ruleset_id          uuid not null references public.rulesets (id),
  tier                public.table_tier,

  host_user_id        uuid references public.profiles (id) on delete set null,

  -- Six characters from an alphabet with no visually ambiguous glyphs:
  -- no O/0 and no I/1. A room code is an address, never an authorisation.
  room_code           text unique check (room_code ~ '^[A-HJ-NP-Z2-9]{6}$'),

  status              public.game_session_status not null default 'lobby',
  max_seats           integer not null default 5 check (max_seats between 1 and 7),

  -- Mirrors BlackjackGameState.version. Monotonic; one increment per accepted command.
  version             bigint not null default 0 check (version >= 0),
  hand_number         integer not null default 0 check (hand_number >= 0),
  shuffle_number      integer not null default 0 check (shuffle_number >= 0),

  -- Absolute server deadline. Clients render countdowns against it; only the
  -- server's clock authorises the transition.
  deadline_at         timestamptz,

  -- Chips currently held in seat stacks, debited from wallets at buy-in. A room
  -- may not be deleted while this is non-zero.
  escrow_chips        bigint not null default 0 check (escrow_chips >= 0),

  -- Populated in the tournament and daily-challenge migrations.
  tournament_id       uuid,
  daily_challenge_id  uuid,

  created_at          timestamptz not null default now(),
  started_at          timestamptz,
  ended_at            timestamptz,

  constraint game_sessions_ended_after_started
    check (ended_at is null or started_at is null or ended_at >= started_at),
  constraint game_sessions_completed_has_end
    check (status <> 'completed' or ended_at is not null)
);

comment on table public.game_sessions is
  'One table/room. Public, sanitised metadata only; the authoritative engine state lives in private.game_state_private.';
comment on column public.game_sessions.escrow_chips is
  'Chips held in seat stacks. A session row may not be deleted while this is non-zero.';

create index game_sessions_status_idx on public.game_sessions (status, mode);
create index game_sessions_host_idx on public.game_sessions (host_user_id);

create trigger game_sessions_deny_client_write
  before insert or update or delete on public.game_sessions
  for each row execute function public.deny_client_write();

-- "A room row is never deleted while wallet escrow remains unreconciled."
create or replace function public.guard_session_escrow_on_delete()
returns trigger
language plpgsql
as $$
begin
  if old.escrow_chips <> 0 then
    raise exception
      'game session % still holds % chips in escrow; reconcile before deleting',
      old.id, old.escrow_chips
      using errcode = '23514';
  end if;
  return old;
end;
$$;

revoke execute on function public.guard_session_escrow_on_delete() from public;

create trigger game_sessions_guard_escrow
  before delete on public.game_sessions
  for each row execute function public.guard_session_escrow_on_delete();

-- -----------------------------------------------------------------------------
-- Seats — the membership table every game-scoped RLS policy consults
-- -----------------------------------------------------------------------------

create table public.game_session_seats (
  id               uuid primary key default gen_random_uuid(),
  game_session_id  uuid not null references public.game_sessions (id) on delete cascade,
  seat_index       integer not null check (seat_index between 0 and 6),

  -- Null for an unoccupied or non-account seat.
  user_id          uuid references public.profiles (id) on delete set null,
  display_name     text not null check (char_length(display_name) between 1 and 24),

  -- Chips at the table, debited from the wallet at buy-in. Server-owned.
  stack            bigint not null default 0 check (stack >= 0),
  buy_in           bigint not null default 0 check (buy_in >= 0),

  status           public.seat_status not null default 'active',
  connected        boolean not null default true,
  disconnected_at  timestamptz,

  joined_at        timestamptz not null default now(),
  left_at          timestamptz,

  constraint game_session_seats_unique_index unique (game_session_id, seat_index)
);

comment on table public.game_session_seats is
  'Seat occupancy and table stack. Membership source for every game-scoped RLS policy.';

-- One active seat per user per game. A second device may watch, never race.
create unique index game_session_seats_one_per_user_idx
  on public.game_session_seats (game_session_id, user_id)
  where user_id is not null and status <> 'left';

create index game_session_seats_user_idx on public.game_session_seats (user_id);

create trigger game_session_seats_deny_client_write
  before insert or update or delete on public.game_session_seats
  for each row execute function public.deny_client_write();

-- -----------------------------------------------------------------------------
-- Participation predicate
--
-- SECURITY DEFINER: the seats table's own policy calls this, and a plain
-- function would recurse into that policy forever.
-- -----------------------------------------------------------------------------

create or replace function public.is_session_participant(p_game_session_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1
    from public.game_session_seats s
    where s.game_session_id = p_game_session_id
      and s.user_id = auth.uid()
  );
$$;

comment on function public.is_session_participant(uuid) is
  'True when the calling user holds a seat in the given session. Used by every game-scoped policy.';

revoke execute on function public.is_session_participant(uuid) from public;
grant execute on function public.is_session_participant(uuid) to authenticated;

-- -----------------------------------------------------------------------------
-- Public event log
--
-- Every row here has already been through the sanitisation boundary. A payload
-- containing an undealt card or an unrevealed hole card is a defect, not a
-- configuration choice.
-- -----------------------------------------------------------------------------

create table public.game_events (
  id                 uuid primary key default gen_random_uuid(),
  game_session_id    uuid not null references public.game_sessions (id) on delete cascade,

  -- Monotonic per session. Clients track lastAppliedSeq and refetch on a gap.
  seq                bigint not null check (seq > 0),

  -- EngineEvent["type"] from shared/blackjack/types.ts.
  type               text not null check (char_length(type) between 1 and 64),

  -- Sanitised public payload only. Produced by toPublicState.
  payload            jsonb not null default '{}'::jsonb,

  visibility         public.event_visibility not null default 'public',
  recipient_user_id  uuid references public.profiles (id) on delete cascade,

  -- BlackjackGameState.version this event was emitted at.
  state_version      bigint not null default 0 check (state_version >= 0),
  hand_number        integer not null default 0 check (hand_number >= 0),

  created_at         timestamptz not null default now(),

  constraint game_events_seq_unique unique (game_session_id, seq),
  constraint game_events_recipient_matches_visibility check (
    (visibility = 'public' and recipient_user_id is null)
    or (visibility = 'seat' and recipient_user_id is not null)
  )
);

comment on table public.game_events is
  'Append-only, sanitised event stream. Participants read public rows; a seat-scoped row is readable only by its recipient.';
comment on column public.game_events.payload is
  'Sanitised output of toPublicState only. Never a raw BlackjackGameState.';

create index game_events_session_seq_idx on public.game_events (game_session_id, seq);
create index game_events_recipient_idx on public.game_events (recipient_user_id)
  where recipient_user_id is not null;

create trigger game_events_deny_client_write
  before insert or update or delete on public.game_events
  for each row execute function public.deny_client_write();

-- =============================================================================
-- THE SERVER-ONLY ENGINE STATE
-- =============================================================================

create table private.game_state_private (
  game_session_id uuid primary key
                    references public.game_sessions (id) on delete cascade,

  -- The complete BlackjackGameState: shoe order, nextIndex, dealer hole card.
  engine_state    jsonb not null,

  -- Must equal game_sessions.version after every accepted command.
  version         bigint not null default 0 check (version >= 0),

  updated_at      timestamptz not null default now()
);

comment on table private.game_state_private is
  'Authoritative BlackjackGameState including future shoe order and the dealer hole card. No API role has any privilege on this table or on the schema that contains it.';

create trigger game_state_private_set_updated_at
  before update on private.game_state_private
  for each row execute function public.set_updated_at();

-- Barrier 3: no table privileges for any API role.
revoke all on table private.game_state_private from public;
revoke all on table private.game_state_private from anon, authenticated, service_role;

-- Barrier 4: RLS on with zero policies. postgres and service_role carry
-- BYPASSRLS, so this costs the server nothing and denies everyone else.
alter table private.game_state_private enable row level security;

-- -----------------------------------------------------------------------------
-- Privileges and Row Level Security for the public game tables
-- -----------------------------------------------------------------------------

revoke all on table public.game_sessions from anon, authenticated;
revoke all on table public.game_session_seats from anon, authenticated;
revoke all on table public.game_events from anon, authenticated;

grant select on table public.game_sessions to authenticated;
grant select on table public.game_session_seats to authenticated;
grant select on table public.game_events to authenticated;

alter table public.game_sessions enable row level security;
alter table public.game_session_seats enable row level security;
alter table public.game_events enable row level security;

create policy game_sessions_select_participant
  on public.game_sessions for select
  to authenticated
  using (public.is_session_participant(id));

create policy game_session_seats_select_participant
  on public.game_session_seats for select
  to authenticated
  using (public.is_session_participant(game_session_id));

create policy game_events_select_participant
  on public.game_events for select
  to authenticated
  using (
    public.is_session_participant(game_session_id)
    and (
      visibility = 'public'
      or recipient_user_id = (select auth.uid())
    )
  );

-- No INSERT / UPDATE / DELETE policy on any of the three: every write is a
-- server command running as postgres or service_role.
