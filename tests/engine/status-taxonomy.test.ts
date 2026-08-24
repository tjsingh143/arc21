/**
 * The engine's vocabularies are written down THREE times, and nothing compared
 * them.
 *
 *   `shared/blackjack/types.ts`      the union the engine assigns
 *   `shared/contracts/…`             the Zod enum the wire payload is parsed by
 *   `supabase/migrations/…`          the Postgres enum a column is typed by
 *
 * The migration says "Mirrors PlayerHandStatus in shared/blackjack/types.ts" in
 * a comment, which is a description of a guard rather than a guard. Drift in
 * either direction is a live defect and neither direction fails loudly on its
 * own:
 *
 *   a value the ENGINE can produce and the schema cannot name is a payload the
 *   client silently fails to parse — the same shape as the `canStartNextHand`
 *   defect that stopped every online table after hand one;
 *
 *   a value the SCHEMA names and the engine cannot produce is dead vocabulary
 *   that reads as meaningful. `RESOLVED` is exactly that, and is kept
 *   deliberately (a Postgres enum cannot drop a value), so this file also
 *   proves the engine never emits it.
 *
 * Reading the `.sql` text is the point: it needs no database, so the check runs
 * in the unit suite where a drifting change is actually made.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  gamePhaseSchema,
  handOutcomeKindSchema,
  playerActionTypeSchema,
  playerHandStatusSchema,
} from "../../shared/contracts/contract-primitives.js";
import {
  ALL_GAME_PHASES,
  ALL_HAND_OUTCOME_KINDS,
  ALL_INSURANCE_DECISIONS,
  ALL_PLAYER_ACTION_TYPES,
  ALL_PLAYER_HAND_STATUSES,
  DEAD_TERMINAL_STATUSES,
  LIVE_TERMINAL_STATUSES,
  isTerminalHandStatus,
  type PlayerHandStatus,
} from "../../shared/blackjack/types.js";
import { betAndDeal, harness } from "../helpers/engine-harness.js";

const FOUNDATION = join(
  process.cwd(),
  "supabase",
  "migrations",
  "20260813120000_foundation.sql",
);

const foundationSql = readFileSync(FOUNDATION, "utf8");

/** Pulls the values out of `create type public.<name> as enum ( ... );`. */
function pgEnumValues(name: string): string[] {
  const pattern = new RegExp(
    `create\\s+type\\s+public\\.${name}\\s+as\\s+enum\\s*\\(([^)]*)\\)`,
    "i",
  );
  const match = pattern.exec(foundationSql);
  if (!match) throw new Error(`no Postgres enum public.${name} in ${FOUNDATION}`);
  return [...match[1]!.matchAll(/'([^']+)'/g)].map((entry) => entry[1]!);
}

describe("the migration really does declare the enums this file compares", () => {
  it("finds all four, so a rename cannot make these tests vacuous", () => {
    for (const name of [
      "player_hand_status",
      "hand_outcome_kind",
      "player_action_type",
      "insurance_decision",
    ]) {
      expect(pgEnumValues(name).length).toBeGreaterThan(0);
    }
  });

  it("refuses to invent an enum that is not there", () => {
    expect(() => pgEnumValues("no_such_enum")).toThrow(/no Postgres enum/);
  });
});

describe("PlayerHandStatus agrees across all three definitions", () => {
  it("matches the wire enum, value for value", () => {
    expect([...playerHandStatusSchema.options].sort()).toEqual([...ALL_PLAYER_HAND_STATUSES].sort());
  });

  it("matches the Postgres enum, value for value", () => {
    expect(pgEnumValues("player_hand_status").sort()).toEqual([...ALL_PLAYER_HAND_STATUSES].sort());
  });
});

describe("GamePhase agrees with the wire enum", () => {
  it("matches value for value", () => {
    expect([...gamePhaseSchema.options].sort()).toEqual([...ALL_GAME_PHASES].sort());
  });
});

describe("HandOutcomeKind agrees across all three definitions", () => {
  it("matches the wire enum", () => {
    expect([...handOutcomeKindSchema.options].sort()).toEqual([...ALL_HAND_OUTCOME_KINDS].sort());
  });

  it("matches the Postgres enum", () => {
    expect(pgEnumValues("hand_outcome_kind").sort()).toEqual([...ALL_HAND_OUTCOME_KINDS].sort());
  });
});

describe("PlayerActionType agrees across all three definitions", () => {
  it("matches the wire enum", () => {
    expect([...playerActionTypeSchema.options].sort()).toEqual([...ALL_PLAYER_ACTION_TYPES].sort());
  });

  it("matches the Postgres enum", () => {
    expect(pgEnumValues("player_action_type").sort()).toEqual([...ALL_PLAYER_ACTION_TYPES].sort());
  });
});

describe("InsuranceDecision agrees with the Postgres enum", () => {
  it("matches value for value", () => {
    expect(pgEnumValues("insurance_decision").sort()).toEqual([...ALL_INSURANCE_DECISIONS].sort());
  });
});

describe("the terminal-status taxonomy", () => {
  it("splits the statuses into acting, live-terminal, dead-terminal and reserved", () => {
    const live = new Set<PlayerHandStatus>(LIVE_TERMINAL_STATUSES);
    const dead = new Set<PlayerHandStatus>(DEAD_TERMINAL_STATUSES);

    // No status is in both lists.
    for (const status of live) expect(dead.has(status)).toBe(false);

    const classified = new Set<PlayerHandStatus>([...live, ...dead, "ACTIVE", "RESOLVED"]);
    expect([...classified].sort()).toEqual([...ALL_PLAYER_HAND_STATUSES].sort());
  });

  it("treats everything except ACTIVE as terminal", () => {
    for (const status of ALL_PLAYER_HAND_STATUSES) {
      expect(isTerminalHandStatus(status)).toBe(status !== "ACTIVE");
    }
  });
});

describe("what a real session actually produces", () => {
  /** Plays enough distinct shapes to reach every status the engine can set. */
  function statusesFromPlay(): Set<string> {
    const seen = new Set<string>();
    const record = (state: { seats: Array<{ hands: Array<{ status: string }> }> }) => {
      for (const seat of state.seats) for (const hand of seat.hands) seen.add(hand.status);
    };

    // Stand.
    record(betAndDeal(harness({ shoe: "10S 7H 7D 5C" }), 100).state);
    record(betAndDeal(harness({ shoe: "10S 7H 7D 5C" }), 100).send({ type: "STAND", seatId: "s1" }).state);
    // Bust.
    record(
      betAndDeal(harness({ shoe: "10S 7H 6D 5C 10H" }), 100).send({ type: "HIT", seatId: "s1" }).state,
    );
    // Natural.
    record(betAndDeal(harness({ shoe: "AS 7H KD 5C" }), 100).state);
    // Double.
    record(
      betAndDeal(harness({ shoe: "5S 7H 6D 5C 9H" }), 100).send({ type: "DOUBLE", seatId: "s1" }).state,
    );
    // Surrender.
    record(
      betAndDeal(harness({ shoe: "10S 7H 6D 5C" }), 100).send({ type: "SURRENDER", seatId: "s1" }).state,
    );
    // Split aces: one card each, and a 21 that is an ordinary 21.
    record(
      betAndDeal(harness({ shoe: "AS 7H AD 5C KH 9D" }), 100).send({ type: "SPLIT", seatId: "s1" }).state,
    );

    return seen;
  }

  it("never assigns RESOLVED", () => {
    expect(statusesFromPlay().has("RESOLVED")).toBe(false);
  });

  it("does assign every other status, so the list is not merely aspirational", () => {
    const produced = statusesFromPlay();
    for (const status of ALL_PLAYER_HAND_STATUSES) {
      if (status === "RESOLVED") continue;
      expect(produced.has(status), `no fixture produces ${status}`).toBe(true);
    }
  });
});
