/**
 * Reading the equipped loadout.
 *
 * The invariant: this NEVER produces a gap. Whatever the server sends — no
 * rows, empty slots, a malformed row, an asset key this build has no art for —
 * every slot resolves to a renderable key, because a table drawn with a blank
 * card back is a defect while a table drawn with the default is a look.
 */

import { describe, expect, it } from "vitest";

import {
  DEFAULT_LOADOUT,
  DEFAULT_ASSET_KEYS,
  toLoadout,
} from "../../src/features/cosmetics/index.js";

describe("toLoadout", () => {
  it("resolves an empty answer to the full default loadout", () => {
    expect(toLoadout([])).toEqual(DEFAULT_LOADOUT);
    expect(toLoadout(null)).toEqual(DEFAULT_LOADOUT);
    expect(toLoadout(undefined)).toEqual(DEFAULT_LOADOUT);
  });

  it("applies an equipped key to its slot and defaults the rest", () => {
    const loadout = toLoadout([{ slot: "card_back", asset_key: "card_backs/slate" }]);
    expect(loadout.cardBackKey).toBe("card_backs/slate");
    expect(loadout.avatarKey).toBe(DEFAULT_ASSET_KEYS.avatar);
    expect(loadout.tableThemeKey).toBe(DEFAULT_ASSET_KEYS.table_theme);
  });

  it("reads all three slots together", () => {
    const loadout = toLoadout([
      { slot: "avatar", asset_key: "avatars/laurel" },
      { slot: "card_back", asset_key: "card_backs/podium" },
      { slot: "table_theme", asset_key: "tables/midnight" },
    ]);
    expect(loadout).toEqual({
      avatarKey: "avatars/laurel",
      cardBackKey: "card_backs/podium",
      tableThemeKey: "tables/midnight",
    });
  });

  it("treats a slot equipped with nothing as the default", () => {
    const loadout = toLoadout([{ slot: "avatar", asset_key: null }]);
    expect(loadout.avatarKey).toBe(DEFAULT_ASSET_KEYS.avatar);
  });

  it("falls back to the default for an asset key this build cannot draw", () => {
    // The catalogue can gain an item before the app that renders it ships.
    // Equipping it must not blank the slot on older builds.
    const loadout = toLoadout([{ slot: "avatar", asset_key: "avatars/not_yet_drawn" }]);
    expect(loadout.avatarKey).toBe(DEFAULT_ASSET_KEYS.avatar);
  });

  it("ignores a key aimed at the wrong slot", () => {
    // The server's loadout trigger already refuses a wrong-kind equip; this is
    // the client refusing to render a table theme as a card back if a row ever
    // arrived mangled.
    const loadout = toLoadout([{ slot: "card_back", asset_key: "tables/midnight" }]);
    expect(loadout.cardBackKey).toBe(DEFAULT_ASSET_KEYS.card_back);
  });

  it("drops a row it cannot read rather than failing the whole loadout", () => {
    const loadout = toLoadout([
      { slot: "hat", asset_key: "avatars/laurel" },
      { slot: "avatar", asset_key: "avatars/laurel" },
    ]);
    expect(loadout.avatarKey).toBe("avatars/laurel");
  });
});
