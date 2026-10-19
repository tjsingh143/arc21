/**
 * Arc 21 — the authoritative blackjack state machine.
 *
 * `applyCommand` is the only way game state changes. It is pure: given a state,
 * a command and a context, it returns a new state plus the ordered events that
 * describe the transition. The client animates *from* those events; it never
 * invents a card or predicts an outcome.
 *
 * Illegal commands throw `EngineError` and leave the input state untouched —
 * there is no partial mutation to roll back.
 *
 * Transitions that need no player input (dealing, peeking, dealer play,
 * settlement) run automatically inside one command via `cascade`, so a single
 * accepted command increments `version` exactly once and produces the full
 * event sequence for that step.
 */

import { cardValue, isAce, isSplitEligible } from "./cards.js";
import { dealerMustDraw, evaluateHand, evaluatePlayerHand } from "./hand-value.js";
import {
  activeHandOf,
  findSeat,
  getLegalActions,
  isBetAmountValid,
  isBettingTurn,
  isSeatsTurn,
  maxPlaceableBet,
} from "./legal-actions.js";
import { assertRulesAreCoherent, ARC_STANDARD_RULES, type BlackjackRules } from "./rules.js";
import type { RandomSource } from "./rng.js";
import {
  createShoe,
  drawCard,
  needsReshuffle,
  reshuffle,
  ShoeExhaustedError,
} from "./shoe.js";
import { insuranceStakeFor, settleSeat, describeDealerFinal } from "./settlement.js";
import {
  DEAD_TERMINAL_STATUSES,
  EngineError,
  type BlackjackGameState,
  type Card,
  type EngineCommand,
  type EngineEvent,
  type EngineResult,
  type PlayerActionType,
  type PlayerHand,
  type SeatState,
} from "./types.js";

// ---------------------------------------------------------------------------
// Construction
// ---------------------------------------------------------------------------

export interface SeatSeed {
  seatId: string;
  userId?: string | null;
  displayName: string;
  stack: number;
  /** A computer-controlled participant. See `SeatState.isAi`. */
  isAi?: boolean;
}

export interface CreateGameOptions {
  gameId: string;
  rules?: BlackjackRules;
  seats: SeatSeed[];
  random: RandomSource;
  /** Timer lengths for online play. Omit for local Practice (no deadlines). */
  timing?: GameTiming | null;
  now?: string;
}

/**
 * Timer lengths, in MILLISECONDS.
 *
 * The unit is in every field name on purpose. An earlier caller passed
 * `{bettingSeconds, insuranceSeconds, actionSeconds}` here; `supabase/functions`
 * is excluded from `tsconfig.json`, so nothing caught it, `betMillis` read
 * `undefined`, `deadlineFrom` returned null, and every shared table ran with no
 * deadline at all — which quietly disabled RESOLVE_TIMEOUT on the only tables
 * that need it. `assertTimingIsCoherent` now refuses that shape outright.
 */
export interface GameTiming {
  betMillis: number;
  actionMillis: number;
  /** Insurance decisions. Falls back to the action clock when absent. */
  insuranceMillis?: number;
  /**
   * How long a settled hand rests before a timeout may start the next round.
   * Omit on a solo table: a lone player stalls nobody, so nothing should
   * advance their table but them.
   */
  settlementMillis?: number;
}

/**
 * Rejects a timing object that carries no usable clock.
 *
 * A missing timer is not a smaller feature, it is a silently untimed table, so
 * this fails loudly at construction rather than at the deadline that never came.
 */
export function assertTimingIsCoherent(timing: GameTiming): void {
  const problems: string[] = [];
  const positiveMillis = (label: string, value: number | undefined, required: boolean) => {
    if (value === undefined) {
      if (required) problems.push(`${label} is missing`);
      return;
    }
    if (!Number.isInteger(value) || value <= 0) {
      problems.push(`${label} must be a positive integer number of milliseconds`);
    }
  };

  positiveMillis("betMillis", timing.betMillis, true);
  positiveMillis("actionMillis", timing.actionMillis, true);
  positiveMillis("insuranceMillis", timing.insuranceMillis, false);
  positiveMillis("settlementMillis", timing.settlementMillis, false);

  if (problems.length > 0) {
    throw new EngineError("ILLEGAL_ACTION", `Incoherent timing: ${problems.join("; ")}`);
  }
}

/**
 * Engine state plus bookkeeping the spec's public shape does not carry.
 * `nextHandSeq` keeps split-hand ids stable and deterministic for tests.
 */
export interface EngineState extends BlackjackGameState {
  timing: GameTiming | null;
  nextHandSeq: number;
}

export interface CommandContext {
  /** Required whenever a reshuffle may occur (i.e. at a betting boundary). */
  random?: RandomSource;
  /** Server time. Drives deadlines and timeout validation. */
  now?: string;
}

export function createGame(options: CreateGameOptions): EngineState {
  const rules = options.rules ?? ARC_STANDARD_RULES;
  assertRulesAreCoherent(rules);
  if (options.timing) assertTimingIsCoherent(options.timing);

  for (const seed of options.seats) {
    // A computer player is never an account. Letting one carry a user id would
    // let the server's per-account bookkeeping — statistics, XP, a cash-out —
    // treat it as a person, which is the one thing an AI seat must never be.
    if (seed.isAi === true && seed.userId !== undefined && seed.userId !== null) {
      throw new EngineError("ILLEGAL_ACTION", `AI seat ${seed.seatId} cannot belong to an account`);
    }
  }

  const seats: SeatState[] = options.seats.map((seed) => ({
    seatId: seed.seatId,
    userId: seed.userId ?? null,
    displayName: seed.displayName,
    stack: seed.stack,
    originalBet: 0,
    insuranceBet: 0,
    insuranceDecision: "NOT_OFFERED",
    hands: [],
    currentHandIndex: 0,
    connected: true,
    betLocked: false,
    sittingOut: false,
    // Present only when true, so a human seat's persisted shape is unchanged.
    ...(seed.isAi === true ? { isAi: true } : {}),
  }));

  return {
    gameId: options.gameId,
    rules,
    phase: "SESSION_READY",
    seats,
    dealer: { cards: [], holeCardRevealed: false },
    activeSeatIndex: null,
    activeHandIndex: null,
    handNumber: 0,
    version: 0,
    shoe: createShoe(rules, options.random),
    actionDeadlineAt: null,
    timing: options.timing ?? null,
    nextHandSeq: 1,
  };
}

/** Moves a freshly created session into its first betting round. */
export function startSession(state: EngineState, context: CommandContext = {}): EngineResult<EngineState> {
  if (state.phase !== "SESSION_READY") {
    throw new EngineError("WRONG_PHASE", `Cannot start a session in phase ${state.phase}`);
  }
  const events: EngineEvent[] = [];
  const next = openBetting(clone(state), events, context);
  return { state: bump(next), events };
}

// ---------------------------------------------------------------------------
// Command entry point
// ---------------------------------------------------------------------------

export function applyCommand(
  input: EngineState,
  command: EngineCommand,
  context: CommandContext = {},
): EngineResult<EngineState> {
  const events: EngineEvent[] = [];
  let state = clone(input);

  switch (command.type) {
    case "PLACE_BET":
      state = handlePlaceBet(state, command.seatId, command.amount, events);
      break;
    case "LOCK_BET":
      state = handleLockBet(state, command.seatId, events, context);
      break;
    case "INSURANCE":
      state = handleInsurance(state, command.seatId, true, events, context);
      break;
    case "DECLINE_INSURANCE":
      state = handleInsurance(state, command.seatId, false, events, context);
      break;
    case "HIT":
    case "STAND":
    case "DOUBLE":
    case "SPLIT":
    case "SURRENDER":
      state = handlePlayerAction(state, command.seatId, command.type, events, context);
      break;
    case "RESOLVE_TIMEOUT":
      state = handleResolveTimeout(state, command.now, events, context);
      break;
    case "LEAVE":
      state = handleLeave(state, command.seatId, events, context);
      break;
    case "NEXT_HAND":
      state = handleNextHand(state, command.seatId, events, context);
      break;
    case "ADVANCE":
      state = cascade(state, events, context);
      break;
    default: {
      const exhaustive: never = command;
      throw new EngineError("ILLEGAL_ACTION", `Unknown command ${JSON.stringify(exhaustive)}`);
    }
  }

  return { state: bump(state), events };
}

// ---------------------------------------------------------------------------
// Command handlers
// ---------------------------------------------------------------------------

function handlePlaceBet(
  state: EngineState,
  seatId: string,
  amount: number,
  events: EngineEvent[],
): EngineState {
  requirePhase(state, "BETTING_OPEN");
  const seat = requireSeat(state, seatId);
  requireBettingTurn(state, seatId);

  if (seat.betLocked) {
    throw new EngineError("ILLEGAL_ACTION", `Seat ${seatId} has already locked its bet`);
  }

  // The seat's previously staged bet is not yet committed; validate the new
  // absolute amount against the full stack.
  const staged: SeatState = { ...seat, stack: seat.stack + seat.originalBet, originalBet: 0 };

  // Zero clears the staged bet. Nothing is committed until LOCK_BET, so taking
  // chips back off the felt is an ordinary action, not a rule violation — and
  // the minimum-bet check must not stand in its way.
  if (amount === 0) {
    seat.stack = staged.stack;
    seat.originalBet = 0;
    events.push({ type: "BET_PLACED", seatId, amount: 0 });
    return state;
  }

  const check = isBetAmountValid(amount, staged, state.rules);
  if (!check.valid) {
    throw new EngineError(check.reason as never, `Invalid bet ${amount} for seat ${seatId}`);
  }

  seat.stack = staged.stack - amount;
  seat.originalBet = amount;
  events.push({ type: "BET_PLACED", seatId, amount });
  return state;
}

function handleLockBet(
  state: EngineState,
  seatId: string,
  events: EngineEvent[],
  context: CommandContext,
): EngineState {
  requirePhase(state, "BETTING_OPEN");
  const seat = requireSeat(state, seatId);

  if (seat.betLocked) return state; // Idempotent: re-locking is a no-op.
  requireBettingTurn(state, seatId);

  const check = isBetAmountValid(seat.originalBet, { ...seat, stack: seat.stack + seat.originalBet }, state.rules);
  if (!check.valid) {
    throw new EngineError(check.reason as never, `Seat ${seatId} cannot lock bet ${seat.originalBet}`);
  }

  seat.betLocked = true;
  events.push({ type: "BET_LOCKED", seatId, amount: seat.originalBet });

  return cascade(state, events, context);
}

function handleInsurance(
  state: EngineState,
  seatId: string,
  take: boolean,
  events: EngineEvent[],
  context: CommandContext,
): EngineState {
  requirePhase(state, "INSURANCE_OFFER");
  const seat = requireSeat(state, seatId);

  if (seat.insuranceDecision !== "PENDING") {
    throw new EngineError("ILLEGAL_ACTION", `Seat ${seatId} has already answered insurance`);
  }

  if (take) {
    const legal = getLegalActions(state, seatId);
    if (!legal.canTakeInsurance) {
      throw new EngineError("INSURANCE_NOT_AVAILABLE", `Seat ${seatId} cannot take insurance`);
    }
    const stake = insuranceStakeFor(seat.originalBet, state.rules);
    seat.stack -= stake;
    seat.insuranceBet = stake;
    seat.insuranceDecision = "TAKEN";
    events.push({ type: "INSURANCE_TAKEN", seatId, amount: stake });
  } else {
    seat.insuranceDecision = "DECLINED";
    events.push({ type: "INSURANCE_DECLINED", seatId });
  }

  return cascade(state, events, context);
}

function handlePlayerAction(
  state: EngineState,
  seatId: string,
  action: PlayerActionType,
  events: EngineEvent[],
  context: CommandContext,
): EngineState {
  requirePhase(state, "PLAYER_TURNS");

  if (!isSeatsTurn(state, seatId)) {
    throw new EngineError("NOT_YOUR_TURN", `It is not seat ${seatId}'s turn`);
  }

  const legal = getLegalActions(state, seatId);
  if (!legal.actions.includes(action)) {
    throw new EngineError("ILLEGAL_ACTION", `${action} is not legal for seat ${seatId} right now`);
  }

  const seat = requireSeat(state, seatId);
  const hand = activeHandOf(seat);
  if (!hand) throw new EngineError("NO_ACTIVE_HAND", `Seat ${seatId} has no active hand`);

  events.push({ type: "PLAYER_ACTION", seatId, handId: hand.id, action });

  switch (action) {
    case "HIT": {
      state = dealToHand(state, seat, hand, events);
      completeIfTerminal(hand, state.rules, seat, events);
      break;
    }
    case "STAND": {
      setHandStatus(hand, "STOOD", seat, events);
      break;
    }
    case "DOUBLE": {
      seat.stack -= hand.wager;
      hand.wager *= 2;
      state = dealToHand(state, seat, hand, events);
      const value = evaluatePlayerHand(hand, state.rules.splitAceTwentyOneIsBlackjack);
      setHandStatus(hand, value.isBust ? "BUSTED" : "DOUBLED_COMPLETE", seat, events);
      break;
    }
    case "SPLIT": {
      state = performSplit(state, seat, hand, events);
      break;
    }
    case "SURRENDER": {
      setHandStatus(hand, "SURRENDERED", seat, events);
      break;
    }
  }

  return cascade(state, events, context);
}

function handleResolveTimeout(
  state: EngineState,
  now: string,
  events: EngineEvent[],
  context: CommandContext,
): EngineState {
  if (state.actionDeadlineAt === null) {
    throw new EngineError("DEADLINE_NOT_REACHED", "No deadline is currently set");
  }
  // Only the server's own clock may authorise this; `now` is supplied by the
  // server, never forwarded from a client payload.
  if (!isDeadlineReached(state, now)) {
    throw new EngineError("DEADLINE_NOT_REACHED", "The action deadline has not passed yet");
  }

  // Defaults are deliberately predictable. The engine never plays basic
  // strategy on an absent user's behalf — that would silently alter their
  // recorded decision accuracy and their chips.
  switch (state.phase) {
    case "BETTING_OPEN": {
      /*
       * At a sequential table the clock belongs to ONE seat, so the default is
       * applied to that seat and the turn then moves on. Staking the minimum for
       * everybody here would collapse the whole betting round the moment the
       * first player looked away — and the players after them would never see
       * the bets they are entitled to bet against.
       */
      const waiting = state.rules.sequentialBetting
        ? state.activeSeatIndex === null
          ? []
          : [state.seats[state.activeSeatIndex]!]
        : state.seats;

      for (const seat of waiting) {
        if (seat.betLocked || seat.sittingOut) continue;
        const restored = seat.stack + seat.originalBet;
        const fallback = seat.originalBet > 0 ? seat.originalBet : state.rules.minBet;
        if (isBetAmountValid(fallback, { ...seat, stack: restored }, state.rules).valid) {
          seat.stack = restored - fallback;
          seat.originalBet = fallback;
          seat.betLocked = true;
          events.push({ type: "TIMEOUT_RESOLVED", seatId: seat.seatId, appliedAction: `BET_${fallback}` });
        } else {
          seat.stack = restored;
          seat.originalBet = 0;
          seat.sittingOut = true;
          events.push({ type: "TIMEOUT_RESOLVED", seatId: seat.seatId, appliedAction: "SIT_OUT" });
        }
      }
      break;
    }
    case "INSURANCE_OFFER": {
      for (const seat of state.seats) {
        if (seat.insuranceDecision !== "PENDING") continue;
        seat.insuranceDecision = "DECLINED";
        events.push({ type: "TIMEOUT_RESOLVED", seatId: seat.seatId, appliedAction: "DECLINE_INSURANCE" });
        events.push({ type: "INSURANCE_DECLINED", seatId: seat.seatId });
      }
      break;
    }
    case "PLAYER_TURNS": {
      const seat = state.activeSeatIndex === null ? undefined : state.seats[state.activeSeatIndex];
      const hand = seat ? activeHandOf(seat) : undefined;
      if (seat && hand && hand.status === "ACTIVE") {
        setHandStatus(hand, "STOOD", seat, events);
        events.push({ type: "TIMEOUT_RESOLVED", seatId: seat.seatId, appliedAction: "STAND" });
      }
      break;
    }
    case "HAND_COMPLETE": {
      // The rest window closed with nobody asking for the next round. Starting
      // it is the only default that keeps a table with other people at it
      // moving. A solo table sets no settlement deadline, so this is
      // unreachable there and a lone player is never rushed.
      return advanceToNextHand(state, events, context);
    }
    default:
      throw new EngineError("WRONG_PHASE", `Phase ${state.phase} has no timeout behaviour`);
  }

  return cascade(state, events, context);
}

function handleLeave(
  state: EngineState,
  seatId: string,
  events: EngineEvent[],
  context: CommandContext,
): EngineState {
  const seat = requireSeat(state, seatId);
  seat.connected = false;

  // A committed hand stays valid and continues to resolve — leaving must never
  // be a way to escape a losing wager.
  if (state.phase === "BETTING_OPEN" && !seat.betLocked) {
    seat.stack += seat.originalBet;
    seat.originalBet = 0;
    seat.sittingOut = true;
  }

  // An unanswered insurance offer is answered the way the clock would answer it.
  // The alternative is a table that waits on somebody who has gone: the cascade
  // holds at INSURANCE_OFFER while any decision is PENDING, and on a table with
  // no insurance clock there is then nothing left to move it. Declining is the
  // stated default, costs the departing seat nothing, and touches no card.
  if (state.phase === "INSURANCE_OFFER" && seat.insuranceDecision === "PENDING") {
    seat.insuranceDecision = "DECLINED";
    events.push({ type: "INSURANCE_DECLINED", seatId });
  }

  events.push({ type: "SEAT_LEFT", seatId });
  return cascade(state, events, context);
}

// ---------------------------------------------------------------------------
// Automatic phase progression
// ---------------------------------------------------------------------------

/**
 * Drives every transition that needs no player input, stopping at the next
 * phase that awaits a decision (or at HAND_COMPLETE).
 *
 * The iteration cap is a defensive guard against a future transition bug
 * producing an infinite loop on the server; it is unreachable in correct play.
 */
function cascade(state: EngineState, events: EngineEvent[], context: CommandContext): EngineState {
  for (let guard = 0; guard < 512; guard++) {
    switch (state.phase) {
      case "BETTING_OPEN": {
        /*
         * Betting closes when every seat that CAN play has locked — not when
         * every seat that has already staged something has.
         *
         * The difference is not academic. The earlier predicate filtered on
         * `originalBet > 0`, so a seat that had not bet yet was not counted, and
         * the FIRST player to lock closed betting for the table: at a four-seat
         * tournament exactly one stack moved per hand and everyone slower was
         * dealt out of it. A shared table has to wait for the people at it.
         *
         * What stops an absent player stalling the table forever is the betting
         * deadline, not this predicate: RESOLVE_TIMEOUT stakes the table minimum
         * for them, or sits them out when they cannot cover it. That is why a
         * shared table must carry timing and a solo one need not — with one seat,
         * "everyone has locked" is the same question either way.
         */
        /*
         * A sequential table picks its next bettor BEFORE the question above is
         * asked, because positioning is also what sits out a seat that can no
         * longer cover the minimum — and a seat still counted as eligible while
         * unable to bet is a round that can never close.
         */
        positionBettor(state, context);

        const eligible = state.seats.filter((seat) => !seat.sittingOut);
        if (eligible.length === 0 || !eligible.every((seat) => seat.betLocked)) {
          return state;
        }
        // Betting is over; the cursor belongs to PLAYER_TURNS from here.
        state.activeSeatIndex = null;
        state.phase = "BETTING_LOCKED";
        break;
      }

      case "BETTING_LOCKED": {
        state.phase = "INITIAL_DEAL";
        break;
      }

      case "INITIAL_DEAL": {
        state = performInitialDeal(state, events);
        // The deal decides whether insurance is offered, and the clock for that
        // decision is set here because this is where `context` — and so the
        // server's `now` — is in scope.
        if (state.phase === "INSURANCE_OFFER") {
          state.actionDeadlineAt = deadlineFrom(
            context.now,
            state.timing?.insuranceMillis ?? state.timing?.actionMillis,
          );
        }
        break;
      }

      case "INSURANCE_OFFER": {
        const pending = state.seats.some((seat) => seat.insuranceDecision === "PENDING");
        if (pending) return state;
        // Insurance is settled BEFORE the peek, which is the whole reason the
        // offer exists — but taking the offer must not conjure a peek a ruleset
        // has switched off. `performInitialDeal` already routes a non-peeking
        // ruleset straight to PLAYER_TURNS on a ten upcard; an ace upcard has to
        // arrive at the same answer after the offer, or insurance would quietly
        // change how the dealer's blackjack is checked.
        state.phase = state.rules.dealerPeeksForBlackjack ? "DEALER_PEEK" : "PLAYER_TURNS";
        state.actionDeadlineAt = null;
        break;
      }

      case "DEALER_PEEK": {
        const dealerHasNatural = evaluateHand(state.dealer.cards).isNaturalBlackjack;
        events.push({ type: "DEALER_PEEKED", hasBlackjack: dealerHasNatural });
        state.phase = dealerHasNatural ? "DEALER_REVEAL" : "PLAYER_TURNS";
        break;
      }

      case "PLAYER_TURNS": {
        // Re-derive the cursor on every pass. This both advances past hands the
        // last action completed and positions the very first cursor when the
        // deal skipped peek entirely (dealer showing neither ace nor ten).
        state = positionCursor(state, events, context);
        if (state.activeSeatIndex === null) {
          state.phase = "DEALER_REVEAL";
          break;
        }
        return state;
      }

      case "DEALER_REVEAL": {
        state.dealer.holeCardRevealed = true;
        const holeCard = state.dealer.cards[1];
        if (holeCard) {
          events.push({ type: "HOLE_CARD_REVEALED", card: holeCard });
        }
        state.phase = "DEALER_TURN";
        state.actionDeadlineAt = null;
        break;
      }

      case "DEALER_TURN": {
        state = playDealer(state, events);
        state.phase = "SETTLEMENT";
        break;
      }

      case "SETTLEMENT": {
        state = performSettlement(state, events);
        state.phase = "HAND_COMPLETE";
        // A shared table gets a rest window rather than an open-ended pause: if
        // nobody asks for the next round, a timeout starts it, so one player who
        // closed their app cannot freeze a table full of people. A solo table
        // passes no `settlementMillis` and therefore waits indefinitely, which is
        // the right answer when the only person being kept waiting is you.
        state.actionDeadlineAt = deadlineFrom(context.now, state.timing?.settlementMillis);
        break;
      }

      case "HAND_COMPLETE": {
        // Resting phase. The caller decides when to start the next round, so
        // result animations are never cut short.
        return state;
      }

      case "BETWEEN_HANDS": {
        state = openBetting(state, events, context);
        break;
      }

      case "SESSION_READY":
      case "SESSION_COMPLETE":
        return state;
    }
  }

  throw new EngineError("ILLEGAL_ACTION", "Phase cascade exceeded its iteration guard");
}

/**
 * The one implementation of "start the next round".
 *
 * Three callers reach it — the local Practice table via `beginNextHand`, a
 * seated player's `NEXT_HAND` command, and a settlement-window timeout — and it
 * matters that they are the same code. A second copy would be a second place for
 * the reshuffle boundary or the sit-out reinstatement to be wrong.
 */
function advanceToNextHand(
  state: EngineState,
  events: EngineEvent[],
  context: CommandContext,
): EngineState {
  if (state.phase !== "HAND_COMPLETE") {
    throw new EngineError("WRONG_PHASE", `Cannot begin a new hand from phase ${state.phase}`);
  }
  state.phase = "BETWEEN_HANDS";
  return cascade(state, events, context);
}

/** Begins the next round: clears the table, reshuffles if the cut was reached. */
export function beginNextHand(state: EngineState, context: CommandContext = {}): EngineResult<EngineState> {
  const events: EngineEvent[] = [];
  const next = advanceToNextHand(clone(state), events, context);
  return { state: bump(next), events };
}

/**
 * A seated player asks for the next round.
 *
 * The seat is required to exist but is otherwise not consulted: starting a round
 * is not a turn, and at a shared table whoever taps first starts it for
 * everyone. The server's idempotency record makes the losers' requests replays
 * rather than a second round.
 */
function handleNextHand(
  state: EngineState,
  seatId: string,
  events: EngineEvent[],
  context: CommandContext,
): EngineState {
  requireSeat(state, seatId);
  return advanceToNextHand(state, events, context);
}

function openBetting(state: EngineState, events: EngineEvent[], context: CommandContext): EngineState {
  // Reshuffling happens here and only here — between hands, never mid-hand.
  if (needsReshuffle(state.shoe)) {
    if (!context.random) {
      throw new EngineError(
        "SHOE_EXHAUSTED",
        "A reshuffle is required but no RandomSource was supplied in the command context",
      );
    }
    state.shoe = reshuffle(state.shoe, state.rules, context.random);
    events.push({
      type: "SHOE_SHUFFLED",
      shuffleNumber: state.shoe.shuffleNumber,
      deckCount: state.rules.deckCount,
    });
  }

  state.dealer = { cards: [], holeCardRevealed: false };
  state.activeSeatIndex = null;
  state.activeHandIndex = null;
  state.handNumber += 1;

  for (const seat of state.seats) {
    seat.hands = [];
    seat.currentHandIndex = 0;
    seat.originalBet = 0;
    seat.insuranceBet = 0;
    seat.insuranceDecision = "NOT_OFFERED";
    seat.betLocked = false;

    if (seat.sitOutNextHand) {
      // Held out of exactly this hand and no further. Consuming the flag here is
      // what makes it one hand rather than a state someone has to remember to
      // clear — a sudden-death hand that silently became permanent would change
      // the tournament's whole shape.
      seat.sittingOut = true;
      seat.sitOutNextHand = false;
    } else if (!seat.connected) {
      /*
       * A seat that has gone is not dealt in, and is never staked again.
       *
       * `connected` is only ever cleared by LEAVE, by a table closure or by a
       * tournament elimination, and nothing in the engine or the server sets it
       * back — so a disconnected seat is a DEPARTED seat, not a flaky one.
       *
       * Without this branch a player who left MID-HAND kept a live seat: the
       * closure path only runs at a phase where no wager is committed, so their
       * seat came back round to BETTING_OPEN still eligible, and the betting
       * deadline then staked the table minimum out of their stack — hand after
       * hand, in absentia, until it fell below the minimum. "Leaving is never a
       * way to escape a committed wager" is right; leaving must not become a way
       * to keep committing them either.
       */
      seat.sittingOut = true;
    } else if (seat.sittingOut && seat.stack >= state.rules.minBet) {
      // A seat that sat out for lack of chips rejoins as soon as it can afford
      // the table minimum again. Reaching here means it is connected.
      seat.sittingOut = false;
    }
  }

  state.phase = "BETTING_OPEN";
  state.actionDeadlineAt = deadlineFrom(context.now, state.timing?.betMillis);
  events.push({ type: "BETTING_OPENED", handNumber: state.handNumber });
  // Sequential tables need a first bettor before any command arrives.
  // `startSession` opens the first round WITHOUT cascading, so positioning only
  // in the cascade would leave hand one with no bettor and refuse everybody.
  positionBettor(state, context);
  return state;
}

/**
 * Whose turn it is to bet, at a table that bets one seat at a time.
 *
 * A no-op unless `rules.sequentialBetting` is set, so an ordinary table is
 * unaffected in every respect — including its single shared betting clock.
 *
 * `state.seats` is action order (the Sprint Tournament rotates that array to
 * move its button), so "the next bettor" is simply the next seat in it that is
 * still in the hand and has not locked. There is no second ordering to keep in
 * step, which is the same reason the button is implemented as a rotation.
 *
 * A SEAT THAT CANNOT COVER THE MINIMUM IS SAT OUT HERE rather than left to time
 * out. With one shared clock a broke seat costs the table one betting window;
 * with a clock EACH it would cost seven seconds of everybody's time per broke
 * seat, every hand, and the round cannot close until every eligible seat has
 * locked. It is the same condition `openBetting` uses to let a seat back in,
 * read in the other direction.
 */
function positionBettor(state: EngineState, context: CommandContext): void {
  if (!state.rules.sequentialBetting) return;

  let next: number | null = null;
  for (let index = 0; index < state.seats.length; index++) {
    const seat = state.seats[index]!;
    if (seat.sittingOut || seat.betLocked) continue;
    if (maxPlaceableBet(seat, state.rules) < state.rules.minBet) {
      seat.sittingOut = true;
      continue;
    }
    next = index;
    break;
  }

  if (state.activeSeatIndex === next) return;

  state.activeSeatIndex = next;
  // Betting has no hand cursor; leaving a stale one would point PLAYER_TURNS
  // consumers at a hand that does not exist yet.
  state.activeHandIndex = null;
  if (next !== null) {
    // The clock restarts only when the turn genuinely moves — the same rule
    // `positionCursor` follows, and for the same reason: a seat must not be able
    // to extend its own deadline by sending commands that change nothing.
    state.actionDeadlineAt = deadlineFrom(context.now, state.timing?.betMillis);
  }
}

/**
 * Refuses a bet from a seat that is not the current bettor.
 *
 * Only at a sequential table. `NOT_YOUR_TURN` rather than `ILLEGAL_ACTION`
 * because it is a synchronisation problem the client can recover from by
 * re-reading the snapshot, exactly as it is for a player action out of turn.
 */
function requireBettingTurn(state: EngineState, seatId: string): void {
  if (isBettingTurn(state, seatId)) return;
  throw new EngineError("NOT_YOUR_TURN", `Seat ${seatId} is not the current bettor`);
}

/**
 * Deals in casino order: one card to each active seat, dealer upcard, a second
 * card to each seat, then the dealer hole card.
 */
function performInitialDeal(state: EngineState, events: EngineEvent[]): EngineState {
  const active = state.seats.filter((seat) => !seat.sittingOut && seat.originalBet > 0);

  for (const seat of active) {
    const hand: PlayerHand = {
      id: `${state.gameId}:h${state.handNumber}:${state.nextHandSeq++}`,
      cards: [],
      wager: seat.originalBet,
      status: "ACTIVE",
      cameFromSplit: false,
      cameFromSplitAces: false,
    };
    seat.hands = [hand];
    seat.currentHandIndex = 0;
  }

  // Round one.
  for (const seat of active) {
    state = dealToHand(state, seat, seat.hands[0]!, events);
  }
  state = dealToDealer(state, events);

  // Round two.
  for (const seat of active) {
    state = dealToHand(state, seat, seat.hands[0]!, events);
  }
  if (state.rules.dealerHoleCard) {
    state = dealToDealer(state, events, { hole: true });
  }

  // Naturals are terminal immediately; those seats never take a turn.
  for (const seat of active) {
    const hand = seat.hands[0]!;
    const value = evaluatePlayerHand(hand, state.rules.splitAceTwentyOneIsBlackjack);
    if (value.isNaturalBlackjack) {
      setHandStatus(hand, "BLACKJACK", seat, events);
    }
  }

  const upcard = state.dealer.cards[0];
  const upcardIsAce = upcard ? isAce(upcard) : false;
  const upcardIsTen = upcard ? cardValue(upcard) === 10 : false;

  if (upcardIsAce && state.rules.insuranceAllowed) {
    for (const seat of active) {
      seat.insuranceDecision = "PENDING";
    }
    state.phase = "INSURANCE_OFFER";
    events.push({ type: "INSURANCE_OFFERED" });
  } else if ((upcardIsAce || upcardIsTen) && state.rules.dealerPeeksForBlackjack) {
    state.phase = "DEALER_PEEK";
  } else {
    state.phase = "PLAYER_TURNS";
  }

  return state;
}

function playDealer(state: EngineState, events: EngineEvent[]): EngineState {
  // If no hand can still be beaten, the dealer does not draw. A natural can only
  // be pushed by a dealer natural, which peek has already excluded, so drawing
  // would consume cards without affecting any outcome.
  const mustDraw = state.seats.some((seat) =>
    seat.hands.some((hand) => {
      if (DEAD_TERMINAL_STATUSES.includes(hand.status)) return false;
      const value = evaluatePlayerHand(hand, state.rules.splitAceTwentyOneIsBlackjack);
      return !value.isNaturalBlackjack;
    }),
  );

  if (mustDraw) {
    // `dealerMustDraw` is the ONLY statement of the drawing rule; the solver
    // that builds the strategy chart calls the same function, so the chart
    // cannot be solved against a dealer this engine does not play.
    for (;;) {
      const value = evaluateHand(state.dealer.cards);
      if (!dealerMustDraw(value, state.rules)) break;
      state = dealToDealer(state, events);
    }
  }

  const final = evaluateHand(state.dealer.cards);
  events.push(
    final.isBust
      ? { type: "DEALER_BUSTED", total: final.bestTotal }
      : { type: "DEALER_STOOD", total: final.bestTotal },
  );
  return state;
}

function performSettlement(state: EngineState, events: EngineEvent[]): EngineState {
  const dealerFinal = describeDealerFinal(state.dealer.cards);

  for (const seat of state.seats) {
    if (seat.hands.length === 0 && seat.insuranceBet === 0) continue;

    const settlement = settleSeat(seat, dealerFinal, state.rules);

    for (const entry of settlement.handOutcomes) {
      const hand = seat.hands.find((candidate) => candidate.id === entry.handId);
      if (hand) hand.outcome = entry.outcome;
      events.push({ type: "HAND_SETTLED", seatId: seat.seatId, handId: entry.handId, outcome: entry.outcome });
    }

    if (seat.insuranceBet > 0) {
      events.push({ type: "INSURANCE_SETTLED", seatId: seat.seatId, credit: settlement.insuranceCredit });
    }

    seat.stack += settlement.totalCredit;
  }

  events.push({ type: "HAND_COMPLETED", handNumber: state.handNumber });
  return state;
}

// ---------------------------------------------------------------------------
// Turn cursor
// ---------------------------------------------------------------------------

/** Moves the cursor to the next hand awaiting a decision, or clears it. */
function positionCursor(
  state: EngineState,
  events: EngineEvent[],
  context: CommandContext,
): EngineState {
  for (let seatIndex = 0; seatIndex < state.seats.length; seatIndex++) {
    const seat = state.seats[seatIndex]!;
    if (seat.sittingOut) continue;

    for (let handIndex = 0; handIndex < seat.hands.length; handIndex++) {
      if (seat.hands[handIndex]!.status !== "ACTIVE") continue;

      const changed = state.activeSeatIndex !== seatIndex || state.activeHandIndex !== handIndex;
      state.activeSeatIndex = seatIndex;
      state.activeHandIndex = handIndex;
      seat.currentHandIndex = handIndex;

      if (changed) {
        // The clock restarts only when the turn genuinely moves. Refreshing it
        // on every cascade pass would let a seat extend its own deadline by
        // sending commands that change nothing.
        state.actionDeadlineAt = deadlineFrom(context.now, state.timing?.actionMillis);
        events.push({ type: "TURN_STARTED", seatId: seat.seatId, handId: seat.hands[handIndex]!.id });
      }
      return state;
    }
  }

  state.activeSeatIndex = null;
  state.activeHandIndex = null;
  state.actionDeadlineAt = null;
  return state;
}

// ---------------------------------------------------------------------------
// Card movement
// ---------------------------------------------------------------------------

function dealToHand(
  state: EngineState,
  seat: SeatState,
  hand: PlayerHand,
  events: EngineEvent[],
): EngineState {
  const card = takeCard(state, events);
  hand.cards.push(card);
  events.push({ type: "CARD_DEALT", to: "SEAT", seatId: seat.seatId, handId: hand.id, card });
  return state;
}

function dealToDealer(
  state: EngineState,
  events: EngineEvent[],
  options: { hole?: boolean } = {},
): EngineState {
  const card = takeCard(state, events);
  state.dealer.cards.push(card);

  if (options.hole) {
    // The hole card's identity must never appear in a public event stream.
    events.push({ type: "HOLE_CARD_DEALT" });
  } else {
    events.push({ type: "CARD_DEALT", to: "DEALER", card });
  }
  return state;
}

function takeCard(state: EngineState, events: EngineEvent[]): Card {
  try {
    const { card, shoe } = drawCard(state.shoe);
    state.shoe = shoe;
    return card;
  } catch (error) {
    if (error instanceof ShoeExhaustedError) {
      events.push({ type: "SHOE_EXHAUSTED_INVARIANT", handNumber: state.handNumber });
      throw new EngineError("SHOE_EXHAUSTED", error.message);
    }
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Split
// ---------------------------------------------------------------------------

function performSplit(
  state: EngineState,
  seat: SeatState,
  hand: PlayerHand,
  events: EngineEvent[],
): EngineState {
  const [first, second] = hand.cards as [Card, Card];
  if (!isSplitEligible(first, second, state.rules.splitPolicy)) {
    throw new EngineError("ILLEGAL_ACTION", "Cards are not split-eligible");
  }

  const splittingAces = isAce(first) && isAce(second);
  const wager = hand.wager;

  seat.stack -= wager;

  const left: PlayerHand = {
    id: `${state.gameId}:h${state.handNumber}:${state.nextHandSeq++}`,
    cards: [first],
    wager,
    status: "ACTIVE",
    cameFromSplit: true,
    cameFromSplitAces: splittingAces || hand.cameFromSplitAces,
  };
  const right: PlayerHand = {
    id: `${state.gameId}:h${state.handNumber}:${state.nextHandSeq++}`,
    cards: [second],
    wager,
    status: "ACTIVE",
    cameFromSplit: true,
    cameFromSplitAces: splittingAces || hand.cameFromSplitAces,
  };

  const at = seat.hands.indexOf(hand);
  seat.hands.splice(at, 1, left, right);
  events.push({ type: "HAND_SPLIT", seatId: seat.seatId, fromHandId: hand.id, newHandIds: [left.id, right.id] });

  // Each new hand immediately receives one card, resolving left to right.
  state = dealToHand(state, seat, left, events);
  state = dealToHand(state, seat, right, events);

  if (splittingAces && !state.rules.hitSplitAcesAllowed) {
    // Split aces get exactly one card each and are done. A resulting 21 is an
    // ordinary 21, not a natural — `evaluatePlayerHand` enforces that via
    // `cameFromSplitAces`.
    for (const created of [left, right]) {
      const value = evaluatePlayerHand(created, state.rules.splitAceTwentyOneIsBlackjack);
      // `isNaturalBlackjack` is only true here when the ruleset opts in via
      // splitAceTwentyOneIsBlackjack; under Arc Standard this stays TWENTY_ONE.
      const status = value.isNaturalBlackjack
        ? "BLACKJACK"
        : value.isTwentyOne
          ? "TWENTY_ONE"
          : "STOOD";
      setHandStatus(created, status, seat, events);
    }
  } else {
    for (const created of [left, right]) {
      completeIfTerminal(created, state.rules, seat, events);
    }
  }

  seat.currentHandIndex = at;
  return state;
}

// ---------------------------------------------------------------------------
// Hand status helpers
// ---------------------------------------------------------------------------

function setHandStatus(
  hand: PlayerHand,
  status: PlayerHand["status"],
  seat: SeatState,
  events: EngineEvent[],
): void {
  hand.status = status;
  events.push({ type: "HAND_STATUS_CHANGED", seatId: seat.seatId, handId: hand.id, status });
}

/**
 * Auto-completes a hand that can no longer act: a bust, or a 21 that the player
 * would never hit. Auto-standing on 21 is a safety convenience, not a rule
 * change — it removes an interaction whose only outcome is an accidental bust.
 */
function completeIfTerminal(
  hand: PlayerHand,
  rules: BlackjackRules,
  seat: SeatState,
  events: EngineEvent[],
): void {
  if (hand.status !== "ACTIVE") return;
  const value = evaluatePlayerHand(hand, rules.splitAceTwentyOneIsBlackjack);
  if (value.isBust) {
    setHandStatus(hand, "BUSTED", seat, events);
  } else if (value.isTwentyOne) {
    setHandStatus(hand, value.isNaturalBlackjack ? "BLACKJACK" : "TWENTY_ONE", seat, events);
  }
}

// ---------------------------------------------------------------------------
// Small utilities
// ---------------------------------------------------------------------------

function requirePhase(state: EngineState, phase: EngineState["phase"]): void {
  if (state.phase !== phase) {
    throw new EngineError("WRONG_PHASE", `Expected phase ${phase}, but the game is in ${state.phase}`);
  }
}

function requireSeat(state: EngineState, seatId: string): SeatState {
  const seat = findSeat(state, seatId);
  if (!seat) throw new EngineError("UNKNOWN_SEAT", `No seat "${seatId}" at this table`);
  return seat as SeatState;
}

/**
 * Whether the table's current deadline has passed by the SERVER's clock.
 *
 * Exported because two callers need the same answer and a second copy of the
 * comparison is a second answer. `handleResolveTimeout` asks it before applying
 * a default; `game-command` asks it before running a competition boundary for a
 * settlement-window timeout, because that boundary can END a tournament and must
 * not be reachable a moment early by a client with a fast clock.
 *
 * `now` is always the server's own timestamp. A client's `clientSentAt` is
 * telemetry and never reaches here.
 */
export function isDeadlineReached(state: BlackjackGameState, now: string): boolean {
  if (state.actionDeadlineAt === null) return false;
  return Date.parse(now) >= Date.parse(state.actionDeadlineAt);
}

function deadlineFrom(now: string | undefined, millis: number | undefined): string | null {
  if (!now || !millis) return null;
  return new Date(Date.parse(now) + millis).toISOString();
}

function bump(state: EngineState): EngineState {
  state.version += 1;
  return state;
}

/**
 * Deep clone so a rejected command cannot leave the caller's state mutated.
 * `structuredClone` is available in Hermes, Deno and Node 17+; the JSON path is
 * a portable fallback. Engine state is plain data by construction.
 */
function clone(state: EngineState): EngineState {
  if (typeof structuredClone === "function") {
    return structuredClone(state);
  }
  return JSON.parse(JSON.stringify(state)) as EngineState;
}
