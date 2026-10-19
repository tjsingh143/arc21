-- =============================================================================
-- Arc 21 — AI Tables: one open request is one table (Astra Refresh C, repair C-2)
-- =============================================================================
--
-- `OPEN_AI_TABLE` used to ignore its `clientRequestId`. Its only replay
-- protection was "the AI table this player is seated at", which is the right
-- answer while that table is live and NO answer once it has closed: the Refresh
-- C audit opened a table, cashed out, re-sent the byte-identical original
-- request, and was answered HTTP 200 with a NEW game (`resumed: false`). A
-- delayed duplicate could therefore reseat a player who had just left, and that
-- seat then blocks entry to every other mode.
--
-- Quick Play has no such gap because its buy-in ledger row IS its request
-- record — unique, written in the table's own transaction, naming the table.
-- An AI table moves no chip and writes no ledger row, so it needs its own
-- record. This is that record and nothing more: who asked, with which request
-- id, and which table that request was answered with.
--
-- It lives in `private` for the reason `private.game_commands` does: no API role
-- holds USAGE on that schema, so there is no client path to it at all. It is
-- written only by `create-session`, as `postgres`, in the transaction that
-- creates the table it names.
--
-- No existing row is touched. AI tables opened before this migration have no
-- record; a replay of one of THOSE requests behaves as it did before (it finds
-- the live table, or opens a new one after closure) — a gap limited to requests
-- already in flight across the deploy, on a mode that has never shipped.
--
-- ONE TRANSACTION, no `commit; begin;` split — see 20261005120000_ai_tables.sql.
-- =============================================================================

create table private.ai_table_open_requests (
  id                 uuid primary key default gen_random_uuid(),

  -- From the verified JWT, never the payload. The same request id under another
  -- account is that account's own request, not a hit on this one.
  user_id            uuid not null references public.profiles (id) on delete cascade,

  client_request_id  uuid not null,

  game_session_id    uuid not null references public.game_sessions (id) on delete cascade,

  created_at         timestamptz not null default now(),

  -- Several requests may name ONE table: the request that opened it, and any
  -- later request answered with it because the player was already seated there
  -- (`resumed: true`). Each is recorded, because a delayed duplicate of a
  -- resuming request is exactly as able to open a new table after closure.
  constraint ai_table_open_requests_once_per_player unique (user_id, client_request_id)
);

-- The cascade from `game_sessions` reads by this column.
create index ai_table_open_requests_game_idx
  on private.ai_table_open_requests (game_session_id);

comment on table private.ai_table_open_requests is
  'OPEN_AI_TABLE idempotency: the table each (player, clientRequestId) was answered with. A replay — '
  'including after the table has closed — is answered with that table and opens nothing. '
  'Server-only: no API role has any privilege on this table or on its schema.';

revoke all on table private.ai_table_open_requests from public;
revoke all on table private.ai_table_open_requests from anon, authenticated, service_role;
alter table private.ai_table_open_requests enable row level security;

do $$
declare
  v_offenders text;
begin
  select string_agg(distinct format('%s->%s(%s)', table_name, grantee, privilege_type), ', ')
  into v_offenders
  from information_schema.role_table_grants
  where table_schema = 'private'
    and table_name = 'ai_table_open_requests'
    and grantee in ('anon', 'authenticated', 'service_role');
  if v_offenders is not null then
    raise exception 'private.ai_table_open_requests has grants to API roles: %', v_offenders;
  end if;
end $$;

select public.assert_client_authorization_surface();
