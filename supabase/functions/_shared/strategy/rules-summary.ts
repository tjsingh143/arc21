/**
 * Arc 21 — what a strategy table was actually solved for.
 *
 * `rulesetId@version` is a *stamp*. It says what the table claims to be, and a
 * stamp is only as honest as the person who last edited the ruleset. Editing a
 * field of `ARC_STANDARD_RULES` without bumping `version` is a one-character
 * mistake that leaves the stamp intact and every cell of the chart wrong — H17
 * alone moves 11 vs A, A,8 vs 6 and 15 vs A — so the stamp cannot be the only
 * thing standing between a player and stale advice.
 *
 * This module is the substance behind the stamp. `strategyRulesSummary` reduces
 * a ruleset to exactly the fields that can move a cell; the generator writes the
 * result into `metadata.rulesSummary`, and the lookup re-derives it from the
 * live ruleset and compares. A field that changed without a version bump is
 * therefore a `RULES_MISMATCH` diagnostic, not silent misinformation.
 *
 * Runtime-neutral: no React, React Native, Expo or Supabase imports.
 */

import type { BlackjackRules, SplitPolicy } from "../engine-primitives.ts";

/**
 * The strategy-relevant projection of a ruleset.
 *
 * Every field here changes at least one cell, one fallback, or the expectation
 * the table publishes for itself.
 *
 * DELIBERATELY EXCLUDED, because no cell depends on them:
 *   - `insuranceAllowed` and the insurance ratios — insurance is a separate
 *     wager with its own expectation and is never part of a basic-strategy
 *     cell (see `SOLVER_APPROXIMATIONS`).
 *   - `targetPenetration` — shoe management, not a decision.
 *   - `minBet` / `maxBet` / `betIncrement` — stake sizing. Table tiers differ
 *     only in these, which is exactly why every tier shares one chart.
 *   - `id` / `version` — the stamp itself, checked separately so the two
 *     failures stay distinguishable in the diagnostic.
 *
 * Adding a rule to `BlackjackRules` that can move a cell means adding it here.
 * `tests/strategy/lookup.test.ts` pins that by walking the ruleset's own keys.
 */
export interface StrategyRulesSummary {
  decks: number;
  dealerHitsSoft17: boolean;
  dealerHoleCard: boolean;
  dealerPeeksForBlackjack: boolean;
  /** `"3:2"`. A 6:5 game is a different game with a different published edge. */
  blackjackPayout: string;
  lateSurrenderAllowed: boolean;
  doubleAllowed: boolean;
  doubleOnAnyTwoCards: boolean;
  doubleAfterSplit: boolean;
  splitPolicy: SplitPolicy;
  maxSplitHands: number;
  splitAcesAllowed: boolean;
  resplitAcesAllowed: boolean;
  hitSplitAcesAllowed: boolean;
  doubleSplitAcesAllowed: boolean;
  splitAceTwentyOneIsBlackjack: boolean;
}

export const STRATEGY_RULE_FIELDS: readonly (keyof StrategyRulesSummary)[] = [
  "decks",
  "dealerHitsSoft17",
  "dealerHoleCard",
  "dealerPeeksForBlackjack",
  "blackjackPayout",
  "lateSurrenderAllowed",
  "doubleAllowed",
  "doubleOnAnyTwoCards",
  "doubleAfterSplit",
  "splitPolicy",
  "maxSplitHands",
  "splitAcesAllowed",
  "resplitAcesAllowed",
  "hitSplitAcesAllowed",
  "doubleSplitAcesAllowed",
  "splitAceTwentyOneIsBlackjack",
];

/** The strategy-relevant fields of a ruleset, in one comparable value. */
export function strategyRulesSummary(rules: BlackjackRules): StrategyRulesSummary {
  return {
    decks: rules.deckCount,
    dealerHitsSoft17: rules.dealerHitsSoft17,
    dealerHoleCard: rules.dealerHoleCard,
    dealerPeeksForBlackjack: rules.dealerPeeksForBlackjack,
    blackjackPayout: `${rules.blackjackPayoutNumerator}:${rules.blackjackPayoutDenominator}`,
    lateSurrenderAllowed: rules.lateSurrenderAllowed,
    doubleAllowed: rules.doubleAllowed,
    doubleOnAnyTwoCards: rules.doubleOnAnyTwoCards,
    doubleAfterSplit: rules.doubleAfterSplit,
    splitPolicy: rules.splitPolicy,
    maxSplitHands: rules.maxSplitHands,
    splitAcesAllowed: rules.splitAcesAllowed,
    resplitAcesAllowed: rules.resplitAcesAllowed,
    hitSplitAcesAllowed: rules.hitSplitAcesAllowed,
    doubleSplitAcesAllowed: rules.doubleSplitAcesAllowed,
    splitAceTwentyOneIsBlackjack: rules.splitAceTwentyOneIsBlackjack,
  };
}

export interface StrategyRulesMismatch {
  field: keyof StrategyRulesSummary;
  /** What the table was solved for. */
  solvedFor: string | number | boolean;
  /** What the session is actually playing. */
  playing: string | number | boolean;
}

/**
 * Every strategy-relevant field where a table's stamped summary disagrees with
 * the ruleset in force. Empty means the table really was solved for this game.
 *
 * A missing field counts as a mismatch: a table emitted before the field
 * existed was solved without considering it, and "it wasn't recorded" is not
 * evidence that it matched.
 */
export function strategyRulesMismatches(
  summary: Readonly<Partial<StrategyRulesSummary>> | undefined,
  rules: BlackjackRules,
): StrategyRulesMismatch[] {
  const expected = strategyRulesSummary(rules);
  const mismatches: StrategyRulesMismatch[] = [];

  for (const field of STRATEGY_RULE_FIELDS) {
    const solvedFor = summary?.[field];
    const playing = expected[field];
    if (solvedFor === undefined) {
      mismatches.push({ field, solvedFor: "(not recorded)", playing });
      continue;
    }
    if (solvedFor !== playing) {
      mismatches.push({ field, solvedFor, playing });
    }
  }

  return mismatches;
}

/** `"dealerHitsSoft17 solved for false, playing true"`, for a diagnostic. */
export function describeRulesMismatch(mismatch: StrategyRulesMismatch): string {
  return `${mismatch.field} solved for ${String(mismatch.solvedFor)}, playing ${String(
    mismatch.playing,
  )}`;
}
