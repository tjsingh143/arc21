/**
 * WHEN A SEAT AT A SHARED TABLE BECOMES AN EMPTY SLOT.
 *
 * `isVacatedSeat` is the mirror of `canCloseSeat`: that one answers "may this
 * seat leave", and this one answers "has it, completely". `joinPublicTable`
 * asks it so a newcomer takes a departed player's place in the engine's seat
 * list, the same way they take the seat INDEX a departure freed.
 *
 * THE DEFECT IT CLOSES, measured against the running stack. Until phase 11 the
 * eighth arrival at a public table was answered HTTP 500 by a seat allocator
 * that counted from the highest index ever used — which accidentally bounded
 * how many departed seats one table could accumulate. With that fixed, every
 * arrival was APPENDED and nothing ever left: ten ordinary arrivals and
 * departures at a five-seat table left TWELVE seats in the engine state, ten of
 * them players who had gone, and the snapshot every client renders grew from
 * 2,040 to 6,442 bytes on the way. Each of those ghosts was drawn on the
 * remaining players' screens with their name, a zero stack and "Disconnected —
 * their clock keeps running."
 *
 * The two ends are tested in two places, deliberately: this file pins the RULE,
 * and `public-table.integration.test.ts` drives players through a real table
 * over HTTP and counts the seats that come back. A test of the predicate alone
 * would prove nothing about whether anybody asks it.
 */

import { describe, expect, it } from "vitest";

import { isVacatedSeat, type SeatState } from "../../shared/blackjack/index.js";

/** A seat in the state `settleTableClosure` leaves behind. */
function vacated(): SeatState {
  return {
    seatId: "seat-gone",
    userId: "user-gone",
    displayName: "Departed",
    stack: 0,
    originalBet: 0,
    insuranceBet: 0,
    insuranceDecision: "NOT_OFFERED",
    hands: [],
    currentHandIndex: 0,
    connected: false,
    betLocked: false,
    sittingOut: true,
  };
}

describe("isVacatedSeat", () => {
  it("is true for a seat whose player left and whose chips have gone back", () => {
    expect(isVacatedSeat(vacated())).toBe(true);
  });

  it("is false for a seat that is simply sitting this hand out", () => {
    // Connected, with chips: a player who cannot cover the minimum, or one held
    // out of a sudden-death hand. Their slot is not free.
    expect(isVacatedSeat({ ...vacated(), connected: true, stack: 500 })).toBe(false);
  });

  it("is false for a player who left MID-HAND, until the wager they committed resolves", () => {
    /*
     * `handleLeave` clears `connected` the moment LEAVE is applied, and the
     * committed hand goes on resolving — "leaving is never a way to escape a
     * committed wager". Reusing the slot then would drop a live hand out of the
     * engine's seat list mid-settlement.
     */
    const midHand = {
      ...vacated(),
      hands: [
        {
          id: "hand-1",
          cards: [],
          wager: 100,
          status: "PLAYING" as const,
          cameFromSplit: false,
        },
      ],
    } as unknown as SeatState;
    expect(isVacatedSeat(midHand)).toBe(false);
    expect(isVacatedSeat({ ...vacated(), originalBet: 100 })).toBe(false);
    expect(isVacatedSeat({ ...vacated(), insuranceBet: 50 })).toBe(false);
  });

  it("is false for a tournament seat eliminated with chips still on it", () => {
    // `session-boundary.ts` clears `connected` on elimination and leaves the
    // stack alone on purpose: the result screen reports the bankroll they went
    // out on. That is a record, not a free slot.
    expect(isVacatedSeat({ ...vacated(), stack: 1_400 })).toBe(false);
  });
});
