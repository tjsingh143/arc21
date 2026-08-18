-- =============================================================================
-- Arc 21 — the wallet has no client write path
--
-- Three layers stand between a modified client and its own balance: the GRANT,
-- the policy, and the guard trigger. Each is tested with the ones above it
-- deliberately removed, so none of them is passing only because another one is
-- doing the work.
--
--   Layer 1  no GRANT           — the verb does not exist
--   Layer 2  GRANT, no policy   — RLS matches no row / rejects the row
--   Layer 3  GRANT and policy   — the guard trigger rejects the write
--   Layer 4  server role        — CHECK constraints still hold
-- =============================================================================

begin;

create extension if not exists pgtap with schema extensions;
set search_path to public, extensions, pg_catalog;

select plan(26);

insert into auth.users (id, email) values
  ('00000000-0000-4000-8000-00000000000a', 'alice@arc21.test'),
  ('00000000-0000-4000-8000-00000000000b', 'bob@arc21.test');

-- -----------------------------------------------------------------------------
-- Layer 1 — the verbs do not exist for a client role
-- -----------------------------------------------------------------------------

select table_privs_are(
  'public', 'wallets', 'authenticated', array['SELECT'],
  'authenticated holds SELECT and nothing else on wallets'
);

select table_privs_are(
  'public', 'wallet_ledger', 'authenticated', array['SELECT'],
  'authenticated holds SELECT and nothing else on wallet_ledger'
);

select table_privs_are(
  'public', 'wallets', 'anon', array[]::text[],
  'anon holds no privilege at all on wallets'
);

select table_privs_are(
  'public', 'wallet_ledger', 'anon', array[]::text[],
  'anon holds no privilege at all on wallet_ledger'
);

set local role authenticated;
set local request.jwt.claims to
  '{"sub":"00000000-0000-4000-8000-00000000000a","role":"authenticated"}';

select throws_ok(
  $$ insert into public.wallets (user_id, balance)
     values ('00000000-0000-4000-8000-00000000000a', 999999) $$,
  '42501', null,
  'authenticated cannot insert a wallet'
);

select throws_ok(
  $$ update public.wallets set balance = balance + 1000000 $$,
  '42501', null,
  'authenticated cannot update a wallet balance'
);

select throws_ok(
  $$ delete from public.wallets $$,
  '42501', null,
  'authenticated cannot delete a wallet'
);

select throws_ok(
  $$ insert into public.wallet_ledger
       (wallet_id, user_id, delta, balance_after, reason, idempotency_key)
     select id, user_id, 500000, 500000, 'correction', 'forged-entry-0001'
     from public.wallets $$,
  '42501', null,
  'authenticated cannot append to the ledger'
);

select throws_ok(
  $$ update public.wallet_ledger set delta = delta * 10 $$,
  '42501', null,
  'authenticated cannot rewrite ledger history'
);

select throws_ok(
  $$ delete from public.wallet_ledger $$,
  '42501', null,
  'authenticated cannot delete ledger history'
);

-- The server-only chip mover is not reachable from a client session either.
select throws_ok(
  $$ select public.apply_wallet_delta(
       '00000000-0000-4000-8000-00000000000a', 1000000, 'correction', 'rpc-forgery-0001'
     ) $$,
  '42501', null,
  'authenticated cannot call apply_wallet_delta'
);

-- Reads are scoped to the owner.
select is(
  (select count(*) from public.wallets),
  1::bigint,
  'authenticated sees exactly one wallet: their own'
);

select is(
  (select count(*) from public.wallets
   where user_id = '00000000-0000-4000-8000-00000000000b'),
  0::bigint,
  'authenticated cannot see another player''s wallet'
);

select is(
  (select count(*) from public.wallet_ledger
   where user_id = '00000000-0000-4000-8000-00000000000b'),
  0::bigint,
  'authenticated cannot see another player''s ledger'
);

reset role;

-- -----------------------------------------------------------------------------
-- Layer 2 — hand over the missing GRANTs; RLS alone must still hold
-- -----------------------------------------------------------------------------

grant insert, update, delete on public.wallets to authenticated;
grant insert, update, delete on public.wallet_ledger to authenticated;

set local role authenticated;
set local request.jwt.claims to
  '{"sub":"00000000-0000-4000-8000-00000000000a","role":"authenticated"}';

-- With the privilege present, the statement is accepted — and quietly matches
-- nothing, because there is no UPDATE policy for it to satisfy.
select lives_ok(
  $$ update public.wallets set balance = balance + 1000000 $$,
  'with UPDATE granted, the statement itself is no longer refused'
);

select is(
  (select balance from public.wallets
   where user_id = '00000000-0000-4000-8000-00000000000a'),
  25000::bigint,
  'but RLS matched no row, so not a single chip moved'
);

select throws_ok(
  $$ insert into public.wallet_ledger
       (wallet_id, user_id, delta, balance_after, reason, idempotency_key)
     values ('00000000-0000-4000-8000-0000000000ff',
             '00000000-0000-4000-8000-00000000000a',
             500000, 500000, 'correction', 'forged-entry-0002') $$,
  '42501', null,
  'with INSERT granted, RLS rejects a forged ledger entry'
);

reset role;

-- -----------------------------------------------------------------------------
-- Layer 3 — hand over permissive policies too; the guard triggers must hold
-- -----------------------------------------------------------------------------

create policy wallets_layer3_update on public.wallets
  for update to authenticated using (true) with check (true);
create policy wallet_ledger_layer3_insert on public.wallet_ledger
  for insert to authenticated with check (true);

set local role authenticated;
set local request.jwt.claims to
  '{"sub":"00000000-0000-4000-8000-00000000000a","role":"authenticated"}';

select throws_ok(
  $$ update public.wallets set balance = balance + 1000000 $$,
  '42501', null,
  'with GRANT and a permissive policy, the wallet guard trigger still refuses'
);

select throws_ok(
  $$ insert into public.wallet_ledger
       (wallet_id, user_id, delta, balance_after, reason, idempotency_key)
     select id, user_id, 500000, 510000, 'correction', 'forged-entry-0003'
     from public.wallets $$,
  '42501', null,
  'with GRANT and a permissive policy, the append-only guard still refuses'
);

reset role;

drop policy wallets_layer3_update on public.wallets;
drop policy wallet_ledger_layer3_insert on public.wallet_ledger;
revoke insert, update, delete on public.wallets from authenticated;
revoke insert, update, delete on public.wallet_ledger from authenticated;

-- -----------------------------------------------------------------------------
-- Layer 4 — constraints hold for the server as well
-- -----------------------------------------------------------------------------

select throws_ok(
  $$ update public.wallets set balance = -1
     where user_id = '00000000-0000-4000-8000-00000000000a' $$,
  '23514', null,
  'a wallet balance cannot go negative, not even under a server role'
);

-- Exactly one chip more than the wallet holds. A round number that merely
-- happened to exceed the old opening balance passed for the wrong reason once
-- the grant changed: the debit succeeded, and the NEXT test then read a wallet
-- 20,000 chips lighter than it expected.
select throws_ok(
  $$ select public.apply_wallet_delta(
       '00000000-0000-4000-8000-00000000000a', -25001, 'table_buy_in', 'overdraw-0001'
     ) $$,
  '23514', null,
  'a chip movement one chip beyond the balance is rejected by a constraint'
);

select throws_ok(
  $$ insert into public.wallet_ledger
       (wallet_id, user_id, delta, balance_after, reason, idempotency_key)
     select id, user_id, 10, 10010, 'correction',
            'initial_grant:00000000-0000-4000-8000-00000000000a'
     from public.wallets
     where user_id = '00000000-0000-4000-8000-00000000000a' $$,
  '23505', null,
  'a duplicate idempotency key is rejected'
);

-- A replayed economic command credits exactly once.
select lives_ok(
  $$ select public.apply_wallet_delta(
       '00000000-0000-4000-8000-00000000000a', 250, 'career_reward', 'career:foundations-1'
     ) $$,
  'the first career reward credit succeeds'
);

select lives_ok(
  $$ select public.apply_wallet_delta(
       '00000000-0000-4000-8000-00000000000a', 250, 'career_reward', 'career:foundations-1'
     ) $$,
  'replaying the same reward is accepted rather than erroring'
);

select is(
  (select balance from public.wallets
   where user_id = '00000000-0000-4000-8000-00000000000a'),
  25250::bigint,
  'the replayed reward credited exactly once'
);

select is(
  (select count(*) from public.wallet_ledger
   where idempotency_key = 'career:foundations-1'),
  1::bigint,
  'exactly one ledger row exists for the replayed reward'
);

select * from finish();

rollback;
