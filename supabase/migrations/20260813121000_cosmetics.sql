-- =============================================================================
-- Arc 21 — 1000 Cosmetics
--
-- There is no `price` column and no randomised unlock, because Arc 21 ships no
-- chip purchases and no loot mechanics. The `cosmetic_unlock_type` enum has no
-- member that could express either, so adding one would require a migration and
-- a deliberate decision rather than a quiet INSERT.
--
-- Ownership is server-controlled: `user_cosmetics` has no client write path.
-- A player may freely change their `loadout`, but only to items they own, and
-- only into a slot matching the item's kind — enforced by trigger, so it holds
-- for any future write path as well.
-- =============================================================================

create table public.cosmetics (
  id            uuid primary key default gen_random_uuid(),

  code          text not null unique check (code ~ '^[a-z0-9-]{3,50}$'),
  kind          public.cosmetic_kind not null,

  name          text not null check (char_length(name) between 1 and 40),
  description   text check (char_length(description) <= 240),

  -- Key into the bundled asset index; never a remote URL.
  asset_key     text not null check (asset_key ~ '^[a-z0-9_/-]{3,80}$'),

  unlock_type   public.cosmetic_unlock_type not null,
  unlock_config jsonb not null default '{}'::jsonb,

  sort_order    integer not null default 0,
  is_active     boolean not null default true,
  created_at    timestamptz not null default now(),

  -- Each unlock type must carry the parameters its evaluator needs, so an
  -- unreachable cosmetic cannot be seeded by accident.
  constraint cosmetics_unlock_config_is_complete check (
    case unlock_type
      when 'default'              then unlock_config = '{}'::jsonb
      when 'level'                then unlock_config ? 'level'
      when 'career_node'          then unlock_config ? 'careerNodeCode'
      when 'career_chapter'       then unlock_config ? 'chapter'
      when 'daily_streak'         then unlock_config ? 'streak'
      when 'tournament_placement' then unlock_config ? 'placement'
      when 'achievement'          then unlock_config ? 'achievement'
    end
  )
);

comment on table public.cosmetics is
  'Public cosmetic catalogue. No price column and no randomised unlock type exists by design.';

create index cosmetics_kind_idx on public.cosmetics (kind, sort_order);

create trigger cosmetics_deny_client_write
  before insert or update or delete on public.cosmetics
  for each row execute function public.deny_client_write();

-- Close the reference left open in 0700.
alter table public.career_nodes
  add constraint career_nodes_reward_cosmetic_fk
  foreign key (reward_cosmetic_id) references public.cosmetics (id) on delete set null;

-- -----------------------------------------------------------------------------
-- Ownership
-- -----------------------------------------------------------------------------

create table public.user_cosmetics (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references public.profiles (id) on delete cascade,
  cosmetic_id uuid not null references public.cosmetics (id) on delete cascade,

  -- Why this item is owned; mirrors the catalogue's unlock_type.
  source      public.cosmetic_unlock_type not null,
  -- The specific node code, placement or achievement that granted it.
  source_ref  text check (source_ref is null or char_length(source_ref) <= 80),

  acquired_at timestamptz not null default now(),

  constraint user_cosmetics_unique unique (user_id, cosmetic_id)
);

comment on table public.user_cosmetics is
  'Server-granted cosmetic ownership. Readable by its owner; no client write path.';

create index user_cosmetics_user_idx on public.user_cosmetics (user_id);

create trigger user_cosmetics_deny_client_write
  before insert or update or delete on public.user_cosmetics
  for each row execute function public.deny_client_write();

-- -----------------------------------------------------------------------------
-- Loadout — one equipped set per player
-- -----------------------------------------------------------------------------

create table public.loadouts (
  id                      uuid primary key default gen_random_uuid(),
  user_id                 uuid not null unique references public.profiles (id) on delete cascade,

  avatar_cosmetic_id      uuid references public.cosmetics (id) on delete set null,
  card_back_cosmetic_id   uuid references public.cosmetics (id) on delete set null,
  table_theme_cosmetic_id uuid references public.cosmetics (id) on delete set null,

  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now()
);

comment on table public.loadouts is
  'Equipped cosmetics. Client-writable, but every slot is validated against ownership and kind by trigger.';

create trigger loadouts_set_updated_at
  before update on public.loadouts
  for each row execute function public.set_updated_at();

-- A slot may only hold an item the player owns, of the kind that slot expects.
create or replace function public.guard_loadout_slots()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_slot record;
  v_kind public.cosmetic_kind;
begin
  for v_slot in
    select * from (values
      (new.avatar_cosmetic_id,      'avatar'::public.cosmetic_kind),
      (new.card_back_cosmetic_id,   'card_back'::public.cosmetic_kind),
      (new.table_theme_cosmetic_id, 'table_theme'::public.cosmetic_kind)
    ) as slots(cosmetic_id, expected_kind)
    where slots.cosmetic_id is not null
  loop
    select c.kind into v_kind
    from public.cosmetics c
    where c.id = v_slot.cosmetic_id and c.is_active;

    if v_kind is null then
      raise exception 'cosmetic % is not available', v_slot.cosmetic_id
        using errcode = '23503';
    end if;

    if v_kind <> v_slot.expected_kind then
      raise exception 'cosmetic % is a % and cannot fill the % slot',
        v_slot.cosmetic_id, v_kind, v_slot.expected_kind
        using errcode = '23514';
    end if;

    if not exists (
      select 1 from public.user_cosmetics uc
      where uc.user_id = new.user_id and uc.cosmetic_id = v_slot.cosmetic_id
    ) then
      raise exception 'cosmetic % is not owned by this player', v_slot.cosmetic_id
        using errcode = '42501';
    end if;
  end loop;

  return new;
end;
$$;

revoke execute on function public.guard_loadout_slots() from public;

create trigger loadouts_guard_slots
  before insert or update on public.loadouts
  for each row execute function public.guard_loadout_slots();

-- -----------------------------------------------------------------------------
-- Privileges and Row Level Security
-- -----------------------------------------------------------------------------

revoke all on table public.cosmetics from anon, authenticated;
revoke all on table public.user_cosmetics from anon, authenticated;
revoke all on table public.loadouts from anon, authenticated;

grant select on table public.cosmetics to anon, authenticated;
grant select on table public.user_cosmetics to authenticated;
grant select, insert on table public.loadouts to authenticated;
grant update (
  avatar_cosmetic_id,
  card_back_cosmetic_id,
  table_theme_cosmetic_id
) on table public.loadouts to authenticated;

alter table public.cosmetics enable row level security;
alter table public.user_cosmetics enable row level security;
alter table public.loadouts enable row level security;

create policy cosmetics_select_active
  on public.cosmetics for select
  to anon, authenticated
  using (is_active);

create policy user_cosmetics_select_own
  on public.user_cosmetics for select
  to authenticated
  using (user_id = (select auth.uid()));

create policy loadouts_select_own
  on public.loadouts for select
  to authenticated
  using (user_id = (select auth.uid()));

create policy loadouts_insert_own
  on public.loadouts for insert
  to authenticated
  with check (user_id = (select auth.uid()));

create policy loadouts_update_own
  on public.loadouts for update
  to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));
