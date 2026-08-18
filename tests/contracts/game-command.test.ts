/**
 * The wire contract for game commands.
 *
 * These are the checks that run before any authoritative state is touched, so
 * they are the cheapest place to stop a malformed or hostile request. The
 * threat model assumes the client is fully controlled by an attacker: anything
 * the schema lets through is something the handler must defend against on its
 * own.
 *
 * Strictness is the point. A schema that silently drops unknown keys lets an
 * attacker probe for a field that IS read somewhere downstream.
 */

import { describe, expect, it } from "vitest";

import {
  chipAmountSchema,
  gameCommandRequestSchema,
  GAME_COMMAND_TYPES,
  MAX_CHIP_AMOUNT,
  stateVersionSchema,
} from "../../shared/contracts/index.js";

const VALID = {
  gameId: "11111111-1111-4111-8111-111111111111",
  clientActionId: "22222222-2222-4222-8222-222222222222",
  expectedVersion: 3,
  clientSentAt: "2026-08-15T12:00:00.000Z",
} as const;

const placeBet = (overrides: Record<string, unknown> = {}) => ({
  ...VALID,
  type: "PLACE_BET",
  payload: { amount: 100 },
  ...overrides,
});

describe("accepts well-formed commands", () => {
  it("accepts a place-bet", () => {
    expect(gameCommandRequestSchema.safeParse(placeBet()).success).toBe(true);
  });

  it("accepts a bet of zero, which clears a staged wager", () => {
    // Zero is an ordinary action — taking chips back off the felt — not a
    // rule violation. The engine, not the schema, owns table minimums.
    expect(gameCommandRequestSchema.safeParse(placeBet({ payload: { amount: 0 } })).success).toBe(true);
  });

  it("accepts every payload-free command, with and without an empty payload", () => {
    for (const type of GAME_COMMAND_TYPES) {
      if (type === "PLACE_BET") continue;
      expect(
        gameCommandRequestSchema.safeParse({ ...VALID, type }).success,
        `${type} without payload`,
      ).toBe(true);
      expect(
        gameCommandRequestSchema.safeParse({ ...VALID, type, payload: {} }).success,
        `${type} with empty payload`,
      ).toBe(true);
    }
  });

  it("defaults the payload so the handler never sees undefined", () => {
    const parsed = gameCommandRequestSchema.parse({ ...VALID, type: "HIT" });
    expect(parsed.payload).toEqual({});
  });
});

describe("rejects malformed identity and versioning", () => {
  it("rejects a missing or non-uuid clientActionId", () => {
    // The idempotency ledger is keyed on this. A client that can send a
    // non-unique or absent id can replay an economic command.
    expect(gameCommandRequestSchema.safeParse(placeBet({ clientActionId: undefined })).success).toBe(false);
    expect(gameCommandRequestSchema.safeParse(placeBet({ clientActionId: "not-a-uuid" })).success).toBe(false);
    expect(gameCommandRequestSchema.safeParse(placeBet({ clientActionId: "" })).success).toBe(false);
  });

  it("rejects a non-uuid gameId", () => {
    expect(gameCommandRequestSchema.safeParse(placeBet({ gameId: "1" })).success).toBe(false);
  });

  it("rejects a negative or fractional expectedVersion", () => {
    expect(gameCommandRequestSchema.safeParse(placeBet({ expectedVersion: -1 })).success).toBe(false);
    expect(gameCommandRequestSchema.safeParse(placeBet({ expectedVersion: 1.5 })).success).toBe(false);
    expect(gameCommandRequestSchema.safeParse(placeBet({ expectedVersion: "3" })).success).toBe(false);
  });

  it("rejects a malformed timestamp", () => {
    expect(gameCommandRequestSchema.safeParse(placeBet({ clientSentAt: "yesterday" })).success).toBe(false);
  });

  it("rejects an unknown command type", () => {
    expect(gameCommandRequestSchema.safeParse(placeBet({ type: "GRANT_CHIPS" })).success).toBe(false);
    expect(gameCommandRequestSchema.safeParse(placeBet({ type: "" })).success).toBe(false);
  });
});

describe("rejects hostile bet amounts", () => {
  it("rejects negative amounts", () => {
    expect(gameCommandRequestSchema.safeParse(placeBet({ payload: { amount: -1 } })).success).toBe(false);
    expect(gameCommandRequestSchema.safeParse(placeBet({ payload: { amount: -1_000_000 } })).success).toBe(false);
  });

  it("rejects fractional amounts, which have no meaning in integer chips", () => {
    expect(chipAmountSchema.safeParse(0.5).success).toBe(false);
    expect(chipAmountSchema.safeParse(100.000001).success).toBe(false);
  });

  it("rejects NaN and the infinities", () => {
    for (const value of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      expect(chipAmountSchema.safeParse(value).success, String(value)).toBe(false);
    }
  });

  it("caps the amount well below the point where integer arithmetic breaks", () => {
    // A bet is doubled on a double-down and multiplied at settlement, so the
    // ceiling must leave headroom under Number.MAX_SAFE_INTEGER — an amount
    // that overflows mid-settlement would corrupt a balance rather than error.
    expect(chipAmountSchema.safeParse(MAX_CHIP_AMOUNT).success).toBe(true);
    expect(chipAmountSchema.safeParse(MAX_CHIP_AMOUNT + 1).success).toBe(false);
    expect(chipAmountSchema.safeParse(Number.MAX_SAFE_INTEGER).success).toBe(false);
    expect(MAX_CHIP_AMOUNT * 4).toBeLessThan(Number.MAX_SAFE_INTEGER);
  });

  it("rejects a numeric string, which would coerce silently elsewhere", () => {
    expect(chipAmountSchema.safeParse("100").success).toBe(false);
  });

  it("rejects a bet amount on a payload-free command", () => {
    expect(
      gameCommandRequestSchema.safeParse({ ...VALID, type: "HIT", payload: { amount: 100 } }).success,
    ).toBe(false);
  });
});

describe("strictness", () => {
  it("rejects unknown top-level fields rather than dropping them", () => {
    // Silently stripping an unknown key lets an attacker probe for one that is
    // read somewhere downstream.
    expect(gameCommandRequestSchema.safeParse(placeBet({ userId: "someone-else" })).success).toBe(false);
    expect(gameCommandRequestSchema.safeParse(placeBet({ seatId: "other-seat" })).success).toBe(false);
    expect(gameCommandRequestSchema.safeParse(placeBet({ balance: 999_999 })).success).toBe(false);
  });

  it("rejects unknown fields inside the payload", () => {
    expect(
      gameCommandRequestSchema.safeParse(placeBet({ payload: { amount: 100, free: true } })).success,
    ).toBe(false);
  });

  it("never lets a client name its own identity", () => {
    // Identity comes from the verified JWT. There must be no field on the wire
    // that could be mistaken for it.
    const parsed = gameCommandRequestSchema.parse(placeBet());
    expect(Object.keys(parsed)).not.toContain("userId");
    expect(Object.keys(parsed)).not.toContain("seatId");
  });
});

describe("state version bounds", () => {
  it("accepts zero and rejects anything below it", () => {
    expect(stateVersionSchema.safeParse(0).success).toBe(true);
    expect(stateVersionSchema.safeParse(-1).success).toBe(false);
  });
});
