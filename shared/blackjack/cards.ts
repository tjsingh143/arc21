/**
 * Arc 21 — card primitives.
 *
 * Card *value* logic lives here; hand evaluation (ace normalisation, soft/hard,
 * naturals) lives in `hand-value.ts`. Nothing else may hardcode rank values.
 */

import type { Card, Rank, Suit } from "./types.js";

export const SUITS: readonly Suit[] = ["S", "H", "D", "C"];

export const RANKS: readonly Rank[] = [
  "A",
  "2",
  "3",
  "4",
  "5",
  "6",
  "7",
  "8",
  "9",
  "10",
  "J",
  "Q",
  "K",
];

const RANK_VALUES: Readonly<Record<Rank, number>> = {
  A: 11,
  "2": 2,
  "3": 3,
  "4": 4,
  "5": 5,
  "6": 6,
  "7": 7,
  "8": 8,
  "9": 9,
  "10": 10,
  J: 10,
  Q: 10,
  K: 10,
};

/**
 * The blackjack value of a rank, with aces reported as 11.
 * Ace downgrading is the responsibility of `hand-value.ts`.
 */
export function rankValue(rank: Rank): number {
  return RANK_VALUES[rank];
}

/** The value used for split eligibility and pair strategy keys. Aces are 11. */
export function cardValue(card: Card): number {
  return RANK_VALUES[card.rank];
}

export function isAce(card: Card): boolean {
  return card.rank === "A";
}

export function isTenValue(card: Card): boolean {
  return RANK_VALUES[card.rank] === 10;
}

/**
 * Whether two cards may be split under the given policy.
 *
 * `same_value` (the Arc Standard default) makes any two ten-value cards
 * split-eligible, so K+Q is a legal split. Basic strategy will still recommend
 * standing — legality and advice are separate concerns.
 */
export function isSplitEligible(
  a: Card,
  b: Card,
  policy: "same_value" | "same_rank",
): boolean {
  return policy === "same_rank" ? a.rank === b.rank : cardValue(a) === cardValue(b);
}

/**
 * Builds an ordered, unshuffled shoe of `deckCount` standard 52-card decks.
 * Every physical card gets a unique, stable id: rank/suit alone is ambiguous
 * across decks and cannot be used for identity.
 */
export function buildDecks(deckCount: number): Card[] {
  if (!Number.isInteger(deckCount) || deckCount < 1) {
    throw new Error(`deckCount must be a positive integer, received ${deckCount}`);
  }

  const cards: Card[] = [];
  for (let deckIndex = 0; deckIndex < deckCount; deckIndex++) {
    for (const suit of SUITS) {
      for (const rank of RANKS) {
        cards.push({
          id: `d${deckIndex}-${rank}${suit}`,
          suit,
          rank,
          deckIndex,
        });
      }
    }
  }
  return cards;
}

const SUIT_NAMES: Readonly<Record<Suit, string>> = {
  S: "Spades",
  H: "Hearts",
  D: "Diamonds",
  C: "Clubs",
};

const RANK_NAMES: Readonly<Record<Rank, string>> = {
  A: "Ace",
  "2": "Two",
  "3": "Three",
  "4": "Four",
  "5": "Five",
  "6": "Six",
  "7": "Seven",
  "8": "Eight",
  "9": "Nine",
  "10": "Ten",
  J: "Jack",
  Q: "Queen",
  K: "King",
};

/** Accessibility label, e.g. "Ace of Spades". Suit is never colour-only. */
export function cardAccessibilityLabel(card: Card): string {
  return `${RANK_NAMES[card.rank]} of ${SUIT_NAMES[card.suit]}`;
}

/** The spoken rank alone, e.g. "Six", for announcements like "Dealer shows six." */
export function rankName(rank: Rank): string {
  return RANK_NAMES[rank];
}

/** Compact debug/log form, e.g. "AS". Not for user-facing display. */
export function cardShorthand(card: Card): string {
  return `${card.rank}${card.suit}`;
}

/**
 * Parses shorthand like "AS" or "10H" into a card. TEST AND TOOLING ONLY —
 * production shoes always come from `buildDecks` + a shuffle.
 */
export function parseCardShorthand(shorthand: string, deckIndex = 0, idSuffix = ""): Card {
  const match = /^(10|[AJQK2-9])([SHDC])$/.exec(shorthand.toUpperCase());
  if (!match) {
    throw new Error(`Unparseable card shorthand: "${shorthand}"`);
  }
  const rank = match[1] as Rank;
  const suit = match[2] as Suit;
  return { id: `d${deckIndex}-${rank}${suit}${idSuffix}`, suit, rank, deckIndex };
}
