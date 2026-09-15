-- =============================================================================
-- Arc 21 — paging a leaderboard
--
-- The four boards took a row COUNT and nothing else. That is not pagination: it
-- is a bigger or smaller top-of-the-board, and a player at rank 130 could see
-- their own position (`my_leaderboard_position` reports it) with no way to look
-- at the players around them. The specification asks for "Top 100" and a
-- "'My position' neighbourhood"; the phase brief asks for pagination outright.
--
-- -----------------------------------------------------------------------------
-- WHY A NEW SIGNATURE RATHER THAN AN ADDED DEFAULT
-- -----------------------------------------------------------------------------
-- `create or replace function f(a int default 100, b int default 0)` does not
-- replace `f(a int default 100)`; it creates a SECOND function, and
-- `f(100)` then fails with "function is not unique". So each board is dropped
-- and recreated at its new arity, and every caller — `my_leaderboard_position`
-- below, and the client's `.rpc(...)` — resolves to the one that remains.
--
-- -----------------------------------------------------------------------------
-- WHY `row_number()` AS WELL AS `rank()`
-- -----------------------------------------------------------------------------
-- `rank()` is what a player reads: equal XP is equal placing, and the next
-- player's number reflects how many are ahead of them. But ties mean `rank` is
-- NOT a total order, and `order by rank offset 100 limit 25` over a tie can put
-- the same row on two pages and another row on none. `row_number()` over the
-- IDENTICAL window is a total order — every window here ends in `user_id` — so
-- paging is stable while the number on screen stays a rank.
--
-- The row type is unchanged: `row_number` orders the query and is never
-- returned, exactly like the `user_id` tie-break it inherits.
--
-- -----------------------------------------------------------------------------
-- WHY NO MAXIMUM PAGE SIZE
-- -----------------------------------------------------------------------------
-- `my_leaderboard_position` deliberately asks each board for a very wide page
-- and locates the caller inside it, so that "your position" is derived from the
-- same ordering the board itself used and the two cannot disagree. A cap here
-- would either break that or require a second, parallel implementation of every
-- board — which is the thing that guarantee exists to avoid. These functions are
-- executable by `authenticated` only, and the ceiling is the number of ranked
-- players, not a number a caller names.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- Weekly XP
-- ---------------------------------------------------------------------------

drop function if exists public.leaderboard_weekly_xp(integer);

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
  limit greatest(p_limit, 1);
$$;

revoke execute on function public.leaderboard_weekly_xp(integer, integer) from public, anon;
grant  execute on function public.leaderboard_weekly_xp(integer, integer) to authenticated;

-- ---------------------------------------------------------------------------
-- Tournament wins
-- ---------------------------------------------------------------------------

drop function if exists public.leaderboard_tournament_wins(integer);

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
  limit greatest(p_limit, 1);
$$;

revoke execute on function public.leaderboard_tournament_wins(integer, integer) from public, anon;
grant  execute on function public.leaderboard_tournament_wins(integer, integer) to authenticated;

-- ---------------------------------------------------------------------------
-- Strategy accuracy
-- ---------------------------------------------------------------------------
--
-- The qualification bar is unchanged and still read from
-- `strategy_accuracy_minimum_decisions()`: 100 server-graded decisions in the
-- ISO week, with the volume tie-break capped by
-- `strategy_accuracy_count_cap()` so grinding cannot outrank accuracy.

drop function if exists public.leaderboard_strategy_accuracy(integer);

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
  limit greatest(p_limit, 1);
$$;

revoke execute on function public.leaderboard_strategy_accuracy(integer, integer) from public, anon;
grant  execute on function public.leaderboard_strategy_accuracy(integer, integer) to authenticated;

-- ---------------------------------------------------------------------------
-- Daily challenge
-- ---------------------------------------------------------------------------
--
-- Ordering unchanged, and it is the specification's: score, then accuracy
-- (NULLS LAST — an unmeasured attempt is not a perfect one), then EV lost, then
-- submission time, then a deterministic tie rule. Body taken from
-- `20260818110000_daily_accuracy_tiebreak.sql`, the LAST migration to define
-- this function, per the `create or replace` rule in CLAUDE.md.

drop function if exists public.leaderboard_daily_challenge(date, integer);

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
  limit greatest(p_limit, 1);
$$;

comment on function public.leaderboard_daily_challenge(date, integer, integer) is
  'The daily board, one page at a time. Score, then accuracy, then EV lost, then '
  'submission time — the specification''s order. Accuracy and EV lost come from '
  'the attempt''s own graded decisions, never from the week bucket.';

revoke execute on function public.leaderboard_daily_challenge(date, integer, integer) from public, anon;
grant  execute on function public.leaderboard_daily_challenge(date, integer, integer) to authenticated;

-- ---------------------------------------------------------------------------
-- "My position" still comes from the boards themselves
-- ---------------------------------------------------------------------------
--
-- Copied from `20260817300000_decisions_and_leaderboards.sql`, the LAST file to
-- define it, with the offsets made explicit. It is redefined here rather than
-- left alone because the functions it calls have been dropped and recreated, and
-- a reader tracing the call graph should find both halves in one place.
create or replace function public.my_leaderboard_position(p_category text)
returns table (rank integer, value bigint, detail text, total_ranked integer)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  -- Wide enough that anyone with a place is found, bounded so a runaway board
  -- cannot turn this into an unbounded scan.
  v_wide integer := 10000;
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

-- A migration that changes a grant asks the gate, as its last line.
select public.assert_client_authorization_surface();
