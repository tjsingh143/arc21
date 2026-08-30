/**
 * The table's rules, and where the shoe is, as one line each.
 *
 * THE DEFECT THIS CLOSES. `PublicGameState` has carried `rulesSummary`,
 * `handNumber` and `shoe` since the contract was written — the server sends
 * them precisely so a player can see the terms of the table they are sitting
 * at — and `app/table/[gameId].tsx` rendered none of the three. Practice puts
 * "Hand 3 · Shoe 1" in its header and Home advertises "six decks, dealer stands
 * on soft 17, blackjack pays 3:2" on a card; the SERVER tables, which are the
 * ones where the rules are not the player's own choice, said nothing at all.
 *
 * That is a Fair Play issue rather than a cosmetic one. A blackjack table
 * states its rules on the felt because the rules change the correct play and
 * the house edge; a table that does not is asking the player to take them on
 * trust — which is the one thing this product does not do anywhere else.
 *
 * Derived rather than typed. `docs/RESPONSIBLE_PLAY.md`'s sibling rule applies:
 * "the fastest way for a fairness page to become a lie is for someone to type
 * six decks into a paragraph". Every value below comes from the snapshot.
 *
 * Runtime-neutral: no React, React Native or Expo import.
 */

import type { PublicGameState } from "../../../shared/blackjack/public-state.js";

/**
 * "6 decks · dealer stands soft 17 · blackjack pays 3:2 · double after split ·
 * late surrender".
 *
 * Every clause is stated in BOTH directions — "no double after split" rather
 * than an omission — because a missing clause is indistinguishable from a
 * clause nobody wrote, and the player cannot tell which they are looking at.
 */
export function describeTableRules(summary: PublicGameState["rulesSummary"]): string {
  return [
    `${summary.deckCount} decks`,
    summary.dealerHitsSoft17 ? "dealer hits soft 17" : "dealer stands soft 17",
    `blackjack pays ${summary.blackjackPayout}`,
    summary.doubleAfterSplit ? "double after split" : "no double after split",
    summary.surrenderAllowed ? "late surrender" : "no surrender",
  ].join(" · ");
}

/**
 * "Hand 4 · Shoe 2", the same line Practice has always carried in its header.
 *
 * The shoe number is what makes the shuffle observable: it increments on every
 * reshuffle, so a player can see that the cards were replaced rather than being
 * told so. Fair Play describes the mechanism; this is where it is visible.
 */
export function describeTableProgress(state: {
  handNumber: number;
  shoe: { shuffleNumber: number };
}): string {
  return `Hand ${state.handNumber} · Shoe ${state.shoe.shuffleNumber}`;
}
