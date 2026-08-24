/**
 * Arc 21 — hand evaluation.
 *
 * Ace handling exists here and nowhere else. If you find yourself writing
 * `total > 21 ? total - 10 : total` in a component, stop: call `evaluateHand`.
 */

import { rankValue } from "./cards.js";
import type { Card, HandValue, PlayerHand } from "./types.js";

export interface EvaluateHandOptions {
  /** Hands produced by a split can never be a natural blackjack... */
  cameFromSplit?: boolean;
  /** ...unless the ruleset explicitly says split-ace 21 counts as one. */
  cameFromSplitAces?: boolean;
  splitAceTwentyOneIsBlackjack?: boolean;
}

/**
 * Evaluates a set of cards.
 *
 * Algorithm:
 *   1. Count every ace as 1 to get the hard total.
 *   2. If at least one ace exists and hardTotal + 10 <= 21, promote exactly one
 *      ace to 11. Only one ace can ever be soft — two elevens is already 22.
 *   3. Bust is bestTotal > 21.
 *   4. A natural is exactly two cards totalling 21 on an original unsplit hand.
 */
export function evaluateHand(cards: Card[], options: EvaluateHandOptions = {}): HandValue {
  let hardTotal = 0;
  let aceCount = 0;

  for (const card of cards) {
    const value = rankValue(card.rank);
    if (value === 11) {
      aceCount++;
      hardTotal += 1;
    } else {
      hardTotal += value;
    }
  }

  const canPromoteAce = aceCount > 0 && hardTotal + 10 <= 21;
  const bestTotal = canPromoteAce ? hardTotal + 10 : hardTotal;
  const isSoft = canPromoteAce;

  const isTwentyOne = bestTotal === 21;
  const twoCardTwentyOne = cards.length === 2 && isTwentyOne;

  let isNaturalBlackjack = twoCardTwentyOne;
  if (twoCardTwentyOne && options.cameFromSplit) {
    // A split hand's two-card 21 is an ordinary 21 and pays 1:1, unless the
    // ruleset opts in for split aces specifically.
    isNaturalBlackjack =
      options.cameFromSplitAces === true && options.splitAceTwentyOneIsBlackjack === true;
  }

  return {
    hardTotal,
    bestTotal,
    isSoft,
    isBust: bestTotal > 21,
    isTwentyOne,
    isNaturalBlackjack,
  };
}

/** Evaluates a `PlayerHand`, wiring up its split provenance automatically. */
export function evaluatePlayerHand(
  hand: PlayerHand,
  splitAceTwentyOneIsBlackjack: boolean,
): HandValue {
  return evaluateHand(hand.cards, {
    cameFromSplit: hand.cameFromSplit,
    cameFromSplitAces: hand.cameFromSplitAces,
    splitAceTwentyOneIsBlackjack,
  });
}

/**
 * The dealer's publicly visible value before the hole card is revealed.
 * Derived only from face-up cards — this function must never see the hole card.
 */
export function visibleDealerValue(faceUpCards: Card[]): HandValue {
  return evaluateHand(faceUpCards);
}

/**
 * The dealer's entire procedure: draw below 17, stand at 17 or better, and hit
 * a SOFT 17 only when the ruleset says so. The dealer makes no decisions, so
 * this is the whole of it.
 *
 * It lives here because it had been written down twice — once in the engine's
 * `playDealer` and once in `scripts/strategy-solver.ts`, which needs the same
 * rule to compute the dealer's final-total distribution. Two copies of the
 * dealer's rule means the basic-strategy chart can be solved for a game the
 * engine does not deal, and the chart is what the product grades players
 * against. Both now call this.
 *
 * Takes primitives rather than a `HandValue` so the solver, which works over
 * rank counts and has no `Card[]` to evaluate, can call it too. The rules
 * parameter is structural for the same reason.
 */
export function dealerMustDraw(
  value: Pick<HandValue, "bestTotal" | "isSoft">,
  rules: { dealerHitsSoft17: boolean },
): boolean {
  if (value.bestTotal > 21) return false; // already bust; there is nothing to draw to
  if (value.bestTotal < 17) return true;
  return value.bestTotal === 17 && value.isSoft && rules.dealerHitsSoft17;
}

/** Human-readable classification, e.g. "Soft 17", "Hard 16", "Blackjack". */
export function describeHandValue(value: HandValue): string {
  if (value.isNaturalBlackjack) return "Blackjack";
  if (value.isBust) return `Bust · ${value.bestTotal}`;
  if (value.isSoft) return `Soft ${value.bestTotal}`;
  return `Hard ${value.bestTotal}`;
}

/** Screen-reader phrasing, spelled out rather than abbreviated. */
export function handValueAccessibilityLabel(value: HandValue): string {
  if (value.isNaturalBlackjack) return "Blackjack";
  if (value.isBust) return `Bust, ${value.bestTotal}`;
  if (value.isSoft) return `Soft ${value.bestTotal}`;
  return `${value.bestTotal}`;
}
