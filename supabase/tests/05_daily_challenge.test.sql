-- =============================================================================
-- Arc 21 — the daily challenge seed is as secret as the shoe it produces
--
-- Every player faces the identical shoe, generated from `seed_secret` by
-- `CounterStreamRandomSource`. Reading that value during the challenge is
-- equivalent to reading the shoe, so it is removed from the client's column
-- privileges entirely. `seed_commitment` — its published SHA-256 — stays
-- readable so the shoe can be verified after the fact.
-- =============================================================================

begin;

create extension if not exists pgtap with schema extensions;
set search_path to public, extensions, pg_catalog;

select plan(18);

-- This file mints its OWN challenges, and a real one for today may already exist:
-- `ensure_daily_challenge_for` creates today's row the first time anyone opens the
-- screen. The fixtures below therefore sit on dates a live challenge will not
-- occupy, and their open/close windows are set relative to `now()` rather than to
-- their own date — every assertion here is about the privilege layer and the
-- `opens_at <= now()` policy, never about which calendar day it is. An earlier
-- version used today's date and collided the moment the mode became playable.
insert into auth.users (id, email)
values ('00000000-0000-4000-8000-00000000000a', 'alice@arc21.test');

-- Live challenge.
insert into public.daily_challenges (
  challenge_date, ruleset_id, seed_secret, seed_commitment,
  hand_count, starting_chips, opens_at, closes_at
)
select
  (current_date + 400), r.id, s.secret,
  encode(extensions.digest(s.secret, 'sha256'), 'hex'),
  25, 5000, now() - interval '1 hour', now() + interval '23 hours'
from public.rulesets r,
     (select repeat('a', 64) as secret) s
where r.ruleset_key = 'arc-standard@1';

-- Tomorrow's challenge, already minted but not yet open.
insert into public.daily_challenges (
  challenge_date, ruleset_id, seed_secret, seed_commitment,
  hand_count, starting_chips, opens_at, closes_at
)
select
  (current_date + 401), r.id, s.secret,
  encode(extensions.digest(s.secret, 'sha256'), 'hex'),
  25, 5000, now() + interval '23 hours', now() + interval '47 hours'
from public.rulesets r,
     (select repeat('b', 64) as secret) s
where r.ruleset_key = 'arc-standard@1';

-- -----------------------------------------------------------------------------
-- The privilege layer
-- -----------------------------------------------------------------------------

select ok(
  not has_column_privilege('authenticated', 'public.daily_challenges', 'seed_secret', 'SELECT'),
  'authenticated cannot select daily_challenges.seed_secret'
);

select ok(
  not has_column_privilege('anon', 'public.daily_challenges', 'seed_secret', 'SELECT'),
  'anon cannot select daily_challenges.seed_secret'
);

select ok(
  has_column_privilege('authenticated', 'public.daily_challenges', 'seed_commitment', 'SELECT'),
  'authenticated can select the published seed commitment'
);

select hasnt_column(
  'public', 'daily_challenges_public', 'seed_secret',
  'the client-facing view does not carry the seed at all'
);

set local role authenticated;
set local request.jwt.claims to
  '{"sub":"00000000-0000-4000-8000-00000000000a","role":"authenticated"}';

select throws_ok(
  $$ select seed_secret from public.daily_challenges $$,
  '42501', null,
  'a client cannot read the daily challenge seed'
);

-- `select *` expands to every column, including the one it may not read.
select throws_ok(
  $$ select * from public.daily_challenges $$,
  '42501', null,
  'select * over the challenge table is rejected rather than silently trimmed'
);

select lives_ok(
  $$ select seed_commitment from public.daily_challenges $$,
  'the published commitment is readable'
);

-- Counted among THIS file's own fixtures. A global count reports whatever real
-- challenges the database happens to hold — today's, minted the first time anyone
-- opened the screen — which is how this assertion first read 2 where it wanted 1.
-- The property under test is the `opens_at <= now()` policy, and that is visible
-- just as clearly within a known pair.
select is(
  (select count(*) from public.daily_challenges_public
   where challenge_date in (
     (current_date + 400),
     (current_date + 401)
   )),
  1::bigint,
  'of this test''s two challenges, only the one that has opened is visible'
);

reset role;

-- -----------------------------------------------------------------------------
-- The commitment must actually commit
-- -----------------------------------------------------------------------------

select throws_ok(
  $$ insert into public.daily_challenges (
       challenge_date, ruleset_id, seed_secret, seed_commitment,
       hand_count, starting_chips, opens_at, closes_at
     )
     select (current_date + 402), r.id, repeat('c', 64), repeat('0', 64),
            25, 5000, now(), now() + interval '1 day'
     from public.rulesets r where r.ruleset_key = 'arc-standard@1' $$,
  '23514', null,
  'a challenge whose commitment is not the hash of its seed is rejected'
);

select throws_ok(
  $$ update public.daily_challenges
     set revealed_seed = seed_secret, seed_revealed_at = now()
     where challenge_date = (current_date + 400) $$,
  '42501', null,
  'the seed cannot be revealed while the challenge is still running'
);

-- A challenge that has closed may be revealed for public verification.
insert into public.daily_challenges (
  challenge_date, ruleset_id, seed_secret, seed_commitment,
  hand_count, starting_chips, opens_at, closes_at
)
select
  (current_date + 399), r.id, s.secret,
  encode(extensions.digest(s.secret, 'sha256'), 'hex'),
  25, 5000, now() - interval '2 days', now() - interval '1 day'
from public.rulesets r,
     (select repeat('d', 64) as secret) s
where r.ruleset_key = 'arc-standard@1';

select throws_ok(
  $$ update public.daily_challenges
     set revealed_seed = repeat('z', 64), seed_revealed_at = now()
     where challenge_date = (current_date + 399) $$,
  '23514', null,
  'a reveal that does not match the stored seed is rejected'
);

select lives_ok(
  $$ update public.daily_challenges
     set revealed_seed = seed_secret, seed_revealed_at = now()
     where challenge_date = (current_date + 399) $$,
  'a closed challenge may publish its seed'
);

select is(
  (
    select encode(extensions.digest(revealed_seed, 'sha256'), 'hex') = seed_commitment
    from public.daily_challenges
    where challenge_date = (current_date + 399)
  ),
  true,
  'the revealed seed hashes to the commitment published before play began'
);

-- -----------------------------------------------------------------------------
-- Somebody has to actually publish it
-- -----------------------------------------------------------------------------
--
-- THE DEFECT THIS CLOSES. Everything above held for the whole life of the
-- feature and nothing in the product ever wrote `revealed_seed`: the column, the
-- trigger, the client projection, the parser and the render branch all existed,
-- and no code path outside this file had ever set it. So the commitment could
-- never be checked by anybody, while the Daily screen told the player in so many
-- words that it could be. `reveal_closed_daily_seeds` is the missing half, and
-- `ensure_todays_daily_challenge` calls it, so opening the screen publishes
-- every seed whose window has closed.

-- Undo this file's own reveal so the function has something to do, and so the
-- count below is about the function rather than about the update above.
update public.daily_challenges
set revealed_seed = null, seed_revealed_at = null
where challenge_date = (current_date + 399);

select is(
  (select public.reveal_closed_daily_seeds() >= 1),
  true,
  'the reveal publishes a challenge whose window has closed'
);

select is(
  (select revealed_seed = seed_secret from public.daily_challenges
   where challenge_date = (current_date + 399)),
  true,
  'and what it published is the seed the commitment was made from'
);

select is(
  (select revealed_seed from public.daily_challenges
   where challenge_date = (current_date + 400)),
  null,
  'while a challenge still RUNNING keeps its seed, which is the whole point'
);

select is(
  (select challenge_date from public.latest_verifiable_daily_challenge()),
  (select max(challenge_date) from public.daily_challenges where revealed_seed is not null),
  'the fairness view names the most recently published challenge'
);

select is(
  (select count(*)::int from public.latest_verifiable_daily_challenge()
   where revealed_seed is null),
  0,
  'and never returns a row whose seed has not been published'
);

select * from finish();

rollback;
