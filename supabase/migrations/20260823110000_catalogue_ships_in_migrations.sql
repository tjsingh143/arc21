-- =============================================================================
-- Arc 21 — catalogue data ships in a MIGRATION, not in the seed
--
-- `supabase/seed.sql` runs on `supabase db reset`. It does NOT run on
-- `supabase db push`, which is how a project is deployed. The ruleset, the
-- cosmetics and the career map lived only there, so a deployed Arc 21 would
-- have started with an EMPTY `public.rulesets` — and `resolveRulesetId` in
-- `create-session` raises on an empty table, which means no solo table, no
-- public table, no tournament and no daily challenge could be opened at all.
-- Every local verification in docs/AUDIT.md passed because `db reset` had just
-- run the seed.
--
-- Nothing here is new data. The three blocks below are the seed's own, moved,
-- with their `on conflict` clauses kept so re-applying is a no-op and so a
-- machine that already ran the seed is not disturbed. The career catalogue
-- follows in 20260823120000, generated from `shared/career/nodes.ts`.
--
-- The rule this is an instance of: if a deployed database needs a row to
-- function, that row belongs in a migration. `rate_limit_policies` already knew
-- this — it is seeded in 20260818100000 — and it was the only catalogue that
-- did.
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
