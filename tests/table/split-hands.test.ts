/**
 * A split must be readable at all three tables, not just the one.
 *
 * THE DEFECT. Splitting is legal everywhere in this product, up to four hands,
 * and the three screens that deal cards handled it three different ways:
 *
 *   Practice   a chip row plus the active hand at hero size — correct
 *   Career     the active hand alone, no row: after a split, the other hands'
 *              totals, wagers and bust status were not on screen at all
 *   Online     EVERY hand at hero size, stacked vertically
 *
 * The online case reaches the most players — Quick Play, public tables, private
 * tables, tournaments and the daily challenge all render `/table/[gameId]` —
 * and is the least usable: `HandCards` at hero size is the largest thing the
 * felt draws, and four of them stacked do not fit a phone in portrait. Which
 * hand the dock was about to act on was carried by a one-pixel border.
 *
 * The presentation now lives in one module. These tests assert its rules; the
 * screens are checked for using it, with the same source-reading caveat
 * `leave-confirmation.test.ts` and `surface-card-test-id.test.ts` carry — RN
 * does not parse under Node, so this proves the module is wired in, not that
 * the tree renders it. That part is a Maestro job.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  describeSplitHand,
  describeSplitHands,
  focusedSplitHandId,
  isSettledHand,
  splitHandFromEngineHand,
  type SplitHandInput,
} from "../../src/features/table/split-hands.js";
import type { PlayerHand } from "../../shared/blackjack/types.js";

function hand(overrides: Partial<SplitHandInput> & { id: string }): SplitHandInput {
  return { total: 17, isSoft: false, status: "ACTIVE", ...overrides };
}

const SCREENS = {
  online: "../../app/table/[gameId].tsx",
  career: "../../app/career/play/[slug].tsx",
  practice: "../../app/game/practice.tsx",
} as const;

function screenSource(key: keyof typeof SCREENS): string {
  return readFileSync(fileURLToPath(new URL(SCREENS[key], import.meta.url)), "utf8");
}

describe("the sources these tests read", () => {
  it("were actually found", () => {
    for (const key of Object.keys(SCREENS) as (keyof typeof SCREENS)[]) {
      expect(screenSource(key).length, key).toBeGreaterThan(1_000);
    }
  });
});

describe("the chip row", () => {
  it("is empty for a single hand, so an ordinary hand looks ordinary", () => {
    expect(describeSplitHands({ hands: [hand({ id: "h1" })], activeHandId: "h1" })).toEqual([]);
    expect(describeSplitHands({ hands: [], activeHandId: null })).toEqual([]);
  });

  it("names every hand of a four-way split", () => {
    const hands = ["h1", "h2", "h3", "h4"].map((id) => hand({ id }));
    const chips = describeSplitHands({ hands, activeHandId: "h3" });

    expect(chips).toHaveLength(4);
    expect(chips.map((chip) => chip.ordinal)).toEqual([1, 2, 3, 4]);
    expect(chips.map((chip) => chip.active)).toEqual([false, false, true, false]);
  });

  it("marks exactly one hand active, and none between hands", () => {
    const hands = [hand({ id: "h1" }), hand({ id: "h2" })];
    expect(describeSplitHands({ hands, activeHandId: "h2" }).filter((c) => c.active)).toHaveLength(1);
    expect(describeSplitHands({ hands, activeHandId: null }).filter((c) => c.active)).toHaveLength(0);
  });
});

describe("what a chip says", () => {
  it("shows the total for a live hand", () => {
    const chip = describeSplitHand({
      hand: hand({ id: "h1", total: 16 }),
      index: 0,
      count: 2,
      active: true,
    });
    expect(chip.label).toBe("Hand 1 · 16");
  });

  it("shows the STATUS rather than the total for a settled hand", () => {
    /*
     * "Hand 2 · 21" beside a dealer blackjack reads as a win. What a finished
     * hand needs to say is what happened to it.
     */
    const busted = describeSplitHand({
      hand: hand({ id: "h1", total: 24, status: "BUSTED" }),
      index: 1,
      count: 2,
      active: false,
    });
    expect(busted.label).toBe("Hand 2 · Bust");
    expect(busted.settled).toBe(true);

    const surrendered = describeSplitHand({
      hand: hand({ id: "h2", total: 16, status: "SURRENDERED" }),
      index: 0,
      count: 2,
      active: false,
    });
    expect(surrendered.label).toBe("Hand 1 · Surrendered");
  });

  it("keeps the total for a hand that stood or doubled", () => {
    // These are the cases where the number IS the useful thing.
    for (const status of ["STOOD", "DOUBLED_COMPLETE", "TWENTY_ONE"] as const) {
      const chip = describeSplitHand({
        hand: hand({ id: "h1", total: 20, status }),
        index: 0,
        count: 2,
        active: false,
      });
      expect(chip.label, status).toBe("Hand 1 · 20");
      expect(chip.settled, status).toBe(true);
    }
  });

  it("says a dash for a hand holding no cards", () => {
    const chip = describeSplitHand({
      hand: hand({ id: "h1", total: null }),
      index: 0,
      count: 2,
      active: false,
    });
    expect(chip.label).toBe("Hand 1 · —");
  });
});

describe("what a screen reader hears", () => {
  it("carries the position AND the count", () => {
    // "Hand 2" alone tells you what you are looking at, not where you are.
    const chip = describeSplitHand({
      hand: hand({ id: "h2", total: 17, isSoft: true }),
      index: 1,
      count: 3,
      active: true,
    });
    expect(chip.accessibilityLabel).toBe("Hand 2 of 3, soft 17, active");
  });

  it("says hard or soft, matching what the hand beside it says", () => {
    const hard = describeSplitHand({
      hand: hand({ id: "h1", total: 16, isSoft: false }),
      index: 0,
      count: 2,
      active: false,
    });
    expect(hard.accessibilityLabel).toBe("Hand 1 of 2, hard 16");
  });

  it("only says active for the hand that is", () => {
    const chips = describeSplitHands({
      hands: [hand({ id: "h1" }), hand({ id: "h2" })],
      activeHandId: "h1",
    });
    expect(chips[0]!.accessibilityLabel).toMatch(/, active$/);
    expect(chips[1]!.accessibilityLabel).not.toMatch(/active/);
  });
});

describe("which hand gets the felt", () => {
  it("is the active one while a hand is being played", () => {
    expect(
      focusedSplitHandId({ hands: [{ id: "h1" }, { id: "h2" }], activeHandId: "h2" }),
    ).toBe("h2");
  });

  it("falls back to the first once every hand has settled", () => {
    // A settled split must still show something rather than collapsing to
    // nothing while the player reads the result.
    expect(
      focusedSplitHandId({ hands: [{ id: "h1" }, { id: "h2" }], activeHandId: null }),
    ).toBe("h1");
  });

  it("ignores an active id that names no hand at this seat", () => {
    // `activeHandId` is table-wide: at a shared table it usually names somebody
    // else's hand, and this seat must not blank itself when it does.
    expect(
      focusedSplitHandId({ hands: [{ id: "h1" }, { id: "h2" }], activeHandId: "someone-else" }),
    ).toBe("h1");
  });

  it("is null when there is no hand at all", () => {
    expect(focusedSplitHandId({ hands: [], activeHandId: null })).toBeNull();
  });
});

describe("mapping an engine hand", () => {
  const engineHand: PlayerHand = {
    id: "e1",
    cards: [
      { id: "c1", rank: "A", suit: "S", deckIndex: 0 },
      { id: "c2", rank: "6", suit: "H", deckIndex: 0 },
    ],
    wager: 100,
    status: "ACTIVE",
    cameFromSplit: false,
    cameFromSplitAces: false,
  };

  it("takes the total from the engine rather than recomputing one", () => {
    const mapped = splitHandFromEngineHand(engineHand, false);
    expect(mapped.total).toBe(17);
    expect(mapped.isSoft).toBe(true);
    expect(mapped.status).toBe("ACTIVE");
  });

  it("reports no total for a hand that has been dealt nothing", () => {
    const mapped = splitHandFromEngineHand({ ...engineHand, cards: [] }, false);
    expect(mapped.total).toBeNull();
  });
});

describe("settled", () => {
  it("is every status except ACTIVE", () => {
    expect(isSettledHand("ACTIVE")).toBe(false);
    for (const status of ["STOOD", "BUSTED", "SURRENDERED", "DOUBLED_COMPLETE", "BLACKJACK"] as const) {
      expect(isSettledHand(status), status).toBe(true);
    }
  });
});

describe("every table that deals cards", () => {
  it("draws the chip row from the shared module", () => {
    for (const key of Object.keys(SCREENS) as (keyof typeof SCREENS)[]) {
      expect(screenSource(key), key).toContain("<HandSelector");
      expect(screenSource(key), key).toContain("describeSplitHands");
    }
  });

  it("renders ONE hand at hero size, never a stack of them", () => {
    /*
     * The online screen's whole defect in one assertion. It used to map every
     * hand straight to `<HandCards size="hero">`; both server-driven screens
     * now gate that render on the focused id.
     */
    for (const key of ["online", "career"] as const) {
      expect(screenSource(key), key).toContain("focusedSplitHandId");
      expect(screenSource(key), key).toContain("hand.id === focusedHandId");
    }
  });

  it("shows the result of a hand once it has one", () => {
    // The career table settled hands and moved straight to "Next hand" — the
    // one screen whose purpose is teaching never said how the hand turned out.
    for (const key of Object.keys(SCREENS) as (keyof typeof SCREENS)[]) {
      expect(screenSource(key), key).toContain("<OutcomeBadge");
    }
  });
});
