-- =============================================================================
-- Arc 21 — 1100 Push tokens and notifications
--
-- A device registers and retires its own push token; everything else about a
-- notification is server-written. The only column a client may update on a
-- notification is `read_at`, enforced by a column-level GRANT.
-- =============================================================================

create table public.push_tokens (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references public.profiles (id) on delete cascade,

  token        text not null unique check (char_length(token) between 8 and 512),
  platform     public.push_platform not null,
  device_id    text check (device_id is null or char_length(device_id) <= 128),

  is_active    boolean not null default true,

  created_at   timestamptz not null default now(),
  last_used_at timestamptz not null default now()
);

comment on table public.push_tokens is
  'Per-device push registration. A user manages only their own rows.';

create index push_tokens_user_idx on public.push_tokens (user_id) where is_active;

-- -----------------------------------------------------------------------------
-- Notifications
-- -----------------------------------------------------------------------------

create table public.notifications (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references public.profiles (id) on delete cascade,

  kind       public.notification_kind not null,
  title      text not null check (char_length(title) between 1 and 80),
  body       text not null check (char_length(body) between 1 and 240),

  -- Deep-link parameters only. Never a seed, a shoe or a hole card.
  data       jsonb not null default '{}'::jsonb,

  read_at    timestamptz,
  sent_at    timestamptz,
  created_at timestamptz not null default now()
);

comment on table public.notifications is
  'Server-written user notifications. Clients may only mark them read.';
comment on column public.notifications.data is
  'Deep-link parameters only. Must never carry a daily-challenge seed, shoe order or hole card.';

create index notifications_user_unread_idx
  on public.notifications (user_id, created_at desc)
  where read_at is null;

create or replace function public.guard_notification_client_update()
returns trigger
language plpgsql
as $$
begin
  if public.is_client_role() then
    if new.kind is distinct from old.kind
       or new.title is distinct from old.title
       or new.body is distinct from old.body
       or new.data is distinct from old.data
       or new.user_id is distinct from old.user_id
       or new.sent_at is distinct from old.sent_at then
      raise exception 'only read_at may be changed on a notification'
        using errcode = '42501';
    end if;
  end if;
  return new;
end;
$$;

revoke execute on function public.guard_notification_client_update() from public;

create trigger notifications_guard_client_update
  before update on public.notifications
  for each row execute function public.guard_notification_client_update();

-- -----------------------------------------------------------------------------
-- Privileges and Row Level Security
-- -----------------------------------------------------------------------------

revoke all on table public.push_tokens from anon, authenticated;
revoke all on table public.notifications from anon, authenticated;

grant select, insert, delete on table public.push_tokens to authenticated;
grant update (is_active, last_used_at, device_id) on table public.push_tokens to authenticated;

grant select, delete on table public.notifications to authenticated;
grant update (read_at) on table public.notifications to authenticated;

alter table public.push_tokens enable row level security;
alter table public.notifications enable row level security;

create policy push_tokens_select_own
  on public.push_tokens for select
  to authenticated
  using (user_id = (select auth.uid()));

create policy push_tokens_insert_own
  on public.push_tokens for insert
  to authenticated
  with check (user_id = (select auth.uid()));

create policy push_tokens_update_own
  on public.push_tokens for update
  to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

create policy push_tokens_delete_own
  on public.push_tokens for delete
  to authenticated
  using (user_id = (select auth.uid()));

create policy notifications_select_own
  on public.notifications for select
  to authenticated
  using (user_id = (select auth.uid()));

create policy notifications_update_own
  on public.notifications for update
  to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

create policy notifications_delete_own
  on public.notifications for delete
  to authenticated
  using (user_id = (select auth.uid()));
