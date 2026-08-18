/**
 * Arc 21 — the session lifecycle contract.
 *
 * Opening a table and closing one are the two moments chips cross the boundary
 * between the global wallet and a server-owned table stack, so both are
 * modelled explicitly rather than being implied by a game command.
 *
 * Note what a client does NOT get to send: no buy-in amount (it is the tier's,
 * read server-side), no display name (it is the profile's), no seat id, no
 * starting stack. The only free choices are which tier to sit at and an
 * idempotency key for the retry.
 */

import { z } from "zod";
import {
  chipAmountSchema,
  isoTimestampSchema,
  tableTierSchema,
  uuidSchema,
} from "./contract-primitives.js";
import { publicGameStateSchema } from "./public-game-state.js";
import { rejectedResponseSchema } from "./command-response.js";

export const openSessionRequestSchema = z.strictObject({
  action: z.literal("OPEN"),
  clientRequestId: uuidSchema,
  tier: tableTierSchema,
  clientSentAt: isoTimestampSchema,
});

export const cashOutRequestSchema = z.strictObject({
  action: z.literal("CASH_OUT"),
  clientRequestId: uuidSchema,
  gameId: uuidSchema,
  clientSentAt: isoTimestampSchema,
});

/**
 * Deal the first hand at a private table.
 *
 * The client names the room and nothing else. Seats, stacks, stakes and the
 * shoe are all decided server-side from the room's membership — a client that
 * could name a starting stack at an unranked table could name one anywhere.
 */
export const startPrivateTableRequestSchema = z.strictObject({
  action: z.literal("START_PRIVATE_TABLE"),
  clientRequestId: uuidSchema,
  roomId: uuidSchema,
  clientSentAt: isoTimestampSchema,
});

/**
 * Put a broke seat back on the private table's fixed stack.
 *
 * Only meaningful at a private table, where the chips are the table's own and
 * unranked. There is no equivalent for a wallet-backed table and there must
 * never be one — a free reset there would mint chips.
 *
 * The client names the game and nothing else. The amount is the ruleset's.
 */
export const resetPrivateStackRequestSchema = z.strictObject({
  action: z.literal("RESET_PRIVATE_STACK"),
  clientRequestId: uuidSchema,
  gameId: uuidSchema,
  clientSentAt: isoTimestampSchema,
});

/**
 * Take a matched seat at a public table.
 *
 * This is the one shared-table action that moves real chips: the tier's buy-in
 * is debited from the global wallet into a server-owned table stack. The client
 * names the room and nothing else — the amount is the tier's, read server-side,
 * exactly as it is for a solo table.
 */
export const joinPublicTableRequestSchema = z.strictObject({
  action: z.literal("JOIN_PUBLIC_TABLE"),
  clientRequestId: uuidSchema,
  roomId: uuidSchema,
  clientSentAt: isoTimestampSchema,
});

/**
 * Start or resume today's Daily Challenge.
 *
 * The client names nothing at all. The date is the server's UTC date, the shoe
 * comes from a secret the client never sees, the stack and the hand count are the
 * challenge row's, and whether the attempt is ranked is decided server-side from
 * whether one has been used today. A client that could name the date could shop
 * for a shoe it had already seen.
 */
export const startDailyChallengeRequestSchema = z.strictObject({
  action: z.literal("START_DAILY_CHALLENGE"),
  clientRequestId: uuidSchema,
  clientSentAt: isoTimestampSchema,
});

/**
 * Enter the Sprint Tournament.
 *
 * The entry fee is the format's 500 chips, read server-side, and it is the only
 * moment a tournament touches the global wallet. The client cannot name a
 * tournament to join either: seating four strangers is the server's allocation
 * decision, made under a lock, exactly as a public table's is.
 */
export const registerSprintRequestSchema = z.strictObject({
  action: z.literal("REGISTER_SPRINT"),
  clientRequestId: uuidSchema,
  clientSentAt: isoTimestampSchema,
});

export const sessionRequestSchema = z.discriminatedUnion("action", [
  openSessionRequestSchema,
  cashOutRequestSchema,
  startPrivateTableRequestSchema,
  resetPrivateStackRequestSchema,
  joinPublicTableRequestSchema,
  startDailyChallengeRequestSchema,
  registerSprintRequestSchema,
]);

export const openedResponseSchema = z.strictObject({
  status: z.literal("opened"),
  gameId: uuidSchema,
  seatId: uuidSchema,
  buyIn: chipAmountSchema,
  walletBalance: chipAmountSchema,
  publicState: publicGameStateSchema,
});

export const cashedOutResponseSchema = z.strictObject({
  status: z.literal("cashed_out"),
  gameId: uuidSchema,
  /** Chips returned to the wallet. Zero when the stack was already empty. */
  returned: chipAmountSchema,
  walletBalance: chipAmountSchema,
});

export const privateTableStartedResponseSchema = z.strictObject({
  status: z.literal("private_table_started"),
  gameId: uuidSchema,
  roomId: uuidSchema,
  seatId: uuidSchema,
  /** Every seat starts here; no wallet was touched. */
  sessionStack: chipAmountSchema,
  publicState: publicGameStateSchema,
});

export const privateStackResetResponseSchema = z.strictObject({
  status: z.literal("private_stack_reset"),
  gameId: uuidSchema,
  seatId: uuidSchema,
  stack: chipAmountSchema,
  publicState: publicGameStateSchema,
});

export const publicSeatTakenResponseSchema = z.strictObject({
  status: z.literal("public_seat_taken"),
  gameId: uuidSchema,
  roomId: uuidSchema,
  seatId: uuidSchema,
  /** What was actually debited from the wallet for this seat. */
  buyIn: chipAmountSchema,
  walletBalance: chipAmountSchema,
  publicState: publicGameStateSchema,
});

export const dailyChallengeStartedResponseSchema = z.strictObject({
  status: z.literal("daily_challenge_started"),
  gameId: uuidSchema,
  seatId: uuidSchema,
  challengeId: uuidSchema,
  /** The published SHA-256 of the seed, so a player can verify after the reveal. */
  seedCommitment: z.string().regex(/^[0-9a-f]{64}$/),
  handCount: z.number().int().positive(),
  /** Challenge chips. They are a scoring medium and never reach the wallet. */
  startingChips: chipAmountSchema,
  /**
   * False when today's ranked attempt has already been used. The replay is
   * playable and scores nothing — said plainly rather than implied.
   */
  ranked: z.boolean(),
  publicState: publicGameStateSchema,
});

export const sprintRegisteredResponseSchema = z.strictObject({
  status: z.literal("sprint_registered"),
  tournamentId: uuidSchema,
  entryId: uuidSchema,
  /** What was actually debited. Zero on a replay of an entry already paid for. */
  entryFee: chipAmountSchema,
  walletBalance: chipAmountSchema,
  entriesFilled: z.number().int().nonnegative(),
  seatsRequired: z.number().int().positive(),
  /** Present once the field filled and the table was dealt. */
  gameId: uuidSchema.nullable(),
  seatId: uuidSchema.nullable(),
  publicState: publicGameStateSchema.nullable(),
});

export const sessionResponseSchema = z.discriminatedUnion("status", [
  openedResponseSchema,
  cashedOutResponseSchema,
  privateTableStartedResponseSchema,
  privateStackResetResponseSchema,
  publicSeatTakenResponseSchema,
  dailyChallengeStartedResponseSchema,
  sprintRegisteredResponseSchema,
  rejectedResponseSchema,
]);

export type OpenSessionRequest = z.infer<typeof openSessionRequestSchema>;
export type CashOutRequest = z.infer<typeof cashOutRequestSchema>;
export type StartPrivateTableRequest = z.infer<typeof startPrivateTableRequestSchema>;
export type ResetPrivateStackRequest = z.infer<typeof resetPrivateStackRequestSchema>;
export type JoinPublicTableRequest = z.infer<typeof joinPublicTableRequestSchema>;
export type StartDailyChallengeRequest = z.infer<typeof startDailyChallengeRequestSchema>;
export type RegisterSprintRequest = z.infer<typeof registerSprintRequestSchema>;
export type DailyChallengeStartedResponse = z.infer<typeof dailyChallengeStartedResponseSchema>;
export type SprintRegisteredResponse = z.infer<typeof sprintRegisteredResponseSchema>;
export type SessionRequest = z.infer<typeof sessionRequestSchema>;
export type OpenedResponse = z.infer<typeof openedResponseSchema>;
export type CashedOutResponse = z.infer<typeof cashedOutResponseSchema>;
export type SessionResponse = z.infer<typeof sessionResponseSchema>;

export function isOpened(response: SessionResponse): response is OpenedResponse {
  return response.status === "opened";
}

export function isCashedOut(response: SessionResponse): response is CashedOutResponse {
  return response.status === "cashed_out";
}
