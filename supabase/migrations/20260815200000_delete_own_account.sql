-- Account deletion.
--
-- Required by the specification and by both app stores. A player must be able
-- to leave and take their data with them, without emailing anyone.
--
-- WHAT IS ERASED, and why it is a hard delete rather than a tombstone: every
-- table holding personal data already cascades from `auth.users` — profile,
-- wallet, ledger, stats, career progress, cosmetics, loadout, push tokens,
-- friendships, requests and blocks. Virtual chips have no value and cannot be
-- redeemed, so there is nothing here that anyone needs to reconcile against a
-- departed account, and keeping a shadow copy of a deleted player's history
-- would be a privacy cost with no corresponding benefit.
--
-- WHAT SURVIVES: `game_sessions`, `game_session_seats` and `hand_players` are
-- `on delete set null`. Those rows are shared history — other people sat at
-- those tables — so the hands remain with the departed seat anonymised rather
-- than deleting a game other players took part in.
--
-- Refusing mid-hand is deliberate. Deleting an account holding a live seat
-- would abandon a table other players are still sitting at, and would strand
-- escrowed chips in a session with no owner. The player is told to leave the
-- table first, which is a two-tap detour and keeps the invariant simple.

create or replace function public.delete_own_account()
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_user_id uuid := auth.uid();
  v_active  int;
begin
  if v_user_id is null then
    raise exception 'deleting an account requires an authenticated session'
      using errcode = '42501';
  end if;

  select count(*)
  into v_active
  from public.game_sessions s
  join public.game_session_seats seat on seat.game_session_id = s.id
  where seat.user_id = v_user_id
    and s.status = 'active';

  if v_active > 0 then
    raise exception
      'leave your table before deleting your account'
      using errcode = 'P0001';
  end if;

  -- One statement. Everything personal cascades from here; anything shared is
  -- set null by its own foreign key, so the policy lives in the schema rather
  -- than in a list of deletes that could drift out of date as tables are added.
  delete from auth.users where id = v_user_id;
end;
$$;

comment on function public.delete_own_account() is
  'Erases the caller''s account. Personal tables cascade; shared game history '
  'is anonymised by set-null. Refuses while the player holds an active seat.';

revoke execute on function public.delete_own_account() from public, anon;
grant execute on function public.delete_own_account() to authenticated;
