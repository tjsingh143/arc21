/**
 * Arc 21 — strategy key normalisation.
 *
 * One state, one key. Everything that reads or writes a strategy table goes
 * through `normalizeStrategyKey`, including the generator — so a key emitted by
 * `scripts/generate-strategy-tables.ts` and a key computed at runtime cannot
 * drift apart.
 *
 * Values follow the engine's `cardValue`: aces are 11, ten-value cards are 10.
 */

import { cardValue, isSplitEligible } from "../engine-primitives.ts";
import { evaluateHand } from "../engine-primitives.ts";
import type { Card, SplitPolicy } from "../engine-primitives.ts";
import type { HandClass, StrategyState } from "./types.ts";

/** Dealer upcard values in chart order: 2..10 then ace (11). */
export const DEALER_UPCARD_VALUES: readonly number[] = [2, 3, 4, 5, 6, 7, 8, 9, 10, 11];

/** Pair values in chart order: 2,2 through 10,10 then A,A (11). */
export const PAIR_VALUES: readonly number[] = [2, 3, 4, 5, 6, 7, 8, 9, 10, 11];

const HAND_CLASSES: readonly HandClass[] = ["hard", "soft", "pair"];

/**
 * The only total a pair of that value can hold.
 *
 * A,A is soft 12, never 2 and never 20 — `pairValue` is 11 for an ace, matching
 * the engine's `cardValue`. Every other pair is twice its card value.
 */
export function pairTotal(pairValue: number): number {
  return pairValue === 11 ? 12 : pairValue * 2;
}

/**
 * Stable key for a decision state.
 *
 * Format:
 *   `hard:<total>:<upcard>`
 *   `soft:<total>:<upcard>`
 *   `pair:<pairValue>:<upcard>`
 *
 * A pair is keyed by its *pair value* rather than its total so that `A,A`
 * (total 12) and `6,6` (total 12) cannot collide.
 *
 * Throws on a malformed state. Callers that accept untrusted or derived input
 * should run `validateStrategyState` first — `lookupStrategy` does, and turns a
 * malformed state into a diagnostic rather than an exception.
 */
export function normalizeStrategyKey(state: StrategyState): string {
  const problem = validateStrategyState(state);
  if (problem !== null) {
    throw new TypeError(`Cannot normalize strategy key: ${problem}`);
  }
  if (state.handClass === "pair") {
    return `pair:${state.pairValue}:${state.dealerUpcardValue}`;
  }
  return `${state.handClass}:${state.playerTotal}:${state.dealerUpcardValue}`;
}

/**
 * Returns a human-readable problem description, or null when the state is a
 * well-formed decision coordinate. Deliberately strict: an out-of-range total
 * is a bug in the caller, not a cell to invent advice for.
 */
export function validateStrategyState(state: StrategyState): string | null {
  if (!HAND_CLASSES.includes(state.handClass)) {
    return `unknown handClass "${String(state.handClass)}"`;
  }
  if (
    !Number.isInteger(state.dealerUpcardValue) ||
    !DEALER_UPCARD_VALUES.includes(state.dealerUpcardValue)
  ) {
    return `dealerUpcardValue ${String(state.dealerUpcardValue)} is not 2..10 or 11`;
  }

  if (state.handClass === "pair") {
    // `pairValue` is validated BEFORE the total, because for a pair the total is
    // derived from it. Range-checking the total first reports a symptom — a pair
    // of twelves is "total 24, outside 2..21" — when the root cause is that
    // twelve is not a card value. The caller gets the actionable message.
    if (state.pairValue === undefined || state.pairValue === null) {
      return "handClass is \"pair\" but pairValue is missing";
    }
    if (!PAIR_VALUES.includes(state.pairValue)) {
      return `pairValue ${String(state.pairValue)} is not 2..10 or 11`;
    }

    // The key ignores `playerTotal` for pairs, so an incoherent total would
    // stay invisible right up until the pair falls back to its total row — and
    // then answer from the wrong row. 2,2 vs 5 carrying a total of 20 would be
    // told to stand on a hard 4. Reject it here instead.
    //
    // A valid pairValue always yields a total in 4..20, so this subsumes the
    // range check applied to hard and soft states below.
    const expected = pairTotal(state.pairValue);
    if (state.playerTotal !== expected) {
      return (
        `pairValue ${String(state.pairValue)} is a total of ${expected}, ` +
        `but playerTotal is ${String(state.playerTotal)}`
      );
    }
    return null;
  }

  if (!Number.isInteger(state.playerTotal) || state.playerTotal < 2 || state.playerTotal > 21) {
    return `playerTotal ${String(state.playerTotal)} is outside 2..21`;
  }
  return null;
}

/**
 * The hard/soft total row a pair falls back to when SPLIT is not available.
 *
 * The total is derived from `pairValue` rather than copied from
 * `state.playerTotal`: this function decides which solved row answers, and it
 * must not be steerable by a field the key never looks at. Returns null for a
 * state that is not a well-formed pair, so the caller reports the state as
 * invalid rather than resolving through an invented row.
 */
export function totalRowStateForPair(state: StrategyState): StrategyState | null {
  if (state.handClass !== "pair" || state.pairValue === undefined) return null;
  if (!PAIR_VALUES.includes(state.pairValue)) return null;
  const handClass: HandClass = state.pairValue === 11 ? "soft" : "hard";
  return {
    handClass,
    playerTotal: pairTotal(state.pairValue),
    dealerUpcardValue: state.dealerUpcardValue,
  };
}

export interface DescribeStrategyStateOptions {
  /** Defaults to `"same_value"`, matching Arc Standard. */
  splitPolicy?: SplitPolicy;
  /** A hand produced by a split can never be offered as an original-pair decision... */
  cameFromSplit?: boolean;
  /** ...but it can still be re-split, so pair classification stays available. */
  cameFromSplitAces?: boolean;
  splitAceTwentyOneIsBlackjack?: boolean;
}

/**
 * Derives the normalized state from real cards.
 *
 * Returns null when there is no decision to advise on: fewer than two cards, a
 * bust, or a natural blackjack. Returning null here is the same fail-safe
 * contract as the lookup — the advisor stays silent rather than inventing a
 * coordinate.
 */
export function describeStrategyState(
  playerCards: readonly Card[],
  dealerUpcard: Card,
  options: DescribeStrategyStateOptions = {},
): StrategyState | null {
  if (playerCards.length < 2) return null;

  const value = evaluateHand([...playerCards], {
    cameFromSplit: options.cameFromSplit === true,
    cameFromSplitAces: options.cameFromSplitAces === true,
    splitAceTwentyOneIsBlackjack: options.splitAceTwentyOneIsBlackjack === true,
  });

  if (value.isBust || value.isNaturalBlackjack) return null;

  const dealerUpcardValue = cardValue(dealerUpcard);
  const first = playerCards[0];
  const second = playerCards[1];

  if (playerCards.length === 2 && first !== undefined && second !== undefined) {
    const policy: SplitPolicy = options.splitPolicy ?? "same_value";
    if (isSplitEligible(first, second, policy)) {
      return {
        handClass: "pair",
        playerTotal: value.bestTotal,
        pairValue: cardValue(first),
        dealerUpcardValue,
      };
    }
  }

  return {
    handClass: value.isSoft ? "soft" : "hard",
    playerTotal: value.bestTotal,
    dealerUpcardValue,
  };
}

/** Chart-style label for a state, e.g. `"Hard 16"`, `"Soft 18"`, `"A,A"`. */
export function describeStrategyStateLabel(state: StrategyState): string {
  if (state.handClass === "pair") {
    const face = state.pairValue === 11 ? "A" : String(state.pairValue);
    return `${face},${face}`;
  }
  return `${state.handClass === "soft" ? "Soft" : "Hard"} ${state.playerTotal}`;
}

/** Chart-style label for a dealer upcard value, e.g. `"A"` or `"10"`. */
export function describeUpcardLabel(upcardValue: number): string {
  return upcardValue === 11 ? "A" : String(upcardValue);
}
