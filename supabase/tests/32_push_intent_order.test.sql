-- =============================================================================
-- Arc 21 — a device's push registration keeps its NEWEST intent (Refresh-B B-H4)
--
-- The final audit let an older "Your turn: on" reach Postgres after a newer
-- "off" had committed, by holding the accepted request past its own failed
-- connection: memory OFF, disk OFF, database ON. The order now travels with
-- each write as an intent revision, and the row applies only a newer one
-- (`20261004120000_push_registration_intent_order.sql`). These assertions are
-- the six required orderings at the database boundary itself, plus who may
-- call what. `tests/server/notification-intent-order.integration.test.ts`
-- drives the same through the app's own code and a real lost connection.
-- =============================================================================

begin;

create extension if not exists pgtap with schema extensions;
set search_path to public, extensions, pg_catalog;

select plan(30);

-- ---------------------------------------------------------------------------
-- Shape and privileges
-- ---------------------------------------------------------------------------

select has_column('public', 'push_tokens', 'intent_revision', 'a device row remembers the newest intent it applied');
select col_type_is('public', 'push_tokens', 'intent_revision', 'bigint', 'as an integer, never a float or a clock string');
select col_not_null('public', 'push_tokens', 'intent_revision', 'and always has one');

select ok(
  has_function_privilege('authenticated',
    'public.register_push_token(text, public.push_platform, text, public.notification_kind[], bigint)', 'execute')
  and has_function_privilege('authenticated', 'public.retire_push_token(text, bigint)', 'execute'),
  'a signed-in device may register and retire itself, with a revision'
);
select ok(
  not has_function_privilege('anon',
    'public.register_push_token(text, public.push_platform, text, public.notification_kind[], bigint)', 'execute')
  and not has_function_privilege('anon', 'public.retire_push_token(text, bigint)', 'execute'),
  'nobody else may'
);
select is(
  (select count(*)::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname in ('register_push_token', 'retire_push_token')),
  2,
  'and no unordered arity survives beside the ordered ones'
);

-- ---------------------------------------------------------------------------
-- Fixtures: two players, one device token
-- ---------------------------------------------------------------------------

insert into auth.users (id, email, aud, role) values
  ('b4000000-0000-4000-8000-000000000001', 'intent-order-1@arc21.test', 'authenticated', 'authenticated'),
  ('b4000000-0000-4000-8000-000000000002', 'intent-order-2@arc21.test', 'authenticated', 'authenticated');

set local role authenticated;
set local request.jwt.claims to '{"sub":"b4000000-0000-4000-8000-000000000001","role":"authenticated"}';

-- Each step's answer, kept for the assertions below (created by the role that writes it).
create temporary table answers (step text primary key, answer jsonb) on commit drop;

-- A first registration: "Your turn" ON at revision 100.
insert into answers values ('on@100', public.register_push_token(
  'ExponentPushToken[intent-order]', 'ios', 'device-1', '{your_turn,system}', 100));

-- CASE 1 / 4 — the newer OFF commits (revision 101)…
insert into answers values ('off@101', public.register_push_token(
  'ExponentPushToken[intent-order]', 'ios', 'device-1', '{system}', 101));
-- …and the older ON, still in flight, arrives afterwards (revision 100 again
-- would be its replay; an even older one is 99). Neither may undo OFF.
insert into answers values ('on@99-late', public.register_push_token(
  'ExponentPushToken[intent-order]', 'ios', 'device-1', '{your_turn,system}', 99));

reset role;

select is((select answer from answers where step = 'on@100'), '{"applied": true, "revision": 100}'::jsonb, 'the first intent is applied');
select is((select answer from answers where step = 'off@101'), '{"applied": true, "revision": 101}'::jsonb, 'a newer intent is applied');
select is((select answer from answers where step = 'on@99-late'), '{"applied": false, "revision": 101}'::jsonb,
  'CASE 1: an older ON that arrives after a newer OFF is refused, and says which revision holds the row');
select is(
  (select allowed_kinds::text from public.push_tokens where token = 'ExponentPushToken[intent-order]'),
  '{system}',
  'CASE 1: the database ends OFF'
);

set local role authenticated;
set local request.jwt.claims to '{"sub":"b4000000-0000-4000-8000-000000000001","role":"authenticated"}';

-- CASE 2 — the mirror image: a newer ON (102), then a late older OFF (101.5 does
-- not exist; the replay of 101 is the late OFF).
insert into answers values ('on@102', public.register_push_token(
  'ExponentPushToken[intent-order]', 'ios', 'device-1', '{your_turn,system}', 102));
insert into answers values ('off@101-late', public.register_push_token(
  'ExponentPushToken[intent-order]', 'ios', 'device-1', '{system}', 101));

reset role;

select is((select answer from answers where step = 'off@101-late'), '{"applied": false, "revision": 102}'::jsonb,
  'CASE 2: an older OFF that arrives after a newer ON is refused');
select is(
  (select allowed_kinds::text from public.push_tokens where token = 'ExponentPushToken[intent-order]'),
  '{your_turn,system}',
  'CASE 2: the database ends ON'
);

set local role authenticated;
set local request.jwt.claims to '{"sub":"b4000000-0000-4000-8000-000000000001","role":"authenticated"}';

-- CASE 6 — the newest intent's reply is lost and the SAME intent is sent again.
insert into answers values ('on@102-replay', public.register_push_token(
  'ExponentPushToken[intent-order]', 'ios', 'device-1', '{your_turn,system}', 102));
-- CASE 5 — an old intent retried after a newer one exists.
insert into answers values ('on@100-retry', public.register_push_token(
  'ExponentPushToken[intent-order]', 'ios', 'device-1', '{your_turn}', 100));

reset role;

select is((select answer from answers where step = 'on@102-replay'), '{"applied": false, "revision": 102}'::jsonb,
  'CASE 6: the same newest intent again is a no-op that reports it is already applied');
select is((select answer from answers where step = 'on@100-retry'), '{"applied": false, "revision": 102}'::jsonb,
  'CASE 5: a retried old intent is refused');
select is(
  (select allowed_kinds::text || '@' || intent_revision from public.push_tokens where token = 'ExponentPushToken[intent-order]'),
  '{your_turn,system}@102',
  'CASES 5 and 6 change nothing: the row is exactly the newest intent'
);

set local role authenticated;
set local request.jwt.claims to '{"sub":"b4000000-0000-4000-8000-000000000001","role":"authenticated"}';

-- Retirement is ordered by the same revision: an older retirement cannot
-- switch off a newer registration…
insert into answers values ('retire@101-late', public.retire_push_token('ExponentPushToken[intent-order]', 101));
-- …a newer one does…
insert into answers values ('retire@103', public.retire_push_token('ExponentPushToken[intent-order]', 103));
-- …and a registration that left before it cannot switch the device back on.
insert into answers values ('on@102-after-retire', public.register_push_token(
  'ExponentPushToken[intent-order]', 'ios', 'device-1', '{your_turn,system}', 102));

reset role;

select is((select answer from answers where step = 'retire@101-late'), '{"applied": false, "revision": 102}'::jsonb,
  'an older retirement cannot switch off a newer registration');
select is((select answer from answers where step = 'retire@103'), '{"applied": true, "revision": 103}'::jsonb,
  'a newer retirement is applied');
select is((select answer from answers where step = 'on@102-after-retire'), '{"applied": false, "revision": 103}'::jsonb,
  'and a registration older than the retirement cannot bring the device back');
select is(
  (select is_active::text || ':' || allowed_kinds::text from public.push_tokens where token = 'ExponentPushToken[intent-order]'),
  'false:{}',
  'the device stays retired'
);

-- ---------------------------------------------------------------------------
-- Ownership: the order is per device; retirement stays confined to its owner
-- ---------------------------------------------------------------------------

set local role authenticated;
set local request.jwt.claims to '{"sub":"b4000000-0000-4000-8000-000000000002","role":"authenticated"}';

-- The next player on this device: a newer write from the same device.
insert into answers values ('two@104', public.register_push_token(
  'ExponentPushToken[intent-order]', 'ios', 'device-1', '{friend_request,system}', 104));

set local request.jwt.claims to '{"sub":"b4000000-0000-4000-8000-000000000001","role":"authenticated"}';

-- The departed player's late writes: neither takes the device back.
insert into answers values ('one@103-late', public.register_push_token(
  'ExponentPushToken[intent-order]', 'ios', 'device-1', '{your_turn,system}', 103));
insert into answers values ('one-retire@999', public.retire_push_token('ExponentPushToken[intent-order]', 999));

reset role;

select is((select answer from answers where step = 'two@104'), '{"applied": true, "revision": 104}'::jsonb,
  'the next player on the device registers it with a newer revision');
select is((select answer from answers where step = 'one@103-late'), '{"applied": false, "revision": 104}'::jsonb,
  'the departed player''s stale registration cannot take the device back');
select is((select answer from answers where step = 'one-retire@999'), '{"applied": false, "revision": null}'::jsonb,
  'and their retirement, however new, cannot touch a row that is not theirs — nor learn its revision');
select is(
  (select user_id::text || ':' || is_active::text || ':' || allowed_kinds::text from public.push_tokens
   where token = 'ExponentPushToken[intent-order]'),
  'b4000000-0000-4000-8000-000000000002:true:{friend_request,system}',
  'the device is the next player''s, active, with their choices'
);

-- ---------------------------------------------------------------------------
-- A write must say where it stands
-- ---------------------------------------------------------------------------

set local role authenticated;
set local request.jwt.claims to '{"sub":"b4000000-0000-4000-8000-000000000002","role":"authenticated"}';

select throws_ok(
  $$ select public.register_push_token('ExponentPushToken[intent-order]', 'ios', 'device-1', '{system}', null) $$,
  '22023', 'a device registration must carry its intent revision',
  'a registration without a revision is refused'
);
select throws_ok(
  $$ select public.register_push_token('ExponentPushToken[intent-order]', 'ios', 'device-1', '{system}', 0) $$,
  '22023', 'a device registration must carry its intent revision',
  'and so is revision 0, which every row already holds'
);
select throws_ok(
  $$ select public.retire_push_token('ExponentPushToken[intent-order]', null) $$,
  '22023', 'a device retirement must carry its intent revision',
  'as is a retirement without one'
);
select throws_ok(
  $$ select public.register_push_token('short', 'ios', null, '{system}', 1) $$,
  'P0001', 'that does not look like a push token',
  'the old token check still stands'
);

reset role;

select is(
  (select count(*)::int from public.push_tokens where token = 'ExponentPushToken[intent-order]'),
  1,
  'one device, one row, throughout'
);

-- A brand-new device's first write is applied from the column default.
set local role authenticated;
set local request.jwt.claims to '{"sub":"b4000000-0000-4000-8000-000000000002","role":"authenticated"}';
insert into answers values ('new-device@1', public.register_push_token(
  'ExponentPushToken[intent-order-second]', 'android', 'device-2', '{system}', 1));
reset role;
select is((select answer from answers where step = 'new-device@1'), '{"applied": true, "revision": 1}'::jsonb,
  'a new device''s first revision is applied');
select is(
  (select count(*)::int from public.push_tokens where user_id = 'b4000000-0000-4000-8000-000000000002'),
  2,
  'and is a second device of the same account, ordered on its own'
);

select * from finish();
rollback;
