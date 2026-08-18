/**
 * Arc 21 — the hands the introduction illustrates.
 *
 * Both are REAL. Page one shows cards the engine would recognise as a natural,
 * and page two's recommendation is READ FROM the generated strategy table
 * rather than typed into the screen. An introduction that shows advice the
 * product would not actually give is a promise the product breaks on the first
 * hand — and a chart transcribed by hand into a marketing screen is exactly how
 * that happens.
 *
 * Pure and free of React: `tests/onboarding` asserts the recommendation against
 * the shipped table without rendering anything.
 */

import { cardAccessibilityLabel } from "../../../shared/blackjack/cards.js";
import { ARC_STANDARD_RULES } from "../../../shared/blackjack/rules.js";
import type { Card } from "../../../shared/blackjack/types.js";
import { drillPool, type DrillScenario } from "../../../shared/career/drills.js";
import { adviseAction, type StrategyAction } from "../../../shared/strategy/index.js";

// ---------------------------------------------------------------------------
// Page 1 — one clean hand
// ---------------------------------------------------------------------------

/**
 * A natural against a seven.
 *
 * Fixed rather than dealt: an introduction must look the same on every device
 * and in every screenshot, and reaching for the shoe's CSPRNG to decorate a
 * marketing page would be both wasteful and non-reproducible.
 */
export const WELCOME_PLAYER_CARDS: readonly Card[] = [
  { id: "welcome:player:0", suit: "S", rank: "A", deckIndex: 0 },
  { id: "welcome:player:1", suit: "H", rank: "K", deckIndex: 0 },
] as const;

export const WELCOME_DEALER_UPCARD: Card = {
  id: "welcome:dealer:0",
  suit: "D",
  rank: "7",
  deckIndex: 0,
};

/** One announcement for the whole illustration, so it is not read card by card. */
export const WELCOME_HAND_ACCESSIBILITY_LABEL =
  `${WELCOME_PLAYER_CARDS.map(cardAccessibilityLabel).join(" and ")}, ` +
  `against the dealer's ${cardAccessibilityLabel(WELCOME_DEALER_UPCARD)} and one face-down card.`;

/**
 * The payout claim on page one, taken from the ruleset in force.
 *
 * Typing "3:2" here would let the screen keep advertising 3:2 after someone
 * changed the rules to 6:5 — the one number a player is entitled to trust.
 */
export const WELCOME_BLACKJACK_PAYOUT_LABEL =
  `${ARC_STANDARD_RULES.blackjackPayoutNumerator}:${ARC_STANDARD_RULES.blackjackPayoutDenominator}`;

// ---------------------------------------------------------------------------
// Page 2 — one real recommendation
// ---------------------------------------------------------------------------

/**
 * The cell page two illustrates: a hard 11 against a six.
 *
 * Chosen because it is the least ambiguous teaching moment in the chart — but
 * the *answer* is not chosen here, it is looked up. If a future solver run were
 * to move this cell, the screen would move with it.
 */
export const SHOWCASE_STRATEGY_KEY = "hard:11:6";

export interface StrategyShowcase {
  /** Built by the shared drill builder, so the cards and the key cannot drift. */
  readonly scenario: DrillScenario;
  /** The table's answer for this cell, restricted to the legal actions. */
  readonly action: StrategyAction;
}

/**
 * Null when the tables cannot answer — the same fail-safe contract the table
 * itself follows. The screen then shows the hand without a recommendation
 * rather than inventing one.
 */
function buildStrategyShowcase(): StrategyShowcase | null {
  const scenario = drillPool(ARC_STANDARD_RULES, "double").find(
    (candidate) => candidate.key === SHOWCASE_STRATEGY_KEY,
  );
  if (scenario === undefined) return null;

  const recommendation = adviseAction({
    rules: ARC_STANDARD_RULES,
    state: scenario.state,
    legalActions: scenario.legalActions,
  });
  if (recommendation === null) return null;

  return { scenario, action: recommendation.action };
}

/** Memoised: the answer is deterministic, and onboarding renders it on a swipe. */
let cached: StrategyShowcase | null | undefined;

export function strategyShowcase(): StrategyShowcase | null {
  if (cached === undefined) cached = buildStrategyShowcase();
  return cached;
}
