/**
 * Recovery grant eligibility, at the boundaries.
 *
 * Both conditions here are the kind that get written with the wrong comparison
 * operator, and neither failure is loud:
 *
 *   * `balance < 2000` — get it wrong and a player sitting on exactly 2,000
 *     chips is offered a grant they do not need, or one at 1,999 is left
 *     stranded below the minimum buy-in with an inactive button and no
 *     explanation.
 *   * `elapsed >= 12h` — get it wrong and the grant is offered a millisecond
 *     early, the server refuses it, and the player sees a button that does
 *     nothing.
 *
 * So both are pinned at the exact millisecond rather than "about twelve hours".
 *
 * None of this is a security control. The server evaluates the same rule inside
 * the transaction that writes the ledger row, and the unique idempotency key
 * means a replayed claim credits at most once. This decides what to draw.
 */

import { describe, expect, it } from "vitest";

import {
  describeRecoveryGrant,
  evaluateRecoveryGrant,
  formatTimeRemaining,
  latestGrantAt,
  RECOVERY_GRANT_COOLDOWN_MS,
  RECOVERY_GRANT_THRESHOLD,
} from "../../src/features/wallet/recovery-grant.js";

const NOW = new Date("2026-08-15T12:00:00.000Z");

function at(msBefore: number): Date {
  return new Date(NOW.getTime() - msBefore);
}

const HOUR = 60 * 60 * 1_000;
const MINUTE = 60 * 1_000;

describe("the balance boundary", () => {
  it("is eligible at 1,999 chips", () => {
    const result = evaluateRecoveryGrant({ balance: 1_999, lastGrantAt: null, now: NOW });
    expect(result.eligible).toBe(true);
    expect(result.blockedBy).toEqual([]);
  });

  it("is NOT eligible at exactly 2,000 chips", () => {
    // 2,000 is the Casual minimum buy-in — a player holding it can still sit
    // down, so the grant is not for them.
    const result = evaluateRecoveryGrant({ balance: 2_000, lastGrantAt: null, now: NOW });
    expect(result.eligible).toBe(false);
    expect(result.blockedBy).toEqual(["BALANCE"]);
  });

  it("is eligible at zero", () => {
    expect(evaluateRecoveryGrant({ balance: 0, lastGrantAt: null, now: NOW }).eligible).toBe(true);
  });

  it("is not eligible far above the threshold", () => {
    expect(
      evaluateRecoveryGrant({ balance: 250_000, lastGrantAt: null, now: NOW }).eligible,
    ).toBe(false);
  });

  it("uses the documented threshold", () => {
    expect(RECOVERY_GRANT_THRESHOLD).toBe(2_000);
  });
});

describe("the cooldown boundary", () => {
  it("is NOT eligible at 11h59m since the last grant", () => {
    const result = evaluateRecoveryGrant({
      balance: 500,
      lastGrantAt: at(11 * HOUR + 59 * MINUTE),
      now: NOW,
    });

    expect(result.eligible).toBe(false);
    expect(result.blockedBy).toEqual(["COOLDOWN"]);
    expect(result.msUntilAvailable).toBe(MINUTE);
  });

  it("is NOT eligible one millisecond short of twelve hours", () => {
    const result = evaluateRecoveryGrant({
      balance: 500,
      lastGrantAt: at(RECOVERY_GRANT_COOLDOWN_MS - 1),
      now: NOW,
    });

    expect(result.eligible).toBe(false);
    expect(result.msUntilAvailable).toBe(1);
  });

  it("IS eligible at exactly 12h00m", () => {
    const result = evaluateRecoveryGrant({
      balance: 500,
      lastGrantAt: at(RECOVERY_GRANT_COOLDOWN_MS),
      now: NOW,
    });

    expect(result.eligible).toBe(true);
    expect(result.blockedBy).toEqual([]);
    expect(result.msUntilAvailable).toBe(0);
    expect(result.availableAt).toBeNull();
  });

  it("is eligible long after the cooldown", () => {
    expect(
      evaluateRecoveryGrant({ balance: 500, lastGrantAt: at(72 * HOUR), now: NOW }).eligible,
    ).toBe(true);
  });

  it("is eligible when there has never been a grant", () => {
    expect(evaluateRecoveryGrant({ balance: 500, lastGrantAt: null, now: NOW }).eligible).toBe(
      true,
    );
  });

  it("reports when the next grant becomes available", () => {
    const lastGrantAt = at(6 * HOUR);
    const result = evaluateRecoveryGrant({ balance: 500, lastGrantAt, now: NOW });

    expect(result.availableAt?.toISOString()).toBe(
      new Date(lastGrantAt.getTime() + RECOVERY_GRANT_COOLDOWN_MS).toISOString(),
    );
  });

  it("uses the documented cooldown", () => {
    expect(RECOVERY_GRANT_COOLDOWN_MS).toBe(12 * 60 * 60 * 1_000);
  });
});

describe("both conditions together", () => {
  it("requires both to pass", () => {
    const rich = evaluateRecoveryGrant({ balance: 5_000, lastGrantAt: at(24 * HOUR), now: NOW });
    const recent = evaluateRecoveryGrant({ balance: 100, lastGrantAt: at(HOUR), now: NOW });

    expect(rich.eligible).toBe(false);
    expect(recent.eligible).toBe(false);
  });

  it("reports both blockers when both apply", () => {
    const result = evaluateRecoveryGrant({ balance: 5_000, lastGrantAt: at(HOUR), now: NOW });

    expect([...result.blockedBy].sort()).toEqual(["BALANCE", "COOLDOWN"]);
  });
});

describe("unusable input", () => {
  it.each([Number.NaN, Infinity, 1_999.5])("refuses to judge a balance of %s", (balance) => {
    // Guessing in the player's favour would be the client asserting something
    // about money it could not read.
    const result = evaluateRecoveryGrant({ balance, lastGrantAt: null, now: NOW });

    expect(result.eligible).toBe(false);
    expect(result.blockedBy).toEqual(["UNKNOWN"]);
    expect(describeRecoveryGrant(result)).toContain("could not be read");
  });

  it("ignores an unparseable last-grant timestamp rather than blocking on it", () => {
    const result = evaluateRecoveryGrant({
      balance: 100,
      lastGrantAt: new Date("not a date"),
      now: NOW,
    });

    expect(result.eligible).toBe(true);
  });
});

describe("supporting helpers", () => {
  it("finds the most recent grant among several", () => {
    const latest = latestGrantAt([
      "2026-08-14T00:00:00.000Z",
      "2026-08-15T06:00:00.000Z",
      "2026-08-01T00:00:00.000Z",
    ]);

    expect(latest?.toISOString()).toBe("2026-08-15T06:00:00.000Z");
  });

  it("returns null when there is nothing usable", () => {
    expect(latestGrantAt([])).toBeNull();
    expect(latestGrantAt(["nonsense", ""])).toBeNull();
  });

  it("rounds a countdown up so it never reads zero while still blocked", () => {
    expect(formatTimeRemaining(1)).toBe("1m");
    expect(formatTimeRemaining(90 * MINUTE)).toBe("1h 30m");
    expect(formatTimeRemaining(2 * HOUR)).toBe("2h");
    expect(formatTimeRemaining(0)).toBe("now");
  });

  it("never names a chip amount it did not receive", () => {
    // The size of a grant is the server's decision. A client that prints a
    // figure has invented it.
    const eligible = evaluateRecoveryGrant({ balance: 0, lastGrantAt: null, now: NOW });

    expect(describeRecoveryGrant(eligible)).toContain("The server decides the amount");
    expect(describeRecoveryGrant(eligible)).not.toMatch(/\b\d{3,}\b/);
  });

  it("explains a cooldown block with a countdown", () => {
    const blocked = evaluateRecoveryGrant({ balance: 100, lastGrantAt: at(HOUR), now: NOW });

    expect(describeRecoveryGrant(blocked)).toContain("11h");
  });
});
