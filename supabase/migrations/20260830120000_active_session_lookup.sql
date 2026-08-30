-- =============================================================================
-- Arc 21 — the reconnectable active-game identifier
-- =============================================================================
--
-- THE DEFECT, reproduced against a running stack before this file existed.
--
--   OPEN                  200 {"gameId":"b3bcfb9b-…","seatId":"41745c30-…","wallet":23000}
--   (the app is killed; both ids existed only as route parameters)
--   OPEN again            409 {"code":"SESSION_ALREADY_ACTIVE"}
--   wallets?select=balance    [{"balance":23000}]      <- 2,000 still in escrow
--
-- `assertNoOtherLiveSeat` in `create-session` refuses a second buy-in while the
-- player holds a live seat, which is right — it is the control that stops one
-- wallet funding two tables. But the game id and the seat id reached the client
-- exactly once, in the reply to OPEN, and were then held only in an
-- `expo-router` parameter. Nothing persisted them and NOTHING ANYWHERE ASKED THE
-- SERVER WHICH TABLE THE PLAYER WAS AT. Lose them — the app is killed mid-hand,
-- the process is reclaimed, the phone reboots, the player signs in on a second
-- device — and every server-authoritative mode is closed for ever:
--
--   Quick Play          409 SESSION_ALREADY_ACTIVE
--   Public Table        409 SESSION_ALREADY_ACTIVE
--   Career (standard)   409 SESSION_ALREADY_ACTIVE
--
-- with the buy-in stranded, because nothing ever marks a session abandoned and
-- the only ways out — LEAVE and CASH_OUT — both name the game id the player no
-- longer has. All three client stores answered that refusal with some form of
-- "leave that table first", which is advice the player cannot act on.
--
-- Measured, not theorised: a solo table left mid-hand parks at PLAYER_TURNS with
-- the seat still `active`, `escrow_chips = 2000`, and `RESOLVE_TIMEOUT` refused
-- (a solo table carries no clocks on purpose, so no deadline can ever be
-- reached). The table is playable and cashable — it just cannot be ADDRESSED.
--
-- The eleventh-and-a-half instance of the built-but-never-connected pattern, and
-- the data was readable the whole time: `game_session_seats` is already
-- selectable by its owner. What was missing was somebody asking.
--
-- -----------------------------------------------------------------------------
-- WHY A FUNCTION RATHER THAN A QUERY THE CLIENT WRITES
-- -----------------------------------------------------------------------------
--
-- Two reasons, both of them mistakes this repository has already made once.
--
--   1. A read through RLS is scoped to what the POLICY permits, not to "your own
--      rows". `game_session_seats_select_participant` correctly shows a player
--      the OTHER seats at a table they are sitting at, so
--      `game_session_seats?status=neq.left` returns other people's seats too and
--      a client-written query has to remember `user_id=eq.<me>`. Deriving the
--      identity from `auth.uid()` in here removes the footgun rather than
--      documenting it.
--
--   2. The predicate must agree with `assertNoOtherLiveSeat`, EXACTLY. A resume
--      card that shows a table the server does not count is a button that leads
--      nowhere; one that misses a table the server DOES count leaves the player
--      locked out with a screen insisting they are free. So the WHERE clause
--      below is that function's, written out:
--
--          s.status <> 'left'  and  g.status in ('lobby', 'active')
--
--      `active` and `disconnected` are seats a player still HOLDS; `left` is one
--      that has already been settled. `tests/server` asserts the two agree by
--      provoking the refusal and checking this function names the same table,
--      rather than by comparing two copies of a predicate.
--
-- WHAT IT RETURNS, and what it deliberately does not: five facts about the
-- CALLER'S OWN seat. No other player, no stack, no wager, no card, and nothing
-- from `private`. The client needs an address and a name for it, and that is all
-- this is.
-- =============================================================================

create or replace function public.my_active_session()
returns table (
  game_session_id uuid,
  seat_id         uuid,
  mode            public.game_mode,
  tier            public.table_tier,
  started_at      timestamptz
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select s.game_session_id, s.id, g.mode, g.tier, g.started_at
  from public.game_session_seats s
  join public.game_sessions g on g.id = s.game_session_id
  where s.user_id = (select auth.uid())
    -- The control's own predicate. See the header.
    and s.status <> 'left'
    and g.status in ('lobby', 'active')
  -- One live seat is an invariant, not a guarantee: `assertNoOtherLiveSeat`
  -- takes `limit 1` for the same reason. The newest is the one a player is
  -- actually at if the invariant is ever broken.
  order by g.started_at desc nulls last, s.joined_at desc
  limit 1;
$$;

comment on function public.my_active_session() is
  'The caller''s own live seat — game id, seat id, mode, tier, start time — or '
  'no row. Derived from auth.uid(); returns nothing about any other player and '
  'nothing from the private schema. Uses the same predicate as the server''s '
  'one-live-seat control, so a player refused a second buy-in can always be '
  'told where their chips are.';

revoke execute on function public.my_active_session() from public, anon;
grant  execute on function public.my_active_session() to authenticated;

-- -----------------------------------------------------------------------------
-- The gate learns about `my_active_session`
-- -----------------------------------------------------------------------------
--
-- Copied VERBATIM from 20260829120000_account_lifecycle_completeness.sql, the
-- LAST file to define it, with one name added to the allowlist. `create or
-- replace function` replaces a body wholesale, so starting from any earlier
-- version would silently revert every check added since — which has cost this
-- repository a `notify_user` call and an `expire_stale_rooms()` call already.
--
-- A new function's default ACL is EXECUTE TO PUBLIC, so the grant above is
-- written as the revoke/grant PAIR and this gate refuses any public function
-- still executable by PUBLIC. Called as the last line, because a migration-time
-- DO block only ever sees the state at its own position in the ordering.

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
    'claim_recovery_grant', 'delete_own_account',
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

select public.assert_client_authorization_surface();
