/**
 * Arc 21 — core blackjack domain types.
 *
 * This module is runtime-neutral: it must never import React, React Native,
 * Expo, Supabase or any other host-specific package. The same types are used by
 * the mobile client, the Edge Function server and the test suite.
 */

export type Suit = "S" | "H" | "D" | "C";

export type Rank =
  | "A"
  | "2"
  | "3"
  | "4"
  | "5"
  | "6"
  | "7"
  | "8"
  | "9"
  | "10"
  | "J"
  | "Q"
  | "K";

/**
 * A single physical card in a shoe.
 *
 * `id` is unique per physical card, so a six-deck shoe holds six distinct cards
 * that are all the ace of spades. Never infer identity from rank/suit alone —
 * animations, split hands and event logs all key off `id`.
 */
export interface Card {
  id: string;
  suit: Suit;
  rank: Rank;
  /** Which physical deck (0-based) this card came from. */
  deckIndex: number;
}

/** A card whose face is not yet public. Used only in sanitized public state. */
export interface HiddenCard {
  hidden: true;
}

export type MaybeHiddenCard = Card | HiddenCard;

export function isHiddenCard(card: MaybeHiddenCard): card is HiddenCard {
  return (card as HiddenCard).hidden === true;
}

/**
 * The positive form. Needed because `filter(c => !isHiddenCard(c))` does not
 * narrow — TypeScript only propagates a type predicate in the true branch.
 */
export function isVisibleCard(card: MaybeHiddenCard): card is Card {
  return (card as HiddenCard).hidden !== true;
}

/**
 * The result of evaluating a hand. Ace handling lives in exactly one place
 * (`hand-value.ts`); nothing else in the codebase may re-derive totals.
 */
export interface HandValue {
  /** Every ace counted as 1. */
  hardTotal: number;
  /** The best total <= 21 if one exists, otherwise the hard total. */
  bestTotal: number;
  /** True when an ace is currently counted as 11. */
  isSoft: boolean;
  isBust: boolean;
  isTwentyOne: boolean;
  /** Two cards totalling 21 on an original, unsplit hand. */
  isNaturalBlackjack: boolean;
}

export interface Shoe {
  cards: Card[];
  /** Index of the next card to be dealt. */
  nextIndex: number;
  /** Increments on every shuffle; part of the public state for transparency. */
  shuffleNumber: number;
  /** When `nextIndex` reaches this, reshuffle before the next betting round. */
  cutIndex: number;
}

export type GamePhase =
  | "SESSION_READY"
  | "BETTING_OPEN"
  | "BETTING_LOCKED"
  | "INITIAL_DEAL"
  | "INSURANCE_OFFER"
  | "DEALER_PEEK"
  | "PLAYER_TURNS"
  | "DEALER_REVEAL"
  | "DEALER_TURN"
  | "SETTLEMENT"
  | "HAND_COMPLETE"
  | "BETWEEN_HANDS"
  | "SESSION_COMPLETE";

/**
 * Every value of `GamePhase`, as data, exhaustive at compile time.
 *
 * `gamePhaseSchema` in `shared/contracts` mirrors this list, and a phase the
 * engine can enter that the wire schema does not name is a payload the client
 * cannot parse — so `tests/engine/status-taxonomy.test.ts` compares them.
 */
export const ALL_GAME_PHASES = [
  "SESSION_READY",
  "BETTING_OPEN",
  "BETTING_LOCKED",
  "INITIAL_DEAL",
  "INSURANCE_OFFER",
  "DEALER_PEEK",
  "PLAYER_TURNS",
  "DEALER_REVEAL",
  "DEALER_TURN",
  "SETTLEMENT",
  "HAND_COMPLETE",
  "BETWEEN_HANDS",
  "SESSION_COMPLETE",
] as const satisfies readonly GamePhase[];

export type PlayerHandStatus =
  | "ACTIVE"
  | "STOOD"
  | "BUSTED"
  | "SURRENDERED"
  | "DOUBLED_COMPLETE"
  | "BLACKJACK"
  | "TWENTY_ONE"
  /**
   * Reserved. The engine never sets it, and no code path reads it.
   *
   * It survives because the union is MIRRORED by two other definitions that
   * cannot be narrowed as cheaply as this one — `playerHandStatusSchema` in
   * `shared/contracts` and the Postgres enum `public.player_hand_status`, from
   * which a value cannot be dropped at all. `tests/engine/status-taxonomy.test.ts`
   * asserts all three agree AND that a full session never produces this value,
   * so it stays a documented reservation rather than becoming a status somebody
   * assumes is meaningful.
   */
  | "RESOLVED";

/**
 * Every value of `PlayerHandStatus`, as data.
 *
 * The `satisfies` clause makes this exhaustive at compile time: adding a member
 * to the union without adding it here fails `tsc`. Three other definitions
 * mirror this list (the two below, the wire enum and the Postgres enum) and a
 * test compares them, because a status the engine can set and the schema cannot
 * carry is a payload that fails to parse in production.
 */
export const ALL_PLAYER_HAND_STATUSES = [
  "ACTIVE",
  "STOOD",
  "BUSTED",
  "SURRENDERED",
  "DOUBLED_COMPLETE",
  "BLACKJACK",
  "TWENTY_ONE",
  "RESOLVED",
] as const satisfies readonly PlayerHandStatus[];

/** Terminal statuses that still compete against the dealer's final total. */
export const LIVE_TERMINAL_STATUSES: readonly PlayerHandStatus[] = [
  "STOOD",
  "DOUBLED_COMPLETE",
  "BLACKJACK",
  "TWENTY_ONE",
];

/**
 * Statuses that have already lost or been withdrawn before the dealer draws.
 *
 * `playDealer` reads THIS rather than repeating the two names inline, which is
 * what it used to do. A hand in one of these states cannot be beaten or pushed,
 * so it is also the list that decides whether the dealer draws at all.
 */
export const DEAD_TERMINAL_STATUSES: readonly PlayerHandStatus[] = [
  "BUSTED",
  "SURRENDERED",
];

/** True for a hand that has finished acting, whatever the reason. */
export function isTerminalHandStatus(status: PlayerHandStatus): boolean {
  return status !== "ACTIVE";
}

export interface PlayerHand {
  id: string;
  cards: Card[];
  /** Chips committed to this specific hand, including any double. */
  wager: number;
  status: PlayerHandStatus;
  cameFromSplit: boolean;
  cameFromSplitAces: boolean;
  /** Set at settlement so the UI and stats can render without recomputing. */
  outcome?: HandOutcome;
}

export type HandOutcomeKind =
  | "WIN"
  | "LOSS"
  | "PUSH"
  | "BLACKJACK"
  | "BUST"
  | "SURRENDER";

/** Every value of `HandOutcomeKind`, as data, exhaustive at compile time. */
export const ALL_HAND_OUTCOME_KINDS = [
  "WIN",
  "LOSS",
  "PUSH",
  "BLACKJACK",
  "BUST",
  "SURRENDER",
] as const satisfies readonly HandOutcomeKind[];

export interface HandOutcome {
  kind: HandOutcomeKind;
  /** Chips returned to the seat stack (stake + profit). Never negative. */
  credit: number;
  /** Net chip change for this hand: `credit - wager`. */
  net: number;
}

/** Where a seat stands on this round's insurance offer. */
export type InsuranceDecision = "PENDING" | "TAKEN" | "DECLINED" | "NOT_OFFERED";

/** Every value of `InsuranceDecision`, as data, exhaustive at compile time. */
export const ALL_INSURANCE_DECISIONS = [
  "PENDING",
  "TAKEN",
  "DECLINED",
  "NOT_OFFERED",
] as const satisfies readonly InsuranceDecision[];

export interface SeatState {
  seatId: string;
  /** Null for an empty seat or a local practice seat with no account. */
  userId: string | null;
  displayName: string;
  /** Chips available at the table, outside of committed wagers. */
  stack: number;
  /** The bet placed for the current round before cards were dealt. */
  originalBet: number;
  insuranceBet: number;
  /** Set once the seat has answered the insurance offer this round. */
  insuranceDecision: InsuranceDecision;
  hands: PlayerHand[];
  currentHandIndex: number;
  connected: boolean;
  /** True once the seat has locked its bet for the round. */
  betLocked: boolean;
  /** Seats that joined mid-shoe sit out until the next betting round. */
  sittingOut: boolean;
  /**
   * Holds this seat out of exactly the next hand, then clears itself.
   *
   * Set by the Sprint Tournament's sudden-death rule, where a tie at an
   * elimination boundary is played out by the tied players alone. Plain
   * `sittingOut` cannot express it: the next betting round reinstates any seat
   * that is connected and can afford the minimum, which every excluded player
   * here is and can. Optional so states persisted before it existed still load.
   */
  sitOutNextHand?: boolean;
}

export interface DealerState {
  cards: Card[];
  holeCardRevealed: boolean;
}

export interface BlackjackGameState {
  gameId: string;
  rules: BlackjackRules;
  phase: GamePhase;

  seats: SeatState[];
  dealer: DealerState;

  activeSeatIndex: number | null;
  activeHandIndex: number | null;

  handNumber: number;
  /** Monotonic; every accepted command increments it exactly once. */
  version: number;

  shoe: Shoe;

  /** ISO-8601 absolute deadline. Clients render countdowns against server time. */
  actionDeadlineAt: string | null;
}

// Re-exported here so consumers can import the whole domain from one module.
export type { BlackjackRules, SplitPolicy } from "./rules.js";
import type { BlackjackRules } from "./rules.js";

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

export type PlayerActionType =
  | "HIT"
  | "STAND"
  | "DOUBLE"
  | "SPLIT"
  | "SURRENDER";

/** Every value of `PlayerActionType`, as data, exhaustive at compile time. */
export const ALL_PLAYER_ACTION_TYPES = [
  "HIT",
  "STAND",
  "DOUBLE",
  "SPLIT",
  "SURRENDER",
] as const satisfies readonly PlayerActionType[];

export type EngineCommandType =
  | "PLACE_BET"
  | "LOCK_BET"
  | "INSURANCE"
  | "DECLINE_INSURANCE"
  | PlayerActionType
  | "RESOLVE_TIMEOUT"
  | "LEAVE"
  | "NEXT_HAND"
  | "ADVANCE";

/**
 * `PLACE_BET` carries an absolute amount, not a delta. Chip taps accumulate in
 * the UI; the engine receives the final intended wager. This keeps the command
 * naturally idempotent under retry.
 */
export type EngineCommand =
  | { type: "PLACE_BET"; seatId: string; amount: number }
  | { type: "LOCK_BET"; seatId: string }
  | { type: "INSURANCE"; seatId: string }
  | { type: "DECLINE_INSURANCE"; seatId: string }
  | { type: PlayerActionType; seatId: string }
  | { type: "RESOLVE_TIMEOUT"; now: string }
  | { type: "LEAVE"; seatId: string }
  /**
   * Starts the next round from HAND_COMPLETE.
   *
   * A seat asks for it rather than the engine advancing on its own, so a
   * settlement is never animated over. `seatId` is present because only someone
   * at the table may advance it, not because the round belongs to that seat.
   */
  | { type: "NEXT_HAND"; seatId: string }
  /** Drives dealer/settlement steps. Server-issued only; never client-trusted. */
  | { type: "ADVANCE" };

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

export type EngineEvent =
  | { type: "BETTING_OPENED"; handNumber: number }
  | { type: "BET_PLACED"; seatId: string; amount: number }
  | { type: "BET_LOCKED"; seatId: string; amount: number }
  | { type: "SHOE_SHUFFLED"; shuffleNumber: number; deckCount: number }
  | { type: "CARD_DEALT"; to: "DEALER" | "SEAT"; seatId?: string; handId?: string; card: Card | null }
  | { type: "HOLE_CARD_DEALT" }
  | { type: "INSURANCE_OFFERED" }
  | { type: "INSURANCE_TAKEN"; seatId: string; amount: number }
  | { type: "INSURANCE_DECLINED"; seatId: string }
  | { type: "DEALER_PEEKED"; hasBlackjack: boolean }
  | { type: "TURN_STARTED"; seatId: string; handId: string }
  | { type: "PLAYER_ACTION"; seatId: string; handId: string; action: PlayerActionType }
  | { type: "HAND_SPLIT"; seatId: string; fromHandId: string; newHandIds: [string, string] }
  | { type: "HAND_STATUS_CHANGED"; seatId: string; handId: string; status: PlayerHandStatus }
  | { type: "HOLE_CARD_REVEALED"; card: Card }
  | { type: "DEALER_STOOD"; total: number }
  | { type: "DEALER_BUSTED"; total: number }
  | { type: "HAND_SETTLED"; seatId: string; handId: string; outcome: HandOutcome }
  | { type: "INSURANCE_SETTLED"; seatId: string; credit: number }
  | { type: "SEAT_LEFT"; seatId: string }
  | { type: "TIMEOUT_RESOLVED"; seatId: string; appliedAction: string }
  | { type: "HAND_COMPLETED"; handNumber: number }
  | { type: "SHOE_EXHAUSTED_INVARIANT"; handNumber: number };

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export type EngineErrorCode =
  | "WRONG_PHASE"
  | "UNKNOWN_SEAT"
  | "NOT_YOUR_TURN"
  | "ILLEGAL_ACTION"
  | "BET_BELOW_MINIMUM"
  | "BET_ABOVE_MAXIMUM"
  | "BET_NOT_MULTIPLE_OF_INCREMENT"
  | "INSUFFICIENT_STACK"
  | "INSURANCE_NOT_AVAILABLE"
  | "DEADLINE_NOT_REACHED"
  | "SHOE_EXHAUSTED"
  | "NO_ACTIVE_HAND";

export class EngineError extends Error {
  readonly code: EngineErrorCode;

  constructor(code: EngineErrorCode, message: string) {
    super(message);
    this.name = "EngineError";
    this.code = code;
  }
}

/**
 * Generic over the state shape so server/tournament extensions of
 * `BlackjackGameState` flow through the reducer without widening back to the
 * base type and losing their extra fields.
 */
export interface EngineResult<S extends BlackjackGameState = BlackjackGameState> {
  state: S;
  events: EngineEvent[];
}
