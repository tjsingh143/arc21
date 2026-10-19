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
  /**
   * A computer-controlled seat at an AI Table. Only ever `true`, and present only
   * on such a seat — see `PublicSeat.isAi`, which this mirrors key for key.
   * `z.literal(true)` rather than `z.boolean()` because the engine never sends
   * `false`, and accepting a value nothing produces is how a schema drifts.
   */
  isAi: z.literal(true).optional(),
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
/*
 * STRICT, like every other schema in this directory — and it was the ONE that
 * was not.
 *
 * Sixty-one schemas across `shared/contracts` use `z.strictObject`, which
 * REJECTS a key it does not know. This one used `z.object`, which silently
 * deletes it, and that is how `canStartNextHand` reached the client as
 * `undefined` for a whole phase with no error anywhere (see the field's own
 * note below). Nothing chose the exception; it was a `strict` somebody did not
 * type, and the cost was the only way to play a second hand at a server table.
 *
 * The trade is deliberate and is the one the rest of this directory already
 * made: a client older than its server FAILS LOUDLY rather than rendering a
 * table with a control quietly missing. This app ships its Edge Functions and
 * its bundle together, so the two are never far apart — and of the two failure
 * modes, the loud one is the only one anybody would notice.
 */
const legalActionSetSchema = z.strictObject({
  actions: z.array(playerActionTypeSchema),
  chipCost: z.record(z.string(), z.number().int().nonnegative()),
  canPlaceBet: z.boolean(),
  canLockBet: z.boolean(),
  betBounds: z
    .strictObject({
      min: z.number().int().nonnegative(),
      max: z.number().int().nonnegative(),
      increment: z.number().int().positive(),
    })
    .nullable(),
  canTakeInsurance: z.boolean(),
  canDeclineInsurance: z.boolean(),
  insuranceStake: z.number().int().nonnegative().nullable(),
  insuranceIsEvenMoney: z.boolean(),
  /**
   * True at HAND_COMPLETE, and MISSING FROM THIS SCHEMA FOR A WHOLE PHASE.
   *
   * `z.object` strips unknown keys, so a field the engine sends and this schema
   * does not name is deleted on the way in — silently, with no parse error,
   * because a narrower payload is a valid one. The server sent
   * `canStartNextHand: true`, the client received `undefined`, and
   * `app/table/[gameId].tsx` gates the "Next hand" button on it. So **no online
   * table could start a second hand through the UI** — private, public, Quick
   * Play, tournament or daily. The screen fell through to "Waiting for the next
   * hand.", which is a sentence describing the very thing it was preventing.
   *
   * The third defect of this exact shape in this project, after the Deal button
   * and the insurance sheet, and the hardest of the three to see: the other two
   * were a missing predicate and a missing branch, both visible in the screen's
   * own source. This one is a correct branch reading a field that something
   * else had already deleted.
   *
   * The module header above has always claimed
   * `tests/contracts/public-state-contract.test.ts` asserts that this schema and
   * the engine's interface describe the same object. THAT FILE DID NOT EXIST.
   * It does now, it round-trips a real engine payload through this schema and
   * compares key for key, and it fails if any field is dropped from any level.
   */
  canStartNextHand: z.boolean(),
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
