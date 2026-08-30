/**
 * How a split is presented — one implementation, for all three tables.
 *
 * THE DEFECT THIS CLOSES. Splitting is legal at every table in the product, up
 * to four hands, and only ONE of the three screens that deal cards presented it
 * usefully:
 *
 *   Practice   `app/game/practice.tsx`      a chip row plus the active hand at
 *                                           hero size. Correct.
 *   Career     `app/career/play/[slug].tsx` the active hand and nothing else —
 *                                           no chip row, so after a split the
 *                                           other hands, their totals and their
 *                                           wagers were simply not on screen.
 *   Online     `app/table/[gameId].tsx`     every hand at HERO size, stacked
 *                                           vertically. Four of those do not fit
 *                                           a phone, and nothing said which one
 *                                           the dock was about to act on except
 *                                           a one-pixel border.
 *
 * The online case is the one that reaches most modes: Quick Play, public
 * tables, private tables, tournaments and the daily challenge all render
 * `/table/[gameId]`.
 *
 * So the presentation moved here rather than being copied twice more. Practice
 * had the right shape and this is its logic, generalised over the two hand
 * types the app holds — the engine's `PlayerHand` and the server's
 * `PublicHand`, which differ only in whether the total arrives computed.
 *
 * Runtime-neutral: no React, React Native or Expo import, so the labels can be
 * asserted in a plain Node process. Only `HandSelector.tsx` draws them.
 */

import { evaluatePlayerHand } from "../../../shared/blackjack/hand-value.js";
import type {
  HandOutcome,
  PlayerHand,
  PlayerHandStatus,
} from "../../../shared/blackjack/types.js";

/**
 * The common denominator of a hand, whichever table it came from.
 *
 * `PublicHand` satisfies this structurally — the server sends `total` and
 * `isSoft` already computed, because a client that re-derived them would be
 * disagreeing with the authority on arithmetic. An engine `PlayerHand` is
 * mapped by `splitHandFromEngineHand` below.
 */
export interface SplitHandInput {
  readonly id: string;
  /** Best total, or null when the hand holds no cards. */
  readonly total: number | null;
  readonly isSoft: boolean;
  readonly status: PlayerHandStatus;
  readonly outcome?: HandOutcome;
}

export interface SplitHandSummary {
  readonly id: string;
  /** 1-based, because "Hand 0" is not a thing a player has. */
  readonly ordinal: number;
  /** Chip text, e.g. "Hand 2 · 17". Short enough for four across a phone. */
  readonly label: string;
  /** Spelled out for a screen reader, e.g. "Hand 2, soft 17, active". */
  readonly accessibilityLabel: string;
  /** The hand the dock is acting on. Exactly one, or none between hands. */
  readonly active: boolean;
  /** True once the hand can take no more cards. Drawn quieter. */
  readonly settled: boolean;
}

/** Maps an engine hand into the shape above. */
export function splitHandFromEngineHand(
  hand: PlayerHand,
  splitAceTwentyOneIsBlackjack: boolean,
): SplitHandInput {
  const value = evaluatePlayerHand(hand, splitAceTwentyOneIsBlackjack);
  return {
    id: hand.id,
    total: hand.cards.length > 0 ? value.bestTotal : null,
    isSoft: value.isSoft,
    status: hand.status,
    outcome: hand.outcome,
  };
}

/**
 * The short word a chip shows for a hand that is finished.
 *
 * A settled hand's TOTAL is not the useful thing — "Hand 2 · 21" beside a
 * dealer blackjack reads as a win. The status is.
 */
function settledWord(status: PlayerHandStatus): string | null {
  switch (status) {
    case "BUSTED":
      return "Bust";
    case "SURRENDERED":
      return "Surrendered";
    case "BLACKJACK":
      return "Blackjack";
    case "ACTIVE":
      return null;
    default:
      // STOOD, DOUBLED_COMPLETE, TWENTY_ONE and the reserved value: the total
      // is exactly what a player wants to see for these.
      return null;
  }
}

/** True once a hand can take no more cards. */
export function isSettledHand(status: PlayerHandStatus): boolean {
  return status !== "ACTIVE";
}

/**
 * One chip's worth of description.
 *
 * `count` is passed so the screen reader hears "Hand 2 of 3" rather than
 * "Hand 2" — a total is the difference between knowing where you are and
 * knowing only what you are looking at.
 */
export function describeSplitHand(input: {
  hand: SplitHandInput;
  index: number;
  count: number;
  active: boolean;
}): SplitHandSummary {
  const { hand, index, count, active } = input;
  const ordinal = index + 1;
  const settled = isSettledHand(hand.status);
  const word = settledWord(hand.status);

  const shortValue = word ?? (hand.total === null ? "—" : String(hand.total));
  const label = `Hand ${ordinal} · ${shortValue}`;

  /*
   * The spoken form mirrors the engine's own phrasing for a live hand — "soft
   * 17", "hard 16" — because that is what `HandCards` says beside it, and two
   * different descriptions of one hand is worse than either alone.
   *
   * Written out rather than calling `describeHandValue`: that takes a full
   * `HandValue`, and fabricating one here from a total and a flag would mean
   * inventing `hardTotal`, `isTwentyOne` and `isNaturalBlackjack` to satisfy a
   * type. A summary must not manufacture engine facts it was not given.
   */
  const spokenValue =
    word?.toLowerCase() ??
    (hand.total === null ? "no cards" : `${hand.isSoft ? "soft" : "hard"} ${hand.total}`);

  return {
    id: hand.id,
    ordinal,
    label,
    accessibilityLabel: `Hand ${ordinal} of ${count}, ${spokenValue}${active ? ", active" : ""}`,
    active,
    settled,
  };
}

/**
 * Every chip for a seat's hands.
 *
 * Returns an empty array for a single hand: a chip row above one hand is
 * clutter that says nothing the hand does not already say. The caller renders
 * nothing at all in that case, which is what keeps an ordinary hand looking
 * like an ordinary hand.
 */
export function describeSplitHands(input: {
  hands: readonly SplitHandInput[];
  /** The hand the dock is acting on, or null between hands. */
  activeHandId: string | null;
}): SplitHandSummary[] {
  if (input.hands.length <= 1) return [];
  return input.hands.map((hand, index) =>
    describeSplitHand({
      hand,
      index,
      count: input.hands.length,
      active: hand.id === input.activeHandId,
    }),
  );
}

/**
 * Which hand gets the large treatment.
 *
 * The ACTIVE one while a hand is being played; otherwise the first, so a
 * settled split still shows something rather than collapsing to nothing. Never
 * more than one, which is the whole point — four hero hands do not fit a phone,
 * and `HandCards` at hero size is 1.6 times the height of a compact one.
 */
export function focusedSplitHandId(input: {
  hands: readonly { readonly id: string }[];
  activeHandId: string | null;
}): string | null {
  const { hands, activeHandId } = input;
  if (hands.length === 0) return null;
  if (activeHandId && hands.some((hand) => hand.id === activeHandId)) return activeHandId;
  return hands[0]!.id;
}
