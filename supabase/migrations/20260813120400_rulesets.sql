-- =============================================================================
-- Arc 21 — 0400 Rulesets
--
-- A row here is a persisted `BlackjackRules` value from
-- shared/blackjack/rules.ts. The engine remains the source of truth; this table
-- exists so a stored hand can be replayed and audited against the exact rules
-- that were in force, and so strategy tables keyed to `id@version` can be
-- resolved server-side.
--
-- The CHECK constraints below make it impossible for the row's identity columns
-- to drift away from the JSON payload they describe.
-- =============================================================================

create table public.rulesets (
  id          uuid primary key default gen_random_uuid(),

  -- BlackjackRules.id, e.g. 'arc-standard'
  key         text not null check (key ~ '^[a-z0-9-]{3,40}$'),
  -- BlackjackRules.version
  version     integer not null check (version >= 1),

  -- The value `rulesetKey()` produces; used for stat bucketing and strategy lookups.
  ruleset_key text generated always as (key || '@' || version) stored,

  label       text not null check (char_length(label) between 1 and 60),
  description text check (char_length(description) <= 500),

  -- The complete BlackjackRules object, verbatim.
  rules       jsonb not null,

  is_active   boolean not null default true,
  created_at  timestamptz not null default now(),

  constraint rulesets_key_version_unique unique (key, version),
  constraint rulesets_ruleset_key_unique unique (ruleset_key),

  constraint rulesets_payload_matches_identity check (
    rules ->> 'id' = key
    and (rules ->> 'version')::integer = version
  ),
  constraint rulesets_payload_is_complete check (
    rules ? 'deckCount'
    and rules ? 'dealerHitsSoft17'
    and rules ? 'blackjackPayoutNumerator'
    and rules ? 'blackjackPayoutDenominator'
    and rules ? 'targetPenetration'
    and rules ? 'minBet'
    and rules ? 'maxBet'
    and rules ? 'betIncrement'
  )
);

comment on table public.rulesets is
  'Persisted BlackjackRules values. Public read-only catalogue; written only by migrations and server code.';
comment on column public.rulesets.rules is
  'Verbatim BlackjackRules object from shared/blackjack/rules.ts.';

create trigger rulesets_deny_client_write
  before insert or update or delete on public.rulesets
  for each row execute function public.deny_client_write();

revoke all on table public.rulesets from anon, authenticated;
grant select on table public.rulesets to anon, authenticated;

alter table public.rulesets enable row level security;

create policy rulesets_select_active
  on public.rulesets for select
  to anon, authenticated
  using (is_active);
