-- =============================================================================
-- Arc 21 — 1300 Command idempotency
--
-- DATABASE.md records this as the one piece of storage the command API needs
-- and does not have: the wallet ledger's `idempotency_key` covers *economic*
-- replay, but a `PLACE_BET`, a `HIT` or a `STAND` moves no chips and so has
-- nothing to collide with. Without this table a dropped response turns every
-- retry into a second real action — a second card, a second split, a second
-- settlement.
--
-- One row per ACCEPTED command. Rejected and stale commands are deliberately
-- not recorded: nothing was applied, so nothing needs replaying, and a client
-- that fixes its input must be free to retry with the same id.
--
-- `response` holds the exact committed response body, so a replay returns the
-- FIRST result byte-for-byte rather than a freshly recomputed one that might
-- differ. It is a sanitised `toPublicState` payload — the same thing the
-- original caller received — never engine state. The CHECK below makes the
-- wrong shape unstorable rather than merely discouraged.
--
-- It lives in `private` for the same reason `game_state_private` does: no API
-- role holds USAGE on that schema, so there is no client path to it at all, and
-- the four barriers described in DATABASE.md apply unchanged.
-- =============================================================================

create table private.game_commands (
  id                uuid primary key default gen_random_uuid(),

  game_session_id   uuid not null references public.game_sessions (id) on delete cascade,

  -- The account the command was attributed to, derived from the verified JWT
  -- and never from the request payload. A replay presenting the same
  -- client_action_id under a different account is a conflict, not a hit.
  user_id           uuid not null references public.profiles (id) on delete cascade,

  client_action_id  uuid not null,

  -- GameCommandType from shared/contracts/game-command.ts.
  command_type      text not null check (char_length(command_type) between 1 and 32),

  -- BlackjackGameState.version AFTER this command was applied.
  applied_version   bigint not null check (applied_version >= 0),

  -- The verbatim committed response body.
  response          jsonb not null,

  created_at        timestamptz not null default now(),

  constraint game_commands_unique_per_session
    unique (game_session_id, client_action_id),

  -- A stored result is a command response, not a state dump. `engine_state` and
  -- a raw shoe have no shape that satisfies this.
  constraint game_commands_response_is_a_response check (
    jsonb_typeof(response) = 'object'
    and response ? 'status'
    and response ->> 'status' = 'accepted'
  ),

  -- Belt and braces against a future handler that stores the wrong object: the
  -- authoritative state's own field names must not appear at the top level.
  constraint game_commands_response_is_not_engine_state check (
    not (response ? 'shoe')
    and not (response ? 'engine_state')
    and not (response ? 'nextHandSeq')
  )
);

comment on table private.game_commands is
  'Accepted-command idempotency ledger. A duplicate clientActionId returns the first committed response unchanged. Server-only: no API role has any privilege on this table or on the schema that contains it.';
comment on column private.game_commands.response is
  'The verbatim committed response body — a sanitised toPublicState payload. Never engine state.';
comment on column private.game_commands.user_id is
  'Derived from the verified JWT. A replay under a different account is rejected as a conflict.';

create index game_commands_session_created_idx
  on private.game_commands (game_session_id, created_at desc);

-- -----------------------------------------------------------------------------
-- The same barriers that stand in front of private.game_state_private.
--
-- Barrier 1 (the schema is absent from `[api] schemas`) and barrier 2 (no role
-- holds USAGE on it) are already in place from the foundation migration. These
-- are barriers 3 and 4, restated per table so a future ALTER DEFAULT PRIVILEGES
-- cannot quietly re-open them.
-- -----------------------------------------------------------------------------

revoke all on table private.game_commands from public;
revoke all on table private.game_commands from anon, authenticated, service_role;

alter table private.game_commands enable row level security;

-- -----------------------------------------------------------------------------
-- Gate, not a test. 20260813121200_hardening.sql runs BEFORE this migration and
-- therefore never sees this table, so the assertion is repeated here. The deploy
-- fails rather than silently exposing the idempotency ledger.
-- -----------------------------------------------------------------------------
do $$
declare
  v_offenders text;
begin
  select string_agg(distinct format('%s->%s(%s)', table_name, grantee, privilege_type), ', ')
  into v_offenders
  from information_schema.role_table_grants
  where table_schema = 'private'
    and table_name = 'game_commands'
    and grantee in ('anon', 'authenticated', 'service_role');

  if v_offenders is not null then
    raise exception 'private.game_commands has grants to API roles: %', v_offenders;
  end if;

  if not (
    select c.relrowsecurity
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'private' and c.relname = 'game_commands'
  ) then
    raise exception 'row level security is not enabled on private.game_commands';
  end if;

  if exists (
    select 1
    from pg_policies
    where schemaname = 'private' and tablename = 'game_commands'
  ) then
    raise exception 'private.game_commands must carry zero RLS policies';
  end if;
end;
$$;
