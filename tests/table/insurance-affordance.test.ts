/**
 * The insurance offer at a SERVER table.
 *
 * THE DEFECT. `INSURANCE` and `DECLINE_INSURANCE` are engine commands, they are
 * in `COMMAND_TYPES` on the wire, `game-command` applies them, and every
 * daily-challenge attempt in `tests/server` sends `DECLINE_INSURANCE`. And no
 * client could send either at a server table: `InsuranceSheet` was mounted only
 * by `app/game/practice.tsx` and `app/career/play/[slug].tsx`, both driving the
 * LOCAL engine, and `app/table/[gameId].tsx` had no insurance branch at all.
 * Its `myTurn` check reads `activeSeatId`, which is null during the offer
 * because insurance is not a turn — so the screen fell through to "Waiting for
 * the next hand." and stayed there until the deadline expired.
 *
 * Nobody was wrongly charged: the timeout DECLINES, which is the stated
 * default. Insurance was simply unreachable at Quick Play, public, private,
 * tournament and daily tables alike.
 *
 * Same shape as `betting-affordance.test.ts`, and for the reason in CLAUDE.md:
 * testing the function a dead control would have called proves the function.
 */

import { describe, expect, it } from "vitest";

import type { LegalActionSet } from "../../shared/blackjack/legal-actions.js";
import { insuranceOffer } from "../../src/features/table/insurance-affordance.js";

function legal(overrides: Partial<LegalActionSet> = {}): LegalActionSet {
  return {
    actions: [],
    chipCost: {},
    canPlaceBet: false,
    canLockBet: false,
    betBounds: null,
    canTakeInsurance: true,
    canDeclineInsurance: true,
    insuranceStake: 50,
    insuranceIsEvenMoney: false,
    ...overrides,
  } as LegalActionSet;
}

describe("the insurance offer", () => {
  it("is offered during the offer phase to a seat that has not answered", () => {
    expect(insuranceOffer("INSURANCE_OFFER", legal())).toEqual({
      stake: 50,
      isEvenMoney: false,
      canAfford: true,
    });
  });

  /**
   * The PHASE check, and it is not redundant with the seat's own flags. Leaving
   * the sheet up on the Modal's `visible` prop alone rendered "Insurance costs
   * 0 chips" once the phase advanced, because the stake is defined only while
   * the offer is live.
   */
  it("is not offered in any other phase", () => {
    for (const phase of [
      "BETTING_OPEN",
      "DEALING",
      "PLAYER_TURNS",
      "DEALER_TURN",
      "SETTLEMENT",
      "HAND_COMPLETE",
      "SESSION_COMPLETE",
    ]) {
      expect(insuranceOffer(phase, legal())).toBeNull();
    }
  });

  /** A seat that has already answered, or never had a bet down, is offered nothing. */
  it("is not offered to a seat with no pending decision", () => {
    expect(insuranceOffer("INSURANCE_OFFER", legal({ canDeclineInsurance: false }))).toBeNull();
    expect(insuranceOffer("INSURANCE_OFFER", null)).toBeNull();
  });

  /**
   * DECLINING IS ALWAYS AVAILABLE. A player who cannot cover the stake must
   * still be able to answer — hiding the sheet from them would leave them at
   * "Waiting for the next hand." exactly as before, which is the defect.
   */
  it("is still offered when the stake cannot be afforded", () => {
    const offer = insuranceOffer(
      "INSURANCE_OFFER",
      legal({ canTakeInsurance: false, insuranceStake: 500 }),
    );
    expect(offer).not.toBeNull();
    expect(offer?.canAfford).toBe(false);
    expect(offer?.stake).toBe(500);
  });

  it("carries Even Money through, since it is the same offer under another name", () => {
    expect(insuranceOffer("INSURANCE_OFFER", legal({ insuranceIsEvenMoney: true }))?.isEvenMoney).toBe(
      true,
    );
  });

  /** A null stake is 0, not NaN and not a rendered "null chips". */
  it("reads a missing stake as nothing rather than as unknown", () => {
    expect(insuranceOffer("INSURANCE_OFFER", legal({ insuranceStake: null }))?.stake).toBe(0);
  });
});
