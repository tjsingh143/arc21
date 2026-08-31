/**
 * The server's clock, as the client reads it.
 *
 * The defect these cover is not a wrong number — there was no number. `deadlineAt`
 * has been on every snapshot since the wire contract was written, under the
 * comment "Clients render countdowns against server time", and no client code
 * read it: no countdown was rendered, and, far worse, NOTHING EVER ASKED THE
 * SERVER TO RESOLVE AN EXPIRED DEADLINE. Arc 21 runs no long-lived game process,
 * so a connected client asking is the only thing that moves a lapsed timer.
 *
 * Two properties are asserted throughout:
 *
 *   * a table with NO deadline renders nothing and asks for nothing. Solo,
 *     career and practice carry none on purpose — nobody else is waiting — and a
 *     countdown reading "0 seconds" there would be a lie about a rule that does
 *     not exist.
 *   * the ask is debounced on the VERSION, not on a timer. A version moves the
 *     instant a timeout applies, so "once per expiry" needs no second clock.
 */

import { describe, expect, it } from "vitest";

import {
  describeDeadline,
  secondsUntilDeadline,
  shouldRequestTimeoutResolution,
  TIMEOUT_RESOLVE_GRACE_MS,
  TIMEOUT_RETRY_MS,
} from "../../src/features/table/table-deadline.js";

const NOW = new Date("2026-08-30T12:00:00.000Z");
const at = (offsetMs: number) => new Date(NOW.getTime() + offsetMs).toISOString();

describe("seconds until a deadline", () => {
  it("is null when the table has no clock at all", () => {
    expect(secondsUntilDeadline(null, NOW)).toBeNull();
  });

  it("is null for a deadline that will not parse, rather than zero", () => {
    // Zero would render as "Time — the hand stands." for a table whose snapshot
    // simply carried something unreadable.
    expect(secondsUntilDeadline("not a date", NOW)).toBeNull();
  });

  it("rounds up, so a countdown never shows a second it has not finished", () => {
    expect(secondsUntilDeadline(at(4_200), NOW)).toBe(5);
    expect(secondsUntilDeadline(at(15_000), NOW)).toBe(15);
  });

  it("floors at zero rather than counting into the negatives", () => {
    expect(secondsUntilDeadline(at(-9_000), NOW)).toBe(0);
  });
});

describe("what the countdown says", () => {
  it("renders nothing when there is no deadline", () => {
    expect(describeDeadline({ deadlineAt: null, phase: "PLAYER_TURNS", now: NOW, awaitingYou: true })).toBeNull();
  });

  it("names the default alongside the number, at every phase that has one", () => {
    const betting = describeDeadline({
      deadlineAt: at(9_000),
      phase: "BETTING_OPEN",
      now: NOW,
      awaitingYou: true,
    });
    expect(betting).toContain("9 seconds");
    expect(betting).toContain("table minimum");

    const insurance = describeDeadline({
      deadlineAt: at(9_000),
      phase: "INSURANCE_OFFER",
      now: NOW,
      awaitingYou: true,
    });
    expect(insurance).toContain("declined");

    const turn = describeDeadline({
      deadlineAt: at(9_000),
      phase: "PLAYER_TURNS",
      now: NOW,
      awaitingYou: true,
    });
    expect(turn).toContain("stand");
  });

  it("says a second, singular, at one second", () => {
    expect(
      describeDeadline({ deadlineAt: at(600), phase: "PLAYER_TURNS", now: NOW, awaitingYou: true }),
    ).toContain("1 second to act");
  });

  it("never promises basic strategy, at any phase", () => {
    // "Never silently play basic strategy for an absent user" is the
    // specification's rule and the engine's behaviour; the copy has to agree.
    for (const phase of ["BETTING_OPEN", "INSURANCE_OFFER", "PLAYER_TURNS", "HAND_COMPLETE"]) {
      for (const awaitingYou of [true, false]) {
        const line = describeDeadline({ deadlineAt: at(5_000), phase, now: NOW, awaitingYou }) ?? "";
        expect(line.toLowerCase()).not.toContain("strategy");
      }
    }
  });
});

describe("asking the server to resolve an expired deadline", () => {
  const base = {
    deadlineAt: at(-5_000),
    version: 7,
    now: NOW,
    pending: false,
    connected: true,
    alreadyAskedForVersion: null,
    lastAskedAt: null,
  };

  it("asks once the deadline has passed", () => {
    expect(shouldRequestTimeoutResolution(base)).toBe(true);
  });

  it("does not ask before it has", () => {
    expect(shouldRequestTimeoutResolution({ ...base, deadlineAt: at(3_000) })).toBe(false);
  });

  it("waits out the skew grace before asking", () => {
    // Two devices and a server do not share a clock. Without this, the fastest
    // client in the room sends a request the server refuses on every tick.
    expect(
      shouldRequestTimeoutResolution({
        ...base,
        deadlineAt: at(-(TIMEOUT_RESOLVE_GRACE_MS - 100)),
      }),
    ).toBe(false);
    expect(
      shouldRequestTimeoutResolution({
        ...base,
        deadlineAt: at(-(TIMEOUT_RESOLVE_GRACE_MS + 100)),
      }),
    ).toBe(true);
  });

  it("never asks at a table with no clock", () => {
    expect(shouldRequestTimeoutResolution({ ...base, deadlineAt: null })).toBe(false);
  });

  it("asks once per version, not once per tick", () => {
    expect(
      shouldRequestTimeoutResolution({
        ...base,
        alreadyAskedForVersion: 7,
        lastAskedAt: NOW.getTime(),
      }),
    ).toBe(false);
    // The version moves the moment the timeout applies, so a NEW expiry is a new
    // question even though the previous one was asked.
    expect(
      shouldRequestTimeoutResolution({
        ...base,
        version: 8,
        alreadyAskedForVersion: 7,
        lastAskedAt: NOW.getTime(),
      }),
    ).toBe(true);
  });

  /**
   * THE DEADLOCK THE MARKER ALONE CAUSED, and it was not theoretical.
   *
   * On the two-simulator run the local edge runtime saturated, one ask was lost,
   * and the client sat at "Reconnecting…" on hand 8 with a lapsed clock — the
   * exact frozen table this whole mechanism exists to prevent, reached by the
   * mechanism itself. An ask that goes unanswered leaves the version where it
   * was, so a marker that blocks outright blocks for ever.
   */
  it("asks AGAIN at the same version once the retry window has passed", () => {
    const asked = {
      ...base,
      alreadyAskedForVersion: base.version,
      lastAskedAt: NOW.getTime() - (TIMEOUT_RETRY_MS - 200),
    };
    expect(shouldRequestTimeoutResolution(asked)).toBe(false);
    expect(
      shouldRequestTimeoutResolution({
        ...asked,
        lastAskedAt: NOW.getTime() - (TIMEOUT_RETRY_MS + 200),
      }),
    ).toBe(true);
  });

  it("stays quiet while a command is in flight", () => {
    expect(shouldRequestTimeoutResolution({ ...base, pending: true })).toBe(false);
  });

  it("stays quiet while the connection is silent", () => {
    // A request into silence tells the player nothing, and the poll is already
    // trying. The server's clock keeps running either way.
    expect(shouldRequestTimeoutResolution({ ...base, connected: false })).toBe(false);
  });
});

/**
 * WHOSE clock it is.
 *
 * Found by looking at a rendered screen and nothing else. On the two-simulator
 * run the host's table read "10 seconds to act · you stand if you do not" while
 * the OTHER seat was the one being waited on — wrong twice, since this player
 * had nothing to do and standing was not what would happen to them. Every
 * assertion about that string passed, because the string was right for the case
 * they were written for.
 */
describe("the countdown says whose clock it is", () => {
  it("addresses the player only when the deadline is waiting on them", () => {
    const mine = describeDeadline({
      deadlineAt: at(9_000),
      phase: "PLAYER_TURNS",
      now: NOW,
      awaitingYou: true,
    });
    const theirs = describeDeadline({
      deadlineAt: at(9_000),
      phase: "PLAYER_TURNS",
      now: NOW,
      awaitingYou: false,
    });

    expect(mine).toContain("you stand if you do not");
    expect(theirs).not.toContain("you stand");
    expect(theirs).toContain("their hand stands");
    // Both still carry the number: the clock is the table's either way.
    expect(theirs).toContain("9 seconds");
  });

  it("does not tell a player who has already bet that they are about to be staked", () => {
    const yetToBet = describeDeadline({
      deadlineAt: at(9_000),
      phase: "BETTING_OPEN",
      now: NOW,
      awaitingYou: true,
    });
    const alreadyBet = describeDeadline({
      deadlineAt: at(9_000),
      phase: "BETTING_OPEN",
      now: NOW,
      awaitingYou: false,
    });

    expect(yetToBet).toContain("if you do not");
    expect(alreadyBet).not.toContain("if you do not");
    expect(alreadyBet).toContain("anyone who has not");
  });

  it("says the same thing to everybody between hands", () => {
    // Nobody in particular is being waited on: the next round starts for the
    // whole table, whoever asks for it first.
    const asked = { deadlineAt: at(9_000), phase: "HAND_COMPLETE", now: NOW } as const;
    expect(describeDeadline({ ...asked, awaitingYou: true })).toBe(
      describeDeadline({ ...asked, awaitingYou: false }),
    );
  });
});
