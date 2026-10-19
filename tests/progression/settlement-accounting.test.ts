/**
 * The server's settlement accounting.
 *
 * This module lives under `supabase/functions/_shared` rather than `shared/`,
 * for a tooling reason worth stating plainly: the Supabase CLI bind-mounts each
 * file outside `supabase/functions` into the Edge runtime individually, from a
 * module graph that does not pick up newly created files. A new file under
 * `shared/` typechecks, passes tests, and then fails at runtime with "no such
 * file or directory" — which is exactly the class of "it compiled so it works"
 * failure this project has been bitten by before.
 *
 * The cost of that placement is two constants duplicated from
 * `shared/progression/xp.ts`. The first test below is what makes the duplicate
 * safe: it fails the moment the two disagree.
 */

import { describe, expect, it } from "vitest";

import {
  accountForSettlement,
  isEmptyAccounting,
  recordsHandSettlement,
  SERVER_DAILY_REPEATABLE_XP_CAP,
  SERVER_XP_PER_SETTLED_HAND,
  SETTLEMENT_RECORDING_MODES,
} from "../../supabase/functions/_shared/settlement-accounting.js";
import { ALL_SESSION_MODES } from "../../supabase/functions/_shared/session-economics.js";
import {
  ACCURACY_ELIGIBLE_MODES,
  GRADED_MODES,
} from "../../supabase/functions/_shared/decision-grading.js";
import {
  DAILY_REPEATABLE_XP_CAP,
  XP_PER_SETTLED_HAND,
} from "../../shared/progression/index.js";
import type { EngineEvent, HandOutcomeKind } from "../../shared/blackjack/index.js";

const settled = (
  seatId: string,
  kind: HandOutcomeKind,
  credit: number,
  net: number,
): EngineEvent => ({
  type: "HAND_SETTLED",
  seatId,
  handId: `${seatId}-${kind}-${credit}`,
  outcome: { kind, credit, net },
});

describe("the duplicated constants have not drifted", () => {
  it("matches the XP awarded per settled hand", () => {
    expect(SERVER_XP_PER_SETTLED_HAND).toBe(XP_PER_SETTLED_HAND);
  });

  it("matches the daily repeatable cap", () => {
    expect(SERVER_DAILY_REPEATABLE_XP_CAP).toBe(DAILY_REPEATABLE_XP_CAP);
  });
});

describe("counting a settled batch", () => {
  it("ignores other seats entirely", () => {
    // A shared table settles every seat in one batch. Crediting all of them to
    // whoever sent the command would let a player inflate their record by
    // sitting next to a busy one.
    const result = accountForSettlement(
      [settled("mine", "WIN", 200, 100), settled("theirs", "WIN", 999, 500)],
      "mine",
    );

    expect(result.settledHands).toBe(1);
    expect(result.stats.handsWon).toBe(1);
    expect(result.stats.chipsNet).toBe(100);
  });

  it("recovers the stake from credit and net", () => {
    // The event carries no wager, so the stake is `credit - net`.
    const result = accountForSettlement([settled("s", "WIN", 200, 100)], "s");
    expect(result.stats.chipsWagered).toBe(100);
  });

  it("counts a blackjack as a win as well as a blackjack", () => {
    const result = accountForSettlement([settled("s", "BLACKJACK", 250, 150)], "s");
    expect(result.stats.handsWon).toBe(1);
    expect(result.stats.blackjacks).toBe(1);
  });

  it("separates a bust and a surrender from an ordinary loss", () => {
    const result = accountForSettlement(
      [
        settled("s", "LOSS", 0, -100),
        settled("s", "BUST", 0, -100),
        settled("s", "SURRENDER", 50, -50),
      ],
      "s",
    );

    expect(result.stats.handsLost).toBe(3);
    expect(result.stats.busts).toBe(1);
    expect(result.stats.handsSurrendered).toBe(1);
  });

  it("keeps a push out of the win and loss columns", () => {
    const result = accountForSettlement([settled("s", "PUSH", 100, 0)], "s");
    expect(result.stats.handsPushed).toBe(1);
    expect(result.stats.handsWon).toBe(0);
    expect(result.stats.handsLost).toBe(0);
  });

  it("reports the largest single win, not the total", () => {
    const result = accountForSettlement(
      [settled("s", "WIN", 100, 50), settled("s", "WIN", 400, 200), settled("s", "WIN", 200, 100)],
      "s",
    );
    expect(result.stats.biggestWin).toBe(200);
  });
});

describe("win streaks", () => {
  it("extends an existing run when nothing broke it", () => {
    const result = accountForSettlement(
      [settled("s", "WIN", 200, 100), settled("s", "BLACKJACK", 250, 150)],
      "s",
    );
    expect(result.stats.streakBroken).toBe(false);
    expect(result.stats.trailingWinStreak).toBe(2);
  });

  it("survives a push, because a push is not a loss", () => {
    const result = accountForSettlement(
      [settled("s", "WIN", 200, 100), settled("s", "PUSH", 100, 0), settled("s", "WIN", 200, 100)],
      "s",
    );
    expect(result.stats.streakBroken).toBe(false);
    expect(result.stats.trailingWinStreak).toBe(2);
  });

  it("counts only the wins after the last loss", () => {
    // The caller resets rather than adds when `streakBroken` is set, so the
    // trailing count must exclude the wins that came before the break.
    const result = accountForSettlement(
      [
        settled("s", "WIN", 200, 100),
        settled("s", "WIN", 200, 100),
        settled("s", "LOSS", 0, -100),
        settled("s", "WIN", 200, 100),
      ],
      "s",
    );

    expect(result.stats.streakBroken).toBe(true);
    expect(result.stats.trailingWinStreak).toBe(1);
  });

  it("reports zero when the batch ends on a loss", () => {
    const result = accountForSettlement(
      [settled("s", "WIN", 200, 100), settled("s", "BUST", 0, -100)],
      "s",
    );
    expect(result.stats.streakBroken).toBe(true);
    expect(result.stats.trailingWinStreak).toBe(0);
  });
});

describe("XP", () => {
  it("pays a flat amount per settled hand", () => {
    const result = accountForSettlement(
      [settled("s", "WIN", 200, 100), settled("s", "LOSS", 0, -100)],
      "s",
    );
    expect(result.xp).toBe(2 * XP_PER_SETTLED_HAND);
  });

  it("pays the same for a large wager as a small one", () => {
    // The specification's "never award more XP for betting larger amounts".
    // Here it is structural — the event's chip figures reach the statistics and
    // never the XP total — so this asserts the property rather than a check.
    const small = accountForSettlement([settled("s", "WIN", 100, 50)], "s");
    const huge = accountForSettlement([settled("s", "WIN", 1_000_000, 500_000)], "s");

    expect(huge.xp).toBe(small.xp);
    expect(huge.stats.chipsNet).toBeGreaterThan(small.stats.chipsNet);
  });
});

describe("an empty batch", () => {
  it("is recognised so the caller can skip the write", () => {
    const nothing = accountForSettlement([], "s");
    expect(isEmptyAccounting(nothing)).toBe(true);
    expect(nothing.xp).toBe(0);
  });

  it("is not confused with a batch for another seat", () => {
    const result = accountForSettlement([settled("theirs", "WIN", 200, 100)], "mine");
    expect(isEmptyAccounting(result)).toBe(true);
  });
});

/**
 * WHICH TABLES WRITE TO A PLAYER'S RECORD AT ALL (Astra Refresh C).
 *
 * Until AI tables existed every settled hand was recorded, unconditionally —
 * true of every mode that then existed, and exactly the shape that would have
 * made the first new mode count by accident. The recording is an allowlist now,
 * like the accuracy board's, and these pin both halves: every mode that recorded
 * before still does, and an AI table does not.
 */
describe("which modes record a settled hand", () => {
  it("is every server mode that recorded before AI tables, unchanged", () => {
    expect([...SETTLEMENT_RECORDING_MODES].sort()).toEqual(
      ["career", "daily_challenge", "private_table", "public_table", "solo", "tournament"].sort(),
    );
  });

  it("leaves an AI table out: a hand against computer players earns no XP and moves no statistic", () => {
    // The weekly XP board is fed entirely by repeatable XP, so a hand that paid
    // XP here would be a ranking input won against machines.
    expect(recordsHandSettlement("ai_table")).toBe(false);
  });

  it("records nothing for a mode nobody has decided about", () => {
    expect(recordsHandSettlement("something_new")).toBe(false);
    expect(recordsHandSettlement("practice")).toBe(false);
  });

  it("names only modes the server knows", () => {
    for (const mode of SETTLEMENT_RECORDING_MODES) {
      expect(ALL_SESSION_MODES as readonly string[]).toContain(mode);
    }
  });

  it("keeps an AI table off the accuracy board and ungraded, too", () => {
    expect(ACCURACY_ELIGIBLE_MODES as readonly string[]).not.toContain("ai_table");
    expect(GRADED_MODES as readonly string[]).not.toContain("ai_table");
  });
});
