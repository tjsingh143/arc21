-- Reading your own blocks back.
--
-- `block_player` and `unblock_player` have both existed since
-- 20260816100000_friends.sql, but nothing could list the blocks — so from
-- inside the app a block was permanent, and the profile screen had to say so.
-- This is the missing half of an action that is presented as a safety tool.
--
-- It returns ONLY rows where the caller is the blocker. A function that also
-- reported who blocked *you* would turn a silent, one-directional control into
-- a notification: every other function in the friend graph answers "no such
-- player" precisely so that a block is never disclosed to the person blocked,
-- and one leaking read here would undo all of them.

create or replace function public.list_blocked()
returns table (
  id uuid,
  username text,
  display_name text,
  blocked_at timestamptz
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
    raise exception 'listing blocked players requires an authenticated session' using errcode = '42501';
  end if;

  return query
  -- `p.username::text` is not decoration. `return query` demands the column
  -- types match the declared ones exactly, and a `username` that is citext
  -- rather than text fails at run time — citext is not on this function's
  -- search_path — while typechecking and every test still pass. Every function
  -- in 20260816100000_friends.sql casts here for the same reason.
  select p.id, p.username::text, p.display_name, b.created_at
  from public.blocks b
  join public.profiles p on p.id = b.blocked_id
  where b.blocker_id = v_me
  -- Most recently blocked first: the person a player has come here to unblock
  -- is almost always the one they blocked last.
  order by b.created_at desc;
end;
$$;

comment on function public.list_blocked() is
  'The caller''s own blocks. Never who blocked the caller — a block is never disclosed to the person blocked.';

-- ---------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------
-- Argument-free, and the caller comes from the session, so there is no
-- spelling of this that reads somebody else's blocks.

revoke execute on function public.list_blocked() from public, anon;
grant execute on function public.list_blocked() to authenticated;
