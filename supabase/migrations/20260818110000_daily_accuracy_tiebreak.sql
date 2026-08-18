-- =============================================================================
-- Arc 21 — the Daily Challenge's accuracy and EV-lost tie-breaks
--
-- The specification ranks the daily board on score, then accuracy, then EV lost,
-- and only then on submission time. This project shipped score, then submission
-- time — and `docs/AUDIT.md` has carried the row as ABSENT since.
--
-- The grading itself was never the missing part. `decision-grading.ts` has
-- graded every decision at a ranked table since phase 12, `daily_challenge` is
-- in `ACCURACY_ELIGIBLE_MODES`, and `record_decisions` buckets the result by ISO
-- week for the strategy leaderboard. What was missing is narrower and easier to
-- miss: a daily ENTRY recorded nothing about the accuracy of ITS OWN attempt.
-- The week bucket cannot answer the question the board asks, because it mixes in
-- every solo and public-table decision the player made that week.
--
-- So the attempt now carries its own counters, and the board orders by them.
--
-- -----------------------------------------------------------------------------
-- WHY EV LOST IS AN INTEGER COLUMN
-- -----------------------------------------------------------------------------
-- `00_schema.test.sql` asserts that no floating-point column exists anywhere in
-- `public`, which is the same discipline that keeps chips integral. EV lost is
-- genuinely fractional — it is a share of one unit wagered — so it is stored in
-- MILLIONTHS of a unit as a bigint. A twenty-hand attempt cannot approach the
-- range: the worst decision in the chart costs about one unit, and there are at
-- most a few dozen decisions.
--
-- -----------------------------------------------------------------------------
-- WHY THIS DOES NOT CHANGE THE SCORE
-- -----------------------------------------------------------------------------
-- The score is still the ending bankroll and nothing else. The specification is
-- pointed that completion speed must not be a skill metric, and folding accuracy
-- INTO the score would have the same defect from the other direction — a player
-- who wins more chips would rank below one who played more textbook hands. These
-- are tie-breaks: they order players the primary metric has already tied.
-- =============================================================================

alter table public.daily_entries
  add column if not exists decisions_total integer not null default 0
    check (decisions_total >= 0),
  add column if not exists decisions_optimal integer not null default 0
    check (decisions_optimal >= 0),
  add column if not exists ev_lost_micros bigint not null default 0
    check (ev_lost_micros >= 0);

-- The same guard `player_decision_periods` carries: you cannot play better than
-- perfectly.
alter table public.daily_entries
  drop constraint if exists daily_entries_optimal_within_total;
alter table public.daily_entries
  add constraint daily_entries_optimal_within_total
    check (decisions_optimal <= decisions_total);

comment on column public.daily_entries.decisions_total is
  'Server-graded decisions in THIS attempt. Distinct from the week bucket in '
  'player_decision_periods, which mixes in every other ranked mode.';
comment on column public.daily_entries.decisions_optimal is
  'How many of them matched the generated strategy chart.';
comment on column public.daily_entries.ev_lost_micros is
  'Total expected value given up, in millionths of one unit wagered, measured '
  'against the best LEGAL action at each decision. An integer because no '
  'floating-point column exists in this schema.';

-- The board's ordering, so the tie-break does not sort in memory.
create index if not exists daily_entries_rank_idx
  on public.daily_entries (daily_challenge_id, score desc, ev_lost_micros, completed_at);

-- -----------------------------------------------------------------------------
-- Recording an attempt's decisions
-- -----------------------------------------------------------------------------
--
-- Counts only, exactly like `record_decisions`: there is no parameter here
-- through which a client could assert its own accuracy, and no client role can
-- reach the function in the first place. The grading happened on authoritative
-- state, before the action was applied.
--
-- Keyed by the SESSION rather than the player, because that is what the caller
-- holds and because it is what makes a replay a no-op: an unranked replay has no
-- entry row at all, so the update matches nothing and writes nothing. That is
-- the same enforcement the rest of this mode uses — never writing, rather than
-- writing and then comparing.
create or replace function public.record_daily_attempt_decisions(
  p_game_session_id uuid,
  p_total           integer,
  p_optimal         integer,
  p_ev_lost_micros  bigint
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if p_total < 0 or p_optimal < 0 or p_optimal > p_total then
    raise exception 'incoherent decision batch: % of %', p_optimal, p_total
      using errcode = '22023';
  end if;
  if p_ev_lost_micros < 0 then
    raise exception 'EV lost cannot be negative' using errcode = '22023';
  end if;
  if p_total = 0 then
    return;
  end if;

  update public.daily_entries
  set decisions_total   = decisions_total + p_total,
      decisions_optimal = decisions_optimal + p_optimal,
      ev_lost_micros    = ev_lost_micros + p_ev_lost_micros
  where game_session_id = p_game_session_id
    and status = 'in_progress';
end;
$$;

comment on function public.record_daily_attempt_decisions(uuid, integer, integer, bigint) is
  'Adds a graded decision to the daily attempt owning this session. A replay has '
  'no entry row, so it silently records nothing — the same "never write" '
  'enforcement the ranked-attempt rule uses. Server-only.';

revoke execute on function public.record_daily_attempt_decisions(uuid, integer, integer, bigint)
  from public, anon, authenticated;

-- -----------------------------------------------------------------------------
-- Accuracy as an integer
-- -----------------------------------------------------------------------------
--
-- Basis points, for the same reason `leaderboard_strategy_accuracy` uses them:
-- an ordering key computed in floating point can rank two identical records
-- differently on different machines. Null when nothing was graded, so the board
-- can put those players below anyone it actually measured rather than above
-- them.
create or replace function public.accuracy_basis_points(p_optimal integer, p_total integer)
returns integer
language sql
immutable
as $$
  select case
           when p_total is null or p_total <= 0 then null
           else (p_optimal::bigint * 10000 / p_total)::integer
         end;
$$;

comment on function public.accuracy_basis_points(integer, integer) is
  'Optimal decisions per ten thousand. Integer arithmetic, so an ordering key '
  'cannot vary with a platform''s floating point. Null when nothing was graded.';

grant execute on function public.accuracy_basis_points(integer, integer) to authenticated;

-- -----------------------------------------------------------------------------
-- The board
-- -----------------------------------------------------------------------------
--
-- Ordering, in the specification's order:
--
--   1. score          descending — the ending bankroll, unchanged
--   2. accuracy       descending, NULLS LAST. An attempt with nothing graded is
--                     not "0% accurate", it is unmeasured, and it ranks below
--                     every attempt that was measured rather than above them.
--                     `desc` alone would put nulls FIRST in Postgres, which
--                     would hand the top of a tie to the least-measured player.
--   3. EV lost        ascending — two players at the same accuracy are separated
--                     by how expensive their mistakes were, not how many
--   4. completed_at   ascending — the pre-existing tie-break, now last
--   5. user_id        so the order is total and a page cannot shuffle between
--                     two identical rows on consecutive reads
--
-- The detail string carries the accuracy when there is one, because a tie-break
-- nobody can see reads as an arbitrary order.
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
      rank() over (
        order by e.score desc,
                 public.accuracy_basis_points(e.decisions_optimal, e.decisions_total) desc nulls last,
                 e.ev_lost_micros asc,
                 e.completed_at asc,
                 e.user_id
      )::integer as rank,
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
  order by rank
  limit greatest(p_limit, 1);
$$;

comment on function public.leaderboard_daily_challenge(date, integer) is
  'The daily board. Score, then accuracy, then EV lost, then submission time — '
  'the specification''s order. Accuracy and EV lost come from the attempt''s own '
  'graded decisions, never from the week bucket, which mixes in other modes.';

grant execute on function public.leaderboard_daily_challenge(date, integer) to authenticated;

-- `my_daily_entry` is deliberately NOT widened to return the new counters.
--
-- The board already shows a player their own accuracy — `is_you` marks their row
-- and `detail` carries the figure — so widening the personal query would add
-- output with no reader. This repository has been bitten nine times by exactly
-- that: a column, a function or an adapter built, typechecked, and connected to
-- nothing. The moment a screen genuinely needs these per-attempt numbers, that
-- is the change to make, alongside the screen that reads them.
