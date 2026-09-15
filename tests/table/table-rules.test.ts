/**
 * A server table must state its own rules.
 *
 * THE DEFECT. `PublicGameState` has carried `rulesSummary`, `handNumber` and
 * `shoe` since the wire contract was written — the server sends all three so a
 * player can see the terms of the table they are sitting at — and
 * `app/table/[gameId].tsx` rendered none of them.
 *
 * The asymmetry is what makes it a defect rather than a preference. Practice
 * puts "Hand 3 · Shoe 1" in its header and Home advertises "Six decks, dealer
 * stands on soft 17, blackjack pays 3:2" on a card. Both of those are tables
 * whose rules the player already knows, because there is only one local
 * ruleset. The SERVER tables — Quick Play, public, private, tournament, daily —
 * are the ones where the rules are not the player's own choice, and they were
 * the ones that said nothing.
 *
 * The rules change the correct play and the house edge. A real table prints
 * them on the felt; a table that does not is asking to be taken on trust, which
 * is the one thing this product does not do anywhere else.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  describeTableProgress,
  describeTableRules,
} from "../../src/features/table/table-rules.js";
import { ARC_STANDARD_RULES } from "../../shared/blackjack/rules.js";

const ARC_STANDARD_SUMMARY = {
  deckCount: 6,
  dealerHitsSoft17: false,
  blackjackPayout: "3:2",
  surrenderAllowed: true,
  doubleAfterSplit: true,
} as const;

const tableScreen = readFileSync(
  fileURLToPath(new URL("../../app/table/[gameId].tsx", import.meta.url)),
  "utf8",
);

describe("the source this test reads", () => {
  it("was actually found", () => {
    expect(tableScreen).toContain("export default function SharedTable");
  });
});

describe("the rules line", () => {
  it("names every rule that changes the correct play", () => {
    const line = describeTableRules(ARC_STANDARD_SUMMARY);
    expect(line).toBe(
      "6 decks · dealer stands soft 17 · blackjack pays 3:2 · double after split · late surrender",
    );
  });

  it("states each clause in BOTH directions rather than omitting it", () => {
    /*
     * A missing clause is indistinguishable from a clause nobody wrote, and the
     * player cannot tell which they are looking at. "no surrender" is
     * information; silence is not.
     */
    const line = describeTableRules({
      deckCount: 8,
      dealerHitsSoft17: true,
      blackjackPayout: "6:5",
      surrenderAllowed: false,
      doubleAfterSplit: false,
    });
    expect(line).toContain("dealer hits soft 17");
    expect(line).toContain("no double after split");
    expect(line).toContain("no surrender");
    expect(line).toContain("blackjack pays 6:5");
  });

  it("reads the payout from the snapshot rather than assuming 3:2", () => {
    // The fastest way for a fairness claim to become a lie is to type it.
    expect(describeTableRules({ ...ARC_STANDARD_SUMMARY, blackjackPayout: "6:5" })).not.toContain(
      "3:2",
    );
  });

  it("agrees with the engine's own ruleset for an Arc Standard table", () => {
    // Guards the summary drifting from the rules it claims to describe.
    expect(ARC_STANDARD_SUMMARY.deckCount).toBe(ARC_STANDARD_RULES.deckCount);
    expect(ARC_STANDARD_SUMMARY.dealerHitsSoft17).toBe(ARC_STANDARD_RULES.dealerHitsSoft17);
  });
});

describe("the progress line", () => {
  it("names the hand and the shoe, as Practice always has", () => {
    expect(describeTableProgress({ handNumber: 4, shoe: { shuffleNumber: 2 } })).toBe(
      "Hand 4 · Shoe 2",
    );
  });

  it("carries the shuffle number, which is what makes a reshuffle observable", () => {
    // Fair Play describes the mechanism. This is where it is visible: the
    // number increments when the cards are replaced, so a player can see it
    // happen rather than being told it does.
    const before = describeTableProgress({ handNumber: 30, shoe: { shuffleNumber: 1 } });
    const after = describeTableProgress({ handNumber: 31, shoe: { shuffleNumber: 2 } });
    expect(before).not.toBe(after);
    expect(after).toContain("Shoe 2");
  });
});

describe("the shared table screen", () => {
  it("renders both lines from the snapshot", () => {
    expect(tableScreen).toContain("describeTableRules(table.rulesSummary)");
    expect(tableScreen).toContain("describeTableProgress(table)");
  });

  it("shows the player their OWN stack, not only everyone else's", () => {
    /*
     * Every other seat rendered `formatChips(other.stack)`. This seat rendered
     * its stack only inside `BettingBar`'s "Available" — so from the deal until
     * the next betting round the player could see four other people's chips and
     * not their own.
     */
    expect(tableScreen).toContain('testID="table-my-stack"');
  });
});
