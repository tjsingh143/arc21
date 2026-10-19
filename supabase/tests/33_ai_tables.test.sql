-- =============================================================================
-- Arc 21 — AI Tables (Astra Refresh C)
--
-- `20261005120000_ai_tables.sql` gives a computer player an explicit marker,
-- `game_session_seats.is_ai`, and makes the database the place that keeps one
-- where it belongs. This file proves the refusals by attempting each of them:
--
--   * an AI seat cannot belong to an account, and cannot buy in;
--   * an AI seat cannot be stored at ANY table but an AI table — one attempt per
--     other mode, so a mode added later without thought is not covered by luck;
--   * an AI table seats exactly one person;
--
-- and then that the reads still answer the way the rest of the product assumes:
-- the person's live seat is their active session, the computer players are
-- visible to the person at their table and to nobody else, and no computer
-- player ever appears as anybody's active session.
--
-- Every fixture id below is owned by this file, and nothing counts a row it did
-- not insert — a pgTAP file that counts global rows fails the day the feature
-- ships.
-- =============================================================================

begin;

create extension if not exists pgtap with schema extensions;
set search_path to public, extensions, pg_catalog;

select plan(32);

insert into auth.users (id, email) values
  ('00000000-0000-4000-8000-0000000033a1', 'ai-table-person@arc21.test'),
  ('00000000-0000-4000-8000-0000000033b1', 'ai-table-stranger@arc21.test'),
  ('00000000-0000-4000-8000-0000000033c1', 'ai-table-second@arc21.test');

-- One table of every mode, so the placement rule is attempted against each.
insert into public.game_sessions (id, mode, ruleset_id, host_user_id, status, max_seats, started_at)
select v.id::uuid, v.mode::public.game_mode, r.id,
       '00000000-0000-4000-8000-0000000033a1'::uuid, 'active', 5, now()
from (values
  ('00000000-0000-4000-8000-000000003301', 'ai_table'),
  ('00000000-0000-4000-8000-000000003302', 'solo'),
  ('00000000-0000-4000-8000-000000003303', 'public_table'),
  ('00000000-0000-4000-8000-000000003304', 'private_table'),
  ('00000000-0000-4000-8000-000000003305', 'tournament'),
  ('00000000-0000-4000-8000-000000003306', 'daily_challenge'),
  ('00000000-0000-4000-8000-000000003307', 'career'),
  ('00000000-0000-4000-8000-000000003308', 'practice')
) as v(id, mode)
cross join public.rulesets r
where r.ruleset_key = 'arc-standard@1';

-- -----------------------------------------------------------------------------
-- The column
-- -----------------------------------------------------------------------------

select has_column('public', 'game_session_seats', 'is_ai', 'a seat says whether it is a computer player');
select col_not_null('public', 'game_session_seats', 'is_ai', 'and never leaves it unsaid');
select col_default_is('public', 'game_session_seats', 'is_ai', 'false',
  'every seat that existed before AI tables is a person');

-- -----------------------------------------------------------------------------
-- An AI table, seated the way `openAiTable` seats one
-- -----------------------------------------------------------------------------

select lives_ok(
  $$ insert into public.game_session_seats
       (id, game_session_id, seat_index, user_id, display_name, stack, buy_in, status, is_ai)
     values
       ('00000000-0000-4000-8000-0000000033f0', '00000000-0000-4000-8000-000000003301', 0,
        null, 'AI Player 1', 5000, 0, 'active', true),
       ('00000000-0000-4000-8000-0000000033f1', '00000000-0000-4000-8000-000000003301', 1,
        '00000000-0000-4000-8000-0000000033a1', 'Person', 5000, 0, 'active', false),
       ('00000000-0000-4000-8000-0000000033f2', '00000000-0000-4000-8000-000000003301', 2,
        null, 'AI Player 2', 5000, 0, 'active', true) $$,
  'an AI table seats one person between two computer players'
);

select is(
  (select count(*) from public.game_session_seats
   where game_session_id = '00000000-0000-4000-8000-000000003301' and is_ai),
  2::bigint,
  'both computer players are marked as such'
);

-- -----------------------------------------------------------------------------
-- What a computer player can never be
-- -----------------------------------------------------------------------------

select throws_ok(
  $$ insert into public.game_session_seats
       (game_session_id, seat_index, user_id, display_name, stack, buy_in, status, is_ai)
     values ('00000000-0000-4000-8000-000000003301', 3,
             '00000000-0000-4000-8000-0000000033b1', 'Masquerade', 5000, 0, 'active', true) $$,
  '23514', null,
  'a computer player cannot belong to an account'
);

select throws_ok(
  $$ insert into public.game_session_seats
       (game_session_id, seat_index, user_id, display_name, stack, buy_in, status, is_ai)
     values ('00000000-0000-4000-8000-000000003301', 3, null, 'Funded', 5000, 5000, 'active', true) $$,
  '23514', null,
  'a computer player cannot buy in — it has no wallet to buy in from'
);

-- One attempt per other mode. A computer player at any of these would be a bot
-- sharing a table with people who did not choose one, or a ranked result decided
-- partly by a machine.
select throws_ok(
  format(
    $$ insert into public.game_session_seats
         (game_session_id, seat_index, user_id, display_name, stack, buy_in, status, is_ai)
       values (%L, 4, null, 'Stowaway', 5000, 0, 'active', true) $$,
    v.id),
  '23514', null,
  format('no computer player may be seated at a %s table', v.mode))
from (values
  ('00000000-0000-4000-8000-000000003302', 'solo'),
  ('00000000-0000-4000-8000-000000003303', 'public_table'),
  ('00000000-0000-4000-8000-000000003304', 'private_table'),
  ('00000000-0000-4000-8000-000000003305', 'tournament'),
  ('00000000-0000-4000-8000-000000003306', 'daily_challenge'),
  ('00000000-0000-4000-8000-000000003307', 'career'),
  ('00000000-0000-4000-8000-000000003308', 'practice')
) as v(id, mode);

-- And not by turning a person's seat into one after the fact.
insert into public.game_session_seats
  (id, game_session_id, seat_index, user_id, display_name, stack, buy_in, status)
values
  ('00000000-0000-4000-8000-0000000033e1', '00000000-0000-4000-8000-000000003302', 0,
   '00000000-0000-4000-8000-0000000033c1', 'Solo', 2000, 2000, 'active');

select throws_ok(
  $$ update public.game_session_seats
     set is_ai = true, user_id = null, buy_in = 0
     where id = '00000000-0000-4000-8000-0000000033e1' $$,
  '23514', null,
  'a person''s seat at a solo table cannot be relabelled a computer player'
);

select is(
  (select is_ai from public.game_session_seats where id = '00000000-0000-4000-8000-0000000033e1'),
  false,
  'a seat stored without saying is a person''s'
);

-- -----------------------------------------------------------------------------
-- One person per AI table
-- -----------------------------------------------------------------------------

select throws_ok(
  $$ insert into public.game_session_seats
       (game_session_id, seat_index, user_id, display_name, stack, buy_in, status, is_ai)
     values ('00000000-0000-4000-8000-000000003301', 3,
             '00000000-0000-4000-8000-0000000033c1', 'Second', 5000, 0, 'active', false) $$,
  '23514', null,
  'an AI table seats exactly one person'
);

-- -----------------------------------------------------------------------------
-- The person's view of their table
-- -----------------------------------------------------------------------------

set local role authenticated;
set local request.jwt.claims to
  '{"sub":"00000000-0000-4000-8000-0000000033a1","role":"authenticated"}';

select results_eq(
  $$ select game_session_id, seat_id, mode::text from public.my_active_session() $$,
  $$ values ('00000000-0000-4000-8000-000000003301'::uuid,
             '00000000-0000-4000-8000-0000000033f1'::uuid, 'ai_table') $$,
  'the person''s live seat at an AI table is their active session, so a killed app finds it again'
);

select results_eq(
  $$ select seat_index, is_ai, user_id is null from public.game_session_seats
     where game_session_id = '00000000-0000-4000-8000-000000003301' order by seat_index $$,
  $$ values (0, true, true), (1, false, false), (2, true, true) $$,
  'the person sees every seat at their own table, and which ones are computer players'
);

-- -----------------------------------------------------------------------------
-- Everybody else's view
-- -----------------------------------------------------------------------------

set local request.jwt.claims to
  '{"sub":"00000000-0000-4000-8000-0000000033b1","role":"authenticated"}';

select is_empty(
  $$ select 1 from public.game_session_seats
     where game_session_id = '00000000-0000-4000-8000-000000003301' $$,
  'a stranger sees none of the seats at somebody else''s AI table'
);

select is_empty(
  $$ select 1 from public.game_sessions where id = '00000000-0000-4000-8000-000000003301' $$,
  'nor the table itself'
);

select is_empty(
  $$ select * from public.my_active_session() $$,
  'and a computer player is nobody''s active session'
);

-- A client cannot place a computer player either: the privilege system refuses
-- the write before any guard is consulted.
select throws_ok(
  $$ insert into public.game_session_seats
       (game_session_id, seat_index, user_id, display_name, stack, buy_in, status, is_ai)
     values ('00000000-0000-4000-8000-000000003301', 3, null, 'Injected', 5000, 0, 'active', true) $$,
  '42501', null,
  'a client cannot write a seat at all, computer player or not'
);

reset role;

-- -----------------------------------------------------------------------------
-- One open request is one table (Refresh C audit C-2)
--
-- `create-session` records every OPEN_AI_TABLE answer here and answers a replay
-- from it, including after the table has closed. The server half is proved in
-- `tests/server/ai-table.integration.test.ts`; this proves what the database
-- itself refuses and who can reach the record.
-- -----------------------------------------------------------------------------

select has_table('private', 'ai_table_open_requests', 'AI-table open requests are recorded');

insert into private.ai_table_open_requests (user_id, client_request_id, game_session_id)
values ('00000000-0000-4000-8000-0000000033a1', '00000000-0000-4000-8000-0000000033e1',
        '00000000-0000-4000-8000-000000003301');

select throws_ok(
  $$ insert into private.ai_table_open_requests (user_id, client_request_id, game_session_id)
     values ('00000000-0000-4000-8000-0000000033a1', '00000000-0000-4000-8000-0000000033e1',
             '00000000-0000-4000-8000-000000003302') $$,
  '23505', null,
  'one request id answers one table for a player, never a second'
);

select lives_ok(
  $$ insert into private.ai_table_open_requests (user_id, client_request_id, game_session_id)
     values ('00000000-0000-4000-8000-0000000033b1', '00000000-0000-4000-8000-0000000033e1',
             '00000000-0000-4000-8000-000000003302') $$,
  'the same request id under another account is that account''s own request'
);

select is(
  (select count(*)::int from information_schema.role_table_grants
   where table_schema = 'private' and table_name = 'ai_table_open_requests'
     and grantee in ('anon', 'authenticated', 'service_role')),
  0,
  'no API role holds any privilege on the request record'
);

select ok(
  (select c.relrowsecurity from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'private' and c.relname = 'ai_table_open_requests'),
  'row level security is enabled on the request record'
);

set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-8000-0000000033a1","role":"authenticated"}', true);
select throws_ok(
  $$ select count(*) from private.ai_table_open_requests $$,
  '42501', null,
  'not even the requesting player can read the record from a client'
);
reset role;

delete from public.game_sessions where id = '00000000-0000-4000-8000-000000003302';
select is(
  (select count(*)::int from private.ai_table_open_requests
   where game_session_id = '00000000-0000-4000-8000-000000003302'),
  0,
  'a record goes with the table it names'
);

-- -----------------------------------------------------------------------------
-- The guard is server-only, and the surface it sits in is unchanged
-- -----------------------------------------------------------------------------

select ok(
  not has_function_privilege('authenticated', 'public.guard_ai_seat_placement()', 'EXECUTE')
  and not has_function_privilege('anon', 'public.guard_ai_seat_placement()', 'EXECUTE'),
  'no client role can execute the placement guard'
);

select lives_ok(
  $$ select public.assert_client_authorization_surface() $$,
  'the client authorization surface is exactly what it was'
);

select * from finish();
rollback;
