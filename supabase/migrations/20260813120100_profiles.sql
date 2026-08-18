-- =============================================================================
-- Arc 21 — 0100 Profiles and statistics
--
-- `profiles` is the only table in this file a client may write, and it may
-- write only its presentational columns. `level` and `xp` are progression
-- currency: they are protected by a column-level GRANT (the client has no
-- UPDATE privilege on those columns at all) *and* by a guard trigger, so
-- neither a forgotten GRANT nor a widened policy is sufficient to open them.
--
-- `player_stats` / `player_mode_stats` are competitive records. They are
-- readable by their owner and written only by server code.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Text hygiene at the database boundary
--
-- SECURITY.md asks for a lowercase-normalised handle that is reserved-name and
-- profanity filtered with rate-limited changes, and a display name of 1-24
-- *visible* characters. The threat model is a client that never runs the app's
-- validation at all, so both rules are enforced here as well.
--
-- These functions are the last line of defence, not the product's moderation
-- system: a word list in a migration is necessarily coarse, and the server
-- keeps the authoritative one. What the database does guarantee is that
-- `admin`, `support` and an entirely invisible display name are
-- unrepresentable, and that a handle cannot be churned without limit.
--
-- Both are pure functions of their argument and a compile-time constant list.
-- They are callable by `authenticated` because they appear in CHECK constraints
-- and in guard triggers on `profiles`, both of which are evaluated as the
-- invoking role; they disclose nothing about any user.
-- -----------------------------------------------------------------------------

create or replace function public.sanitise_display_name(p_name text)
returns text
language sql
immutable
as $$
  --  1. every flavour of space becomes an ASCII space (so a newline separates
  --     words instead of vanishing and joining them)
  --  2. control, bidi-override and zero-width characters are deleted outright:
  --     U+202E alone renders a name backwards, and a string of U+200B renders
  --     as nothing at all while still satisfying a length check
  --  3. runs of spaces collapse, the result is trimmed, and a result with no
  --     visible characters left becomes null
  select nullif(
    btrim(
      regexp_replace(
        regexp_replace(
          regexp_replace(
            coalesce(p_name, ''),
            U&'[\0009-\000D\0020\0085\00A0\1680\2000-\200A\2028\2029\202F\205F\3000]',
            ' ', 'g'
          ),
          U&'[\0001-\0008\000E-\001F\007F-\009F\00AD\061C\180E\200B-\200F\202A-\202E\2060-\2064\2066-\206F\FEFF]',
          '', 'g'
        ),
        '  +', ' ', 'g'
      ),
      ' '
    ),
    ''
  );
$$;

comment on function public.sanitise_display_name(text) is
  'Deletes control, bidi-override and zero-width characters and normalises whitespace. Returns null when no visible character remains. Unicode is otherwise preserved.';

create or replace function public.username_is_permitted(p_username text)
returns boolean
language plpgsql
immutable
as $$
declare
  -- Matched against the handle with underscores removed, and again with common
  -- digit substitutions folded (0->o, 1->i, 3->e, 4->a, 5->s, 7->t), so
  -- `adm1n` and `a_d_m_i_n` are refused as well as `admin`.
  c_reserved constant text[] := array[
    'admin', 'admins', 'administrator', 'administrators', 'sysadmin',
    'superuser', 'root', 'postgres', 'supabase', 'system', 'service',
    'services', 'server', 'api', 'rest', 'graphql', 'auth', 'oauth',
    'login', 'signin', 'signup', 'register', 'password', 'account',
    'accounts', 'settings', 'security', 'abuse', 'legal', 'privacy',
    'terms', 'billing', 'payment', 'payments', 'refund', 'refunds',
    'support', 'helpdesk', 'help', 'contact', 'info', 'moderator',
    'moderators', 'mod', 'mods', 'staff', 'team', 'official', 'owner',
    'founder', 'everyone', 'anyone', 'here', 'all', 'anonymous', 'anon',
    'guest', 'null', 'undefined', 'none', 'nobody', 'bot', 'bots',
    'dealer', 'croupier', 'house', 'casino', 'arc', 'arc21', 'arctwentyone',
    'arcadmin', 'arcstaff', 'arcsupport', 'arcteam', 'arcofficial'
  ];
  -- Refused anywhere in the handle. Deliberately limited to strings that do
  -- not occur inside ordinary words, so the filter does not reject real names.
  c_forbidden_substrings constant text[] := array[
    'fuck', 'shit', 'cunt', 'bitch', 'whore', 'slut', 'pussy', 'asshole',
    'bastard', 'wanker', 'dickhead', 'cocksuck', 'motherfuck', 'jizz',
    'nigger', 'nigga', 'faggot', 'kike', 'tranny', 'retard', 'molest',
    'pedophile', 'paedophile', 'rapist', 'nazi', 'hitler', 'porn'
  ];
  -- Refused only as a whole word, because each is a substring of ordinary
  -- ones ('grape', 'analysis', 'raccoon', 'class', 'shoe').
  c_forbidden_words constant text[] := array[
    'rape', 'anal', 'coon', 'spic', 'cum', 'ass', 'fag', 'hoe'
  ];
  v_plain  text;
  v_folded text;
begin
  if p_username is null or p_username !~ '^[a-z0-9_]{3,20}$' then
    return false;
  end if;

  v_plain  := replace(p_username, '_', '');
  v_folded := translate(v_plain, '013457', 'oieast');

  if v_plain = any (c_reserved) or v_folded = any (c_reserved) then
    return false;
  end if;

  if exists (
    select 1
    from unnest(c_forbidden_substrings) as s (word)
    where v_plain like '%' || s.word || '%'
       or v_folded like '%' || s.word || '%'
  ) then
    return false;
  end if;

  if exists (
    select 1
    from unnest(
      regexp_split_to_array(translate(p_username, '013457', 'oieast'), '[_0-9]+')
    ) as t (word)
    where t.word = any (c_forbidden_words)
  ) then
    return false;
  end if;

  return true;
end;
$$;

comment on function public.username_is_permitted(text) is
  'Handle format plus the reserved-name and profanity filter SECURITY.md requires. Pure: depends only on its argument and a constant word list.';

revoke execute on function public.sanitise_display_name(text) from public;
revoke execute on function public.username_is_permitted(text) from public;

-- Needed by the CHECK constraints and guard triggers below, both of which are
-- evaluated as the invoking role. Without this, every legitimate rename fails
-- with `permission denied for function`.
grant execute on function public.sanitise_display_name(text) to authenticated;
grant execute on function public.username_is_permitted(text) to authenticated;

create table public.profiles (
  id                  uuid primary key references auth.users (id) on delete cascade,
  username            text not null unique
                        check (username ~ '^[a-z0-9_]{3,20}$'),
  display_name        text not null
                        check (char_length(display_name) between 1 and 24),
  bio                 text check (char_length(bio) <= 160),
  avatar_url          text check (char_length(avatar_url) <= 2048),
  country_code        text check (country_code ~ '^[A-Z]{2}$'),
  privacy             public.profile_privacy not null default 'public',

  -- Server-owned progression. Never client-writable.
  level               integer not null default 1 check (level >= 1 and level <= 100),
  xp                  bigint  not null default 0 check (xp >= 0),

  -- Written only by guard_profile_username(). Deliberately absent from the
  -- client's UPDATE column grant: the timestamp a rate limit is measured
  -- against must not be writable by the client the limit applies to.
  username_changed_at timestamptz,
  last_seen_at        timestamptz not null default now(),
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),

  -- The privilege system and the guard triggers below are the primary
  -- enforcement; these are the constraint-level backstop, so a row that
  -- violates them cannot exist however it was written.
  constraint profiles_username_is_permitted
    check (public.username_is_permitted(username)),
  constraint profiles_display_name_is_sanitised
    check (display_name = public.sanitise_display_name(display_name))
);

comment on table public.profiles is
  'Public-facing player identity. level and xp are server-owned and are not client-writable.';
comment on column public.profiles.level is
  'Server-owned. Protected by column-level GRANT and by guard_profile_server_columns().';
comment on column public.profiles.xp is
  'Server-owned. Protected by column-level GRANT and by guard_profile_server_columns().';
comment on column public.profiles.username_changed_at is
  'Set by guard_profile_username() on every rename. Not client-writable; it is what the rename rate limit is measured against.';

create index profiles_username_idx on public.profiles (username);
create index profiles_level_idx on public.profiles (level desc);

create trigger profiles_set_updated_at
  before update on public.profiles
  for each row execute function public.set_updated_at();

-- The second lock on level / xp. A client role that somehow acquires an UPDATE
-- privilege still cannot move progression.
create or replace function public.guard_profile_server_columns()
returns trigger
language plpgsql
as $$
begin
  if public.is_client_role() then
    if new.level is distinct from old.level then
      raise exception 'profiles.level is server-owned and not client-writable'
        using errcode = '42501';
    end if;
    if new.xp is distinct from old.xp then
      raise exception 'profiles.xp is server-owned and not client-writable'
        using errcode = '42501';
    end if;
    if new.id is distinct from old.id then
      raise exception 'profiles.id is immutable' using errcode = '42501';
    end if;
    if new.created_at is distinct from old.created_at then
      raise exception 'profiles.created_at is immutable' using errcode = '42501';
    end if;
  end if;
  return new;
end;
$$;

revoke execute on function public.guard_profile_server_columns() from public;

create trigger profiles_guard_server_columns
  before update on public.profiles
  for each row execute function public.guard_profile_server_columns();

-- -----------------------------------------------------------------------------
-- Handle and display-name enforcement
-- -----------------------------------------------------------------------------

-- Renames: normalised, filtered and rate limited.
--
-- USERNAME_CHANGE_INTERVAL is declared once, here, rather than repeated as a
-- literal wherever a rename is checked. The limit is measured against
-- `username_changed_at`, which only this trigger writes.
create or replace function public.guard_profile_username()
returns trigger
language plpgsql
as $$
declare
  c_username_change_interval constant interval := interval '30 days';
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

  if public.is_client_role()
     and old.username_changed_at is not null
     and old.username_changed_at > now() - c_username_change_interval then
    raise exception
      'username may be changed once every %; the last change was %',
      c_username_change_interval, old.username_changed_at
      using errcode = '55000';
  end if;

  new.username_changed_at := now();
  return new;
end;
$$;

-- Display names are stored sanitised rather than merely validated, so the
-- stored value is the one every reader gets. A name with nothing visible left
-- is rejected outright: `char_length` counts zero-width characters, so a length
-- check alone accepts a name that renders as empty.
create or replace function public.normalise_profile_display_name()
returns trigger
language plpgsql
as $$
begin
  new.display_name := public.sanitise_display_name(new.display_name);

  if new.display_name is null then
    raise exception 'display_name must contain at least one visible character'
      using errcode = '23514';
  end if;

  return new;
end;
$$;

revoke execute on function public.guard_profile_username() from public;
revoke execute on function public.normalise_profile_display_name() from public;

create trigger profiles_guard_username
  before insert or update on public.profiles
  for each row execute function public.guard_profile_username();

create trigger profiles_normalise_display_name
  before insert or update on public.profiles
  for each row execute function public.normalise_profile_display_name();

-- -----------------------------------------------------------------------------
-- Aggregate statistics (all modes combined)
-- -----------------------------------------------------------------------------

create table public.player_stats (
  id                  uuid primary key default gen_random_uuid(),
  user_id             uuid not null unique references public.profiles (id) on delete cascade,

  sessions_played     integer not null default 0 check (sessions_played >= 0),
  hands_played        integer not null default 0 check (hands_played >= 0),
  hands_won           integer not null default 0 check (hands_won >= 0),
  hands_lost          integer not null default 0 check (hands_lost >= 0),
  hands_pushed        integer not null default 0 check (hands_pushed >= 0),
  hands_surrendered   integer not null default 0 check (hands_surrendered >= 0),
  blackjacks          integer not null default 0 check (blackjacks >= 0),
  busts               integer not null default 0 check (busts >= 0),
  doubles             integer not null default 0 check (doubles >= 0),
  splits              integer not null default 0 check (splits >= 0),
  insurance_taken     integer not null default 0 check (insurance_taken >= 0),

  chips_wagered       bigint not null default 0 check (chips_wagered >= 0),
  chips_net           bigint not null default 0,
  biggest_win         bigint not null default 0 check (biggest_win >= 0),

  current_win_streak  integer not null default 0 check (current_win_streak >= 0),
  longest_win_streak  integer not null default 0 check (longest_win_streak >= 0),

  -- Strategy accuracy. decisions_optimal can never exceed decisions_total.
  decisions_total     integer not null default 0 check (decisions_total >= 0),
  decisions_optimal   integer not null default 0 check (decisions_optimal >= 0),

  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),

  constraint player_stats_optimal_within_total
    check (decisions_optimal <= decisions_total),
  constraint player_stats_streak_ordering
    check (current_win_streak <= longest_win_streak),
  constraint player_stats_outcomes_within_played
    check (hands_won + hands_lost + hands_pushed <= hands_played)
);

comment on table public.player_stats is
  'Server-written lifetime statistics. Private to the owning user.';

create trigger player_stats_set_updated_at
  before update on public.player_stats
  for each row execute function public.set_updated_at();

create trigger player_stats_deny_client_write
  before insert or update or delete on public.player_stats
  for each row execute function public.deny_client_write();

-- -----------------------------------------------------------------------------
-- Per-mode, per-ruleset statistics
--
-- Bucketed by ruleset key ("arc-standard@1") because basic strategy — and
-- therefore decision accuracy — is only comparable within one ruleset version.
-- -----------------------------------------------------------------------------

create table public.player_mode_stats (
  id                  uuid primary key default gen_random_uuid(),
  user_id             uuid not null references public.profiles (id) on delete cascade,
  mode                public.game_mode not null,
  ruleset_key         text not null check (ruleset_key ~ '^[a-z0-9-]+@[0-9]+$'),

  sessions_played     integer not null default 0 check (sessions_played >= 0),
  hands_played        integer not null default 0 check (hands_played >= 0),
  hands_won           integer not null default 0 check (hands_won >= 0),
  hands_lost          integer not null default 0 check (hands_lost >= 0),
  hands_pushed        integer not null default 0 check (hands_pushed >= 0),
  hands_surrendered   integer not null default 0 check (hands_surrendered >= 0),
  blackjacks          integer not null default 0 check (blackjacks >= 0),
  busts               integer not null default 0 check (busts >= 0),
  doubles             integer not null default 0 check (doubles >= 0),
  splits              integer not null default 0 check (splits >= 0),
  insurance_taken     integer not null default 0 check (insurance_taken >= 0),

  chips_wagered       bigint not null default 0 check (chips_wagered >= 0),
  chips_net           bigint not null default 0,

  decisions_total     integer not null default 0 check (decisions_total >= 0),
  decisions_optimal   integer not null default 0 check (decisions_optimal >= 0),

  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),

  constraint player_mode_stats_unique unique (user_id, mode, ruleset_key),
  constraint player_mode_stats_optimal_within_total
    check (decisions_optimal <= decisions_total)
);

comment on table public.player_mode_stats is
  'Server-written statistics bucketed by mode and ruleset version. Private to the owning user.';

create index player_mode_stats_user_idx on public.player_mode_stats (user_id);

create trigger player_mode_stats_set_updated_at
  before update on public.player_mode_stats
  for each row execute function public.set_updated_at();

create trigger player_mode_stats_deny_client_write
  before insert or update or delete on public.player_mode_stats
  for each row execute function public.deny_client_write();

-- -----------------------------------------------------------------------------
-- Privileges
-- -----------------------------------------------------------------------------

revoke all on table public.profiles from anon, authenticated;
revoke all on table public.player_stats from anon, authenticated;
revoke all on table public.player_mode_stats from anon, authenticated;

grant select on table public.profiles to authenticated;

-- Column-level UPDATE. Any statement whose SET list touches a column outside
-- this set is rejected by the privilege system before RLS is even consulted.
grant update (
  username,
  display_name,
  bio,
  avatar_url,
  country_code,
  privacy
) on table public.profiles to authenticated;

grant select on table public.player_stats to authenticated;
grant select on table public.player_mode_stats to authenticated;

-- -----------------------------------------------------------------------------
-- Row Level Security
-- -----------------------------------------------------------------------------

alter table public.profiles enable row level security;
alter table public.player_stats enable row level security;
alter table public.player_mode_stats enable row level security;

-- Own profile is always visible. The broader visibility policy (public /
-- friends-only, minus blocks) is added in the social migration, once the
-- friendships and blocks tables it depends on exist.
create policy profiles_select_self
  on public.profiles for select
  to authenticated
  using (id = (select auth.uid()));

create policy profiles_update_self
  on public.profiles for update
  to authenticated
  using (id = (select auth.uid()))
  with check (id = (select auth.uid()));

-- No INSERT or DELETE policy: rows are created by the auth.users trigger and
-- removed by cascade when the account is deleted.

create policy player_stats_select_own
  on public.player_stats for select
  to authenticated
  using (user_id = (select auth.uid()));

create policy player_mode_stats_select_own
  on public.player_mode_stats for select
  to authenticated
  using (user_id = (select auth.uid()));
