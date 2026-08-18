-- =============================================================================
-- Arc 21 — account deletion
--
-- Required by the specification and by both app stores. The policy is a hard
-- delete: virtual chips have no value and cannot be redeemed, so there is
-- nothing to reconcile against a departed account and a shadow copy of their
-- history would be a privacy cost with no benefit.
--
-- Personal tables cascade from `auth.users`. Shared history — the sessions and
-- hands other people also sat at — is `on delete set null`, so a game is never
-- deleted out from under the players who remain in it.
-- =============================================================================

begin;

create extension if not exists pgtap with schema extensions;
set search_path to public, extensions, pg_catalog;

select plan(7);

select has_function('public', 'delete_own_account', 'a player can delete their own account');

select function_privs_are(
  'public', 'delete_own_account', array[]::text[], 'authenticated', array['EXECUTE'],
  'a signed-in player may delete their account');
select function_privs_are(
  'public', 'delete_own_account', array[]::text[], 'anon', array[]::text[],
  'an anonymous caller may not');

insert into auth.users (id, email, aud, role)
values ('44444444-4444-4444-4444-444444444444', 'leaving@arc21.test',
        'authenticated', 'authenticated');

-- The bootstrap trigger gives this account a profile, stats and a funded wallet.
select is(
  (select count(*)::int from public.wallets
   where user_id = '44444444-4444-4444-4444-444444444444'),
  1,
  'the account exists and holds a wallet before deletion'
);

set local role authenticated;
set local request.jwt.claims to
  '{"sub":"44444444-4444-4444-4444-444444444444","role":"authenticated"}';

select lives_ok(
  'select public.delete_own_account()',
  'the account deletes itself'
);

set local role postgres;

select is(
  (select count(*)::int from auth.users
   where id = '44444444-4444-4444-4444-444444444444'),
  0,
  'the auth record is gone'
);

-- Every personal table at once: a per-table assertion would silently miss a
-- table added later without a cascade.
select is(
  (
    (select count(*)::int from public.profiles      where id      = '44444444-4444-4444-4444-444444444444') +
    (select count(*)::int from public.wallets       where user_id = '44444444-4444-4444-4444-444444444444') +
    (select count(*)::int from public.wallet_ledger where user_id = '44444444-4444-4444-4444-444444444444') +
    (select count(*)::int from public.player_stats  where user_id = '44444444-4444-4444-4444-444444444444') +
    (select count(*)::int from public.career_progress where user_id = '44444444-4444-4444-4444-444444444444') +
    (select count(*)::int from public.user_cosmetics  where user_id = '44444444-4444-4444-4444-444444444444')
  ),
  0,
  'profile, wallet, ledger, stats, career progress and cosmetics are all erased'
);

select * from finish();
rollback;
