/**
 * What a computer player at an AI Table decides — from what it is allowed to see.
 *
 * A COMPUTER PLAYER IS A PARTICIPANT, NOT AN AUTHORITY. It decides only the
 * things a person in its seat would decide — a bet, an answer to insurance, a
 * play — and only AFTER the authoritative game has produced the situation. It
 * never touches a card, a shoe, a stack or a phase; the engine applies its
 * choice exactly as it would a person's, and refuses it exactly as it would a
 * person's if it were illegal.
 *
 * THE INFORMATION BOUNDARY IS THE TYPE OF THE ONE INPUT. `decideAiSeatAction`
 * takes an `AiSeatObservation` and nothing else, and the only builder of one,
 * `observeAiSeat`, takes a `PublicGameState` — the output of `toPublicState`,
 * which is this project's single sanitisation boundary. So the policy cannot be
 * handed the shoe, the undealt cards, the hole card or a random source by
 * accident: none of them exists in anything it is given, and this module
 * imports no type that carries them. `tests/ai-table/ai-seat-observation.test.ts`
 * proves it four ways — the observation's keys are an allowlist, its bytes carry
 * no undealt card and no unrevealed hole card, the decision is identical when
 * only hidden information differs, and this file's source names none of the
 * engine's private types.
 *
 * WHAT IT SEES: its own seat (stack, bet, cards), the dealer's UP card, the
 * legal action set the engine computed for it, and the published ruleset.
 * Other players' cards are public too, but basic strategy does not use them, so
 * they are left out rather than offered.
 *
 * HOW IT DECIDES — deterministically, with no randomness and no state:
 *
 *   betting     the table minimum, flat, every hand. If its stack cannot cover
 *               the minimum it leaves the table, which is the one legal way out
 *               of a betting round it cannot join.
 *   insurance   declined, always. Basic strategy declines insurance and even
 *               money alike, and the solved chart this project ships was solved
 *               with "insurance always declined" (see its own metadata).
 *   play        `adviseAction` — the SAME advisor that grades a player's
 *               decision and powers Learn and Analysis, reading the solved table
 *               keyed to `rulesetId@version`. There is no second chart here.
 *   no advice   where the advisor deliberately returns null, the seat STANDS.
 *               That is the engine's own stated default for an undecided hand
 *               (a lapsed action clock stands), it is legal on every active
 *               hand, and it ends the hand's turn rather than guessing at one.
 *   next hand   never. Only the person at the table decides when the next hand
 *               starts, so a settlement is never hurried for them.
 *
 * The specification's V1.1 "Table Ambience" note sketches optional personality
 * profiles with a probability of following basic strategy. Refresh C does not
 * build them: its brief asked for one deterministic, testable policy and no
 * difficulty levels or personalities. Nothing here can depend on a loss
 * streak, a balance, a level or anything else about the player — the
 * observation does not contain them.
 *
 * Runtime-neutral, like the strategy module it calls: no React, React Native,
 * Expo or Supabase import.
 */

import { isVisibleCard } from "../../../shared/blackjack/index.js";
import type {
  BlackjackRules,
  Card,
  GamePhase,
  LegalActionSet,
  PlayerActionType,
  PlayerHandStatus,
  PublicGameState,
} from "../../../shared/blackjack/index.js";
import { adviseAction, describeStrategyState } from "./strategy/index.ts";

// ---------------------------------------------------------------------------
// The observation
// ---------------------------------------------------------------------------

/** One of the AI seat's own hands, as every player at the table sees it. */
export interface AiSeatHandView {
  readonly id: string;
  readonly cards: readonly Card[];
  readonly status: PlayerHandStatus;
  readonly cameFromSplit: boolean;
}

/** The AI seat's own position: its chips, its bet and its cards. */
export interface AiSeatView {
  readonly seatId: string;
  readonly stack: number;
  readonly originalBet: number;
  readonly betLocked: boolean;
  readonly sittingOut: boolean;
  readonly connected: boolean;
  readonly hands: readonly AiSeatHandView[];
}

/**
 * Everything a computer player may know when it decides, and nothing else.
 *
 * Every field is copied out of the sanitised public snapshot, except `rules`,
 * which is the published ruleset — the rules of a table are a Fair Play claim,
 * readable by anybody, and the strategy advisor needs the whole ruleset to
 * check its chart was solved for this game. The observation holds no reference
 * into the engine's state: cards are copied, not shared.
 */
export interface AiSeatObservation {
  readonly phase: GamePhase;
  readonly seat: AiSeatView;
  /** The hand the table is asking about. Null unless it is this seat's turn. */
  readonly activeHandId: string | null;
  /** The dealer's face-up card. Never the hole card. Null before the deal. */
  readonly dealerUpCard: Card | null;
  /** What the engine says this seat may do now, exactly as the snapshot carries it. */
  readonly legal: LegalActionSet;
  readonly rules: BlackjackRules;
}

function copyCard(card: Card): Card {
  return { id: card.id, suit: card.suit, rank: card.rank, deckIndex: card.deckIndex };
}

function copyLegal(legal: LegalActionSet): LegalActionSet {
  return {
    actions: [...legal.actions],
    chipCost: { ...legal.chipCost },
    canPlaceBet: legal.canPlaceBet,
    canLockBet: legal.canLockBet,
    betBounds: legal.betBounds ? { ...legal.betBounds } : null,
    canTakeInsurance: legal.canTakeInsurance,
    canDeclineInsurance: legal.canDeclineInsurance,
    insuranceStake: legal.insuranceStake,
    insuranceIsEvenMoney: legal.insuranceIsEvenMoney,
    canStartNextHand: legal.canStartNextHand,
  };
}

/**
 * Builds an AI seat's observation from the PUBLIC snapshot.
 *
 * The only constructor of an `AiSeatObservation`, and its input is the output of
 * `toPublicState`. Returns null for a seat that is not a computer player — a
 * person's seat is never decided for, by this or anything else.
 *
 * The dealer's first card is the upcard by the engine's deal order, and the
 * snapshot replaces the unrevealed hole card with `{ hidden: true }`, so even
 * reading index 0 cannot reach it; `isVisibleCard` is the belt to that brace.
 */
export function observeAiSeat(
  table: PublicGameState,
  seatId: string,
  rules: BlackjackRules,
): AiSeatObservation | null {
  const seat = table.seats.find((candidate) => candidate.seatId === seatId);
  if (seat === undefined || seat.isAi !== true) return null;
  const legal = table.legalActions[seatId];
  if (legal === undefined) return null;

  const upcard = table.dealer.cards[0];
  return {
    phase: table.phase,
    seat: {
      seatId: seat.seatId,
      stack: seat.stack,
      originalBet: seat.originalBet,
      betLocked: seat.betLocked,
      sittingOut: seat.sittingOut,
      connected: seat.connected,
      hands: seat.hands.map((hand) => ({
        id: hand.id,
        cards: hand.cards.map(copyCard),
        status: hand.status,
        cameFromSplit: hand.cameFromSplit,
      })),
    },
    activeHandId: table.activeSeatId === seatId ? table.activeHandId : null,
    dealerUpCard: upcard !== undefined && isVisibleCard(upcard) ? copyCard(upcard) : null,
    legal: copyLegal(legal),
    rules: { ...rules },
  };
}

// ---------------------------------------------------------------------------
// The decision
// ---------------------------------------------------------------------------

/**
 * What a computer player may ask for. Deliberately narrower than the wire's
 * `GameCommandType`: there is no `INSURANCE`, because it is never taken; no
 * `NEXT_HAND`, because only the person at the table starts a hand; and no
 * `RESOLVE_TIMEOUT`, because a computer player has no clock to plead.
 */
export type AiSeatDecision =
  | { readonly type: "PLACE_BET"; readonly amount: number }
  | { readonly type: "LOCK_BET" }
  | { readonly type: "DECLINE_INSURANCE" }
  | { readonly type: PlayerActionType }
  | { readonly type: "LEAVE" };

/**
 * The play when the advisor has nothing to say.
 *
 * STAND, because it is already this engine's documented default for a hand
 * nobody decided — the action clock stands for an absent player — and because
 * it is legal on every active hand and finishes that hand's turn in one step.
 * It is not strategy and does not pretend to be.
 */
export const AI_SEAT_FALLBACK_ACTION: PlayerActionType = "STAND";

/**
 * The wager a computer player stakes: the table minimum, every hand.
 *
 * Flat betting at the minimum is the simplest rule that is always legal — the
 * engine's bounds put the minimum inside the range whenever any bet is
 * possible — and it uses nothing but the table's posted band. Taken from the
 * bounds the engine computed rather than from the ruleset, so it can never name
 * a figure the engine would refuse.
 */
export function aiSeatWager(bounds: NonNullable<LegalActionSet["betBounds"]>): number {
  return bounds.min;
}

/**
 * The basic-strategy play for the active hand, or null when the advisor has
 * none.
 *
 * `cameFromSplitAces` is not passed because the public hand does not carry it,
 * and it cannot change the answer for a hand that is still being decided: the
 * only thing it alters is whether a split hand's two-card 21 counts as a
 * natural, and a two-card 21 is completed by the engine the instant it is dealt
 * — it never reaches a decision.
 */
function recommendedPlay(observation: AiSeatObservation): PlayerActionType | null {
  const hand = observation.seat.hands.find((candidate) => candidate.id === observation.activeHandId);
  const upcard = observation.dealerUpCard;
  if (hand === undefined || upcard === null) return null;

  const strategyState = describeStrategyState(hand.cards, upcard, {
    splitPolicy: observation.rules.splitPolicy,
    cameFromSplit: hand.cameFromSplit,
    splitAceTwentyOneIsBlackjack: observation.rules.splitAceTwentyOneIsBlackjack,
  });
  if (strategyState === null) return null;

  const recommendation = adviseAction({
    rules: observation.rules,
    state: strategyState,
    legalActions: observation.legal.actions,
  });
  return recommendation?.action ?? null;
}

function decideBet(observation: AiSeatObservation): AiSeatDecision {
  const { legal } = observation;
  // A staged bet the engine will accept: commit it.
  if (legal.canLockBet) return { type: "LOCK_BET" };
  if (legal.canPlaceBet && legal.betBounds !== null) {
    return { type: "PLACE_BET", amount: aiSeatWager(legal.betBounds) };
  }
  // The stack cannot cover the table minimum. A seat that cannot bet would hold
  // the betting round open for ever — an AI table carries no clock to sit it
  // out — so it leaves, through the same LEAVE any player may send.
  return { type: "LEAVE" };
}

function decidePlay(observation: AiSeatObservation): AiSeatDecision | null {
  const actions = observation.legal.actions;
  // Not this seat's turn: the engine offers it nothing to do.
  if (actions.length === 0) return null;

  const recommended = recommendedPlay(observation);
  if (recommended !== null) return { type: recommended };
  return actions.includes(AI_SEAT_FALLBACK_ACTION) ? { type: AI_SEAT_FALLBACK_ACTION } : null;
}

/**
 * The one decision a computer player makes right now, or null when the table
 * is asking it nothing.
 *
 * Pure: the same observation always produces the same decision, and nothing
 * outside the observation is consulted. Every non-null answer is drawn from the
 * legal set the engine supplied, and the engine checks it again when it is
 * applied.
 */
export function decideAiSeatAction(observation: AiSeatObservation): AiSeatDecision | null {
  const { phase, seat, legal } = observation;
  // A seat sitting a hand out, or one that has left, is asked nothing.
  if (!seat.connected || seat.sittingOut) return null;

  switch (phase) {
    case "BETTING_OPEN":
      return seat.betLocked ? null : decideBet(observation);
    case "INSURANCE_OFFER":
      return legal.canDeclineInsurance ? { type: "DECLINE_INSURANCE" } : null;
    case "PLAYER_TURNS":
      return decidePlay(observation);
    default:
      // HAND_COMPLETE included: `canStartNextHand` is true for every seat there,
      // and a computer player deliberately never takes it.
      return null;
  }
}

/**
 * Whether the table is waiting on this seat — the question the driver asks when
 * the policy returns null, so a decision that is OWED and not made fails loudly
 * instead of committing a table that can never move again.
 *
 * Kept beside the policy so the two are read together: `decideAiSeatAction`
 * returns null exactly when this is false, and
 * `tests/ai-table/ai-seat-policy.test.ts` holds them to that over every
 * situation it generates.
 */
export function aiSeatOwesDecision(observation: AiSeatObservation): boolean {
  const { phase, seat, legal } = observation;
  if (!seat.connected || seat.sittingOut) return false;
  switch (phase) {
    case "BETTING_OPEN":
      return !seat.betLocked;
    case "INSURANCE_OFFER":
      return legal.canDeclineInsurance || legal.canTakeInsurance;
    case "PLAYER_TURNS":
      return legal.actions.length > 0;
    default:
      return false;
  }
}
