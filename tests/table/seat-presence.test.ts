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
  COMPUTER_PLAYER_ACCESSIBILITY_LABEL,
  describeSeatBetting,
  describeSeatHandDetail,
  describeSeatIdentity,
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

/**
 * A COMPUTER PLAYER, LABELLED FROM THE SERVER'S FLAG (Astra Refresh C).
 *
 * The specification's computer seats are "explicitly labeled", and the label
 * must come from what the snapshot SAYS the seat is — never from its name, which
 * is free text a person chooses.
 */
describe("a computer player's seat", () => {
  it("is labelled AI, and spelled out for a screen reader", () => {
    expect(describeSeatIdentity({ isAi: true })).toBe("AI");
    expect(COMPUTER_PLAYER_ACCESSIBILITY_LABEL).toBe("Computer player");
  });

  it("is labelled because of the flag, not because of a name", () => {
    // A person who calls themselves "AI Player 1" is still a person.
    const person = { ...present(), displayName: "AI Player 1" };
    expect(describeSeatIdentity(person)).toBeNull();
    // And a computer player is labelled whatever it is called.
    const named = { ...present({ isAi: true }), displayName: "Ada" };
    expect(describeSeatIdentity(named)).toBe("AI");
  });

  it("says what it is waiting for before it bets", () => {
    // Computer players stake once the person has locked a bet; "Yet to bet"
    // would read as a player taking their time.
    expect(describeSeatBetting(present({ isAi: true }))).toBe("Bets when you deal");
    expect(describeSeatBetting(present({ isAi: true, betLocked: true }))).toBe("Bet placed");
    expect(describeSeatBetting(present({ isAi: true, sittingOut: true }))).toBe(
      "Sitting out this hand",
    );
  });

  it("is departed, like anybody's, once it has left", () => {
    const left = present({ isAi: true, connected: false });
    expect(seatPresence(left).kind).toBe("departed");
    expect(describeSeatBetting(left)).toBeNull();
  });
});

describe("another seat's hand line", () => {
  it("states the wager, and once settled what the hand came to", () => {
    expect(describeSeatHandDetail({ wager: 40 })).toBe("Bet 40");
    expect(describeSeatHandDetail({ wager: 40, outcome: { kind: "WIN", net: 40 } })).toBe(
      "Bet 40 · Won 40",
    );
    expect(describeSeatHandDetail({ wager: 20, outcome: { kind: "BUST", net: -20 } })).toBe(
      "Bet 20 · Lost 20",
    );
    expect(describeSeatHandDetail({ wager: 20, outcome: { kind: "PUSH", net: 0 } })).toBe(
      "Bet 20 · Push",
    );
    expect(describeSeatHandDetail({ wager: 20, outcome: { kind: "SURRENDER", net: -10 } })).toBe(
      "Bet 20 · Lost 10",
    );
  });

  it("says nothing for a hand with no wager", () => {
    expect(describeSeatHandDetail({ wager: 0 })).toBeUndefined();
  });
});
