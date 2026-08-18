-- =============================================================================
-- Arc 21 — 0200 Wallet and ledger
--
-- The global chip wallet. Virtual chips have no monetary value, but the
-- integrity model is the same one a real ledger needs, because a modified
-- client is assumed to be attacking it.
--
--   * There is NO client write path. `anon` and `authenticated` hold SELECT
--     and nothing else on either table, and neither table has an INSERT,
--     UPDATE or DELETE policy. Two independent mechanisms would both have to
--     fail before a client could move a chip.
--   * `balance >= 0` is a CHECK constraint, not application logic.
--   * The ledger is append-only. UPDATE is rejected for every role including
--     the server, and so is TRUNCATE — which no row-level trigger can see and
--     which would otherwise erase the whole history in one statement with a
--     leaked service key. A correction is a new row, never an edit to history.
--   * Every ledger row carries a UNIQUE idempotency key, so a replayed
--     economic command credits exactly once.
--   * All amounts are bigint. No floating point ever touches a balance.
-- =============================================================================

create table public.wallets (
  id                uuid primary key default gen_random_uuid(),
  user_id           uuid not null unique references public.profiles (id) on delete cascade,

  balance           bigint not null default 0,

  lifetime_credited bigint not null default 0 check (lifetime_credited >= 0),
  lifetime_debited  bigint not null default 0 check (lifetime_debited >= 0),

  -- Optimistic concurrency for the command transaction.
  version           bigint not null default 0 check (version >= 0),

  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),

  constraint wallets_balance_non_negative check (balance >= 0)
);

comment on table public.wallets is
  'Global virtual-chip balance. Server-authoritative: readable by its owner, writable by no client role.';
comment on column public.wallets.balance is
  'Integer chips. balance >= 0 is enforced by the wallets_balance_non_negative CHECK constraint.';

create trigger wallets_set_updated_at
  before update on public.wallets
  for each row execute function public.set_updated_at();

create trigger wallets_deny_client_write
  before insert or update or delete on public.wallets
  for each row execute function public.deny_client_write();

-- -----------------------------------------------------------------------------
-- Append-only ledger
-- -----------------------------------------------------------------------------

create table public.wallet_ledger (
  id              uuid primary key default gen_random_uuid(),
  wallet_id       uuid not null references public.wallets (id) on delete cascade,
  user_id         uuid not null references public.profiles (id) on delete cascade,

  delta           bigint not null check (delta <> 0),
  balance_after   bigint not null check (balance_after >= 0),

  reason          public.ledger_reason not null,

  -- Loose reference rather than a foreign key, so one ledger shape serves game
  -- sessions, tournaments, career nodes and daily challenges without the table
  -- growing a nullable FK column per feature.
  reference_type  text check (reference_type is null or char_length(reference_type) <= 64),
  reference_id    uuid,

  -- The replay guard. A duplicate economic command hits this constraint and the
  -- caller returns the first committed result.
  idempotency_key text not null
                    check (char_length(idempotency_key) between 8 and 200),

  metadata        jsonb not null default '{}'::jsonb,
  created_at      timestamptz not null default now(),

  constraint wallet_ledger_idempotency_key_unique unique (idempotency_key)
);

comment on table public.wallet_ledger is
  'Append-only chip ledger. Every row carries a unique idempotency key; UPDATE is rejected for all roles.';

create index wallet_ledger_user_created_idx
  on public.wallet_ledger (user_id, created_at desc);
create index wallet_ledger_reference_idx
  on public.wallet_ledger (reference_type, reference_id)
  where reference_type is not null;

-- History is immutable for everyone. DELETE remains possible for the server so
-- an account deletion can cascade, but never for a client role.
create or replace function public.guard_ledger_append_only()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'UPDATE' then
    raise exception 'wallet_ledger is append-only; record a correcting entry instead'
      using errcode = '42501';
  end if;
  if tg_op = 'DELETE' and public.is_client_role() then
    raise exception 'wallet_ledger is not client-writable' using errcode = '42501';
  end if;
  if tg_op = 'INSERT' and public.is_client_role() then
    raise exception 'wallet_ledger is not client-writable' using errcode = '42501';
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end;
$$;

-- A FOR EACH ROW trigger never fires on TRUNCATE, and TRUNCATE would erase the
-- entire history in one statement while satisfying every row-level guard above
-- it. The privilege is revoked from every non-owner role in the hardening
-- migration; this is the second lock, so a role that somehow acquires TRUNCATE
-- still cannot use it on the ledger or the balances it reconciles against.
create or replace function public.deny_truncate()
returns trigger
language plpgsql
as $$
begin
  raise exception 'table %.% may not be truncated; its history is append-only',
    tg_table_schema, tg_table_name
    using errcode = '42501';
end;
$$;

revoke execute on function public.guard_ledger_append_only() from public;
revoke execute on function public.deny_truncate() from public;

create trigger wallet_ledger_append_only
  before insert or update or delete on public.wallet_ledger
  for each row execute function public.guard_ledger_append_only();

create trigger wallet_ledger_deny_truncate
  before truncate on public.wallet_ledger
  for each statement execute function public.deny_truncate();

create trigger wallets_deny_truncate
  before truncate on public.wallets
  for each statement execute function public.deny_truncate();

-- -----------------------------------------------------------------------------
-- The only supported way to move chips
--
-- SECURITY DEFINER, owned by postgres, executable by service_role only. Locks
-- the wallet row, honours the idempotency key, and lets the CHECK constraint —
-- not a comparison in application code — reject an overdraft.
-- -----------------------------------------------------------------------------

create or replace function public.apply_wallet_delta(
  p_user_id         uuid,
  p_delta           bigint,
  p_reason          public.ledger_reason,
  p_idempotency_key text,
  p_reference_type  text default null,
  p_reference_id    uuid default null,
  p_metadata        jsonb default '{}'::jsonb
)
returns public.wallet_ledger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_wallet    public.wallets;
  v_existing  public.wallet_ledger;
  v_entry     public.wallet_ledger;
begin
  -- Take the wallet lock FIRST. The lock, not the read, is what serialises a
  -- replay: two concurrent callers holding the same idempotency key both miss
  -- the other's uncommitted ledger row under READ COMMITTED, so a replay guard
  -- placed ahead of the lock lets the loser reach the INSERT and raise 23505
  -- instead of returning the first committed result. Blocking on the lock
  -- first means the loser resumes after the winner commits, and the next
  -- statement takes a fresh snapshot that contains the winner's row.
  select * into v_wallet
  from public.wallets
  where user_id = p_user_id
  for update;

  if not found then
    raise exception 'no wallet for user %', p_user_id using errcode = 'P0002';
  end if;

  -- Replay of an already-committed command: return the first result unchanged.
  select * into v_existing
  from public.wallet_ledger
  where idempotency_key = p_idempotency_key;

  if found then
    if v_existing.user_id <> p_user_id then
      raise exception
        'idempotency key % already belongs to a different account', p_idempotency_key
        using errcode = '23505';
    end if;
    return v_existing;
  end if;

  begin
    insert into public.wallet_ledger (
      wallet_id, user_id, delta, balance_after, reason,
      reference_type, reference_id, idempotency_key, metadata
    )
    values (
      v_wallet.id, p_user_id, p_delta, v_wallet.balance + p_delta, p_reason,
      p_reference_type, p_reference_id, p_idempotency_key, coalesce(p_metadata, '{}'::jsonb)
    )
    returning * into v_entry;
  exception when unique_violation then
    -- Belt and braces for a caller that holds no wallet lock in common with
    -- the winner (a key reused across users, or a future caller that locks
    -- differently): the conflicting row is committed by the time the INSERT
    -- raises, so re-reading it returns the first committed result.
    select * into v_existing
    from public.wallet_ledger
    where idempotency_key = p_idempotency_key;

    if found and v_existing.user_id = p_user_id then
      return v_existing;
    end if;
    raise;
  end;

  update public.wallets
  set balance           = balance + p_delta,
      lifetime_credited = lifetime_credited + greatest(p_delta, 0),
      lifetime_debited  = lifetime_debited + greatest(-p_delta, 0),
      version           = version + 1
  where id = v_wallet.id;

  return v_entry;
end;
$$;

comment on function public.apply_wallet_delta is
  'Server-only, idempotent, row-locking chip movement. Not executable by anon or authenticated.';

revoke execute on function public.apply_wallet_delta(
  uuid, bigint, public.ledger_reason, text, text, uuid, jsonb
) from public, anon, authenticated;
grant execute on function public.apply_wallet_delta(
  uuid, bigint, public.ledger_reason, text, text, uuid, jsonb
) to service_role;

-- -----------------------------------------------------------------------------
-- Account bootstrap
--
-- Profile, stats row, wallet and the opening ledger entry are created by the
-- server when the auth account appears. There is deliberately no client INSERT
-- path into any of them.
-- -----------------------------------------------------------------------------

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  -- Client-controlled: `raw_user_meta_data` is whatever the signup request
  -- sent. It is normalised and put through the same reserved-name filter a
  -- rename goes through, and falls back to a derived handle if it fails.
  v_requested text := lower(btrim(nullif(new.raw_user_meta_data ->> 'username', '')));
  -- 13 characters: 'p' plus twelve hex digits of the account id.
  v_base      text := 'p' || substr(replace(new.id::text, '-', ''), 1, 12);
  v_username  text;
  v_attempt   integer := 0;
  v_display   text;
  v_wallet_id uuid;
begin
  if v_requested is not null
     and public.username_is_permitted(v_requested)
     and not exists (select 1 from public.profiles where username = v_requested)
  then
    v_username := v_requested;
  else
    -- The derived handle is not unique on its own: two account ids can share
    -- their first twelve hex digits. Suffix until a free handle is found rather
    -- than retrying the same string, which would loop forever on a collision.
    v_username := v_base;
    while exists (select 1 from public.profiles where username = v_username) loop
      v_attempt := v_attempt + 1;
      if v_attempt > 50 then
        raise exception 'could not allocate a username for account %', new.id;
      end if;
      -- Stays within the 20-character limit: 13 + 1 + at most 2 digits.
      v_username := v_base || '_' || v_attempt::text;
    end loop;
  end if;

  -- Sanitise, then truncate, then sanitise again: truncating to 24 characters
  -- can leave a trailing space, and a name that is nothing but zero-width
  -- characters sanitises to null and falls back to the handle.
  v_display := public.sanitise_display_name(
    nullif(new.raw_user_meta_data ->> 'display_name', '')
  );
  v_display := left(coalesce(v_display, v_username), 24);
  v_display := coalesce(public.sanitise_display_name(v_display), v_username);

  insert into public.profiles (id, username, display_name)
  values (new.id, v_username, v_display);

  insert into public.player_stats (user_id) values (new.id);

  insert into public.wallets (user_id, balance, lifetime_credited)
  values (new.id, 10000, 10000)
  returning id into v_wallet_id;

  insert into public.wallet_ledger (
    wallet_id, user_id, delta, balance_after, reason, idempotency_key
  )
  values (
    v_wallet_id, new.id, 10000, 10000, 'initial_grant',
    'initial_grant:' || new.id::text
  );

  return new;
end;
$$;

revoke execute on function public.handle_new_user() from public, anon, authenticated;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- -----------------------------------------------------------------------------
-- Privileges and Row Level Security
-- -----------------------------------------------------------------------------

revoke all on table public.wallets from anon, authenticated;
revoke all on table public.wallet_ledger from anon, authenticated;

grant select on table public.wallets to authenticated;
grant select on table public.wallet_ledger to authenticated;

alter table public.wallets enable row level security;
alter table public.wallet_ledger enable row level security;

create policy wallets_select_own
  on public.wallets for select
  to authenticated
  using (user_id = (select auth.uid()));

create policy wallet_ledger_select_own
  on public.wallet_ledger for select
  to authenticated
  using (user_id = (select auth.uid()));

-- Intentionally no INSERT / UPDATE / DELETE policy on either table.
