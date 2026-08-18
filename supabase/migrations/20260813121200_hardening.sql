-- =============================================================================
-- Arc 21 — 1200 Authorization hardening assertions
--
-- These are not tests, they are gates. The migration fails — and therefore the
-- deploy fails — if any of the following stops being true:
--
--   1. Every table in `public` has Row Level Security enabled.
--   2. No table in `private` grants anything to an API role.
--   3. `anon` cannot execute any function in `public`.
--   4. `authenticated` can execute only the three relationship predicates that
--      RLS policies need; everything else, including apply_wallet_delta, is out
--      of reach.
--   5. Neither client role holds INSERT, UPDATE or DELETE on any table whose
--      contents are server-owned.
--
-- pgTAP covers the same ground in supabase/tests. The duplication is deliberate:
-- a test suite that nobody runs before deploying protects nothing.
-- =============================================================================

do $$
declare
  v_offenders text;
begin
  -- 1. RLS everywhere in public.
  select string_agg(c.relname, ', ' order by c.relname)
  into v_offenders
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public'
    and c.relkind = 'r'
    and not c.relrowsecurity;

  if v_offenders is not null then
    raise exception 'RLS is not enabled on public table(s): %', v_offenders;
  end if;
end;
$$;

do $$
declare
  v_offenders text;
begin
  -- 2. Nothing in `private` is reachable by an API role.
  select string_agg(distinct format('%s->%s(%s)', table_name, grantee, privilege_type), ', ')
  into v_offenders
  from information_schema.role_table_grants
  where table_schema = 'private'
    and grantee in ('anon', 'authenticated', 'service_role');

  if v_offenders is not null then
    raise exception 'private schema has grants to API roles: %', v_offenders;
  end if;

  if has_schema_privilege('anon', 'private', 'USAGE')
     or has_schema_privilege('authenticated', 'private', 'USAGE')
     or has_schema_privilege('service_role', 'private', 'USAGE') then
    raise exception 'an API role holds USAGE on the private schema';
  end if;
end;
$$;

do $$
declare
  v_offenders text;
begin
  -- 3 & 4. Function execution surface.
  --
  -- `is_client_role` is callable by both client roles because the guard
  -- triggers execute as the invoker and call it; it reports the caller's own
  -- role and nothing else.
  --
  -- The client-reachable relationship predicates are the CALLER-SCOPED ones
  -- (`viewer_*`): each derives the viewer from auth.uid() and takes only the
  -- counterparty, so there is no pair to probe. The two-argument
  -- `are_friends`/`has_blocked` are deliberately absent — EXECUTE on those makes
  -- them a PostgREST RPC oracle over the entire social graph, which is precisely
  -- what this list exists to prevent.
  --
  -- `sanitise_display_name` and `username_is_permitted` are pure functions of
  -- their argument, used by the client to validate input before submitting it.
  -- They read no table and reveal nothing beyond the rules the UI already states.
  --
  -- Everything else — apply_wallet_delta above all — is out of reach.
  select string_agg(p.proname, ', ' order by p.proname)
  into v_offenders
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and has_function_privilege('anon', p.oid, 'EXECUTE')
    and p.proname not in ('is_client_role');

  if v_offenders is not null then
    raise exception 'anon can execute unexpected public function(s): %', v_offenders;
  end if;

  select string_agg(p.proname, ', ' order by p.proname)
  into v_offenders
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and has_function_privilege('authenticated', p.oid, 'EXECUTE')
    and p.proname not in (
      'is_client_role',
      'is_session_participant',
      'viewer_has_blocked',
      'viewer_is_blocked_by',
      'viewer_is_friend_of',
      'viewer_is_in_tournament',
      'sanitise_display_name',
      'username_is_permitted'
    );

  if v_offenders is not null then
    raise exception 'authenticated can execute unexpected public function(s): %', v_offenders;
  end if;

  -- The one that would matter most if it ever slipped.
  if has_function_privilege('anon', 'public.apply_wallet_delta(uuid, bigint, public.ledger_reason, text, text, uuid, jsonb)', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.apply_wallet_delta(uuid, bigint, public.ledger_reason, text, text, uuid, jsonb)', 'EXECUTE') then
    raise exception 'a client role can execute apply_wallet_delta';
  end if;
end;
$$;

do $$
declare
  v_offenders text;
  -- Tables a client is genuinely allowed to write, and the verbs it may use.
  v_allowed text[] := array[
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
  -- 5. No unexpected write privilege for anon or authenticated.
  select string_agg(distinct format('%s:%s(%s)', table_name, privilege_type, grantee), ', ')
  into v_offenders
  from information_schema.role_table_grants
  where table_schema = 'public'
    and grantee in ('anon', 'authenticated')
    and privilege_type in ('INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES')
    and (table_name || ':' || privilege_type) <> all (v_allowed);

  if v_offenders is not null then
    raise exception 'unexpected client write privilege(s): %', v_offenders;
  end if;

  -- The wallet is called out explicitly because it is the one that matters most.
  if has_table_privilege('authenticated', 'public.wallets', 'INSERT')
     or has_table_privilege('authenticated', 'public.wallets', 'UPDATE')
     or has_table_privilege('authenticated', 'public.wallets', 'DELETE')
     or has_table_privilege('authenticated', 'public.wallet_ledger', 'INSERT')
     or has_table_privilege('authenticated', 'public.wallet_ledger', 'UPDATE')
     or has_table_privilege('authenticated', 'public.wallet_ledger', 'DELETE') then
    raise exception 'authenticated holds a write privilege on the wallet tables';
  end if;

  -- And progression, which is the other thing a modified client would target.
  if has_column_privilege('authenticated', 'public.profiles', 'level', 'UPDATE')
     or has_column_privilege('authenticated', 'public.profiles', 'xp', 'UPDATE') then
    raise exception 'authenticated can update profiles.level or profiles.xp';
  end if;

  -- And the daily-challenge seed.
  if has_column_privilege('authenticated', 'public.daily_challenges', 'seed_secret', 'SELECT')
     or has_column_privilege('anon', 'public.daily_challenges', 'seed_secret', 'SELECT') then
    raise exception 'a client role can read daily_challenges.seed_secret';
  end if;
end;
$$;

-- -----------------------------------------------------------------------------
-- 6. Column-level write grants on the money tables.
--
-- Blocks 1-5 read `information_schema.role_table_grants` and
-- `has_table_privilege`, both of which report TABLE-level grants only. Neither
-- sees `grant update (balance) on public.wallets to authenticated` — so the one
-- table the gate singles out as mattering most could be opened up without
-- tripping anything. `has_column_privilege` is the only check that sees it.
--
-- The wallet tables get an absolute rule rather than an allowlist: ordinary
-- tables legitimately carry narrow column grants (friend_requests.status,
-- notifications.read_at, and so on), but no client role has any business
-- writing any column of the ledger or the balance it derives from.
-- -----------------------------------------------------------------------------
do $$
declare
  v_offenders text;
begin
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
end;
$$;

-- -----------------------------------------------------------------------------
-- 7. Views must not launder RLS.
--
-- A view owned by a privileged role runs with that owner's rights unless it is
-- declared `security_invoker`. Granting such a view to `authenticated` hands
-- clients the owner's unrestricted view of the underlying table, and block 1
-- never looks at it because it filters `relkind = 'r'`. `daily_challenges_public`
-- is built correctly (security_invoker = true); this gate makes that mandatory
-- rather than merely conventional.
-- -----------------------------------------------------------------------------
do $$
declare
  v_offenders text;
begin
  select string_agg(c.relname, ', ' order by c.relname)
  into v_offenders
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public'
    and c.relkind in ('v', 'm')
    and (
      has_table_privilege('authenticated', c.oid, 'SELECT')
      or has_table_privilege('anon', c.oid, 'SELECT')
    )
    and coalesce(
          (
            select o.option_value
            from pg_options_to_table(c.reloptions) as o(option_name, option_value)
            where o.option_name = 'security_invoker'
          ),
          'false'
        ) <> 'true';

  if v_offenders is not null then
    raise exception
      'client-readable view(s) without security_invoker, which bypass RLS: %', v_offenders;
  end if;
end;
$$;
