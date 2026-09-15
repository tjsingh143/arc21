-- =============================================================================
-- Arc 21 — the one thing `supabase db lint` had to say
-- =============================================================================
--
--   {"function":"public.cosmetic_is_earned",
--    "issues":[{"level":"warning extra",
--               "message":"control reached end of function without RETURN",
--               "sqlState":"2F005"}]}
--
-- WHAT IT MEANS HERE. The body is one `case v_kind` over
-- `public.cosmetic_unlock_type`, and every one of its seven values is handled —
-- `default`, `level`, `career_node`, `career_chapter`, `daily_streak`,
-- `tournament_placement`, `achievement`. So the warning is not a live defect:
-- the function cannot currently fall off its end.
--
-- WHY IT IS WORTH FIXING ANYWAY. A `case` with no `else` does not return NULL
-- when nothing matches — it RAISES `CASE_NOT_FOUND` (20000). And the caller is
-- not a report. `grant_earned_cosmetics_for` runs inside the COMMAND
-- TRANSACTION: `_shared/session-boundary.ts` calls it while settling a sprint
-- placement and while paying a career node. So the day somebody adds an eighth
-- unlock type — and adding one is a one-line `alter type` that nothing forces
-- them to follow up — the first player to finish a tournament would have their
-- settlement rolled back by an exception raised inside a cosmetics check.
-- Placements, prize chips and XP, undone by a decoration.
--
-- `else return false` is the same answer the `achievement` branch already gives
-- for the same reason, in its own words: "granting one would hand out an item
-- for a condition nobody can meet or check". An unimplemented unlock type
-- grants nothing until somebody implements it, and settles everything else
-- normally.
--
-- THE BODY IS CARRIED FORWARD WHOLE, from `20260817310000_cosmetic_unlocks.sql`,
-- which is the LAST file to define it — `20260818120000_authorization_gate.sql`
-- only narrows its ACL. `create or replace function` silently reverts every
-- later redefinition, and this project has already lost a `notify_user` call
-- and an `expire_stale_rooms()` call that way, one of them with nothing failing
-- to say so.
-- =============================================================================

create or replace function public.cosmetic_is_earned(p_user_id uuid, p_cosmetic_id uuid)
returns boolean
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_kind   public.cosmetic_unlock_type;
  v_config jsonb;
begin
  select unlock_type, unlock_config into v_kind, v_config
  from public.cosmetics
  where id = p_cosmetic_id and is_active;

  if v_kind is null then
    return false;
  end if;

  case v_kind
    when 'default' then
      return true;

    when 'level' then
      return exists (
        select 1 from public.profiles
        where id = p_user_id and level >= (v_config ->> 'level')::int
      );

    when 'career_node' then
      -- The node's own code, completed. Stars beyond the first are not required:
      -- a node always awards its first star for completion, so gating a cosmetic
      -- on three would make bad cards block a reward.
      return exists (
        select 1
        from public.career_progress cp
        join public.career_nodes n on n.id = cp.career_node_id
        where cp.user_id = p_user_id
          and n.code = (v_config ->> 'careerNodeCode')
          and cp.status = 'completed'
      );

    when 'career_chapter' then
      -- EVERY node in the chapter. `not exists (… incomplete …)` rather than a
      -- count, so adding a nineteenth node to a chapter tightens the requirement
      -- automatically instead of leaving it satisfied by the old total.
      return not exists (
        select 1
        from public.career_nodes n
        left join public.career_progress cp
          on cp.career_node_id = n.id and cp.user_id = p_user_id
        where n.chapter = (v_config ->> 'chapter')::public.career_chapter
          and coalesce(cp.status, 'locked') <> 'completed'
      );

    when 'daily_streak' then
      return public.daily_challenge_streak(p_user_id) >= (v_config ->> 'streak')::int;

    when 'tournament_placement' then
      -- "Placed this well or better", in a tournament that actually finished.
      return exists (
        select 1
        from public.tournament_entries e
        join public.tournaments t on t.id = e.tournament_id
        where e.user_id = p_user_id
          and t.status = 'completed'
          and e.placement is not null
          and e.placement <= (v_config ->> 'placement')::int
      );

    when 'achievement' then
      -- No achievement system exists yet, and nothing in the catalogue uses this
      -- branch. Returning false is the honest answer: granting one would hand out
      -- an item for a condition nobody can meet or check.
      return false;

    else
      -- An unlock type this function has never been taught. NOT an error: this
      -- runs inside the transaction that settles a tournament placement and pays
      -- a career node, and `CASE_NOT_FOUND` here would roll back chips, XP and a
      -- placement over a decoration. Grants nothing, settles everything else.
      return false;
  end case;
end;
$$;

comment on function public.cosmetic_is_earned(uuid, uuid) is
  'Whether this player has met the unlock condition for one cosmetic. Server-only: '
  'revoked from every client role. An unlock type it has not been taught grants '
  'nothing rather than raising, because the callers settle tournaments and career '
  'nodes inside the same transaction.';

-- The ACL as `20260818120000_authorization_gate.sql` left it. `create or replace`
-- preserves permissions, so this restates rather than changes them — and stating
-- them is cheaper than the reader having to go and check.
revoke execute on function public.cosmetic_is_earned(uuid, uuid) from public, anon, authenticated;

-- A migration that touches a grant calls the gate as its last line: a
-- migration-time DO block only ever sees the state at its own position in the
-- ordering, which is how sixteen migrations of new grants once accumulated
-- behind a check that had simply stopped being asked.
do $$ begin perform public.assert_client_authorization_surface(); end $$;
