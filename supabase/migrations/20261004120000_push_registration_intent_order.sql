-- =============================================================================
-- Arc 21 — a device's push registration keeps its NEWEST intent (Refresh-B B-H4)
--
-- `push_tokens` is keyed by TOKEN: one row per device, holding whose device it
-- is, the kinds that device's Settings allow, and whether it is active. Every
-- write to that row came from one device, and the device wrote them one at a
-- time (the device lane in `src/lib/notifications/push.ts`). That was taken to
-- mean the last write the device MADE was the last write the database KEPT.
--
-- It does not. The final independent audit reproduced it against the real
-- PostgREST: "Your turn" ON was sent, a proxy accepted the whole request and
-- kept its work queued, then dropped the client connection. The device saw a
-- failure, its lane moved on, "Your turn" OFF was written and acknowledged —
-- and the queued ON then reached Postgres and committed AFTER it. Memory OFF,
-- disk OFF, database ON. A connection's failure is not the failure of work the
-- server already accepted, and nothing on the device can order work that has
-- already left it.
--
-- So the order travels WITH the write. Each registration and retirement carries
-- an intent revision the device allocates, in the order it makes them, from a
-- counter it persists before sending (`push.ts`). The row remembers the newest
-- revision it applied and takes a write only if it is newer:
--
--   newer   applied; the row now holds this intent
--   equal   the same intent arriving twice — a retry after a lost reply — and
--           already applied: a no-op that reports the row's revision
--   older   an obsolete intent that outlived its connection: refused, no-op
--
-- OWNERSHIP. The order is per TOKEN, i.e. per device, because that is what the
-- product promises: Settings are device-local, and one phone's opt-out is not a
-- statement about another phone's separate token. Two devices of one account
-- never share a row, so they cannot defeat each other. A change of player on one
-- device is a write from that device like any other — the next player's
-- registration carries a higher revision than the departed player's last write,
-- so a departed player's stale registration can no longer take the device back.
--
-- Not changed: grants and RLS (`push_tokens` keeps exactly the client grants
-- `20260813121100` gave it), the per-account ceiling and its eviction rule
-- (`20260905120000`), the sender, and the payload rules.
-- =============================================================================

alter table public.push_tokens
  add column intent_revision bigint not null default 0
    check (intent_revision >= 0);

comment on column public.push_tokens.intent_revision is
  'The newest device intent applied to this row (B-H4). A registration or retirement is applied only '
  'if its revision is greater; an equal one is the same intent replayed; an older one is obsolete.';

-- -----------------------------------------------------------------------------
-- Registration
-- -----------------------------------------------------------------------------

-- A changed argument list is a new function, not a replacement: the old arity
-- would survive beside it, and every unordered caller with it.
drop function public.register_push_token(text, public.push_platform, text, public.notification_kind[]);

-- Body from `20260905120000_bounded_client_reads.sql`, the LAST migration to
-- define it — the eviction included — with the intent order added.
create function public.register_push_token(
  p_token     text,
  p_platform  public.push_platform,
  p_device_id text,
  p_kinds     public.notification_kind[],
  p_revision  bigint
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_me      uuid := auth.uid();
  v_applied boolean;
  v_current bigint;
begin
  if v_me is null then
    raise exception 'registering a device requires an authenticated session' using errcode = '42501';
  end if;
  if p_token is null or char_length(p_token) < 8 or char_length(p_token) > 512 then
    raise exception 'that does not look like a push token' using errcode = 'P0001';
  end if;
  if p_revision is null or p_revision < 1 then
    raise exception 'a device registration must carry its intent revision' using errcode = '22023';
  end if;

  /*
   * One statement decides. `on conflict … do update … where` locks the
   * device's row and evaluates the comparison against its latest committed
   * version, so two writes racing for one device are ordered by revision, not
   * by which commits last.
   */
  insert into public.push_tokens (user_id, token, platform, device_id, allowed_kinds, is_active, intent_revision)
  values (v_me, p_token, p_platform, p_device_id, coalesce(p_kinds, '{}'), true, p_revision)
  on conflict (token) do update
    set user_id         = v_me,
        platform        = excluded.platform,
        device_id       = excluded.device_id,
        allowed_kinds   = excluded.allowed_kinds,
        is_active       = true,
        last_used_at    = now(),
        intent_revision = excluded.intent_revision
    where public.push_tokens.intent_revision < excluded.intent_revision
  returning true into v_applied;

  if v_applied is null then
    -- An equal or newer intent is already this device's. Nothing changed, so
    -- nothing to evict either.
    select t.intent_revision into v_current from public.push_tokens t where t.token = p_token;
    return jsonb_build_object('applied', false, 'revision', v_current);
  end if;

  /*
   * Evict, never refuse — unchanged from `20260905120000`, where the reason for
   * `t.token <> p_token` is recorded: the registration just written must never
   * be the one evicted.
   */
  delete from public.push_tokens t
  where t.user_id = v_me
    and t.token <> p_token
    and t.id not in (
      select id from public.push_tokens
      where user_id = v_me
        and token <> p_token
      order by last_used_at desc, created_at desc, id desc
      limit greatest(public.push_tokens_per_account_maximum() - 1, 0)
    );

  return jsonb_build_object('applied', true, 'revision', p_revision);
end;
$$;

comment on function public.register_push_token(text, public.push_platform, text, public.notification_kind[], bigint) is
  'Registers this device, if this intent is newer than the last one applied to its token (B-H4). '
  'An account holds at most push_tokens_per_account_maximum() registrations; the least recently used '
  'is retired rather than the new one refused. Returns {applied, revision}.';

-- -----------------------------------------------------------------------------
-- Retirement
-- -----------------------------------------------------------------------------

drop function public.retire_push_token(text);

-- Body from `20260817400000_notification_delivery.sql`, the LAST migration to
-- define it, with the intent order added. Still confined to the caller's own
-- row: a departed player's retirement can never touch the next player's.
create function public.retire_push_token(p_token text, p_revision bigint)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_me      uuid := auth.uid();
  v_applied boolean;
  v_current bigint;
begin
  if v_me is null then
    raise exception 'retiring a device requires an authenticated session' using errcode = '42501';
  end if;
  if p_revision is null or p_revision < 1 then
    raise exception 'a device retirement must carry its intent revision' using errcode = '22023';
  end if;

  update public.push_tokens
  set is_active = false, allowed_kinds = '{}', last_used_at = now(), intent_revision = p_revision
  where user_id = v_me and token = p_token and intent_revision < p_revision
  returning true into v_applied;

  if v_applied is null then
    -- Not the caller's row, nothing to retire, or a newer intent already holds
    -- it. The revision is reported only for the caller's own row.
    select t.intent_revision into v_current from public.push_tokens t where t.token = p_token and t.user_id = v_me;
    return jsonb_build_object('applied', false, 'revision', v_current);
  end if;

  return jsonb_build_object('applied', true, 'revision', p_revision);
end;
$$;

comment on function public.retire_push_token(text, bigint) is
  'Deactivates the caller''s own registration of this device, if this intent is newer than the last '
  'one applied to its token (B-H4). Returns {applied, revision}.';

-- -----------------------------------------------------------------------------
-- Privileges: exactly what the replaced functions had
-- -----------------------------------------------------------------------------

revoke execute on function
  public.register_push_token(text, public.push_platform, text, public.notification_kind[], bigint),
  public.retire_push_token(text, bigint)
from public, anon;

grant execute on function
  public.register_push_token(text, public.push_platform, text, public.notification_kind[], bigint),
  public.retire_push_token(text, bigint)
to authenticated;

-- A migration that changes a grant asks the gate as its last line.
select public.assert_client_authorization_surface();
