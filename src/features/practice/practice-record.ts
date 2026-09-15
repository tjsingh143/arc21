/**
 * Arc 21 — the local Practice record.
 *
 * Everything a Practice session knows about itself, folded from the engine's own
 * events and its post-command state. Pure functions, runtime-neutral: no React,
 * no React Native, no storage. The store calls `foldCommand` once per accepted
 * command and keeps what comes back.
 *
 * WHY THIS EXISTS AT ALL.
 *
 * The counters below used to be absent, and the Statistics screen said so in
 * as many words: "this device records hands, decisions and chips — not the
 * result of each hand". That was true of the store and false of the product.
 * The engine emits `HAND_SETTLED` with a typed outcome for every hand, and
 * `PLAYER_ACTION` for every double, split and surrender; the store simply threw
 * the events away after using them for sound. Nothing here is derived, guessed
 * or reconstructed from the bankroll — every number is a tally of an event the
 * engine authored.
 *
 * TWO COUNTS OF "HANDS", DELIBERATELY.
 *
 *   `handsPlayed`   rounds. One deal, however many hands a split made of it.
 *   `handsSettled`  settled hands. A split round settles two or more.
 *
 * Wins, losses and pushes are per SETTLED HAND, so they sum to `handsSettled`
 * and not to `handsPlayed`. Conflating the two is how a stats screen ends up
 * claiming more wins than hands.
 */

import { evaluateHand, evaluatePlayerHand } from "../../../shared/blackjack/hand-value.js";
import type {
  BlackjackGameState,
  EngineEvent,
  HandOutcomeKind,
  SeatState,
} from "../../../shared/blackjack/types.js";

// ---------------------------------------------------------------------------
// Statistics
// ---------------------------------------------------------------------------

/**
 * Local practice statistics.
 *
 * Strategy accuracy — not win rate — is the mastery metric: short-run blackjack
 * outcomes are dominated by variance, so a player can play perfectly and lose.
 * The outcome counters are recorded because a player is entitled to see what
 * happened; they are never presented as the measure of skill.
 *
 * Decisions are only counted when the tables could actually adjudicate them, so
 * an unpriced state never counts as a mistake. Accuracy is tracked separately
 * for modes that reveal the answer first, because a "correct" decision made
 * while reading the recommendation measures nothing about the player.
 */
export interface PracticeStats {
  /** Rounds dealt and settled. A split round is one. */
  handsPlayed: number;
  /** Individual hands settled. A split round contributes two or more. */
  handsSettled: number;
  handsWon: number;
  handsLost: number;
  handsPushed: number;
  /** Naturals. A subset of `handsWon`, never added to it. */
  blackjacks: number;
  /** Hands that went over 21. A subset of `handsLost`. */
  busts: number;
  /** Hands given up for half the wager. Counted apart from wins and losses. */
  handsSurrendered: number;

  /** Every chip committed to a hand, including the chips a double or split added. */
  chipsWagered: number;
  /** Sum of settled net across every hand. Insurance included. */
  netChips: number;
  /** Highest chip total the seat has held, stack plus anything on the felt. */
  maxBankroll: number;

  doubles: number;
  /** Doubled hands that won. A doubled hand that busts is never one. */
  doubleWins: number;
  splits: number;
  surrenders: number;
  insuranceTaken: number;

  /** Round-level streaks. A round is won when its net is positive. */
  currentWinStreak: number;
  longestWinStreak: number;
  longestLossStreak: number;

  decisions: number;
  correct: number;
  /** Decisions made without the answer on screen (play and challenge modes). */
  unaidedDecisions: number;
  unaidedCorrect: number;
  estimatedEvLost: number;
  hardDecisions: number;
  hardCorrect: number;
  softDecisions: number;
  softCorrect: number;
  pairDecisions: number;
  pairCorrect: number;
}

export const EMPTY_PRACTICE_STATS: PracticeStats = Object.freeze({
  handsPlayed: 0,
  handsSettled: 0,
  handsWon: 0,
  handsLost: 0,
  handsPushed: 0,
  blackjacks: 0,
  busts: 0,
  handsSurrendered: 0,
  chipsWagered: 0,
  netChips: 0,
  maxBankroll: 0,
  doubles: 0,
  doubleWins: 0,
  splits: 0,
  surrenders: 0,
  insuranceTaken: 0,
  currentWinStreak: 0,
  longestWinStreak: 0,
  longestLossStreak: 0,
  decisions: 0,
  correct: 0,
  unaidedDecisions: 0,
  unaidedCorrect: 0,
  estimatedEvLost: 0,
  hardDecisions: 0,
  hardCorrect: 0,
  softDecisions: 0,
  softCorrect: 0,
  pairDecisions: 0,
  pairCorrect: 0,
});

/** Every key of `PracticeStats`, as data. Exhaustive at compile time. */
export const PRACTICE_STAT_KEYS = Object.keys(
  EMPTY_PRACTICE_STATS,
) as readonly (keyof PracticeStats)[];

// ---------------------------------------------------------------------------
// Hand history
// ---------------------------------------------------------------------------

/**
 * One settled round, as the Play-mode hand history shows it.
 *
 * Cards are deliberately NOT kept. The history is a record of what happened,
 * and a list of every card dealt is both far larger and an invitation to treat
 * it as shoe information. Totals and outcomes are what a player reviews.
 */
export interface PracticeHandRecord {
  handNumber: number;
  /** Chips committed across every hand of the round, doubles and splits included. */
  wagered: number;
  /** Net chip change for the round, insurance included. */
  net: number;
  /** One entry per settled hand, in dealing order. */
  outcomes: readonly HandOutcomeKind[];
  /** Player totals, in the same order as `outcomes`. */
  playerTotals: readonly number[];
  /** Dealer's final total, or null when the dealer never played. */
  dealerTotal: number | null;
  dealerBusted: boolean;
  /** Chips won or lost on the insurance side bet. Zero when none was taken. */
  insuranceNet: number;
}

/** How many settled rounds the history keeps. Bounded so a save cannot grow without limit. */
export const MAX_HAND_HISTORY = 50;

// ---------------------------------------------------------------------------
// Folding one command
// ---------------------------------------------------------------------------

export interface FoldResult {
  stats: PracticeStats;
  /** Present only on the command that settled a round. */
  record: PracticeHandRecord | null;
}

/**
 * Applies one accepted command's events to the record.
 *
 * `before` and `after` are the engine states either side of the command, and
 * `events` is exactly what the engine returned for it. Nothing is inferred from
 * a state diff: a diff cannot tell a double from a hit that happened to add
 * chips, and it cannot see a hand that split and re-merged in the same command.
 */
export function foldCommand(input: {
  stats: PracticeStats;
  before: BlackjackGameState;
  after: BlackjackGameState;
  events: readonly EngineEvent[];
  seatId: string;
}): FoldResult {
  const { before, after, events, seatId } = input;
  const stats = { ...input.stats };

  /*
   * WHAT WAS STAKED ON INSURANCE THIS ROUND.
   *
   * Not simply `before.insuranceBet`. When the dealer peeks and HAS a natural,
   * the engine takes the insurance and settles the whole round inside the SAME
   * command — so at `before` the stake is still zero, and reading it there
   * credited the player with the full insurance return as if it were profit.
   * The event carries the amount, so prefer it and fall back to the seat.
   */
  const insuranceStake = Math.max(
    nonNegative(seatOf(before, seatId)?.insuranceBet ?? 0),
    events.reduce(
      (most, event) =>
        event.type === "INSURANCE_TAKEN" && event.seatId === seatId
          ? Math.max(most, nonNegative(event.amount))
          : most,
      0,
    ),
  );

  for (const event of events) {
    switch (event.type) {
      case "BET_LOCKED":
        if (event.seatId === seatId) stats.chipsWagered += nonNegative(event.amount);
        break;

      case "PLAYER_ACTION":
        if (event.seatId !== seatId) break;
        // The chips a double or a split ADDS are not in `BET_LOCKED`, so they
        // are added here from the hand the engine just changed. Reading the
        // wager off the post-command hand is exact for both.
        if (event.action === "DOUBLE") {
          stats.doubles += 1;
          stats.chipsWagered += addedWager(before, after, seatId, event.handId);
        } else if (event.action === "SURRENDER") {
          stats.surrenders += 1;
        }
        break;

      case "HAND_SPLIT": {
        if (event.seatId !== seatId) break;
        stats.splits += 1;
        // A split stakes the new hand at the original wager.
        const created = findHand(after, seatId, event.newHandIds[1]);
        stats.chipsWagered += nonNegative(created?.wager ?? 0);
        break;
      }

      case "INSURANCE_TAKEN":
        if (event.seatId === seatId) {
          stats.insuranceTaken += 1;
          stats.chipsWagered += nonNegative(event.amount);
        }
        break;

      case "HAND_SETTLED": {
        if (event.seatId !== seatId) break;
        stats.handsSettled += 1;
        stats.netChips += finite(event.outcome.net);
        applyOutcome(stats, event.outcome.kind);

        // A doubled hand keeps `DOUBLED_COMPLETE` unless it busted, and a busted
        // hand is never a win — so this is exact without remembering which hand
        // doubled across commands.
        if (event.outcome.kind === "WIN") {
          const hand = findHand(after, seatId, event.handId);
          if (hand?.status === "DOUBLED_COMPLETE") stats.doubleWins += 1;
        }
        break;
      }

      case "INSURANCE_SETTLED":
        /*
         * `credit` is what came BACK, not what was made. The stake left the
         * stack when insurance was taken, so the net of the side bet is
         * `credit - stake` — adding the credit alone credited the player with
         * chips they had already paid, and made lifetime net disagree with the
         * bankroll by exactly the total staked on insurance.
         */
        if (event.seatId === seatId) stats.netChips += finite(event.credit) - insuranceStake;
        break;

      default:
        break;
    }
  }

  // A round is counted when it reaches settlement, not when the player asks for
  // the next one: quitting after the result still played the hand.
  const settled = after.phase === "HAND_COMPLETE" && before.phase !== "HAND_COMPLETE";

  let record: PracticeHandRecord | null = null;
  if (settled) {
    stats.handsPlayed += 1;
    record = describeRound(after, seatId, events, insuranceStake);
    applyRoundStreak(stats, record.net);
  }

  stats.maxBankroll = Math.max(stats.maxBankroll, chipsHeld(after, seatId));

  return { stats, record };
}

/**
 * Chips the seat holds, wherever they sit.
 *
 * The stake leaves the stack the moment a wager is committed, so a bare `stack`
 * read mid-hand understates the player by exactly what is on the felt — and
 * `maxBankroll` would then be capped at whatever they last had with no bet out.
 */
export function chipsHeld(game: BlackjackGameState, seatId: string): number {
  const seat = game.seats.find((candidate) => candidate.seatId === seatId);
  if (!seat) return 0;

  const stack = nonNegative(seat.stack);

  // Settled: the credit is already back in the stack, and the hands remain only
  // as the record of what was played. Counting their wagers would double them.
  if (game.phase === "HAND_COMPLETE" || game.phase === "BETWEEN_HANDS") return stack;

  if (seat.hands.length === 0) return stack + nonNegative(seat.originalBet);

  const wagered = seat.hands.reduce((sum, hand) => sum + nonNegative(hand.wager), 0);
  return stack + wagered + nonNegative(seat.insuranceBet);
}

// ---------------------------------------------------------------------------

function applyOutcome(stats: PracticeStats, kind: HandOutcomeKind): void {
  switch (kind) {
    case "BLACKJACK":
      stats.blackjacks += 1;
      stats.handsWon += 1;
      break;
    case "WIN":
      stats.handsWon += 1;
      break;
    case "BUST":
      stats.busts += 1;
      stats.handsLost += 1;
      break;
    case "LOSS":
      stats.handsLost += 1;
      break;
    case "PUSH":
      stats.handsPushed += 1;
      break;
    case "SURRENDER":
      // Neither a win nor a loss: half the wager came back. Counting it as a
      // loss would make a correct surrender look like a defeat, which is the
      // opposite of what this product is trying to teach.
      stats.handsSurrendered += 1;
      break;
  }
}

function applyRoundStreak(stats: PracticeStats, net: number): void {
  if (net > 0) {
    stats.currentWinStreak = Math.max(0, stats.currentWinStreak) + 1;
    stats.longestWinStreak = Math.max(stats.longestWinStreak, stats.currentWinStreak);
    return;
  }
  if (net < 0) {
    // Negative values of `currentWinStreak` carry the losing run, so one field
    // can express both directions without a second one that must agree with it.
    stats.currentWinStreak = Math.min(0, stats.currentWinStreak) - 1;
    stats.longestLossStreak = Math.max(stats.longestLossStreak, -stats.currentWinStreak);
    return;
  }
  // A push breaks both runs without starting either.
  stats.currentWinStreak = 0;
}

function describeRound(
  game: BlackjackGameState,
  seatId: string,
  events: readonly EngineEvent[],
  staked: number,
): PracticeHandRecord {
  const seat = seatOf(game, seatId);
  const hands = seat?.hands ?? [];

  // Net, not credit: the stake left the stack when insurance was taken.
  const insuranceNet = events.reduce(
    (sum, event) =>
      event.type === "INSURANCE_SETTLED" && event.seatId === seatId
        ? sum + finite(event.credit) - staked
        : sum,
    0,
  );

  const dealerValue = game.dealer.cards.length > 0
    ? evaluateHand([...game.dealer.cards])
    : null;

  return {
    handNumber: game.handNumber,
    wagered: hands.reduce((sum, hand) => sum + nonNegative(hand.wager), 0) + staked,
    net: hands.reduce((sum, hand) => sum + finite(hand.outcome?.net ?? 0), 0) + insuranceNet,
    outcomes: hands.map((hand) => hand.outcome?.kind).filter(isOutcomeKind),
    playerTotals: hands.map(
      (hand) => evaluatePlayerHand(hand, game.rules.splitAceTwentyOneIsBlackjack).bestTotal,
    ),
    dealerTotal: dealerValue === null ? null : dealerValue.bestTotal,
    dealerBusted: dealerValue?.isBust === true,
    insuranceNet,
  };
}

function isOutcomeKind(kind: HandOutcomeKind | undefined): kind is HandOutcomeKind {
  return kind !== undefined;
}

function seatOf(game: BlackjackGameState, seatId: string): SeatState | undefined {
  return game.seats.find((candidate) => candidate.seatId === seatId);
}

function findHand(game: BlackjackGameState, seatId: string, handId: string | undefined) {
  if (handId === undefined) return undefined;
  return seatOf(game, seatId)?.hands.find((hand) => hand.id === handId);
}

/** How many chips a command added to one hand's wager. Never negative. */
function addedWager(
  before: BlackjackGameState,
  after: BlackjackGameState,
  seatId: string,
  handId: string | undefined,
): number {
  const was = nonNegative(findHand(before, seatId, handId)?.wager ?? 0);
  const now = nonNegative(findHand(after, seatId, handId)?.wager ?? 0);
  return Math.max(0, now - was);
}

function finite(value: number): number {
  return Number.isFinite(value) ? value : 0;
}

function nonNegative(value: number): number {
  return Number.isFinite(value) ? Math.max(0, value) : 0;
}
