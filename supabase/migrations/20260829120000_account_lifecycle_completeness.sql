-- =============================================================================
-- Arc 21 — account deletion must be total, and a signup must not lose a race
--
-- Phase 3 found five defects in the account lifecycle. Every one of them was
-- reproduced against the running stack before it was fixed, and every one has a
-- regression that fails when its fix is removed — four in
-- `supabase/tests/23_account_lifecycle.test.sql`, and the fifth in
-- `tests/server/account-lifecycle.integration.test.ts`, because a race between
-- two signups cannot be expressed in one pgTAP session.
--
-- A sixth change here is not a defect: `private.career_drill_seeds` never had
-- RLS, which exposed nothing (the schema grants USAGE to no API role) but left
-- the barrier one deep instead of two. The gate at the end of this file now
-- refuses a private table without it.
--
-- 1. DELETION FAILED WITH A FOREIGN KEY VIOLATION for a player who had hosted a
--    public matchmaking table. `join_matchmaking` makes whoever arrives first at
--    a tier the host of the room it creates — "the host by accident of arriving
--    first", in its own words. `rooms.host_user_id` cascades from `auth.users`,
--    so deleting that account deleted the room; `matchmaking_queue.room_id`
--    referenced it with no `on delete` clause, and the SECOND player's queue row
--    blocked the cascade:
--
--      update or delete on table "rooms" violates foreign key constraint
--      "matchmaking_queue_room_id_fkey" on table "matchmaking_queue"
--
--    PostgREST renders that as a 409 naming a constraint, so the player is told
--    nothing they can act on. `docs/PRIVACY.md` says holding a live seat is "the
--    only condition under which deletion is declined"; this was a second one,
--    undocumented, and reachable by playing one Quick Play table.
--
-- 2. DELETION EVICTED THE OTHER PLAYERS. Even where the cascade succeeded, it
--    deleted a lobby four other people were sitting in, because the host left.
--    `leave_room` has always had the right answer — migrate the host to the
--    longest-joined member, close the room only when nobody remains — and
--    deletion simply never called it. It does now, rather than restating the
--    rule: there is one implementation of who inherits a lobby.
--
-- 3. A DEPARTED SEAT WAS NOT ANONYMISED. `game_session_seats.user_id` is
--    `on delete set null`, so the seat survives with no owner — which is the
--    point, because other players sat at that table. But `display_name` is a
--    COPY of the profile's display name taken when the seat was opened, and
--    nothing cleared it. The deleted player stayed named, by name, on every
--    table they ever sat at, visible to every other participant through
--    `game_session_seats_select_participant`. Both this migration's predecessor
--    and `docs/PRIVACY.md` claimed the row "no longer identifies you".
--
-- 4. DELETION WAS REFUSED TO A PLAYER WHO HAD ALREADY LEFT. The guard counted
--    every seat of theirs in an ACTIVE session, including seats with status
--    `left` — which are the settled ones, written only after `settleTableClosure`
--    has returned the escrow. So leaving a busy public table and then trying to
--    delete produced "leave your table before deleting your account", telling
--    the player to do the thing they had just done, for as long as the other
--    players kept the table running.
--
-- 5. A CONCURRENT SIGNUP LOST ITS ACCOUNT. `handle_new_user` asks whether the
--    requested handle is taken and then inserts it. Two signups requesting one
--    handle a millisecond apart both see it free; the second violates
--    `profiles_username_key`, which aborts the trigger, aborts the `auth.users`
--    insert, and answers the player HTTP 500. Measured: twelve of twelve
--    concurrent pairs. The requested handle was never a guarantee — the branch
--    above it already falls back to a derived one when the name is taken — so
--    this only makes the fallback work when "taken" happens concurrently.
--
-- WHAT IS DELIBERATELY NOT CHANGED. `rooms.host_user_id` still cascades. Making
-- it `set null` would need `not null` dropped and every reader of a host taught
-- to expect nobody, for no gain once the room is handed over first.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. A room going away must never block anything
-- -----------------------------------------------------------------------------
--
-- A queue entry's `room_id` is a soft pointer: it records where the player was
-- matched, and it is meaningless once that room is gone. `no action` made it a
-- hard reference, so a room could not be deleted while any player remembered
-- being sent to it. `delete_own_account` below also releases such entries
-- explicitly, because a queue row left pointing at nothing would poll as
-- `matched` with no room code; this constraint is the structural backstop that
-- stops any FUTURE path failing the same way.

alter table public.matchmaking_queue
  drop constraint matchmaking_queue_room_id_fkey;

alter table public.matchmaking_queue
  add constraint matchmaking_queue_room_id_fkey
  foreign key (room_id) references public.rooms (id) on delete set null;

-- -----------------------------------------------------------------------------
-- 2. Private state that was added later, held to the same rule
-- -----------------------------------------------------------------------------
--
-- `private.game_state_private` and `private.game_commands` both carry RLS with
-- no policies — a deny-all that costs the server nothing, because `postgres` and
-- `service_role` hold BYPASSRLS. `private.career_drill_seeds` arrived in
-- 20260823130000 without it. Nothing was exposed: the schema grants USAGE to
-- nobody. But the barrier is meant to be two-deep, and the gate below now
-- refuses a private table that has only one.

revoke all on table private.career_drill_seeds from public;
revoke all on table private.career_drill_seeds from anon, authenticated, service_role;

alter table private.career_drill_seeds enable row level security;

-- -----------------------------------------------------------------------------
-- 3. Account creation: survive a lost race for the requested handle
-- -----------------------------------------------------------------------------
--
-- Redefined from 20260823150000_signup_handle_must_be_permitted.sql, which is
-- the LAST file to define it — checked with
-- `grep -l 'create or replace function public.handle_new_user' migrations/*.sql`
-- before a line was written, because copying an earlier version silently reverts
-- everything a later one added. Everything that file established is intact: the
-- derived handle is still put through `username_is_permitted`, and an
-- unpermitted base still draws a fresh one rather than suffixing a base whose
-- own characters are the problem.

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
  -- The display name AS ASKED FOR, before any fallback. Held separately so a
  -- retry below can rebuild the fallback against the handle it actually got.
  v_display_requested text;
  v_display   text;
  v_wallet_id uuid;
  v_constraint text;
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
  v_display_requested := public.sanitise_display_name(
    nullif(new.raw_user_meta_data ->> 'display_name', '')
  );

  /*
   * THE HANDLE CHECK ABOVE IS NOT ATOMIC WITH THE INSERT BELOW, AND CANNOT BE.
   *
   * `not exists (select …)` answers against COMMITTED rows. Two signups
   * requesting one handle a millisecond apart both find it free, and the second
   * one's insert violates `profiles_username_key` — which aborts this trigger,
   * aborts the `auth.users` insert that fired it, and hands the player HTTP 500
   * with no account and nothing to retry. Measured against the running stack:
   * twelve concurrent pairs, twelve 500s.
   *
   * Nothing above promised the requested handle — the very first branch already
   * falls back to a derived one when the name is taken. This makes that
   * fallback work when "taken" happens concurrently, which is the only case it
   * did not already cover.
   *
   * ONLY THE HANDLE IS RETRYABLE. A duplicate PRIMARY KEY means this account
   * already has a profile, which is a real fault and is re-raised rather than
   * quietly papered over with a different username.
   */
  loop
    v_display := left(coalesce(v_display_requested, v_username), 24);
    v_display := coalesce(public.sanitise_display_name(v_display), v_username);

    begin
      insert into public.profiles (id, username, display_name)
      values (new.id, v_username, v_display);
      exit;
    exception when unique_violation then
      get stacked diagnostics v_constraint = constraint_name;
      if v_constraint is distinct from 'profiles_username_key' then
        raise;
      end if;

      v_attempt := v_attempt + 1;
      if v_attempt > 50 then
        raise exception 'could not allocate a username for account %', new.id;
      end if;

      -- A fresh base, not a suffix. The collision says nothing about whether
      -- THIS base is usable, and re-deriving from the account id would collide
      -- with whatever the winner is now holding.
      loop
        v_base := 'p' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 12);
        exit when public.username_is_permitted(v_base);
      end loop;
      v_username := v_base;
    end;
  end loop;

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
  'Bootstraps a profile, statistics row, funded wallet and its opening ledger '
  'entry for a new account. The requested handle is a request: it is filtered, '
  'and replaced by a derived one if it is reserved, already taken, or taken by '
  'a concurrent signup between the check and the insert.';

-- `create or replace` preserves the existing ACL, but the pair is written out
-- anyway: a function whose privileges are left implicit is EXECUTE TO PUBLIC,
-- and this one inserts a funded wallet.
revoke execute on function public.handle_new_user() from public, anon, authenticated;

-- -----------------------------------------------------------------------------
-- 4. Account deletion: total, and refused for exactly one stated reason
-- -----------------------------------------------------------------------------

create or replace function public.delete_own_account()
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_user_id uuid := auth.uid();
  v_held    int;
  v_room_id uuid;
begin
  if v_user_id is null then
    raise exception 'deleting an account requires an authenticated session'
      using errcode = '42501';
  end if;

  /*
   * The ONLY refusal, and `docs/PRIVACY.md` says so.
   *
   * `seat.status <> 'left'` is the whole correction. A seat becomes `left` only
   * from `syncSeatRow(…, { status: 'left' })`, which the Edge Function calls
   * after `settleTableClosure` has returned the escrow — so a `left` seat owes
   * nothing and holds nothing. Counting it refused deletion to a player who had
   * already stood up from a public table, for as long as the OTHER players kept
   * that table running, with a message telling them to leave a table they had
   * left. `active` and `disconnected` still refuse: a disconnected seat still
   * has chips in escrow.
   */
  select count(*)
  into v_held
  from public.game_sessions s
  join public.game_session_seats seat on seat.game_session_id = s.id
  where seat.user_id = v_user_id
    and seat.status <> 'left'
    and s.status = 'active';

  if v_held > 0 then
    raise exception
      'leave your table before deleting your account'
      using errcode = 'P0001';
  end if;

  /*
   * Stand up from every lobby first, THROUGH `leave_room`.
   *
   * Not a restatement of its rule — a call to it. `leave_room` migrates the host
   * to the longest-joined remaining member and closes the room only when nobody
   * is left, which is exactly what should happen when a host deletes their
   * account. Letting `rooms.host_user_id`'s cascade do it instead deleted a
   * lobby the other players were still sitting in, and — because a matchmaking
   * queue entry pointed at that room — usually could not delete it at all.
   *
   * `leave_room` reads `auth.uid()`, which is this caller: SECURITY DEFINER
   * changes the executing role, never the request's claims.
   */
  for v_room_id in
    select room_id
    from public.room_members
    where user_id = v_user_id and status = 'joined'
  loop
    perform public.leave_room(v_room_id);
  end loop;

  /*
   * Release anyone still queued into a room that leaves with this account.
   *
   * After the loop above, a room this player still hosts has no joined members,
   * so this is normally a no-op. It is not redundant, though: the foreign key
   * is now `on delete set null`, and a queue row left saying `matched` with no
   * room would poll for ever as matched with no code to join. Cancelling it
   * sends the player back to the queue, which is the honest outcome.
   */
  update public.matchmaking_queue q
  set status = 'cancelled', room_id = null, matched_at = null
  where q.user_id <> v_user_id
    and q.room_id in (select r.id from public.rooms r where r.host_user_id = v_user_id);

  /*
   * ANONYMISE THE SHARED HISTORY THE FOREIGN KEYS ONLY HALF-ANONYMISE.
   *
   * `game_session_seats.user_id` is `on delete set null` so a game other people
   * played is not deleted out from under them. But `display_name` is a COPY of
   * the profile's display name, taken when the seat opened, and no foreign key
   * touches it — so an ownerless seat still said who had sat there, to every
   * other participant, for ever. Done BEFORE the delete, because afterwards
   * there is no `user_id` left to find these rows by.
   *
   * The column is `not null` and 1–24 characters, so the placeholder is a real
   * name rather than an empty string the table would have to render as a gap.
   */
  update public.game_session_seats
  set display_name = 'Deleted player'
  where user_id = v_user_id;

  /*
   * And notifications OTHER players hold about this account: a friend request
   * from them, an invite from them, an acceptance by them. Each carries their
   * display name in its body and deep-links to a profile that is about to stop
   * existing, so it is both a name left behind and a dead end. `from_user_id`
   * is one of the eight keys `notification_data_is_safe` permits, which is why
   * this can be asked as a query at all.
   */
  delete from public.notifications
  where data ->> 'from_user_id' = v_user_id::text;

  -- Everything personal cascades from here; anything shared is set null by its
  -- own foreign key, so the policy stays in the schema rather than in a list of
  -- deletes that drifts as tables are added. `23_account_lifecycle.test.sql`
  -- populates every user-scoped table and asserts the residue is nil.
  delete from auth.users where id = v_user_id;
end;
$$;

comment on function public.delete_own_account() is
  'Erases the caller''s account. Personal tables cascade; shared game history '
  'is anonymised, seat display names included. Hands over any lobby the caller '
  'hosts before leaving it. Refuses only while the player still holds a seat '
  'at a running table.';

revoke execute on function public.delete_own_account() from public, anon;
grant execute on function public.delete_own_account() to authenticated;

-- -----------------------------------------------------------------------------
-- 5. The gate, extended, and called as the last line
-- -----------------------------------------------------------------------------
--
-- Taken from 20260823190000_player_public_profile.sql, the LAST file to define
-- it, with one block added. A migration-time DO block only ever sees the state
-- at its own position in the ordering, which is why this is a function called
-- from both here and pgTAP rather than a block sitting in one migration.

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
