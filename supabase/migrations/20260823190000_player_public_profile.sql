-- =============================================================================
-- Arc 21 — a friend's profile had nothing to read
-- =============================================================================
--
-- The specification's FRIEND PROFILE list is nine things: avatar, display name,
-- username, level, presence, public stats according to privacy setting, career
-- stars, tournament wins, Invite to Table (plus Remove Friend and Block, which
-- are built). The screen renders the first four and last-seen, and there is no
-- source anywhere for the rest — `my_competition_record` and
-- `my_career_progress` both derive from `auth.uid()` and answer only about the
-- caller, correctly.
--
-- WHAT DECIDES WHAT IS SHOWN. Settings says the choice "controls who can see
-- your profile and standings", so standings — hands, accuracy, career stars,
-- tournament wins — are ALL governed by `profiles.privacy`, not just the ones
-- the word "stats" obviously covers. There is one visibility answer here, not
-- four.
--
--   public   → the numbers are returned to anybody not blocked
--   friends  → returned to a confirmed friend, and to nobody else
--   private  → returned to nobody. NULL, not zero: "no record" and "a record of
--              zero" are different claims, and this app states the difference
--              everywhere else.
--
-- IDENTITY IS NOT GATED THE SAME WAY, and that is deliberate rather than an
-- oversight. `search_players` already returns username, display name and level
-- for every player who is not blocked — it has to, or nobody could be found to
-- befriend — so hiding the same three fields here would not conceal anything.
-- What privacy protects is the RECORD.
--
-- A BLOCK, IN EITHER DIRECTION, RETURNS NOTHING AT ALL. Not an empty profile, no
-- row: the same answer as a user id that never existed. The block must not be
-- discoverable by the person blocked.
--
-- Nothing here is writable and nothing names a chip. It is one read.
-- =============================================================================

create or replace function public.player_public_profile(p_user_id uuid)
returns table (
  user_id                uuid,
  username               text,
  display_name           text,
  avatar_url             text,
  country_code           text,
  level                  integer,
  privacy                public.profile_privacy,
  is_friend              boolean,
  stats_visible          boolean,
  hands_played           integer,
  hands_won              integer,
  hands_pushed           integer,
  decisions_total        integer,
  decisions_optimal      integer,
  career_stars           integer,
  career_nodes_completed integer,
  tournaments_entered    integer,
  tournament_wins        integer,
  last_seen_at           timestamptz
)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
-- The RETURNS TABLE column names shadow real columns of the same name inside
-- the body. Prefer the column, as `get_room_state` does.
#variable_conflict use_column
declare
  v_me      uuid := auth.uid();
  v_friend  boolean;
  v_visible boolean;
begin
  if v_me is null then
    raise exception 'this requires an authenticated session' using errcode = '42501';
  end if;
  if p_user_id is null then return; end if;

  -- Either direction. Nothing distinguishes "they blocked you" from "no such
  -- player", which is the point.
  if public.is_blocked_between(v_me, p_user_id) then return; end if;

  v_friend := public.are_friends(v_me, p_user_id);

  select
    case
      when p.id = v_me then true
      when p.privacy = 'public' then true
      when p.privacy = 'friends' then v_friend
      else false
    end
  into v_visible
  from public.profiles p
  where p.id = p_user_id;

  -- No such profile. Same silent return as a block.
  if v_visible is null then return; end if;

  return query
  select
    p.id,
    p.username::text,
    p.display_name,
    p.avatar_url,
    p.country_code,
    p.level,
    p.privacy,
    v_friend,
    v_visible,
    -- NULL rather than 0 wherever the record is not visible. A zero here would
    -- render as a real record of nothing, which is a different and untrue thing.
    case when v_visible then coalesce(s.hands_played, 0) end,
    case when v_visible then coalesce(s.hands_won, 0) end,
    case when v_visible then coalesce(s.hands_pushed, 0) end,
    case when v_visible then coalesce(s.decisions_total, 0) end,
    case when v_visible then coalesce(s.decisions_optimal, 0) end,
    case when v_visible then coalesce(c.stars, 0) end,
    case when v_visible then coalesce(c.completed, 0) end,
    case when v_visible then coalesce(t.entered, 0) end,
    case when v_visible then coalesce(t.wins, 0) end,
    p.last_seen_at
  from public.profiles p
  left join public.player_stats s on s.user_id = p.id
  left join lateral (
    select
      sum(cp.stars)::integer                                        as stars,
      count(*) filter (where cp.status = 'completed')::integer      as completed
    from public.career_progress cp
    where cp.user_id = p.id
  ) c on true
  left join lateral (
    select
      count(*)::integer                                   as entered,
      count(*) filter (where e.placement = 1)::integer    as wins
    from public.tournament_entries e
    where e.user_id = p.id
      -- A withdrawn entry is not a tournament somebody took part in. The same
      -- rule `my_competition_record` uses, so the two cannot disagree about the
      -- same player.
      and e.status <> 'withdrawn'
  ) t on true
  where p.id = p_user_id;
end;
$$;

comment on function public.player_public_profile(uuid) is
  'One other player''s profile as this caller may see it. Identity is returned '
  'for anybody not blocked — search_players already discloses the same three '
  'fields — while every NUMBER is governed by profiles.privacy, which Settings '
  'describes as controlling "your profile and standings". A block in either '
  'direction returns no row at all.';

revoke execute on function public.player_public_profile(uuid) from public, anon;
grant  execute on function public.player_public_profile(uuid) to authenticated;


-- -----------------------------------------------------------------------------
-- The authorization gate learns about `player_public_profile`
-- -----------------------------------------------------------------------------
-- From the LAST version (20260823170000), one line changed. `create or replace
-- function` reverts every later redefinition, so the whole body is carried
-- forward rather than patched — and the gate is called at the bottom of this
-- file, because a migration-time check only ever sees the state at its own
-- position in the ordering.

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
    -- one other player's profile, as this caller may see it
    'player_public_profile',
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

-- A migration that changes a grant calls the gate as its last line.
do $$ begin perform public.assert_client_authorization_surface(); end $$;
