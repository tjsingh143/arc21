-- =============================================================================
-- Arc 21 — notifications, push tokens and delivery
--
-- Three properties, in descending order of how bad it would be to get wrong.
--
--   1. A CLIENT CANNOT WRITE A NOTIFICATION. `notify_user` is revoked from every
--      client role, so a modified client cannot post itself "you won a
--      tournament" or forge one from another player. Asserted on the privilege,
--      not on the application code that happens to call it.
--   2. A PAYLOAD CANNOT CARRY A SECRET. `data` is constrained to allowlisted
--      keys holding short scalars, so a daily-challenge seed, a shoe order or a
--      hole card cannot ride out through a push message. The 1100 migration
--      asserted this in a comment; a comment is not a constraint.
--   3. DELIVERY IS RECORDED HONESTLY. Without push credentials nothing is sent,
--      and those rows say `mocked` with a null `sent_at` rather than claiming a
--      delivery that did not happen.
--
-- Fixtures are scoped to this file's own users and counted only within them.
-- =============================================================================

begin;

create extension if not exists pgtap with schema extensions;
set search_path to public, extensions, pg_catalog;

select plan(41);

-- ---------------------------------------------------------------------------
-- Structure
-- ---------------------------------------------------------------------------

select has_type('public', 'notification_delivery', 'delivery state is an enum, not free text');
select has_column('public', 'notifications', 'delivery', 'a notification records how it was delivered');
select has_column('public', 'notifications', 'dedupe_key', 'and how repeats are collapsed');
select has_column('public', 'push_tokens', 'allowed_kinds', 'a device says which kinds it wants');

select bag_eq(
  $$ select unnest(enum_range(null::public.notification_delivery))::text $$,
  $$ values ('pending'), ('sent'), ('mocked'), ('no_device'), ('failed') $$,
  'mocked is distinct from sent, which is the whole point of the enum'
);

-- ---------------------------------------------------------------------------
-- Privileges
-- ---------------------------------------------------------------------------

select ok(
  not has_function_privilege('authenticated',
    'public.notify_user(uuid, public.notification_kind, text, text, jsonb, text)', 'execute'),
  'a client cannot write a notification'
);
select ok(
  not has_function_privilege('anon',
    'public.notify_user(uuid, public.notification_kind, text, text, jsonb, text)', 'execute'),
  'and neither can an anonymous caller'
);
select ok(
  not has_function_privilege('authenticated', 'public.pending_push_deliveries(integer)', 'execute'),
  'a client cannot read the delivery queue, which carries other people''s titles'
);
select ok(
  not has_function_privilege('authenticated',
    'public.record_push_delivery(uuid, public.notification_delivery, text)', 'execute'),
  'nor mark one delivered'
);
select ok(
  has_function_privilege('authenticated', 'public.my_notifications(integer)', 'execute'),
  'but it can read its own'
);
select ok(
  has_function_privilege('authenticated',
    'public.register_push_token(text, public.push_platform, text, public.notification_kind[])', 'execute'),
  'and register its own device'
);

-- ---------------------------------------------------------------------------
-- The payload allowlist
-- ---------------------------------------------------------------------------

select ok(public.notification_data_is_safe('{"room_code": "ABCDEF"}'::jsonb),
  'a deep-link parameter is allowed');
select ok(public.notification_data_is_safe('{}'::jsonb),
  'and so is nothing at all');
select ok(not public.notification_data_is_safe('{"seed_secret": "hunter2"}'::jsonb),
  'an unlisted key is refused, whatever it is called');
select ok(not public.notification_data_is_safe('{"shoe": ["AS", "KD"]}'::jsonb),
  'a shoe is an array, and an array cannot be a deep-link parameter');
select ok(not public.notification_data_is_safe('{"room_code": {"nested": 1}}'::jsonb),
  'nor can a nested object');
select ok(not public.notification_data_is_safe(to_jsonb('not an object'::text)),
  'and the payload itself must be an object');
select ok(
  not public.notification_data_is_safe(
    jsonb_build_object('room_code', repeat('x', 65))),
  'a value long enough to hold a shoe is refused on length alone'
);

-- ---------------------------------------------------------------------------
-- Fixtures
-- ---------------------------------------------------------------------------

insert into auth.users (id, email, aud, role) values
  ('0e000000-0000-4000-8000-000000000001', 'notify-a@arc21.test', 'authenticated', 'authenticated'),
  ('0e000000-0000-4000-8000-000000000002', 'notify-b@arc21.test', 'authenticated', 'authenticated');

-- ---------------------------------------------------------------------------
-- Writing
-- ---------------------------------------------------------------------------

select isnt(
  public.notify_user('0e000000-0000-4000-8000-000000000001', 'system', 'Hello', 'A body'),
  null,
  'the server can write a notification'
);

select throws_ok(
  $$ select public.notify_user('0e000000-0000-4000-8000-000000000001', 'system', 'Hi', 'B',
       '{"seed_secret": "hunter2"}'::jsonb) $$,
  'P0001',
  'notification data may carry deep-link parameters only',
  'and is refused outright when it tries to attach something else'
);

-- Dedupe collapses rather than erroring: two people racing the same invite is
-- ordinary, and the second one is not a failure.
select isnt(
  public.notify_user('0e000000-0000-4000-8000-000000000001', 'table_invite', 'Invite', 'B',
    '{"room_code": "ABCDEF"}'::jsonb, 'dedupe-fixture'),
  null,
  'a keyed notification is written the first time'
);
select is(
  public.notify_user('0e000000-0000-4000-8000-000000000001', 'table_invite', 'Invite', 'B',
    '{"room_code": "ABCDEF"}'::jsonb, 'dedupe-fixture'),
  null,
  'and collapsed the second, rather than buzzing the same device twice'
);
select is(
  (select count(*)::int from public.notifications
   where user_id = '0e000000-0000-4000-8000-000000000001' and dedupe_key = 'dedupe-fixture'),
  1,
  'leaving exactly one row'
);

-- The same key for a DIFFERENT player is a different notification.
select isnt(
  public.notify_user('0e000000-0000-4000-8000-000000000002', 'table_invite', 'Invite', 'B',
    '{"room_code": "ABCDEF"}'::jsonb, 'dedupe-fixture'),
  null,
  'dedupe is scoped per player, not globally'
);

-- ---------------------------------------------------------------------------
-- Reading, as the recipient
-- ---------------------------------------------------------------------------

set local role authenticated;
select set_config('request.jwt.claims',
  '{"sub":"0e000000-0000-4000-8000-000000000001","role":"authenticated"}', true);

select is(
  (select count(*)::int from public.my_notifications()),
  2,
  'a player sees their own notifications'
);
select is(
  (select count(*)::int from public.notifications),
  2,
  'and RLS shows them nothing of anybody else''s'
);
select is(public.unread_notification_count(), 2, 'both are unread');

select is(public.mark_notifications_read(null), 2, 'marking all read reports what it changed');
select is(public.unread_notification_count(), 0, 'and leaves nothing unread');

-- The one thing a client may change is `read_at`, and that is now enforced by
-- comparing the whole row rather than by listing columns — the previous guard
-- named six, and every column added afterwards would have been writable.
select throws_ok(
  $$ update public.notifications set title = 'Forged'
     where user_id = '0e000000-0000-4000-8000-000000000001' $$,
  '42501',
  null,
  'a client cannot rewrite a notification''s text'
);
select throws_ok(
  $$ update public.notifications set delivery = 'sent'
     where user_id = '0e000000-0000-4000-8000-000000000001' $$,
  '42501',
  null,
  'nor mark its own notification delivered'
);

-- ---------------------------------------------------------------------------
-- Devices
-- ---------------------------------------------------------------------------

select lives_ok(
  $$ select public.register_push_token('ExponentPushToken[fixture-a]', 'ios', 'device-a',
       array['table_invite', 'friend_request']::public.notification_kind[]) $$,
  'a device registers itself for the kinds it wants'
);
select is(
  (select array_length(allowed_kinds, 1) from public.push_tokens
   where token = 'ExponentPushToken[fixture-a]'),
  2,
  'and the allowlist is stored, because it is what the sender filters on'
);

select throws_ok(
  $$ select public.register_push_token('short', 'ios', null, array['system']::public.notification_kind[]) $$,
  'P0001',
  'that does not look like a push token',
  'a token too short to be real is refused'
);

reset role;

-- ---------------------------------------------------------------------------
-- The sender's view
-- ---------------------------------------------------------------------------

-- A kind this device did NOT ask for produces no delivery row at all.
select is(
  (select count(*)::int from public.pending_push_deliveries(100)
   where token = 'ExponentPushToken[fixture-a]' and kind = 'system'),
  0,
  'a kind the device did not ask for is never queued to it'
);
select is(
  (select count(*)::int from public.pending_push_deliveries(100)
   where token = 'ExponentPushToken[fixture-a]' and kind = 'table_invite'),
  1,
  'and a kind it did ask for is'
);

-- The honest delivery record.
select public.record_push_delivery(
  (select id from public.notifications
   where user_id = '0e000000-0000-4000-8000-000000000001' and dedupe_key = 'dedupe-fixture'),
  'mocked', 'no push credentials configured');

select is(
  (select delivery::text from public.notifications
   where user_id = '0e000000-0000-4000-8000-000000000001' and dedupe_key = 'dedupe-fixture'),
  'mocked',
  'a development send records mocked'
);
select is(
  (select sent_at from public.notifications
   where user_id = '0e000000-0000-4000-8000-000000000001' and dedupe_key = 'dedupe-fixture'),
  null,
  'and leaves sent_at null, so "how many pushes have we really sent" stays answerable'
);

select public.record_push_delivery(
  (select id from public.notifications
   where user_id = '0e000000-0000-4000-8000-000000000002' and dedupe_key = 'dedupe-fixture'),
  'sent', null);

select isnt(
  (select sent_at from public.notifications
   where user_id = '0e000000-0000-4000-8000-000000000002' and dedupe_key = 'dedupe-fixture'),
  null,
  'only a real send stamps sent_at'
);

-- ---------------------------------------------------------------------------
-- Inviting a friend to a table
-- ---------------------------------------------------------------------------

set local role authenticated;
select set_config('request.jwt.claims',
  '{"sub":"0e000000-0000-4000-8000-000000000001","role":"authenticated"}', true);

-- Not friends yet: the invite is refused with the same wording a missing account
-- gets everywhere else in the friend graph, so a room cannot be used to probe.
select throws_ok(
  $$ select public.invite_friend_to_room(gen_random_uuid(), '0e000000-0000-4000-8000-000000000002') $$,
  'P0002',
  'no such player',
  'a stranger cannot be invited to a table'
);

select throws_ok(
  $$ select public.invite_friend_to_room(gen_random_uuid(), '0e000000-0000-4000-8000-000000000001') $$,
  'P0001',
  'you cannot invite yourself',
  'and neither can you'
);

reset role;

select * from finish();
rollback;
