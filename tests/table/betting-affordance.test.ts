import { describe, expect, it } from "vitest";

import {
  canDealStagedBet,
  describeWaiting,
} from "../../src/features/table/betting-affordance.js";
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

  /**
   * A tournament bets one seat at a time, and the engine answers NO_ACTIONS to
   * every seat but the current bettor. Chips can still be staged locally — the
   * tray is a client-side pile until Deal is pressed — so without this the
   * three waiting players would each be offered a Deal the server can only
   * refuse.
   */
  it("does not offer Deal to a seat whose turn to bet has not arrived", () => {
    const notMyTurn = betting({ canPlaceBet: false, canLockBet: false, betBounds: null });
    expect(canDealStagedBet(notMyTurn, 0)).toBe(false);
    expect(canDealStagedBet(notMyTurn, 500)).toBe(false);
  });
});

/**
 * The caption a seat with no control is shown.
 *
 * "Waiting for another player." was true and useless once the Sprint Tournament
 * started betting one seat at a time: the whole reason the format bets in turn
 * is that you WATCH the bets go in, and a caption that does not say a bet is
 * being placed hides the mechanic.
 */
describe("what a waiting seat is told", () => {
  it("names the player who is betting, when one is", () => {
    expect(
      describeWaiting({ phase: "BETTING_OPEN", activeSeatId: "s2", activeSeatName: "Ada" }),
    ).toBe("Ada is betting.");
  });

  it("says a bet is being placed even when the name is missing", () => {
    expect(
      describeWaiting({ phase: "BETTING_OPEN", activeSeatId: "s2", activeSeatName: null }),
    ).toBe("Another player is betting.");
  });

  it("still says what it always said when nobody is active", () => {
    expect(
      describeWaiting({ phase: "HAND_COMPLETE", activeSeatId: null, activeSeatName: null }),
    ).toBe("Waiting for the next hand.");
  });

  it("keeps the general wording for a turn that is not a bet", () => {
    expect(
      describeWaiting({ phase: "PLAYER_TURNS", activeSeatId: "s3", activeSeatName: "Ada" }),
    ).toBe("Waiting for another player.");
  });
});
