-- =============================================================================
-- Arc 21 — the private engine state must be unreachable
--
-- private.game_state_private holds the undealt shoe in order and the dealer's
-- hole card. This file is the reason the schema is shaped the way it is: a
-- single readable row would let a modified client win every remaining hand.
--
-- Each barrier is tested on its own, because a defence that only works when the
-- other three also work is one defence, not four.
-- =============================================================================

begin;

create extension if not exists pgtap with schema extensions;
set search_path to public, extensions, pg_catalog;

select plan(14);

-- -----------------------------------------------------------------------------
-- Fixture: one user, one session, one row of private state
-- -----------------------------------------------------------------------------

insert into auth.users (id, email)
values ('00000000-0000-4000-8000-00000000000a', 'alice@arc21.test');

insert into public.game_sessions (id, mode, ruleset_id, tier, host_user_id, status)
select
  '00000000-0000-4000-8000-0000000005e5',
  'solo',
  r.id,
  'casual',
  '00000000-0000-4000-8000-00000000000a',
  'active'
from public.rulesets r
where r.ruleset_key = 'arc-standard@1';

-- Alice is a seated participant — the most privileged position a client can
-- hold in this session. She still must not reach the engine state.
insert into public.game_session_seats (game_session_id, seat_index, user_id, display_name)
values ('00000000-0000-4000-8000-0000000005e5', 0,
        '00000000-0000-4000-8000-00000000000a', 'Alice');

insert into private.game_state_private (game_session_id, engine_state, version)
values (
  '00000000-0000-4000-8000-0000000005e5',
  jsonb_build_object(
    'shoe', jsonb_build_object(
      'cards', jsonb_build_array(
        jsonb_build_object('id', 'c1', 'rank', 'A', 'suit', 'S', 'deckIndex', 0),
        jsonb_build_object('id', 'c2', 'rank', 'K', 'suit', 'H', 'deckIndex', 0)
      ),
      'nextIndex', 0
    ),
    'dealer', jsonb_build_object('holeCardRevealed', false)
  ),
  1
);

-- -----------------------------------------------------------------------------
-- Barrier 1 — the schema is not exposed through the Data API
-- -----------------------------------------------------------------------------

select is(
  (
    select n.nspname
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where c.relname = 'game_state_private'
  ),
  'private',
  'the engine state table lives outside the API-exposed schemas'
);

-- -----------------------------------------------------------------------------
-- Barrier 2 — no API role holds USAGE on the schema
-- -----------------------------------------------------------------------------

select ok(
  not has_schema_privilege('anon', 'private', 'USAGE'),
  'anon has no USAGE on the private schema'
);

select ok(
  not has_schema_privilege('authenticated', 'private', 'USAGE'),
  'authenticated has no USAGE on the private schema'
);

select ok(
  not has_schema_privilege('service_role', 'private', 'USAGE'),
  'service_role has no USAGE on the private schema'
);

-- -----------------------------------------------------------------------------
-- Barrier 3 — no table privileges for any API role
-- -----------------------------------------------------------------------------

select is(
  (
    select count(*)
    from information_schema.role_table_grants
    where table_schema = 'private'
      and grantee in ('anon', 'authenticated', 'service_role')
  )::int,
  0,
  'no API role holds any privilege on any table in the private schema'
);

-- -----------------------------------------------------------------------------
-- Barrier 4 — RLS is on with no policies at all
-- -----------------------------------------------------------------------------

select ok(
  (
    select c.relrowsecurity
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'private' and c.relname = 'game_state_private'
  ),
  'row level security is enabled on private.game_state_private'
);

select is(
  (
    select count(*)
    from pg_policies
    where schemaname = 'private' and tablename = 'game_state_private'
  )::int,
  0,
  'private.game_state_private has no policies, so no row can match'
);

-- -----------------------------------------------------------------------------
-- No back door through the public schema
-- -----------------------------------------------------------------------------

select is(
  (
    select count(*)
    from pg_views
    where schemaname = 'public'
      and definition ilike '%game_state_private%'
  )::int,
  0,
  'no view in public selects from the private engine state'
);

select is(
  (
    select count(*)
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.prosrc ilike '%game_state_private%'
      and (
        has_function_privilege('anon', p.oid, 'EXECUTE')
        or has_function_privilege('authenticated', p.oid, 'EXECUTE')
      )
  )::int,
  0,
  'no client-callable function touches the private engine state'
);

-- -----------------------------------------------------------------------------
-- And the actual attempt, as a seated participant
-- -----------------------------------------------------------------------------

set local role authenticated;
set local request.jwt.claims to
  '{"sub":"00000000-0000-4000-8000-00000000000a","role":"authenticated"}';

select ok(
  auth.uid() = '00000000-0000-4000-8000-00000000000a'::uuid,
  'the test session is authenticated as Alice'
);

select ok(
  public.is_session_participant('00000000-0000-4000-8000-0000000005e5'),
  'Alice really is a seated participant in the session'
);

select throws_ok(
  'select * from private.game_state_private',
  '42501',
  null,
  'a seated participant cannot select from private.game_state_private'
);

select throws_ok(
  $$ select engine_state from private.game_state_private
     where game_session_id = '00000000-0000-4000-8000-0000000005e5' $$,
  '42501',
  null,
  'a seated participant cannot read the engine state of their own session'
);

select throws_ok(
  $$ update private.game_state_private set version = 999 $$,
  '42501',
  null,
  'a seated participant cannot write the engine state'
);

reset role;

select * from finish();

rollback;
