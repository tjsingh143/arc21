-- =============================================================================
-- Arc 21 — seeded catalogue
--
-- The ruleset row must stay identical to ARC_STANDARD_RULES in
-- shared/blackjack/rules.ts. If someone edits one without the other, strategy
-- advice and server settlement start disagreeing, which is the quietest and
-- worst kind of bug this product can have.
-- =============================================================================

begin;

create extension if not exists pgtap with schema extensions;
set search_path to public, extensions, pg_catalog;

select plan(22);

-- -----------------------------------------------------------------------------
-- The Arc Standard ruleset
-- -----------------------------------------------------------------------------

select is(
  (select count(*) from public.rulesets),
  1::bigint,
  'exactly one ruleset is seeded'
);

select is(
  (select ruleset_key from public.rulesets),
  'arc-standard@1',
  'the seeded ruleset key is arc-standard@1'
);

select is(
  (select (rules ->> 'deckCount')::int from public.rulesets),
  6,
  'six decks'
);

select is(
  (select (rules ->> 'dealerHitsSoft17')::boolean from public.rulesets),
  false,
  'the dealer stands on all 17'
);

select is(
  (select (rules ->> 'dealerHoleCard')::boolean from public.rulesets),
  true,
  'American hole card'
);

select is(
  (select (rules ->> 'dealerPeeksForBlackjack')::boolean from public.rulesets),
  true,
  'the dealer peeks for blackjack'
);

select is(
  (
    select (rules ->> 'blackjackPayoutNumerator') || ':' ||
           (rules ->> 'blackjackPayoutDenominator')
    from public.rulesets
  ),
  '3:2',
  'a natural pays 3:2'
);

select is(
  (
    select (rules ->> 'insuranceFractionNumerator') || '/' ||
           (rules ->> 'insuranceFractionDenominator') || ' at ' ||
           (rules ->> 'insurancePayoutNumerator') || ':' ||
           (rules ->> 'insurancePayoutDenominator')
    from public.rulesets
  ),
  '1/2 at 2:1',
  'insurance is half the stake and pays 2:1'
);

select is(
  (select (rules ->> 'lateSurrenderAllowed')::boolean from public.rulesets),
  true,
  'late surrender is allowed'
);

select is(
  (select (rules ->> 'doubleAfterSplit')::boolean from public.rulesets),
  true,
  'double after split is allowed'
);

select is(
  (select rules ->> 'splitPolicy' from public.rulesets),
  'same_value',
  'splitting is by equal value, so a king and a queen qualify'
);

select is(
  (select (rules ->> 'maxSplitHands')::int from public.rulesets),
  4,
  'at most four hands after splitting'
);

select is(
  (
    select (rules ->> 'resplitAcesAllowed') || '/' ||
           (rules ->> 'hitSplitAcesAllowed') || '/' ||
           (rules ->> 'splitAceTwentyOneIsBlackjack')
    from public.rulesets
  ),
  'false/false/false',
  'split aces take one card each and 21 there is ordinary 21'
);

select is(
  (select (rules ->> 'targetPenetration')::numeric from public.rulesets),
  0.75::numeric,
  'the cut card sits at 75 percent penetration'
);

-- -----------------------------------------------------------------------------
-- Career map
-- -----------------------------------------------------------------------------

select is(
  (select count(*) from public.career_nodes),
  18::bigint,
  '18 career nodes are seeded'
);

select is(
  (
    select count(*) from (
      select chapter from public.career_nodes
      group by chapter having count(*) = 6
    ) as chapters_of_six
  ),
  3::bigint,
  'three chapters of exactly six nodes each'
);

select results_eq(
  $$ select chapter::text from public.career_nodes
     group by chapter, chapter_order order by chapter_order $$,
  $$ values ('FOUNDATIONS'), ('THE_WORKSHOP'), ('SKYLINE') $$,
  'the chapters are FOUNDATIONS, THE WORKSHOP and SKYLINE, in that order'
);

select is(
  (select count(*) from public.career_nodes where requires_node_id is not null),
  17::bigint,
  'every node but the first is gated on the one before it'
);

-- -----------------------------------------------------------------------------
-- Cosmetics
-- -----------------------------------------------------------------------------

select results_eq(
  $$ select kind::text, count(*) from public.cosmetics
     group by kind order by kind::text $$,
  $$ values ('avatar', 12::bigint), ('card_back', 8::bigint), ('table_theme', 4::bigint) $$,
  '12 avatars, 8 card backs and 4 table themes'
);

select is(
  (select count(distinct kind) from public.cosmetics where unlock_type = 'default'),
  3::bigint,
  'every slot has at least one default item, so a new player is never slotless'
);

select is(
  (select count(*) from public.career_nodes where reward_cosmetic_id is not null),
  3::bigint,
  'each chapter finale awards a cosmetic'
);

-- -----------------------------------------------------------------------------
-- What a signed-out client can see
-- -----------------------------------------------------------------------------

set local role anon;

select is(
  (
    (select count(*) from public.cosmetics)
    + (select count(*) from public.career_nodes)
    + (select count(*) from public.rulesets)
  ),
  43::bigint,
  'the catalogue tables are readable without an account (24 + 18 + 1)'
);

reset role;

select * from finish();

rollback;
