-- =============================================================================
-- Arc 21 — 0900 Daily challenge
--
-- Every player faces the identical shoe, produced by `CounterStreamRandomSource`
-- from a secret seed. That makes the seed exactly as dangerous as the shoe
-- itself: knowing it while the challenge is live means knowing every card.
--
-- `seed_secret` is therefore protected the same way the private engine state is,
-- by removing the privilege rather than by filtering rows:
--
--   * `authenticated` holds a column-level SELECT grant that lists every column
--     EXCEPT `seed_secret`. `select seed_secret from daily_challenges` is
--     rejected by the privilege system, and so is `select *`.
--   * `public.daily_challenges_public` is the view clients actually read. It is
--     `security_invoker`, so the row policy below still applies to it.
--   * `seed_commitment` — the published SHA-256 of the secret — is readable from
--     the moment the challenge opens, so a player can verify after the fact that
--     the shoe was fixed before play began. A trigger proves the commitment
--     genuinely matches the stored secret; a commitment nobody checks is theatre.
--   * `revealed_seed` may only be written once `closes_at` has passed.
-- =============================================================================

create table public.daily_challenges (
  id                uuid primary key default gen_random_uuid(),
  challenge_date    date not null unique,

  ruleset_id        uuid not null references public.rulesets (id),

  -- SERVER ONLY. Never granted to any API role. See the grants below.
  seed_secret       text not null check (char_length(seed_secret) between 32 and 256),

  -- Published SHA-256 (hex) of seed_secret. Safe to read.
  seed_commitment   text not null check (seed_commitment ~ '^[0-9a-f]{64}$'),

  -- Populated only after the challenge closes, for public verification.
  revealed_seed     text,
  seed_revealed_at  timestamptz,

  hand_count        integer not null check (hand_count between 1 and 100),
  starting_chips    bigint not null check (starting_chips > 0),
  tier              public.table_tier not null default 'standard',

  reward_chips      bigint not null default 0 check (reward_chips >= 0),
  reward_xp         integer not null default 0 check (reward_xp >= 0),

  opens_at          timestamptz not null,
  closes_at         timestamptz not null,

  created_at        timestamptz not null default now(),

  constraint daily_challenges_window check (closes_at > opens_at),
  constraint daily_challenges_reveal_is_paired check (
    (revealed_seed is null and seed_revealed_at is null)
    or (revealed_seed is not null and seed_revealed_at is not null)
  )
);

comment on table public.daily_challenges is
  'One challenge per date. seed_secret is server-only; seed_commitment is the published SHA-256 that makes the shoe verifiable after the fact.';
comment on column public.daily_challenges.seed_secret is
  'SERVER ONLY. Excluded from every client GRANT. Never log this value.';
comment on column public.daily_challenges.seed_commitment is
  'SHA-256 (hex) of seed_secret, published when the challenge opens.';

create index daily_challenges_window_idx on public.daily_challenges (opens_at, closes_at);

-- The commitment must actually commit to the stored secret, and the reveal may
-- not happen early.
create or replace function public.guard_daily_challenge_seed()
returns trigger
language plpgsql
set search_path = public, extensions, pg_temp
as $$
begin
  if encode(extensions.digest(new.seed_secret, 'sha256'), 'hex') <> new.seed_commitment then
    raise exception 'seed_commitment is not the SHA-256 of seed_secret'
      using errcode = '23514';
  end if;

  if new.revealed_seed is not null then
    if now() < new.closes_at then
      raise exception 'daily challenge seed may not be revealed before closes_at'
        using errcode = '42501';
    end if;
    if new.revealed_seed <> new.seed_secret then
      raise exception 'revealed_seed does not match seed_secret'
        using errcode = '23514';
    end if;
  end if;

  return new;
end;
$$;

revoke execute on function public.guard_daily_challenge_seed() from public;

create trigger daily_challenges_guard_seed
  before insert or update on public.daily_challenges
  for each row execute function public.guard_daily_challenge_seed();

create trigger daily_challenges_deny_client_write
  before insert or update or delete on public.daily_challenges
  for each row execute function public.deny_client_write();

-- -----------------------------------------------------------------------------
-- Entries
-- -----------------------------------------------------------------------------

create table public.daily_entries (
  id                  uuid primary key default gen_random_uuid(),
  daily_challenge_id  uuid not null references public.daily_challenges (id) on delete cascade,
  user_id             uuid not null references public.profiles (id) on delete cascade,
  game_session_id     uuid references public.game_sessions (id) on delete set null,

  status              public.daily_entry_status not null default 'in_progress',

  hands_played        integer not null default 0 check (hands_played >= 0),
  final_chips         bigint not null default 0 check (final_chips >= 0),
  score               bigint not null default 0,

  reward_ledger_id    uuid references public.wallet_ledger (id) on delete set null,

  started_at          timestamptz not null default now(),
  completed_at        timestamptz,

  constraint daily_entries_one_per_user unique (daily_challenge_id, user_id),
  constraint daily_entries_completed_has_timestamp check (
    status <> 'completed' or completed_at is not null
  )
);

comment on table public.daily_entries is
  'One attempt per user per challenge. Readable only by its owner; leaderboards are published as server-produced, public-safe output.';

create index daily_entries_leaderboard_idx
  on public.daily_entries (daily_challenge_id, score desc);
create index daily_entries_user_idx on public.daily_entries (user_id);

create trigger daily_entries_deny_client_write
  before insert or update or delete on public.daily_entries
  for each row execute function public.deny_client_write();

-- Close the reference left open in 0500.
alter table public.game_sessions
  add constraint game_sessions_daily_challenge_fk
  foreign key (daily_challenge_id) references public.daily_challenges (id) on delete set null;

-- -----------------------------------------------------------------------------
-- Privileges
-- -----------------------------------------------------------------------------

revoke all on table public.daily_challenges from anon, authenticated;
revoke all on table public.daily_entries from anon, authenticated;

-- Column-level SELECT. `seed_secret` is deliberately absent, so neither
-- `select seed_secret` nor `select *` is permitted.
grant select (
  id,
  challenge_date,
  ruleset_id,
  seed_commitment,
  revealed_seed,
  seed_revealed_at,
  hand_count,
  starting_chips,
  tier,
  reward_chips,
  reward_xp,
  opens_at,
  closes_at,
  created_at
) on table public.daily_challenges to authenticated;

grant select on table public.daily_entries to authenticated;

-- -----------------------------------------------------------------------------
-- Row Level Security
-- -----------------------------------------------------------------------------

alter table public.daily_challenges enable row level security;
alter table public.daily_entries enable row level security;

create policy daily_challenges_select_open
  on public.daily_challenges for select
  to authenticated
  using (opens_at <= now());

create policy daily_entries_select_own
  on public.daily_entries for select
  to authenticated
  using (user_id = (select auth.uid()));

-- -----------------------------------------------------------------------------
-- The shape clients actually read
-- -----------------------------------------------------------------------------

create view public.daily_challenges_public
with (security_invoker = true) as
select
  id,
  challenge_date,
  ruleset_id,
  seed_commitment,
  revealed_seed,
  seed_revealed_at,
  hand_count,
  starting_chips,
  tier,
  reward_chips,
  reward_xp,
  opens_at,
  closes_at
from public.daily_challenges;

comment on view public.daily_challenges_public is
  'Client-facing projection of daily_challenges with seed_secret absent. security_invoker, so the row policy still applies.';

revoke all on table public.daily_challenges_public from anon, authenticated;
grant select on table public.daily_challenges_public to authenticated;
