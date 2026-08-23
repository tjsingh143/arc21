-- =============================================================================
-- Arc 21 — reward-bearing career attempts run on the server
-- =============================================================================
--
-- WHAT WAS MISSING. Nothing anywhere wrote `public.career_progress`. The table
-- existed with its constraints, its RLS and its deny-client-write trigger; the
-- cosmetic gates read it; `shared/career/progress.ts` marked a completed node's
-- reward `rewardOwed` and left `rewardClaimed` false "until a server grants
-- them". No server granted them. Three MVP acceptance criteria failed on it —
-- "Rewards", "Cosmetics earned", and eight of twenty-four cosmetics being
-- unobtainable — and so did the Definition of Done's "complete career
-- progression".
--
-- WHY IT IS A SERVER SESSION AND NOT A REPORTED SCORE. The specification is
-- explicit in three separate places:
--
--   "Career rewards | Server"                          (authority boundaries)
--   "A Career node may be practiced offline, but any reward-bearing attempt
--    requires server authority."                        (offline design)
--   "Move reward-bearing Quick Play and Career attempts to authoritative
--    server commands."                                  (build phases)
--
-- So a ranked attempt is a real session in a new `career` mode: the server owns
-- the shoe, validates every action, grades every decision against its own
-- strategy tables and counts the hands. The client reports nothing. The local
-- runner in `src/features/career` stays exactly as it is and stays unranked —
-- that is the "practiced offline" half, and it grants nothing.
--
-- CHIPS AT A CAREER TABLE ARE A SCORING MEDIUM. The 2,000 a node starts with
-- are not a buy-in: no wallet is debited, and the stack vanishes with the
-- session. `career` is therefore NOT in WALLET_BACKED_MODES, for the same
-- reason a tournament stack is not. The only wallet event in the whole mode is
-- the node's first-completion reward, paid once under a key derived from the
-- node and the player.
-- =============================================================================

alter type public.game_mode add value if not exists 'career';

commit;
begin;

-- -----------------------------------------------------------------------------
-- Attempts
-- -----------------------------------------------------------------------------
--
-- `career_progress` is the AGGREGATE — best stars, first completion, the ledger
-- row that paid. This is the per-attempt record it is computed from, and it
-- exists for the same reason `daily_entries` carries its own counters rather
-- than reading the week bucket: an attempt's accuracy is a fact about that
-- attempt, and `player_decision_periods` mixes in every ranked decision of the
-- week.
--
-- Every rate is stored as integer counts, and EV lost in MILLIONTHS as a
-- bigint. No floating-point column exists anywhere in this schema.

create table public.career_attempts (
  id                 uuid primary key default gen_random_uuid(),
  user_id            uuid not null references public.profiles (id) on delete cascade,
  career_node_id     uuid not null references public.career_nodes (id) on delete cascade,

  -- Null for a drill: a drill is not a dealt hand and has no table.
  game_session_id    uuid references public.game_sessions (id) on delete set null,

  format             text not null check (format in ('standard', 'drill')),
  status             text not null default 'in_progress'
                       check (status in ('in_progress', 'completed', 'abandoned')),

  hands_played       integer not null default 0 check (hands_played >= 0),
  decisions_total    integer not null default 0 check (decisions_total >= 0),
  decisions_optimal  integer not null default 0 check (decisions_optimal >= 0),
  unaided_total      integer not null default 0 check (unaided_total >= 0),
  unaided_optimal    integer not null default 0 check (unaided_optimal >= 0),
  ev_lost_micros     bigint  not null default 0 check (ev_lost_micros >= 0),

  starting_chips     bigint not null check (starting_chips >= 0),
  final_chips        bigint not null default 0 check (final_chips >= 0),

  stars              integer not null default 0 check (stars between 0 and 3),

  started_at         timestamptz not null default now(),
  completed_at       timestamptz,
  updated_at         timestamptz not null default now(),

  -- You cannot play better than perfectly, and an unaided decision is a subset
  -- of the graded ones. The same shape of guard `player_stats` carries.
  constraint career_attempts_optimal_within_total check (decisions_optimal <= decisions_total),
  constraint career_attempts_unaided_within_total check (unaided_total <= decisions_total),
  constraint career_attempts_unaided_optimal_within check (unaided_optimal <= unaided_total),
  constraint career_attempts_finished_has_timestamp check (
    status = 'in_progress' or completed_at is not null
  ),
  constraint career_attempts_stars_require_completion check (
    stars = 0 or status = 'completed'
  ),
  -- A drill has no table and no bankroll; a standard node has both.
  constraint career_attempts_drill_has_no_session check (
    format = 'standard' or game_session_id is null
  )
);

comment on table public.career_attempts is
  'One reward-bearing attempt at one career node. Every counter is written by '
  'the server from its own authoritative state; the client reports nothing. '
  'career_progress is the aggregate computed from these.';

-- One live attempt per node per player. A second would let a player run two
-- shoes at the same node and keep whichever went better, which is the career
-- equivalent of the daily challenge's one-ranked-attempt rule.
create unique index career_attempts_one_live
  on public.career_attempts (user_id, career_node_id)
  where status = 'in_progress';

create index career_attempts_user_idx on public.career_attempts (user_id, career_node_id);
create index career_attempts_session_idx on public.career_attempts (game_session_id);

create trigger career_attempts_set_updated_at
  before update on public.career_attempts
  for each row execute function public.set_updated_at();

create trigger career_attempts_deny_client_write
  before insert or update or delete on public.career_attempts
  for each row execute function public.deny_client_write();

alter table public.career_attempts enable row level security;

revoke all on table public.career_attempts from anon, authenticated;
grant select on table public.career_attempts to authenticated;

create policy career_attempts_select_own
  on public.career_attempts for select
  to authenticated
  using (user_id = (select auth.uid()));

-- -----------------------------------------------------------------------------
-- Drill scenarios
-- -----------------------------------------------------------------------------
--
-- A drill's scenarios are generated from a secret the server holds, exactly as
-- the daily challenge's shoe is, and regenerated to grade the answers. The
-- point is not secrecy — a drill has no hidden information, and the player is
-- looking at the hand — it is that the client cannot substitute EASIER
-- scenarios than the ones it was asked. The answers are graded against the
-- server's own regeneration, by index.
--
-- In `private`, which has no client grants at all, because a seed in a
-- client-readable table is not a seed.

create table private.career_drill_seeds (
  attempt_id     uuid primary key references public.career_attempts (id) on delete cascade,
  seed_secret    text not null check (char_length(seed_secret) between 32 and 128),
  focus          text not null,
  scenario_count integer not null check (scenario_count between 1 and 100),
  created_at     timestamptz not null default now()
);

comment on table private.career_drill_seeds is
  'The secret a drill attempt''s scenarios are derived from. Never leaves the '
  'server; regenerated at grading time so a client cannot answer a different '
  'question from the one it was asked.';

-- -----------------------------------------------------------------------------
-- Recording a finished attempt
-- -----------------------------------------------------------------------------
--
-- Takes the STARS the server computed and the counters it observed. It does not
-- take a verdict — there is no shape of this call that says "pay me" — and it
-- pays nothing: the reward is `apply_wallet_delta` in the Edge Function, under
-- a key derived from the node and the player, so a replayed finalisation cannot
-- credit twice. What this owns is the aggregate: best stars win, first
-- completion is stamped once, and the row is created if the node has never been
-- played.
--
-- `security definer` and revoked from every client role. The only caller is the
-- server's own connection.

create or replace function public.record_career_completion(
  p_user_id  uuid,
  p_node_id  uuid,
  p_stars    integer,
  p_score    bigint,
  p_at       timestamptz default now()
)
returns public.career_progress
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_row public.career_progress;
begin
  if p_stars < 0 or p_stars > 3 then
    raise exception 'stars out of range: %', p_stars using errcode = '22023';
  end if;

  insert into public.career_progress
    (user_id, career_node_id, status, stars, best_score, attempts, first_completed_at)
  values
    (p_user_id, p_node_id, 'completed', p_stars, greatest(p_score, 0), 1, p_at)
  on conflict (user_id, career_node_id) do update set
    status             = 'completed',
    -- Best-of, never last-of. A worse replay must not take a star away.
    stars              = greatest(public.career_progress.stars, excluded.stars),
    best_score         = greatest(public.career_progress.best_score, excluded.best_score),
    attempts           = public.career_progress.attempts + 1,
    -- Stamped by the FIRST completion and never moved.
    first_completed_at = coalesce(public.career_progress.first_completed_at, excluded.first_completed_at)
  returning * into v_row;

  return v_row;
end;
$$;

comment on function public.record_career_completion(uuid, uuid, integer, bigint, timestamptz) is
  'Folds one finished attempt into career_progress. Best-of for stars and score, '
  'first_completed_at stamped once. Pays nothing: the reward is a wallet delta '
  'keyed to the node and the player, written by the Edge Function.';

revoke execute on function
  public.record_career_completion(uuid, uuid, integer, bigint, timestamptz)
from public, anon, authenticated;

-- Counting an attempt that did NOT complete. Kept separate because the
-- aggregate's `attempts` should move for an abandoned run too, and folding that
-- into the function above would mean passing a "did they finish" flag — which
-- is the shape of call this design is avoiding.
create or replace function public.record_career_attempt_started(
  p_user_id uuid,
  p_node_id uuid
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  insert into public.career_progress (user_id, career_node_id, status, attempts)
  values (p_user_id, p_node_id, 'available', 1)
  on conflict (user_id, career_node_id) do update set
    attempts = public.career_progress.attempts + 1;
end;
$$;

comment on function public.record_career_attempt_started(uuid, uuid) is
  'Counts an attempt at the moment it starts, so an abandoned run is still an '
  'attempt. Never sets status to completed and never awards a star.';

revoke execute on function public.record_career_attempt_started(uuid, uuid)
from public, anon, authenticated;

-- -----------------------------------------------------------------------------
-- Reading your own career
-- -----------------------------------------------------------------------------
--
-- One call, so the map does not make eighteen. Returns the node CODE rather
-- than its id: the client keys everything on the slug from
-- `shared/career/nodes.ts`, and handing it a uuid would invite a second lookup
-- table on the client to translate.

create or replace function public.my_career_progress()
returns table (
  node_code          text,
  status             public.career_status,
  stars              integer,
  best_score         bigint,
  attempts           integer,
  first_completed_at timestamptz,
  reward_claimed_at  timestamptz
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select n.code, p.status, p.stars, p.best_score, p.attempts,
         p.first_completed_at, p.reward_claimed_at
  from public.career_progress p
  join public.career_nodes n on n.id = p.career_node_id
  where p.user_id = (select auth.uid())
  order by n.chapter_order, n.node_order;
$$;

comment on function public.my_career_progress() is
  'The caller''s own career progress, keyed by node code. Reads nothing about '
  'anybody else; auth.uid() is the only identity it will accept.';

revoke execute on function public.my_career_progress() from public, anon;
grant  execute on function public.my_career_progress() to authenticated;

-- -----------------------------------------------------------------------------
-- The authorization gate learns about `my_career_progress`
-- -----------------------------------------------------------------------------
--
-- `assert_client_authorization_surface()` carries the allowlist of public
-- functions each client role may execute, INSIDE its body — so a new
-- client-callable function means redefining it. `create or replace function`
-- silently reverts every later redefinition, so this starts from the LAST
-- version (20260818120000, which is still the only one) and changes exactly one
-- line. Everything else below is that version, verbatim.
--
-- Adding the function to the list is not a formality. The gate raises on any
-- public function `authenticated` can execute that it does not know about, and
-- it is called at the bottom of this file — so the migration itself fails if
-- the two disagree, which is how it was caught while writing this.

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
