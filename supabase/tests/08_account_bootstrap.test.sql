-- =============================================================================
-- Arc 21 — account bootstrap
--
-- A new auth account materialises its profile, statistics row, wallet and
-- opening ledger entry in one server-side trigger. There is no client INSERT
-- path into any of the four, so this is the only way they come into existence.
--
-- The username fallback is exercised deliberately: account ids that share their
-- first twelve hex digits derive the same handle, and the resolution must
-- produce a different one rather than retrying the same string.
-- =============================================================================

begin;

create extension if not exists pgtap with schema extensions;
set search_path to public, extensions, pg_catalog;

select plan(13);

insert into auth.users (id, email, raw_user_meta_data) values
  ('00000000-0000-4000-8000-00000000000a', 'alice@arc21.test',
   '{"username": "ada_l", "display_name": "Ada"}'::jsonb),
  ('00000000-0000-4000-8000-00000000000b', 'bob@arc21.test', '{}'::jsonb),
  ('00000000-0000-4000-8000-00000000000c', 'carol@arc21.test', '{}'::jsonb),
  ('11111111-1111-4111-8111-111111111111', 'dave@arc21.test',
   '{"username": "ada_l"}'::jsonb);

select is(
  (select username from public.profiles
   where id = '00000000-0000-4000-8000-00000000000a'),
  'ada_l',
  'a valid requested username is honoured'
);

select is(
  (select display_name from public.profiles
   where id = '00000000-0000-4000-8000-00000000000a'),
  'Ada',
  'a requested display name is honoured'
);

select isnt(
  (select username from public.profiles
   where id = '11111111-1111-4111-8111-111111111111'),
  'ada_l',
  'a username that is already taken is not handed out twice'
);

-- Bob and Carol share the first twelve hex digits of their account ids.
select isnt(
  (select username from public.profiles
   where id = '00000000-0000-4000-8000-00000000000b'),
  (select username from public.profiles
   where id = '00000000-0000-4000-8000-00000000000c'),
  'colliding derived usernames are resolved to distinct handles'
);

-- Every assertion below is scoped to this file's four fixture accounts rather
-- than to the whole table. A global `count(*) from public.profiles` asserts that
-- the database contains nothing else, which makes the suite pass only against a
-- database nobody has touched — true immediately after `supabase db reset` and
-- false the moment a developer, a seed change or a running app creates an
-- account. The behaviour under test (the bootstrap trigger) is per-account, so
-- scoping loses no coverage.
create temporary table bootstrap_fixture (user_id uuid primary key) on commit drop;
insert into bootstrap_fixture values
  ('00000000-0000-4000-8000-00000000000a'),
  ('00000000-0000-4000-8000-00000000000b'),
  ('00000000-0000-4000-8000-00000000000c'),
  ('11111111-1111-4111-8111-111111111111');

select is(
  (select count(*) from public.profiles p
   join bootstrap_fixture f on f.user_id = p.id
   where p.username !~ '^[a-z0-9_]{3,20}$'),
  0::bigint,
  'every generated username satisfies the handle format'
);

select is(
  (select count(*) from public.profiles p join bootstrap_fixture f on f.user_id = p.id),
  4::bigint,
  'one profile per account, created by the trigger'
);

select is(
  (select count(*) from public.wallets w
   join bootstrap_fixture f on f.user_id = w.user_id
   where w.balance <> 25000),
  0::bigint,
  'every new account opens with the same 25,000 chip grant'
);

select is(
  (select count(*) from public.wallet_ledger l
   join bootstrap_fixture f on f.user_id = l.user_id
   where l.reason = 'initial_grant'),
  4::bigint,
  'the opening grant is recorded in the ledger, one entry per account'
);

select is(
  (select count(*) from public.player_stats s join bootstrap_fixture f on f.user_id = s.user_id),
  4::bigint,
  'a statistics row is created alongside each profile'
);

-- ---------------------------------------------------------------------------
-- A handle the filter refuses must not stop the account existing
-- ---------------------------------------------------------------------------
-- Some accounts could not be created AT ALL. The derived handle — 'p' plus
-- twelve hex digits of the account id — never went through the filter a
-- REQUESTED handle goes through, and `username_is_permitted` folds digits
-- before matching (0→o 1→i 3→e 4→a 5→s 7→t). So `p24552abcdef0` folds to
-- `p2ass2abcdef0`, splits on its digits into {p, ass, abcdef0}, and is refused.
-- The CHECK rejected the row, the trigger aborted, and GoTrue answered the
-- signup with HTTP 500 — about one account in nine hundred, at random.

select ok(
  not public.username_is_permitted('p24552abcdef0'),
  'the filter still refuses the handle that reproduced it, so this test is not vacuous'
);

insert into auth.users (id, email, aud, role) values
  ('24552abc-def0-4000-8000-00000000000a', 'fold-a@arc21.test', 'authenticated', 'authenticated');

select is(
  (select count(*)::int from public.profiles where id = '24552abc-def0-4000-8000-00000000000a'),
  1,
  'an account whose derived handle folds into a forbidden word is still created'
);

select ok(
  (select public.username_is_permitted(username)
   from public.profiles where id = '24552abc-def0-4000-8000-00000000000a'),
  'and the handle it was given passes the same filter a rename would'
);

-- The ordinary collision path is unchanged: a permitted base that is taken gets
-- a suffix, and stays tied to the account id.
insert into auth.users (id, email, aud, role) values
  ('1a2b3c4d-5e6f-4000-8000-00000000000b', 'coll-a@arc21.test', 'authenticated', 'authenticated');
update public.profiles set username = 'p1a2b3c4d5e6f'
where id = '1a2b3c4d-5e6f-4000-8000-00000000000b';
insert into auth.users (id, email, aud, role) values
  ('1a2b3c4d-5e6f-4000-8000-00000000000c', 'coll-b@arc21.test', 'authenticated', 'authenticated');

select is(
  (select username from public.profiles where id = '1a2b3c4d-5e6f-4000-8000-00000000000c'),
  'p1a2b3c4d5e6f_1',
  'a permitted handle that is taken is suffixed, not replaced'
);

select * from finish();

rollback;
