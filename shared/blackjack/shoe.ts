/**
 * Arc 21 — shoe management.
 *
 * The shoe is the single most integrity-sensitive structure in the product.
 * Rules that must never be violated:
 *   - The order is fixed at shuffle time and never consulted for "drama".
 *   - Cards are drawn strictly in order from `nextIndex`.
 *   - No card is ever fabricated, peeked at out of turn, or re-ordered.
 *   - Reshuffles happen between hands only, never mid-hand.
 */

import { buildDecks } from "./cards.js";
import { shuffleInPlace, type RandomSource } from "./rng.js";
import type { Card, Shoe } from "./types.js";
import type { BlackjackRules } from "./rules.js";

/**
 * Cards held back so a hand in progress cannot run the shoe dry.
 *
 * DELIBERATE DEVIATION FROM SPEC (documented in docs/BLACKJACK_RULES.md):
 * the specification asks for both 75% penetration and a 104-card reserve. At
 * six decks those are mutually exclusive — the cut card falls at index 234,
 * leaving 78 cards, so a 104-card reserve would always trip first (at index
 * 209) and silently reduce real penetration to ~67%.
 *
 * Penetration is a user-facing fairness claim on the Fair Play screen, so the
 * cut card stays the primary trigger and the reserve becomes what its name
 * says: a backstop that should never fire in ordinary play. One full deck is
 * comfortably beyond a realistic round's consumption (a five-seat round uses
 * roughly 20–30 cards) while remaining strictly below the 78-card post-cut
 * remainder, so it cannot pre-empt the cut card.
 *
 * `assertPenetrationIsCoherent` enforces that relationship for any ruleset.
 */
export const SAFETY_RESERVE_CARDS = 52;

export function createShoe(rules: BlackjackRules, source: RandomSource, shuffleNumber = 1): Shoe {
  const cards = shuffleInPlace(buildDecks(rules.deckCount), source);
  return {
    cards,
    nextIndex: 0,
    shuffleNumber,
    cutIndex: computeCutIndex(cards.length, rules.targetPenetration),
  };
}

/** Reshuffles the same physical cards, incrementing the shuffle counter. */
export function reshuffle(shoe: Shoe, rules: BlackjackRules, source: RandomSource): Shoe {
  const cards = shuffleInPlace(buildDecks(rules.deckCount), source);
  return {
    cards,
    nextIndex: 0,
    shuffleNumber: shoe.shuffleNumber + 1,
    cutIndex: computeCutIndex(cards.length, rules.targetPenetration),
  };
}

export function computeCutIndex(totalCards: number, targetPenetration: number): number {
  return Math.floor(totalCards * targetPenetration);
}

/**
 * Verifies the safety reserve cannot pre-empt the cut card for a given ruleset.
 *
 * If it can, the shoe would reshuffle earlier than the advertised penetration —
 * a quiet mismatch between what the Fair Play screen states and what the engine
 * actually does. Called from the ruleset guard so a bad combination fails at
 * configuration time rather than shipping.
 */
export function assertPenetrationIsCoherent(rules: BlackjackRules): void {
  const total = rules.deckCount * 52;
  const cutIndex = computeCutIndex(total, rules.targetPenetration);
  const remainingAtCut = total - cutIndex;

  if (remainingAtCut < SAFETY_RESERVE_CARDS) {
    throw new Error(
      `Ruleset "${rules.id}" is incoherent: at ${rules.deckCount} decks and ` +
        `${(rules.targetPenetration * 100).toFixed(0)}% penetration only ${remainingAtCut} cards ` +
        `remain at the cut card, which is below the ${SAFETY_RESERVE_CARDS}-card safety reserve. ` +
        `The reserve would trigger first and the stated penetration would be wrong.`,
    );
  }
}

export function cardsRemaining(shoe: Shoe): number {
  return shoe.cards.length - shoe.nextIndex;
}

export function approximateDecksRemaining(shoe: Shoe): number {
  return Math.round((cardsRemaining(shoe) / 52) * 2) / 2;
}

/**
 * Whether a new betting round must begin with a fresh shuffle.
 *
 * Checked only at the betting boundary. Two independent triggers: the cut card
 * has been reached, or the remaining cards have fallen into the safety reserve.
 */
export function needsReshuffle(shoe: Shoe): boolean {
  return shoe.nextIndex >= shoe.cutIndex || cardsRemaining(shoe) < SAFETY_RESERVE_CARDS;
}

export class ShoeExhaustedError extends Error {
  constructor() {
    super(
      "Shoe exhausted mid-hand. This indicates a penetration/reserve defect or a " +
        "pathological test fixture. The hand must be voided and wagers restored — " +
        "never fabricate a card.",
    );
    this.name = "ShoeExhaustedError";
  }
}

/**
 * Draws the next card. Returns a new shoe rather than mutating, so engine
 * transitions stay pure and serialisable.
 *
 * Throws `ShoeExhaustedError` rather than reshuffling mid-hand: a silent
 * mid-hand reshuffle would change the composition a player is reasoning about.
 */
export function drawCard(shoe: Shoe): { card: Card; shoe: Shoe } {
  if (shoe.nextIndex >= shoe.cards.length) {
    throw new ShoeExhaustedError();
  }
  const card = shoe.cards[shoe.nextIndex]!;
  return { card, shoe: { ...shoe, nextIndex: shoe.nextIndex + 1 } };
}

/**
 * TEST ONLY — a shoe with an exact, known card order.
 *
 * `cards` are dealt first, in the order given. Any remaining capacity is padded
 * so draws past the fixture do not immediately exhaust the shoe.
 */
export function createPreorderedShoe(cards: Card[], padWith: Card[] = []): Shoe {
  const all = [...cards, ...padWith];
  return {
    cards: all,
    nextIndex: 0,
    shuffleNumber: 1,
    cutIndex: all.length,
  };
}

/**
 * Verifies a shoe is a true permutation of `deckCount` intact decks — no
 * duplicated ids, no missing cards, correct rank/suit multiplicities.
 * Used in tests and as a server-side sanity check after shuffling.
 */
export function assertShoeIntegrity(shoe: Shoe, deckCount: number): void {
  const expected = buildDecks(deckCount);
  if (shoe.cards.length !== expected.length) {
    throw new Error(
      `Shoe has ${shoe.cards.length} cards, expected ${expected.length} for ${deckCount} decks`,
    );
  }

  const seen = new Set<string>();
  for (const card of shoe.cards) {
    if (seen.has(card.id)) {
      throw new Error(`Shoe contains duplicate card id "${card.id}"`);
    }
    seen.add(card.id);
  }

  for (const card of expected) {
    if (!seen.has(card.id)) {
      throw new Error(`Shoe is missing card "${card.id}"`);
    }
  }
}
