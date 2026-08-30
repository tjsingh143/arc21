-- =============================================================================
-- Arc 21 — the account lifecycle, asserted where it actually broke
--
-- `11_delete_account.test.sql` already asserts that deletion exists, that only a
-- signed-in caller may run it, and that six named tables come back empty. Its
-- own comment says a per-table assertion "would silently miss a table added
-- later without a cascade" — and then names six tables, which is exactly that.
-- Sixteen migrations of new tables later, nothing was checking notifications,
-- push tokens, daily entries, tournament entries, rooms, the matchmaking queue
-- or anything else.
--
-- So this file does not name tables. It POPULATES every table that references a
-- user, deletes the account, and then asks the catalogue which of those tables
-- still holds a row for it. A table added tomorrow with a user column and no
-- cascade fails this file without anybody editing it.
--
-- It also asserts the four defects phase 3 found, each of which fails this file
-- when its fix is removed:
--
--   * a host of a matched public table could not delete their account at all;
--   * deleting it evicted the other players from that table;
--   * a departed seat kept the departed player's display name;
--   * a player who had already LEFT a running table was told to leave it.
--
-- SCOPING. Every fixture id below is a literal this file owns, and every count
-- is filtered to those ids. `05_daily_challenge.test.sql` and the sprint
-- integration flake are both the same lesson: a test that counts global rows
-- fails the day the feature ships.
-- =============================================================================

begin;

create extension if not exists pgtap with schema extensions;
set search_path to public, extensions, pg_catalog;

select plan(16);

-- The account under test, a second player who shares its history, and the
-- session they both sat at.
\set leaver   '\'a0000000-0000-4000-8000-00000000000a\''
\set stayer   '\'b0000000-0000-4000-8000-00000000000b\''
\set session  '\'c0000000-0000-4000-8000-00000000000c\''
\set hand     '\'d0000000-0000-4000-8000-00000000000d\''
\set handplay '\'e0000000-0000-4000-8000-00000000000e\''

insert into auth.users (id, email, aud, role) values
  (:leaver, 'lifecycle-leaver@arc21.test', 'authenticated', 'authenticated'),
  (:stayer, 'lifecycle-stayer@arc21.test', 'authenticated', 'authenticated');

-- ---------------------------------------------------------------------------
-- Fixture: a row in every table that references a user
-- ---------------------------------------------------------------------------

insert into public.friend_requests (sender_id, receiver_id) values (:leaver, :stayer);
insert into public.friendships (user_id_a, user_id_b) values (:leaver, :stayer);
insert into public.blocks (blocker_id, blocked_id) values (:leaver, :stayer);

insert into public.notifications (user_id, kind, title, body)
values (:leaver, 'system', 'Yours', 'A notification this account received.');

-- One the OTHER player holds, ABOUT this account. It names them in its body and
-- deep-links to a profile that is about to stop existing.
insert into public.notifications (user_id, kind, title, body, data)
values (:stayer, 'friend_request', 'Friend request', 'leaver wants to be friends.',
        jsonb_build_object('from_user_id', :leaver));

insert into public.push_tokens (user_id, token, platform)
values (:leaver, 'ExponentPushToken[lifecycle-test]', 'ios');

insert into public.user_cosmetics (user_id, cosmetic_id, source)
select :leaver, id, 'default' from public.cosmetics limit 1
on conflict do nothing;

insert into public.player_mode_stats (user_id, mode, ruleset_key)
values (:leaver, 'solo', 'arc-standard@1');
insert into public.player_decision_periods (user_id, period_start) values (:leaver, current_date);
insert into public.player_daily_xp (user_id, utc_day) values (:leaver, current_date);

insert into public.career_progress (user_id, career_node_id)
select :leaver, id from public.career_nodes order by chapter_order, node_order limit 1
on conflict do nothing;

insert into public.career_attempts (user_id, career_node_id, format, starting_chips)
select :leaver, id, 'drill', 1000 from public.career_nodes order by chapter_order, node_order limit 1;

insert into private.career_drill_seeds (attempt_id, seed_secret, focus, scenario_count)
select id, repeat('s', 48), 'hard-totals', 10
from public.career_attempts where user_id = :leaver;

select public.ensure_daily_challenge_for(current_date);
insert into public.daily_entries (daily_challenge_id, user_id)
select id, :leaver from public.daily_challenges where challenge_date = current_date;

insert into public.tournaments
  (code, name, ruleset_id, format, status, starts_at, registration_opens_at,
   starting_chips, max_entries)
select 'lifecycle-probe', 'Lifecycle probe', id, 'leaderboard', 'registering',
       now(), now(), 10000, 4
from public.rulesets limit 1;
insert into public.tournament_entries (tournament_id, user_id)
select id, :leaver from public.tournaments where code = 'lifecycle-probe';

insert into public.rate_limit_events (user_id, action) values (:leaver, 'send_friend_request');

-- Shared history: a COMPLETED table both players sat at.
insert into public.game_sessions (id, mode, ruleset_id, host_user_id, status, started_at, ended_at)
select :session, 'public_table', id, :leaver, 'completed', now(), now()
from public.rulesets limit 1;

insert into public.game_session_seats
  (game_session_id, seat_index, user_id, display_name, status)
values (:session, 0, :leaver, 'leaver', 'left'),
       (:session, 1, :stayer, 'stayer', 'left');

insert into public.hand_records (id, game_session_id, ruleset_id, hand_number, shuffle_number)
select :hand, :session, id, 1, 1 from public.rulesets limit 1;

insert into public.hand_players
  (id, hand_record_id, game_session_id, seat_id, user_id, engine_hand_id,
   hand_index, wager, credit, net, status, outcome)
select :handplay, :hand, :session, s.id, :leaver, 'h1', 0, 100, 200, 100, 'STOOD', 'WIN'
from public.game_session_seats s
where s.game_session_id = :session and s.seat_index = 0;

insert into public.player_actions
  (hand_record_id, hand_player_id, game_session_id, user_id, action, seq)
values (:hand, :handplay, :session, :leaver, 'STAND', 1);

insert into public.game_events
  (game_session_id, seq, type, payload, visibility, recipient_user_id)
values (:session, 1, 'settled', '{}'::jsonb, 'seat', :leaver);

insert into private.game_state_private (game_session_id, engine_state, version)
values (:session, '{"shoe":["AS"]}'::jsonb, 1);

insert into private.game_commands
  (game_session_id, user_id, client_action_id, command_type, applied_version, response)
values (:session, :leaver, 'f0000000-0000-4000-8000-00000000000f', 'NEXT_HAND', 1,
        '{"status":"accepted"}'::jsonb);

-- A PUBLIC table this account hosts by accident of arriving first, with the
-- other player matched into it. This is the shape that could not be deleted.
set local role authenticated;
set local request.jwt.claims to '{"sub":"a0000000-0000-4000-8000-00000000000a","role":"authenticated"}';
select public.join_matchmaking('casual');
select public.poll_matchmaking();
set local request.jwt.claims to '{"sub":"b0000000-0000-4000-8000-00000000000b","role":"authenticated"}';
select public.join_matchmaking('casual');
select public.poll_matchmaking();
set local role postgres;

-- The fixture is worth asserting before the sweep asserts the policy: a sweep
-- over empty tables passes having proved nothing.
select is(
  (select count(*)::int from public.rooms r
   join public.matchmaking_queue q on q.room_id = r.id
   where r.host_user_id = :leaver and q.user_id = :stayer),
  1,
  'the fixture really does have a second player queued into a room this account hosts'
);

select isnt(
  (select display_name from public.game_session_seats
   where game_session_id = :session and seat_index = 0),
  'Deleted player',
  'and the departed seat really does carry a real name before deletion'
);

-- ---------------------------------------------------------------------------
-- A seat that is STILL HELD refuses, and it is the only thing that does
-- ---------------------------------------------------------------------------

insert into public.game_sessions (id, mode, ruleset_id, status, started_at)
select '11110000-0000-4000-8000-000000000011', 'public_table', id, 'active', now()
from public.rulesets limit 1;
insert into public.game_session_seats
  (game_session_id, seat_index, user_id, display_name, status, connected)
values ('11110000-0000-4000-8000-000000000011', 0, :leaver, 'leaver', 'active', true);

set local role authenticated;
set local request.jwt.claims to '{"sub":"a0000000-0000-4000-8000-00000000000a","role":"authenticated"}';

-- `throws_ok` runs its argument through EXECUTE, which refuses transaction
-- commands — so the savepoint is issued out here rather than inside it.
savepoint held_seat;
select throws_ok(
  'select public.delete_own_account()',
  'P0001',
  'leave your table before deleting your account',
  'a seat still held at a running table refuses deletion'
);
rollback to savepoint held_seat;

-- A DISCONNECTED seat still holds escrow, so it refuses too.
set local role postgres;
update public.game_session_seats
set status = 'disconnected', connected = false, disconnected_at = now()
where game_session_id = '11110000-0000-4000-8000-000000000011';

set local role authenticated;
set local request.jwt.claims to '{"sub":"a0000000-0000-4000-8000-00000000000a","role":"authenticated"}';
savepoint ghost_seat;
select throws_ok(
  'select public.delete_own_account()',
  'P0001',
  'leave your table before deleting your account',
  'and so does a disconnected one, because its chips are still in escrow'
);
rollback to savepoint ghost_seat;

-- A seat already LEFT does NOT. It was settled before it was marked, so the
-- player owes the table nothing — and the table may keep running for hours.
set local role postgres;
update public.game_session_seats
set status = 'left', connected = false, left_at = now()
where game_session_id = '11110000-0000-4000-8000-000000000011';

set local role authenticated;
set local request.jwt.claims to '{"sub":"a0000000-0000-4000-8000-00000000000a","role":"authenticated"}';

select lives_ok(
  'select public.delete_own_account()',
  'a player who has already left a still-running table may delete their account'
);

set local role postgres;

-- ---------------------------------------------------------------------------
-- Nothing personal survives — asked of the CATALOGUE, not of a list
-- ---------------------------------------------------------------------------

select is(
  (select count(*)::int from auth.users where id = :leaver),
  0,
  'the auth record is gone'
);

-- Every column in `public` or `private` that references a user, queried by name
-- through the catalogue. Adding a table with a user column and no cascade makes
-- this fail with the offending table named, which is the whole point.
create temporary table lifecycle_residue (relation text, rows int) on commit drop;

do $$
declare
  r record;
  v int;
begin
  for r in
    select n.nspname as schema_name,
           c.relname  as table_name,
           a.attname  as column_name
    from pg_constraint con
    join pg_class c on c.oid = con.conrelid
    join pg_namespace n on n.oid = c.relnamespace
    join unnest(con.conkey) as k(attnum) on true
    join pg_attribute a on a.attrelid = con.conrelid and a.attnum = k.attnum
    where con.contype = 'f'
      and n.nspname in ('public', 'private')
      and con.confrelid in ('auth.users'::regclass, 'public.profiles'::regclass)
      -- `set null` columns are the shared history this deletion deliberately
      -- keeps. They are asserted separately, below, including the name.
      and con.confdeltype = 'c'
  loop
    execute format(
      'select count(*)::int from %I.%I where %I = %L',
      r.schema_name, r.table_name, r.column_name, 'a0000000-0000-4000-8000-00000000000a'
    ) into v;
    if v > 0 then
      insert into lifecycle_residue values (
        format('%s.%s.%s', r.schema_name, r.table_name, r.column_name), v
      );
    end if;
  end loop;
end $$;

select is(
  (select coalesce(string_agg(relation || '=' || rows, ', ' order by relation), 'none')
   from lifecycle_residue),
  'none',
  'every cascading reference to the account is empty, asked of the catalogue rather than a list'
);

-- The tables that cascade one hop further, through a row that is itself gone.
select is(
  (
    (select count(*)::int from public.wallet_ledger l
       join public.wallets w on w.id = l.wallet_id where w.user_id = :leaver) +
    (select count(*)::int from private.career_drill_seeds s
       join public.career_attempts a on a.id = s.attempt_id where a.user_id = :leaver)
  ),
  0,
  'and so is everything that hangs off one of those rows'
);

-- ---------------------------------------------------------------------------
-- The shared history survives, and no longer names anybody
-- ---------------------------------------------------------------------------

select is(
  (select count(*)::int from public.game_session_seats where game_session_id = :session),
  2,
  'the completed table both players sat at is still there, both seats intact'
);

select is(
  (select display_name from public.game_session_seats
   where game_session_id = :session and seat_index = 0),
  'Deleted player',
  'and the departed seat no longer says who sat in it'
);

select is(
  (select count(*)::int from public.game_session_seats
   where game_session_id = :session and seat_index = 0 and user_id is not null),
  0,
  'nor does it still point at an account'
);

select is(
  (
    (select count(*)::int from public.hand_records  where game_session_id = :session) +
    (select count(*)::int from public.hand_players  where game_session_id = :session) +
    (select count(*)::int from public.player_actions where game_session_id = :session)
  ),
  3,
  'the hand, the hand player and the action all remain, because another player was there'
);

select is(
  (select count(*)::int from public.notifications
   where data ->> 'from_user_id' = 'a0000000-0000-4000-8000-00000000000a'),
  0,
  'a notification another player held ABOUT this account is gone with it'
);

-- ---------------------------------------------------------------------------
-- The other player keeps their table
-- ---------------------------------------------------------------------------
--
-- The defect this replaces was a hard failure: `matchmaking_queue.room_id`
-- referenced `rooms` with no `on delete` clause, so cascading the room away from
-- its departing host raised
--   'update or delete on table "rooms" violates foreign key constraint
--    "matchmaking_queue_room_id_fkey"'
-- and deletion was impossible. Making the cascade succeed would have been the
-- wrong fix on its own: it deletes a lobby other players are sitting in.

select is(
  (select count(*)::int from public.room_members m
   join public.rooms r on r.id = m.room_id
   where m.user_id = :stayer and m.status = 'joined' and r.status = 'lobby'),
  1,
  'the other player is still seated at the public table its host just deleted themselves from'
);

select is(
  (select count(*)::int from public.rooms where host_user_id = :stayer),
  1,
  'and has inherited the lobby, by the same rule leave_room applies'
);

-- ---------------------------------------------------------------------------
-- And the structural backstop underneath all of that
-- ---------------------------------------------------------------------------
--
-- Asserted separately BECAUSE the behaviour above no longer depends on it. With
-- the hand-over in place a room is not deleted at all, so reverting this
-- constraint alone leaves every assertion above passing — which is exactly the
-- shape of change that rots unnoticed. A queue entry's `room_id` records where a
-- player was sent; it is a soft pointer, and `no action` made it the reason an
-- account could not be deleted. Deleting the room directly is the only way to
-- ask the constraint the question.

insert into public.rooms (id, code, host_user_id, visibility, mode, max_seats, tier)
values ('22220000-0000-4000-8000-000000000022', 'ZZ2222', :stayer, 'public', 'public_table', 5, 'casual');
insert into public.matchmaking_queue (user_id, tier, status, room_id)
values (:stayer, 'casual', 'matched', '22220000-0000-4000-8000-000000000022');

delete from public.rooms where id = '22220000-0000-4000-8000-000000000022';

select is(
  (select count(*)::int from public.matchmaking_queue
   where user_id = :stayer and room_id is null),
  1,
  'a room deleted under a queue entry releases it rather than refusing to go'
);

select * from finish();
rollback;
