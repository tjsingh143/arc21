-- Record what a settled hand did: statistics, and XP under its daily cap.
--
-- Until now the server settled hands correctly and then forgot them. The engine
-- state and the event log both recorded the hand, but `player_stats` was
-- written only by the signup trigger, so a player could play all day and their
-- statistics screen would still read zero. XP had the same shape of gap: the
-- curve existed as a tested module with nothing calling it.
--
-- Both are written here, in the same transaction as the settlement itself. A
-- separate pass would be a second place for the hand count to be wrong.

-- ---------------------------------------------------------------------------
-- The daily repeatable-XP cap
-- ---------------------------------------------------------------------------
-- The specification caps repeatable XP at 300 per UTC day so grinding cannot
-- outrun playing. The day is stored as a plain date in UTC rather than derived
-- from a timestamp at read time: a player crossing midnight mid-session must
-- get a fresh allowance, and that boundary has to be the same one the client
-- shows.

-- A surrogate uuid key with a unique constraint on the natural key, rather than
-- a composite primary key. Every table in this schema is keyed that way and
-- 00_schema asserts it; the pair is what must be unique, not what identifies
-- the row.
create table if not exists public.player_daily_xp (
  id           uuid        primary key default gen_random_uuid(),
  user_id      uuid        not null references auth.users (id) on delete cascade,
  utc_day      date        not null,
  repeatable_xp integer    not null default 0 check (repeatable_xp >= 0),
  updated_at   timestamptz not null default now(),
  unique (user_id, utc_day)
);

alter table public.player_daily_xp enable row level security;

-- Readable so a screen can show "you have earned 180 of 300 today"; never
-- writable, like every other progression figure.
create policy player_daily_xp_select_own on public.player_daily_xp
  for select using (user_id = auth.uid());

-- RLS scopes the rows; the GRANT is what makes the table reachable at all.
-- Omitting it left a policy that could never match, which the pgTAP privilege
-- assertion caught.
grant select on public.player_daily_xp to authenticated;

comment on table public.player_daily_xp is
  'Repeatable XP earned per UTC day, for the 300/day cap. Server-written only.';

-- ---------------------------------------------------------------------------
-- The settlement writer
-- ---------------------------------------------------------------------------

create or replace function public.record_hand_settlement(
  p_user_id            uuid,
  p_hands_played       integer,
  p_hands_won          integer,
  p_hands_lost         integer,
  p_hands_pushed       integer,
  p_hands_surrendered  integer,
  p_blackjacks         integer,
  p_busts              integer,
  p_chips_wagered      bigint,
  p_chips_net          bigint,
  p_biggest_win        bigint,
  p_trailing_win_streak integer,
  p_streak_broken      boolean,
  p_xp                 integer,
  p_utc_day            date,
  p_daily_cap          integer
)
returns table (xp_granted integer, total_xp bigint, daily_xp_after integer)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_already  integer;
  v_granted  integer;
  v_total    bigint;
begin
  -- Upsert-then-read under the row lock, so two settlements landing together
  -- cannot both see the same "already earned" figure and each grant a full
  -- allowance.
  insert into public.player_daily_xp (user_id, utc_day, repeatable_xp)
  values (p_user_id, p_utc_day, 0)
  on conflict (user_id, utc_day) do nothing;

  select repeatable_xp into v_already
  from public.player_daily_xp
  where user_id = p_user_id and utc_day = p_utc_day
  for update;

  -- greatest(...,0) matters: a cap lowered below what a player already earned
  -- today would otherwise compute a negative grant and silently take XP away.
  v_granted := least(p_xp, greatest(p_daily_cap - v_already, 0));

  update public.player_daily_xp
  set repeatable_xp = v_already + v_granted, updated_at = now()
  where user_id = p_user_id and utc_day = p_utc_day;

  update public.profiles
  set xp = xp + v_granted, updated_at = now()
  where id = p_user_id
  returning xp into v_total;

  update public.player_stats set
    hands_played       = hands_played + p_hands_played,
    hands_won          = hands_won + p_hands_won,
    hands_lost         = hands_lost + p_hands_lost,
    hands_pushed       = hands_pushed + p_hands_pushed,
    hands_surrendered  = hands_surrendered + p_hands_surrendered,
    blackjacks         = blackjacks + p_blackjacks,
    busts              = busts + p_busts,
    chips_wagered      = chips_wagered + p_chips_wagered,
    chips_net          = chips_net + p_chips_net,
    biggest_win        = greatest(biggest_win, p_biggest_win),
    -- A batch containing a loss resets the run and then counts any wins that
    -- came after it; a batch of pure wins extends whatever was already running.
    current_win_streak = case
      when p_streak_broken then p_trailing_win_streak
      else current_win_streak + p_trailing_win_streak
    end,
    longest_win_streak = greatest(
      longest_win_streak,
      case
        when p_streak_broken then p_trailing_win_streak
        else current_win_streak + p_trailing_win_streak
      end
    ),
    updated_at = now()
  where user_id = p_user_id;

  return query
  select v_granted,
         v_total,
         (select repeatable_xp from public.player_daily_xp
          where user_id = p_user_id and utc_day = p_utc_day);
end;
$$;

comment on function public.record_hand_settlement is
  'Applies a settled batch to player_stats and XP, honouring the daily '
  'repeatable cap. Takes counts only — no wager is passed, so no path exists '
  'by which a larger bet earns more XP.';

-- Server-only. This writes progression, which no client may author.
revoke execute on function public.record_hand_settlement(
  uuid, integer, integer, integer, integer, integer, integer, integer,
  bigint, bigint, bigint, integer, boolean, integer, date, integer
) from public, anon, authenticated;
