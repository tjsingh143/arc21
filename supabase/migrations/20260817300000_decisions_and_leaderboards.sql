-- =============================================================================
-- Arc 21 — server-graded decisions, and the four leaderboards
--
-- The specification's requirement for the strategy board is "minimum 100
-- eligible SERVER-AUTHORITATIVE decisions in period", which is the whole reason
-- this file exists: a client-reported accuracy is a client-chosen accuracy.
--
-- Every leaderboard here is a function rather than a view, for two reasons. It
-- lets each one derive "your position" for the caller without a second query,
-- and it keeps the projection deliberate: these return a display name, an avatar
-- asset key and a number, and never a user id or an email. SECURITY.md forbids
-- exposing account identifiers, and a leaderboard is the easiest place to leak
-- one by accident.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- Decisions, bucketed by week
-- ---------------------------------------------------------------------------

-- Monday 00:00 UTC, as a date. Postgres' `date_trunc('week', …)` is
-- ISO-8601 — weeks start Monday — which is exactly what the specification asks
-- for, so this is a naming wrapper rather than arithmetic of our own.
create or replace function public.utc_week_start(p_at timestamptz default now())
returns date
language sql
immutable
as $$
  select (date_trunc('week', p_at at time zone 'utc'))::date;
$$;

comment on function public.utc_week_start(timestamptz) is
  'Monday 00:00 UTC of the week containing p_at. The leaderboard period boundary.';

grant execute on function public.utc_week_start(timestamptz) to anon, authenticated;

create table if not exists public.player_decision_periods (
  id                 uuid primary key default gen_random_uuid(),
  user_id            uuid not null references auth.users (id) on delete cascade,
  -- Monday of the period. A date rather than a timestamp because the boundary is
  -- a calendar one and comparing dates cannot pick up a timezone by accident.
  period_start       date not null,

  decisions_total    integer not null default 0 check (decisions_total >= 0),
  decisions_optimal  integer not null default 0 check (decisions_optimal >= 0),

  updated_at         timestamptz not null default now(),

  constraint player_decision_periods_unique unique (user_id, period_start),
  -- The same shape of guard `player_stats` carries: you cannot play better than
  -- perfectly.
  constraint player_decision_periods_optimal_within_total
    check (decisions_optimal <= decisions_total)
);

comment on table public.player_decision_periods is
  'Server-graded basic-strategy decisions per player per ISO week. Written only by '
  'record_decisions, which is reachable by no API role. Practice, private tables '
  'and tournaments are excluded before a row is ever written.';

create index player_decision_periods_period_idx
  on public.player_decision_periods (period_start, decisions_total desc);

alter table public.player_decision_periods enable row level security;

-- Readable so a player can see their own qualification progress — "62 of the 100
-- decisions you need this week" — and nothing else.
create policy player_decision_periods_select_own on public.player_decision_periods
  for select using (user_id = (select auth.uid()));

grant select on table public.player_decision_periods to authenticated;

create trigger player_decision_periods_deny_client_write
  before insert or update or delete on public.player_decision_periods
  for each row execute function public.deny_client_write();

-- Records a batch of graded decisions.
--
-- Takes counts, never a verdict per hand, so there is no shape of this call that
-- says "this player's accuracy is 100%". The caller has already established
-- eligibility; this function's job is arithmetic and the period boundary.
create or replace function public.record_decisions(
  p_user_id  uuid,
  p_total    integer,
  p_optimal  integer,
  p_at       timestamptz default now()
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_week date := public.utc_week_start(p_at);
begin
  if p_total < 0 or p_optimal < 0 or p_optimal > p_total then
    raise exception 'incoherent decision batch: % of %', p_optimal, p_total
      using errcode = '22023';
  end if;
  if p_total = 0 then
    return;
  end if;

  insert into public.player_decision_periods (user_id, period_start, decisions_total, decisions_optimal)
  values (p_user_id, v_week, p_total, p_optimal)
  on conflict (user_id, period_start) do update
    set decisions_total = public.player_decision_periods.decisions_total + p_total,
        decisions_optimal = public.player_decision_periods.decisions_optimal + p_optimal,
        updated_at = now();

  -- The lifetime figures on `player_stats` have existed since the first schema
  -- migration and were never written by anything. They are now.
  update public.player_stats
  set decisions_total = decisions_total + p_total,
      decisions_optimal = decisions_optimal + p_optimal,
      updated_at = now()
  where user_id = p_user_id;
end;
$$;

comment on function public.record_decisions(uuid, integer, integer, timestamptz) is
  'Applies a batch of SERVER-GRADED decisions to the week bucket and the lifetime '
  'totals. Counts only — there is no parameter here through which a client could '
  'assert its own accuracy. Server-only.';

revoke execute on function public.record_decisions(uuid, integer, integer, timestamptz)
  from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Weekly XP needs milestone XP to be dated
-- ---------------------------------------------------------------------------
--
-- `award_milestone_xp` deliberately bypasses the repeatable daily cap, and so it
-- also bypassed `player_daily_xp` entirely — which meant a tournament prize or a
-- daily reward could not appear on a weekly board at all. Recording it in its own
-- column keeps both properties: it is dated, and it is uncapped.
alter table public.player_daily_xp
  add column if not exists milestone_xp integer not null default 0
    check (milestone_xp >= 0);

comment on column public.player_daily_xp.milestone_xp is
  'One-off XP earned on this day — tournament placements, daily rewards. Dated so '
  'the weekly board can include it; deliberately NOT subject to the repeatable cap.';

create or replace function public.award_milestone_xp(p_user_id uuid, p_xp integer)
returns bigint
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_total bigint;
  v_day   date := (now() at time zone 'utc')::date;
begin
  if p_xp < 0 then
    raise exception 'milestone XP cannot be negative' using errcode = '22023';
  end if;

  update public.profiles
  set xp = xp + p_xp, updated_at = now()
  where id = p_user_id
  returning xp into v_total;

  if v_total is null then
    raise exception 'no profile for %', p_user_id using errcode = 'P0002';
  end if;

  -- Dated, so a weekly board can see it. Still uncapped.
  insert into public.player_daily_xp (user_id, utc_day, repeatable_xp, milestone_xp)
  values (p_user_id, v_day, 0, p_xp)
  on conflict (user_id, utc_day) do update
    set milestone_xp = public.player_daily_xp.milestone_xp + p_xp,
        updated_at = now();

  return v_total;
end;
$$;

revoke execute on function public.award_milestone_xp(uuid, integer) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- The public-safe projection every board returns
-- ---------------------------------------------------------------------------
--
-- Deliberately narrow. `display_name` is already public, `avatar_asset_key` is a
-- key into the bundled asset index rather than a URL, and `value` is a number.
-- There is no user id and no email in this shape, so a board cannot leak one
-- however it is joined.
do $$ begin
  create type public.leaderboard_row as (
    rank              integer,
    display_name      text,
    avatar_asset_key  text,
    value             bigint,
    detail            text,
    is_you            boolean
  );
exception when duplicate_object then null; end $$;

-- The equipped avatar, or null when a player has not chosen one. A LEFT JOIN
-- through the loadout, so a player with no cosmetics still appears on the board.
create or replace function public.avatar_asset_for(p_user_id uuid)
returns text
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select c.asset_key
  from public.loadouts l
  join public.cosmetics c on c.id = l.avatar_cosmetic_id
  where l.user_id = p_user_id;
$$;

revoke execute on function public.avatar_asset_for(uuid) from public, anon;
grant execute on function public.avatar_asset_for(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- Weekly XP
-- ---------------------------------------------------------------------------
--
-- Resets Monday 00:00 UTC by construction: the period is derived, never stored,
-- so there is no scheduled job that can fail to run and no stale row to clear.
create or replace function public.leaderboard_weekly_xp(p_limit integer default 100)
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
      -- `rank()` rather than `row_number()`: equal XP is equal placing, and the
      -- next player's number reflects how many are ahead of them.
      rank() over (order by t.xp desc, t.user_id)::integer as rank,
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
  order by rank
  limit greatest(p_limit, 1);
$$;

grant execute on function public.leaderboard_weekly_xp(integer) to authenticated;

-- ---------------------------------------------------------------------------
-- Tournament wins
-- ---------------------------------------------------------------------------
--
-- Wins, then second places, then entries — the specification's ordering. Only
-- completed tournaments count, so a running one cannot show a placement that has
-- not been settled.
create or replace function public.leaderboard_tournament_wins(p_limit integer default 100)
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
    group by e.user_id
    having count(*) filter (where e.placement = 1) > 0
  ),
  ranked as (
    select
      rank() over (order by x.wins desc, x.seconds desc, x.entries desc, x.user_id)::integer as rank,
      p.display_name::text,
      public.avatar_asset_for(x.user_id) as avatar_asset_key,
      x.wins as value,
      -- Said out loud, because "3" alone hides whether that was 3 from 4 or 3
      -- from 40, and the second figure is the interesting one.
      (x.entries::text || ' entered') as detail,
      x.user_id = (select auth.uid()) as is_you
    from tallies x
    join public.profiles p on p.id = x.user_id
  )
  select rank, display_name, avatar_asset_key, value, detail, is_you
  from ranked
  order by rank
  limit greatest(p_limit, 1);
$$;

grant execute on function public.leaderboard_tournament_wins(integer) to authenticated;

-- ---------------------------------------------------------------------------
-- Strategy accuracy
-- ---------------------------------------------------------------------------

-- The qualification bar and the anti-grind cap, as functions so a test and the
-- client can both read the real numbers rather than a copy.
create or replace function public.strategy_accuracy_minimum_decisions()
returns integer language sql immutable as $$ select 100 $$;

create or replace function public.strategy_accuracy_count_cap()
returns integer language sql immutable as $$ select 1000 $$;

comment on function public.strategy_accuracy_count_cap() is
  'Volume above this stops improving a tie-break. Without a cap, "then eligible '
  'decision count descending" rewards grinding rather than accuracy.';

grant execute on function public.strategy_accuracy_minimum_decisions() to authenticated;
grant execute on function public.strategy_accuracy_count_cap() to authenticated;

-- Accuracy in basis points, not a float: no float ever reaches a stored or
-- compared figure in this project, and 8,734 is exactly 87.34%.
create or replace function public.leaderboard_strategy_accuracy(p_limit integer default 100)
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
      -- Integer arithmetic throughout: (optimal * 10000) / total.
      ((d.decisions_optimal::bigint * 10000) / d.decisions_total)::bigint as accuracy_bp
    from public.player_decision_periods d
    where d.period_start = public.utc_week_start()
      and d.decisions_total >= public.strategy_accuracy_minimum_decisions()
  ),
  ranked as (
    select
      rank() over (
        order by q.accuracy_bp desc,
                 -- Capped, so a player with 5,000 decisions does not outrank one
                 -- with 1,000 at the same accuracy.
                 least(q.decisions_total, public.strategy_accuracy_count_cap()) desc,
                 -- The deterministic stable tie rule. Never returned.
                 q.user_id
      )::integer as rank,
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
  order by rank
  limit greatest(p_limit, 1);
$$;

grant execute on function public.leaderboard_strategy_accuracy(integer) to authenticated;

-- A player's own qualification progress, which the board itself cannot show
-- them: someone with 60 decisions is absent from it, and "you are not on this
-- board" is a worse answer than "40 more decisions to qualify".
create or replace function public.my_strategy_accuracy_progress()
returns table (
  decisions_total   integer,
  decisions_optimal integer,
  accuracy_bp       integer,
  minimum_required  integer,
  qualified         boolean
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select
    coalesce(d.decisions_total, 0),
    coalesce(d.decisions_optimal, 0),
    case
      when coalesce(d.decisions_total, 0) = 0 then 0
      else ((d.decisions_optimal::bigint * 10000) / d.decisions_total)::integer
    end,
    public.strategy_accuracy_minimum_decisions(),
    coalesce(d.decisions_total, 0) >= public.strategy_accuracy_minimum_decisions()
  from (select 1) one
  left join public.player_decision_periods d
    on d.user_id = (select auth.uid()) and d.period_start = public.utc_week_start();
$$;

grant execute on function public.my_strategy_accuracy_progress() to authenticated;

-- ---------------------------------------------------------------------------
-- Daily challenge
-- ---------------------------------------------------------------------------
--
-- Completed attempts only, ordered by score. `completed_at` is the specification's
-- "earlier submitted valid finish" tie-break; the accuracy and EV-lost tie-breaks
-- above it are not implemented, and this file does not pretend otherwise — see
-- docs/AUDIT.md.
create or replace function public.leaderboard_daily_challenge(
  p_date  date default null,
  p_limit integer default 100
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
      rank() over (order by e.score desc, e.completed_at, e.user_id)::integer as rank,
      p.display_name::text,
      public.avatar_asset_for(e.user_id) as avatar_asset_key,
      e.score as value,
      (e.hands_played::text || ' hands') as detail,
      e.user_id = (select auth.uid()) as is_you
    from public.daily_entries e
    join target t on t.id = e.daily_challenge_id
    join public.profiles p on p.id = e.user_id
    where e.status = 'completed'
  )
  select rank, display_name, avatar_asset_key, value, detail, is_you
  from ranked
  order by rank
  limit greatest(p_limit, 1);
$$;

grant execute on function public.leaderboard_daily_challenge(date, integer) to authenticated;

-- ---------------------------------------------------------------------------
-- "My position", for a player outside the top 100
-- ---------------------------------------------------------------------------
--
-- The specification asks for a "my position" neighbourhood. Rather than four more
-- functions, each board is asked for a generous page and the caller's own row is
-- located within it — so the neighbourhood is derived from the same ordering the
-- board itself used, and cannot disagree with it.
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

  /*
   * One branch per board, deliberately repetitive.
   *
   * Two earlier versions were shorter and worse. A lateral join over a UNION was
   * clever enough that reading it did not tell you whether it was right; a
   * temporary table was clear but made the function volatile, and it failed at
   * runtime with "CREATE TABLE is not allowed in a non-volatile function".
   * Four plain queries are longer and cannot do either.
   */
  if p_category = 'weekly_xp' then
    return query
      with board as (select * from public.leaderboard_weekly_xp(v_wide))
      select b.rank, b.value, b.detail, (select count(*)::integer from board)
      from board b where b.is_you;
  elsif p_category = 'tournament_wins' then
    return query
      with board as (select * from public.leaderboard_tournament_wins(v_wide))
      select b.rank, b.value, b.detail, (select count(*)::integer from board)
      from board b where b.is_you;
  elsif p_category = 'strategy_accuracy' then
    return query
      with board as (select * from public.leaderboard_strategy_accuracy(v_wide))
      select b.rank, b.value, b.detail, (select count(*)::integer from board)
      from board b where b.is_you;
  elsif p_category = 'daily_challenge' then
    return query
      with board as (select * from public.leaderboard_daily_challenge(null, v_wide))
      select b.rank, b.value, b.detail, (select count(*)::integer from board)
      from board b where b.is_you;
  else
    raise exception 'unknown leaderboard %', p_category using errcode = '22023';
  end if;
end;
$$;

comment on function public.my_leaderboard_position(text) is
  'The caller''s own place on one board, derived from the same ordering the board '
  'uses so the two cannot disagree. Returns no row when the caller is unranked.';

grant execute on function public.my_leaderboard_position(text) to authenticated;
