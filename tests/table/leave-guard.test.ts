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

import {
  mayLeaveTable,
  TABLE_EXIT_ROUTE,
  TABLE_SCREEN_OPTIONS,
  tableExitDestination,
  tableExitSequence,
} from "../../src/features/table/leave-guard.js";

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
    expect(mayLeaveTable({ alreadyLeaving: false, cashedOut: false, holdsSeat: true })).toBe(false);
  });

  it("allows it once the server has cashed out", () => {
    expect(mayLeaveTable({ alreadyLeaving: false, cashedOut: true, holdsSeat: true })).toBe(true);
  });

  /**
   * THE ONE THAT WEDGED THE APP.
   *
   * With no seat there is nothing for this guard to protect, and cancelling
   * anyway is a trap rather than a redundancy: every route away from the table
   * fires `beforeRemove`, so a listener that cancels and then asks about a seat
   * which no longer exists cancels FOR EVER. Photographed twice on a device —
   * the screen sat on its own "You are no longer at this table" notice with
   * `arc21://table/lobby` reporting COMPLETED and changing nothing, and only
   * killing the app got the player out.
   */
  it("allows it outright once the seat is gone, whatever the other answers say", () => {
    for (const alreadyLeaving of [true, false]) {
      for (const cashedOut of [true, false]) {
        expect(mayLeaveTable({ alreadyLeaving, cashedOut, holdsSeat: false })).toBe(true);
      }
    }
  });

  it("allows the replay that follows a successful cash-out", () => {
    /*
     * Dispatching the original navigation action re-fires `beforeRemove`.
     * Without this branch the second pass would send a second CASH_OUT — which
     * is idempotent server-side, the key being derived from `gameId:seatId`,
     * but a loop that relies on idempotency to terminate is still a loop.
     */
    expect(mayLeaveTable({ alreadyLeaving: true, cashedOut: false, holdsSeat: true })).toBe(true);
  });
});

/**
 * WHERE A SETTLED TABLE SENDS THE PLAYER.
 *
 * Leaving replays the navigation action that was cancelled — a GO_BACK — and
 * the table route is often the BOTTOM of the stack: `router.replace` from the
 * lobby, `arc21://table/...`, a notification, the resume card on a cold launch.
 * With nothing beneath it, GO_BACK is not handled at all.
 *
 * Photographed on a device. The cash-out committed, the seat was settled, the
 * chips were back — and the screen sat on "Reading the table…" with a dev-build
 * banner reading "The action 'GO_BACK' was not handled by any navigator", and no
 * way off it: the only control was "Leave table", which cashes out an
 * already-settled seat and dispatches the same unhandled GO_BACK again.
 */
describe("leaving a table with nothing behind it", () => {
  it("goes back when there is somewhere to go back to", () => {
    expect(tableExitDestination(true)).toBe("back");
  });

  it("names a destination when there is not", () => {
    expect(tableExitDestination(false)).toBe(TABLE_EXIT_ROUTE);
    // Home rather than the lobby: a player whose table has ended is not
    // necessarily looking for another one, and Home is the one route that is
    // always there.
    expect(TABLE_EXIT_ROUTE).toBe("/(tabs)/home");
  });
});

/**
 * THE TWO WAYS OFF A TABLE MUST DO THE SAME THING.
 *
 * The screen has a back-bar control and a `beforeRemove` listener, and each used
 * to carry its own copy of the exit. One copy omitted the step that records the
 * screen is leaving — so the back bar confirmed, cashed out, navigated, and the
 * listener then fired with `alreadyLeaving: false`, cancelled the navigation and
 * ASKED AGAIN whether to leave a table already left, quoting a stack the seat no
 * longer held. Being an `Alert`, it was modal: the app sat behind it and a deep
 * link to the lobby reported COMPLETED against a screen nobody could see.
 *
 * These assert the property that failed — the mark happens in BOTH branches, and
 * first — rather than the destination, which was never wrong.
 */
describe("the exit both leave paths follow", () => {
  it("records that the screen is leaving before it navigates, with a route behind it", () => {
    expect(tableExitSequence(true)).toEqual(["mark-leaving", "replay-back"]);
  });

  it("records it just the same when there is nothing behind this route", () => {
    // The branch the back bar was taking when it asked twice: reached by a deep
    // link or a `router.replace` from the lobby, so there is no back to replay.
    expect(tableExitSequence(false)).toEqual(["mark-leaving", "replace"]);
  });

  it("marks the leave first in every case, which is the whole point", () => {
    for (const canGoBack of [true, false]) {
      expect(tableExitSequence(canGoBack)[0]).toBe("mark-leaving");
    }
  });

  it("leaves exactly one way, so an exit cannot both replay and replace", () => {
    for (const canGoBack of [true, false]) {
      const steps = tableExitSequence(canGoBack);
      expect(steps.filter((step) => step !== "mark-leaving")).toHaveLength(1);
    }
  });
});
