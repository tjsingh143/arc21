-- =============================================================================
-- Arc 21 — game visibility follows the seat, not the room code
--
-- A participant reads the sanitised public event stream. A seat-scoped event
-- reaches only its recipient. A non-participant reads nothing at all, and
-- knowing the session id does not change that: a room code is an address, never
-- an authorisation.
-- =============================================================================

begin;

create extension if not exists pgtap with schema extensions;
set search_path to public, extensions, pg_catalog;

select plan(16);

insert into auth.users (id, email) values
  ('00000000-0000-4000-8000-00000000000a', 'alice@arc21.test'),
  ('00000000-0000-4000-8000-00000000000b', 'bob@arc21.test'),
  ('00000000-0000-4000-8000-00000000000c', 'carol@arc21.test');

insert into public.game_sessions (id, mode, ruleset_id, tier, room_code, status, started_at)
select '00000000-0000-4000-8000-0000000005e5', 'private_table', r.id, 'standard',
       'K7M4PJ', 'active', now()
from public.rulesets r where r.ruleset_key = 'arc-standard@1';

insert into public.game_session_seats (game_session_id, seat_index, user_id, display_name, stack)
values
  ('00000000-0000-4000-8000-0000000005e5', 0, '00000000-0000-4000-8000-00000000000a', 'Alice', 5000),
  ('00000000-0000-4000-8000-0000000005e5', 1, '00000000-0000-4000-8000-00000000000b', 'Bob',   5000);

insert into public.game_events
  (game_session_id, seq, type, payload, visibility, recipient_user_id, hand_number)
values
  ('00000000-0000-4000-8000-0000000005e5', 1, 'BETTING_OPENED',
   '{"handNumber": 1}'::jsonb, 'public', null, 1),
  ('00000000-0000-4000-8000-0000000005e5', 2, 'TURN_STARTED',
   '{"seatId": "0", "handId": "h1"}'::jsonb, 'seat',
   '00000000-0000-4000-8000-00000000000a', 1);

insert into public.hand_records
  (id, game_session_id, ruleset_id, hand_number, dealer_cards, dealer_total, completed_at)
select '00000000-0000-4000-8000-000000000a01', '00000000-0000-4000-8000-0000000005e5',
       r.id, 1,
       '[{"id":"d1","rank":"10","suit":"S","deckIndex":0},
         {"id":"d2","rank":"7","suit":"H","deckIndex":0}]'::jsonb,
       17, now()
from public.rulesets r where r.ruleset_key = 'arc-standard@1';

insert into public.hand_players
  (id, hand_record_id, game_session_id, user_id, engine_hand_id, cards,
   wager, credit, net, status, outcome, best_total)
values
  ('00000000-0000-4000-8000-000000000b01',
   '00000000-0000-4000-8000-000000000a01', '00000000-0000-4000-8000-0000000005e5',
   '00000000-0000-4000-8000-00000000000a', 'h1', '[]'::jsonb,
   100, 200, 100, 'STOOD', 'WIN', 19),
  ('00000000-0000-4000-8000-000000000b02',
   '00000000-0000-4000-8000-000000000a01', '00000000-0000-4000-8000-0000000005e5',
   '00000000-0000-4000-8000-00000000000b', 'h2', '[]'::jsonb,
   100, 0, -100, 'BUSTED', 'BUST', 23);

insert into public.player_actions
  (hand_player_id, hand_record_id, game_session_id, user_id, seq, action)
values
  ('00000000-0000-4000-8000-000000000b01', '00000000-0000-4000-8000-000000000a01',
   '00000000-0000-4000-8000-0000000005e5', '00000000-0000-4000-8000-00000000000a', 1, 'STAND'),
  ('00000000-0000-4000-8000-000000000b02', '00000000-0000-4000-8000-000000000a01',
   '00000000-0000-4000-8000-0000000005e5', '00000000-0000-4000-8000-00000000000b', 1, 'HIT');

-- -----------------------------------------------------------------------------
-- Alice, a seated participant
-- -----------------------------------------------------------------------------

set local role authenticated;
set local request.jwt.claims to
  '{"sub":"00000000-0000-4000-8000-00000000000a","role":"authenticated"}';

select is(
  (select count(*) from public.game_sessions),
  1::bigint,
  'a participant can see the session they are seated in'
);

select is(
  (select count(*) from public.game_events),
  2::bigint,
  'a participant sees the public stream plus events addressed to them'
);

select is(
  (select count(*) from public.hand_records),
  1::bigint,
  'a participant can read the hand history of their table'
);

select is(
  (select count(*) from public.hand_players),
  2::bigint,
  'a participant can see every settled hand at their table'
);

select is(
  (select count(*) from public.player_actions),
  1::bigint,
  'a participant sees only their own decisions, not those of other players'
);

select throws_ok(
  $$ insert into public.game_events (game_session_id, seq, type, payload)
     values ('00000000-0000-4000-8000-0000000005e5', 99, 'HAND_SETTLED', '{}'::jsonb) $$,
  '42501', null,
  'a participant cannot append to the event stream'
);

select throws_ok(
  $$ update public.game_sessions set version = 999 $$,
  '42501', null,
  'a participant cannot advance the session version'
);

select throws_ok(
  $$ update public.game_session_seats set stack = 999999 $$,
  '42501', null,
  'a participant cannot top up their own table stack'
);

reset role;

-- -----------------------------------------------------------------------------
-- Bob, also seated, but not the recipient of the seat-scoped event
-- -----------------------------------------------------------------------------

set local role authenticated;
set local request.jwt.claims to
  '{"sub":"00000000-0000-4000-8000-00000000000b","role":"authenticated"}';

select is(
  (select count(*) from public.game_events),
  1::bigint,
  'another participant sees only the public events'
);

select is_empty(
  $$ select 1 from public.game_events where visibility = 'seat' $$,
  'a seat-scoped event is invisible to the other players at the table'
);

select is(
  (select count(*) from public.player_actions),
  1::bigint,
  'decision history is private even between players at the same table'
);

reset role;

-- -----------------------------------------------------------------------------
-- Carol, who knows the room code but holds no seat
-- -----------------------------------------------------------------------------

set local role authenticated;
set local request.jwt.claims to
  '{"sub":"00000000-0000-4000-8000-00000000000c","role":"authenticated"}';

select is_empty(
  $$ select 1 from public.game_sessions where room_code = 'K7M4PJ' $$,
  'knowing the room code does not make a stranger a participant'
);

select is_empty(
  $$ select 1 from public.game_events $$,
  'a non-participant reads no events'
);

select is_empty(
  $$ select 1 from public.hand_players $$,
  'a non-participant reads no hand history'
);

reset role;

-- -----------------------------------------------------------------------------
-- Server-side invariants
-- -----------------------------------------------------------------------------

select throws_ok(
  $$ insert into public.hand_records
       (game_session_id, ruleset_id, hand_number, dealer_cards)
     select '00000000-0000-4000-8000-0000000005e5', r.id, 2,
            '[{"id":"d9","rank":"A","suit":"S","deckIndex":0}]'::jsonb
     from public.rulesets r where r.ruleset_key = 'arc-standard@1' $$,
  '23514', null,
  'a dealer card cannot be archived before the hand is complete'
);

update public.game_sessions set escrow_chips = 10000
where id = '00000000-0000-4000-8000-0000000005e5';

select throws_ok(
  $$ delete from public.game_sessions
     where id = '00000000-0000-4000-8000-0000000005e5' $$,
  '23514', null,
  'a session holding wallet escrow cannot be deleted'
);

select * from finish();

rollback;
