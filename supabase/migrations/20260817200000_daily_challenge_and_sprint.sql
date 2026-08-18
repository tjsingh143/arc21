-- =============================================================================
-- Arc 21 — the Daily Challenge row, and the Sprint Tournament's structure
--
-- The tables for both already exist (0800, 0900). What was missing was the
-- machinery: a way for today's challenge to come into being, and the columns a
-- sprint needs to remember where the button is, who went out when, and what a
-- placement paid.
--
-- Neither half moves a chip. Every economic step — the 500-chip entry fee, a
-- prize, a daily reward — goes through `apply_wallet_delta` from the session
-- Edge Function, which locks the wallet before honouring its idempotency key.
-- The reason is the one recorded throughout this project: a second chip-moving
-- path doubles the surface for no benefit, and "duplicate prize impossible" is a
-- named acceptance criterion.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- Today's daily challenge
-- ---------------------------------------------------------------------------
--
-- Created on demand rather than by a scheduler, for the same reason the
-- matchmaking room is: a cron job that has not run yet is an outage, whereas a
-- row created by the first person to look at the screen cannot be late.
--
-- The seed is minted HERE, in SQL, and nowhere else. It never crosses a network
-- boundary, never appears in a log, and never reaches a client: the
-- `authenticated` grant on `daily_challenges` lists every column except
-- `seed_secret`, so `select *` is refused by the privilege system.
--
-- The specification asks for `seedCommitment = SHA-256(context + seed)`. The
-- existing `guard_daily_challenge_seed` trigger verifies
-- `seed_commitment = sha256(seed_secret)` exactly, so the context goes INSIDE
-- the secret: the published hash covers the date because the date is part of the
-- preimage. One commitment scheme, and the trigger that proves it is already
-- tested.
-- The creation half, with NO caller check, reachable only by the server.
--
-- Split out from the client-facing wrapper because the session Edge Function
-- connects as `postgres` and therefore has no `auth.uid()` — the wrapper's
-- authentication check would refuse the one caller that actually needs to build
-- the shoe. Splitting keeps the check on the client path instead of weakening it
-- for everyone.
create or replace function public.ensure_daily_challenge_for(p_date date)
returns uuid
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_secret     text;
  v_commitment text;
  v_ruleset    uuid;
  v_id         uuid;
begin
  -- Serialise creation for this date. Without it two players opening the screen
  -- together both miss the row and both insert, and the loser takes a unique
  -- violation on `challenge_date` instead of getting today's challenge.
  perform pg_advisory_xact_lock(hashtext('daily_challenge:' || p_date::text));

  select id into v_id from public.daily_challenges where challenge_date = p_date;
  if v_id is not null then
    return v_id;
  end if;

  select id into v_ruleset from public.rulesets where is_active order by created_at limit 1;
  if v_ruleset is null then
    raise exception 'no active ruleset is seeded' using errcode = 'P0001';
  end if;

  -- 32 bytes of CSPRNG output behind the date context. The context is part of
  -- the preimage, so the published commitment commits to the date too.
  v_secret := 'arc21:daily:' || p_date::text || ':'
              || encode(extensions.gen_random_bytes(32), 'hex');
  v_commitment := encode(extensions.digest(v_secret, 'sha256'), 'hex');

  insert into public.daily_challenges
    (challenge_date, ruleset_id, seed_secret, seed_commitment,
     hand_count, starting_chips, tier, reward_chips, reward_xp, opens_at, closes_at)
  values
    (p_date, v_ruleset, v_secret, v_commitment,
     20, 5000, 'standard', 1000, 150,
     p_date::timestamptz, p_date::timestamptz + interval '1 day')
  returning id into v_id;

  return v_id;
end;
$$;

comment on function public.ensure_daily_challenge_for(date) is
  'SERVER ONLY. Creates a date''s challenge and mints its secret seed. Granted to '
  'no API role: the session Edge Function reaches it as postgres.';

revoke execute on function public.ensure_daily_challenge_for(date) from public, anon, authenticated;

create or replace function public.ensure_todays_daily_challenge()
returns public.daily_challenges_public
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_date   date := (now() at time zone 'utc')::date;
  v_public public.daily_challenges_public;
begin
  if auth.uid() is null then
    raise exception 'the daily challenge requires an authenticated session' using errcode = '42501';
  end if;

  perform public.ensure_daily_challenge_for(v_date);

  -- Read back through the client-facing projection, so this function cannot
  -- return the secret even by accident. The view does not carry the column.
  select * into v_public from public.daily_challenges_public where challenge_date = v_date;
  return v_public;
end;
$$;

comment on function public.ensure_todays_daily_challenge() is
  'Returns today''s challenge, creating it if absent. Never returns seed_secret: '
  'the projection it reads does not carry the column.';

revoke execute on function public.ensure_todays_daily_challenge() from public, anon;
grant execute on function public.ensure_todays_daily_challenge() to authenticated;

-- A player's own attempt, if any. `daily_entries` is already readable by its
-- owner under RLS; this exists so the client can ask one question instead of
-- joining two tables through two policies.
create or replace function public.my_daily_entry()
returns table (
  daily_challenge_id uuid,
  game_session_id    uuid,
  status             public.daily_entry_status,
  hands_played       int,
  final_chips        bigint,
  score              bigint,
  completed_at       timestamptz
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select e.daily_challenge_id, e.game_session_id, e.status,
         e.hands_played, e.final_chips, e.score, e.completed_at
  from public.daily_entries e
  join public.daily_challenges c on c.id = e.daily_challenge_id
  where e.user_id = (select auth.uid())
    and c.challenge_date = (now() at time zone 'utc')::date;
$$;

revoke execute on function public.my_daily_entry() from public, anon;
grant execute on function public.my_daily_entry() to authenticated;

-- ---------------------------------------------------------------------------
-- One-off XP
-- ---------------------------------------------------------------------------
--
-- Deliberately separate from `record_hand_settlement`, and deliberately NOT
-- capped by `player_daily_xp`.
--
-- That cap exists to stop repeatable grinding: five XP a hand, three hundred a
-- day, so nobody farms levels by dealing all night. A tournament placement and a
-- daily challenge reward are the opposite kind of award — one costs a 500-chip
-- entry and the field has to fill, the other is available once per UTC date — so
-- running them through the repeatable cap would let an evening of ordinary hands
-- silently swallow a prize a player earned.
--
-- It touches XP only. Statistics belong to hands, and a placement is not a hand.
create or replace function public.award_milestone_xp(p_user_id uuid, p_xp integer)
returns bigint
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_total bigint;
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

  return v_total;
end;
$$;

comment on function public.award_milestone_xp(uuid, integer) is
  'Uncapped one-off XP for a tournament placement or a daily challenge reward. '
  'Not subject to the repeatable daily cap, which exists to limit grinding rather '
  'than to limit prizes. Server-only.';

revoke execute on function public.award_milestone_xp(uuid, integer) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Sprint tournament structure
-- ---------------------------------------------------------------------------

-- Where hand one's button sat. Chosen by the server's CSPRNG so no seat carries
-- a standing positional advantage; kept because the result screen reports it.
alter table public.tournaments
  add column if not exists initial_button integer
    check (initial_button is null or initial_button >= 0);

-- Sudden-death bookkeeping. The specification allows at most five tie-break
-- hands per tournament; past that a tie is accepted and the placement shared.
alter table public.tournaments
  add column if not exists tie_break_hands_used integer not null default 0
    check (tie_break_hands_used >= 0);

-- The scheduled hand whose boundary is currently being played out, or NULL when
-- no tie-break is in progress. Needed because a sudden-death hand is an EXTRA
-- hand at hand six, not hand seven, and must carry hand six's bet ceiling.
alter table public.tournaments
  add column if not exists tie_break_boundary integer
    check (tie_break_boundary is null or tie_break_boundary > 0);

comment on column public.tournaments.tie_break_boundary is
  'Scheduled hand whose boundary a sudden-death hand is resolving, else NULL. '
  'A tie-break hand carries the boundary hand''s bet ceiling, not the next one''s.';

-- How many of the twelve SCHEDULED hands have been played.
--
-- Deliberately not the engine's hand number, which counts every hand dealt. A
-- sudden-death hand is a "special" extra hand in the specification's words, so it
-- must not consume one of the twelve — and it must not push the hand-9 ceiling
-- change earlier either. A measured run made exactly that mistake: one tie-break
-- at the hand-six boundary left the tournament playing eleven scheduled hands and
-- raising its bet ceiling an engine-hand too soon.
alter table public.tournaments
  add column if not exists scheduled_hands_played integer not null default 0
    check (scheduled_hands_played >= 0);

-- Which scheduled hand this entry went out after. `eliminated_at` records when
-- in wall-clock time; placement ordering needs the hand, because "outlasted the
-- field" is measured in hands and two players can go out in the same second.
alter table public.tournament_entries
  add column if not exists eliminated_after_hand integer
    check (eliminated_after_hand is null or eliminated_after_hand >= 0);

-- Set for the duration of a sudden-death hand. Everyone else sits that hand out.
alter table public.tournament_entries
  add column if not exists in_tie_break boolean not null default false;

-- What the placement actually paid. Derivable from prize_ledger_id, but the
-- result screen reads it directly and a zero here is meaningfully different
-- from a missing ledger row: fourth place pays nothing, by design.
alter table public.tournament_entries
  add column if not exists prize_chips bigint not null default 0
    check (prize_chips >= 0);

alter table public.tournament_entries
  add column if not exists prize_xp integer not null default 0
    check (prize_xp >= 0);

-- ---------------------------------------------------------------------------
-- Reading a tournament
-- ---------------------------------------------------------------------------

-- Caller-scoped, exactly like `viewer_is_in_tournament`: it takes only the
-- tournament and derives the viewer from auth.uid(), so it cannot be turned into
-- an oracle for whether some other account is entered in something.
--
-- It exists because standings need display names, and reaching profiles through
-- the entries policy would hide a competitor whose profile privacy is 'private'
-- — leaving a live tournament with a nameless seat. Competitors seeing each
-- other's stacks is load-bearing for tournament strategy; the specification's
-- sequential visible betting depends on it.
create or replace function public.sprint_standings(p_tournament_id uuid)
returns table (
  entry_id              uuid,
  display_name          text,
  chips                 bigint,
  status                public.tournament_entry_status,
  placement             integer,
  eliminated_after_hand integer,
  in_tie_break          boolean,
  prize_chips           bigint,
  prize_xp              integer,
  is_you                boolean
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

  if not exists (
    select 1 from public.tournament_entries e
    where e.tournament_id = p_tournament_id and e.user_id = v_me
  ) then
    raise exception 'you are not in that tournament' using errcode = '42501';
  end if;

  return query
    select e.id, p.display_name::text, e.chips, e.status, e.placement,
           e.eliminated_after_hand, e.in_tie_break, e.prize_chips, e.prize_xp,
           e.user_id = v_me
    from public.tournament_entries e
    join public.profiles p on p.id = e.user_id
    where e.tournament_id = p_tournament_id
    order by
      -- Survivors above the eliminated, then by stack. The same ordering the
      -- format module uses for placement, so the live table and the final result
      -- do not disagree about who is ahead.
      (e.eliminated_after_hand is not null),
      e.eliminated_after_hand desc nulls first,
      e.chips desc,
      e.id;
end;
$$;

revoke execute on function public.sprint_standings(uuid) from public, anon;
grant execute on function public.sprint_standings(uuid) to authenticated;

-- The player's live tournament, so the client can rejoin after a kill without
-- being told to register again.
create or replace function public.my_sprint_entry()
returns table (
  tournament_id        uuid,
  entry_id             uuid,
  tournament_status    public.tournament_status,
  entry_status         public.tournament_entry_status,
  game_session_id      uuid,
  -- The player's SEAT at the tournament table, which is not the same thing as
  -- their entry. The table screen resolves the player's own hand and controls by
  -- seat id; handed an entry id it finds no seat and renders no buttons at all.
  game_session_seat_id uuid,
  entries_filled       integer,
  seats_required       integer,
  chips                bigint,
  placement            integer,
  tie_break_boundary   integer,
  tie_break_hands_used integer
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select
    t.id, e.id, t.status, e.status, g.id,
    (select seat.id from public.game_session_seats seat
     where seat.game_session_id = g.id and seat.user_id = e.user_id
     limit 1),
    (select count(*)::int from public.tournament_entries x where x.tournament_id = t.id),
    t.max_entries,
    e.chips, e.placement, t.tie_break_boundary, t.tie_break_hands_used
  from public.tournament_entries e
  join public.tournaments t on t.id = e.tournament_id
  left join public.game_sessions g on g.tournament_id = t.id
  where e.user_id = (select auth.uid())
    and t.status in ('registering', 'running')
  order by e.registered_at desc
  limit 1;
$$;

revoke execute on function public.my_sprint_entry() from public, anon;
grant execute on function public.my_sprint_entry() to authenticated;

-- The catalogue entry a player reads BEFORE spending 500 chips. The
-- specification requires the format to be visible before entry, so this is a
-- read of the real configuration rather than copy duplicated in the client.
create or replace function public.sprint_format()
returns table (
  seats            integer,
  scheduled_hands  integer,
  starting_chips   bigint,
  entry_fee_chips  bigint,
  min_bet          bigint,
  early_max_bet    bigint,
  late_max_bet     bigint,
  late_bets_from   integer,
  elimination_hand integer,
  prize_structure  jsonb
)
language sql
stable
as $$
  select 4, 12, 10000::bigint, 500::bigint, 100::bigint, 2000::bigint, 5000::bigint, 9, 6,
    '[{"placement":1,"chips":2000,"xp":200},
      {"placement":2,"chips":1000,"xp":120},
      {"placement":3,"chips":500,"xp":80},
      {"placement":4,"chips":0,"xp":40}]'::jsonb;
$$;

comment on function public.sprint_format() is
  'The sprint configuration a player sees before paying an entry fee. Mirrored by '
  'SPRINT in supabase/functions/_shared/tournament-format.ts; '
  'supabase/tests/16_sprint_and_daily.test.sql asserts the two agree field by field.';

-- Readable while signed OUT as well.
--
-- The specification requires a player to know the format before spending an
-- entry fee, and someone deciding whether to make an account is exactly who
-- needs to read it. The alternative was a copy of "12 hands, 2,000 max" typed
-- into the client for guests, which is a second source of truth on the one screen
-- where being wrong costs chips.
--
-- It discloses nothing: every value here is published configuration, identical
-- for everyone, and the function takes no arguments and reads no table.
grant execute on function public.sprint_format() to anon, authenticated;
