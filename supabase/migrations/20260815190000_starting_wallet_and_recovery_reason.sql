-- Bring the opening wallet to the specified figure, and name the Recovery Grant.
--
-- The specification says a registered user starts with 25,000 virtual chips.
-- This project had been seeding 10,000 — not a considered deviation, just a
-- number that was never reconciled against the document.
--
-- The function below is the existing `handle_new_user` reproduced verbatim with
-- only that amount changed. It is repeated in full because PostgreSQL replaces
-- a function wholesale; the first attempt at this migration paraphrased the
-- body from memory and silently dropped the requested-username handling, the
-- reserved-name filter and the collision suffixing — the trigger then failed
-- the username CHECK on the very next signup. If this needs changing again,
-- copy the current definition. Do not retype it.
--
-- Only accounts created from now on are affected. Back-filling existing wallets
-- would write a grant that was never made, and the ledger is an audit trail
-- before it is a convenience.
--
-- `recovery_grant` is added to the ledger reasons here but deliberately not
-- used until the next migration: PostgreSQL will not let a new enum value be
-- used in the transaction that introduced it.

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  -- Client-controlled: `raw_user_meta_data` is whatever the signup request
  -- sent. It is normalised and put through the same reserved-name filter a
  -- rename goes through, and falls back to a derived handle if it fails.
  v_requested text := lower(btrim(nullif(new.raw_user_meta_data ->> 'username', '')));
  -- 13 characters: 'p' plus twelve hex digits of the account id.
  v_base      text := 'p' || substr(replace(new.id::text, '-', ''), 1, 12);
  v_username  text;
  v_attempt   integer := 0;
  v_display   text;
  v_wallet_id uuid;
begin
  if v_requested is not null
     and public.username_is_permitted(v_requested)
     and not exists (select 1 from public.profiles where username = v_requested)
  then
    v_username := v_requested;
  else
    -- The derived handle is not unique on its own: two account ids can share
    -- their first twelve hex digits. Suffix until a free handle is found rather
    -- than retrying the same string, which would loop forever on a collision.
    v_username := v_base;
    while exists (select 1 from public.profiles where username = v_username) loop
      v_attempt := v_attempt + 1;
      if v_attempt > 50 then
        raise exception 'could not allocate a username for account %', new.id;
      end if;
      -- Stays within the 20-character limit: 13 + 1 + at most 2 digits.
      v_username := v_base || '_' || v_attempt::text;
    end loop;
  end if;

  -- Sanitise, then truncate, then sanitise again: truncating to 24 characters
  -- can leave a trailing space, and a name that is nothing but zero-width
  -- characters sanitises to null and falls back to the handle.
  v_display := public.sanitise_display_name(
    nullif(new.raw_user_meta_data ->> 'display_name', '')
  );
  v_display := left(coalesce(v_display, v_username), 24);
  v_display := coalesce(public.sanitise_display_name(v_display), v_username);

  insert into public.profiles (id, username, display_name)
  values (new.id, v_username, v_display);

  insert into public.player_stats (user_id) values (new.id);

  insert into public.wallets (user_id, balance, lifetime_credited)
  values (new.id, 25000, 25000)
  returning id into v_wallet_id;

  insert into public.wallet_ledger (
    wallet_id, user_id, delta, balance_after, reason, idempotency_key
  )
  values (
    v_wallet_id, new.id, 25000, 25000, 'initial_grant',
    'initial_grant:' || new.id::text
  );

  return new;
end;
$$;

revoke execute on function public.handle_new_user() from public, anon, authenticated;

alter type public.ledger_reason add value if not exists 'recovery_grant';
