-- The Recovery Grant: a dead bankroll must not be a dead end.
--
-- Specification: if the wallet holds under 2,000, top it back up to 5,000, at
-- most once every 12 hours. There is no advertisement, no wheel, no purchase
-- offer and no cooldown-skip — the whole point of this mechanism is that a
-- player who runs out is never routed toward spending money. If they are not
-- yet eligible, Practice remains unlimited and free.
--
-- Everything is decided server-side. The caller supplies no user id, no balance
-- and no amount; identity comes from the verified session and the top-up is
-- computed from the authoritative balance under a row lock.

create or replace function public.claim_recovery_grant()
returns public.wallet_ledger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_user_id   uuid := auth.uid();
  v_wallet    public.wallets;
  v_last_at   timestamptz;
  v_ordinal   int;
  v_delta     bigint;
begin
  if v_user_id is null then
    raise exception 'a recovery grant requires an authenticated session'
      using errcode = '42501';
  end if;

  -- Lock first, for the same reason apply_wallet_delta does: two concurrent
  -- claims must serialise here, so the second one re-reads a balance of 5,000
  -- and is refused rather than granting twice.
  select * into v_wallet
  from public.wallets
  where user_id = v_user_id
  for update;

  if not found then
    raise exception 'no wallet for user %', v_user_id using errcode = 'P0002';
  end if;

  if v_wallet.balance >= 2000 then
    raise exception
      'a recovery grant is only available below 2000 chips (balance is %)',
      v_wallet.balance
      using errcode = 'P0001';
  end if;

  select max(created_at), count(*)
  into v_last_at, v_ordinal
  from public.wallet_ledger
  where user_id = v_user_id and reason = 'recovery_grant';

  if v_last_at is not null and v_last_at > now() - interval '12 hours' then
    raise exception
      'the next recovery grant is available at %', v_last_at + interval '12 hours'
      using errcode = 'P0001';
  end if;

  -- Restore TO 5,000 rather than adding a flat 5,000, so the grant cannot be
  -- farmed by spending down to 1,999 repeatedly for a larger net gain.
  v_delta := 5000 - v_wallet.balance;

  -- The ordinal makes the key deterministic for a retry of THIS claim while
  -- still permitting a genuine future grant, which a fixed key would block
  -- forever and a random one would not deduplicate at all.
  return public.apply_wallet_delta(
    v_user_id,
    v_delta,
    'recovery_grant',
    'recovery_grant:' || v_user_id::text || ':' || v_ordinal::text,
    'wallet',
    null,
    jsonb_build_object('balance_before', v_wallet.balance)
  );
end;
$$;

comment on function public.claim_recovery_grant() is
  'Restores a wallet under 2000 chips to 5000, at most once per 12 hours. '
  'Derives identity from the session and computes the amount from the locked '
  'authoritative balance — the client supplies nothing.';

-- Callable by a signed-in player, but every decision inside is the server''s.
revoke execute on function public.claim_recovery_grant() from public, anon;
grant execute on function public.claim_recovery_grant() to authenticated;
