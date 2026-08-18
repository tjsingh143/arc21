-- =============================================================================
-- Arc 21 — one player cannot read another player's private records
--
-- Statistics, friend requests, notifications, devices and owned cosmetics are
-- all scoped to their owner. A friend request in particular is visible to
-- exactly two people; a third party cannot even establish that it exists.
-- =============================================================================

begin;

create extension if not exists pgtap with schema extensions;
set search_path to public, extensions, pg_catalog;

select plan(19);

insert into auth.users (id, email) values
  ('00000000-0000-4000-8000-00000000000a', 'alice@arc21.test'),
  ('00000000-0000-4000-8000-00000000000b', 'bob@arc21.test'),
  ('00000000-0000-4000-8000-00000000000c', 'carol@arc21.test');

-- Alice accumulates a private record of every kind.
insert into public.player_mode_stats (user_id, mode, ruleset_key, hands_played)
values ('00000000-0000-4000-8000-00000000000a', 'solo', 'arc-standard@1', 120);

insert into public.career_progress (user_id, career_node_id, status, first_completed_at)
select '00000000-0000-4000-8000-00000000000a', id, 'completed', now()
from public.career_nodes where code = 'foundations-1';

insert into public.notifications (user_id, kind, title, body)
values ('00000000-0000-4000-8000-00000000000a', 'system', 'Welcome', 'Your table is ready.');

insert into public.push_tokens (user_id, token, platform)
values ('00000000-0000-4000-8000-00000000000a', 'ExponentPushToken[alice-device]', 'ios');

insert into public.user_cosmetics (user_id, cosmetic_id, source)
select '00000000-0000-4000-8000-00000000000a', id, 'default'
from public.cosmetics where code = 'avatar-house-dealer';

insert into public.loadouts (user_id, avatar_cosmetic_id)
select '00000000-0000-4000-8000-00000000000a', id
from public.cosmetics where code = 'avatar-house-dealer';

insert into public.friend_requests (id, sender_id, receiver_id)
values ('00000000-0000-4000-8000-0000000000f1',
        '00000000-0000-4000-8000-00000000000a',
        '00000000-0000-4000-8000-00000000000b');

-- -----------------------------------------------------------------------------
-- Bob, an unrelated authenticated user
-- -----------------------------------------------------------------------------

set local role authenticated;
set local request.jwt.claims to
  '{"sub":"00000000-0000-4000-8000-00000000000b","role":"authenticated"}';

select is_empty(
  $$ select 1 from public.player_stats
     where user_id = '00000000-0000-4000-8000-00000000000a' $$,
  'another user cannot read a player''s lifetime statistics'
);

select is_empty(
  $$ select 1 from public.player_mode_stats
     where user_id = '00000000-0000-4000-8000-00000000000a' $$,
  'another user cannot read a player''s per-mode statistics'
);

select is_empty(
  $$ select 1 from public.career_progress
     where user_id = '00000000-0000-4000-8000-00000000000a' $$,
  'another user cannot read a player''s career progress'
);

select is_empty(
  $$ select 1 from public.notifications
     where user_id = '00000000-0000-4000-8000-00000000000a' $$,
  'another user cannot read a player''s notifications'
);

select is_empty(
  $$ select 1 from public.push_tokens
     where user_id = '00000000-0000-4000-8000-00000000000a' $$,
  'another user cannot read a player''s registered devices'
);

select is_empty(
  $$ select 1 from public.user_cosmetics
     where user_id = '00000000-0000-4000-8000-00000000000a' $$,
  'another user cannot read a player''s cosmetic inventory'
);

select is_empty(
  $$ select 1 from public.loadouts
     where user_id = '00000000-0000-4000-8000-00000000000a' $$,
  'another user cannot read a player''s equipped loadout'
);

-- Bob is the receiver, so the request itself is visible to him.
select is(
  (select count(*) from public.friend_requests
   where id = '00000000-0000-4000-8000-0000000000f1'),
  1::bigint,
  'the receiver can see a friend request addressed to them'
);

-- Accepting is a status change; the friendship edge is created server-side.
select lives_ok(
  $$ update public.friend_requests set status = 'accepted'
     where id = '00000000-0000-4000-8000-0000000000f1' $$,
  'the receiver may accept a friend request'
);

select is(
  (select count(*) from public.friendships),
  1::bigint,
  'accepting created exactly one friendship edge'
);

select throws_ok(
  $$ insert into public.friendships (user_id_a, user_id_b)
     values ('00000000-0000-4000-8000-00000000000b',
             '00000000-0000-4000-8000-00000000000c') $$,
  '42501', null,
  'a user cannot fabricate a friendship edge directly'
);

reset role;

-- -----------------------------------------------------------------------------
-- Carol, a third party to that request
-- -----------------------------------------------------------------------------

set local role authenticated;
set local request.jwt.claims to
  '{"sub":"00000000-0000-4000-8000-00000000000c","role":"authenticated"}';

select is_empty(
  $$ select 1 from public.friend_requests
     where id = '00000000-0000-4000-8000-0000000000f1' $$,
  'a third party cannot see a friend request between two other players'
);

select is_empty(
  $$ select 1 from public.friendships $$,
  'a third party cannot see other players'' friendships'
);

select throws_ok(
  $$ insert into public.friend_requests (sender_id, receiver_id)
     values ('00000000-0000-4000-8000-00000000000a',
             '00000000-0000-4000-8000-00000000000c') $$,
  '42501', null,
  'a user cannot send a friend request in someone else''s name'
);

reset role;

-- -----------------------------------------------------------------------------
-- Profile privacy settings
-- -----------------------------------------------------------------------------

update public.profiles set privacy = 'private'
where id = '00000000-0000-4000-8000-00000000000a';

set local role authenticated;
set local request.jwt.claims to
  '{"sub":"00000000-0000-4000-8000-00000000000c","role":"authenticated"}';

select is_empty(
  $$ select 1 from public.profiles
     where id = '00000000-0000-4000-8000-00000000000a' $$,
  'a private profile is invisible to other players'
);

reset role;

update public.profiles set privacy = 'friends'
where id = '00000000-0000-4000-8000-00000000000a';

set local role authenticated;
set local request.jwt.claims to
  '{"sub":"00000000-0000-4000-8000-00000000000c","role":"authenticated"}';

select is_empty(
  $$ select 1 from public.profiles
     where id = '00000000-0000-4000-8000-00000000000a' $$,
  'a friends-only profile is invisible to a non-friend'
);

reset role;

-- Bob accepted the request above, so he is a friend and may see it.
set local role authenticated;
set local request.jwt.claims to
  '{"sub":"00000000-0000-4000-8000-00000000000b","role":"authenticated"}';

select is(
  (select count(*) from public.profiles
   where id = '00000000-0000-4000-8000-00000000000a'),
  1::bigint,
  'a friends-only profile is visible to a friend'
);

reset role;

update public.profiles set privacy = 'public'
where id = '00000000-0000-4000-8000-00000000000a';

-- A block hides the profile again, in both directions.
insert into public.blocks (blocker_id, blocked_id)
values ('00000000-0000-4000-8000-00000000000a',
        '00000000-0000-4000-8000-00000000000c');

set local role authenticated;
set local request.jwt.claims to
  '{"sub":"00000000-0000-4000-8000-00000000000c","role":"authenticated"}';

select is_empty(
  $$ select 1 from public.profiles
     where id = '00000000-0000-4000-8000-00000000000a' $$,
  'a public profile is hidden from someone its owner has blocked'
);

select is_empty(
  $$ select 1 from public.blocks $$,
  'a blocked user is not told that a block exists'
);

reset role;

select * from finish();

rollback;
