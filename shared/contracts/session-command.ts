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
  cardSchema,
  chipAmountSchema,
  isoTimestampSchema,
  tableTierSchema,
  uuidSchema,
} from "./contract-primitives.js";
import { publicGameStateSchema } from "./public-game-state.js";
import { rejectedResponseSchema } from "./command-response.js";

/**
 * A career node's slug, which is also `career_nodes.code`.
 *
 * The same pattern the column's CHECK constraint carries, so a slug the
 * database would refuse never reaches it.
 */
export const careerNodeSlugSchema = z.string().regex(/^[a-z0-9-]{3,40}$/);

/**
 * One drill scenario, as the server issues it.
 *
 * Deliberately the whole visible situation and nothing more: the player's cards,
 * the dealer's UP card, and which actions are legal. There is no hole card here
 * — a drill has no dealer hand to resolve — and no recommended action, because
 * that is the question.
 */
export const careerDrillScenarioSchema = z.strictObject({
  index: z.number().int().nonnegative(),
  /** Real `Card`s, not codes: the drill screen renders them with `PlayingCard`. */
  playerCards: z.array(cardSchema).min(2).max(2),
  dealerUpCard: cardSchema,
  legalActions: z.array(z.enum(["HIT", "STAND", "DOUBLE", "SPLIT", "SURRENDER"])).min(2),
  label: z.string().min(1).max(64),
  upcardLabel: z.string().min(1).max(16),
});

/**
 * How much help a Quick Play table shows.
 *
 * `learn` and `analysis` put the recommended play — and, for analysis, the
 * expectation of every legal action — on screen BEFORE the choice. The
 * specification excludes exactly that from the qualified strategy-accuracy
 * board, and `solo` is on that board, so the choice is recorded on the SESSION
 * and never revised: a client that could name its assistance per decision could
 * opt a mistake out of its own accuracy.
 *
 * Only Quick Play offers a choice. Every other mode is `play`.
 */
export const assistanceModeSchema = z.enum(["play", "learn", "analysis", "challenge"]);

export const openSessionRequestSchema = z.strictObject({
  action: z.literal("OPEN"),
  clientRequestId: uuidSchema,
  tier: tableTierSchema,
  /** Omitted means `play` — unassisted, and counted. */
  assistance: assistanceModeSchema.optional(),
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

/**
 * Leave the Sprint Tournament queue and take the entry fee back.
 *
 * THE HOLE THIS CLOSES. Registration debits 500 chips and holds the player in
 * the oldest tournament still short of players — and until this existed there
 * was no way out of one that never filled. `registerSprint` returns the SAME
 * entry to anybody already in a `registering` or `running` tournament, so a
 * player whose three companions never arrived was locked to it permanently:
 * the fee spent, the screen reading "Waiting for 3 more players", and every
 * other online mode refusing them for as long as it lasted. Measured, not
 * inferred.
 *
 * The specification's own error handling asks for exactly this half: "if a
 * committed tournament is cancelled server-side, refund through ledger". A
 * cancellation with no way to trigger it is a feature that does not exist, so
 * the player may trigger it themselves while the field is still filling.
 *
 * It names no tournament. The server refunds the entry the CALLER holds, which
 * is the only one they could have, for the same reason registration lets nobody
 * choose which tournament to sit in.
 */
export const withdrawSprintRequestSchema = z.strictObject({
  action: z.literal("WITHDRAW_SPRINT"),
  clientRequestId: uuidSchema,
  clientSentAt: isoTimestampSchema,
});

/**
 * Start or resume a reward-bearing attempt at a career node.
 *
 * The client names the NODE and nothing else. Not the shoe, not the bankroll,
 * not the hand count, not whether the prerequisite is met and certainly not the
 * result: all of those are read from the catalogue and the player's own
 * progress, server-side. The specification puts career rewards on the server
 * and says a reward-bearing attempt requires server authority — this is the
 * command that makes that true, and the local runner in `src/features/career`
 * stays exactly what it was: playable offline, and worth nothing.
 */
export const startCareerNodeRequestSchema = z.strictObject({
  action: z.literal("START_CAREER_NODE"),
  clientRequestId: uuidSchema,
  /** `CareerNode.slug`, which is also `career_nodes.code`. One key, one catalogue. */
  nodeSlug: careerNodeSlugSchema,
  clientSentAt: isoTimestampSchema,
});

/**
 * Answer a drill.
 *
 * A drill is not a dealt hand: its scenarios are constructed to put one
 * decision family in front of the player repeatedly. They are constructed from
 * a secret the SERVER holds, and regenerated here to grade against — so a
 * client may answer whatever it likes, but it cannot answer an easier question
 * than the one it was asked, and it cannot decide what its answer was worth.
 *
 * The whole attempt arrives at once, which is no weaker than one answer at a
 * time: a modified client that knows basic strategy can answer perfectly in
 * either shape. What matters is that the GRADE is the server's, and the reward
 * follows the grade.
 */
export const submitCareerDrillRequestSchema = z.strictObject({
  action: z.literal("SUBMIT_CAREER_DRILL"),
  clientRequestId: uuidSchema,
  attemptId: uuidSchema,
  /** One action per scenario, in the order they were issued. */
  answers: z.array(z.enum(["HIT", "STAND", "DOUBLE", "SPLIT", "SURRENDER"])).min(1).max(100),
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
  withdrawSprintRequestSchema,
  startCareerNodeRequestSchema,
  submitCareerDrillRequestSchema,
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

/**
 * The entry given up and the fee returned.
 *
 * `refundChips` is what actually moved, so a replay reports zero rather than
 * claiming a second refund — the same honesty `entryFee` shows on a re-entry.
 * `tournamentCancelled` is true when the withdrawal emptied the tournament and
 * the server closed it; a tournament with other people still waiting in it
 * carries on without the leaver.
 */
export const sprintWithdrawnResponseSchema = z.strictObject({
  status: z.literal("sprint_withdrawn"),
  tournamentId: uuidSchema,
  entryId: uuidSchema,
  refundChips: chipAmountSchema,
  walletBalance: chipAmountSchema,
  tournamentCancelled: z.boolean(),
});

/**
 * A career node, opened.
 *
 * Two shapes in one response because a career node has two formats and the
 * client must be told which it got. A STANDARD node returns a table — game id,
 * seat id, public state — and is played through `game-command` like any other
 * server session. A DRILL returns its scenarios and no table at all.
 *
 * `stars` on a previous best and `rewardPaid` are included so the screen can
 * say what is actually at stake: a node completed before still awards stars,
 * but its first-completion reward has already been paid and will not be paid
 * again. Saying that plainly beats a player discovering it afterwards.
 */
export const careerNodeStartedResponseSchema = z.strictObject({
  status: z.literal("career_node_started"),
  attemptId: uuidSchema,
  nodeSlug: careerNodeSlugSchema,
  format: z.enum(["standard", "drill"]),
  startingChips: chipAmountSchema,
  /** Non-null for a standard node; null for a drill, which has no table. */
  gameId: uuidSchema.nullable(),
  seatId: uuidSchema.nullable(),
  publicState: publicGameStateSchema.nullable(),
  /** Non-empty for a drill, empty for a standard node. */
  scenarios: z.array(careerDrillScenarioSchema),
  /** Best stars already recorded for this node, 0 if never completed. */
  bestStars: z.number().int().min(0).max(3),
  /** True when the first-completion reward has already been paid for this node. */
  rewardPaid: z.boolean(),
});

/** A graded drill, as the server scored it. */
export const careerDrillGradedResponseSchema = z.strictObject({
  status: z.literal("career_drill_graded"),
  attemptId: uuidSchema,
  nodeSlug: careerNodeSlugSchema,
  stars: z.number().int().min(0).max(3),
  decisions: z.number().int().nonnegative(),
  correct: z.number().int().nonnegative(),
  /** Chips actually credited. Zero on a repeat completion. */
  rewardChips: chipAmountSchema,
  rewardXp: z.number().int().nonnegative(),
  walletBalance: chipAmountSchema,
  /** Per scenario, in the order they were answered. */
  verdicts: z.array(
    z.strictObject({
      chosen: z.enum(["HIT", "STAND", "DOUBLE", "SPLIT", "SURRENDER"]),
      recommended: z.enum(["HIT", "STAND", "DOUBLE", "SPLIT", "SURRENDER"]),
      correct: z.boolean(),
    }),
  ),
});

export const sessionResponseSchema = z.discriminatedUnion("status", [
  openedResponseSchema,
  cashedOutResponseSchema,
  privateTableStartedResponseSchema,
  privateStackResetResponseSchema,
  publicSeatTakenResponseSchema,
  dailyChallengeStartedResponseSchema,
  sprintRegisteredResponseSchema,
  sprintWithdrawnResponseSchema,
  careerNodeStartedResponseSchema,
  careerDrillGradedResponseSchema,
  rejectedResponseSchema,
]);

export type AssistanceMode = z.infer<typeof assistanceModeSchema>;
export type StartCareerNodeRequest = z.infer<typeof startCareerNodeRequestSchema>;
export type SubmitCareerDrillRequest = z.infer<typeof submitCareerDrillRequestSchema>;
export type CareerDrillScenario = z.infer<typeof careerDrillScenarioSchema>;
export type CareerNodeStartedResponse = z.infer<typeof careerNodeStartedResponseSchema>;
export type CareerDrillGradedResponse = z.infer<typeof careerDrillGradedResponseSchema>;
export type OpenSessionRequest = z.infer<typeof openSessionRequestSchema>;
export type CashOutRequest = z.infer<typeof cashOutRequestSchema>;
export type StartPrivateTableRequest = z.infer<typeof startPrivateTableRequestSchema>;
export type ResetPrivateStackRequest = z.infer<typeof resetPrivateStackRequestSchema>;
export type JoinPublicTableRequest = z.infer<typeof joinPublicTableRequestSchema>;
export type StartDailyChallengeRequest = z.infer<typeof startDailyChallengeRequestSchema>;
export type RegisterSprintRequest = z.infer<typeof registerSprintRequestSchema>;
export type WithdrawSprintRequest = z.infer<typeof withdrawSprintRequestSchema>;
export type SprintWithdrawnResponse = z.infer<typeof sprintWithdrawnResponseSchema>;
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
