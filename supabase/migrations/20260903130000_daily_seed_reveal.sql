-- =============================================================================
-- Arc 21 — publishing a closed challenge's seed
--
-- THE HOLE, and it is the whole point of the commitment.
--
-- `daily_challenges` has carried `revealed_seed` and `seed_revealed_at` since
-- the table was created. A trigger refuses a reveal before `closes_at` and
-- refuses one that does not match the secret; the client projection carries the
-- column; `daily.ts` parses it; the Daily screen renders `Seed: …` when it is
-- there; and `describeVerification` tells the player, in so many words, that
-- "the seed itself stays secret until the challenge closes, then it can be
-- checked against this hash".
--
-- **Nothing in this repository ever wrote the column.** Outside pgTAP, no code
-- path sets `revealed_seed` — so the seed was never published, the render branch
-- was dead, and the promise on the screen could not be kept by anybody. The
-- commitment migration's own header warns about exactly this: "a commitment
-- nobody checks is theatre". A commitment nobody CAN check is worse.
--
-- The specification: "After challenge closes, the seed may become publicly
-- viewable in an audit/fairness view."
--
-- -----------------------------------------------------------------------------
-- ON DEMAND, NOT ON A SCHEDULE
-- -----------------------------------------------------------------------------
-- The same reasoning `ensure_daily_challenge_for` is built on, and the same
-- shape `create_private_room` uses when it calls `expire_stale_rooms()`: a cron
-- job that has not run is an outage, and a row written by the first person to
-- look at the screen cannot be late. `ensure_todays_daily_challenge` reveals
-- everything that has closed as its first act, so opening the Daily screen
-- publishes yesterday's seed.
--
-- -----------------------------------------------------------------------------
-- WHY THIS CANNOT LEAK A LIVE SEED
-- -----------------------------------------------------------------------------
-- Three independent things have to agree before a byte moves:
--
--   1. `where closes_at <= now()` here;
--   2. `guard_daily_challenge_seed` raises 42501 for a reveal before
--      `closes_at`, whoever attempts it and however they reach the row;
--   3. `revealed_seed` is a different column from `seed_secret`, and the
--      `authenticated` grant lists the first and not the second — so even a
--      reveal that somehow ran early would still be reading a column the
--      privilege system permits, rather than opening the one it does not.
-- =============================================================================

create or replace function public.reveal_closed_daily_seeds()
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_revealed integer := 0;
begin
  update public.daily_challenges
  set revealed_seed    = seed_secret,
      seed_revealed_at = now()
  where closes_at <= now()
    and revealed_seed is null;

  get diagnostics v_revealed = row_count;
  return v_revealed;
end;
$$;

comment on function public.reveal_closed_daily_seeds() is
  'Publishes the seed of every challenge whose window has closed, so the '
  'commitment published before play can actually be checked. Idempotent. '
  'Server-only: the guard trigger refuses an early reveal independently.';

revoke execute on function public.reveal_closed_daily_seeds() from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- The audit view's row
-- ---------------------------------------------------------------------------
--
-- The most recently CLOSED challenge whose seed has been published, which is
-- what a fairness view can actually show: today's seed is secret by design, so
-- a screen offering to verify today would be offering nothing.
--
-- Returns the commitment and the seed and no opinion about whether they match.
-- The point of a commitment is that the player's own device recomputes the
-- hash; a server that also answered "yes, it matches" would be asking to be
-- believed twice.
create or replace function public.latest_verifiable_daily_challenge()
returns table (
  challenge_date   date,
  seed_commitment  text,
  revealed_seed    text,
  seed_revealed_at timestamptz
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select c.challenge_date, c.seed_commitment, c.revealed_seed, c.seed_revealed_at
  from public.daily_challenges c
  where c.revealed_seed is not null
  order by c.challenge_date desc
  limit 1;
$$;

comment on function public.latest_verifiable_daily_challenge() is
  'The most recent challenge whose seed has been published, for the fairness '
  'view. Never returns a live challenge: a row is only here once revealed, and '
  'a reveal cannot happen before closes_at.';

revoke execute on function public.latest_verifiable_daily_challenge() from public, anon;
grant  execute on function public.latest_verifiable_daily_challenge() to authenticated;

-- ---------------------------------------------------------------------------
-- Today's challenge, and yesterday's seed
-- ---------------------------------------------------------------------------
--
-- Body copied VERBATIM from `20260817200000_daily_challenge_and_sprint.sql`, the
-- LAST migration to define this function, with one line added. `create or
-- replace function` replaces a body wholesale, and starting from anything but
-- the newest version is how this repository has already lost a `notify_user`
-- call and an `expire_stale_rooms()` call.
create or replace function public.ensure_todays_daily_challenge()
returns public.daily_challenges_public
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_date   date := (now() at time zone 'utc')::date;
  v_public public.daily_challenges_public;
begin
  if auth.uid() is null then
    raise exception 'the daily challenge requires an authenticated session' using errcode = '42501';
  end if;

  -- Anything whose window has closed becomes verifiable. Here rather than on a
  -- schedule, for the reason the row below is created here rather than on one.
  perform public.reveal_closed_daily_seeds();

  perform public.ensure_daily_challenge_for(v_date);

  -- Read back through the client-facing projection, so this function cannot
  -- return the secret even by accident. The view does not carry the column.
  select * into v_public from public.daily_challenges_public where challenge_date = v_date;
  return v_public;
end;
$$;

comment on function public.ensure_todays_daily_challenge() is
  'Returns today''s challenge, creating it if absent and publishing the seed of '
  'any challenge that has closed. Never returns seed_secret: the projection it '
  'reads does not carry the column.';

revoke execute on function public.ensure_todays_daily_challenge() from public, anon;
grant  execute on function public.ensure_todays_daily_challenge() to authenticated;

-- ---------------------------------------------------------------------------
-- The gate learns about `latest_verifiable_daily_challenge`
-- ---------------------------------------------------------------------------
--
-- Copied VERBATIM from `20260830130000_room_lifecycle_and_presence.sql`, the
-- LAST file to define it, with one name added to the allowlist. `create or
-- replace function` replaces a body wholesale, so starting from any earlier
-- version silently reverts every check added since.
--
-- The gate refused this migration on its first run, which is the gate working:
-- a new `authenticated` RPC is a decision, not a side effect.

create or replace function public.assert_client_authorization_surface()
returns void
language plpgsql
security definer
set search_path = public, pg_catalog, pg_temp
as $$
declare
  v_offenders text;

  -- Functions `anon` may execute. The original gate's list, restored.
  --
  -- `is_client_role` is here because the guard triggers execute with the
  -- invoker's rights and call it; it reports the caller's own role and nothing
  -- else.
  c_anon_functions constant text[] := array[
    'is_client_role'
  ];

  -- Functions `authenticated` may execute, in four groups:
  --
  --   * the CALLER-SCOPED relationship predicates the RLS policies need. The
  --     two-argument `are_friends`/`has_blocked` are deliberately absent: EXECUTE
  --     on those turns them into a PostgREST oracle over the whole social graph.
  --   * the guard and constraint helpers, which run with the invoker's rights
  --     inside triggers and CHECK constraints and therefore cannot be revoked
  --     without breaking ordinary writes.
  --   * `enforce_rate_limit`, which takes no user id and can only ever spend the
  --     caller's own budget.
  --   * the RPCs the app actually calls. Every one of these was checked against
  --     a `.rpc(` call site.
  --
  -- `apply_wallet_delta` is absent, and is checked for by name below as well.
  c_authenticated_functions constant text[] := array[
    -- relationship predicates
    'caller_is_room_member',
    'is_session_participant',
    'viewer_has_blocked',
    'viewer_is_blocked_by',
    'viewer_is_friend_of',
    'viewer_is_in_tournament',
    -- guard and constraint helpers
    'is_client_role',
    'level_from_total_xp',
    'notification_data_is_safe',
    'sanitise_display_name',
    'username_is_permitted',
    -- the caller's own rate-limit budget
    'enforce_rate_limit',
    -- friends
    'accept_friend_request', 'block_player', 'decline_friend_request',
    'list_blocked', 'list_friend_requests', 'list_friends', 'remove_friend',
    'search_players', 'send_friend_request', 'unblock_player',
    -- rooms and matchmaking
    'create_private_room', 'get_room_state', 'invite_friend_to_room',
    'join_matchmaking', 'join_private_room', 'leave_matchmaking', 'leave_room',
    'poll_matchmaking', 'remove_room_member', 'set_room_ready',
    -- competition
    'ensure_todays_daily_challenge', 'latest_verifiable_daily_challenge',
    'my_daily_entry', 'my_sprint_entry',
    'sprint_format', 'sprint_standings',
    -- leaderboards
    'leaderboard_daily_challenge', 'leaderboard_strategy_accuracy',
    'leaderboard_tournament_wins', 'leaderboard_weekly_xp',
    'my_leaderboard_position', 'my_strategy_accuracy_progress',
    -- career
    'my_career_progress',
    -- the caller's own competition totals
    'my_competition_record',
    -- one other player's profile, as this caller may see it
    'player_public_profile',
    -- progression and cosmetics
    'equip_cosmetic', 'grant_earned_cosmetics', 'my_inventory', 'my_level_progress',
    'my_loadout',
    -- notifications
    'mark_notifications_read', 'my_notifications', 'register_push_token',
    'retire_push_token', 'unread_notification_count',
    -- account
    'claim_recovery_grant', 'delete_own_account',
    -- presence: the caller's own last_seen_at, and nobody else's
    'touch_last_seen',
    -- where the caller's own chips are, so a refused buy-in can say so
    'my_active_session'
  ];

  -- Tables a client is genuinely allowed to write, and the verbs it may use.
  -- Unchanged from the original gate: nothing has been added to it since, which
  -- is itself worth knowing.
  c_allowed_writes constant text[] := array[
    'profiles:UPDATE',
    'friend_requests:INSERT',
    'friend_requests:UPDATE',
    'friendships:DELETE',
    'blocks:INSERT',
    'blocks:DELETE',
    'loadouts:INSERT',
    'loadouts:UPDATE',
    'push_tokens:INSERT',
    'push_tokens:UPDATE',
    'push_tokens:DELETE',
    'notifications:UPDATE',
    'notifications:DELETE'
  ];
begin
  -- 1. RLS on every table in public.
  select string_agg(c.relname, ', ' order by c.relname)
  into v_offenders
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity;

  if v_offenders is not null then
    raise exception 'RLS is not enabled on public table(s): %', v_offenders;
  end if;

  -- 2. Nothing in `private` is reachable by an API role.
  select string_agg(distinct format('%s->%s(%s)', table_name, grantee, privilege_type), ', ')
  into v_offenders
  from information_schema.role_table_grants
  where table_schema = 'private' and grantee in ('anon', 'authenticated', 'service_role');

  if v_offenders is not null then
    raise exception 'private schema has grants to API roles: %', v_offenders;
  end if;

  if has_schema_privilege('anon', 'private', 'USAGE')
     or has_schema_privilege('authenticated', 'private', 'USAGE')
     or has_schema_privilege('service_role', 'private', 'USAGE') then
    raise exception 'an API role holds USAGE on the private schema';
  end if;

  /*
   * 2b. RLS ON EVERY TABLE IN `private` TOO.
   *
   * New here. Block 1 only ever looked at `public`, so `private` relied
   * entirely on the schema carrying no USAGE — one grant away from being the
   * only thing standing between a client and the shoe. Two of the three
   * private tables already had RLS on with no policies; `career_drill_seeds`
   * was added later and did not, and nothing noticed because nothing asked.
   */
  select string_agg(c.relname, ', ' order by c.relname)
  into v_offenders
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'private' and c.relkind = 'r' and not c.relrowsecurity;

  if v_offenders is not null then
    raise exception 'RLS is not enabled on private table(s): %', v_offenders;
  end if;

  /*
   * 3. NO FUNCTION IN public IS EXECUTABLE BY PUBLIC.
   *
   * The check that would have caught everything this file had to narrow. A new
   * function's default ACL is EXECUTE TO PUBLIC, so a migration that writes only
   * `grant … to authenticated` leaves it reachable by `anon` — and reads as if
   * it did not. This needs no allowlist and never goes out of date.
   */
  select string_agg(p.proname, ', ' order by p.proname)
  into v_offenders
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and p.proacl is not null
    and exists (
      select 1 from aclexplode(p.proacl) a
      where a.grantee = 0 and a.privilege_type = 'EXECUTE'
    );

  if v_offenders is not null then
    raise exception
      'public function(s) executable by PUBLIC — add `revoke execute … from public`: %',
      v_offenders;
  end if;

  -- A function that has never been granted or revoked at all carries a NULL acl,
  -- which ALSO means EXECUTE TO PUBLIC. Postgres stores the default implicitly,
  -- so the check above cannot see it and this one is not a duplicate.
  select string_agg(p.proname, ', ' order by p.proname)
  into v_offenders
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proacl is null;

  if v_offenders is not null then
    raise exception
      'public function(s) with a default ACL, which is EXECUTE TO PUBLIC: %', v_offenders;
  end if;

  -- 4 & 5. The deliberate grants.
  select string_agg(p.proname, ', ' order by p.proname)
  into v_offenders
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and has_function_privilege('anon', p.oid, 'EXECUTE')
    and p.proname <> all (c_anon_functions);

  if v_offenders is not null then
    raise exception 'anon can execute unexpected public function(s): %', v_offenders;
  end if;

  select string_agg(p.proname, ', ' order by p.proname)
  into v_offenders
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and has_function_privilege('authenticated', p.oid, 'EXECUTE')
    and p.proname <> all (c_authenticated_functions);

  if v_offenders is not null then
    raise exception 'authenticated can execute unexpected public function(s): %', v_offenders;
  end if;

  -- The one that would matter most if it ever slipped.
  if has_function_privilege('anon', 'public.apply_wallet_delta(uuid, bigint, public.ledger_reason, text, text, uuid, jsonb)', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.apply_wallet_delta(uuid, bigint, public.ledger_reason, text, text, uuid, jsonb)', 'EXECUTE') then
    raise exception 'a client role can execute apply_wallet_delta';
  end if;

  -- And the two that name a user id to charge a rate limit against.
  select string_agg(p.proname, ', ' order by p.proname)
  into v_offenders
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and p.proname in ('consume_rate_limit', 'rate_limit_check', 'rate_limit_for',
                      'record_decisions', 'record_daily_attempt_decisions', 'notify_user')
    and (has_function_privilege('anon', p.oid, 'EXECUTE')
         or has_function_privilege('authenticated', p.oid, 'EXECUTE'));

  if v_offenders is not null then
    raise exception 'a client role can execute a server-only function: %', v_offenders;
  end if;

  -- 6. No unexpected write privilege.
  select string_agg(distinct format('%s:%s(%s)', table_name, privilege_type, grantee), ', ')
  into v_offenders
  from information_schema.role_table_grants
  where table_schema = 'public'
    and grantee in ('anon', 'authenticated')
    and privilege_type in ('INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES')
    and (table_name || ':' || privilege_type) <> all (c_allowed_writes);

  if v_offenders is not null then
    raise exception 'unexpected client write privilege(s): %', v_offenders;
  end if;

  -- 7. Column-level write grants on the money tables. `role_table_grants` and
  -- `has_table_privilege` both report TABLE-level grants only, so neither sees
  -- `grant update (balance) on wallets`.
  select string_agg(
           distinct format('%s.%s->%s(%s)', c.table_name, c.column_name, c.grantee, c.privilege_type),
           ', '
         )
  into v_offenders
  from information_schema.column_privileges c
  where c.table_schema = 'public'
    and c.table_name in ('wallets', 'wallet_ledger')
    and c.grantee in ('anon', 'authenticated')
    and c.privilege_type in ('INSERT', 'UPDATE', 'REFERENCES');

  if v_offenders is not null then
    raise exception 'client role holds a column-level write grant on a money table: %', v_offenders;
  end if;

  if has_column_privilege('authenticated', 'public.profiles', 'level', 'UPDATE')
     or has_column_privilege('authenticated', 'public.profiles', 'xp', 'UPDATE')
     or has_column_privilege('authenticated', 'public.profiles', 'username_changed_at', 'UPDATE') then
    raise exception 'authenticated can update a server-owned profiles column';
  end if;

  if has_column_privilege('authenticated', 'public.daily_challenges', 'seed_secret', 'SELECT')
     or has_column_privilege('anon', 'public.daily_challenges', 'seed_secret', 'SELECT') then
    raise exception 'a client role can read daily_challenges.seed_secret';
  end if;

  -- 8. Views must not launder RLS. A view owned by a privileged role runs with
  -- that owner's rights unless declared `security_invoker`, and block 1 never
  -- looks at one because it filters `relkind = 'r'`.
  select string_agg(c.relname, ', ' order by c.relname)
  into v_offenders
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public'
    and c.relkind in ('v', 'm')
    and (has_table_privilege('authenticated', c.oid, 'SELECT')
         or has_table_privilege('anon', c.oid, 'SELECT'))
    and coalesce(
          (select o.option_value
           from pg_options_to_table(c.reloptions) as o(option_name, option_value)
           where o.option_name = 'security_invoker'),
          'false'
        ) <> 'true';

  if v_offenders is not null then
    raise exception
      'client-readable view(s) without security_invoker, which bypass RLS: %', v_offenders;
  end if;

  /*
   * 9. Every client grant is backed by a policy.
   *
   * New in this file, and the check the systematic audit actually needed. RLS
   * with no policy is deny-all, so a table that GRANTS a verb but has no policy
   * for it has a dead grant: harmless today, and exactly the thing somebody
   * later "fixes" by adding a permissive policy because the grant implies the
   * feature was meant to work.
   *
   * `rate_limit_policies` and `rate_limit_events` are deliberately in the other
   * state — RLS on, no policy, no grant — which this check is happy with,
   * because it looks for grants without policies rather than the reverse.
   */
  select string_agg(distinct format('%s:%s', g.table_name, g.privilege_type), ', ')
  into v_offenders
  from information_schema.role_table_grants g
  join pg_class c on c.relname = g.table_name
  join pg_namespace n on n.oid = c.relnamespace and n.nspname = 'public'
  where g.table_schema = 'public'
    and g.grantee in ('anon', 'authenticated')
    and g.privilege_type in ('SELECT', 'INSERT', 'UPDATE', 'DELETE')
    and c.relkind = 'r'
    and not exists (
      select 1 from pg_policy p
      where p.polrelid = c.oid
        and (p.polcmd = '*'
             or p.polcmd = case g.privilege_type
                             when 'SELECT' then 'r'
                             when 'INSERT' then 'a'
                             when 'UPDATE' then 'w'
                             when 'DELETE' then 'd'
                           end::"char")
    );

  if v_offenders is not null then
    raise exception
      'client grant(s) with no policy to permit them, so the grant is dead: %', v_offenders;
  end if;
end;
$$;

revoke execute on function public.assert_client_authorization_surface() from public, anon, authenticated;

-- A migration that changes a grant asks the gate, as its last line.
select public.assert_client_authorization_surface();
