-- =============================================================================
-- Arc 21 — phase 10, backend authorization hardening
--
-- Three things, each measured against the running stack before it was written.
--
--   1. `tournament_entries` was readable by EVERY authenticated account.
--   2. `service_role` could mint chips through the Data API in one call.
--   3. Five policies named the `PUBLIC` role where they meant `authenticated`.
--
-- Nothing here changes a rule of the game, a payout or a card.
-- =============================================================================


-- -----------------------------------------------------------------------------
-- 1. A tournament entry is visible to its owner and to the field. Nobody else.
-- -----------------------------------------------------------------------------
--
-- `tournament_entries_select_visible` had a third clause:
--
--     or exists (select 1 from public.profiles p where p.id = tournament_entries.user_id)
--
-- The reasoning it shipped with was sound in shape — nested access is evaluated
-- as the invoking role, so a hidden profile yields no row and the entry stays
-- hidden, which puts visibility rules in one place. What it missed is that
-- `profiles.privacy` DEFAULTS to `public`, so for an ordinary account the
-- subquery is simply true and the clause collapses to "anyone signed in".
--
-- MEASURED, not reasoned about: a freshly created second account with no
-- friendship, no shared table and no tournament of its own read **152 entry
-- rows** out of `tournament_entries` — `user_id`, live `chips`, `placement` and
-- `prize_chips` for every entrant in the database. `public.sprint_standings`
-- refuses exactly those numbers to a non-participant with a 42501, so the
-- sanctioned read path and the raw table disagreed about the same data.
--
-- Three documents said the tighter thing and only the policy said otherwise:
--
--   * `docs/SECURITY.md` — "Entries in a tournament you are in";
--   * `tests/server/rls-idor.integration.test.ts` — classifies the table as
--     OWNED, "a stranger must see NONE of it", and passed because its fixture
--     never created an entry. The file's own header warns that "a sweep over
--     empty tables passes having proved nothing" and it had one inside it;
--   * `sprint_standings`, which is the only way the app reads this data.
--
-- The public shape of a tournament is `leaderboard_tournament_wins`, which is
-- SECURITY DEFINER and publishes finished placements on purpose. A live stack
-- mid-tournament is not that.
drop policy if exists tournament_entries_select_visible on public.tournament_entries;

create policy tournament_entries_select_visible
  on public.tournament_entries for select
  to authenticated
  using (
    user_id = (select auth.uid())
    or public.viewer_is_in_tournament(tournament_id)
  );

comment on policy tournament_entries_select_visible on public.tournament_entries is
  'Your own entry, or an entry in a tournament you are in. Competitors must see '
  'each other''s stacks and placements; nobody else may. Finished placements are '
  'published separately by leaderboard_tournament_wins.';

-- A match row is a bracket edge between two entries, so it must not be more
-- visible than the entries it points at. The endpoint-visibility clause it
-- carried had the same defect one level removed: with entries world-readable it
-- was world-readable too. `tournament_matches` holds zero rows in the whole
-- database — the Sprint format is a single table, not a bracket — so this is
-- the shape being fixed before anything writes it, not a live leak.
drop policy if exists tournament_matches_select_visible on public.tournament_matches;

create policy tournament_matches_select_visible
  on public.tournament_matches for select
  to authenticated
  using (public.viewer_is_in_tournament(tournament_id));

comment on policy tournament_matches_select_visible on public.tournament_matches is
  'Matches in a tournament you are in. V1.1 shape: nothing writes this table yet.';


-- -----------------------------------------------------------------------------
-- 2. `service_role` loses the one thing it could still reach in `public`
-- -----------------------------------------------------------------------------
--
-- `20260813120000_foundation.sql` already explains why `service_role` holds no
-- table privilege in this schema: "The server reaches this schema as `postgres`
-- or through a SECURITY DEFINER function owned by `postgres`, so service_role
-- needs no table privilege at all." The same sentence is true of functions, and
-- one grant contradicted it.
--
-- MEASURED: a POST to `/rest/v1/rpc/apply_wallet_delta` carrying nothing but the
-- service key answered HTTP 200 and moved a wallet from 24,450 to 1,024,450.
-- One request, no engine, no idempotency the caller does not choose, no seat.
--
-- Nothing legitimate is losing anything. Every call site is
-- `_shared/session-repository.ts`, which runs inside the command transaction
-- over the direct Postgres connection from `SUPABASE_DB_URL` — that connects as
-- `postgres`, which owns the function. `send-notifications` is the only Function
-- that authenticates a caller against the service key at all, and it too reaches
-- the database over that same connection.
--
-- A service key is a root credential and this is defence in depth, not a
-- client-reachable hole. But "root" is a reason to take the last verb away, not
-- a reason to leave it: after this, a leaked service key can read no table,
-- write no table and execute no function in `public`.
revoke execute on function public.apply_wallet_delta(
  uuid, bigint, public.ledger_reason, text, text, uuid, jsonb
) from service_role;

comment on function public.apply_wallet_delta is
  'Server-only, idempotent, row-locking chip movement. Executable by no API '
  'role — not anon, not authenticated and not service_role. Reached only as '
  'postgres, over the Edge Functions'' direct database connection.';


-- -----------------------------------------------------------------------------
-- 3. A policy that names PUBLIC means every role, including `anon`
-- -----------------------------------------------------------------------------
--
-- Five policies were written `to public` where they meant `to authenticated`.
-- All five are harmless today for the same reason the `deny_client_write`
-- trigger was harmless the day before it was needed: `anon` holds no grant on
-- any of these tables, so the policy is never consulted for it.
--
-- That is the FIRST lock, and this repository has now added a client grant by
-- accident sixteen times. A policy naming PUBLIC turns the next such accident
-- into an anon-readable table; a policy naming `authenticated` does not. The
-- predicate is `auth.uid()`-based either way and `auth.uid()` is null for anon,
-- so nothing observable changes for a legitimate caller — which is exactly why
-- it is worth writing down rather than arguing about.
drop policy if exists matchmaking_queue_select_own on public.matchmaking_queue;
create policy matchmaking_queue_select_own
  on public.matchmaking_queue for select
  to authenticated
  using (user_id = (select auth.uid()));

drop policy if exists player_daily_xp_select_own on public.player_daily_xp;
create policy player_daily_xp_select_own
  on public.player_daily_xp for select
  to authenticated
  using (user_id = (select auth.uid()));

drop policy if exists player_decision_periods_select_own on public.player_decision_periods;
create policy player_decision_periods_select_own
  on public.player_decision_periods for select
  to authenticated
  using (user_id = (select auth.uid()));

drop policy if exists rooms_select_member on public.rooms;
create policy rooms_select_member
  on public.rooms for select
  to authenticated
  using (public.caller_is_room_member(id));

drop policy if exists room_members_select_same_room on public.room_members;
create policy room_members_select_same_room
  on public.room_members for select
  to authenticated
  using (public.caller_is_room_member(room_id));


-- -----------------------------------------------------------------------------
-- 4. The gate learns both rules
-- -----------------------------------------------------------------------------
--
-- Copied VERBATIM from `20260903130000_daily_seed_reveal.sql`, the LAST file to
-- define it, with blocks 10 and 11 appended. `create or replace function`
-- replaces a body wholesale, so starting from any earlier version silently
-- reverts every check added since — see the note in `CLAUDE.md`.

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

  /*
   * 10. `service_role` REACHES NOTHING IN `public`.
   *
   * New in phase 10. The foundation migration revoked default table and
   * sequence privileges from `service_role` and wrote down why: the server
   * reaches this schema as `postgres` or through a SECURITY DEFINER function
   * owned by `postgres`, so the key needs no privilege here at all. It never
   * said the same about FUNCTIONS, and one grant survived —
   * `apply_wallet_delta`, measured minting a million chips through
   * `/rest/v1/rpc/` with nothing but the key.
   *
   * Stated as "no function at all" rather than as an allowlist, because the
   * correct number is zero and an allowlist is a place for the number to grow.
   */
  select string_agg(p.proname, ', ' order by p.proname)
  into v_offenders
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and has_function_privilege('service_role', p.oid, 'EXECUTE');

  if v_offenders is not null then
    raise exception
      'service_role can execute public function(s); it should reach nothing here: %',
      v_offenders;
  end if;

  select string_agg(distinct format('%s(%s)', table_name, privilege_type), ', ')
  into v_offenders
  from information_schema.role_table_grants
  where table_schema = 'public' and grantee = 'service_role';

  if v_offenders is not null then
    raise exception 'service_role holds table privilege(s) in public: %', v_offenders;
  end if;

  /*
   * 11. NO POLICY ON A `public` TABLE NAMES THE `PUBLIC` ROLE.
   *
   * `create policy … using (user_id = auth.uid())` with no `to` clause applies
   * to PUBLIC — every role, `anon` included. Five policies were written that
   * way and all five were harmless, because `anon` holds no grant on those
   * tables and a policy is never consulted for a verb the role cannot use.
   *
   * That is the FIRST lock, and this repository has added a client grant by
   * accident sixteen times. The same argument that put `deny_client_write`
   * underneath the server-owned tables applies here: name the role, so the next
   * accidental grant is still refused.
   */
  select string_agg(distinct format('%s.%s', c.relname, p.polname), ', ')
  into v_offenders
  from pg_policy p
  join pg_class c on c.oid = p.polrelid
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and 0 = any (p.polroles);

  if v_offenders is not null then
    raise exception
      'policy/policies on a public table name the PUBLIC role rather than a client role: %',
      v_offenders;
  end if;
end;
$$;

revoke execute on function public.assert_client_authorization_surface() from public, anon, authenticated;

-- A migration that changes a grant asks the gate, as its last line.
select public.assert_client_authorization_surface();
