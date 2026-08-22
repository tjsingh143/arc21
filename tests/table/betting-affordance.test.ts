import { describe, expect, it } from "vitest";

import { canDealStagedBet } from "../../src/features/table/betting-affordance.js";
import type { LegalActionSet } from "../../shared/blackjack/legal-actions.js";

/** A betting-phase legal set. Spelled out rather than exporting an engine internal. */
function betting(overrides: Partial<LegalActionSet> = {}): LegalActionSet {
  return {
    actions: [],
    chipCost: {},
    canPlaceBet: true,
    canLockBet: false,
    betBounds: { min: 10, max: 1_000, increment: 10 },
    canTakeInsurance: false,
    canDeclineInsurance: false,
    insuranceStake: null,
    insuranceIsEvenMoney: false,
    canStartNextHand: false,
    ...overrides,
  };
}

/**
 * The regression this file exists for: at a server-authoritative table the
 * engine holds no bet until Deal is pressed, so gating Deal on the engine's
 * bet made it permanently unpressable and no online table could take a wager.
 * See `betting-affordance.ts`.
 */
describe("offering Deal for a staged bet", () => {
  it("offers Deal for a legal staged bet even though the engine holds none", () => {
    // canLockBet is false because seat.originalBet is 0 — nothing has been
    // sent to the server yet. This is EVERY online table before the first bet.
    const legal = betting({ canLockBet: false });
    expect(canDealStagedBet(legal, 100)).toBe(true);
  });

  it("does not offer Deal with nothing staged", () => {
    expect(canDealStagedBet(betting({ canLockBet: false }), 0)).toBe(false);
  });

  it("does not offer Deal below the table minimum or above its maximum", () => {
    const legal = betting({ canLockBet: false });
    expect(canDealStagedBet(legal, 5)).toBe(false);
    expect(canDealStagedBet(legal, 1_001)).toBe(false);
    expect(canDealStagedBet(legal, 10)).toBe(true);
    expect(canDealStagedBet(legal, 1_000)).toBe(true);
  });

  it("still offers Deal when the engine already holds a lockable bet", () => {
    // The practice path: addChip applied PLACE_BET locally, so the engine has
    // the bet and `stagedBet` has already been cleared or not yet set.
    expect(canDealStagedBet(betting({ canLockBet: true }), 0)).toBe(true);
  });

  it("falls back to 'something is staged' when the table states no bounds", () => {
    const legal = betting({ canLockBet: false, betBounds: null });
    expect(canDealStagedBet(legal, 0)).toBe(false);
    expect(canDealStagedBet(legal, 25)).toBe(true);
  });
});
