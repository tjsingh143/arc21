-- =============================================================================
-- Arc 21 — progression is not client-writable
--
-- `level` and `xp` decide table access and cosmetic unlocks, so they are the
-- obvious target for a modified client. They are protected twice: the client
-- role has no UPDATE privilege on those two columns, and a guard trigger
-- refuses the change even if that privilege is later granted by mistake.
-- =============================================================================

begin;

create extension if not exists pgtap with schema extensions;
set search_path to public, extensions, pg_catalog;

select plan(18);

insert into auth.users (id, email) values
  ('00000000-0000-4000-8000-00000000000a', 'alice@arc21.test'),
  ('00000000-0000-4000-8000-00000000000b', 'bob@arc21.test');

-- -----------------------------------------------------------------------------
-- The privilege layer
-- -----------------------------------------------------------------------------

select ok(
  not has_column_privilege('authenticated', 'public.profiles', 'level', 'UPDATE'),
  'authenticated holds no UPDATE privilege on profiles.level'
);

select ok(
  not has_column_privilege('authenticated', 'public.profiles', 'xp', 'UPDATE'),
  'authenticated holds no UPDATE privilege on profiles.xp'
);

select ok(
  has_column_privilege('authenticated', 'public.profiles', 'display_name', 'UPDATE'),
  'authenticated may still update its own display name'
);

set local role authenticated;
set local request.jwt.claims to
  '{"sub":"00000000-0000-4000-8000-00000000000a","role":"authenticated"}';

select lives_ok(
  $$ update public.profiles set display_name = 'Alicia'
     where id = '00000000-0000-4000-8000-00000000000a' $$,
  'a user may rename themselves'
);

select is(
  (select display_name from public.profiles
   where id = '00000000-0000-4000-8000-00000000000a'),
  'Alicia',
  'the rename took effect'
);

select throws_ok(
  $$ update public.profiles set level = 99
     where id = '00000000-0000-4000-8000-00000000000a' $$,
  '42501', null,
  'a user cannot raise their own level'
);

select throws_ok(
  $$ update public.profiles set xp = 1000000
     where id = '00000000-0000-4000-8000-00000000000a' $$,
  '42501', null,
  'a user cannot award themselves xp'
);

-- Hiding the protected column among permitted ones changes nothing.
select throws_ok(
  $$ update public.profiles set display_name = 'Alicia', level = 42
     where id = '00000000-0000-4000-8000-00000000000a' $$,
  '42501', null,
  'smuggling level alongside a permitted column is still rejected'
);

select throws_ok(
  $$ insert into public.profiles (id, username, display_name)
     values ('00000000-0000-4000-8000-0000000000cc', 'forged', 'Forged') $$,
  '42501', null,
  'a user cannot insert a profile row'
);

select throws_ok(
  $$ delete from public.profiles
     where id = '00000000-0000-4000-8000-00000000000a' $$,
  '42501', null,
  'a user cannot delete a profile row'
);

-- Another player's profile is not writable. The attempt is silent rather than
-- an error: RLS simply matches no row.
select lives_ok(
  $$ update public.profiles set display_name = 'Owned'
     where id = '00000000-0000-4000-8000-00000000000b' $$,
  'renaming another player raises no error'
);

reset role;

select isnt(
  (select display_name from public.profiles
   where id = '00000000-0000-4000-8000-00000000000b'),
  'Owned',
  'the other profile is untouched'
);

-- -----------------------------------------------------------------------------
-- With the column privilege granted by mistake, the trigger still holds
-- -----------------------------------------------------------------------------

grant update (level, xp) on public.profiles to authenticated;

set local role authenticated;
set local request.jwt.claims to
  '{"sub":"00000000-0000-4000-8000-00000000000a","role":"authenticated"}';

select throws_ok(
  $$ update public.profiles set level = 99
     where id = '00000000-0000-4000-8000-00000000000a' $$,
  '42501', null,
  'with UPDATE(level) granted, the guard trigger still refuses'
);

select throws_ok(
  $$ update public.profiles set xp = 1000000
     where id = '00000000-0000-4000-8000-00000000000a' $$,
  '42501', null,
  'with UPDATE(xp) granted, the guard trigger still refuses'
);

reset role;

revoke update (level, xp) on public.profiles from authenticated;

select is(
  (select level from public.profiles
   where id = '00000000-0000-4000-8000-00000000000a'),
  1,
  'the level never moved'
);

-- -----------------------------------------------------------------------------
-- The server can still award progression
-- -----------------------------------------------------------------------------

select lives_ok(
  $$ update public.profiles set xp = 1200
     where id = '00000000-0000-4000-8000-00000000000a' $$,
  'a server role may award xp'
);

-- `level` is DERIVED, not awarded.
--
-- This assertion used to set `level = 5` alongside the XP and check that the 5
-- was stored — which passed only because nothing recomputed the column. It now
-- does: `shared/progression/xp.ts` says total XP is the stored truth and the level
-- follows from it, and a trigger makes that true in the database. 1,200 XP buys
-- level 7 on the published curve, so writing 5 there would have been storing a
-- figure that disagreed with the player's own XP.
select is(
  (select level from public.profiles
   where id = '00000000-0000-4000-8000-00000000000a'),
  public.level_from_total_xp(1200),
  'the level is derived from the awarded xp rather than stored separately'
);

select is(
  public.level_from_total_xp(1200),
  7,
  'and 1,200 XP is level 7 on the published curve'
);

select * from finish();

rollback;
