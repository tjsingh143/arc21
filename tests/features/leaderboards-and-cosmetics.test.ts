/**
 * Reading leaderboards and the cosmetic inventory on the client.
 *
 * The two things a player would be actively misled by, and so the two these
 * guard:
 *
 *   - a value rendered in the wrong units. Accuracy arrives in basis points
 *     because no float touches a compared figure, and printing 8,734 raw would
 *     read as a score rather than 87.34%;
 *   - a locked item that looks purchasable. There is nothing to buy, so the copy
 *     under a locked item is a requirement and never a price.
 */

import { describe, expect, it } from "vitest";

import {
  CATEGORY_COPY,
  LEADERBOARD_CATEGORIES,
  describePosition,
  nextPageRequest,
  PAGE_SIZE,
  pageWasLast,
  formatValue,
  toEntries,
  toPosition,
} from "../../src/features/leaderboards/index.js";
import {
  KIND_TABS,
  canEquip,
  itemsOfKind,
  lockedLabel,
  summarise,
  toItems,
  type CosmeticItem,
} from "../../src/features/cosmetics/index.js";

const ROW = {
  rank: 1,
  display_name: "player_one",
  avatar_asset_key: "avatar/house_dealer",
  value: 8_734,
  detail: "412 decisions",
  is_you: false,
};

describe("reading a board", () => {
  it("parses a list", () => {
    expect(toEntries([ROW, { ...ROW, rank: 2 }])).toHaveLength(2);
  });

  it("drops a row it cannot read rather than half-rendering it", () => {
    // A board with a gap is recoverable. A board with an invented rank is not —
    // a player would read it as their real position.
    expect(toEntries([ROW, { rank: "second" }])).toHaveLength(1);
  });

  it("returns nothing for a non-list", () => {
    expect(toEntries(null)).toEqual([]);
    expect(toEntries({ rank: 1 })).toEqual([]);
  });

  it("carries no account identifier", () => {
    // The server's projection has no user id and no email in it. Asserted here so
    // a future widening of the row shape fails a test rather than shipping.
    const parsed = toEntries([ROW])[0]!;
    expect(Object.keys(parsed).sort()).toEqual([
      "avatar_asset_key",
      "detail",
      "display_name",
      "is_you",
      "rank",
      "value",
    ]);
  });

  it("tolerates a player with no avatar equipped", () => {
    const parsed = toEntries([{ ...ROW, avatar_asset_key: null }]);
    expect(parsed).toHaveLength(1);
    expect(parsed[0]?.avatar_asset_key).toBeNull();
  });
});

describe("formatting a value in the units it is actually in", () => {
  it("renders accuracy basis points as a percentage", () => {
    expect(formatValue("strategy_accuracy", 8_734)).toBe("87.34%");
    expect(formatValue("strategy_accuracy", 10_000)).toBe("100.00%");
  });

  it("keeps two decimal places, including a trailing zero", () => {
    // 9,000 is 90.00%, not 90.0% and certainly not 90%. Dropping the digit would
    // make two different accuracies render identically.
    expect(formatValue("strategy_accuracy", 9_000)).toBe("90.00%");
    expect(formatValue("strategy_accuracy", 9_005)).toBe("90.05%");
  });

  it("counts tournament wins in words a person would use", () => {
    expect(formatValue("tournament_wins", 1)).toBe("1 win");
    expect(formatValue("tournament_wins", 4)).toBe("4 wins");
  });

  it("labels XP", () => {
    expect(formatValue("weekly_xp", 1_240)).toBe("1,240 XP");
  });

  it("leaves a daily score as a plain figure", () => {
    expect(formatValue("daily_challenge", 6_400)).toBe("6,400");
  });
});

describe("what a player outside the top 100 is told", () => {
  it("states their place when the server reported one", () => {
    const position = toPosition({ rank: 142, value: 8_100, detail: null, total_ranked: 900 });
    expect(describePosition("strategy_accuracy", position)).toBe(
      "You are 142 of 900 with 81.00%.",
    );
  });

  it("says nothing rather than inventing a rank", () => {
    // "Not on this board" is a worse answer than a rank, and a made-up rank is
    // worse than either.
    expect(describePosition("weekly_xp", null)).toBeNull();
    expect(toPosition(null)).toBeNull();
    expect(toPosition({ rank: 0 })).toBeNull();
  });
});

describe("the boards on offer", () => {
  it("is the specification's four", () => {
    expect([...LEADERBOARD_CATEGORIES]).toEqual([
      "weekly_xp",
      "tournament_wins",
      "strategy_accuracy",
      "daily_challenge",
    ]);
  });

  it("does not include global bankroll", () => {
    // "Do not make global bankroll the flagship leaderboard." It is not a board
    // here at all, which is stronger than not being the flagship.
    expect(LEADERBOARD_CATEGORIES as readonly string[]).not.toContain("bankroll");
    expect(LEADERBOARD_CATEGORIES as readonly string[]).not.toContain("chips");
  });

  it("explains what an empty board means, for every board", () => {
    // An empty leaderboard must read as "nobody has qualified", never as broken.
    for (const category of LEADERBOARD_CATEGORIES) {
      expect(CATEGORY_COPY[category].emptyReason.length).toBeGreaterThan(10);
      expect(CATEGORY_COPY[category].purpose.length).toBeGreaterThan(10);
    }
  });

  it("says which modes the accuracy board counts", () => {
    expect(CATEGORY_COPY.strategy_accuracy.purpose).toMatch(/Practice.*excluded|excluded/i);
  });

  it("says when the weekly board resets", () => {
    expect(CATEGORY_COPY.weekly_xp.purpose).toMatch(/Monday/);
  });
});

// ---------------------------------------------------------------------------

const ITEM: CosmeticItem = {
  cosmetic_id: "11111111-1111-4111-8111-111111111111",
  code: "avatar-apprentice",
  kind: "avatar",
  name: "Apprentice",
  description: "Earned on the way up.",
  asset_key: "avatar/apprentice",
  owned: false,
  equipped: false,
  unlock_type: "level",
  requirement: "Reach level 3",
  sort_order: 3,
};

/**
 * Paging a board.
 *
 * The predicates rather than the store, because what goes wrong here is a
 * CONTROL: a "Load more" that fires twice appends the same page twice, and one
 * that never stops asks the server for an empty page for ever. This project has
 * been bitten by testing the function behind a button instead of whether the
 * button could be pressed — `betting-affordance.ts` is the shape.
 */
describe("paging a leaderboard", () => {
  it("keeps asking while a full page comes back", () => {
    expect(pageWasLast(PAGE_SIZE)).toBe(false);
  });

  it("stops on a short page, without a further round trip to discover it", () => {
    expect(pageWasLast(PAGE_SIZE - 1)).toBe(true);
    expect(pageWasLast(0)).toBe(true);
  });

  it("asks for the next page starting where the last one ended", () => {
    expect(nextPageRequest({ loaded: 25, hasMore: true, busy: false })).toEqual({
      limit: PAGE_SIZE,
      offset: 25,
    });
    expect(nextPageRequest({ loaded: 50, hasMore: true, busy: false })?.offset).toBe(50);
  });

  it("asks for nothing once the board has run out", () => {
    expect(nextPageRequest({ loaded: 12, hasMore: false, busy: false })).toBeNull();
  });

  it("asks for nothing while a page is already in flight", () => {
    // Two taps on "Load more" would otherwise fetch the same offset twice and
    // append it twice — a duplicated block of rows, not a missing one, which is
    // the harder kind to notice.
    expect(nextPageRequest({ loaded: 25, hasMore: true, busy: true })).toBeNull();
  });
});

describe("reading the inventory", () => {
  it("parses a catalogue row", () => {
    const items = toItems([ITEM]);
    expect(items).toHaveLength(1);
    expect(items[0]?.requirement).toBe("Reach level 3");
  });

  it("drops a row it cannot read", () => {
    // Showing an item whose ownership could not be parsed would either tease
    // something owned or hide something earned.
    expect(toItems([ITEM, { code: "broken" }])).toHaveLength(1);
    expect(toItems(null)).toEqual([]);
  });

  it("offers the specification's three tabs, in its order", () => {
    expect(KIND_TABS.map((tab) => tab.kind)).toEqual(["avatar", "card_back", "table_theme"]);
    expect(KIND_TABS.map((tab) => tab.label)).toEqual(["Avatar", "Cards", "Table"]);
  });

  it("groups and sorts by kind", () => {
    const items = toItems([
      { ...ITEM, cosmetic_id: "aaaaaaaa-1111-4111-8111-111111111111", sort_order: 9 },
      { ...ITEM, cosmetic_id: "bbbbbbbb-1111-4111-8111-111111111111", sort_order: 1 },
      { ...ITEM, cosmetic_id: "cccccccc-1111-4111-8111-111111111111", kind: "card_back" },
    ]);
    const avatars = itemsOfKind(items, "avatar");
    expect(avatars.map((item) => item.sort_order)).toEqual([1, 9]);
    expect(itemsOfKind(items, "card_back")).toHaveLength(1);
    expect(itemsOfKind(items, "table_theme")).toHaveLength(0);
  });

  it("counts owned against total for a kind", () => {
    const items = toItems([
      { ...ITEM, cosmetic_id: "aaaaaaaa-2222-4222-8222-222222222222", owned: true },
      { ...ITEM, cosmetic_id: "bbbbbbbb-2222-4222-8222-222222222222", owned: false },
      { ...ITEM, cosmetic_id: "cccccccc-2222-4222-8222-222222222222", kind: "card_back", owned: true },
    ]);
    expect(summarise(items, "avatar")).toEqual({ owned: 1, total: 2 });
    expect(summarise(items, "card_back")).toEqual({ owned: 1, total: 1 });
  });
});

describe("a locked item", () => {
  it("shows what to do, in the server's words", () => {
    expect(lockedLabel(ITEM)).toBe("Reach level 3");
  });

  it("never shows a price, because there is nothing to buy", () => {
    // The specification: no purchase price in the MVP, and no Shop route. The
    // requirement string comes from the server and describes an action.
    for (const requirement of [
      "Reach level 3",
      "Win a Sprint Tournament",
      "Finish 7 daily challenges in a row",
      "Complete every node in Foundations",
    ]) {
      const label = lockedLabel({ ...ITEM, requirement });
      expect(label).not.toMatch(/\bbuy\b|\bprice\b|\bcost\b|[$£€]|\bchips\b/i);
    }
  });

  it("falls back to a plain statement rather than an empty line", () => {
    expect(lockedLabel({ ...ITEM, requirement: null })).toBe("Not yet available");
  });
});

describe("equipping", () => {
  it("is offered for something owned and not already on", () => {
    expect(canEquip({ ...ITEM, owned: true, equipped: false })).toBe(true);
  });

  it("is not offered for something already equipped", () => {
    expect(canEquip({ ...ITEM, owned: true, equipped: true })).toBe(false);
  });

  it("is not offered for something locked", () => {
    // The server refuses it at the loadout trigger anyway; this is about not
    // showing a control that would fail.
    expect(canEquip({ ...ITEM, owned: false })).toBe(false);
  });
});
