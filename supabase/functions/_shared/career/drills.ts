/**
 * Arc 21 — targeted drill scenarios.
 *
 * Runtime-neutral. A drill is NOT a dealt hand: the cards are constructed to
 * put one decision family in front of the player repeatedly, which a fair shoe
 * would take hundreds of hands to do. That is a legitimate teaching tool and an
 * illegitimate thing to disguise, so every drill node is badged "Drill" in the
 * UI and the product never presents these as organically shuffled casino hands.
 *
 * Two design rules keep drills honest:
 *
 *   1. **Legality comes from the engine.** `drillLegalActions` builds a real
 *      `BlackjackGameState` and asks `getLegalActions`. Hand-rolling "a
 *      two-card hand can double and surrender" here would be a second
 *      implementation of the rules, and second implementations drift.
 *
 *   2. **Every scenario round-trips.** A candidate is kept only if
 *      `describeStrategyState` re-derives the intended coordinate from the
 *      cards themselves, and only if the validated tables can actually grade
 *      it. A drill therefore never shows a hand it cannot mark, so its accuracy
 *      denominator is exactly the number of scenarios presented.
 *
 * No wager is at stake in a drill and no bankroll moves. Drill nodes are scored
 * on accuracy alone, which is why none of them carries a bankroll star.
 */

import { getLegalActions } from "../engine-primitives.ts";
import { randomIntBelow, type RandomSource } from "../engine-primitives.ts";
import type { BlackjackRules } from "../engine-primitives.ts";
import type {
  BlackjackGameState,
  Card,
  PlayerActionType,
  Rank,
  Suit,
} from "../engine-primitives.ts";
import {
  adviseAction,
  bestLegalEV,
  describeStrategyState,
  describeStrategyStateLabel,
  describeUpcardLabel,
  evForAction,
  normalizeStrategyKey,
  type StrategyAction,
  type StrategyState,
} from "../strategy/index.ts";
import type { DrillFocus } from "./types.ts";

/** Seat id used by the synthetic state that answers legality questions. */
const DRILL_SEAT = "drill";

/** Nominal wager for the synthetic state. Never charged; drills risk nothing. */
const DRILL_WAGER = 100;

export interface DrillScenario {
  /** Normalized strategy key, e.g. `"hard:11:6"`. Stable and unique in a pool. */
  readonly key: string;
  readonly playerCards: readonly Card[];
  readonly dealerUpcard: Card;
  readonly state: StrategyState;
  /** Exactly what the engine would permit for this hand. */
  readonly legalActions: readonly PlayerActionType[];
  /** Chart-style labels, e.g. "Hard 16" and "10". */
  readonly handLabel: string;
  readonly upcardLabel: string;
}

export interface DrillVerdict {
  readonly chosen: PlayerActionType;
  readonly recommended: StrategyAction;
  readonly correct: boolean;
  /** Expectation given up, in units of the original wager. Null if unpriced. */
  readonly evLost: number | null;
}

// ---------------------------------------------------------------------------
// Card construction
// ---------------------------------------------------------------------------

const SUIT_CYCLE: readonly Suit[] = ["S", "H", "D", "C"];

function rankForValue(value: number): Rank | null {
  if (value === 11) return "A";
  if (value === 10) return "10";
  if (value >= 2 && value <= 9) return String(value) as Rank;
  return null;
}

/**
 * Suits are cycled deterministically from the card's position.
 *
 * Suit has no effect on strategy or on any outcome, so this is presentation
 * only — and it is emphatically not a place to reach for a random number.
 */
function drillCard(rank: Rank, key: string, seq: number): Card {
  const suit = SUIT_CYCLE[seq % SUIT_CYCLE.length]!;
  return { id: `drill:${key}:${seq}:${rank}${suit}`, suit, rank, deckIndex: 0 };
}

/**
 * Two cards holding a hard total, never an equal-value pair.
 *
 * Splits the total as evenly as possible and steps one apart when that would
 * produce a pair, so `hard 16` is 7+9 rather than 8+8 — an 8,8 would classify
 * as a pair and answer from a different row of the chart entirely.
 *
 * Returns null for totals no such two-card hand can hold: 4 (only 2+2) and 20
 * (only 10+10) are pairs by construction.
 */
function hardPairFreeCards(total: number): [number, number] | null {
  let low = Math.floor(total / 2);
  let high = total - low;
  if (low === high) {
    low -= 1;
    high += 1;
  }
  if (low < 2 || high > 10) return null;
  return [low, high];
}

function materialise(state: StrategyState): Omit<DrillScenario, "legalActions"> | null {
  const key = safeKey(state);
  if (key === null) return null;

  const upcardRank = rankForValue(state.dealerUpcardValue);
  if (upcardRank === null) return null;

  const values = playerCardValues(state);
  if (values === null) return null;

  const ranks: Rank[] = [];
  for (const value of values) {
    const rank = rankForValue(value);
    if (rank === null) return null;
    ranks.push(rank);
  }

  const playerCards = ranks.map((rank, index) => drillCard(rank, key, index));
  const dealerUpcard = drillCard(upcardRank, key, ranks.length);

  // The cards, not the requested coordinate, are the source of truth. If the
  // engine's own classifier does not agree that these cards are the intended
  // state, the scenario is discarded rather than shown under a wrong label.
  const derived = describeStrategyState(playerCards, dealerUpcard, { splitPolicy: "same_value" });
  if (derived === null) return null;
  if (safeKey(derived) !== key) return null;

  return {
    key,
    playerCards,
    dealerUpcard,
    state: derived,
    handLabel: describeStrategyStateLabel(derived),
    upcardLabel: describeUpcardLabel(derived.dealerUpcardValue),
  };
}

function playerCardValues(state: StrategyState): [number, number] | null {
  if (state.handClass === "pair") {
    const value = state.pairValue;
    if (value === undefined) return null;
    return [value, value];
  }
  if (state.handClass === "soft") {
    const other = state.playerTotal - 11;
    // Soft 12 is A,A (a pair) and soft 21 is a natural; neither is a drillable
    // "soft hand" decision, so both fall outside 2..9 and are rejected here.
    if (other < 2 || other > 9) return null;
    return [11, other];
  }
  return hardPairFreeCards(state.playerTotal);
}

/** `normalizeStrategyKey` throws on a malformed state; a pool builder wants null. */
function safeKey(state: StrategyState): string | null {
  try {
    return normalizeStrategyKey(state);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Legality — delegated to the engine, never re-derived
// ---------------------------------------------------------------------------

/**
 * What the engine would allow for this hand, as a fresh two-card hand with a
 * stack large enough that affordability never silently removes an action.
 */
export function drillLegalActions(
  rules: BlackjackRules,
  playerCards: readonly Card[],
  dealerUpcard: Card,
): PlayerActionType[] {
  const state: BlackjackGameState = {
    gameId: "drill",
    rules,
    phase: "PLAYER_TURNS",
    seats: [
      {
        seatId: DRILL_SEAT,
        userId: null,
        displayName: "You",
        // Comfortably above any double or split cost, so legality reflects the
        // rules rather than the size of an imaginary stack.
        stack: DRILL_WAGER * 8,
        originalBet: DRILL_WAGER,
        insuranceBet: 0,
        insuranceDecision: "NOT_OFFERED",
        hands: [
          {
            id: "drill-hand",
            cards: [...playerCards],
            wager: DRILL_WAGER,
            status: "ACTIVE",
            cameFromSplit: false,
            cameFromSplitAces: false,
          },
        ],
        currentHandIndex: 0,
        connected: true,
        betLocked: true,
        sittingOut: false,
      },
    ],
    dealer: { cards: [dealerUpcard], holeCardRevealed: false },
    activeSeatIndex: 0,
    activeHandIndex: 0,
    handNumber: 1,
    version: 0,
    // getLegalActions never reads the shoe. An empty one keeps it obvious that
    // no card can be drawn from a drill.
    shoe: { cards: [], nextIndex: 0, shuffleNumber: 1, cutIndex: 0 },
    actionDeadlineAt: null,
  };

  return getLegalActions(state, DRILL_SEAT).actions;
}

// ---------------------------------------------------------------------------
// Pools
// ---------------------------------------------------------------------------

const UPCARDS: readonly number[] = [2, 3, 4, 5, 6, 7, 8, 9, 10, 11];
const PAIR_VALUES: readonly number[] = [2, 3, 4, 5, 6, 7, 8, 9, 10, 11];

function statesForFocus(focus: DrillFocus): StrategyState[] {
  const states: StrategyState[] = [];

  const hard = (totals: readonly number[], upcards: readonly number[] = UPCARDS) => {
    for (const total of totals) {
      for (const upcard of upcards) {
        states.push({ handClass: "hard", playerTotal: total, dealerUpcardValue: upcard });
      }
    }
  };
  const soft = (totals: readonly number[]) => {
    for (const total of totals) {
      for (const upcard of UPCARDS) {
        states.push({ handClass: "soft", playerTotal: total, dealerUpcardValue: upcard });
      }
    }
  };
  const pairs = () => {
    for (const value of PAIR_VALUES) {
      for (const upcard of UPCARDS) {
        states.push({
          handClass: "pair",
          playerTotal: value === 11 ? 12 : value * 2,
          pairValue: value,
          dealerUpcardValue: upcard,
        });
      }
    }
  };

  switch (focus) {
    case "double":
      // Where doubling is genuinely the question: the hard totals it is ever
      // right on, and the soft hands where it competes with hitting.
      hard([9, 10, 11]);
      soft([13, 14, 15, 16, 17, 18]);
      break;

    case "pair":
    case "split":
      // The same family at two different bars: F4 introduces it, W5 raises it.
      // Splitting is legal far more often than it is correct, which is exactly
      // what makes the full pair space worth drilling.
      pairs();
      break;

    case "surrender":
      // Late surrender only ever competes against a high upcard, and the drill
      // must contain plenty of hands where the answer is "do not surrender".
      hard([12, 13, 14, 15, 16, 17], [7, 8, 9, 10, 11]);
      break;

    case "soft":
      soft([13, 14, 15, 16, 17, 18, 19, 20]);
      break;

    case "mixed":
      hard([8, 9, 10, 11, 12, 13, 14, 15, 16, 17]);
      soft([13, 14, 15, 16, 17, 18, 19, 20]);
      pairs();
      break;
  }

  return states;
}

/**
 * Every scenario of a focus that can actually be built and graded, in a stable
 * order. Deterministic — selection is where randomness enters.
 */
export function drillPool(rules: BlackjackRules, focus: DrillFocus): DrillScenario[] {
  const pool: DrillScenario[] = [];
  const seen = new Set<string>();

  for (const state of statesForFocus(focus)) {
    const base = materialise(state);
    if (base === null) continue;
    if (seen.has(base.key)) continue;

    const legalActions = drillLegalActions(rules, base.playerCards, base.dealerUpcard);

    // A scenario the validated tables cannot answer must never be presented:
    // there would be no correct answer to mark it against, and the specification
    // forbids guessing one.
    const recommendation = adviseAction({ rules, state: base.state, legalActions });
    if (recommendation === null) continue;

    seen.add(base.key);
    pool.push({ ...base, legalActions });
  }

  return pool;
}

/**
 * Picks `count` distinct scenarios from a focus.
 *
 * Uses the injected `RandomSource` — the same CSPRNG that shuffles the shoe.
 * `Math.random()` is never acceptable for anything a player is scored on, and
 * which twelve of ninety scenarios you are asked is exactly that.
 *
 * When a pool is smaller than the requested count the pool repeats, reshuffled,
 * rather than returning fewer scenarios: a node that promises twelve decisions
 * must ask twelve. Every shipped pool is larger than every shipped count, and a
 * test asserts it.
 */
export function buildDrillScenarios(options: {
  rules: BlackjackRules;
  focus: DrillFocus;
  count: number;
  random: RandomSource;
}): DrillScenario[] {
  const { rules, focus, count, random } = options;
  if (count <= 0) return [];

  const pool = drillPool(rules, focus);
  if (pool.length === 0) {
    throw new Error(`Drill focus "${focus}" produced no gradeable scenarios`);
  }

  const chosen: DrillScenario[] = [];
  while (chosen.length < count) {
    const shuffled = shuffled_(pool, random);
    for (const scenario of shuffled) {
      if (chosen.length >= count) break;
      chosen.push(scenario);
    }
  }
  return chosen;
}

/** Non-mutating unbiased shuffle, so the pool itself stays in a stable order. */
function shuffled_<T>(items: readonly T[], random: RandomSource): T[] {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = randomIntBelow(random, i + 1);
    const tmp = copy[i]!;
    copy[i] = copy[j]!;
    copy[j] = tmp;
  }
  return copy;
}

// ---------------------------------------------------------------------------
// Grading
// ---------------------------------------------------------------------------

/**
 * Marks one drill answer.
 *
 * Returns null when the tables have no opinion — which `drillPool` has already
 * made impossible for a shipped scenario, but the contract is kept so a caller
 * can never treat "we could not grade that" as "you were wrong".
 */
export function gradeDrillDecision(
  rules: BlackjackRules,
  scenario: DrillScenario,
  chosen: PlayerActionType,
): DrillVerdict | null {
  const recommendation = adviseAction({
    rules,
    state: scenario.state,
    legalActions: scenario.legalActions,
  });
  if (recommendation === null) return null;

  const correct = chosen === recommendation.action;
  if (correct) {
    return { chosen, recommended: recommendation.action, correct: true, evLost: 0 };
  }

  // Priced against the best action that was actually available. Grading against
  // the best PRICED action would bill the player for plays the engine would
  // have rejected.
  const best = bestLegalEV(recommendation.decision, scenario.legalActions);
  const chosenEv = evForAction(recommendation.decision, chosen as StrategyAction);
  const evLost =
    best !== null && chosenEv !== null ? Math.max(0, best.ev - chosenEv) : null;

  return { chosen, recommended: recommendation.action, correct: false, evLost };
}
