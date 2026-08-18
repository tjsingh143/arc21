-- =============================================================================
-- Arc 21 — the authorization gate, made re-runnable, and the surface it found
--
-- `20260813121200_hardening.sql` gates the authorization surface with DO blocks
-- that FAIL THE MIGRATION if a client role gains something it should not have.
-- The mechanism is right and this file extends it rather than replacing it.
--
-- -----------------------------------------------------------------------------
-- WHAT THE AUDIT FOUND: THE GATE STOPPED RUNNING SIXTEEN MIGRATIONS AGO
-- -----------------------------------------------------------------------------
-- Those DO blocks execute exactly once, at the point in the ordering where they
-- sit — thirteenth of twenty-nine. Everything from `20260815120000` onward is
-- applied AFTER them and has never been checked by anything. The gate did not
-- weaken; it simply stopped being asked.
--
-- What accumulated behind it, measured against the running database before this
-- file was written:
--
--   * the gate asserts `anon` may execute exactly ONE public function.
--     `anon` could execute SEVENTEEN.
--   * the four leaderboards, `my_leaderboard_position`,
--     `my_strategy_accuracy_progress`, `caller_is_room_member` and
--     `notification_data_is_safe` were all reachable signed out.
--
-- And the cause is one line that is easy to leave out. A newly created function
-- carries Postgres's DEFAULT ACL, which is **EXECUTE TO PUBLIC** — every role,
-- including `anon`. The early migrations all wrote
--
--     revoke execute on function … from public, anon;
--     grant  execute on function … to authenticated;
--
-- and the later ones wrote only the `grant`, which adds a privilege without ever
-- removing the default one. Reading such a migration, the grant looks like the
-- whole story.
--
-- So the strongest check in this file is not an allowlist at all. It is the
-- mechanical rule that **no function in `public` may be executable by PUBLIC**.
-- That one line catches every instance of this mistake, including the ones
-- nobody has made yet, without anybody maintaining a list.
--
-- -----------------------------------------------------------------------------
-- AND THE GATE IS NOW A FUNCTION
-- -----------------------------------------------------------------------------
-- The checks live in `assert_client_authorization_surface()`, called by this
-- migration and again by `20_authorization_surface.test.sql`. A future migration
-- that changes a grant should call it too — one line at the bottom of the file —
-- which is what keeps this from going stale again the way the original did.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Narrowing what the audit found
-- -----------------------------------------------------------------------------
--
-- Every function below is an INTERNAL helper: it is called from inside another
-- `SECURITY DEFINER` function, from a trigger, or from a CHECK constraint, and
-- no client calls it directly. Verified against every `.rpc(` call site in the
-- app before revoking, not assumed.
--
-- The leaderboard functions are the interesting case. They were reachable by
-- `anon` purely through the default ACL, and the leaderboard store already
-- refuses to read a board without a session — so nothing signed-out could reach
-- them anyway. The grant said one thing and the product did another; the product
-- was right.
revoke execute on function public.accuracy_basis_points(integer, integer) from public, anon, authenticated;
revoke execute on function public.avatar_asset_for(uuid) from public, anon, authenticated;
revoke execute on function public.cosmetic_is_earned(uuid, uuid) from public, anon, authenticated;
revoke execute on function public.daily_challenge_streak(uuid) from public, anon, authenticated;
revoke execute on function public.max_player_level() from public, anon, authenticated;
revoke execute on function public.total_xp_for_level(integer) from public, anon, authenticated;
revoke execute on function public.utc_week_start(timestamptz) from public, anon, authenticated;
revoke execute on function public.strategy_accuracy_count_cap() from public, anon, authenticated;
revoke execute on function public.strategy_accuracy_minimum_decisions() from public, anon, authenticated;

-- These four ARE needed by a client role, but only by `authenticated`, and only
-- indirectly. Each was reachable by `anon` through the default ACL.
--
--   caller_is_room_member    the RLS policy on rooms/room_members, evaluated
--                            with the invoker's rights
--   level_from_total_xp      the `profiles_sync_level` trigger, likewise
--   notification_data_is_safe the CHECK on notifications.data, re-evaluated when
--                            a client marks one read
--   sanitise_display_name / username_is_permitted
--                            the CHECK constraints on profiles, and the
--                            normalise trigger
--
-- That last pair is worth a note, because the original gate justified their
-- grant as "used by the client to validate input before submitting it". They are
-- not: nothing in the app calls either one — `src/features/auth/credentials.ts`
-- re-implements the format check locally. The grant is load-bearing for a
-- different reason, proved by revoking it and watching a plain rename fail with
-- `permission denied for function sanitise_display_name`.
revoke execute on function public.caller_is_room_member(uuid) from public, anon;
revoke execute on function public.level_from_total_xp(bigint) from public, anon;
revoke execute on function public.notification_data_is_safe(jsonb) from public, anon;
revoke execute on function public.sanitise_display_name(text) from public, anon;
revoke execute on function public.username_is_permitted(text) from public, anon;
grant execute on function public.notification_data_is_safe(jsonb) to authenticated;

-- The boards and the two "how am I doing" queries: signed-in only, as the client
-- has always behaved.
revoke execute on function public.leaderboard_weekly_xp(integer) from public, anon;
revoke execute on function public.leaderboard_tournament_wins(integer) from public, anon;
revoke execute on function public.leaderboard_strategy_accuracy(integer) from public, anon;
revoke execute on function public.leaderboard_daily_challenge(date, integer) from public, anon;
revoke execute on function public.my_leaderboard_position(text) from public, anon;
revoke execute on function public.my_strategy_accuracy_progress() from public, anon;
revoke execute on function public.sprint_format() from public, anon;

-- Everything created since the gate stopped running, swept for the default ACL
-- rather than named one by one — the named revokes above are the ones with a
-- reason worth recording. This catches anything else that carries `=X/…`.
do $$
declare
  v_proc record;
begin
  for v_proc in
    select p.oid::regprocedure as sig
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.prokind = 'f'
      and p.proacl is not null
      and exists (
        select 1 from aclexplode(p.proacl) a
        where a.grantee = 0 and a.privilege_type = 'EXECUTE'
      )
  loop
    execute format('revoke execute on function %s from public', v_proc.sig);
  end loop;
end;
$$;

-- -----------------------------------------------------------------------------
-- 2. The gate itself
-- -----------------------------------------------------------------------------
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
    'poll_matchmaking', 'set_room_ready',
    -- competition
    'ensure_todays_daily_challenge', 'my_daily_entry', 'my_sprint_entry',
    'sprint_format', 'sprint_standings',
    -- leaderboards
    'leaderboard_daily_challenge', 'leaderboard_strategy_accuracy',
    'leaderboard_tournament_wins', 'leaderboard_weekly_xp',
    'my_leaderboard_position', 'my_strategy_accuracy_progress',
    -- progression and cosmetics
    'equip_cosmetic', 'grant_earned_cosmetics', 'my_inventory', 'my_level_progress',
    'my_loadout',
    -- notifications
    'mark_notifications_read', 'my_notifications', 'register_push_token',
    'retire_push_token', 'unread_notification_count',
    -- account
    'claim_recovery_grant', 'delete_own_account'
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

comment on function public.assert_client_authorization_surface() is
  'Raises if any client role holds a privilege it should not. Called at migration '
  'time — a check that runs on deploy is stronger than a test somebody may not '
  'run — and again from 20_authorization_surface.test.sql. A migration that '
  'changes a grant should call it at the bottom of the file.';

revoke execute on function public.assert_client_authorization_surface()
  from public, anon, authenticated;

-- The gate, run against the full surface for the first time since migration 13.
do $$ begin perform public.assert_client_authorization_surface(); end $$;
