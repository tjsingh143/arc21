-- =============================================================================
-- Arc 21 — a room ends when its game does, a started table stops taking
--          newcomers, and "last seen" is a time somebody was actually seen
-- =============================================================================
--
-- Three defects, all three reproduced against the running stack through
-- client-reachable calls only before this file existed.
--
-- -----------------------------------------------------------------------------
-- 1. A ROOM WAS NEVER CLOSED WHEN ITS GAME ENDED, SO A HOST COULD OPEN EXACTLY
--    ONE PRIVATE TABLE, EVER.
-- -----------------------------------------------------------------------------
--
-- `leave_room` closes a room when the last JOINED member leaves it, and that is
-- the only thing in the entire schema that has ever written `status = 'closed'`.
-- It is reachable from the lobby and from nowhere else: the moment the host
-- deals, every client navigates to `/table/[gameId]`, and leaving THERE sends
-- `CASH_OUT` to the `create-session` function, which settles the seat and ends
-- the session without touching the room. `expire_stale_rooms()` cannot help —
-- it only ever looks at `status = 'lobby'`.
--
-- So a played-out room sits at `active` for ever. Measured:
--
--     start:                200 private_table_started
--     both players CASH_OUT 200 cashed_out  (game_sessions.status = completed)
--     rooms row:            status = active, code still held
--     create_private_room:  400 P0001 "you already have a table open"
--
-- That last line is permanent. One private table per account for the lifetime of
-- the account, and the six-character code never comes back — and six characters
-- are only plentiful because retired rooms give theirs up.
--
-- THE RULE THIS FILE ADDS IS DELIBERATELY NARROW. A room is retired only when
-- its session is over AND no seat at it still holds anything: `game_sessions`
-- says `completed`/`abandoned`, and no `game_session_seats` row is anything but
-- `left`. A private table holds no escrow, but a PUBLIC one does, and "never
-- delete or reconcile a room while relevant economic state remains" has to be
-- mechanical rather than a comment. A room whose session is still `active` is
-- left exactly where it is, however long ago its players stopped playing:
-- reconciling THOSE stacks is a different job with different consequences, and
-- doing it wrong mints or strands chips.
--
-- -----------------------------------------------------------------------------
-- 2. A NEWCOMER COULD JOIN A ROOM THAT WAS ALREADY PLAYING, AND WAS THEN
--    STRANDED IN THE LOBBY WITH NOTHING ON SCREEN TO SAY SO.
-- -----------------------------------------------------------------------------
--
-- `join_private_room` admits `status in ('lobby', 'active')`, which is right for
-- the case it was written for — rejoining IS how reconnection works. But it did
-- not distinguish a returning player from a stranger. Seats are fixed when the
-- host deals; a player who arrives afterwards gets a `room_members` row and no
-- `game_session_seats` row at all, and the lobby's own resolution step
-- (`findSeat`) therefore returns null on every poll, for ever. Measured:
--
--     third player join_private_room:  200, room row returned
--     get_room_state:                  200, three members listed
--     game_session_seats for them:     []
--
-- The lobby then shows "3 of 5 seated" and never navigates, with no message,
-- while the other two play. Refusing is the correct answer and it is also the
-- answer the specification gives — "once playing, the server owns the game" —
-- and it is refused with the SAME silent no-row every other cause uses, so a
-- code-guesser still cannot tell a live table from a wrong guess.
--
-- The reconnect case is preserved twice over: an existing `joined` member
-- returns before this check is reached, and a member whose row is no longer
-- `joined` is re-seated if — and only if — they already hold a seat in the
-- session, which is the one case where "already playing" is not a newcomer.
--
-- -----------------------------------------------------------------------------
-- 3. `profiles.last_seen_at` WAS WRITTEN ONCE, AT SIGNUP, AND NEVER AGAIN.
-- -----------------------------------------------------------------------------
--
-- The specification asks for ephemeral Realtime presence and says to "persist
-- only last_seen_at for fallback". The column exists, `list_friends()` returns
-- it, `player_public_profile()` returns it, and the app renders it through
-- `describeLastSeen` — whose own doc comment says the value is "written at some
-- unstated moment in the past". It is written at exactly one moment: the
-- INSERT in `handle_new_user`. Nothing has ever updated it.
--
-- So the fallback beneath presence was the account's creation date, presented
-- as a fact about when somebody was last around. A friend playing at that very
-- moment reads as "Last seen over a week ago" unless they happen to have the
-- Social tab open, which is the only place the presence channel is joined.
--
-- `touch_last_seen()` is the missing write, and it is deliberately the ONLY
-- thing that writes the column: the client cannot, because `authenticated`
-- holds no UPDATE grant on it. Its call sites are the presence store's — the
-- moment a player publishes presence and the moment they change it — so "last
-- seen" means "last on the presence channel", which is a claim the data
-- actually supports.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Housekeeping: a lobby times out, and a finished table's room retires with it
-- -----------------------------------------------------------------------------
-- Redefined from `20260816110000_rooms.sql`, the only file to define it.

create or replace function public.expire_stale_rooms()
returns int
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_count int;
  v_closed int;
begin
  -- Safe to run at any time and from anywhere: a private room holds no escrow,
  -- so expiring one can never strand chips. The equivalent for a public table
  -- must reconcile stacks first and is deliberately not written here.
  update public.rooms
  set status = 'expired'
  where status = 'lobby' and expires_at < now();

  get diagnostics v_count = row_count;

  /*
   * A room whose GAME is over.
   *
   * Three conditions, and all three are the point:
   *
   *   - the room points at a session,
   *   - that session is `completed` or `abandoned` — the server's own word for
   *     "this table is finished", written in the same transaction as the last
   *     seat's settlement,
   *   - and no seat at it is anything but `left`, so nothing is still holding
   *     chips that a wallet is owed.
   *
   * The third is redundant today and is here on purpose. `settleTableClosure`
   * marks a seat `left` in the same transaction that credits it, so a completed
   * session cannot have a held seat — but this is the check that would notice
   * if that ever stopped being true, and the consequence of retiring a room out
   * from under unreconciled escrow is chips nobody can reach.
   *
   * A room whose session is still `active` is left alone however long ago
   * everybody stopped playing. The specification's "empty active room cleanup,
   * after safely reconciling stacks" needs that reconciliation to exist first,
   * and inventing it here would be the opposite of safe.
   */
  update public.rooms r
  set status = 'closed'
  where r.status in ('active', 'finishing')
    and r.game_session_id is not null
    and exists (
      select 1 from public.game_sessions g
      where g.id = r.game_session_id
        and g.status in ('completed', 'abandoned')
    )
    and not exists (
      select 1 from public.game_session_seats s
      where s.game_session_id = r.game_session_id
        and s.status <> 'left'
    );

  get diagnostics v_closed = row_count;
  return v_count + v_closed;
end;
$$;

comment on function public.expire_stale_rooms() is
  'Retires rooms nobody can still use: a lobby past its 30 minutes, and a room '
  'whose game session has ended with every seat settled. Never touches a room '
  'whose session is still running — reconciling those stacks is a different job.';

-- `leave_room` and `create_private_room` already call this; so does the room
-- lookup below, so a player returning to Social is enough to retire their own
-- finished room without any scheduled job.
revoke execute on function public.expire_stale_rooms() from public, anon, authenticated;

-- -----------------------------------------------------------------------------
-- A room that has dealt is closed to newcomers
-- -----------------------------------------------------------------------------
-- Redefined from `20260823180000_room_seats_and_removal.sql`, the LAST file to
-- define it. It carries `enforce_rate_limit('room_join')`, the returns-no-row
-- refusal contract that makes that limit enforceable, the `kicked` check and the
-- seat re-assignment on rejoin. All four are preserved verbatim.

create or replace function public.join_private_room(p_code text)
returns public.rooms
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_me    uuid := auth.uid();
  v_room  public.rooms;
  v_seat  int;
  v_taken int;
begin
  if v_me is null then
    raise exception 'joining requires an authenticated session' using errcode = '42501';
  end if;

  -- Before the code is looked at, for the same reason as the friend graph: a
  -- limit consumed after the lookup would answer differently for a code that
  -- resolves.
  perform public.enforce_rate_limit('room_join');

  -- Codes are typed by hand: fold case and drop spaces before matching, so a
  -- player who types "abc def" is not told their code is wrong.
  select * into v_room
  from public.rooms
  where code = upper(regexp_replace(coalesce(p_code, ''), '\s', '', 'g'))
    and status in ('lobby', 'active')
  -- Lock the room so two people taking the last seat cannot both succeed.
  for update;

  -- One answer for every reason a code does not admit you: unknown, expired,
  -- blocked, removed, playing already or full. Returning rather than raising is
  -- what lets the attempt above be counted.
  if not found then return null; end if;
  if v_room.expires_at < now() then return null; end if;
  if public.is_blocked_between(v_me, v_room.host_user_id) then return null; end if;

  -- Removed by the host, and it sticks. Same silent refusal as every other:
  -- a removed player is not told they were removed by a code that stops
  -- working, and a guesser learns nothing either way.
  if exists (
    select 1 from public.room_members
    where room_id = v_room.id and user_id = v_me and status = 'kicked'
  ) then
    return null;
  end if;

  -- Rejoining is not an error; it is how reconnection works.
  if exists (select 1 from public.room_members
             where room_id = v_room.id and user_id = v_me and status = 'joined') then
    update public.room_members set last_seen_at = now()
    where room_id = v_room.id and user_id = v_me;
    return v_room;
  end if;

  /*
   * ONCE THE TABLE HAS DEALT, THE SERVER OWNS THE GAME.
   *
   * Seats are fixed when the host deals, so a player arriving afterwards would
   * get a `room_members` row and no `game_session_seats` row — and the lobby,
   * which resolves its own seat from that table, would poll for one for ever
   * with nothing on screen to explain why. Reproduced against the running
   * stack: a third player joined a playing room, `get_room_state` listed them,
   * and their seat query returned `[]`.
   *
   * Below the "already joined" branch, so an ordinary reconnect never reaches
   * it, and past a player who HOLDS a seat in the session, which is the one
   * case where somebody not currently a joined member is not a newcomer — a
   * player whose membership was ended while their seat was still live gets back
   * in by typing the same code.
   */
  if v_room.game_session_id is not null
     and not exists (
       select 1 from public.game_session_seats s
       where s.game_session_id = v_room.game_session_id
         and s.user_id = v_me
         -- A SETTLED seat is not a reconnection. A player who cashed out has
         -- had their chips; letting the code seat them again as a room member
         -- with no live game seat is the same stranding as a newcomer's.
         and s.status <> 'left'
     ) then
    return null;
  end if;

  select count(*) into v_taken
  from public.room_members
  where room_id = v_room.id and status = 'joined';

  if v_taken >= v_room.max_seats then return null; end if;

  -- Lowest free seat, so leaving and rejoining does not scatter people across
  -- the table. `status = 'joined'` here is the same predicate as the partial
  -- unique index `room_members_live_seat_idx`.
  select coalesce(min(s), 0) into v_seat
  from generate_series(0, v_room.max_seats - 1) s
  where s not in (
    select seat_index from public.room_members
    where room_id = v_room.id and status = 'joined'
  );

  insert into public.room_members (room_id, user_id, seat_index)
  values (v_room.id, v_me, v_seat)
  on conflict (room_id, user_id) do update
    -- `seat_index` is re-assigned, not kept. A returning player's old seat may
    -- have been taken while they were away, and holding the stale number is
    -- how one returning player collided with the person now sitting there.
    set status = 'joined', seat_index = excluded.seat_index, last_seen_at = now();

  return v_room;
end;
$$;

revoke execute on function public.join_private_room(text) from public, anon;
grant  execute on function public.join_private_room(text) to authenticated;

-- -----------------------------------------------------------------------------
-- Leaving a room, whoever is asking
-- -----------------------------------------------------------------------------
--
-- A FOURTH DEFECT, and the one that shows why the three above are one subject.
-- `leave_room` derives the caller from `auth.uid()`, and it is the ONLY thing
-- that ends a room membership or migrates the host role. The Edge Functions run
-- as the service role with no JWT claims, so they cannot call it — and leaving a
-- table that has already dealt does not go through the lobby at all. "Leave
-- table" sends `CASH_OUT`, which settles the seat and returns the stack, and
-- never touched `room_members`.
--
-- Measured against the running stack: a host at a three-seat table cashes out,
-- the other two keep playing, and afterwards
--
--     game_sessions.status                    active
--     rooms.host_user_id = the departed host  t
--     room_members.status for them            joined
--     the app's restore() query               returns the room
--     create_private_room                     400 "you already have a table open"
--
-- Three consequences. The departed player is put BACK into the lobby of a table
-- they have cashed out of, and from there the lobby resolves their now-`left`
-- seat and walks them to a table where every command answers SESSION_CLOSED.
-- They cannot open another private table until strangers finish playing. And
-- the host role never migrates, so the specification's "if host leaves, transfer
-- the social host role to the longest-connected eligible user" held only in the
-- lobby — the one place a host leaving matters least, because there is no game
-- to keep running.
--
-- `release_room_seat` is `leave_room`'s body with the identity as a parameter,
-- and `leave_room` becomes a one-line caller of it. ONE implementation of host
-- migration, not two: a second copy is how the two would eventually disagree
-- about which member inherits a room. It is server-only — an argument naming
-- WHOSE seat to release is exactly what must never be client-callable.

create or replace function public.release_room_seat(p_room_id uuid, p_user_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_room      public.rooms;
  v_next      uuid;
  v_remaining int;
begin
  if p_user_id is null then
    raise exception 'releasing a seat needs an account' using errcode = '42501';
  end if;

  select * into v_room from public.rooms where id = p_room_id for update;
  if not found then return; end if;

  update public.room_members
  set status = 'left', is_ready = false
  where room_id = p_room_id and user_id = p_user_id and status = 'joined';

  select count(*) into v_remaining
  from public.room_members
  where room_id = p_room_id and status = 'joined';

  if v_remaining = 0 then
    update public.rooms set status = 'closed' where id = p_room_id;
    return;
  end if;

  -- Host migration. The host owns the invite and the lobby, never the dealer or
  -- the shoe — those are the server's — so handing the role over cannot change
  -- how a hand plays out, and NOTHING here touches the game session.
  -- Longest-connected member takes it.
  if v_room.host_user_id = p_user_id then
    select user_id into v_next
    from public.room_members
    where room_id = p_room_id and status = 'joined'
    order by joined_at
    limit 1;

    update public.rooms set host_user_id = v_next where id = p_room_id;
  end if;
end;
$$;

comment on function public.release_room_seat(uuid, uuid) is
  'Ends one player''s room membership, migrating the host role and closing the '
  'room when it empties. Server-only: the argument names whose seat to release. '
  'leave_room is the caller-scoped wrapper, and the Edge Functions call this '
  'when a player cashes out of a table that has already dealt.';

revoke execute on function public.release_room_seat(uuid, uuid) from public, anon, authenticated;

-- `leave_room` keeps its signature, its grant and its behaviour; the body is now
-- a single call, so there is exactly one implementation of the rule.
create or replace function public.leave_room(p_room_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_me uuid := auth.uid();
begin
  if v_me is null then
    raise exception 'this requires an authenticated session' using errcode = '42501';
  end if;
  perform public.release_room_seat(p_room_id, v_me);
end;
$$;

revoke execute on function public.leave_room(uuid) from public, anon;
grant  execute on function public.leave_room(uuid) to authenticated;

-- -----------------------------------------------------------------------------
-- "Last seen" becomes a time somebody was seen
-- -----------------------------------------------------------------------------

create or replace function public.touch_last_seen()
returns timestamptz
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_me   uuid := auth.uid();
  v_when timestamptz;
begin
  if v_me is null then
    raise exception 'this requires an authenticated session' using errcode = '42501';
  end if;

  /*
   * The caller's own row and no other. There is no parameter to point at
   * somebody else, for the same reason none of the friend functions takes a
   * "from": an API where the client names whose row to stamp is one where a
   * modified client backdates or forward-dates a stranger's presence.
   *
   * SECURITY DEFINER because `authenticated` deliberately holds no UPDATE grant
   * on this column — `assert_client_authorization_surface()` would fail the
   * migration that added one — so this function is the only way it moves.
   */
  update public.profiles
  set last_seen_at = now()
  where id = v_me
  returning last_seen_at into v_when;

  return v_when;
end;
$$;

comment on function public.touch_last_seen() is
  'Stamps the caller''s own last_seen_at. The fallback beneath ephemeral '
  'Realtime presence: called when a player publishes presence, so "last seen" '
  'means "last on the presence channel".';

revoke execute on function public.touch_last_seen() from public, anon;
grant  execute on function public.touch_last_seen() to authenticated;

-- -----------------------------------------------------------------------------
-- The gate learns about `touch_last_seen`
-- -----------------------------------------------------------------------------
--
-- Copied VERBATIM from `20260830120000_active_session_lookup.sql`, the LAST file
-- to define it, with one name added to the allowlist. `create or replace
-- function` replaces a body wholesale, so starting from any earlier version
-- would silently revert every check added since — which has already cost this
-- repository a `notify_user` call and an `expire_stale_rooms()` call.
--
-- Called as the last line of the migration, because a migration-time DO block
-- only ever sees the state at its own position in the ordering.

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

select public.assert_client_authorization_surface();
