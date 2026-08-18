/**
 * Arc 21 — the command response contract.
 *
 * Three outcomes, and nothing else:
 *
 *   accepted  the command changed authoritative state. Carries the new
 *             sanitised snapshot and the events that produced it.
 *   stale     the client acted on an old version. NOTHING was applied; the
 *             authoritative snapshot comes back so the client can resynchronise
 *             and decide for itself whether to retry.
 *   rejected  the command was not legal, not authorised, or not understood.
 *             Carries a stable machine-readable code and a message that is safe
 *             to show a user — never SQL, never a stack trace, never a row.
 */

import { z } from "zod";
import { publicGameStateSchema } from "./public-game-state.js";
import { publicGameEventSchema } from "./game-event.js";

/**
 * Stable rejection codes. Clients branch on these; the message is for humans and
 * may be reworded at any time.
 *
 * The set is deliberately coarse where being precise would help an attacker.
 * `NOT_A_PARTICIPANT` covers both "no such game" and "not your game", so a
 * modified client cannot enumerate live session ids by comparing responses.
 */
export const COMMAND_REJECTION_CODES = [
  /** No credential, malformed credential, or a token that failed verification. */
  "UNAUTHENTICATED",
  /** The caller holds no live seat in this session — or it does not exist. */
  "NOT_A_PARTICIPANT",
  /** The request body failed schema validation. */
  "INVALID_REQUEST",
  /** This clientActionId was first used by a different account. */
  "IDEMPOTENCY_CONFLICT",
  /** The session is finished; no further commands are accepted. */
  "SESSION_CLOSED",
  /** The session is mid-hand and cannot be closed or cashed out right now. */
  "SESSION_BUSY",
  /** The caller already holds a live seat at another table. */
  "SESSION_ALREADY_ACTIVE",
  /** The table tier is above the caller's level. */
  "TABLE_LOCKED",

  // --- mapped one-for-one from EngineErrorCode -----------------------------
  "WRONG_PHASE",
  "UNKNOWN_SEAT",
  "NOT_YOUR_TURN",
  "ILLEGAL_ACTION",
  "BET_BELOW_MINIMUM",
  "BET_ABOVE_MAXIMUM",
  "BET_NOT_MULTIPLE_OF_INCREMENT",
  "INSUFFICIENT_STACK",
  "INSURANCE_NOT_AVAILABLE",
  "DEADLINE_NOT_REACHED",
  "SHOE_EXHAUSTED",
  "NO_ACTIVE_HAND",

  /** Too many commands too quickly. */
  "RATE_LIMITED",
  /** Anything unexpected. The detail is logged server-side and never returned. */
  "INTERNAL",
] as const;

export const commandRejectionCodeSchema = z.enum(COMMAND_REJECTION_CODES);

export type CommandRejectionCode = (typeof COMMAND_REJECTION_CODES)[number];

export const acceptedResponseSchema = z.strictObject({
  status: z.literal("accepted"),
  publicState: publicGameStateSchema,
  events: z.array(publicGameEventSchema),
});

export const staleResponseSchema = z.strictObject({
  status: z.literal("stale"),
  publicState: publicGameStateSchema,
});

export const rejectedResponseSchema = z.strictObject({
  status: z.literal("rejected"),
  code: commandRejectionCodeSchema,
  message: z.string().min(1).max(300),
});

export const gameCommandResponseSchema = z.discriminatedUnion("status", [
  acceptedResponseSchema,
  staleResponseSchema,
  rejectedResponseSchema,
]);

export type AcceptedResponse = z.infer<typeof acceptedResponseSchema>;
export type StaleResponse = z.infer<typeof staleResponseSchema>;
export type RejectedResponse = z.infer<typeof rejectedResponseSchema>;
export type GameCommandResponse = z.infer<typeof gameCommandResponseSchema>;

// ---------------------------------------------------------------------------
// Narrowing helpers
//
// These exist so callers never reach for `response.publicState` before proving
// the branch. TypeScript narrows the union from the return type.
// ---------------------------------------------------------------------------

export function isAccepted(response: GameCommandResponse): response is AcceptedResponse {
  return response.status === "accepted";
}

export function isStale(response: GameCommandResponse): response is StaleResponse {
  return response.status === "stale";
}

export function isRejected(response: GameCommandResponse): response is RejectedResponse {
  return response.status === "rejected";
}

/**
 * True for the two branches that carry an authoritative snapshot. A client uses
 * this to update its cache without caring whether its own command was applied.
 */
export function hasPublicState(
  response: GameCommandResponse,
): response is AcceptedResponse | StaleResponse {
  return response.status === "accepted" || response.status === "stale";
}
