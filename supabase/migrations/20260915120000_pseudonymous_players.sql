-- Refresh B: server-assigned public handles and verified social activity.
-- Existing players retain every identifier and all account-scoped state.
-- Anonymous creation is an auth.users INSERT; securing is UPDATE, with no grant.

create or replace function public.generated_player_handle(p_suffixed boolean default false)
returns text
language plpgsql
volatile
set search_path = public, extensions, pg_temp
as $$
declare
  v_adjectives constant text[] := array['able','agile','amber','aqua','avid','azure','brave','brisk','calm','cedar','clear','coral','cozy','crisp','eager','early','fair','fancy','fast','fleet','fond','fresh','gentle','glad','gold','grand','green','happy','hazel','jolly','keen','kind','lively','lucky','lunar','merry','mild','mint','misty','noble','olive','pearl','plush','polar','proud','quiet','quick','royal','ruby','sandy','shiny','sleek','smart','snowy','soft','solar','spry','steady','sunny','swift','teal','tidy','vivid','warm','witty'];
  v_animals constant text[] := array['badger','bat','bear','bee','bison','boar','bunny','camel','carp','cobra','cod','crane','crow','deer','dove','duck','eagle','egret','elk','falcon','fawn','ferret','finch','fox','frog','gecko','goose','hare','hawk','heron','ibis','jaguar','jay','koala','lark','lemur','lion','llama','lynx','macaw','manta','mink','moose','moth','mouse','newt','orca','otter','owl','panda','parrot','perch','pike','pony','puma','quail','raven','robin','seal','shark','shrew','sloth','snail','swan','tiger','trout','turtle','whale','wolf','wren','yak','zebra'];
  v_bytes bytea := extensions.gen_random_bytes(8);
  v_handle text;
begin
  v_handle := v_adjectives[1 + get_byte(v_bytes, 0) % cardinality(v_adjectives)]
    || '_' || v_animals[1 + get_byte(v_bytes, 1) % cardinality(v_animals)];
  if p_suffixed then
    v_handle := v_handle || '_' || lpad((
      (get_byte(v_bytes, 2)::bigint * 65536 + get_byte(v_bytes, 3) * 256 + get_byte(v_bytes, 4)) % 1000000
    )::text, 6, '0');
  end if;
  return v_handle;
end;
$$;
revoke all on function public.generated_player_handle(boolean) from public, anon, authenticated, service_role;

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  -- Only permanent signups retain the legacy optional request. Anonymous
  -- metadata is never authority for either identity class or first assignment.
  v_requested text := case when new.is_anonymous is true then null
    else lower(btrim(nullif(new.raw_user_meta_data ->> 'username', ''))) end;
  v_display_requested text := case when new.is_anonymous is true then null
    else public.sanitise_display_name(nullif(new.raw_user_meta_data ->> 'display_name', '')) end;
  v_username text;
  v_display text;
  v_attempt integer := 0;
  v_constraint text;
  v_wallet_id uuid;
begin
  loop
    v_username := case when v_attempt = 0 and v_requested is not null
      and public.username_is_permitted(v_requested) then v_requested
      else public.generated_player_handle(v_attempt > 0) end;
    v_attempt := v_attempt + 1;
    if v_attempt > 100 then
      raise exception 'could not allocate public handle';
    end if;
    -- The vocabulary AND every suffixed candidate pass the canonical filter.
    if not public.username_is_permitted(v_username) then continue; end if;
    v_display := coalesce(public.sanitise_display_name(
      left(coalesce(v_display_requested, v_username), 24)), v_username);
    begin
      insert into public.profiles(id, username, display_name)
      values (new.id, v_username, v_display);
      exit;
    exception when unique_violation then
      get stacked diagnostics v_constraint = constraint_name;
      if v_constraint is distinct from 'profiles_username_key' then raise; end if;
      -- The unique index, rather than an advisory precheck, arbitrates races.
    end;
  end loop;

  insert into public.player_stats(user_id) values (new.id);
  -- Preserve the established bootstrap/version semantics. Both opening rows
  -- commit with the auth user; every subsequent movement uses apply_wallet_delta.
  insert into public.wallets(user_id, balance, lifetime_credited)
  values (new.id, 25000, 25000) returning id into v_wallet_id;
  insert into public.wallet_ledger(wallet_id, user_id, delta, balance_after, reason, idempotency_key)
  values (v_wallet_id, new.id, 25000, 25000, 'initial_grant', 'initial_grant:' || new.id::text);
  return new;
end;
$$;
revoke all on function public.handle_new_user() from public, anon, authenticated, service_role;
comment on function public.handle_new_user() is
  'Atomic identity bootstrap: filtered unique human-readable handle, profile, statistics, and one opening grant. Auth linking never invokes this INSERT trigger.';

-- Requests already use this RPC in production. Direct insertion bypassed its
-- 20/hour abuse limit and is no longer a client capability.
revoke insert on public.friend_requests from authenticated;
drop policy friend_requests_insert_as_sender on public.friend_requests;

-- The old shared topic exposed all participants and accepted client UUIDs.
drop policy arc21_presence_roster_needs_an_account on realtime.messages;
drop policy arc21_only_presence_may_be_written_by_a_client on realtime.messages;

create or replace function public.list_friend_presence()
returns table(user_id uuid, state text)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare v_me uuid := auth.uid();
begin
  if v_me is null then
    raise exception 'this requires an authenticated session' using errcode = '42501';
  end if;
  return query
  select p.id, case when exists (
    select 1 from public.game_session_seats s
    join public.game_sessions g on g.id = s.game_session_id
    where s.user_id = p.id and s.status <> 'left' and g.status = 'active'
  ) then 'in_game'::text else 'available'::text end
  from public.friendships f
  join public.profiles p on p.id = case when f.user_id_a = v_me then f.user_id_b else f.user_id_a end
  where v_me in (f.user_id_a, f.user_id_b)
    and not public.is_blocked_between(v_me, p.id)
    and p.last_seen_at >= now() - interval '90 seconds'
  order by p.id
  limit 100;
end;
$$;
revoke all on function public.list_friend_presence() from public, anon, service_role;
grant execute on function public.list_friend_presence() to authenticated;
comment on function public.list_friend_presence() is
  'Only accepted, unblocked friends with recent verified activity. available means recently active, not a claim of a live connection; in_game comes from server seats.';

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
    'touch_last_seen', 'list_friend_presence',
    -- where the caller's own chips are, so a refused buy-in can say so
    'my_active_session'
  ];

  -- Tables a client is genuinely allowed to write, and the verbs it may use.
  -- Unchanged from the original gate: nothing has been added to it since, which
  -- is itself worth knowing.
  c_allowed_writes constant text[] := array[
    'profiles:UPDATE',
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
