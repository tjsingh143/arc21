-- =============================================================================
-- Arc 21 — the Recovery Grant
--
-- A dead bankroll must not be a dead end, and must not become a purchase
-- funnel. The grant restores a wallet under 2,000 chips TO 5,000, at most once
-- every 12 hours, with every decision made server-side from a locked balance.
--
-- The two rules that matter are tested separately, because a balance check can
-- accidentally stand in for a cooldown check: after one grant the wallet holds
-- 5,000, so a second claim is refused for being *too rich* whether or not the
-- cooldown works at all. The cooldown is therefore tested with the balance
-- pushed back down, where only the cooldown can refuse it.
-- =============================================================================

begin;

create extension if not exists pgtap with schema extensions;
set search_path to public, extensions, pg_catalog;

select plan(8);

select has_function('public', 'claim_recovery_grant', 'the grant is a server function');

-- A signed-in player may ask; anonymous and public may not.
select function_privs_are(
  'public', 'claim_recovery_grant', array[]::text[], 'authenticated', array['EXECUTE'],
  'a signed-in player may claim');
select function_privs_are(
  'public', 'claim_recovery_grant', array[]::text[], 'anon', array[]::text[],
  'an anonymous caller may not claim');

insert into auth.users (id, email, aud, role)
values ('22222222-2222-2222-2222-222222222222', 'grant@arc21.test',
        'authenticated', 'authenticated');

set local role authenticated;
set local request.jwt.claims to
  '{"sub":"22222222-2222-2222-2222-222222222222","role":"authenticated"}';

-- -----------------------------------------------------------------------------
-- Above the threshold: refused
-- -----------------------------------------------------------------------------

select throws_ok(
  'select public.claim_recovery_grant()',
  'P0001',
  null,
  'a wallet at the opening 25,000 is refused'
);

-- -----------------------------------------------------------------------------
-- Below the threshold: restored TO 5,000, not by 5,000
-- -----------------------------------------------------------------------------

set local role postgres;
update public.wallets set balance = 1999
where user_id = '22222222-2222-2222-2222-222222222222';
set local role authenticated;

select lives_ok(
  'select public.claim_recovery_grant()',
  'a wallet at 1,999 is granted'
);

select is(
  (select balance from public.wallets
   where user_id = '22222222-2222-2222-2222-222222222222'),
  5000::bigint,
  'the wallet is restored TO 5,000 — a flat +5,000 would reward spending down'
);

select is(
  (select count(*)::int from public.wallet_ledger
   where user_id = '22222222-2222-2222-2222-222222222222'
     and reason = 'recovery_grant'),
  1,
  'the grant is recorded once in the ledger'
);

-- -----------------------------------------------------------------------------
-- The cooldown, isolated from the balance rule
-- -----------------------------------------------------------------------------

set local role postgres;
update public.wallets set balance = 500
where user_id = '22222222-2222-2222-2222-222222222222';
set local role authenticated;

select throws_ok(
  'select public.claim_recovery_grant()',
  'P0001',
  null,
  'a second claim inside 12 hours is refused even at 500 chips'
);

select * from finish();
rollback;
