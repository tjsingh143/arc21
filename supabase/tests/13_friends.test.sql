-- =============================================================================
-- Arc 21 — the friend graph
--
-- The cases that matter are the ones where two people act at once, and the ones
-- where a block has to actually stop something. A "send request" test that only
-- covers the happy path passes on an implementation that stacks duplicate rows
-- and leaves two people permanently pending on each other.
-- =============================================================================

begin;

create extension if not exists pgtap with schema extensions;
set search_path to public, extensions, pg_catalog;

select plan(13);

select has_function('public', 'send_friend_request', 'requests are a server function');
select has_function('public', 'block_player', 'blocking is a server function');

-- No function takes a "from": identity always comes from the session.
select is(
  (select count(*)::int from pg_proc p
   join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.proname in ('send_friend_request', 'accept_friend_request', 'remove_friend', 'block_player')
     and pg_get_function_arguments(p.oid) not like '%p_to uuid'
     and pg_get_function_arguments(p.oid) not like '%p_from uuid'
     and pg_get_function_arguments(p.oid) not like '%p_other uuid'),
  0,
  'every friend operation names only the OTHER person, never both sides'
);

insert into auth.users (id, email, aud, role) values
  ('aaaaaaaa-0000-4000-8000-000000000001', 'fr-a@arc21.test', 'authenticated', 'authenticated'),
  ('bbbbbbbb-0000-4000-8000-000000000002', 'fr-b@arc21.test', 'authenticated', 'authenticated');

set local role authenticated;
set local request.jwt.claims to
  '{"sub":"aaaaaaaa-0000-4000-8000-000000000001","role":"authenticated"}';

-- --------------------------------------------------------------------------
-- Requests are idempotent
-- --------------------------------------------------------------------------

select is(
  (select public.send_friend_request('bbbbbbbb-0000-4000-8000-000000000002')),
  'outgoing_pending',
  'a first request is pending'
);

select is(
  (select public.send_friend_request('bbbbbbbb-0000-4000-8000-000000000002')),
  'outgoing_pending',
  'asking twice is not an error'
);

select is(
  (select count(*)::int from public.friend_requests),
  1,
  'and does not stack a second row'
);

select throws_ok(
  $$ select public.send_friend_request('aaaaaaaa-0000-4000-8000-000000000001') $$,
  'P0001', null,
  'you cannot add yourself'
);

-- --------------------------------------------------------------------------
-- Crossed requests resolve to ONE friendship
-- --------------------------------------------------------------------------
-- Two people tapping "add" at the same moment is the realistic race here. A
-- naive implementation leaves a mirrored pair of pending requests that neither
-- side can accept, because each is waiting on the other.

set local request.jwt.claims to
  '{"sub":"bbbbbbbb-0000-4000-8000-000000000002","role":"authenticated"}';

select is(
  (select public.send_friend_request('aaaaaaaa-0000-4000-8000-000000000001')),
  'friends',
  'requesting someone who already asked you accepts instead'
);

select is(
  (select count(*)::int from public.friendships),
  1,
  'a friendship is stored once, not once per direction'
);

-- --------------------------------------------------------------------------
-- Blocking
-- --------------------------------------------------------------------------

select is(
  (select public.block_player('aaaaaaaa-0000-4000-8000-000000000001')),
  'blocked',
  'blocking succeeds'
);

select is(
  (select count(*)::int from public.friendships),
  0,
  'blocking removes the friendship — otherwise the blocked player still sees them'
);

set local request.jwt.claims to
  '{"sub":"aaaaaaaa-0000-4000-8000-000000000001","role":"authenticated"}';

-- The blocked party is told the same thing a missing account would produce.
-- Saying "you are blocked" confirms the account exists and who blocked them.
select throws_ok(
  $$ select public.send_friend_request('bbbbbbbb-0000-4000-8000-000000000002') $$,
  'P0002', null,
  'the blocked party cannot re-add, and is not told why'
);

select is(
  (select count(*)::int from public.search_players('fr-b')),
  0,
  'and cannot find them in search either'
);

select * from finish();
rollback;
