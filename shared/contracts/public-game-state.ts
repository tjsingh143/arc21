/**
 * Arc 21 — the sanitised snapshot contract.
 *
 * This mirrors `PublicGameState` from shared/blackjack/public-state.ts, which is
 * the ONLY function permitted to produce a client-visible payload. The schema
 * exists so the client can validate what it receives and so a server refactor
 * that widens the public shape fails a test rather than leaking silently.
 *
 * `tests/contracts/public-state-contract.test.ts` asserts, at compile time and
 * at runtime, that this schema and the engine's interface describe the same
 * object. Adding a field to one without the other fails the suite.
 */

import { z } from "zod";
import {
  playerActionTypeSchema,
  cardSchema,
  chipAmountSchema,
  gamePhaseSchema,
  handOutcomeSchema,
  maybeHiddenCardSchema,
  playerHandStatusSchema,
  stateVersionSchema,
} from "./contract-primitives.js";

export const publicHandSchema = z.strictObject({
  id: z.string().min(1).max(128),
  /** Player cards are public in blackjack — every seat sees them. */
  cards: z.array(cardSchema),
  wager: chipAmountSchema,
  status: playerHandStatusSchema,
  cameFromSplit: z.boolean(),
  /** Null when the hand holds no cards. */
  total: z.int().min(0).max(64).nullable(),
  isSoft: z.boolean(),
  outcome: handOutcomeSchema.optional(),
});

export const publicSeatSchema = z.strictObject({
  seatId: z.string().min(1).max(128),
  userId: z.string().min(1).max(128).nullable(),
  displayName: z.string().min(1).max(64),
  stack: chipAmountSchema,
  originalBet: chipAmountSchema,
  insuranceBet: chipAmountSchema,
  hands: z.array(publicHandSchema),
  connected: z.boolean(),
  sittingOut: z.boolean(),
  betLocked: z.boolean(),
});

export const publicRulesSummarySchema = z.strictObject({
  deckCount: z.int().min(1).max(16),
  dealerHitsSoft17: z.boolean(),
  /** Rendered as a ratio, e.g. "3:2". */
  blackjackPayout: z.string().min(3).max(16),
  surrenderAllowed: z.boolean(),
  doubleAfterSplit: z.boolean(),
});

export const publicDealerSchema = z.strictObject({
  /**
   * The hole card appears as `{ hidden: true }` until reveal. It is replaced
   * rather than omitted so the client can render a face-down card without ever
   * receiving its identity.
   */
  cards: z.array(maybeHiddenCardSchema),
  /** Value of the face-up cards only, until the hole card is revealed. */
  displayedTotal: z.int().min(0).max(64).nullable(),
  holeCardRevealed: z.boolean(),
});

export const publicShoeSchema = z.strictObject({
  shuffleNumber: z.int().min(0),
  /** Rounded to the nearest half deck; never an exact count, never an order. */
  approximateRemainingDecks: z.number().min(0),
});

/**
 * Legality as the server computed it, per seat.
 *
 * Validated like everything else that crosses the wire: a malformed set would
 * otherwise render buttons that the server is about to refuse.
 */
const legalActionSetSchema = z.object({
  actions: z.array(playerActionTypeSchema),
  chipCost: z.record(z.string(), z.number().int().nonnegative()),
  canPlaceBet: z.boolean(),
  canLockBet: z.boolean(),
  betBounds: z
    .object({
      min: z.number().int().nonnegative(),
      max: z.number().int().nonnegative(),
      increment: z.number().int().positive(),
    })
    .nullable(),
  canTakeInsurance: z.boolean(),
  canDeclineInsurance: z.boolean(),
  insuranceStake: z.number().int().nonnegative().nullable(),
  insuranceIsEvenMoney: z.boolean(),
});

/**
 * What the table is allowed to TELL the player, when the session asked for help.
 *
 * Present only on a session whose `assistance` is `learn` or `analysis`, and
 * only while it is that seat's turn. Computed on the SERVER from authoritative
 * state by the same advisor that grades the decision — there is one chart in
 * this system, and a client that rebuilt advice locally would be a second
 * implementation of it.
 *
 * It leaks nothing. Every input is already visible: the player's own cards and
 * the dealer's UP card. The hole card is never consulted, which is the same
 * rule `computeAdvice` follows on the Practice table.
 */
export const publicAdviceSchema = z.strictObject({
  seatId: z.string().min(1).max(128),
  recommended: playerActionTypeSchema,
  /** Chart-style, e.g. "Hard 16 against 10". */
  explanation: z.string().min(1).max(160),
  /**
   * Expectation per legal action, in MILLIONTHS of one unit wagered. Integers,
   * because no float decides anything a player is scored on — and `analysis`
   * only. `learn` gets the recommendation and no numbers.
   */
  actionEvMicros: z.record(z.string(), z.int()).nullable(),
});

export const publicGameStateSchema = z.strictObject({
  gameId: z.string().min(1).max(128),
  version: stateVersionSchema,
  phase: gamePhaseSchema,
  rulesSummary: publicRulesSummarySchema,
  handNumber: z.int().min(0),
  seats: z.array(publicSeatSchema),
  dealer: publicDealerSchema,
  activeSeatId: z.string().min(1).max(128).nullable(),
  activeHandId: z.string().min(1).max(128).nullable(),
  /** Absolute server deadline. Clients render countdowns against server time. */
  deadlineAt: z.string().min(1).max(64).nullable(),
  shoe: publicShoeSchema,
  legalActions: z.record(z.string(), legalActionSetSchema),
  /**
   * Null on every unassisted table, which is all of them except a Quick Play
   * session the player opened in Learn or Analysis.
   */
  advice: publicAdviceSchema.nullable().optional(),
});

export type ContractPublicAdvice = z.infer<typeof publicAdviceSchema>;
export type ContractPublicHand = z.infer<typeof publicHandSchema>;
export type ContractPublicSeat = z.infer<typeof publicSeatSchema>;
export type ContractPublicGameState = z.infer<typeof publicGameStateSchema>;
