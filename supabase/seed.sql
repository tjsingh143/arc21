-- =============================================================================
-- Arc 21 — seed data
--
-- Applied by `supabase db reset` after every migration. Contains only catalogue
-- data: the ruleset, the career map and the cosmetic catalogue. No user rows,
-- no wallets, no secrets.
--
-- Deliberately NOT seeded here:
--   * daily_challenges — a row requires a real `seed_secret`, and a secret in a
--     version-controlled file is not a secret. Challenges are minted by a
--     server job. The pgTAP suite creates its own throwaway row.
--   * Any cosmetic price or randomised unlock. Neither exists in this product.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- The Arc Standard ruleset
--
-- `rules` is ARC_STANDARD_RULES from shared/blackjack/rules.ts, verbatim. The
-- rulesets_payload_matches_identity CHECK rejects this row if `key` / `version`
-- ever drift from the payload.
-- -----------------------------------------------------------------------------

insert into public.rulesets (key, version, label, description, rules, is_active)
values (
  'arc-standard',
  1,
  'Arc Standard',
  'Six decks, dealer stands on all 17, blackjack pays 3:2, late surrender, double after split, split on equal value to four hands.',
  jsonb_build_object(
    'id',                           'arc-standard',
    'version',                      1,
    'deckCount',                    6,
    'dealerHitsSoft17',             false,
    'dealerHoleCard',               true,
    'dealerPeeksForBlackjack',      true,
    'blackjackPayoutNumerator',     3,
    'blackjackPayoutDenominator',   2,
    'insuranceAllowed',             true,
    'insuranceFractionNumerator',   1,
    'insuranceFractionDenominator', 2,
    'insurancePayoutNumerator',     2,
    'insurancePayoutDenominator',   1,
    'lateSurrenderAllowed',         true,
    'doubleAllowed',                true,
    'doubleOnAnyTwoCards',          true,
    'doubleAfterSplit',             true,
    'splitPolicy',                  'same_value',
    'maxSplitHands',                4,
    'splitAcesAllowed',             true,
    'resplitAcesAllowed',           false,
    'hitSplitAcesAllowed',          false,
    'doubleSplitAcesAllowed',       false,
    'splitAceTwentyOneIsBlackjack', false,
    'targetPenetration',            0.75,
    'minBet',                       50,
    'maxBet',                       1000,
    'betIncrement',                 10
  ),
  true
)
on conflict (key, version) do nothing;

-- -----------------------------------------------------------------------------
-- Cosmetics — 12 avatars, 8 card backs, 4 table themes
--
-- Every unlock is earned by playing: a level, a career node, a chapter, a daily
-- streak or a tournament placement. There is no price and no chance.
-- -----------------------------------------------------------------------------

insert into public.cosmetics (code, kind, name, description, asset_key, unlock_type, unlock_config, sort_order)
values
  -- Avatars
  ('avatar-house-dealer',  'avatar', 'House Dealer',   'The dealer who taught you the order of operations.',        'avatars/house_dealer',  'default',              '{}'::jsonb,                              10),
  ('avatar-first-chip',    'avatar', 'First Chip',     'Everyone starts with one.',                                 'avatars/first_chip',    'default',              '{}'::jsonb,                              20),
  ('avatar-apprentice',    'avatar', 'Apprentice',     'You have stopped hitting sixteen against a six.',           'avatars/apprentice',    'level',                '{"level": 3}'::jsonb,                    30),
  ('avatar-draftsman',     'avatar', 'Draftsman',      'Lines drawn before the cards are dealt.',                   'avatars/draftsman',     'level',                '{"level": 7}'::jsonb,                    40),
  ('avatar-architect',     'avatar', 'Architect',      'Structure over instinct.',                                  'avatars/architect',     'level',                '{"level": 12}'::jsonb,                   50),
  ('avatar-night-shift',   'avatar', 'Night Shift',    'The shoe does not care what time it is.',                   'avatars/night_shift',   'level',                '{"level": 18}'::jsonb,                   60),
  ('avatar-old-hand',      'avatar', 'Old Hand',       'Long enough to know the dealer is not out to get you.',     'avatars/old_hand',      'level',                '{"level": 25}'::jsonb,                   70),
  ('avatar-foundation',    'avatar', 'Foundation',     'Awarded for completing the Foundations chapter.',           'avatars/foundation',    'career_chapter',       '{"chapter": "FOUNDATIONS"}'::jsonb,      80),
  ('avatar-machinist',     'avatar', 'Machinist',      'Awarded for completing The Workshop chapter.',              'avatars/machinist',     'career_chapter',       '{"chapter": "THE_WORKSHOP"}'::jsonb,     90),
  ('avatar-skyline',       'avatar', 'Skyline',        'Awarded for completing the Skyline chapter.',               'avatars/skyline',       'career_chapter',       '{"chapter": "SKYLINE"}'::jsonb,         100),
  ('avatar-clockwork',     'avatar', 'Clockwork',      'Seven daily challenges in a row.',                          'avatars/clockwork',     'daily_streak',         '{"streak": 7}'::jsonb,                  110),
  ('avatar-laurel',        'avatar', 'Laurel',         'First place in a tournament.',                              'avatars/laurel',        'tournament_placement', '{"placement": 1}'::jsonb,               120),

  -- Card backs
  ('back-arc-standard',    'card_back', 'Arc Standard',   'The house back.',                                        'card_backs/arc_standard', 'default',            '{}'::jsonb,                              10),
  ('back-slate',           'card_back', 'Slate',          'Matte, quiet, unbothered.',                              'card_backs/slate',        'level',              '{"level": 5}'::jsonb,                    20),
  ('back-brass',           'card_back', 'Brass',          'Warm metal and straight edges.',                         'card_backs/brass',        'level',              '{"level": 15}'::jsonb,                   30),
  ('back-drafting',        'card_back', 'Drafting Paper', 'Awarded for finishing Foundations.',                     'card_backs/drafting',     'career_node',        '{"careerNodeCode": "foundations-6"}'::jsonb, 40),
  ('back-blueprint',       'card_back', 'Blueprint',      'Awarded for finishing The Workshop.',                     'card_backs/blueprint',    'career_node',        '{"careerNodeCode": "workshop-6"}'::jsonb,    50),
  ('back-meridian',        'card_back', 'Meridian',       'Awarded for finishing Skyline.',                          'card_backs/meridian',     'career_node',        '{"careerNodeCode": "skyline-6"}'::jsonb,     60),
  ('back-thirty-days',     'card_back', 'Thirty Days',    'Thirty daily challenges in a row.',                       'card_backs/thirty_days',  'daily_streak',       '{"streak": 30}'::jsonb,                  70),
  ('back-podium',          'card_back', 'Podium',         'A top-three tournament finish.',                          'card_backs/podium',       'tournament_placement', '{"placement": 3}'::jsonb,              80),

  -- Table themes
  ('table-arc-green',      'table_theme', 'Arc Green',     'The default felt.',                                      'tables/arc_green',      'default',        '{}'::jsonb,                          10),
  ('table-workshop-oak',   'table_theme', 'Workshop Oak',  'Awarded for completing The Workshop chapter.',           'tables/workshop_oak',   'career_chapter', '{"chapter": "THE_WORKSHOP"}'::jsonb, 20),
  ('table-skyline-dusk',   'table_theme', 'Skyline Dusk',  'Awarded for completing the Skyline chapter.',            'tables/skyline_dusk',   'career_chapter', '{"chapter": "SKYLINE"}'::jsonb,      30),
  ('table-midnight',       'table_theme', 'Midnight',      'Unlocked at level 20.',                                  'tables/midnight',       'level',          '{"level": 20}'::jsonb,               40)
on conflict (code) do nothing;

-- -----------------------------------------------------------------------------
-- Career — 18 nodes, three chapters of six
--
-- Objectives are declarative and graded server-side. None of them can be
-- satisfied by luck alone at the accuracy tiers, and none of them asks the
-- player to deviate from correct basic strategy.
-- -----------------------------------------------------------------------------

insert into public.career_nodes (
  code, chapter, chapter_order, node_order, title, summary,
  objective, ruleset_id, tier, starting_chips, reward_chips, reward_xp
)
select
  v.code, v.chapter, v.chapter_order, v.node_order, v.title, v.summary,
  v.objective, r.id, v.tier, v.starting_chips, v.reward_chips, v.reward_xp
from (values
  -- Chapter 1 — FOUNDATIONS: the shape of a hand.
  ('foundations-1', 'FOUNDATIONS'::public.career_chapter, 1, 1,
   'First Hand',
   'Place a bet, take cards, and let the dealer play out. Five hands, no target.',
   '{"type": "play_hands", "count": 5}'::jsonb,
   'casual'::public.table_tier, 1000::bigint, 250::bigint, 50),

  ('foundations-2', 'FOUNDATIONS', 1, 2,
   'Hard and Soft',
   'An ace is worth eleven until it would bust you. Reach 1,400 chips inside twenty hands.',
   '{"type": "reach_chips", "target": 1400, "maxHands": 20}'::jsonb,
   'casual', 1000, 300, 60),

  ('foundations-3', 'FOUNDATIONS', 1, 3,
   'Standing Room',
   'Win five hands while busting no more than twice. Standing is a decision, not a surrender.',
   '{"type": "win_hands", "count": 5, "maxBusts": 2}'::jsonb,
   'casual', 1000, 350, 70),

  ('foundations-4', 'FOUNDATIONS', 1, 4,
   'The Natural',
   'Two cards, twenty-one, paid three to two. Be dealt one inside forty hands.',
   '{"type": "hand_outcome", "outcome": "BLACKJACK", "count": 1, "maxHands": 40}'::jsonb,
   'casual', 1000, 400, 80),

  ('foundations-5', 'FOUNDATIONS', 1, 5,
   'Stands On All Seventeen',
   'The dealer never improvises. Finish fifteen hands still holding chips.',
   '{"type": "survive_hands", "count": 15}'::jsonb,
   'casual', 1000, 450, 90),

  ('foundations-6', 'FOUNDATIONS', 1, 6,
   'Foundations Review',
   'Twelve graded decisions at ninety percent accuracy or better.',
   '{"type": "strategy_accuracy", "minAccuracy": 0.9, "minDecisions": 12}'::jsonb,
   'casual', 1500, 750, 150),

  -- Chapter 2 — THE WORKSHOP: the decisions that separate players.
  ('workshop-1', 'THE_WORKSHOP', 2, 1,
   'Double Down',
   'One extra card, twice the wager, then a forced stand. Win three doubled hands.',
   '{"type": "win_with_action", "action": "DOUBLE", "count": 3}'::jsonb,
   'standard', 2000, 500, 100),

  ('workshop-2', 'THE_WORKSHOP', 2, 2,
   'Split Decision',
   'Equal value splits — a king and a queen qualify. Win two hands that came from a split.',
   '{"type": "win_with_action", "action": "SPLIT", "count": 2}'::jsonb,
   'standard', 2000, 550, 110),

  ('workshop-3', 'THE_WORKSHOP', 2, 3,
   'Late Surrender',
   'Half your wager back beats a hand you were going to lose. Surrender correctly twice.',
   '{"type": "optimal_action", "action": "SURRENDER", "count": 2}'::jsonb,
   'standard', 2000, 600, 120),

  ('workshop-4', 'THE_WORKSHOP', 2, 4,
   'Declining Insurance',
   'Insurance is a side bet on the dealer, and it is not a good one. Decline it five times.',
   '{"type": "decline_insurance", "count": 5}'::jsonb,
   'standard', 2000, 650, 130),

  ('workshop-5', 'THE_WORKSHOP', 2, 5,
   'Aces Apart',
   'Split aces take one card each and stop. Twenty-one there pays even money, not three to two.',
   '{"type": "split_aces_resolved", "count": 2}'::jsonb,
   'standard', 2000, 700, 140),

  ('workshop-6', 'THE_WORKSHOP', 2, 6,
   'Workshop Review',
   'Twenty-five graded decisions at ninety-five percent accuracy or better.',
   '{"type": "strategy_accuracy", "minAccuracy": 0.95, "minDecisions": 25}'::jsonb,
   'standard', 3000, 1500, 300),

  -- Chapter 3 — SKYLINE: consistency at stake.
  ('skyline-1', 'SKYLINE', 3, 1,
   'Standard Stakes',
   'Higher minimums, identical rules. Reach 7,000 chips from a 5,000 buy-in.',
   '{"type": "reach_chips", "target": 7000, "maxHands": 40}'::jsonb,
   'standard', 5000, 900, 180),

  ('skyline-2', 'SKYLINE', 3, 2,
   'Bankroll Discipline',
   'Finish thirty hands with your chips level or better. Variance is not a strategy.',
   '{"type": "net_after_hands", "hands": 30, "minNet": 0}'::jsonb,
   'standard', 5000, 1000, 200),

  ('skyline-3', 'SKYLINE', 3, 3,
   'The Long Shoe',
   'Play one shoe all the way to the cut card without leaving the table.',
   '{"type": "complete_shoe", "count": 1}'::jsonb,
   'standard', 5000, 1100, 220),

  ('skyline-4', 'SKYLINE', 3, 4,
   'Under Pressure',
   'Reach 9,000 chips inside twenty hands. A short window rewards correct play, not bold play.',
   '{"type": "reach_chips", "target": 9000, "maxHands": 20}'::jsonb,
   'standard', 5000, 1200, 240),

  ('skyline-5', 'SKYLINE', 3, 5,
   'High Table',
   'Two hundred minimum, five thousand maximum, the same dealer rules as every other table.',
   '{"type": "reach_chips", "target": 26000, "maxHands": 40}'::jsonb,
   'high', 20000, 1500, 300),

  ('skyline-6', 'SKYLINE', 3, 6,
   'Skyline Review',
   'Forty graded decisions at ninety-seven percent accuracy or better.',
   '{"type": "strategy_accuracy", "minAccuracy": 0.97, "minDecisions": 40}'::jsonb,
   'high', 20000, 3000, 600)
) as v (
  code, chapter, chapter_order, node_order, title, summary,
  objective, tier, starting_chips, reward_chips, reward_xp
)
cross join (
  select id from public.rulesets where ruleset_key = 'arc-standard@1'
) as r
on conflict (code) do nothing;

-- Each node is gated on the one before it, in chapter then node order.
with ordered as (
  select
    id,
    lag(id) over (order by chapter_order, node_order) as previous_id
  from public.career_nodes
)
update public.career_nodes n
set requires_node_id = o.previous_id
from ordered o
where o.id = n.id
  and o.previous_id is not null
  and n.requires_node_id is distinct from o.previous_id;

-- Chapter finales award the card back that marks them.
update public.career_nodes n
set reward_cosmetic_id = c.id
from public.cosmetics c
where (n.code, c.code) in (
  ('foundations-6', 'back-drafting'),
  ('workshop-6',    'back-blueprint'),
  ('skyline-6',     'back-meridian')
)
and n.reward_cosmetic_id is distinct from c.id;
