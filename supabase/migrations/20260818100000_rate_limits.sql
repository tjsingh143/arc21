-- =============================================================================
-- Arc 21 — rate limits
--
-- The specification names six actions that must be limited:
--
--     friend requests per hour
--     room creation per minute/hour
--     room join attempts per minute
--     matchmaking enrollments
--     profile rename frequency
--     game commands outside an active game
--
-- and adds that "exact production limits may be constants/configuration, not
-- magic numbers scattered through functions". So the numbers live in ONE table,
-- `rate_limit_policies`, and every enforcement point reads them from there. The
-- only limit previously in the codebase — the 30-day username interval — was a
-- literal inside `guard_profile_username`; it has been moved here with the rest.
--
-- Five of the six actions run through a `SECURITY DEFINER` function that already
-- derives identity from `auth.uid()`. The sixth, game commands, is enforced in
-- the `game-command` Edge Function, which calls the same core through the same
-- policy table — there is no second set of numbers on the server.
--
-- -----------------------------------------------------------------------------
-- THE WINDOW IS ROLLING, NOT A CALENDAR BUCKET
-- -----------------------------------------------------------------------------
-- Every decision counts events strictly newer than `now() - window_length`. A
-- limit that resets on the hour is a limit that can be doubled at 59 minutes
-- past, which is not a limit.
--
-- -----------------------------------------------------------------------------
-- A REFUSED ATTEMPT IS NOT RECORDED
-- -----------------------------------------------------------------------------
-- Deliberate, and the difference between a limit and a ban. If a refusal also
-- wrote an event, a caller hammering faster than the window drains would keep
-- their own window permanently full and could never get back in. Recording only
-- what is allowed means the window always drains in exactly `window_length`.
--
-- -----------------------------------------------------------------------------
-- A REFUSAL MUST NOT BECOME A NEW PROBE
-- -----------------------------------------------------------------------------
-- The friend graph deliberately answers "no such player" for both a missing
-- account and a block, so a caller cannot use it to enumerate. A rate-limit
-- refusal must not undo that. Two rules follow, and both are load-bearing:
--
--   1. The limit is consumed BEFORE any lookup of the thing being acted on, so
--      the refusal is a pure function of the caller's own history. It cannot
--      differ by target and therefore cannot report anything about one.
--   2. The message says only that the caller has done this too often and when
--      to try again. It names no account, no room and no code.
--
-- -----------------------------------------------------------------------------
-- PT429
-- -----------------------------------------------------------------------------
-- PostgREST maps a SQLSTATE of the form `PTnnn` to HTTP status nnn, so a refusal
-- raised with `PT429` reaches the client as a real 429. This matters: the
-- pre-existing rename limit raised `55000`, which PostgREST renders as **HTTP
-- 500** — a player who renamed themselves twice in a month was told the server
-- had broken. Measured against the running stack before this file was written.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- The policy table — the one place the numbers live
-- -----------------------------------------------------------------------------
--
-- An action may carry MORE THAN ONE policy, which is how "room creation per
-- minute/hour" is expressed without inventing two action names: both rows are
-- checked and the tighter one refuses first. The primary key is a uuid because
-- `00_schema.test.sql` asserts every table in `public` has a single-column uuid
-- primary key; the real key is the unique constraint below it.
create table public.rate_limit_policies (
  id            uuid primary key default gen_random_uuid(),
  action        text not null check (action ~ '^[a-z][a-z0-9_]{2,63}$'),
  window_length interval not null check (window_length > interval '0'),
  max_events    integer not null check (max_events > 0),
  rationale     text not null check (char_length(rationale) between 1 and 400),

  constraint rate_limit_policies_one_row_per_window unique (action, window_length)
);

comment on table public.rate_limit_policies is
  'Every rate limit in the product, in one place. Read through rate_limit_for(); '
  'never duplicated as a literal inside a function. Server-owned: no client role '
  'holds any privilege on it, and RLS is enabled with no policy, so it is '
  'unreachable through PostgREST even if a grant were added by accident.';

comment on column public.rate_limit_policies.window_length is
  'The ROLLING window. Events are counted against now() - window_length, never '
  'against a calendar boundary.';

alter table public.rate_limit_policies enable row level security;

-- No policy, and no grant. RLS with zero policies is deny-all for every
-- non-superuser role, which is the intent stated plainly rather than a
-- `using (false)` that reads as an oversight.
revoke all on table public.rate_limit_policies from anon, authenticated;

create trigger rate_limit_policies_deny_client_write
  before insert or update or delete on public.rate_limit_policies
  for each row execute function public.deny_client_write();

-- -----------------------------------------------------------------------------
-- The events
-- -----------------------------------------------------------------------------
create table public.rate_limit_events (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users (id) on delete cascade,
  action      text not null,
  occurred_at timestamptz not null default now()
);

comment on table public.rate_limit_events is
  'One row per ALLOWED attempt. Refusals are not recorded — see the header of '
  'this migration. Pruned on every consume, so the table holds at most one '
  'window of history per player per action.';

-- The only access pattern: this player, this action, inside the window. The
-- descending timestamp lets the count stop as soon as it leaves the window.
create index rate_limit_events_window_idx
  on public.rate_limit_events (user_id, action, occurred_at desc);

alter table public.rate_limit_events enable row level security;
revoke all on table public.rate_limit_events from anon, authenticated;

create trigger rate_limit_events_deny_client_write
  before insert or update or delete on public.rate_limit_events
  for each row execute function public.deny_client_write();

-- -----------------------------------------------------------------------------
-- The verdict
-- -----------------------------------------------------------------------------
--
-- A composite rather than a bare boolean so a caller can tell a player when to
-- come back. `retry_after` is the time until the OLDEST event in the offending
-- window falls out of it, which is the moment one slot frees.
create type public.rate_limit_verdict as (
  allowed       boolean,
  action        text,
  max_events    integer,
  window_length interval,
  retry_after   interval
);

-- -----------------------------------------------------------------------------
-- Reading the policy — the single accessor
-- -----------------------------------------------------------------------------
create or replace function public.rate_limit_for(p_action text)
returns setof public.rate_limit_policies
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select * from public.rate_limit_policies
  where action = p_action
  order by window_length;
$$;

comment on function public.rate_limit_for(text) is
  'Every policy configured for one action, tightest window first. The only way '
  'any enforcement point learns a limit.';

revoke execute on function public.rate_limit_for(text) from public, anon, authenticated;

-- -----------------------------------------------------------------------------
-- Checking without consuming
-- -----------------------------------------------------------------------------
--
-- Read-only, so it is safe to call inside a transaction that is about to be
-- rolled back. `game-command` uses exactly that property: it asks this question
-- on the rejection path of a command that is going to throw anyway, which costs
-- a legitimate player nothing at all.
create or replace function public.rate_limit_check(p_user_id uuid, p_action text)
returns public.rate_limit_verdict
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_policy public.rate_limit_policies;
  v_now    timestamptz := now();
  v_used   integer;
  v_oldest timestamptz;
  v_any    boolean := false;
begin
  if p_user_id is null then
    raise exception 'a rate limit is measured against an identity' using errcode = '42501';
  end if;

  for v_policy in select * from public.rate_limit_for(p_action) loop
    v_any := true;

    select count(*), min(occurred_at) into v_used, v_oldest
    from public.rate_limit_events
    where user_id = p_user_id
      and action = p_action
      and occurred_at > v_now - v_policy.window_length;

    if v_used >= v_policy.max_events then
      return (
        false,
        p_action,
        v_policy.max_events,
        v_policy.window_length,
        greatest(v_oldest + v_policy.window_length - v_now, interval '0')
      )::public.rate_limit_verdict;
    end if;
  end loop;

  -- An unknown action is a programming error, not an open door. Failing closed
  -- here means a typo in an enforcement point refuses the action rather than
  -- silently disabling its limit.
  if not v_any then
    raise exception 'no rate limit policy is configured for action %', p_action
      using errcode = '22023';
  end if;

  return (true, p_action, null, null, null)::public.rate_limit_verdict;
end;
$$;

revoke execute on function public.rate_limit_check(uuid, text) from public, anon, authenticated;

-- -----------------------------------------------------------------------------
-- Consuming
-- -----------------------------------------------------------------------------
create or replace function public.consume_rate_limit(p_user_id uuid, p_action text)
returns public.rate_limit_verdict
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare
  v_verdict public.rate_limit_verdict;
  v_longest interval;
begin
  if p_user_id is null then
    raise exception 'a rate limit is measured against an identity' using errcode = '42501';
  end if;

  /*
   * Serialise this player's attempts at this action, and nothing else.
   *
   * Without it, two concurrent calls at max_events - 1 both count the same
   * shortfall under READ COMMITTED — neither sees the other's uncommitted row —
   * and both insert. The same reasoning, and the same tool, as the matchmaking
   * allocator: transaction-scoped, released at commit, and keyed narrowly enough
   * that two different players never wait on each other.
   */
  perform pg_advisory_xact_lock(
    hashtext('arc21:rate_limit:' || p_action),
    hashtext(p_user_id::text)
  );

  select coalesce(max(window_length), interval '0') into v_longest
  from public.rate_limit_for(p_action);

  -- Anything older than the longest window for this action can never change a
  -- decision again. Pruning here rather than on a schedule means there is no job
  -- that can fail to run and no unbounded table if one does.
  if v_longest > interval '0' then
    delete from public.rate_limit_events
    where user_id = p_user_id
      and action = p_action
      and occurred_at <= now() - v_longest;
  end if;

  v_verdict := public.rate_limit_check(p_user_id, p_action);

  -- Refusals are deliberately NOT recorded. See the header.
  if v_verdict.allowed then
    insert into public.rate_limit_events (user_id, action) values (p_user_id, p_action);
  end if;

  return v_verdict;
end;
$$;

comment on function public.consume_rate_limit(uuid, text) is
  'Records one attempt if the rolling window has room, and reports the verdict. '
  'Server-only: it names the player it charges, so no client role may reach it.';

revoke execute on function public.consume_rate_limit(uuid, text) from public, anon, authenticated;

-- -----------------------------------------------------------------------------
-- Consuming your own, and raising
-- -----------------------------------------------------------------------------
--
-- The raising wrapper the five SQL enforcement points call. Two properties:
--
--   * it derives the player from `auth.uid()`, so there is no argument through
--     which one account could spend another's budget;
--   * the message it raises names the action's limit and when to retry, and
--     nothing about whatever was being acted on.
--
-- It is granted to `authenticated` because ONE caller needs it: the profile
-- rename guard is an ordinary trigger running with the invoker's rights, so it
-- cannot reach a revoked function the way the SECURITY DEFINER routines can. The
-- grant is safe by construction — the only budget a caller can spend through it
-- is their own, which they could spend anyway by performing the action.
create or replace function public.enforce_rate_limit(p_action text)
returns public.rate_limit_verdict
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare
  v_me      uuid := auth.uid();
  v_verdict public.rate_limit_verdict;
begin
  if v_me is null then
    raise exception 'this requires an authenticated session' using errcode = '42501';
  end if;

  v_verdict := public.consume_rate_limit(v_me, p_action);

  if not v_verdict.allowed then
    raise exception
      'you have reached the limit of % for this action per %; try again in %',
      v_verdict.max_events,
      v_verdict.window_length,
      -- Whole seconds. A retry-after printed to six decimal places tells a
      -- caller the exact time of their own oldest attempt, which is more
      -- precision than the message needs.
      make_interval(secs => ceil(extract(epoch from v_verdict.retry_after))::int)
      using errcode = 'PT429';
  end if;

  return v_verdict;
end;
$$;

comment on function public.enforce_rate_limit(text) is
  'Consumes the caller''s own budget for an action and raises PT429 — HTTP 429 '
  'through PostgREST — when it is spent. Says only how often the action may be '
  'taken and when to retry: never anything about the target of the action.';

revoke execute on function public.enforce_rate_limit(text) from public, anon;
grant execute on function public.enforce_rate_limit(text) to authenticated;

-- =============================================================================
-- The policies
--
-- Every number in the product is below this line. The windows are deliberately
-- generous: these exist to stop scripted abuse, not to interrupt anybody who is
-- playing. A limit tight enough to inconvenience a real player is a limit that
-- will be relaxed in a hurry by somebody who does not know why it was set.
-- =============================================================================
insert into public.rate_limit_policies (action, window_length, max_events, rationale) values
  ('friend_request', interval '1 hour', 20,
   'Specification: friend requests per hour. Twenty is far above any real social '
   'session and far below a script working through a user list.'),

  ('room_create', interval '1 minute', 5,
   'Specification: room creation per minute. A host may already hold only one '
   'live room, so this bounds the close-and-reopen loop that would otherwise '
   'churn six-character codes.'),
  ('room_create', interval '1 hour', 40,
   'Specification: room creation per hour. The second half of the same line: a '
   'rate that is reasonable for a minute is not reasonable sustained.'),

  ('room_join', interval '1 minute', 10,
   'Specification: room join attempts per minute. This is the control that makes '
   'guessing a room code impractical, so it counts ATTEMPTS — a join that finds '
   'nothing is exactly the attempt worth limiting.'),

  ('matchmaking_enroll', interval '1 minute', 10,
   'Specification: matchmaking enrollments. Only a NEW enrolment is charged; '
   'polling and re-queueing after a reconnect return the existing entry and cost '
   'nothing, so a flaky connection never spends this.'),
  ('matchmaking_enroll', interval '1 hour', 60,
   'The sustained ceiling for the same action.'),

  ('profile_username_change', interval '30 days', 1,
   'Specification: profile rename frequency. The handle is an identity other '
   'players learn, so it moves at most once a month. This interval was a literal '
   'inside guard_profile_username until this migration.'),

  ('profile_display_name_change', interval '1 hour', 5,
   'The other half of "profile rename frequency". The display name is what every '
   'leaderboard row shows; it was previously unlimited, so a name could be '
   'changed between one screenshot and the next.'),

  ('game_command_outside_game', interval '1 minute', 30,
   'Specification: game commands outside an active game. Charged only when a '
   'command names a table the caller holds no live seat at, so ordinary play — '
   'which is several commands a HAND — never touches it.');

-- =============================================================================
-- Enforcement point 1 — friend requests
-- =============================================================================
--
-- The consume is the FIRST thing after the authentication check and BEFORE
-- `p_to` is looked at, so the refusal cannot differ between a real account, a
-- missing one and a block. Everything below that line is unchanged.
--
-- THE BODY IS COPIED FROM `20260817400000_notification_delivery.sql`, NOT FROM
-- `20260816100000_friends.sql`. That distinction cost a debugging round and is
-- the reason this note exists: `create or replace function` replaces the WHOLE
-- body, so copying an older definition silently reverts every later change to
-- it. The first draft of this migration took the version from the friends
-- migration and dropped the `notify_user` call the notification migration had
-- added — a friend request stopped producing a notification, and only
-- `tests/server/notifications.integration.test.ts` noticed. Before redefining
-- any function, `grep -l 'create or replace function public.<name>'` across
-- every migration and start from the LAST one.
create or replace function public.send_friend_request(p_to uuid)
returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_me   uuid := auth.uid();
  v_name text;
begin
  if v_me is null then
    raise exception 'sending a request requires an authenticated session' using errcode = '42501';
  end if;

  -- Before any lookup of p_to. A limit consumed after a lookup would answer
  -- differently for an account that exists, which is precisely the probe the
  -- shared "no such player" wording exists to prevent.
  perform public.enforce_rate_limit('friend_request');

  if p_to = v_me then
    raise exception 'you cannot add yourself' using errcode = 'P0001';
  end if;
  if not exists (select 1 from public.profiles where id = p_to) then
    raise exception 'no such player' using errcode = 'P0002';
  end if;
  if public.is_blocked_between(v_me, p_to) then
    -- Deliberately the same wording a missing account would produce. Telling an
    -- attacker "you are blocked" confirms the account exists and who blocked
    -- them; the specification asks for no free-text contact for this reason.
    raise exception 'no such player' using errcode = 'P0002';
  end if;

  if public.are_friends(v_me, p_to) then
    return 'friends';
  end if;

  select coalesce(display_name, username::text) into v_name
  from public.profiles where id = v_me;

  -- They already asked us: accept rather than creating a mirrored request.
  -- Two people tapping "add" at the same time must end up friends, not with a
  -- pair of pending requests neither can resolve.
  if exists (select 1 from public.friend_requests
             where sender_id = p_to and receiver_id = v_me and status = 'pending') then
    perform public.accept_friend_request(p_to);
    return 'friends';
  end if;

  -- Idempotent: asking twice is not an error and does not stack rows.
  if exists (select 1 from public.friend_requests
             where sender_id = v_me and receiver_id = p_to and status = 'pending') then
    return 'outgoing_pending';
  end if;

  insert into public.friend_requests (sender_id, receiver_id, status)
  values (v_me, p_to, 'pending')
  on conflict do nothing;

  -- Deduped on the pair, so withdrawing and re-sending does not buzz them again.
  perform public.notify_user(
    p_to,
    'friend_request',
    'Friend request',
    coalesce(v_name, 'Someone') || ' wants to be friends.',
    jsonb_build_object('from_user_id', v_me::text),
    'friend_request:' || v_me::text
  );

  return 'outgoing_pending';
end;
$$;

-- =============================================================================
-- Enforcement point 2 — room creation
-- =============================================================================
--
-- Body taken from `20260816130000_expire_rooms_on_use.sql`, the LAST migration
-- to define this function — see the note above `send_friend_request`. The first
-- draft copied it from `20260816110000_rooms.sql` instead and dropped the
-- `expire_stale_rooms()` call, which is the entire content of that later
-- migration: abandoned lobbies would have started holding their codes for ever
-- again. Nothing in pgTAP covers that path, so it would have gone out silently.
create or replace function public.create_private_room(p_max_seats int default 5)
returns public.rooms
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_me   uuid := auth.uid();
  v_room public.rooms;
begin
  if v_me is null then
    raise exception 'creating a table requires an authenticated session' using errcode = '42501';
  end if;

  perform public.enforce_rate_limit('room_create');

  if p_max_seats < 2 or p_max_seats > 5 then
    raise exception 'a private table seats between 2 and 5 players' using errcode = 'P0001';
  end if;

  -- Before the "one live room" check, so a player whose old lobby simply timed
  -- out is not told they already have a table open.
  perform public.expire_stale_rooms();

  -- One live room per host. Without this a player could spawn rooms endlessly,
  -- and every one of them would hold a code.
  if exists (
    select 1 from public.rooms
    where host_user_id = v_me and status in ('lobby', 'active', 'finishing')
  ) then
    raise exception 'you already have a table open' using errcode = 'P0001';
  end if;

  insert into public.rooms (code, host_user_id, max_seats)
  values (public.generate_room_code(), v_me, p_max_seats)
  returning * into v_room;

  insert into public.room_members (room_id, user_id, seat_index, is_ready)
  values (v_room.id, v_me, 0, true);

  return v_room;
end;
$$;

-- =============================================================================
-- Enforcement point 3 — room joins
-- =============================================================================
--
-- THIS ONE CHANGES ITS REFUSAL CONTRACT, AND THE REASON IS THE WHOLE POINT.
--
-- A rate limit consumed inside the caller's transaction is rolled back with that
-- transaction. Every other enforcement point here charges an attempt that then
-- SUCCEEDS, so that is harmless. A room join is the opposite: the attempt worth
-- limiting is the one that finds nothing, because this is the control that makes
-- guessing a six-character code impractical. If a failed guess raised, the whole
-- call — including the recorded attempt — would roll back, and a guesser would
-- have an unlimited budget. The limit would exist and enforce nothing.
--
-- So an unavailable table is no longer an exception. `join_private_room` returns
-- NO ROW, the attempt commits and is counted, and the client renders one fixed
-- sentence. This also closes a small oracle that was already here: "that table
-- is full" told a guesser their code had hit a real live room, while "that table
-- is not available" told them it had not. There is now exactly one answer for a
-- code that does not admit you, whatever the reason — the friend graph's
-- discipline, applied to room codes.
--
-- The rate limit itself still raises, with PT429. That is correct and is not the
-- same case: a refusal must NOT be recorded, so rolling it back is what we want.
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
  -- blocked or full. Returning rather than raising is what lets the attempt
  -- above be counted.
  if not found then return null; end if;
  if v_room.expires_at < now() then return null; end if;
  if public.is_blocked_between(v_me, v_room.host_user_id) then return null; end if;

  -- Rejoining is not an error; it is how reconnection works.
  if exists (select 1 from public.room_members
             where room_id = v_room.id and user_id = v_me and status = 'joined') then
    update public.room_members set last_seen_at = now()
    where room_id = v_room.id and user_id = v_me;
    return v_room;
  end if;

  select count(*) into v_taken
  from public.room_members
  where room_id = v_room.id and status = 'joined';

  if v_taken >= v_room.max_seats then return null; end if;

  -- Lowest free seat, so leaving and rejoining does not scatter people across
  -- the table.
  select coalesce(min(s), 0) into v_seat
  from generate_series(0, v_room.max_seats - 1) s
  where s not in (
    select seat_index from public.room_members
    where room_id = v_room.id and status = 'joined'
  );

  insert into public.room_members (room_id, user_id, seat_index)
  values (v_room.id, v_me, v_seat)
  on conflict (room_id, user_id) do update
    set status = 'joined', last_seen_at = now();

  return v_room;
end;
$$;

comment on function public.join_private_room(text) is
  'Joins a private table by code. Returns NO ROW for every reason a code does '
  'not admit you — unknown, expired, blocked, full — so a caller cannot tell a '
  'real code from a wrong one. Rate limited per rate_limit_policies.';

-- =============================================================================
-- Enforcement point 4 — matchmaking enrolments
-- =============================================================================
--
-- Only a NEW enrolment is charged. Re-queueing for the same tier after a
-- reconnect returns the existing entry and costs nothing, which matters because
-- that path is exactly what a flaky connection does repeatedly.
create or replace function public.join_matchmaking(p_tier public.table_tier)
returns public.matchmaking_queue
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_me    uuid := auth.uid();
  v_entry public.matchmaking_queue;
  v_level int;
begin
  if v_me is null then
    raise exception 'matchmaking requires an authenticated session' using errcode = '42501';
  end if;

  perform public.expire_stale_queue_entries();

  -- The tier's unlock level is checked here AND again when the seat is funded.
  -- This one is a courtesy so a player is not queued into a table they cannot
  -- sit at; the one that matters is the one next to the money.
  select level into v_level from public.profiles where id = v_me;
  if p_tier = 'high' and coalesce(v_level, 1) < 10 then
    raise exception 'the high table unlocks at level 10' using errcode = 'P0001';
  end if;

  -- Re-queueing is not an error: it is what a client does after a reconnect.
  select * into v_entry
  from public.matchmaking_queue
  where user_id = v_me and status = 'waiting';

  if found then
    if v_entry.tier <> p_tier then
      -- Changing your mind about the stakes cancels the old wait rather than
      -- leaving a player queued for two tables at once.
      update public.matchmaking_queue set status = 'cancelled'
      where id = v_entry.id;
    else
      -- Not a new enrolment, so nothing is charged.
      return v_entry;
    end if;
  end if;

  -- Charged here, immediately before the row that makes it an enrolment.
  perform public.enforce_rate_limit('matchmaking_enroll');

  insert into public.matchmaking_queue (user_id, tier)
  values (v_me, p_tier)
  returning * into v_entry;

  return v_entry;
end;
$$;

-- =============================================================================
-- Enforcement point 5 — profile renames
-- =============================================================================
--
-- The handle limit was already here as `interval '30 days'` written into the
-- function body; it now reads the policy table like everything else. Two changes
-- beyond that:
--
--   * the errcode moves from 55000 (HTTP 500 — the player was told the server
--     had broken) to PT429;
--   * the DISPLAY name is limited too. It is the name every leaderboard row
--     shows and it was previously unlimited.
--
-- Both go through the generic mechanism. An earlier draft kept the handle
-- measured against `profiles.username_changed_at` and read only the INTERVAL
-- from the policy table — which does not work, and the reason is worth writing
-- down: `guard_profile_username` is an ordinary trigger running with the
-- INVOKER's rights, so it cannot reach a function revoked from `authenticated`.
-- Either the policy accessor gets a client grant, or the guard calls the one
-- wrapper that already has one. The wrapper wins: one enforcement path, one
-- measurement, and nothing new is exposed.
--
-- `username_changed_at` is still stamped. It stops being the enforcement
-- mechanism and stays what it always looked like — the audit column saying when
-- this handle last moved.
create or replace function public.guard_profile_username()
returns trigger
language plpgsql
as $$
begin
  -- A handle is a lowercase-normalised identity, so normalise before deciding
  -- whether it changed: 'Admin' becomes 'admin' and is then refused as
  -- reserved rather than slipping past on letter case.
  new.username := lower(btrim(coalesce(new.username, '')));

  if tg_op = 'INSERT' then
    return new;
  end if;

  if new.username is not distinct from old.username then
    return new;
  end if;

  if not public.username_is_permitted(new.username) then
    raise exception 'username "%" is reserved or not permitted', new.username
      using errcode = '23514';
  end if;

  if public.is_client_role() then
    perform public.enforce_rate_limit('profile_username_change');
  end if;

  new.username_changed_at := now();
  return new;
end;
$$;

revoke execute on function public.guard_profile_username() from public;

comment on column public.profiles.username_changed_at is
  'When this handle last moved. Stamped by guard_profile_username() and absent '
  'from the client UPDATE grant. It records the change; the LIMIT on how often '
  'one may happen lives in rate_limit_policies like every other limit.';

-- One-time reconciliation for accounts that renamed before this migration.
--
-- Enforcement moves from a column to the events table, and a player who renamed
-- yesterday must not get a free second rename because the new table has no
-- history. Anything older than the configured window is already spent and needs
-- no row.
insert into public.rate_limit_events (user_id, action, occurred_at)
select p.id, 'profile_username_change', p.username_changed_at
from public.profiles p
cross join lateral (
  select window_length from public.rate_limit_policies
  where action = 'profile_username_change'
) policy
where p.username_changed_at is not null
  and p.username_changed_at > now() - policy.window_length;

-- The display name goes through the generic mechanism, because unlike the handle
-- it has no timestamp column of its own and does not need one.
create or replace function public.guard_profile_display_name_rate()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'UPDATE'
     and public.is_client_role()
     and new.display_name is distinct from old.display_name then
    perform public.enforce_rate_limit('profile_display_name_change');
  end if;

  return new;
end;
$$;

revoke execute on function public.guard_profile_display_name_rate() from public;

comment on function public.guard_profile_display_name_rate() is
  'Rate limits display-name changes. Runs AFTER normalise_profile_display_name '
  'so that re-saving a name which sanitises to the same string is free.';

-- Ordering matters and is alphabetical in Postgres: `profiles_normalise_display_name`
-- sorts before `profiles_rate_limit_display_name`, so the comparison below sees
-- the sanitised value and a cosmetic edit that normalises to the same string
-- costs nothing.
create trigger profiles_rate_limit_display_name
  before update on public.profiles
  for each row execute function public.guard_profile_display_name_rate();

-- -----------------------------------------------------------------------------
-- Housekeeping for deleted accounts
-- -----------------------------------------------------------------------------
-- `rate_limit_events.user_id` cascades from `auth.users`, so deleting an account
-- takes its history with it. Asserted in 11_delete_account.test.sql.
