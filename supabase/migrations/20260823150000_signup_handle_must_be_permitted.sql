-- =============================================================================
-- Arc 21 — some accounts could not be created at all
-- =============================================================================
--
-- REPRODUCED, not inferred:
--
--   insert into auth.users (id, …) values ('24552abc-def0-4000-8000-…', …);
--   ERROR:  new row for relation "profiles" violates check constraint
--           "profiles_username_is_permitted"
--   DETAIL: Failing row contains (…, p24552abcdef0, …)
--   CONTEXT: PL/pgSQL function handle_new_user() line 43
--
-- and over HTTP, from the auth container's own log during an ordinary test run:
--
--   {"level":"error","path":"/admin/users","status":500,
--    "error":"… violates check constraint \"profiles_username_is_permitted\" …"}
--
-- `handle_new_user` derives a handle as 'p' plus twelve hex digits of the
-- account id, and never put it through the filter a REQUESTED handle goes
-- through. `username_is_permitted` folds digits before matching — 0→o, 1→i,
-- 3→e, 4→a, 5→s, 7→t — so `p24552abcdef0` folds to `p2ass2abcdef0`, splits on
-- its remaining digits into {p, ass, abcdef0}, and is refused for containing a
-- forbidden whole word.
--
-- Roughly one account in nine hundred, chosen at random by a uuid, met a 500 on
-- sign-up with nothing the player could do about it. It is an MVP acceptance
-- criterion ("Email account") and a Definition-of-Done line ("create an
-- account").
--
-- The whole function is restated because `create or replace` reverts later
-- redefinitions, and this one already had two — `20260813120200_wallets.sql`
-- introduced it and `20260815190000_starting_wallet_and_recovery_reason.sql`
-- redefined it. This starts from the LAST.
-- =============================================================================

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
    /*
     * THE DERIVED HANDLE MUST PASS THE SAME FILTER A REQUESTED ONE DOES.
     *
     * It did not, and the consequence was that some accounts could not be
     * created AT ALL. `username_is_permitted` folds digits before matching —
     * 0→o, 1→i, 3→e, 4→a, 5→s, 7→t — so a handle built from hex digits can fold
     * into a word on the list. `24552abc-…` derives `p24552abcdef0`, which folds
     * to `p2ass2abcdef0` and splits on its digits into {p, ass, abcdef0}. `ass`
     * is a forbidden whole word, the CHECK constraint refuses the row, the
     * trigger aborts, and GoTrue answers the signup with **HTTP 500**.
     *
     * Measured, not theorised: two of them appeared in the auth container's log
     * during one test run, with
     *   'new row for relation "profiles" violates check constraint
     *    "profiles_username_is_permitted"'.
     * Roughly one account in nine hundred, entirely at random, and nothing the
     * player could do about it.
     *
     * A SUFFIX CANNOT REPAIR IT. `p24552abcdef0_1` still contains the segment
     * `ass` once folded, so the old loop would have spun to fifty and raised —
     * a 500 either way. A base whose own characters are the problem needs a
     * different base, so the unpermitted case draws a FRESH random one. The
     * taken-but-permitted case still suffixes, which keeps the handle tied to
     * the account id where it can be.
     */
    v_username := v_base;
    while not public.username_is_permitted(v_username)
       or exists (select 1 from public.profiles where username = v_username) loop
      v_attempt := v_attempt + 1;
      if v_attempt > 50 then
        raise exception 'could not allocate a username for account %', new.id;
      end if;

      if public.username_is_permitted(v_base) then
        -- Free-handle search. Stays within the 20-character limit: 13 + 1 + 2.
        v_username := v_base || '_' || v_attempt::text;
      else
        -- The base itself is refused. Draw another, from a source that has
        -- nothing to do with the account id, and check it the same way.
        v_base := 'p' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 12);
        v_username := v_base;
      end if;
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
comment on function public.handle_new_user() is
  'Bootstraps a profile, stats, a wallet and the 25,000-chip opening grant for a '
  'new account. The derived handle is put through username_is_permitted, exactly '
  'as a requested one is: it was not, and a handle whose hex digits folded into a '
  'forbidden word made the signup fail with HTTP 500.';

revoke execute on function public.handle_new_user() from public, anon, authenticated;

-- Proof, at migration time, against the exact id that reproduced it. A comment
-- claiming a bug is fixed is a comment; this is the check.
do $$
declare
  v_id uuid := '24552abc-def0-4000-8000-0000000000ff';
begin
  if public.username_is_permitted('p24552abcdef0') then
    raise exception 'the filter no longer refuses p24552abcdef0 — this check is now vacuous';
  end if;

  insert into auth.users (id, email, aud, role)
  values (v_id, 'handle-check@arc21.invalid', 'authenticated', 'authenticated');

  if not exists (
    select 1 from public.profiles
    where id = v_id and public.username_is_permitted(username)
  ) then
    raise exception 'the derived handle is still not permitted';
  end if;

  -- Leaves nothing behind. The cascade takes the profile, stats, wallet and
  -- ledger row with it.
  delete from auth.users where id = v_id;
end $$;
