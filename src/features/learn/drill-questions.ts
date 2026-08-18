/**
 * Arc 21 — Decision Drill questions.
 *
 * Questions are GENERATED FROM THE TABLE'S OWN KEY SPACE. The generator walks
 * `ARC_STANDARD_STRATEGY_TABLE.entries`, realises each key as two real `Card`
 * objects plus a dealer upcard, derives the state back out of those cards with
 * the engine's own `describeStrategyState`, and then asks `adviseAction` for the
 * answer. A key that does not survive that round trip — or that the advisor
 * declines to answer — is not asked.
 *
 * That is the guarantee the specification wants: **a question can never be asked
 * that the tables cannot grade**, because the answer is produced by the same
 * lookup the player meets at the Practice table, not by a parallel list of
 * "correct" plays maintained here.
 *
 * Two consequences worth stating plainly:
 *
 *   - Not every solved cell is a drill. `hard:21` needs three cards, `soft:21`
 *     is a natural (nothing to decide), and `hard:4` / `hard:20` can only be
 *     made by a pair, which the classifier calls a pair. Those cells are real
 *     and the Strategy Guide still shows them; they simply cannot be posed as a
 *     two-card question, so they are skipped rather than faked with a hand the
 *     player would never hold.
 *   - The action buttons come from the ruleset, not from a hardcoded list, and
 *     `tests/learn/drill-questions.test.ts` deals the same cards through the
 *     real engine and asserts `getLegalActions` agrees. A drill that offered a
 *     button the table would not is a drill that teaches the wrong thing.
 *
 * Runtime-neutral: no React, no React Native, no Expo.
 */

import { describeStrategyState } from "../../../shared/strategy/index.js";
import {
  adviseAction,
  ARC_STANDARD_STRATEGY_TABLE,
  describeStrategyStateLabel,
  describeUpcardLabel,
  evMistakeForDecision,
  legalActionEVs,
  normalizeStrategyKey,
  type ActionEV,
  type HandClass,
  type StrategyAction,
  type StrategyDecision,
  type StrategyState,
  type StrategyTable,
} from "../../../shared/strategy/index.js";
import { ARC_STANDARD_RULES, type BlackjackRules } from "../../../shared/blackjack/rules.js";
import type { Card, Rank, Suit } from "../../../shared/blackjack/types.js";
import { format, formatMagnitude } from "../practice/advice.js";

// ---------------------------------------------------------------------------
// Categories
// ---------------------------------------------------------------------------

export type DrillCategory = "mixed" | "hard" | "soft" | "pairs" | "mistakes";

export interface DrillCategoryDefinition {
  id: DrillCategory;
  label: string;
  blurb: string;
  /** Null for Mixed and My mistakes, which are not a single hand class. */
  handClass: HandClass | null;
}

export const DRILL_CATEGORIES: readonly DrillCategoryDefinition[] = [
  {
    id: "mixed",
    label: "Mixed",
    blurb: "Every hand type, drawn at random.",
    handClass: null,
  },
  {
    id: "hard",
    label: "Hard totals",
    blurb: "No ace, or an ace forced to count as 1.",
    handClass: "hard",
  },
  {
    id: "soft",
    label: "Soft totals",
    blurb: "An ace still counting as 11 — the hands most people misplay.",
    handClass: "soft",
  },
  {
    id: "pairs",
    label: "Pairs",
    blurb: "When to split, and when splitting costs you.",
    handClass: "pair",
  },
  {
    id: "mistakes",
    label: "My mistakes",
    blurb: "Hands you have missed, weighted so the recent ones come round sooner.",
    handClass: null,
  },
];

export function drillCategory(id: DrillCategory): DrillCategoryDefinition {
  const found = DRILL_CATEGORIES.find((category) => category.id === id);
  if (!found) throw new Error(`Unknown drill category "${id}"`);
  return found;
}

/** Narrows an arbitrary route parameter, defaulting to Mixed. */
export function parseDrillCategory(value: string | undefined): DrillCategory {
  return DRILL_CATEGORIES.some((category) => category.id === value)
    ? (value as DrillCategory)
    : "mixed";
}

// ---------------------------------------------------------------------------
// Realising a strategy key as real cards
// ---------------------------------------------------------------------------

const RANK_FOR_VALUE: Readonly<Record<number, Rank>> = {
  2: "2",
  3: "3",
  4: "4",
  5: "5",
  6: "6",
  7: "7",
  8: "8",
  9: "9",
  10: "10",
  11: "A",
};

/**
 * Drill cards are illustrations, not dealt cards: they are constructed here
 * rather than drawn from a shoe, and they never touch the engine's shoe or any
 * chip balance. Ids are stable and unique within a question so React can key on
 * them and so the same question renders identically every time it comes round.
 */
function drillCard(value: number, suit: Suit, key: string, slot: string): Card | null {
  const rank = RANK_FOR_VALUE[value];
  if (rank === undefined) return null;
  return { id: `drill:${key}:${slot}`, suit, rank, deckIndex: 0 };
}

/**
 * The two card values that make a hand of this class and total.
 *
 * Returns null when two cards cannot make it. Being explicit about the
 * impossible cases is the point — silently substituting a three-card hand for
 * `hard:21` would ask the player a question about a hand they are not looking
 * at.
 */
export function twoCardValuesFor(
  handClass: HandClass,
  rowValue: number,
): [number, number] | null {
  if (handClass === "pair") {
    return RANK_FOR_VALUE[rowValue] === undefined ? null : [rowValue, rowValue];
  }

  if (handClass === "soft") {
    // An ace plus one other card. Soft 12 would be A,A (a pair) and soft 21
    // would be a natural, so neither is a decision.
    const other = rowValue - 11;
    if (other < 2 || other > 9) return null;
    return [11, other];
  }

  // Hard: two non-ace cards of DIFFERENT values, or the classifier would call it
  // a pair. That rules out 4 (2,2) and 20 (10,10 — and K,Q, which is still an
  // equal-value pair under Arc Standard). It also rules out 21: the only
  // two-card 21 is A,10, which is a natural and not a decision at all.
  const low = rowValue <= 12 ? 2 : rowValue - 10;
  const high = rowValue - low;
  if (low < 2 || high < 2 || low > 10 || high > 10 || low === high) return null;
  return [low, high];
}

// ---------------------------------------------------------------------------
// Legal actions for a fresh two-card hand
// ---------------------------------------------------------------------------

/** The order buttons appear in, matching the table's action dock. */
const ACTION_ORDER: readonly StrategyAction[] = ["HIT", "STAND", "DOUBLE", "SPLIT", "SURRENDER"];

/**
 * What the engine would allow on an original, funded, unsplit two-card hand.
 *
 * This mirrors `getLegalActions` for exactly that situation and is pinned to it
 * by a test that deals the same cards through the real engine. It is derived
 * from the ruleset rather than hardcoded so a variant that removes surrender or
 * DAS removes the button too.
 *
 * Affordability is deliberately assumed: a drill has no bankroll, so there is no
 * stack for a double to be short of.
 */
export function drillLegalActions(
  rules: BlackjackRules,
  state: StrategyState,
): StrategyAction[] {
  const actions: StrategyAction[] = ["HIT", "STAND"];

  if (rules.doubleAllowed && rules.doubleOnAnyTwoCards) actions.push("DOUBLE");

  if (state.handClass === "pair" && rules.maxSplitHands > 1) {
    const splittingAces = state.pairValue === 11;
    if (!splittingAces || rules.splitAcesAllowed) actions.push("SPLIT");
  }

  if (rules.lateSurrenderAllowed) actions.push("SURRENDER");

  return ACTION_ORDER.filter((action) => actions.includes(action));
}

// ---------------------------------------------------------------------------
// Questions
// ---------------------------------------------------------------------------

export interface DrillQuestion {
  /** The strategy key. Also the spaced-repetition key, so history is per-cell. */
  key: string;
  handClass: HandClass;
  state: StrategyState;
  playerCards: readonly [Card, Card];
  dealerUpcard: Card;
  /** "Hard 16", "Soft 18", "8,8". */
  handLabel: string;
  /** "10", "A". */
  upcardLabel: string;
  /** Every action the engine would offer, in dock order. */
  actions: readonly StrategyAction[];
  /** What `adviseAction` answers for this state. Never hand-written. */
  answer: StrategyAction;
  decision: StrategyDecision;
  /** Priced legal actions, best first. Empty when the cell prices none. */
  evs: readonly ActionEV[];
}

export interface BuildQuestionsOptions {
  rules?: BlackjackRules;
  table?: StrategyTable;
}

/**
 * Every gradeable two-card question the table supports, in a stable order.
 *
 * Stable because the order is derived from the sorted key space rather than from
 * `Object.keys` insertion order: a drill bank that reshuffles itself between
 * builds makes a bug report impossible to reproduce.
 */
export function buildDrillQuestions(options: BuildQuestionsOptions = {}): DrillQuestion[] {
  const rules = options.rules ?? ARC_STANDARD_RULES;
  const table = options.table ?? ARC_STANDARD_STRATEGY_TABLE;

  const questions: DrillQuestion[] = [];

  const sortedKeys = Object.keys(table.entries).sort();
  for (const key of sortedKeys) {
    const entry = table.entries[key];
    if (entry === undefined) continue;

    const rowValue = entry.handClass === "pair" ? entry.pairValue : entry.playerTotal;
    if (rowValue === undefined) continue;

    const values = twoCardValuesFor(entry.handClass, rowValue);
    if (values === null) continue;

    const first = drillCard(values[0], "S", key, "p0");
    const second = drillCard(values[1], "H", key, "p1");
    const upcard = drillCard(entry.dealerUpcardValue, "C", key, "up");
    if (first === null || second === null || upcard === null) continue;

    // Derive the state from the CARDS, using the engine's own describer. If the
    // cards do not reproduce the key we set out to ask about, the question is
    // wrong and is dropped rather than mislabelled.
    const state = describeStrategyState([first, second], upcard, {
      splitPolicy: rules.splitPolicy,
      splitAceTwentyOneIsBlackjack: rules.splitAceTwentyOneIsBlackjack,
    });
    if (state === null || normalizeStrategyKey(state) !== key) continue;

    const actions = drillLegalActions(rules, state);
    const recommendation = adviseAction({ rules, state, legalActions: actions });
    // The advisor stays silent rather than guessing; so does the drill.
    if (recommendation === null) continue;

    questions.push({
      key,
      handClass: state.handClass,
      state,
      playerCards: [first, second],
      dealerUpcard: upcard,
      handLabel: describeStrategyStateLabel(state),
      upcardLabel: describeUpcardLabel(state.dealerUpcardValue),
      actions,
      answer: recommendation.action,
      decision: recommendation.decision,
      evs: legalActionEVs(recommendation.decision, actions),
    });
  }

  return questions;
}

/** The questions belonging to a category. `mistakes` is filtered by history. */
export function questionsForCategory(
  questions: readonly DrillQuestion[],
  category: DrillCategory,
): DrillQuestion[] {
  const definition = drillCategory(category);
  if (definition.handClass === null) return [...questions];
  return questions.filter((question) => question.handClass === definition.handClass);
}

// ---------------------------------------------------------------------------
// Grading
// ---------------------------------------------------------------------------

export interface DrillVerdict {
  chosen: StrategyAction;
  expected: StrategyAction;
  correct: boolean;
  /**
   * Expectation given up, per unit of the original wager. Null when the cell
   * does not price the choice — "we do not know" is not the same as "free".
   */
  evLost: number | null;
  /** Drawn from the solver's own EVs, never from written-out prose per cell. */
  explanation: string;
}

const GERUND: Readonly<Record<StrategyAction, string>> = {
  HIT: "hitting",
  STAND: "standing",
  DOUBLE: "doubling",
  SPLIT: "splitting",
  SURRENDER: "surrendering",
};

function capitalise(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/**
 * The rationale for a question, in the solver's numbers.
 *
 * Rounded to two decimals because the underlying model carries documented
 * approximations; more digits would imply precision it does not have.
 */
export function explainDrillQuestion(question: DrillQuestion): string {
  const best = question.evs[0];
  const runnerUp = question.evs[1];

  if (!best || !runnerUp) {
    return `${capitalise(GERUND[question.answer])} is the highest-value play for ${
      question.handLabel
    } against ${question.upcardLabel}.`;
  }

  return (
    `${capitalise(GERUND[best.action])} averages ${format(best.ev)} per bet here, ` +
    `against ${format(runnerUp.ev)} for ${GERUND[runnerUp.action]}.`
  );
}

/** Grades an answer against the advisor's own recommendation. */
export function gradeDrillAnswer(
  question: DrillQuestion,
  chosen: StrategyAction,
): DrillVerdict {
  const correct = chosen === question.answer;
  const evLost = correct
    ? 0
    : evMistakeForDecision(question.decision, chosen, question.actions);

  return {
    chosen,
    expected: question.answer,
    correct,
    evLost,
    explanation: correct
      ? explainDrillQuestion(question)
      : explainMistake(question, chosen, evLost),
  };
}

function explainMistake(
  question: DrillQuestion,
  chosen: StrategyAction,
  evLost: number | null,
): string {
  const best = question.evs.find((entry) => entry.action === question.answer) ?? question.evs[0];
  const chosenEv = question.evs.find((entry) => entry.action === chosen);

  if (!best || !chosenEv) {
    return `${capitalise(GERUND[question.answer])} is the higher-value play for ${
      question.handLabel
    } against ${question.upcardLabel}.`;
  }

  const cost =
    evLost !== null && evLost > 0
      ? ` — about ${formatMagnitude(evLost)} of a bet worse on average.`
      : ".";

  return (
    `${capitalise(GERUND[question.answer])} averages ${format(best.ev)} per bet here; ` +
    `${GERUND[chosen]} averages ${format(chosenEv.ev)}${cost}`
  );
}
