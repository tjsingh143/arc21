-- =============================================================================
-- Arc 21 — the Competition section of Statistics had nothing to read
-- =============================================================================
--
-- `app/stats/index.tsx` called `competitionState({ hasAccount: false, online:
-- false })` with both values written as LITERALS. Every signed-in player was
-- told that tournament and daily-challenge records "require an account" — which
-- they have — and the screen could not have shown a record even if the flag had
-- been right, because nothing anywhere fetched one.
--
-- The same defect the Profile screen had, and its fix is documented in that
-- file's header: `hasAccount` was written when there genuinely was no sign-in
-- and never revisited once accounts shipped. This is the other instance.
--
-- WHAT THIS RETURNS, and what it deliberately does not. Five numbers about the
-- CALLER, derived from `auth.uid()`. No user id, no email, no opponent, and
-- nothing about anybody else's placement — the same projection discipline the
-- leaderboards keep, for the same reason.
--
-- `best_daily_rank` is computed with the ranking the daily board itself uses,
-- tie-breaks included, rather than a second ordering that could disagree with
-- the board the player is looking at.
-- =============================================================================

create or replace function public.my_competition_record()
returns table (
  tournaments_entered       integer,
  tournament_wins           integer,
  best_finish               integer,
  daily_challenges_played   integer,
  daily_challenge_best_rank integer
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  with me as (select (select auth.uid()) as id),
  tournaments as (
    select
      count(*)::integer as entered,
      count(*) filter (where e.placement = 1)::integer as wins,
      min(e.placement)::integer as best
    from public.tournament_entries e, me
    where e.user_id = me.id
      -- A withdrawn entry is not a tournament the player took part in.
      and e.status <> 'withdrawn'
  ),
  -- Ranked exactly as `leaderboard_daily_challenge` ranks, so "your best rank"
  -- and the board a player can open cannot disagree.
  daily as (
    select
      count(*)::integer as played,
      min(r.rank)::integer as best
    from (
      select
        e.user_id,
        rank() over (
          partition by e.daily_challenge_id
          order by e.score desc,
                   public.accuracy_basis_points(e.decisions_optimal, e.decisions_total) desc nulls last,
                   e.ev_lost_micros asc,
                   e.completed_at asc,
                   e.user_id
        )::integer as rank
      from public.daily_entries e
      where e.status = 'completed'
    ) r, me
    where r.user_id = me.id
  )
  select
    coalesce(tournaments.entered, 0),
    coalesce(tournaments.wins, 0),
    tournaments.best,
    coalesce(daily.played, 0),
    daily.best
  from tournaments, daily;
$$;

comment on function public.my_competition_record() is
  'The caller''s own tournament and daily-challenge totals, for the Statistics '
  'screen. Derived from auth.uid(); returns no identifier and nothing about any '
  'other player. Daily rank uses the leaderboard''s own ordering, tie-breaks '
  'included, so the two cannot disagree.';

revoke execute on function public.my_competition_record() from public, anon;
grant  execute on function public.my_competition_record() to authenticated;

-- -----------------------------------------------------------------------------
-- The authorization gate learns about `my_competition_record`
-- -----------------------------------------------------------------------------
--
-- The allowlist lives inside the gate's body, so a new client-callable function
-- means redefining it. `create or replace function` reverts every later
-- redefinition, so this starts from the LAST version (20260823130000) and
-- changes exactly one line. The gate is called at the bottom of this file, so
-- the migration fails if the two disagree.

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
    -- career
    'my_career_progress',
    -- the caller's own competition totals
    'my_competition_record',
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

do $$ begin perform public.assert_client_authorization_surface(); end $$;
