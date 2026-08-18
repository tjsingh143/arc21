-- =============================================================================
-- Arc 21 — 0800 Tournaments
--
-- Brackets, standings and placements are public; every write is server-side.
-- Registration is not a client INSERT because it is an economic command: the
-- entry fee debit and the entry row must commit together or not at all.
--
-- `entry_ledger_id` / `prize_ledger_id` tie each entry to the ledger rows that
-- moved chips for it, so "claim a prize twice" is caught by the ledger's unique
-- idempotency key rather than by hopeful application logic.
-- =============================================================================

create table public.tournaments (
  id                     uuid primary key default gen_random_uuid(),

  code                   text not null unique check (code ~ '^[a-z0-9-]{3,40}$'),
  name                   text not null check (char_length(name) between 1 and 60),
  description            text check (char_length(description) <= 500),

  format                 public.tournament_format not null,
  status                 public.tournament_status not null default 'scheduled',

  ruleset_id             uuid not null references public.rulesets (id),
  tier                   public.table_tier not null default 'standard',

  entry_fee_chips        bigint not null default 0 check (entry_fee_chips >= 0),
  starting_chips         bigint not null check (starting_chips > 0),

  min_entries            integer not null default 2 check (min_entries >= 2),
  max_entries            integer not null check (max_entries between 2 and 1024),

  -- [{ "placement": 1, "chips": 25000, "xp": 500 }, ...]
  prize_structure        jsonb not null default '[]'::jsonb,

  registration_opens_at  timestamptz not null,
  starts_at              timestamptz not null,
  ends_at                timestamptz,

  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),

  constraint tournaments_entry_window check (registration_opens_at <= starts_at),
  constraint tournaments_entry_bounds check (min_entries <= max_entries),
  constraint tournaments_prize_structure_is_array
    check (jsonb_typeof(prize_structure) = 'array')
);

comment on table public.tournaments is
  'Public tournament catalogue. Server-written.';

create index tournaments_status_idx on public.tournaments (status, starts_at);

create trigger tournaments_set_updated_at
  before update on public.tournaments
  for each row execute function public.set_updated_at();

create trigger tournaments_deny_client_write
  before insert or update or delete on public.tournaments
  for each row execute function public.deny_client_write();

-- -----------------------------------------------------------------------------
-- Entries
-- -----------------------------------------------------------------------------

create table public.tournament_entries (
  id               uuid primary key default gen_random_uuid(),
  tournament_id    uuid not null references public.tournaments (id) on delete cascade,
  user_id          uuid not null references public.profiles (id) on delete cascade,

  status           public.tournament_entry_status not null default 'registered',

  -- Bracket position, not an RNG seed. Arc 21 stores no per-tournament shuffle
  -- secret: every match shoe comes from the production CSPRNG.
  bracket_seed     integer check (bracket_seed is null or bracket_seed > 0),

  chips            bigint not null default 0 check (chips >= 0),
  score            bigint not null default 0,
  placement        integer check (placement is null or placement > 0),

  entry_ledger_id  uuid references public.wallet_ledger (id) on delete set null,
  prize_ledger_id  uuid references public.wallet_ledger (id) on delete set null,

  registered_at    timestamptz not null default now(),
  eliminated_at    timestamptz,

  constraint tournament_entries_unique_user unique (tournament_id, user_id),
  constraint tournament_entries_placement_requires_finish check (
    placement is null or status in ('eliminated', 'withdrawn', 'active')
  )
);

comment on table public.tournament_entries is
  'Registrations and standings. Publicly readable; created only by the server so the entry fee and the entry commit together.';

create unique index tournament_entries_unique_bracket_seed_idx
  on public.tournament_entries (tournament_id, bracket_seed)
  where bracket_seed is not null;

create index tournament_entries_user_idx on public.tournament_entries (user_id);
create index tournament_entries_standings_idx
  on public.tournament_entries (tournament_id, score desc);

create trigger tournament_entries_deny_client_write
  before insert or update or delete on public.tournament_entries
  for each row execute function public.deny_client_write();

-- -----------------------------------------------------------------------------
-- Matches
-- -----------------------------------------------------------------------------

create table public.tournament_matches (
  id               uuid primary key default gen_random_uuid(),
  tournament_id    uuid not null references public.tournaments (id) on delete cascade,

  round            integer not null check (round > 0),
  match_index      integer not null check (match_index >= 0),

  entry_a_id       uuid references public.tournament_entries (id) on delete set null,
  entry_b_id       uuid references public.tournament_entries (id) on delete set null,
  winner_entry_id  uuid references public.tournament_entries (id) on delete set null,

  game_session_id  uuid references public.game_sessions (id) on delete set null,

  status           public.tournament_match_status not null default 'pending',

  scheduled_at     timestamptz,
  started_at       timestamptz,
  completed_at     timestamptz,

  constraint tournament_matches_unique_slot unique (tournament_id, round, match_index),
  constraint tournament_matches_distinct_entries check (
    entry_a_id is null or entry_b_id is null or entry_a_id <> entry_b_id
  ),
  constraint tournament_matches_winner_played check (
    winner_entry_id is null
    or winner_entry_id = entry_a_id
    or winner_entry_id = entry_b_id
  ),
  constraint tournament_matches_completed_has_winner check (
    status <> 'completed' or winner_entry_id is not null
  )
);

comment on table public.tournament_matches is
  'Bracket slots. A winner must be one of the two entries in the slot.';

create index tournament_matches_tournament_idx
  on public.tournament_matches (tournament_id, round, match_index);

create trigger tournament_matches_deny_client_write
  before insert or update or delete on public.tournament_matches
  for each row execute function public.deny_client_write();

-- Now that tournaments exist, close the reference left open in 0500.
alter table public.game_sessions
  add constraint game_sessions_tournament_fk
  foreign key (tournament_id) references public.tournaments (id) on delete set null;

-- -----------------------------------------------------------------------------
-- Privileges and Row Level Security
-- -----------------------------------------------------------------------------

revoke all on table public.tournaments from anon, authenticated;
revoke all on table public.tournament_entries from anon, authenticated;
revoke all on table public.tournament_matches from anon, authenticated;

grant select on table public.tournaments to anon, authenticated;
grant select on table public.tournament_entries to authenticated;
grant select on table public.tournament_matches to authenticated;

alter table public.tournaments enable row level security;
alter table public.tournament_entries enable row level security;
alter table public.tournament_matches enable row level security;

-- Caller-scoped, like the social predicates: takes only the tournament and
-- derives the viewer from auth.uid(), so it cannot be used to probe whether
-- some other account is entered in something.
create or replace function public.viewer_is_in_tournament(p_tournament_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1
    from public.tournament_entries e
    where e.tournament_id = p_tournament_id
      and e.user_id = (select auth.uid())
  );
$$;

revoke execute on function public.viewer_is_in_tournament(uuid) from public;
grant execute on function public.viewer_is_in_tournament(uuid) to authenticated;

create policy tournaments_select_all
  on public.tournaments for select
  to anon, authenticated
  using (status <> 'cancelled');

-- `user_id` IS an auth identifier — it is the `auth.users` id — so a blanket
-- `using (true)` published every competitor's account UUID to every client,
-- including users whose profile privacy is `private` and users who had blocked
-- the requester. SECURITY.md forbids exposing account identifiers, and the
-- profile RLS this bypassed is the whole point of that setting.
--
-- Three ways to see an entry, in order of specificity:
--   1. it is yours;
--   2. you are in the same tournament — competitors must see each other's
--      stacks and placements, which is load-bearing for tournament strategy;
--   3. the entrant's profile is visible to you anyway.
--
-- Clause 3 delegates to the profiles policies by selecting from the table:
-- nested access is evaluated as the invoking role, so a hidden profile yields
-- no row and the entry stays hidden. Visibility rules therefore live in exactly
-- one place instead of being restated (and drifting) here.
create policy tournament_entries_select_visible
  on public.tournament_entries for select
  to authenticated
  using (
    user_id = (select auth.uid())
    or public.viewer_is_in_tournament(tournament_id)
    or exists (
      select 1
      from public.profiles p
      where p.id = tournament_entries.user_id
    )
  );

-- A match row is a bracket edge whose endpoints are entry ids, so it leaks only
-- as much as the entries it points at. Visible to participants and to anyone who
-- can see at least one of its endpoints.
create policy tournament_matches_select_visible
  on public.tournament_matches for select
  to authenticated
  using (
    public.viewer_is_in_tournament(tournament_id)
    or exists (
      select 1
      from public.tournament_entries e
      where e.id in (tournament_matches.entry_a_id, tournament_matches.entry_b_id)
    )
  );
