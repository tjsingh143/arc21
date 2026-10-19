/**
 * Arc 21 — public state sanitisation.
 *
 * This is the security boundary between authoritative server state and
 * everything a client is allowed to observe. `toPublicState` is the ONLY
 * function permitted to produce a payload for Realtime broadcast, API
 * responses, client caches, logs or analytics.
 *
 * It must never emit:
 *   - the shoe's card order (past order is fine, future order is not)
 *   - the dealer's hole card before it is revealed
 *   - another seat's private bookkeeping
 *
 * The engine state deliberately contains all of that, which is exactly why
 * nothing may serialise `BlackjackGameState` directly.
 */

import { getLegalActions, type LegalActionSet } from "./legal-actions.js";
import { approximateDecksRemaining } from "./shoe.js";
import { evaluateHand, evaluatePlayerHand } from "./hand-value.js";
import type {
  BlackjackGameState,
  Card,
  GamePhase,
  HandOutcome,
  MaybeHiddenCard,
  PlayerActionType,
  PlayerHandStatus,
} from "./types.js";

export interface PublicHand {
  id: string;
  cards: Card[];
  wager: number;
  status: PlayerHandStatus;
  cameFromSplit: boolean;
  /** Best total, or null when the hand holds no cards. */
  total: number | null;
  isSoft: boolean;
  outcome?: HandOutcome;
}

export interface PublicSeat {
  seatId: string;
  userId: string | null;
  displayName: string;
  stack: number;
  originalBet: number;
  insuranceBet: number;
  hands: PublicHand[];
  connected: boolean;
  sittingOut: boolean;
  betLocked: boolean;
  /**
   * Present, and true, only on a computer-controlled seat at an AI Table.
   *
   * ABSENT rather than `false` on every other seat, for the reason `outcome`
   * is absent on an unsettled hand: the wire contract is strict, so a key an
   * older client has never heard of would make it refuse EVERY table's snapshot.
   * Emitted only where it is true, the payload of every existing table is byte
   * for byte what it was, and only a table that really does seat computer
   * players carries anything new.
   *
   * It is the client's ONLY way to tell a computer player from a person. A
   * display name is not that: names are free text a player chooses.
   */
  isAi?: true;
}

export interface PublicGameState {
  gameId: string;
  version: number;
  phase: GamePhase;

  rulesSummary: {
    deckCount: number;
    dealerHitsSoft17: boolean;
    blackjackPayout: string;
    surrenderAllowed: boolean;
    doubleAfterSplit: boolean;
  };

  handNumber: number;

  seats: PublicSeat[];
  dealer: {
    cards: MaybeHiddenCard[];
    /** Value of the face-up cards only, until the hole card is revealed. */
    displayedTotal: number | null;
    holeCardRevealed: boolean;
  };

  activeSeatId: string | null;
  activeHandId: string | null;
  deadlineAt: string | null;

  shoe: {
    shuffleNumber: number;
    approximateRemainingDecks: number;
  };

  /**
   * What each seat may legally do right now, keyed by seat id.
   *
   * Sent rather than re-derived on the client, because deriving it there would
   * be a second implementation of the rules — the exact thing this project
   * forbids. `getLegalActions` runs once, on the server, and the client renders
   * what it returns. The server still re-checks legality when the command
   * arrives; this is for drawing buttons, never for authority.
   *
   * It leaks nothing: legality follows from a seat's own cards, its stack and
   * the dealer's upcard, all of which are already public.
   */
  legalActions: Record<string, LegalActionSet>;

  /**
   * Advice, when the session asked for it. **The engine never fills this.**
   *
   * `toPublicState` leaves it undefined, always. It is a transport slot the
   * SERVER attaches after sanitisation, on a Quick Play session whose recorded
   * assistance is `learn` or `analysis`, using the same advisor that grades the
   * decision. The engine has no opinion about strategy and must not acquire
   * one — `shared/strategy` is a separate module for that reason, and nothing
   * here imports it.
   *
   * It leaks nothing. Every input is already public: the seat's own cards and
   * the dealer's UP card. The hole card is never consulted.
   */
  advice?: {
    seatId: string;
    recommended: PlayerActionType;
    explanation: string;
    /** Millionths of one unit wagered, per action. `analysis` only; else null. */
    actionEvMicros: Record<string, number> | null;
  } | null;
}

export function toPublicState(state: BlackjackGameState): PublicGameState {
  const rules = state.rules;

  const legalActions: Record<string, LegalActionSet> = {};
  for (const seat of state.seats) {
    legalActions[seat.seatId] = getLegalActions(state, seat.seatId);
  }

  const seats: PublicSeat[] = state.seats.map((seat) => ({
    seatId: seat.seatId,
    userId: seat.userId,
    displayName: seat.displayName,
    stack: seat.stack,
    originalBet: seat.originalBet,
    insuranceBet: seat.insuranceBet,
    connected: seat.connected,
    sittingOut: seat.sittingOut,
    betLocked: seat.betLocked,
    ...(seat.isAi === true ? { isAi: true as const } : {}),
    hands: seat.hands.map((hand) => {
      const value = evaluatePlayerHand(hand, rules.splitAceTwentyOneIsBlackjack);
      return {
        id: hand.id,
        // Player cards are public in blackjack — every seat sees them.
        cards: hand.cards,
        wager: hand.wager,
        status: hand.status,
        cameFromSplit: hand.cameFromSplit,
        total: hand.cards.length === 0 ? null : value.bestTotal,
        isSoft: value.isSoft,
        ...(hand.outcome ? { outcome: hand.outcome } : {}),
      };
    }),
  }));

  // The hole card is replaced by a placeholder, not merely omitted, so the
  // client can render a face-down card without ever receiving its identity.
  const dealerCards: MaybeHiddenCard[] = state.dealer.cards.map((card, index) => {
    const isHole = index === 1 && rules.dealerHoleCard;
    if (isHole && !state.dealer.holeCardRevealed) {
      return { hidden: true };
    }
    return card;
  });

  const faceUpCards = state.dealer.holeCardRevealed
    ? state.dealer.cards
    : state.dealer.cards.filter((_, index) => !(index === 1 && rules.dealerHoleCard));

  const activeSeat =
    state.activeSeatIndex === null ? null : (state.seats[state.activeSeatIndex] ?? null);
  const activeHand =
    activeSeat && state.activeHandIndex !== null
      ? (activeSeat.hands[state.activeHandIndex] ?? null)
      : null;

  return {
    gameId: state.gameId,
    version: state.version,
    phase: state.phase,

    rulesSummary: {
      deckCount: rules.deckCount,
      dealerHitsSoft17: rules.dealerHitsSoft17,
      blackjackPayout: `${rules.blackjackPayoutNumerator}:${rules.blackjackPayoutDenominator}`,
      surrenderAllowed: rules.lateSurrenderAllowed,
      doubleAfterSplit: rules.doubleAfterSplit,
    },

    handNumber: state.handNumber,
    seats,

    dealer: {
      cards: dealerCards,
      displayedTotal: faceUpCards.length === 0 ? null : evaluateHand(faceUpCards).bestTotal,
      holeCardRevealed: state.dealer.holeCardRevealed,
    },

    activeSeatId: activeSeat?.seatId ?? null,
    activeHandId: activeHand?.id ?? null,
    deadlineAt: state.actionDeadlineAt,

    legalActions,
    shoe: {
      shuffleNumber: state.shoe.shuffleNumber,
      approximateRemainingDecks: approximateDecksRemaining(state.shoe),
    },
  };
}

/**
 * Test/CI guard: proves a serialised payload carries no undealt card and no
 * unrevealed hole card. Wired into the engine suite so a future refactor that
 * widens the public shape fails loudly rather than leaking silently.
 */
export function assertNoHiddenCardLeak(
  payload: unknown,
  state: BlackjackGameState,
): void {
  const serialised = JSON.stringify(payload);

  const undealt = state.shoe.cards.slice(state.shoe.nextIndex);
  for (const card of undealt) {
    if (serialised.includes(`"${card.id}"`)) {
      throw new Error(`Public payload leaks undealt card "${card.id}"`);
    }
  }

  if (!state.dealer.holeCardRevealed && state.rules.dealerHoleCard) {
    const hole = state.dealer.cards[1];
    if (hole && serialised.includes(`"${hole.id}"`)) {
      throw new Error(`Public payload leaks the dealer hole card "${hole.id}"`);
    }
  }
}
