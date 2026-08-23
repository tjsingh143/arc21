/**
 * A table cannot be left without the server agreeing.
 *
 * Leaving is an economic command: `CASH_OUT` returns the remaining stack to the
 * wallet. The "Leave table" control has sent it since phase 14, and refuses to
 * navigate on a refusal — but a route can be removed three other ways, and the
 * first of them was wide open:
 *
 *   the iOS swipe-back gesture      enabled by DEFAULT on a native stack, and
 *                                   `headerShown: false` does not change that
 *   the Android hardware back       pops the screen directly
 *   a deep link resetting the stack same
 *
 * A swipe therefore popped the table with the buy-in still in escrow: the seat
 * stayed `active`, the wallet stayed short, and the screen that took the chips
 * had promised "whatever is left comes back when you leave" — which is the
 * exact defect the control was fixed to close, still reachable by a gesture.
 *
 * Testing the CONSTANTS rather than the component, for the reason this
 * repository keeps relearning: a test that calls `leaveTable` proves
 * `leaveTable` works and proves nothing about whether anything can bypass it.
 */

import { describe, expect, it } from "vitest";

import { mayLeaveTable, TABLE_SCREEN_OPTIONS } from "../../src/features/table/leave-guard.js";

describe("the swipe-back gesture", () => {
  it("is off for the table route", () => {
    // `gestureEnabled` defaults to true on iOS. Leaving it at the default is
    // the whole of the defect, so the option is asserted rather than commented.
    expect(TABLE_SCREEN_OPTIONS.gestureEnabled).toBe(false);
  });
});

describe("whether a route removal may proceed", () => {
  it("refuses while the server has not cashed the seat out", () => {
    // The mid-hand case: `CASH_OUT` is refused with SESSION_BUSY and the player
    // stays at the table with the reason on screen. Walking away here is what
    // strands the chips.
    expect(mayLeaveTable({ alreadyLeaving: false, cashedOut: false })).toBe(false);
  });

  it("allows it once the server has cashed out", () => {
    expect(mayLeaveTable({ alreadyLeaving: false, cashedOut: true })).toBe(true);
  });

  it("allows the replay that follows a successful cash-out", () => {
    /*
     * Dispatching the original navigation action re-fires `beforeRemove`.
     * Without this branch the second pass would send a second CASH_OUT — which
     * is idempotent server-side, the key being derived from `gameId:seatId`,
     * but a loop that relies on idempotency to terminate is still a loop.
     */
    expect(mayLeaveTable({ alreadyLeaving: true, cashedOut: false })).toBe(true);
  });
});
