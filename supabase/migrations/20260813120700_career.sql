-- =============================================================================
-- Arc 21 — 0700 Career
--
-- 18 nodes across three chapters. The node catalogue is public; a player's
-- progress through it is private to them and entirely server-written.
--
-- `reward_ledger_id` links a claimed reward to the exact ledger row that paid
-- it. Combined with the ledger's unique idempotency key, that makes "claim a
-- prize twice" a constraint violation rather than a race to be reasoned about.
-- =============================================================================

create table public.career_nodes (
  id                 uuid primary key default gen_random_uuid(),

  code               text not null unique check (code ~ '^[a-z0-9-]{3,40}$'),
  chapter            public.career_chapter not null,
  chapter_order      integer not null check (chapter_order between 1 and 10),
  node_order         integer not null check (node_order between 1 and 20),

  title              text not null check (char_length(title) between 1 and 60),
  summary            text not null check (char_length(summary) between 1 and 240),

  -- Declarative goal, interpreted server-side. Example:
  --   {"type": "reach_chips", "target": 3000, "maxHands": 25}
  objective          jsonb not null,

  ruleset_id         uuid not null references public.rulesets (id),
  tier               public.table_tier not null default 'casual',
  starting_chips     bigint not null check (starting_chips > 0),

  reward_chips       bigint not null default 0 check (reward_chips >= 0),
  reward_xp          integer not null default 0 check (reward_xp >= 0),
  reward_cosmetic_id uuid,

  requires_node_id   uuid references public.career_nodes (id) on delete set null,

  is_active          boolean not null default true,
  created_at         timestamptz not null default now(),

  constraint career_nodes_unique_position unique (chapter, node_order),
  constraint career_nodes_objective_has_type check (objective ? 'type'),
  constraint career_nodes_not_self_gated check (requires_node_id is distinct from id)
);

comment on table public.career_nodes is
  'Public catalogue of career objectives. Written by seed data and migrations only.';

create index career_nodes_chapter_idx
  on public.career_nodes (chapter_order, node_order);

create trigger career_nodes_deny_client_write
  before insert or update or delete on public.career_nodes
  for each row execute function public.deny_client_write();

-- -----------------------------------------------------------------------------
-- Progress
-- -----------------------------------------------------------------------------

create table public.career_progress (
  id                 uuid primary key default gen_random_uuid(),
  user_id            uuid not null references public.profiles (id) on delete cascade,
  career_node_id     uuid not null references public.career_nodes (id) on delete cascade,

  status             public.career_status not null default 'locked',
  stars              integer not null default 0 check (stars between 0 and 3),
  best_score         bigint not null default 0 check (best_score >= 0),
  attempts           integer not null default 0 check (attempts >= 0),

  first_completed_at timestamptz,
  reward_claimed_at  timestamptz,

  -- The ledger row that paid this node's chip reward, if any.
  reward_ledger_id   uuid references public.wallet_ledger (id) on delete set null,

  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),

  constraint career_progress_unique unique (user_id, career_node_id),
  constraint career_progress_completed_has_timestamp check (
    status <> 'completed' or first_completed_at is not null
  ),
  constraint career_progress_stars_require_completion check (
    stars = 0 or status = 'completed'
  ),
  constraint career_progress_reward_requires_completion check (
    reward_claimed_at is null or status = 'completed'
  ),
  constraint career_progress_ledger_requires_claim check (
    reward_ledger_id is null or reward_claimed_at is not null
  )
);

comment on table public.career_progress is
  'Per-user career progress. Readable by its owner; every write, including reward payment, is server-controlled.';

create index career_progress_user_idx on public.career_progress (user_id);

create trigger career_progress_set_updated_at
  before update on public.career_progress
  for each row execute function public.set_updated_at();

create trigger career_progress_deny_client_write
  before insert or update or delete on public.career_progress
  for each row execute function public.deny_client_write();

-- -----------------------------------------------------------------------------
-- Privileges and Row Level Security
-- -----------------------------------------------------------------------------

revoke all on table public.career_nodes from anon, authenticated;
revoke all on table public.career_progress from anon, authenticated;

grant select on table public.career_nodes to anon, authenticated;
grant select on table public.career_progress to authenticated;

alter table public.career_nodes enable row level security;
alter table public.career_progress enable row level security;

create policy career_nodes_select_active
  on public.career_nodes for select
  to anon, authenticated
  using (is_active);

create policy career_progress_select_own
  on public.career_progress for select
  to authenticated
  using (user_id = (select auth.uid()));

-- No INSERT / UPDATE / DELETE policy: rewards are server-controlled.
