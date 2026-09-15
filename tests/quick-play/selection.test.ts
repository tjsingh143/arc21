/**
 * Remembering the Quick Play selection, and refusing to guess at a broken one.
 *
 * The specification asks for setup on the first authenticated Quick Play and
 * one tap afterwards, so the tier and the assistance mode are persisted. The
 * tier decides how many chips leave the wallet, which is why a stored value
 * that is not one of the known ids is DROPPED rather than repaired: repairing
 * it would be guessing with somebody's money, and setup is a perfectly good
 * answer to "we do not know what you chose".
 */

import { beforeEach, describe, expect, it } from "vitest";

import { MemoryKeyValueStore } from "../../src/lib/persistence/key-value-store.js";
import {
  DEFAULT_SELECTION,
  parseSelection,
  setQuickPlayStorage,
  useQuickPlayStore,
} from "../../src/features/quick-play/quick-play-store.js";

beforeEach(() => {
  setQuickPlayStorage(new MemoryKeyValueStore());
  useQuickPlayStore.setState({ remembered: null, loaded: false, opening: false, notice: null });
});

describe("parsing a stored selection", () => {
  it("accepts each of the three tiers and the four assistance modes", () => {
    for (const tier of ["casual", "standard", "high"]) {
      for (const assistance of ["play", "learn", "analysis", "challenge"]) {
        expect(parseSelection(JSON.stringify({ tier, assistance }))).toEqual({ tier, assistance });
      }
    }
  });

  it("drops a tier it does not recognise rather than falling back to one", () => {
    // "whale" is not a tier. Substituting Casual would silently deal a
    // different table from the one the stored value asked for; substituting
    // High would spend ten times as much.
    expect(parseSelection(JSON.stringify({ tier: "whale", assistance: "play" }))).toBeNull();
  });

  it("drops an assistance mode it does not recognise", () => {
    expect(parseSelection(JSON.stringify({ tier: "casual", assistance: "godmode" }))).toBeNull();
  });

  it("drops a partial record", () => {
    expect(parseSelection(JSON.stringify({ tier: "casual" }))).toBeNull();
    expect(parseSelection(JSON.stringify({ assistance: "play" }))).toBeNull();
  });

  it("survives anything that is not JSON at all", () => {
    expect(parseSelection("not json")).toBeNull();
    expect(parseSelection("")).toBeNull();
    expect(parseSelection(null)).toBeNull();
  });
});

describe("remembering across launches", () => {
  it("loads nothing the first time, so the screen opens setup", async () => {
    await useQuickPlayStore.getState().load();
    expect(useQuickPlayStore.getState().remembered).toBeNull();
    expect(useQuickPlayStore.getState().loaded).toBe(true);
  });

  it("returns what was remembered", async () => {
    await useQuickPlayStore.getState().remember({ tier: "standard", assistance: "challenge" });

    // A fresh store reading the same storage, which is what a relaunch is.
    useQuickPlayStore.setState({ remembered: null, loaded: false });
    await useQuickPlayStore.getState().load();

    expect(useQuickPlayStore.getState().remembered).toEqual({
      tier: "standard",
      assistance: "challenge",
    });
  });

  it("keeps the selection for this session even when storage refuses", async () => {
    setQuickPlayStorage({
      get: async () => null,
      set: async () => {
        throw new Error("disk full");
      },
      remove: async () => undefined,
    });

    // Failing the deal over a preference that could not be saved would be
    // absurd. The selection still applies; it just will not survive a relaunch.
    await useQuickPlayStore.getState().remember({ tier: "high", assistance: "analysis" });
    expect(useQuickPlayStore.getState().remembered).toEqual({
      tier: "high",
      assistance: "analysis",
    });
  });

  it("opens setup when storage never answers", async () => {
    setQuickPlayStorage({
      get: async () => {
        throw new Error("no storage");
      },
      set: async () => undefined,
      remove: async () => undefined,
    });

    await useQuickPlayStore.getState().load();
    expect(useQuickPlayStore.getState().remembered).toBeNull();
    expect(useQuickPlayStore.getState().loaded).toBe(true);
  });
});

describe("the default", () => {
  it("is the cheapest table and no assistance", () => {
    // The cheapest, so a first Quick Play cannot be a 20,000-chip surprise; and
    // unassisted, so a player who never touches the selector is on the ranked
    // board rather than quietly off it.
    expect(DEFAULT_SELECTION).toEqual({ tier: "casual", assistance: "play" });
  });
});
