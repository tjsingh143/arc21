/**
 * The AI Table's wire contract (Astra Refresh C).
 *
 * `OPEN_AI_TABLE` is the whole of what a client says to sit down with computer
 * players, and the point of these tests is what it CANNOT say. A client that
 * could name how many computer players there are, what they hold, what they
 * bet or how they play could arrange the table it is about to play at — so the
 * request carries an idempotency key and a timestamp and nothing else, and the
 * strict schema refuses every field a modified client might add.
 *
 * The reply is a closed economy's reply: a table stack that came from nowhere,
 * and deliberately no buy-in and no wallet balance, because nothing left the
 * wallet and nothing will go back to it.
 */

import { describe, expect, it } from "vitest";

import { toPublicState } from "../../shared/blackjack/index.js";
import {
  aiTableOpenedResponseSchema,
  openAiTableRequestSchema,
  sessionRequestSchema,
  sessionResponseSchema,
} from "../../shared/contracts/index.js";
import { aiTable } from "../helpers/ai-table-harness.js";

const REQUEST = {
  action: "OPEN_AI_TABLE",
  clientRequestId: "6f1c0b4e-1f53-4c8e-9d3e-2a7b5c9d0e11",
  clientSentAt: "2026-10-05T12:00:00.000Z",
} as const;

describe("asking for an AI table", () => {
  it("needs an idempotency key and a timestamp, and nothing else", () => {
    expect(openAiTableRequestSchema.safeParse(REQUEST).success).toBe(true);
    expect(sessionRequestSchema.safeParse(REQUEST).success).toBe(true);
  });

  it.each([
    ["how many computer players", { aiSeats: 4 }],
    ["their stacks", { aiStack: 1 }],
    ["the person's stack", { stack: 1_000_000 }],
    ["a seat", { seatId: "6f1c0b4e-1f53-4c8e-9d3e-2a7b5c9d0e12" }],
    ["a difficulty", { difficulty: "easy" }],
    ["a bet for them", { aiBet: 500 }],
    ["a stake band", { minBet: 1 }],
    ["a ranked flag", { ranked: true }],
  ])("refuses a client that tries to name %s", (_what, extra) => {
    expect(openAiTableRequestSchema.safeParse({ ...REQUEST, ...extra }).success).toBe(false);
    expect(sessionRequestSchema.safeParse({ ...REQUEST, ...extra }).success).toBe(false);
  });

  it("refuses a request with no idempotency key, so a retry is always recognisable", () => {
    const { clientRequestId: _id, ...withoutKey } = REQUEST;
    void _id;
    expect(openAiTableRequestSchema.safeParse(withoutKey).success).toBe(false);
    expect(
      openAiTableRequestSchema.safeParse({ ...REQUEST, clientRequestId: "not-a-uuid" }).success,
    ).toBe(false);
  });
});

describe("the answer", () => {
  const publicState = toPublicState(aiTable({ shoe: "10S 9H 10D 6C 7S 7H 9D 10C" }));
  const REPLY = {
    status: "ai_table_opened",
    gameId: "0d5a4a59-4f0e-4b0f-8b1c-1a2b3c4d5e6f",
    seatId: "9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d",
    tableStack: 5_000,
    resumed: false,
    publicState,
  };

  it("is a table address, the stack every seat started on, and the snapshot", () => {
    expect(aiTableOpenedResponseSchema.safeParse(REPLY).success).toBe(true);
    expect(sessionResponseSchema.safeParse(REPLY).success).toBe(true);
  });

  it("says when it is the table the player already held", () => {
    expect(aiTableOpenedResponseSchema.parse({ ...REPLY, resumed: true }).resumed).toBe(true);
    const { resumed: _resumed, ...withoutResumed } = REPLY;
    void _resumed;
    expect(aiTableOpenedResponseSchema.safeParse(withoutResumed).success).toBe(false);
  });

  it("carries no buy-in and no wallet balance — none moved, and none will", () => {
    expect(aiTableOpenedResponseSchema.safeParse({ ...REPLY, buyIn: 5_000 }).success).toBe(false);
    expect(aiTableOpenedResponseSchema.safeParse({ ...REPLY, walletBalance: 25_000 }).success).toBe(
      false,
    );
  });

  it("carries the computer players in its snapshot, marked as such", () => {
    const parsed = aiTableOpenedResponseSchema.parse(REPLY);
    expect(parsed.publicState.seats.filter((seat) => seat.isAi === true)).toHaveLength(2);
  });
});
