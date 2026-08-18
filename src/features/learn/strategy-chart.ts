/**
 * Arc 21 — the strategy chart, PROJECTED from the generated table.
 *
 * Every cell rendered by the Strategy Guide is read out of
 * `ARC_STANDARD_STRATEGY_TABLE`, which is solver output. Nothing here
 * transcribes a published chart, and nothing here decides what the right play
 * is: this module only reshapes solved data into rows and columns.
 *
 * That distinction is the whole point. A hand-typed chart is a guessed
 * strategy — the one thing the specification forbids — and it drifts silently
 * the moment the solver or the ruleset changes. `tests/learn/strategy-chart.test.ts`
 * pins the projection against `adviseAction`, so a chart that disagrees with the
 * advisor the player meets at the table fails the build rather than the player.
 *
 * The rows and the columns are derived from the table's own key space too, so a
 * ruleset that solves for more (or fewer) states renders more (or fewer) rows
 * without an edit here.
 *
 * Runtime-neutral by construction: no React, no React Native. The screen renders
 * what this returns.
 */

import {
  actionEVs,
  DEALER_UPCARD_VALUES,
  describeUpcardLabel,
  normalizeStrategyKey,
  pairTotal,
  type ActionEV,
  type HandClass,
  type StrategyAction,
  type StrategyDecision,
  type StrategyState,
  type StrategyTable,
} from "../../../shared/strategy/index.js";
import type { StrategyRulesSummary } from "../../../shared/strategy/index.js";

// ---------------------------------------------------------------------------
// Tabs
// ---------------------------------------------------------------------------

export type ChartTab = "hard" | "soft" | "pairs";

export interface ChartTabDefinition {
  id: ChartTab;
  label: string;
  handClass: HandClass;
  /** One line of orientation, shown above the grid. */
  blurb: string;
}

/**
 * "Pairs" is a tab, not a hand class: the table calls the class `pair`, and the
 * two names are kept separate so the UI copy can change without touching a key.
 */
export const CHART_TABS: readonly ChartTabDefinition[] = [
  {
    id: "hard",
    label: "Hard",
    handClass: "hard",
    blurb: "No ace, or an ace that must count as 1.",
  },
  {
    id: "soft",
    label: "Soft",
    handClass: "soft",
    blurb: "Holding an ace that can still count as 11 without busting.",
  },
  {
    id: "pairs",
    label: "Pairs",
    handClass: "pair",
    blurb: "Your first two cards are worth the same — splitting is on the table.",
  },
];

export function chartTab(id: ChartTab): ChartTabDefinition {
  const found = CHART_TABS.find((tab) => tab.id === id);
  if (!found) throw new Error(`Unknown chart tab "${id}"`);
  return found;
}

/** Narrows an arbitrary route parameter to a tab, defaulting to Hard. */
export function parseChartTab(value: string | undefined): ChartTab {
  return CHART_TABS.some((tab) => tab.id === value) ? (value as ChartTab) : "hard";
}

// ---------------------------------------------------------------------------
// Cell codes
// ---------------------------------------------------------------------------

/**
 * The single letter shown inside a cell.
 *
 * The letter is what the cell *means*; the tint behind it is decoration. Colour
 * is never the only encoding — a player who cannot separate the hues reads the
 * same chart everyone else does.
 */
export type ChartCode = "H" | "S" | "D" | "P" | "R";

const CODE_FOR_ACTION: Readonly<Record<StrategyAction, ChartCode>> = {
  HIT: "H",
  STAND: "S",
  DOUBLE: "D",
  SPLIT: "P",
  SURRENDER: "R",
};

export function chartCodeForAction(action: StrategyAction): ChartCode {
  return CODE_FOR_ACTION[action];
}

const VERB: Readonly<Record<StrategyAction, string>> = {
  HIT: "hit",
  STAND: "stand",
  DOUBLE: "double",
  SPLIT: "split",
  SURRENDER: "surrender",
};

function sentenceCase(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/**
 * The cell in words, including its fallback.
 *
 * `fallbackAction` is data on the cell, not a rule invented in the UI, which is
 * exactly why "double if allowed, otherwise hit" can be stated honestly rather
 * than approximated as "double".
 */
export function describeChartCell(decision: StrategyDecision): string {
  const primary = sentenceCase(VERB[decision.recommendedAction]);
  const fallback = decision.fallbackAction;
  if (fallback === undefined) return primary;
  return `${primary} if allowed, otherwise ${VERB[fallback]}`;
}

export interface ChartLegendEntry {
  code: ChartCode;
  meaning: string;
}

/**
 * The legend the specification asks for, stated once so the guide and its tests
 * read the same list.
 */
export const CHART_LEGEND: readonly ChartLegendEntry[] = [
  { code: "H", meaning: "Hit" },
  { code: "S", meaning: "Stand" },
  { code: "D", meaning: "Double if allowed, otherwise the cell's fallback" },
  { code: "P", meaning: "Split" },
  { code: "R", meaning: "Surrender if allowed, otherwise the cell's fallback" },
];

// ---------------------------------------------------------------------------
// Grid
// ---------------------------------------------------------------------------

export interface ChartCell {
  key: string;
  state: StrategyState;
  decision: StrategyDecision;
  code: ChartCode;
  action: StrategyAction;
  fallback: StrategyAction | null;
  upcardValue: number;
  upcardLabel: string;
  /** "Double if allowed, otherwise hit". */
  meaning: string;
  accessibilityLabel: string;
  /** Every priced action for this cell, best first. Empty if the cell has none. */
  evs: ActionEV[];
}

export interface ChartRow {
  handClass: HandClass;
  /** Player total for hard/soft rows; the pair's card value for pair rows. */
  rowValue: number;
  /** Compact label for the sticky column: "16", "A,7", "8,8". */
  label: string;
  /** Spoken label: "Hard 16", "Soft 18", "Pair of eights". */
  accessibilityLabel: string;
  /**
   * A cell is null only when the table has no entry for that coordinate. The
   * guide renders an em-dash there rather than inventing an action — the same
   * fail-safe the advisor uses.
   */
  cells: readonly (ChartCell | null)[];
}

export interface StrategyChart {
  tab: ChartTab;
  /** Dealer upcard columns, in chart order: 2..10 then A. */
  upcards: readonly { value: number; label: string }[];
  rows: readonly ChartRow[];
  /** "Arc Standard · 6 decks · dealer stands soft 17 · double after split · late surrender". */
  rulesetLine: string;
  /** Secondary line: payout, split policy, split-hand cap. */
  rulesetDetail: string;
}

export const CHART_UPCARDS: readonly { value: number; label: string }[] =
  DEALER_UPCARD_VALUES.map((value) => ({ value, label: describeUpcardLabel(value) }));

/**
 * Which rows this table actually solves for, ascending.
 *
 * Derived from the entries rather than declared, so the guide cannot show a row
 * the solver never produced, and cannot omit one it did.
 */
export function chartRowValues(table: StrategyTable, handClass: HandClass): number[] {
  const values = new Set<number>();
  for (const decision of Object.values(table.entries)) {
    if (decision.handClass !== handClass) continue;
    const value = handClass === "pair" ? decision.pairValue : decision.playerTotal;
    if (value === undefined) continue;
    values.add(value);
  }
  return [...values].sort((a, b) => a - b);
}

/** The state a chart coordinate addresses. */
export function chartState(
  handClass: HandClass,
  rowValue: number,
  dealerUpcardValue: number,
): StrategyState {
  if (handClass === "pair") {
    return {
      handClass,
      playerTotal: pairTotal(rowValue),
      pairValue: rowValue,
      dealerUpcardValue,
    };
  }
  return { handClass, playerTotal: rowValue, dealerUpcardValue };
}

const PAIR_NOUN: Readonly<Record<number, string>> = {
  2: "twos",
  3: "threes",
  4: "fours",
  5: "fives",
  6: "sixes",
  7: "sevens",
  8: "eights",
  9: "nines",
  10: "tens",
  11: "aces",
};

/** Compact row label for the sticky column. */
export function chartRowLabel(handClass: HandClass, rowValue: number): string {
  if (handClass === "pair") {
    const face = rowValue === 11 ? "A" : String(rowValue);
    return `${face},${face}`;
  }
  if (handClass === "soft") {
    // A soft total is an ace plus the rest. Soft 12 is the two-ace holding
    // played as a total rather than as a pair, so it is labelled A,A.
    return rowValue === 12 ? "A,A" : `A,${rowValue - 11}`;
  }
  return String(rowValue);
}

/** Spoken row label. Screen readers get words, not chart shorthand. */
export function chartRowAccessibilityLabel(handClass: HandClass, rowValue: number): string {
  if (handClass === "pair") {
    return `Pair of ${PAIR_NOUN[rowValue] ?? String(rowValue)}`;
  }
  return `${handClass === "soft" ? "Soft" : "Hard"} ${rowValue}`;
}

function buildCell(
  table: StrategyTable,
  handClass: HandClass,
  rowValue: number,
  upcardValue: number,
): ChartCell | null {
  const state = chartState(handClass, rowValue, upcardValue);
  const key = normalizeStrategyKey(state);
  const decision = table.entries[key];
  if (decision === undefined) return null;

  const meaning = describeChartCell(decision);
  const upcardLabel = describeUpcardLabel(upcardValue);

  return {
    key,
    state,
    decision,
    code: chartCodeForAction(decision.recommendedAction),
    action: decision.recommendedAction,
    fallback: decision.fallbackAction ?? null,
    upcardValue,
    upcardLabel,
    meaning,
    accessibilityLabel: `${chartRowAccessibilityLabel(handClass, rowValue)} against dealer ${
      upcardValue === 11 ? "ace" : upcardValue
    }: ${meaning.toLowerCase()}`,
    evs: actionEVs(decision),
  };
}

/** Title-cases a ruleset id: `arc-standard` → `Arc Standard`. */
export function rulesetDisplayName(rulesetId: string): string {
  return rulesetId
    .split(/[-_]/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

/**
 * The ruleset banner every chart must carry.
 *
 * Built from `metadata.rulesSummary` — the rules the solver actually ran over —
 * so it can never claim a rule the chart was not solved for. Basic strategy is
 * rule-specific; a chart that does not say which rules it belongs to is
 * misinformation waiting to happen.
 */
export function chartRulesetLine(
  rulesetId: string,
  summary: Readonly<StrategyRulesSummary>,
): string {
  return [
    rulesetDisplayName(rulesetId),
    `${summary.decks} decks`,
    summary.dealerHitsSoft17 ? "dealer hits soft 17" : "dealer stands soft 17",
    summary.doubleAfterSplit ? "double after split" : "no double after split",
    summary.lateSurrenderAllowed ? "late surrender" : "no surrender",
  ].join(" · ");
}

/** Second banner line: the rules that shape the pair rows and the payout. */
export function chartRulesetDetail(summary: Readonly<StrategyRulesSummary>): string {
  return [
    `blackjack pays ${summary.blackjackPayout}`,
    summary.splitPolicy === "same_value" ? "split any equal values" : "split by rank",
    `up to ${summary.maxSplitHands} hands`,
    summary.hitSplitAcesAllowed ? "hit split aces" : "one card to split aces",
  ].join(" · ");
}

/** The whole grid for one tab. */
export function buildStrategyChart(table: StrategyTable, tab: ChartTab): StrategyChart {
  const { handClass } = chartTab(tab);

  const rows: ChartRow[] = chartRowValues(table, handClass).map((rowValue) => ({
    handClass,
    rowValue,
    label: chartRowLabel(handClass, rowValue),
    accessibilityLabel: chartRowAccessibilityLabel(handClass, rowValue),
    cells: CHART_UPCARDS.map((upcard) => buildCell(table, handClass, rowValue, upcard.value)),
  }));

  return {
    tab,
    upcards: CHART_UPCARDS,
    rows,
    rulesetLine: chartRulesetLine(table.rulesetId, table.metadata.rulesSummary),
    rulesetDetail: chartRulesetDetail(table.metadata.rulesSummary),
  };
}
