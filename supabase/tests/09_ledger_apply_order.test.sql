-- =============================================================================
-- Arc 21 — the ledger must be replayable in the order it was applied
--
-- Written after an attack on the live stack produced this, from two concurrent
-- buy-ins on one account:
--
--   created_at   delta   balance_after
--   ...613007    10000   10000
--   ...633520    -2000    6000
--   ...633522    -2000    8000
--
-- which reads 10000 -> 6000 -> 8000 and is not a valid chain. No chips moved
-- wrongly; `created_at` is transaction-START time, so a transaction that begins
-- first can take the wallet lock second and record an earlier timestamp against
-- a later apply. `seq` is assigned at INSERT, under the lock, so it carries the
-- real order.
-- =============================================================================

begin;

create extension if not exists pgtap with schema extensions;
set search_path to public, extensions, pg_catalog;

select plan(6);

-- -----------------------------------------------------------------------------
-- The column and its indexes exist
-- -----------------------------------------------------------------------------

select has_column('public', 'wallet_ledger', 'seq',
  'wallet_ledger records a monotonic apply order');

-- Uniqueness comes from an index rather than a table constraint, so assert the
-- index. `col_is_unique` reports the first unique constraint on the table,
-- which here is idempotency_key, and would pass or fail for the wrong reason.
select index_is_unique('public', 'wallet_ledger', 'wallet_ledger_seq_key',
  'seq is unique, so it totally orders the ledger');

select has_index('public', 'wallet_ledger', 'wallet_ledger_user_seq_idx',
  'reconciliation can read a user''s ledger in apply order without a sort');

-- -----------------------------------------------------------------------------
-- seq follows lock-acquisition order, and the chain it produces is valid
-- -----------------------------------------------------------------------------

do $$
declare
  v_user uuid := gen_random_uuid();
begin
  insert into auth.users (id, email, aud, role)
  values (v_user, 'ledger-order@arc21.test', 'authenticated', 'authenticated');

  -- The bootstrap trigger creates the wallet and its opening grant.
  perform public.apply_wallet_delta(
    v_user, -2000, 'table_buy_in', 'order-test-1', 'game', null, '{}'::jsonb);
  perform public.apply_wallet_delta(
    v_user, -1500, 'table_buy_in', 'order-test-2', 'game', null, '{}'::jsonb);
  perform public.apply_wallet_delta(
    v_user, 500, 'table_cash_out', 'order-test-3', 'game', null, '{}'::jsonb);

  create temporary table ledger_order_probe as
  select seq, delta, balance_after,
         sum(delta) over (order by seq rows between unbounded preceding and current row) as running
  from public.wallet_ledger
  where user_id = v_user;
end $$;

select is(
  (select count(*)::int from ledger_order_probe where balance_after <> running),
  0,
  'every balance_after equals the running total of deltas ordered by seq'
);

select is(
  (select count(*)::int from ledger_order_probe),
  4,
  'the opening grant and all three movements are recorded'
);

-- seq must strictly increase with each successive apply.
select is(
  (select count(*)::int from (
     select seq, lag(seq) over (order by seq) prev from ledger_order_probe) t
   where prev is not null and seq <= prev),
  0,
  'seq strictly increases, so no two entries share an apply position'
);

select * from finish();
rollback;
