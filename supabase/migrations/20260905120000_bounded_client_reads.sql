-- =============================================================================
-- Arc 21 — phase 11, bounding what one client request can ask the server to do
--
-- Three findings, each MEASURED against the running stack before it was written
-- and re-measured after. None of them changes a rule of the game, a payout or a
-- card; all three are the same shape — *a client names how much work the server
-- does, and nothing says how much is too much.*
--
--   1. `leaderboard_*` took `p_limit` straight from the caller. Measured:
--      `p_limit => 2147483647` answered HTTP 200 with every ranked row in the
--      window, in one response.
--   2. `register_push_token` had no per-account ceiling. Measured: **200 rows
--      for one account in 1.9 seconds**, and `pending_push_deliveries` JOINS
--      notifications to tokens, so each of those is a copy of every message.
--   3. `search_players` built a LIKE pattern out of unescaped user input. Its
--      own comment says a query under two characters "would return most of the
--      table" — and `'%%'` is two characters. Measured: 108 calls walked
--      **445 distinct accounts** with nothing refused.
--
-- The general rule this file writes down: *an argument that decides how much
-- work happens is an argument that must be bounded by the server.*
-- =============================================================================


-- -----------------------------------------------------------------------------
-- 1. A leaderboard page has a ceiling
-- -----------------------------------------------------------------------------
--
-- Every board ends `limit greatest(p_limit, 1)`. `greatest` bounds it BELOW —
-- a negative or zero page becomes one row — and nothing bounds it above.
--
-- The confidentiality of the rows is not what is at stake and it is worth being
-- exact about that: a leaderboard is by specification a public board of avatar,
-- display name and value, `p_offset` is unbounded, and paging 25 at a time
-- already reaches every row. What one unbounded request buys an attacker is the
-- RESPONSE — one call that materialises and serialises the whole board.
--
-- The ceiling is 10,000 and it is not a new number. `my_leaderboard_position`
-- has read each board at `v_wide := 10000` since the boards existed, under a
-- comment that says why — "wide enough that anyone with a place is found,
-- bounded so a runaway board cannot turn this into an unbounded scan". That is
-- the same argument, arrived at for the same reason, and the reason this is a
-- FUNCTION rather than a literal in five places is that the two must not drift:
-- a maximum below what `my_leaderboard_position` asks for would silently stop
-- telling players outside the top page where they stand.
--
-- So no real caller changes behaviour. The client asks for `PAGE_SIZE` (25).
create or replace function public.leaderboard_page_maximum()
returns integer
language sql
immutable
as $$ select 10000 $$;

comment on function public.leaderboard_page_maximum() is
  'The most rows one leaderboard call may return. Shared by the four boards and '
  'by my_leaderboard_position, which reads a board this wide to find the caller.';

-- Server-only. Every reader is a `security definer` body that runs as the
-- owner, so no client needs the grant — and the gate refuses a `public`
-- function that `authenticated` can execute and nothing has allowlisted, which
-- is exactly how this line came to be written.
revoke execute on function public.leaderboard_page_maximum() from public, anon, authenticated;

-- Each body below is taken from `20260903120000_leaderboard_pagination.sql`, the
-- LAST migration to define it, per the `create or replace` rule in CLAUDE.md.
-- The ONLY line that differs in each is the last one.

create or replace function public.leaderboard_weekly_xp(
  p_limit  integer default 100,
  p_offset integer default 0
)
returns setof public.leaderboard_row
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  with totals as (
    select d.user_id, sum(d.repeatable_xp + d.milestone_xp)::bigint as xp
    from public.player_daily_xp d
    where d.utc_day >= public.utc_week_start()
      and d.utc_day < public.utc_week_start() + 7
    group by d.user_id
    having sum(d.repeatable_xp + d.milestone_xp) > 0
  ),
  ranked as (
    select
      rank()       over (order by t.xp desc, t.user_id)::integer as rank,
      row_number() over (order by t.xp desc, t.user_id)::integer as position,
      p.display_name::text,
      public.avatar_asset_for(t.user_id) as avatar_asset_key,
      t.xp as value,
      null::text as detail,
      t.user_id = (select auth.uid()) as is_you
    from totals t
    join public.profiles p on p.id = t.user_id
  )
  select rank, display_name, avatar_asset_key, value, detail, is_you
  from ranked
  order by position
  offset greatest(coalesce(p_offset, 0), 0)
  limit least(greatest(coalesce(p_limit, 100), 1), public.leaderboard_page_maximum());
$$;

revoke execute on function public.leaderboard_weekly_xp(integer, integer) from public, anon;
grant  execute on function public.leaderboard_weekly_xp(integer, integer) to authenticated;

create or replace function public.leaderboard_tournament_wins(
  p_limit  integer default 100,
  p_offset integer default 0
)
returns setof public.leaderboard_row
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  with tallies as (
    select
      e.user_id,
      count(*) filter (where e.placement = 1)::bigint as wins,
      count(*) filter (where e.placement = 2)::bigint as seconds,
      count(*)::bigint as entries
    from public.tournament_entries e
    join public.tournaments t on t.id = e.tournament_id
    where t.status = 'completed'
      -- A withdrawn entry is not a tournament anybody played.
      and e.status <> 'withdrawn'
    group by e.user_id
    having count(*) filter (where e.placement = 1) > 0
  ),
  ranked as (
    select
      rank()       over (order by x.wins desc, x.seconds desc, x.entries desc, x.user_id)::integer as rank,
      row_number() over (order by x.wins desc, x.seconds desc, x.entries desc, x.user_id)::integer as position,
      p.display_name::text,
      public.avatar_asset_for(x.user_id) as avatar_asset_key,
      x.wins as value,
      (x.entries::text || ' entered') as detail,
      x.user_id = (select auth.uid()) as is_you
    from tallies x
    join public.profiles p on p.id = x.user_id
  )
  select rank, display_name, avatar_asset_key, value, detail, is_you
  from ranked
  order by position
  offset greatest(coalesce(p_offset, 0), 0)
  limit least(greatest(coalesce(p_limit, 100), 1), public.leaderboard_page_maximum());
$$;

revoke execute on function public.leaderboard_tournament_wins(integer, integer) from public, anon;
grant  execute on function public.leaderboard_tournament_wins(integer, integer) to authenticated;

create or replace function public.leaderboard_strategy_accuracy(
  p_limit  integer default 100,
  p_offset integer default 0
)
returns setof public.leaderboard_row
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  with qualified as (
    select
      d.user_id,
      d.decisions_total,
      ((d.decisions_optimal::bigint * 10000) / d.decisions_total)::bigint as accuracy_bp
    from public.player_decision_periods d
    where d.period_start = public.utc_week_start()
      and d.decisions_total >= public.strategy_accuracy_minimum_decisions()
  ),
  ranked as (
    select
      rank() over (
        order by q.accuracy_bp desc,
                 least(q.decisions_total, public.strategy_accuracy_count_cap()) desc,
                 q.user_id
      )::integer as rank,
      row_number() over (
        order by q.accuracy_bp desc,
                 least(q.decisions_total, public.strategy_accuracy_count_cap()) desc,
                 q.user_id
      )::integer as position,
      p.display_name::text,
      public.avatar_asset_for(q.user_id) as avatar_asset_key,
      q.accuracy_bp as value,
      (q.decisions_total::text || ' decisions') as detail,
      q.user_id = (select auth.uid()) as is_you
    from qualified q
    join public.profiles p on p.id = q.user_id
  )
  select rank, display_name, avatar_asset_key, value, detail, is_you
  from ranked
  order by position
  offset greatest(coalesce(p_offset, 0), 0)
  limit least(greatest(coalesce(p_limit, 100), 1), public.leaderboard_page_maximum());
$$;

revoke execute on function public.leaderboard_strategy_accuracy(integer, integer) from public, anon;
grant  execute on function public.leaderboard_strategy_accuracy(integer, integer) to authenticated;

create or replace function public.leaderboard_daily_challenge(
  p_date   date default null,
  p_limit  integer default 100,
  p_offset integer default 0
)
returns setof public.leaderboard_row
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  with target as (
    select id from public.daily_challenges
    where challenge_date = coalesce(p_date, (now() at time zone 'utc')::date)
  ),
  ranked as (
    select
      rank() over (
        order by e.score desc,
                 public.accuracy_basis_points(e.decisions_optimal, e.decisions_total) desc nulls last,
                 e.ev_lost_micros asc,
                 e.completed_at asc,
                 e.user_id
      )::integer as rank,
      row_number() over (
        order by e.score desc,
                 public.accuracy_basis_points(e.decisions_optimal, e.decisions_total) desc nulls last,
                 e.ev_lost_micros asc,
                 e.completed_at asc,
                 e.user_id
      )::integer as position,
      p.display_name::text,
      public.avatar_asset_for(e.user_id) as avatar_asset_key,
      e.score as value,
      (
        e.hands_played::text || ' hands' ||
        coalesce(
          ' · ' ||
          (public.accuracy_basis_points(e.decisions_optimal, e.decisions_total) / 100)::text ||
          '% accurate',
          ''
        )
      ) as detail,
      e.user_id = (select auth.uid()) as is_you
    from public.daily_entries e
    join target t on t.id = e.daily_challenge_id
    join public.profiles p on p.id = e.user_id
    where e.status = 'completed'
  )
  select rank, display_name, avatar_asset_key, value, detail, is_you
  from ranked
  order by position
  offset greatest(coalesce(p_offset, 0), 0)
  limit least(greatest(coalesce(p_limit, 100), 1), public.leaderboard_page_maximum());
$$;

comment on function public.leaderboard_daily_challenge(date, integer, integer) is
  'The daily board, one page at a time. Score, then accuracy, then EV lost, then '
  'submission time — the specification''s order. Accuracy and EV lost come from '
  'the attempt''s own graded decisions, never from the week bucket.';

revoke execute on function public.leaderboard_daily_challenge(date, integer, integer) from public, anon;
grant  execute on function public.leaderboard_daily_challenge(date, integer, integer) to authenticated;

/*
 * And the OTHER copy of the number.
 *
 * `my_leaderboard_position` carried `v_wide integer := 10000` as a literal.
 * Leaving it there would put the ceiling in two places with nothing tying them
 * together — and the drift that matters is silent: lower the maximum below
 * `v_wide` and the boards keep working while every player outside the top page
 * quietly stops being told where they stand, because the wide read they are
 * found in has been trimmed underneath them.
 *
 * Body from `20260903120000_leaderboard_pagination.sql`, the LAST migration to
 * define it, with that one line changed.
 */
create or replace function public.my_leaderboard_position(p_category text)
returns table (rank integer, value bigint, detail text, total_ranked integer)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  -- Wide enough that anyone with a place is found, bounded so a runaway board
  -- cannot turn this into an unbounded scan. The SAME bound the boards clamp to,
  -- read from the one place that states it.
  v_wide integer := public.leaderboard_page_maximum();
begin
  if auth.uid() is null then
    raise exception 'this requires an authenticated session' using errcode = '42501';
  end if;

  if p_category = 'weekly_xp' then
    return query
      with board as (select * from public.leaderboard_weekly_xp(v_wide, 0))
      select b.rank, b.value, b.detail, (select count(*)::integer from board)
      from board b where b.is_you;
  elsif p_category = 'tournament_wins' then
    return query
      with board as (select * from public.leaderboard_tournament_wins(v_wide, 0))
      select b.rank, b.value, b.detail, (select count(*)::integer from board)
      from board b where b.is_you;
  elsif p_category = 'strategy_accuracy' then
    return query
      with board as (select * from public.leaderboard_strategy_accuracy(v_wide, 0))
      select b.rank, b.value, b.detail, (select count(*)::integer from board)
      from board b where b.is_you;
  elsif p_category = 'daily_challenge' then
    return query
      with board as (select * from public.leaderboard_daily_challenge(null, v_wide, 0))
      select b.rank, b.value, b.detail, (select count(*)::integer from board)
      from board b where b.is_you;
  else
    raise exception 'unknown leaderboard %', p_category using errcode = '22023';
  end if;
end;
$$;

revoke execute on function public.my_leaderboard_position(text) from public, anon;
grant  execute on function public.my_leaderboard_position(text) to authenticated;


-- -----------------------------------------------------------------------------
-- 2. An account holds a bounded number of devices
-- -----------------------------------------------------------------------------
--
-- `register_push_token` conflicts on the TOKEN, so a real device registering
-- again updates one row however many times it launches. A modified client
-- sending a fresh string each time inserted a fresh row each time, with nothing
-- counting: measured at 200 rows for one account in 1.9 s, and there is no
-- ceiling in that number, only how long the loop was left running.
--
-- Two costs, and the second is the one that matters. Rows are cheap; DELIVERIES
-- are not. `pending_push_deliveries` JOINS `notifications` to `push_tokens`, so
-- N registered tokens turn every single notification for that account into N
-- outbound messages. That is an amplifier the account holder controls.
--
-- The fix is a ceiling with an eviction rule, not a refusal: a player who really
-- has replaced a phone eleven times must still be able to register the eleventh.
-- The OLDEST-USED registration is retired, which is the one least likely to be a
-- device still in somebody's hand.
create or replace function public.push_tokens_per_account_maximum()
returns integer
language sql
immutable
as $$ select 10 $$;

comment on function public.push_tokens_per_account_maximum() is
  'The most push registrations one account may hold. A notification is delivered '
  'once per registration, so this bounds fan-out as well as rows.';

-- Server-only, for the same reason as `leaderboard_page_maximum()` above.
revoke execute on function public.push_tokens_per_account_maximum() from public, anon, authenticated;

-- Body from `20260817400000_notification_delivery.sql`, the LAST migration to
-- define it, with the eviction added below the upsert.
create or replace function public.register_push_token(
  p_token     text,
  p_platform  public.push_platform,
  p_device_id text default null,
  p_kinds     public.notification_kind[] default '{}'
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_me uuid := auth.uid();
begin
  if v_me is null then
    raise exception 'registering a device requires an authenticated session' using errcode = '42501';
  end if;
  if p_token is null or char_length(p_token) < 8 or char_length(p_token) > 512 then
    raise exception 'that does not look like a push token' using errcode = 'P0001';
  end if;

  insert into public.push_tokens (user_id, token, platform, device_id, allowed_kinds, is_active)
  values (v_me, p_token, p_platform, p_device_id, coalesce(p_kinds, '{}'), true)
  on conflict (token) do update
    set user_id       = v_me,
        platform      = excluded.platform,
        device_id     = excluded.device_id,
        allowed_kinds = excluded.allowed_kinds,
        is_active     = true,
        last_used_at  = now();

  /*
   * Evict, never refuse.
   *
   * `t.token <> p_token` is not belt and braces; it is the invariant. The first
   * version of this relied on the row just written being the newest and so
   * never the one evicted — which `now()` does not guarantee, because it is
   * fixed for a transaction. `25_bounded_reads.test.sql` registered forty
   * devices in one statement, every row took the SAME `last_used_at`, the
   * survivors were then chosen by a random uuid, and the registration the
   * caller had just made was among the thirty deleted. A device left with no
   * working registration is a worse outcome than the growth this bounds, so the
   * exclusion is stated rather than argued for.
   *
   * `last_used_at` then `created_at` then `id` orders the REST: least recently
   * used goes first, which is the registration least likely to be a device
   * still in somebody's hand, and the last two keys make the rule total so the
   * plan never decides it.
   */
  delete from public.push_tokens t
  where t.user_id = v_me
    and t.token <> p_token
    and t.id not in (
      select id from public.push_tokens
      where user_id = v_me
        and token <> p_token
      order by last_used_at desc, created_at desc, id desc
      limit greatest(public.push_tokens_per_account_maximum() - 1, 0)
    );
end;
$$;

comment on function public.register_push_token(text, public.push_platform, text, public.notification_kind[]) is
  'Registers this device. An account holds at most push_tokens_per_account_maximum() '
  'registrations; the least recently used is retired rather than the new one refused.';

revoke execute on function
  public.register_push_token(text, public.push_platform, text, public.notification_kind[])
from public, anon;
grant execute on function
  public.register_push_token(text, public.push_platform, text, public.notification_kind[])
to authenticated;


-- -----------------------------------------------------------------------------
-- 3. A search query is DATA, and `%` and `_` are not
-- -----------------------------------------------------------------------------
--
-- `search_players` interpolated the caller's text into a LIKE pattern:
--
--     p.username::text like v_q || '%' or lower(p.display_name) like '%' || v_q || '%'
--
-- so every metacharacter in it was a metacharacter in the pattern. Its own
-- comment states the guard that was supposed to hold — "a one-character query
-- would return most of the table; make the caller be specific rather than paging
-- through everybody" — and `'%%'` is two characters that match everything.
--
-- MEASURED: `'%%'`, `'__'`, `'_a'` and `'%a'` each answered 25 rows against a
-- database where `'zz'` answered none, and 108 calls of the form `%<c>`,
-- `<c>%`, `_<c>` enumerated 445 distinct accounts with nothing refused.
--
-- Two changes, and both are needed. The pattern escapes `\`, `%` and `_` so the
-- text is matched as text — and the action gets a rate-limit policy, because
-- escaping bounds what ONE query returns and only a limit bounds how many
-- queries there are. Nothing else in the social surface was unlimited:
-- `friend_request`, `room_create`, `room_join` and `matchmaking_enroll` all have
-- policies, and search was the one that did not.
insert into public.rate_limit_policies (action, window_length, max_events, rationale)
values
  (
    'player_search',
    interval '1 minute',
    30,
    'Finding somebody to add takes a handful of queries; a directory walk takes '
    'thousands. Thirty a minute is above any real search session and below a '
    'script working through the alphabet.'
  ),
  (
    'player_search',
    interval '1 hour',
    300,
    'The sustained ceiling for the same action. A minute-rate that is reasonable '
    'in a burst is not reasonable held for an hour.'
  )
on conflict do nothing;

/*
 * VOLATILE now, and that is the point rather than a side effect.
 *
 * It was `stable`, and a `stable` function may not write — so the limit could
 * not be spent inside it. The tempting shape is a `search_players_limited`
 * wrapper that spends the limit and calls this one; that is a control the
 * CLIENT enforces and the server does not, because `search_players` would still
 * be granted to `authenticated` and a modified client would simply call it.
 * CLAUDE.md already records that mistake in another form ("a policy the client
 * enforces and the server does not is a stated policy, not an enforced one"),
 * so the limit goes where it cannot be walked around.
 *
 * Nothing is lost by dropping `stable`: no query plans on it, and supabase-js
 * POSTs every `.rpc()` call, so PostgREST's GET-for-stable routing is not in
 * play either.
 *
 * Body otherwise from `20260816100000_friends.sql`, the only migration to
 * define it.
 */
create or replace function public.search_players(p_query text)
returns table (
  id uuid,
  username text,
  display_name text,
  level integer,
  relationship text
)
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare
  v_me uuid := auth.uid();
  v_q  text := lower(btrim(coalesce(p_query, '')));
  v_p  text;
begin
  if v_me is null then
    raise exception 'searching requires an authenticated session' using errcode = '42501';
  end if;

  /*
   * Spent BEFORE the query is looked at, and before the length guard, which is
   * the rule `CLAUDE.md` states for every enforcement point: a refusal that
   * arrives at different speeds for different inputs is a probe. It also means
   * a script cannot buy budget by sending queries it knows are too short.
   */
  perform public.enforce_rate_limit('player_search');

  -- A one-character query would return most of the table; make the caller be
  -- specific rather than paging through everybody.
  if length(v_q) < 2 then
    return;
  end if;

  /*
   * The pattern, with the caller's text quoted into it rather than pasted.
   *
   * `\` first — escaping it after the others would escape the backslashes this
   * very expression just added. `escape '\'` is then stated explicitly rather
   * than left to the server default, so the meaning of this pattern does not
   * depend on a setting.
   */
  v_p := replace(replace(replace(v_q, '\', '\\'), '%', '\%'), '_', '\_');

  return query
  select p.id,
         p.username::text,
         p.display_name,
         p.level,
         case
           when public.are_friends(v_me, p.id) then 'friends'
           when exists (select 1 from public.friend_requests r
                        where r.sender_id = v_me and r.receiver_id = p.id and r.status = 'pending')
             then 'outgoing_pending'
           when exists (select 1 from public.friend_requests r
                        where r.sender_id = p.id and r.receiver_id = v_me and r.status = 'pending')
             then 'incoming_pending'
           else 'none'
         end
  from public.profiles p
  where p.id <> v_me
    -- Blocked people do not appear in search at all, in either direction.
    and not public.is_blocked_between(v_me, p.id)
    and (p.username::text like v_p || '%' escape '\'
         or lower(p.display_name) like '%' || v_p || '%' escape '\')
  order by
    -- Exact handle first, then prefix matches, then display-name matches.
    (p.username::text = v_q) desc,
    (p.username::text like v_p || '%' escape '\') desc,
    p.username
  limit 25;
end;
$$;

comment on function public.search_players(text) is
  'Finds players by exact or partial handle or display name. The query is matched '
  'as TEXT: % and _ are escaped, so the two-character minimum cannot be walked '
  'around with metacharacters. Rate-limited as player_search.';

revoke execute on function public.search_players(text) from public, anon;
grant  execute on function public.search_players(text) to authenticated;

-- A migration that changes a grant asks the gate, as its last line.
select public.assert_client_authorization_surface();
