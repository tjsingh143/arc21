/**
 * Arc 21 — action legality.
 *
 * There is exactly one implementation of "what may this seat do right now".
 * The client renders its controls from it; the server re-runs it before
 * accepting any command. A hidden button is a UI convenience, never a security
 * boundary — an adversarial client can send anything, so legality is decided
 * here on the authoritative state.
 */

import { isSplitEligible } from "./cards.js";
import { evaluatePlayerHand } from "./hand-value.js";
import { insuranceStakeFor } from "./settlement.js";
import type { BlackjackRules } from "./rules.js";
import type {
  BlackjackGameState,
  PlayerActionType,
  PlayerHand,
  SeatState,
} from "./types.js";

export interface LegalActionSet {
  /** Player decisions available on the seat's currently active hand. */
  actions: PlayerActionType[];
  /** Extra chips each chargeable action would commit. */
  chipCost: Partial<Record<PlayerActionType, number>>;

  canPlaceBet: boolean;
  canLockBet: boolean;
  betBounds: { min: number; max: number; increment: number } | null;

  canTakeInsurance: boolean;
  canDeclineInsurance: boolean;
  insuranceStake: number | null;
  /** True when the seat holds a natural, so the prompt reads "Even Money". */
  insuranceIsEvenMoney: boolean;

  /**
   * True at HAND_COMPLETE, where the round is settled and the table is resting.
   *
   * The engine does not start the next round by itself — a settlement must never
   * be animated over — so someone has to ask. Any seat still at the table may,
   * and the first request wins; the rest are idempotent replays.
   */
  canStartNextHand: boolean;
}

const NO_ACTIONS: LegalActionSet = {
  actions: [],
  chipCost: {},
  canPlaceBet: false,
  canLockBet: false,
  betBounds: null,
  canTakeInsurance: false,
  canDeclineInsurance: false,
  insuranceStake: null,
  insuranceIsEvenMoney: false,
  canStartNextHand: false,
};

export function findSeat(state: BlackjackGameState, seatId: string): SeatState | undefined {
  return state.seats.find((seat) => seat.seatId === seatId);
}

/** The hand a seat is currently acting on, if any. */
export function activeHandOf(seat: SeatState): PlayerHand | undefined {
  return seat.hands[seat.currentHandIndex];
}

export function isSeatsTurn(state: BlackjackGameState, seatId: string): boolean {
  if (state.phase !== "PLAYER_TURNS" || state.activeSeatIndex === null) return false;
  return state.seats[state.activeSeatIndex]?.seatId === seatId;
}

/**
 * Whether this seat may stake chips right now.
 *
 * True for every seat at an ordinary table, which takes bets from all of them at
 * once. At a SEQUENTIAL table — the Sprint Tournament — it is true only for the
 * seat the engine has named, so that earlier bets are committed and visible
 * before the next player chooses theirs.
 *
 * One definition, three callers: `getLegalActions` draws the controls from it,
 * the reducer refuses a command that contradicts it, and the server's
 * `assertCommandIsLegal` uses it to answer NOT_YOUR_TURN rather than
 * WRONG_PHASE — a distinction that matters because the first is a
 * synchronisation problem a client recovers from by re-reading the snapshot and
 * the second reads as a bug.
 */
export function isBettingTurn(state: BlackjackGameState, seatId: string): boolean {
  if (!state.rules.sequentialBetting) return true;
  if (state.activeSeatIndex === null) return false;
  return state.seats[state.activeSeatIndex]?.seatId === seatId;
}

/**
 * The maximum bet a seat can afford, respecting table limits and increment.
 * Rounds *down* to the increment so the returned value is always placeable.
 */
export function maxPlaceableBet(seat: SeatState, rules: BlackjackRules): number {
  const affordable = Math.min(seat.stack, rules.maxBet);
  return Math.floor(affordable / rules.betIncrement) * rules.betIncrement;
}

export function isBetAmountValid(
  amount: number,
  seat: SeatState,
  rules: BlackjackRules,
): { valid: boolean; reason?: string } {
  if (!Number.isInteger(amount)) return { valid: false, reason: "BET_NOT_MULTIPLE_OF_INCREMENT" };
  if (amount % rules.betIncrement !== 0) {
    return { valid: false, reason: "BET_NOT_MULTIPLE_OF_INCREMENT" };
  }
  if (amount < rules.minBet) return { valid: false, reason: "BET_BELOW_MINIMUM" };
  if (amount > rules.maxBet) return { valid: false, reason: "BET_ABOVE_MAXIMUM" };
  if (amount > seat.stack) return { valid: false, reason: "INSUFFICIENT_STACK" };
  return { valid: true };
}

/**
 * Computes everything a seat may legally do in the current state.
 *
 * `actorId` is the seat id. The server derives it from the authenticated
 * session — never from a client-supplied field.
 */
export function getLegalActions(state: BlackjackGameState, actorId: string): LegalActionSet {
  const seat = findSeat(state, actorId);
  if (!seat || seat.sittingOut) return NO_ACTIONS;

  const rules = state.rules;

  // The round is settled and the table is resting. Nothing else is legal here,
  // and the one thing that is belongs to every seat rather than to a turn.
  if (state.phase === "HAND_COMPLETE") {
    return { ...NO_ACTIONS, canStartNextHand: true };
  }

  if (state.phase === "BETTING_OPEN") {
    /*
     * A sequential table takes bets one seat at a time, so every seat but the
     * current bettor may look and not touch.
     *
     * Returning NO_ACTIONS rather than a set with `canPlaceBet: false` matters
     * for the CONTROL as much as for the command: `betBounds` goes with it, and
     * a client that still saw bounds would happily offer a chip tray to a player
     * whose turn has not arrived. The other seats' committed bets are on the
     * snapshot regardless — that is the whole point of betting in turn.
     */
    if (!isBettingTurn(state, actorId)) return NO_ACTIONS;

    const canBet = !seat.betLocked && maxPlaceableBet(seat, rules) >= rules.minBet;
    return {
      ...NO_ACTIONS,
      canPlaceBet: canBet,
      canLockBet: !seat.betLocked && isBetAmountValid(seat.originalBet, seat, rules).valid,
      betBounds: canBet
        ? { min: rules.minBet, max: maxPlaceableBet(seat, rules), increment: rules.betIncrement }
        : null,
    };
  }

  if (state.phase === "INSURANCE_OFFER") {
    if (seat.insuranceDecision !== "PENDING") return NO_ACTIONS;

    const stake = insuranceStakeFor(seat.originalBet, rules);
    const hand = seat.hands[0];
    const holdsNatural = hand
      ? evaluatePlayerHand(hand, rules.splitAceTwentyOneIsBlackjack).isNaturalBlackjack
      : false;

    return {
      ...NO_ACTIONS,
      canTakeInsurance: rules.insuranceAllowed && stake > 0 && seat.stack >= stake,
      canDeclineInsurance: true,
      insuranceStake: stake,
      insuranceIsEvenMoney: holdsNatural,
    };
  }

  if (state.phase !== "PLAYER_TURNS" || !isSeatsTurn(state, actorId)) {
    return NO_ACTIONS;
  }

  const hand = activeHandOf(seat);
  if (!hand || hand.status !== "ACTIVE") return NO_ACTIONS;

  const actions: PlayerActionType[] = [];
  const chipCost: Partial<Record<PlayerActionType, number>> = {};

  // --- Hit -----------------------------------------------------------------
  // A split ace receives exactly one card and is completed by the engine, so it
  // should never be ACTIVE here. The guard is belt-and-braces against a future
  // ruleset that permits hitting split aces.
  const hitBlockedBySplitAce = hand.cameFromSplitAces && !rules.hitSplitAcesAllowed;
  if (!hitBlockedBySplitAce) {
    actions.push("HIT");
  }

  // --- Stand ---------------------------------------------------------------
  actions.push("STAND");

  // --- Double --------------------------------------------------------------
  const isTwoCardHand = hand.cards.length === 2;
  const doubleAllowedHere =
    rules.doubleAllowed &&
    rules.doubleOnAnyTwoCards &&
    isTwoCardHand &&
    (!hand.cameFromSplit || rules.doubleAfterSplit) &&
    (!hand.cameFromSplitAces || rules.doubleSplitAcesAllowed) &&
    seat.stack >= hand.wager;

  if (doubleAllowedHere) {
    actions.push("DOUBLE");
    chipCost.DOUBLE = hand.wager;
  }

  // --- Split ---------------------------------------------------------------
  if (isTwoCardHand && seat.hands.length < rules.maxSplitHands && seat.stack >= hand.wager) {
    const [first, second] = hand.cards as [PlayerHand["cards"][number], PlayerHand["cards"][number]];
    if (isSplitEligible(first, second, rules.splitPolicy)) {
      const splittingAces = first.rank === "A";
      const aceSplitPermitted = !splittingAces || rules.splitAcesAllowed;
      const resplitAcePermitted = !(splittingAces && hand.cameFromSplitAces) || rules.resplitAcesAllowed;

      if (aceSplitPermitted && resplitAcePermitted) {
        actions.push("SPLIT");
        chipCost.SPLIT = hand.wager;
      }
    }
  }

  // --- Surrender -----------------------------------------------------------
  // Late surrender: original two-card unsplit hand only, and only once the
  // dealer has already checked for blackjack (guaranteed by PLAYER_TURNS).
  const surrenderAllowedHere =
    rules.lateSurrenderAllowed &&
    isTwoCardHand &&
    !hand.cameFromSplit &&
    seat.hands.length === 1;

  if (surrenderAllowedHere) {
    actions.push("SURRENDER");
  }

  return {
    ...NO_ACTIONS,
    actions,
    chipCost,
  };
}

/**
 * Convenience predicate over `getLegalActions`, for a caller that wants one
 * answer rather than the whole set.
 *
 * It used to claim the SERVER called it "before applying a command". The server
 * does not: `engine-bridge.assertCommandIsLegal` reads the full
 * `LegalActionSet`, because it has to distinguish "not your turn" from "not a
 * legal action" and needs the chip costs anyway. Nothing else calls this either.
 * It is kept because it is the natural one-question form of the same lookup, and
 * `tests/engine/engine-api.test.ts` pins it to `getLegalActions` so the two can
 * never answer differently — but the comment now says what is true, because a
 * false claim about a call site is how a control ends up guarded by nothing.
 */
export function isActionLegal(
  state: BlackjackGameState,
  actorId: string,
  action: PlayerActionType,
): boolean {
  return getLegalActions(state, actorId).actions.includes(action);
}
