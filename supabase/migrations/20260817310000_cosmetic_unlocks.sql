-- =============================================================================
-- Arc 21 — earning cosmetics
--
-- The catalogue and the ownership tables have existed since 1000; nothing granted
-- ownership, so every player had an empty inventory and no way to fill it. This
-- file is the evaluator.
--
-- What it deliberately cannot do: grant anything for a payment, a random draw, or
-- a streak of losses. `cosmetic_unlock_type` has no member that could express the
-- first two, and every branch below reads progression the player earned.
--
-- Cosmetics provide no gameplay advantage — the acceptance criterion for this
-- phase. That is structural rather than promised: an `asset_key` is a key into the
-- bundled asset index, and nothing in the engine, the rules, the shoe or the
-- settlement reads a cosmetic at all. `supabase/tests/17_cosmetics.test.sql`
-- asserts the loadout tables are absent from every gameplay path.
-- =============================================================================

-- The player's current daily-challenge streak, in consecutive UTC days.
--
-- Counted backwards from today, or from yesterday when today has not been played
-- yet: a streak should not appear broken at 00:01 UTC simply because the day is
-- young. A gap of one full day ends it.
create or replace function public.daily_challenge_streak(p_user_id uuid)
returns integer
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_today  date := (now() at time zone 'utc')::date;
  v_cursor date;
  v_streak integer := 0;
begin
  -- Start from the most recent completed day, but only if it is today or
  -- yesterday. Anything older means the streak is already over.
  select max(c.challenge_date) into v_cursor
  from public.daily_entries e
  join public.daily_challenges c on c.id = e.daily_challenge_id
  where e.user_id = p_user_id and e.status = 'completed';

  if v_cursor is null or v_cursor < v_today - 1 then
    return 0;
  end if;

  -- Walk back one day at a time. Bounded at a year so a corrupt row cannot spin.
  while v_streak < 366 loop
    if not exists (
      select 1
      from public.daily_entries e
      join public.daily_challenges c on c.id = e.daily_challenge_id
      where e.user_id = p_user_id and e.status = 'completed' and c.challenge_date = v_cursor
    ) then
      exit;
    end if;
    v_streak := v_streak + 1;
    v_cursor := v_cursor - 1;
  end loop;

  return v_streak;
end;
$$;

revoke execute on function public.daily_challenge_streak(uuid) from public, anon;
grant execute on function public.daily_challenge_streak(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- Has this player earned this cosmetic?
-- ---------------------------------------------------------------------------
--
-- One function, one cosmetic, no writes. Separating the question from the granting
-- means the inventory screen can show a locked item and its requirement using
-- exactly the predicate that would unlock it, rather than a second description of
-- the same rule that could drift.
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
  end case;
end;
$$;

revoke execute on function public.cosmetic_is_earned(uuid, uuid) from public, anon;
grant execute on function public.cosmetic_is_earned(uuid, uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- Granting
-- ---------------------------------------------------------------------------

-- SERVER half, no caller check: the session function reaches this as `postgres`
-- after a tournament settles or a daily challenge completes.
create or replace function public.grant_earned_cosmetics_for(p_user_id uuid)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_granted integer := 0;
begin
  insert into public.user_cosmetics (user_id, cosmetic_id, source, source_ref)
  select
    p_user_id,
    c.id,
    c.unlock_type,
    -- The specific thing that earned it, for the "how you got this" line.
    coalesce(
      c.unlock_config ->> 'careerNodeCode',
      c.unlock_config ->> 'chapter',
      c.unlock_config ->> 'level',
      c.unlock_config ->> 'streak',
      c.unlock_config ->> 'placement'
    )
  from public.cosmetics c
  where c.is_active
    and public.cosmetic_is_earned(p_user_id, c.id)
  -- Already owned stays owned, with its original acquisition date: a cosmetic is
  -- never re-granted, so `acquired_at` keeps meaning "when you earned it".
  on conflict (user_id, cosmetic_id) do nothing;

  get diagnostics v_granted = row_count;

  -- A first grant also needs somewhere to equip into. Created empty; the trigger
  -- on `loadouts` validates any slot the player then fills.
  insert into public.loadouts (user_id) values (p_user_id)
  on conflict (user_id) do nothing;

  return v_granted;
end;
$$;

comment on function public.grant_earned_cosmetics_for(uuid) is
  'Grants every cosmetic the player has earned and not yet been given. Idempotent. '
  'Server-only; the client calls grant_earned_cosmetics() for its own account.';

revoke execute on function public.grant_earned_cosmetics_for(uuid) from public, anon, authenticated;

-- CLIENT half. Takes no argument, so there is no spelling of it that grants
-- cosmetics to somebody else.
create or replace function public.grant_earned_cosmetics()
returns integer
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
  return public.grant_earned_cosmetics_for(v_me);
end;
$$;

revoke execute on function public.grant_earned_cosmetics() from public, anon;
grant execute on function public.grant_earned_cosmetics() to authenticated;

-- ---------------------------------------------------------------------------
-- The inventory the screen reads
-- ---------------------------------------------------------------------------
--
-- Every catalogue item, owned or not, with the requirement spelled out for the
-- locked ones. Locked items show what to DO — "Reach level 12" — and never a
-- price, because there is nothing to buy.
create or replace function public.my_inventory()
returns table (
  cosmetic_id  uuid,
  code         text,
  kind         public.cosmetic_kind,
  name         text,
  description  text,
  asset_key    text,
  owned        boolean,
  equipped     boolean,
  unlock_type  public.cosmetic_unlock_type,
  requirement  text,
  sort_order   integer
)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_me uuid := auth.uid();
begin
  if v_me is null then
    raise exception 'this requires an authenticated session' using errcode = '42501';
  end if;

  return query
  select
    c.id,
    c.code::text,
    c.kind,
    c.name::text,
    c.description::text,
    c.asset_key::text,
    uc.id is not null,
    (l.avatar_cosmetic_id = c.id
      or l.card_back_cosmetic_id = c.id
      or l.table_theme_cosmetic_id = c.id) is true,
    c.unlock_type,
    case c.unlock_type
      when 'default'              then 'Available to everyone'
      when 'level'                then 'Reach level ' || (c.unlock_config ->> 'level')
      when 'career_node'          then 'Complete ' || coalesce(n.title, c.unlock_config ->> 'careerNodeCode')
      when 'career_chapter'       then 'Complete every node in ' ||
                                       initcap(replace(lower(c.unlock_config ->> 'chapter'), '_', ' '))
      when 'daily_streak'         then 'Finish ' || (c.unlock_config ->> 'streak') ||
                                       ' daily challenges in a row'
      when 'tournament_placement' then case (c.unlock_config ->> 'placement')
                                         when '1' then 'Win a Sprint Tournament'
                                         else 'Finish a Sprint Tournament in the top ' ||
                                              (c.unlock_config ->> 'placement')
                                       end
      when 'achievement'          then 'Not yet available'
    end::text,
    c.sort_order
  from public.cosmetics c
  left join public.user_cosmetics uc on uc.cosmetic_id = c.id and uc.user_id = v_me
  left join public.loadouts l on l.user_id = v_me
  left join public.career_nodes n
    on c.unlock_type = 'career_node' and n.code = (c.unlock_config ->> 'careerNodeCode')
  where c.is_active
  order by c.kind, c.sort_order, c.name;
end;
$$;

revoke execute on function public.my_inventory() from public, anon;
grant execute on function public.my_inventory() to authenticated;

-- ---------------------------------------------------------------------------
-- Equipping
-- ---------------------------------------------------------------------------
--
-- The client could UPDATE `loadouts` directly — the grant and the validating
-- trigger are already there — but it would have to know which of three columns a
-- given item belongs in. This takes the item and works that out, so the screen
-- never encodes the slot mapping.
--
-- Ownership is NOT re-checked here. The trigger on `loadouts` refuses an unowned
-- or wrong-kind item for any write path, and duplicating the check would create a
-- second place for it to be wrong.
create or replace function public.equip_cosmetic(p_cosmetic_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_me   uuid := auth.uid();
  v_kind public.cosmetic_kind;
begin
  if v_me is null then
    raise exception 'this requires an authenticated session' using errcode = '42501';
  end if;

  select kind into v_kind from public.cosmetics where id = p_cosmetic_id and is_active;
  if v_kind is null then
    raise exception 'no such cosmetic' using errcode = '23503';
  end if;

  insert into public.loadouts (user_id) values (v_me) on conflict (user_id) do nothing;

  update public.loadouts
  set avatar_cosmetic_id =
        case when v_kind = 'avatar' then p_cosmetic_id else avatar_cosmetic_id end,
      card_back_cosmetic_id =
        case when v_kind = 'card_back' then p_cosmetic_id else card_back_cosmetic_id end,
      table_theme_cosmetic_id =
        case when v_kind = 'table_theme' then p_cosmetic_id else table_theme_cosmetic_id end
  where user_id = v_me;
end;
$$;

revoke execute on function public.equip_cosmetic(uuid) from public, anon;
grant execute on function public.equip_cosmetic(uuid) to authenticated;

-- The equipped set, so a screen can read it without knowing the column names.
create or replace function public.my_loadout()
returns table (
  slot        text,
  cosmetic_id uuid,
  name        text,
  asset_key   text
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select s.slot, c.id, c.name::text, c.asset_key::text
  from public.loadouts l
  cross join lateral (values
    ('avatar', l.avatar_cosmetic_id),
    ('card_back', l.card_back_cosmetic_id),
    ('table_theme', l.table_theme_cosmetic_id)
  ) as s(slot, cosmetic_id)
  left join public.cosmetics c on c.id = s.cosmetic_id
  where l.user_id = (select auth.uid());
$$;

revoke execute on function public.my_loadout() from public, anon;
grant execute on function public.my_loadout() to authenticated;
