-- =============================================================================
-- Arc 21 — `profiles.level` is derived from `profiles.xp`
--
-- `shared/progression/xp.ts` states the principle plainly at the top of the file:
--
--   "TOTAL XP IS THE STORED TRUTH. Level, progress and the next threshold are all
--    derived from it. Storing the level alongside it invites the two to disagree."
--
-- The column existed anyway, and nothing ever wrote it. So every account sat at
-- level 1 forever, however much XP it earned — which meant the high-stakes table
-- gate (`level >= 10`) could never open, and the level-gated half of the cosmetic
-- catalogue could never unlock. Found while wiring those unlocks.
--
-- The fix keeps the column, because RLS policies and the tier gate read it, but
-- makes it a DERIVED value maintained by a trigger. The two cannot disagree,
-- because only one of them is ever written by hand.
-- =============================================================================

-- Cumulative XP at which a level begins. Level 1 begins at 0.
--
-- The same closed form as `totalXpForLevel`: each level costs
-- `100 + 25 * (L - 1)`, so the total to reach level L is
-- `100 * (L-1) + 25 * (L-1)(L-2) / 2`. `(L-1)(L-2)` is a product of consecutive
-- integers and therefore always even, so this stays in whole numbers — no float
-- reaches a progression figure, for the same reason none reaches a chip balance.
create or replace function public.total_xp_for_level(p_level integer)
returns bigint
language sql
immutable
as $$
  select case
    when p_level <= 1 then 0::bigint
    else (100::bigint * (p_level - 1)) + (25::bigint * (p_level - 1) * (p_level - 2) / 2)
  end;
$$;

comment on function public.total_xp_for_level(integer) is
  'Cumulative XP at which a level begins. Mirrors totalXpForLevel in '
  'shared/progression/xp.ts; tests/progression/level-curve.test.ts asserts the two '
  'agree for every level up to the cap.';

grant execute on function public.total_xp_for_level(integer) to anon, authenticated;

-- The MVP ceiling, mirroring MAX_LEVEL.
create or replace function public.max_player_level()
returns integer language sql immutable as $$ select 50 $$;

grant execute on function public.max_player_level() to anon, authenticated;

-- The level a total buys.
--
-- Scans upward rather than inverting the quadratic, exactly as the TypeScript
-- does and for the same reason: the inverse needs a square root, and a float
-- result one ulp low at an exact threshold names the level below — so a player who
-- earned precisely enough would watch their level fail to appear.
create or replace function public.level_from_total_xp(p_total_xp bigint)
returns integer
language sql
immutable
as $$
  select coalesce(
    (
      select max(candidate)
      from generate_series(1, public.max_player_level()) as candidate
      where public.total_xp_for_level(candidate) <= greatest(coalesce(p_total_xp, 0), 0)
    ),
    1
  );
$$;

grant execute on function public.level_from_total_xp(bigint) to anon, authenticated;

-- ---------------------------------------------------------------------------
-- Keeping the column honest
-- ---------------------------------------------------------------------------

create or replace function public.sync_profile_level()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  -- Recomputed rather than adjusted. A trigger that added "+1 when a threshold is
  -- crossed" would drift the moment any correction touched `xp` directly.
  new.level := public.level_from_total_xp(new.xp);
  return new;
end;
$$;

revoke execute on function public.sync_profile_level() from public;

-- BEFORE, so the derived value is written in the same row version rather than by
-- a second UPDATE that would re-fire every trigger on the table.
drop trigger if exists profiles_sync_level on public.profiles;
create trigger profiles_sync_level
  before insert or update of xp on public.profiles
  for each row execute function public.sync_profile_level();

-- Bring existing rows in line. On a fresh database this is a no-op; on one with
-- history it repairs every account that had been stuck at level 1.
update public.profiles
set level = public.level_from_total_xp(xp)
where level <> public.level_from_total_xp(xp);

-- ---------------------------------------------------------------------------
-- Level progress, for the profile screen
-- ---------------------------------------------------------------------------
--
-- Reports what the curve reports, including the honest answer at the cap: there
-- is NO next level, so the threshold and the remainder are null rather than zero
-- or negative. Anything else hands a UI a number to divide by.
create or replace function public.my_level_progress()
returns table (
  level             integer,
  total_xp          bigint,
  xp_into_level     bigint,
  xp_for_next_level integer,
  xp_remaining      bigint,
  is_max_level      boolean
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select
    public.level_from_total_xp(p.xp),
    p.xp,
    p.xp - public.total_xp_for_level(public.level_from_total_xp(p.xp)),
    case
      when public.level_from_total_xp(p.xp) >= public.max_player_level() then null
      else 100 + 25 * (public.level_from_total_xp(p.xp) - 1)
    end,
    case
      when public.level_from_total_xp(p.xp) >= public.max_player_level() then null
      else (100 + 25 * (public.level_from_total_xp(p.xp) - 1))
           - (p.xp - public.total_xp_for_level(public.level_from_total_xp(p.xp)))
    end,
    public.level_from_total_xp(p.xp) >= public.max_player_level()
  from public.profiles p
  where p.id = (select auth.uid());
$$;

revoke execute on function public.my_level_progress() from public, anon;
grant execute on function public.my_level_progress() to authenticated;
