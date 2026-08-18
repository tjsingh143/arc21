-- =============================================================================
-- Arc 21 — 0600 Hand history
--
-- The auditable record of what was actually dealt. Written by the server at
-- settlement, never during play.
--
-- `hand_records.dealer_cards` is constrained so it can only be non-empty once
-- `completed_at` is set. A hand history table is exactly the sort of place a
-- hole card leaks from — an "archive" row written at deal time would publish
-- the dealer's down card to every participant before the peek. The constraint
-- makes that shape impossible to store rather than merely discouraged.
-- =============================================================================

create table public.hand_records (
  id                uuid primary key default gen_random_uuid(),
  game_session_id   uuid not null references public.game_sessions (id) on delete cascade,
  ruleset_id        uuid not null references public.rulesets (id),

  hand_number       integer not null check (hand_number > 0),
  shuffle_number    integer not null default 0 check (shuffle_number >= 0),

  -- Populated only at completion; see the CHECK below.
  dealer_cards      jsonb not null default '[]'::jsonb,
  dealer_total      integer check (dealer_total is null or dealer_total between 0 and 30),
  dealer_is_natural boolean not null default false,
  dealer_busted     boolean not null default false,

  started_at        timestamptz not null default now(),
  completed_at      timestamptz,

  constraint hand_records_unique_per_session unique (game_session_id, hand_number),

  -- No dealer card may be persisted before the hand is over.
  constraint hand_records_dealer_cards_only_when_complete check (
    completed_at is not null or dealer_cards = '[]'::jsonb
  ),
  constraint hand_records_totals_only_when_complete check (
    completed_at is not null or (dealer_total is null and not dealer_busted)
  )
);

comment on table public.hand_records is
  'Completed-hand archive. Dealer cards may only be stored once completed_at is set, so the hole card cannot leak through history.';

create index hand_records_session_idx
  on public.hand_records (game_session_id, hand_number desc);

create trigger hand_records_deny_client_write
  before insert or update or delete on public.hand_records
  for each row execute function public.deny_client_write();

-- -----------------------------------------------------------------------------
-- One row per settled player hand (a split produces several)
-- -----------------------------------------------------------------------------

create table public.hand_players (
  id                    uuid primary key default gen_random_uuid(),
  hand_record_id        uuid not null references public.hand_records (id) on delete cascade,

  -- Denormalised so participant policies do not need a join to the parent.
  game_session_id       uuid not null references public.game_sessions (id) on delete cascade,

  seat_id               uuid references public.game_session_seats (id) on delete set null,
  user_id               uuid references public.profiles (id) on delete set null,

  -- PlayerHand.id from the engine, and its ordinal within the seat.
  engine_hand_id        text not null check (char_length(engine_hand_id) between 1 and 64),
  hand_index            integer not null default 0 check (hand_index >= 0),

  cards                 jsonb not null default '[]'::jsonb,

  wager                 bigint not null check (wager >= 0),
  insurance_bet         bigint not null default 0 check (insurance_bet >= 0),
  insurance_decision    public.insurance_decision not null default 'NOT_OFFERED',
  insurance_credit      bigint not null default 0 check (insurance_credit >= 0),

  status                public.player_hand_status not null,
  outcome               public.hand_outcome_kind,

  -- HandOutcome.credit — chips returned to the seat stack. Never negative.
  credit                bigint not null default 0 check (credit >= 0),
  -- HandOutcome.net — credit minus wager. Enforced below, not trusted.
  net                   bigint not null default 0,

  best_total            integer check (best_total is null or best_total between 0 and 30),
  is_soft               boolean not null default false,
  is_natural            boolean not null default false,
  came_from_split       boolean not null default false,
  came_from_split_aces  boolean not null default false,

  created_at            timestamptz not null default now(),

  constraint hand_players_unique_engine_hand unique (hand_record_id, engine_hand_id),

  -- Settlement arithmetic is checked by the database, not asserted in a comment.
  constraint hand_players_net_is_credit_minus_wager check (net = credit - wager)
);

comment on table public.hand_players is
  'One settled player hand. net = credit - wager is a database constraint.';

create index hand_players_user_idx on public.hand_players (user_id, created_at desc);
create index hand_players_session_idx on public.hand_players (game_session_id);
create index hand_players_record_idx on public.hand_players (hand_record_id);

create trigger hand_players_deny_client_write
  before insert or update or delete on public.hand_players
  for each row execute function public.deny_client_write();

-- -----------------------------------------------------------------------------
-- Individual decisions, with strategy grading
--
-- A player's decision timing and accuracy are private. Other participants can
-- see the cards that were dealt; they cannot see how long you hesitated or
-- whether the solver disagreed with you.
-- -----------------------------------------------------------------------------

create table public.player_actions (
  id               uuid primary key default gen_random_uuid(),
  hand_player_id   uuid not null references public.hand_players (id) on delete cascade,
  hand_record_id   uuid not null references public.hand_records (id) on delete cascade,
  game_session_id  uuid not null references public.game_sessions (id) on delete cascade,
  user_id          uuid references public.profiles (id) on delete set null,

  seq              integer not null check (seq > 0),
  action           public.player_action_type not null,

  -- Hand as it stood before the action, for replay and for regrading if a
  -- strategy table is corrected.
  cards_before     jsonb not null default '[]'::jsonb,
  total_before     integer check (total_before is null or total_before between 0 and 30),
  is_soft_before   boolean not null default false,
  dealer_upcard    jsonb,

  -- Null until graded. Grading is server-side and keyed to the ruleset version.
  optimal_action   public.player_action_type,
  was_optimal      boolean,

  -- Null when the action came from a timeout default rather than a decision.
  decision_ms      integer check (decision_ms is null or decision_ms >= 0),
  from_timeout     boolean not null default false,

  decided_at       timestamptz not null default now(),

  constraint player_actions_unique_seq unique (hand_player_id, seq),
  constraint player_actions_grading_is_consistent check (
    (optimal_action is null and was_optimal is null)
    or (optimal_action is not null and was_optimal is not null)
  ),
  constraint player_actions_timeout_has_no_timing check (
    not from_timeout or decision_ms is null
  )
);

comment on table public.player_actions is
  'Per-decision log with optional strategy grading. Readable only by the player who made the decision.';

create index player_actions_user_idx on public.player_actions (user_id, decided_at desc);
create index player_actions_hand_idx on public.player_actions (hand_player_id, seq);

create trigger player_actions_deny_client_write
  before insert or update or delete on public.player_actions
  for each row execute function public.deny_client_write();

-- -----------------------------------------------------------------------------
-- Privileges and Row Level Security
-- -----------------------------------------------------------------------------

revoke all on table public.hand_records from anon, authenticated;
revoke all on table public.hand_players from anon, authenticated;
revoke all on table public.player_actions from anon, authenticated;

grant select on table public.hand_records to authenticated;
grant select on table public.hand_players to authenticated;
grant select on table public.player_actions to authenticated;

alter table public.hand_records enable row level security;
alter table public.hand_players enable row level security;
alter table public.player_actions enable row level security;

create policy hand_records_select_participant
  on public.hand_records for select
  to authenticated
  using (public.is_session_participant(game_session_id));

create policy hand_players_select_participant
  on public.hand_players for select
  to authenticated
  using (
    user_id = (select auth.uid())
    or public.is_session_participant(game_session_id)
  );

create policy player_actions_select_own
  on public.player_actions for select
  to authenticated
  using (user_id = (select auth.uid()));
