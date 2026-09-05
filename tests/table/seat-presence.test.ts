/**
 * What a seat card is allowed to say about a player who has gone.
 *
 * THE DEFECT. `app/table/[gameId].tsx` rendered "Disconnected — their clock
 * keeps running." for every seat with `connected: false`, and "Yet to bet"
 * beside it whenever that seat held no cards. Both are false of a player who
 * cashed out, and this engine has no other kind of disconnection — the
 * reducer's own comment: "`connected` is only ever cleared by LEAVE, by a table
 * closure or by a tournament elimination, and nothing sets it back."
 *
 * Seen on a Release build at a two-seat private table: the host left, and the
 * remaining player was shown `0 · Yet to bet · Disconnected — their clock keeps
 * running.` for the rest of the session. `isVacatedSeat` cannot help — it lets a
 * NEWCOMER reuse a slot at a public table, and nobody new ever joins a private
 * room.
 *
 * The three states below are constructed from what each of the three code paths
 * actually leaves behind, which is the point of the file: they are not three
 * shapes somebody imagined.
 */

import { describe, expect, it } from "vitest";

import {
  describeSeatBetting,
  seatPresence,
  type SeatPresenceView,
} from "../../src/features/table/seat-presence";

/** A seat at the table, playing. */
function present(overrides: Partial<SeatPresenceView> = {}): SeatPresenceView {
  return {
    connected: true,
    sittingOut: false,
    betLocked: false,
    stack: 4_900,
    originalBet: 0,
    insuranceBet: 0,
    hands: [],
    ...overrides,
  };
}

describe("a seat whose player is still there", () => {
  it("is present", () => {
    expect(seatPresence(present()).kind).toBe("present");
  });

  it("says whether they have bet yet", () => {
    expect(describeSeatBetting(present())).toBe("Yet to bet");
    expect(describeSeatBetting(present({ betLocked: true }))).toBe("Bet placed");
  });

  it("says when they are sitting the hand out", () => {
    // Never rendered before this file existed: a seat below the table minimum,
    // or a tournament's sudden-death hold-out, was indistinguishable from one
    // still deciding.
    expect(describeSeatBetting(present({ sittingOut: true }))).toBe("Sitting out this hand");
  });
});

describe("a seat left behind by `settleTableClosure`", () => {
  /*
   * `close-table.ts` zeroes the stack, the bets and the hands and clears
   * `connected` — the exact shape `isVacatedSeat` recognises. This is the state
   * the private-table screenshot was showing.
   */
  const cashedOut = present({
    connected: false,
    sittingOut: true,
    stack: 0,
    hands: [],
  });

  it("is reported as gone, not as disconnected", () => {
    const presence = seatPresence(cashedOut);
    expect(presence.kind).toBe("departed");
    expect(presence.kind === "departed" && presence.note).toBe("No longer playing at this table.");
  });

  it("never claims a clock is still running for them", () => {
    const presence = seatPresence(cashedOut);
    expect(presence.kind === "departed" && presence.note).not.toMatch(/clock/i);
  });

  it("is not also described as yet to bet", () => {
    expect(describeSeatBetting(cashedOut)).toBeNull();
  });
});

describe("a seat left behind by a MID-HAND leave", () => {
  /*
   * `handleLeave` clears `connected` at once and leaves the committed hand to
   * resolve — "leaving is never a way to escape a committed wager" — so the
   * server's clock genuinely does keep running for this seat. This is the one
   * case the original sentence was right about, and the reason it is kept.
   */
  const midHand = present({
    connected: false,
    originalBet: 100,
    hands: [{}],
  });

  it("says the hand is still being played out", () => {
    const presence = seatPresence(midHand);
    expect(presence.kind).toBe("resolving");
    expect(presence.kind === "resolving" && presence.note).toMatch(/playing their hand out/);
  });

  it("counts a lone insurance bet as something still live", () => {
    expect(seatPresence(present({ connected: false, insuranceBet: 50 })).kind).toBe("resolving");
  });
});

describe("a seat eliminated from a tournament", () => {
  /*
   * `session-boundary.ts` clears `connected` and sets `sittingOut`, and
   * deliberately LEAVES THE STACK — the result screen reports the bankroll they
   * went out on. So chips on a seat must not be read as something at stake, or
   * every eliminated player would be described as still playing a hand.
   */
  const eliminated = present({
    connected: false,
    sittingOut: true,
    stack: 3_400,
    hands: [],
  });

  it("is reported as gone rather than as resolving a hand", () => {
    expect(seatPresence(eliminated).kind).toBe("departed");
  });

  it("is not described as having left, because they did not choose to", () => {
    const presence = seatPresence(eliminated);
    expect(presence.kind === "departed" && presence.note).not.toMatch(/\bleft\b/i);
  });
});
