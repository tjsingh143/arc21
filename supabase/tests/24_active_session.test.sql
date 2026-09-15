-- =============================================================================
-- Arc 21 — the reconnectable active-game identifier
--
-- `my_active_session()` is the answer to "where are my chips" for a player whose
-- app has forgotten. Before it existed, a game id reached the client once — in
-- the reply to the buy-in — and lived afterwards only in a route parameter, so
-- losing it locked the account out of every server-authoritative mode with the
-- buy-in stranded and nothing to address.
--
-- What is asserted here is the SHAPE: whose seat it reports, which statuses
-- count as held, and that no client role can point it at somebody else. The
-- relationship it must keep with `assertNoOtherLiveSeat` — the control it
-- mirrors — is asserted against the running function in
-- `tests/server/economy-authority.integration.test.ts`, by provoking the refusal
-- and checking this names the same table. Two copies of a predicate compared to
-- each other prove only that they were copied.
--
-- Every fixture id below is owned by this file. A pgTAP file that counts global
-- rows fails the day the feature ships, so nothing here counts anything it did
-- not insert.
-- =============================================================================

begin;

create extension if not exists pgtap with schema extensions;
set search_path to public, extensions, pg_catalog;

select plan(14);

insert into auth.users (id, email) values
  ('00000000-0000-4000-8000-0000000024a1', 'active-alice@arc21.test'),
  ('00000000-0000-4000-8000-0000000024b1', 'active-bob@arc21.test'),
  ('00000000-0000-4000-8000-0000000024c1', 'active-carol@arc21.test');

-- Alice's live solo table, Bob's completed one, Carol's seat that has left.
insert into public.game_sessions (id, mode, ruleset_id, tier, status, started_at)
select '00000000-0000-4000-8000-000000002401', 'solo', r.id, 'casual', 'active', now()
from public.rulesets r where r.ruleset_key = 'arc-standard@1';

insert into public.game_sessions (id, mode, ruleset_id, tier, status, started_at, ended_at)
select '00000000-0000-4000-8000-000000002402', 'solo', r.id, 'casual', 'completed',
       now() - interval '1 hour', now()
from public.rulesets r where r.ruleset_key = 'arc-standard@1';

insert into public.game_sessions (id, mode, ruleset_id, status, started_at)
select '00000000-0000-4000-8000-000000002403', 'career', r.id, 'active', now()
from public.rulesets r where r.ruleset_key = 'arc-standard@1';

insert into public.game_session_seats
  (id, game_session_id, seat_index, user_id, display_name, stack, buy_in, status)
values
  ('00000000-0000-4000-8000-0000000024f1', '00000000-0000-4000-8000-000000002401', 0,
   '00000000-0000-4000-8000-0000000024a1', 'Alice', 2000, 2000, 'active'),
  -- Bob's table is over; the seat was settled with it.
  ('00000000-0000-4000-8000-0000000024f2', '00000000-0000-4000-8000-000000002402', 0,
   '00000000-0000-4000-8000-0000000024b1', 'Bob', 0, 2000, 'left'),
  -- Carol is DISCONNECTED at a live career node, which is a seat still HELD.
  ('00000000-0000-4000-8000-0000000024f3', '00000000-0000-4000-8000-000000002403', 0,
   '00000000-0000-4000-8000-0000000024c1', 'Carol', 2000, 0, 'disconnected');

-- -----------------------------------------------------------------------------
-- Alice — a live seat, reported in full
-- -----------------------------------------------------------------------------

set local role authenticated;
set local request.jwt.claims to
  '{"sub":"00000000-0000-4000-8000-0000000024a1","role":"authenticated"}';

select is(
  (select count(*) from public.my_active_session()),
  1::bigint,
  'a player holding a live seat is told about exactly one table'
);

select results_eq(
  $$ select game_session_id, seat_id, mode::text, tier::text from public.my_active_session() $$,
  $$ values ('00000000-0000-4000-8000-000000002401'::uuid,
             '00000000-0000-4000-8000-0000000024f1'::uuid,
             'solo', 'casual') $$,
  'and it is her own table, seat, mode and stakes'
);

-- The projection, asserted rather than described: an ADDRESS and a name for it.
-- A column added here would be a fact about a table travelling to a client that
-- asked only where to go, so the signature is pinned.
select is(
  (select pg_get_function_result(p.oid)
   from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'my_active_session'),
  'TABLE(game_session_id uuid, seat_id uuid, mode game_mode, tier table_tier, '
  || 'started_at timestamp with time zone)',
  'it returns an address and a name for it — no stack, no wager, no card'
);

-- -----------------------------------------------------------------------------
-- Bob — a settled seat is not a held one
-- -----------------------------------------------------------------------------

set local request.jwt.claims to
  '{"sub":"00000000-0000-4000-8000-0000000024b1","role":"authenticated"}';

select is_empty(
  $$ select * from public.my_active_session() $$,
  'a seat with status left is settled, so no table is offered'
);

-- -----------------------------------------------------------------------------
-- Carol — `disconnected` is a seat still HELD
-- -----------------------------------------------------------------------------
--
-- This is the distinction account deletion once got wrong in the other
-- direction: it refused while any seat existed, `left` ones included, and told
-- players to leave a table they had already left. `active` and `disconnected`
-- are held; `left` is not.

set local request.jwt.claims to
  '{"sub":"00000000-0000-4000-8000-0000000024c1","role":"authenticated"}';

select is(
  (select game_session_id from public.my_active_session()),
  '00000000-0000-4000-8000-000000002403'::uuid,
  'a disconnected seat is still held, so its table is still offered'
);

select is(
  (select mode::text from public.my_active_session()),
  'career',
  'and a closed-economy mode is reported like any other'
);

select is(
  (select tier from public.my_active_session()),
  null,
  'a table with no stakes reports no tier rather than inventing one'
);

-- -----------------------------------------------------------------------------
-- A stranger
-- -----------------------------------------------------------------------------

set local request.jwt.claims to
  '{"sub":"00000000-0000-4000-8000-0000000024b1","role":"authenticated"}';

select is_empty(
  $$ select * from public.my_active_session() $$,
  'one player learns nothing about another player''s table'
);

-- There is no argument to point it somewhere else. The identity comes from
-- auth.uid() and the function takes nothing at all.
select is(
  (select count(*) from pg_proc p
   join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'my_active_session' and p.pronargs > 0),
  0::bigint,
  'no overload of it accepts an argument'
);

reset role;

-- -----------------------------------------------------------------------------
-- Privileges
-- -----------------------------------------------------------------------------
--
-- A new function's default ACL is EXECUTE TO PUBLIC, so `grant … to
-- authenticated` alone leaves it callable by `anon` while reading as if it did
-- not. Sixteen migrations made that mistake before the gate existed.

select ok(
  not has_function_privilege('anon', 'public.my_active_session()', 'EXECUTE'),
  'anon cannot execute it'
);

select ok(
  has_function_privilege('authenticated', 'public.my_active_session()', 'EXECUTE'),
  'a signed-in player can'
);

select ok(
  (select prosecdef from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'my_active_session'),
  'it is SECURITY DEFINER, so it can read the seat rows RLS would scope'
);

select is(
  (select proconfig from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'my_active_session'),
  array['search_path=public, pg_temp'],
  'with a pinned search_path, as every SECURITY DEFINER function here has'
);

-- And the gate itself, which is the check that does not go out of date: it
-- refuses any public function executable by PUBLIC and any function outside its
-- allowlist that a client role can reach.
select lives_ok(
  $$ select public.assert_client_authorization_surface() $$,
  'the authorization surface still passes with the new function on it'
);

select * from finish();

rollback;
