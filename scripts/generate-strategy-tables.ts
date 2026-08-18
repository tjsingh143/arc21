/**
 * Arc 21 — strategy table generator.  DEVELOPMENT TOOLING.
 *
 *   npx tsx scripts/generate-strategy-tables.ts
 *
 * Writes two files:
 *   supabase/functions/_shared/strategy/generated-arc-standard-v1.ts   the table the product serves
 *   docs/STRATEGY_VALIDATION.md                    the cross-validation report
 *
 * The mathematics lives in `scripts/strategy-solver.ts`, which documents the
 * method and every approximation in its header. This file is the driver: solve,
 * cross-check against the published chart, emit.
 *
 * ===========================================================================
 * WHY THIS EXISTS
 * ===========================================================================
 *
 * The specification forbids guessed strategy, and a chart typed in from memory
 * is a guess — it cannot be re-derived when a rule changes, and nobody can tell
 * a transcription slip from a deliberate call. So every cell the product serves
 * is computed from first principles.
 *
 * The published chart appears in exactly one place, `scripts/canonical-basic-
 * strategy.ts`, and is used only as an independent reference. Its disagreements
 * with the solver are *reported* with EV numbers, never silently reconciled in
 * either direction: the solver is not tuned to match the chart, and a
 * disagreement is not quietly accepted either.
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import { ARC_STANDARD_RULES } from "../shared/blackjack/rules.js";
import type { BlackjackRules } from "../shared/blackjack/rules.js";
import {
  DEALER_UPCARD_VALUES,
  describeStrategyStateLabel,
  describeUpcardLabel,
  normalizeStrategyKey,
  pairTotal,
  totalRowStateForPair,
} from "../supabase/functions/_shared/strategy/keys.js";
import {
  STRATEGY_RULE_FIELDS,
  strategyRulesSummary,
} from "../supabase/functions/_shared/strategy/rules-summary.js";
import type {
  HandClass,
  StrategyAction,
  StrategyDecision,
  StrategyState,
} from "../supabase/functions/_shared/strategy/types.js";
import {
  CANONICAL_CHART_SOURCE,
  CANONICAL_SIX_DECK_S17_DAS_LS,
  canonicalCellToActions,
  type CanonicalCell,
} from "./canonical-basic-strategy.js";
import {
  SOLVER_APPROXIMATIONS,
  overallExpectation,
  solveChart,
  type Chart,
  type RowResult,
} from "./strategy-solver.js";

// ===========================================================================
// Emitting the generated table
// ===========================================================================

function round(value: number, places = 6): number {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}

const EV_ORDER: readonly StrategyAction[] = ["STAND", "HIT", "DOUBLE", "SPLIT", "SURRENDER"];

function toDecision(row: RowResult, rules: BlackjackRules): StrategyDecision {
  const evs: Partial<Record<StrategyAction, number>> = {};
  for (const action of EV_ORDER) {
    const value = row.evs[action];
    if (value !== undefined) evs[action] = round(value);
  }

  const decision: StrategyDecision = {
    key: normalizeStrategyKey(row.state),
    rulesetId: rules.id,
    rulesetVersion: rules.version,
    handClass: row.state.handClass,
    playerTotal: row.state.playerTotal,
    dealerUpcardValue: row.state.dealerUpcardValue,
    recommendedAction: row.recommendedAction,
    evs,
  };
  if (row.state.pairValue !== undefined) decision.pairValue = row.state.pairValue;
  if (row.fallbackAction !== undefined) decision.fallbackAction = row.fallbackAction;
  return decision;
}

function emitTableSource(
  chart: Chart,
  rules: BlackjackRules,
  expectedValuePerUnit: number,
  generatedAt: string,
): string {
  const decisions = chart.rows.map((row) => toDecision(row, rules));
  decisions.sort((a, b) => a.key.localeCompare(b.key));

  const lines: string[] = [];
  lines.push("/**");
  lines.push(" * GENERATED FILE — DO NOT EDIT.");
  lines.push(" *");
  lines.push(" * Produced by `scripts/generate-strategy-tables.ts`:");
  lines.push(" *   npx tsx scripts/generate-strategy-tables.ts");
  lines.push(" *");
  lines.push(" * Every cell below is the output of an expected-value solver run over the");
  lines.push(" * ruleset named here. No cell was copied from a published chart. Editing this");
  lines.push(" * file by hand replaces computed advice with a guess, which is exactly what the");
  lines.push(" * specification forbids — change the solver and regenerate instead.");
  lines.push(" *");
  lines.push(` * Ruleset:   ${rules.id}@${rules.version}`);
  lines.push(` * Generated: ${generatedAt}`);
  lines.push(" *");
  lines.push(" * Cross-validation against the published chart, including every disagreement");
  lines.push(" * and its EV margin, is in docs/STRATEGY_VALIDATION.md.");
  lines.push(" *");
  lines.push(" * Approximations (also machine-readable in `metadata.method.approximations`):");
  for (const note of SOLVER_APPROXIMATIONS) {
    lines.push(` *   - ${note}`);
  }
  lines.push(" */");
  lines.push("");
  lines.push('import type { StrategyTable } from "./types.ts";');
  lines.push("");
  lines.push("export const ARC_STANDARD_STRATEGY_TABLE: StrategyTable = {");
  lines.push(`  rulesetId: ${JSON.stringify(rules.id)},`);
  lines.push(`  rulesetVersion: ${rules.version},`);
  lines.push("  metadata: {");
  lines.push('    generator: "scripts/generate-strategy-tables.ts",');
  lines.push(`    generatedAt: ${JSON.stringify(generatedAt)},`);
  lines.push(`    deckCount: ${rules.deckCount},`);
  // Emitted from `strategyRulesSummary` rather than field by field, so the
  // summary the table carries and the summary the lookup re-derives from live
  // rules cannot drift apart. A field added there appears here automatically;
  // a field added to `BlackjackRules` and forgotten there is caught by
  // tests/strategy/lookup.test.ts.
  const summary = strategyRulesSummary(rules);
  lines.push("    rulesSummary: {");
  for (const field of STRATEGY_RULE_FIELDS) {
    lines.push(`      ${field}: ${JSON.stringify(summary[field])},`);
  }
  lines.push("    },");
  lines.push("    method: {");
  lines.push(
    '      dealerDistribution: "exact recursion with 6-deck card removal, conditioned on the known cards",',
  );
  lines.push("      peekConditioning: true,");
  lines.push('      playerDraws: "exact recursion with card removal; optimal continuation",');
  lines.push(
    '      splitModel: "pending-hand recursion with an exact max-hands cap, DAS per ruleset, one card to split aces",',
  );
  lines.push(
    '      compositionBasis: "probability-weighted over two-card hands (three-card for hard 21 / soft 21)",',
  );
  lines.push("      approximations: [");
  for (const note of SOLVER_APPROXIMATIONS) {
    lines.push(`        ${JSON.stringify(note)},`);
  }
  lines.push("      ],");
  lines.push("      infiniteDeckApproximationUsed: false,");
  lines.push("    },");
  lines.push(`    expectedValuePerUnit: ${round(expectedValuePerUnit, 8)},`);
  lines.push(`    entryCount: ${decisions.length},`);
  lines.push("  },");
  lines.push("  entries: {");

  for (const decision of decisions) {
    const parts: string[] = [];
    parts.push(`key: ${JSON.stringify(decision.key)}`);
    parts.push(`rulesetId: ${JSON.stringify(decision.rulesetId)}`);
    parts.push(`rulesetVersion: ${decision.rulesetVersion}`);
    parts.push(`handClass: ${JSON.stringify(decision.handClass)}`);
    parts.push(`playerTotal: ${decision.playerTotal}`);
    if (decision.pairValue !== undefined) parts.push(`pairValue: ${decision.pairValue}`);
    parts.push(`dealerUpcardValue: ${decision.dealerUpcardValue}`);
    parts.push(`recommendedAction: ${JSON.stringify(decision.recommendedAction)}`);
    if (decision.fallbackAction !== undefined) {
      parts.push(`fallbackAction: ${JSON.stringify(decision.fallbackAction)}`);
    }
    const evEntries = Object.entries(decision.evs ?? {}).map(
      ([action, value]) => `${action}: ${value}`,
    );
    parts.push(`evs: { ${evEntries.join(", ")} }`);
    lines.push(`    ${JSON.stringify(decision.key)}: { ${parts.join(", ")} },`);
  }

  lines.push("  },");
  lines.push("};");
  lines.push("");
  return lines.join("\n");
}

// ===========================================================================
// Cross-validation against the published chart
// ===========================================================================

export interface Disagreement {
  rowLabel: string;
  upcardLabel: string;
  key: string;
  computed: StrategyAction;
  computedFallback: StrategyAction | undefined;
  canonical: StrategyAction;
  canonicalFallback: StrategyAction | undefined;
  /** Solver's EV for its own choice minus its EV for the published choice. */
  margin: number;
  evs: Partial<Record<StrategyAction, number>>;
  /** The primary actions agree; only the "else" action differs. */
  fallbackOnly: boolean;
  /** The reference row is an extrapolation, not a published row. */
  extrapolatedReference: boolean;
}

function stateForCanonicalRow(
  row: (typeof CANONICAL_SIX_DECK_S17_DAS_LS)[number],
  upcardValue: number,
): StrategyState {
  if (row.handClass === "pair") {
    return {
      handClass: "pair",
      playerTotal: row.total,
      pairValue: row.pairValue,
      dealerUpcardValue: upcardValue,
    };
  }
  return { handClass: row.handClass, playerTotal: row.total, dealerUpcardValue: upcardValue };
}

export function crossValidate(chart: Chart): Disagreement[] {
  const disagreements: Disagreement[] = [];

  for (const row of CANONICAL_SIX_DECK_S17_DAS_LS) {
    DEALER_UPCARD_VALUES.forEach((upcardValue, index) => {
      const cell: CanonicalCell | undefined = row.cells[index];
      if (cell === undefined) return;

      const state = stateForCanonicalRow(row, upcardValue);
      const key = normalizeStrategyKey(state);
      const solved = chart.byKey.get(key);
      if (solved === undefined) {
        throw new Error(`The reference chart names a cell the solver never produced: ${key}`);
      }

      const canonical = canonicalCellToActions(cell);
      const primaryDiffers = solved.recommendedAction !== canonical.action;
      const fallbackDiffers =
        canonical.fallback !== undefined &&
        solved.fallbackAction !== undefined &&
        solved.fallbackAction !== canonical.fallback;

      if (!primaryDiffers && !fallbackDiffers) return;

      const computedEv = solved.evs[solved.recommendedAction] ?? Number.NaN;
      const canonicalEv = solved.evs[canonical.action] ?? Number.NaN;

      disagreements.push({
        rowLabel: describeStrategyStateLabel(state),
        upcardLabel: describeUpcardLabel(upcardValue),
        key,
        computed: solved.recommendedAction,
        computedFallback: solved.fallbackAction,
        canonical: canonical.action,
        canonicalFallback: canonical.fallback,
        margin: computedEv - canonicalEv,
        evs: solved.evs,
        fallbackOnly: !primaryDiffers,
        extrapolatedReference: row.published === false,
      });
    });
  }

  return disagreements;
}

/**
 * Cells where basic strategy is genuinely close, and where different published
 * charts and different solvers legitimately land on different answers. Reported
 * with their margins so a human can see exactly how thin each call is.
 */
const WATCHED_CELLS: ReadonlyArray<{ label: string; state: StrategyState }> = [
  { label: "16 vs 10", state: { handClass: "hard", playerTotal: 16, dealerUpcardValue: 10 } },
  { label: "16 vs 9", state: { handClass: "hard", playerTotal: 16, dealerUpcardValue: 9 } },
  { label: "16 vs A", state: { handClass: "hard", playerTotal: 16, dealerUpcardValue: 11 } },
  { label: "15 vs 10", state: { handClass: "hard", playerTotal: 15, dealerUpcardValue: 10 } },
  { label: "15 vs A", state: { handClass: "hard", playerTotal: 15, dealerUpcardValue: 11 } },
  { label: "11 vs A", state: { handClass: "hard", playerTotal: 11, dealerUpcardValue: 11 } },
  { label: "12 vs 4", state: { handClass: "hard", playerTotal: 12, dealerUpcardValue: 4 } },
  { label: "A,7 vs 9", state: { handClass: "soft", playerTotal: 18, dealerUpcardValue: 9 } },
  { label: "A,8 vs 6", state: { handClass: "soft", playerTotal: 19, dealerUpcardValue: 6 } },
  {
    label: "8,8 vs 10",
    state: { handClass: "pair", playerTotal: 16, pairValue: 8, dealerUpcardValue: 10 },
  },
];

// ===========================================================================
// Report rendering
// ===========================================================================

const CELL_LABEL: Readonly<Record<string, string>> = {
  HIT: "H",
  STAND: "S",
  "DOUBLE/HIT": "Dh",
  "DOUBLE/STAND": "Ds",
  "SURRENDER/HIT": "Rh",
  "SURRENDER/STAND": "Rs",
  "SPLIT/HIT": "Ph",
  "SPLIT/STAND": "Ps",
  SPLIT: "P",
  DOUBLE: "D",
  SURRENDER: "R",
};

function cellLabel(row: RowResult): string {
  const composite =
    row.fallbackAction !== undefined
      ? `${row.recommendedAction}/${row.fallbackAction}`
      : row.recommendedAction;
  return CELL_LABEL[composite] ?? composite;
}

const ACTION_WORD: Readonly<Record<StrategyAction, string>> = {
  HIT: "hit",
  STAND: "stand",
  DOUBLE: "double",
  SPLIT: "split",
  SURRENDER: "surrender",
};

function pairStateFor(pairValue: number, dealerUpcardValue: number): StrategyState {
  return {
    handClass: "pair",
    playerTotal: pairTotal(pairValue),
    pairValue,
    dealerUpcardValue,
  };
}

/**
 * How a pair that cannot be split actually resolves, read out of the solved
 * chart rather than asserted in prose — the report must describe the advisor
 * that shipped, not the one the writer remembered.
 */
function describePairFallback(chart: Chart, pairValue: number, dealerUpcardValue: number): string {
  const pair = pairStateFor(pairValue, dealerUpcardValue);
  const pairRow = chart.byKey.get(normalizeStrategyKey(pair));
  const totalState = totalRowStateForPair(pair);
  const totalRow =
    totalState === null ? undefined : chart.byKey.get(normalizeStrategyKey(totalState));
  if (pairRow === undefined || totalState === null || totalRow === undefined) {
    throw new Error(`Cannot describe the pair fallback for ${normalizeStrategyKey(pair)}`);
  }

  const upcard = describeUpcardLabel(dealerUpcardValue);
  const totalLabel = describeStrategyStateLabel(totalState).toLowerCase();
  const primary = ACTION_WORD[totalRow.recommendedAction];
  const secondary =
    totalRow.fallbackAction === undefined ? undefined : ACTION_WORD[totalRow.fallbackAction];

  return (
    `\`${describeStrategyStateLabel(pair)}\` vs ${upcard} shows \`${cellLabel(pairRow)}\`, but a player ` +
    `who cannot split is served the ${totalLabel} vs ${upcard} cell (\`${cellLabel(totalRow)}\`) — ` +
    `${primary}${secondary === undefined ? "" : `, or ${secondary} when ${primary} is unavailable too`}`
  );
}

function renderChartTable(chart: Chart, handClass: HandClass): string {
  const rows = CANONICAL_SIX_DECK_S17_DAS_LS.filter((row) => row.handClass === handClass);
  const header = `| ${handClass === "pair" ? "Pair" : "Total"} | ${DEALER_UPCARD_VALUES.map(
    describeUpcardLabel,
  ).join(" | ")} |`;
  const divider = `|---|${DEALER_UPCARD_VALUES.map(() => "---").join("|")}|`;
  const lines = [header, divider];

  for (const row of rows) {
    const cells = DEALER_UPCARD_VALUES.map((upcardValue) => {
      const solved = chart.byKey.get(normalizeStrategyKey(stateForCanonicalRow(row, upcardValue)));
      return solved === undefined ? "?" : cellLabel(solved);
    });
    lines.push(`| ${row.label} | ${cells.join(" | ")} |`);
  }

  return lines.join("\n");
}

function fmt(value: number | undefined): string {
  if (value === undefined || Number.isNaN(value)) return "—";
  return value.toFixed(5);
}

function signed(value: number): string {
  return `${value >= 0 ? "+" : ""}${value.toFixed(5)}`;
}

function renderDisagreementTable(rows: readonly Disagreement[]): string[] {
  const out: string[] = [];
  out.push(
    "| Hand | Dealer | Computed | Reference | Margin | Stand | Hit | Double | Split | Surrender |",
  );
  out.push("|---|---|---|---|---|---|---|---|---|---|");
  for (const d of rows) {
    const computed = d.computedFallback !== undefined ? `${d.computed}/${d.computedFallback}` : d.computed;
    const reference =
      d.canonicalFallback !== undefined ? `${d.canonical}/${d.canonicalFallback}` : d.canonical;
    out.push(
      `| ${d.rowLabel} | ${d.upcardLabel} | ${computed} | ${reference} | ${signed(d.margin)} | ` +
        `${fmt(d.evs.STAND)} | ${fmt(d.evs.HIT)} | ${fmt(d.evs.DOUBLE)} | ${fmt(d.evs.SPLIT)} | ` +
        `${fmt(d.evs.SURRENDER)} |`,
    );
  }
  return out;
}

function renderValidationReport(
  chart: Chart,
  rules: BlackjackRules,
  disagreements: readonly Disagreement[],
  expectedValuePerUnit: number,
  generatedAt: string,
): string {
  const out: string[] = [];

  out.push("# Arc 21 — Strategy Cross-Validation");
  out.push("");
  out.push("**GENERATED FILE — regenerate with `npx tsx scripts/generate-strategy-tables.ts`.**");
  out.push("");
  out.push(`Ruleset \`${rules.id}@${rules.version}\` · generated ${generatedAt}`);
  out.push("");
  out.push(
    "The chart Arc 21 serves is computed by an expected-value solver, not copied from a published chart. " +
      "This document is the independent check: it compares every cell of the computed chart against the " +
      "widely published six-deck / S17 / DAS / late-surrender basic strategy chart and lists **every** " +
      "disagreement, with the solver's own EV numbers for that cell.",
  );
  out.push("");
  out.push(
    "Disagreements are reported, never reconciled. The solver is not tuned to match the published chart, " +
      "and a disagreement is not quietly accepted either — every one below is for a human to adjudicate.",
  );
  out.push("");

  out.push("## Method");
  out.push("");
  out.push("- Six-deck composition with exact card removal. **No infinite-deck approximation anywhere.**");
  out.push(
    "- Dealer final-total distribution by exact recursion honouring S17, conditioned on the peek finding " +
      "no natural — a ten upcard cannot hold an ace beneath it, an ace upcard cannot hold a ten, and the " +
      "surviving hole cards are renormalised.",
  );
  out.push("- Player draws recurse with card removal and optimal continuation at every step.");
  out.push(
    "- Split EV uses a pending-hand recursion that tracks the hand count exactly, so the four-hand cap " +
      "binds where it really binds; DAS per ruleset; split aces take one card and stand, and a resulting " +
      "21 pays 1:1 rather than 3:2.",
  );
  out.push("- Surrender is exactly -0.5.");
  out.push(
    "- Every EV is per unit of the **original** wager and is conditional on the dealer not holding a " +
      "natural — the only state in which a decision is ever offered.",
  );
  out.push("");
  out.push("### Approximations");
  out.push("");
  for (const note of SOLVER_APPROXIMATIONS) {
    out.push(`- ${note}`);
  }
  out.push("");
  out.push("### End-to-end sanity signal");
  out.push("");
  out.push(
    `Playing this chart from the top of the shoe with insurance always declined returns ` +
      `**${(expectedValuePerUnit * 100).toFixed(4)}%** per unit wagered — a house edge of ` +
      `**${(-expectedValuePerUnit * 100).toFixed(4)}%**. Published analyses of a six-deck, S17, DAS, ` +
      "late-surrender, 3:2 game without resplit aces land in the same neighbourhood. A structural error " +
      "in the dealer distribution, the peek conditioning or the split model would move this figure well " +
      "before it moved a single chart cell, so it is the cheapest place to notice one.",
  );
  out.push("");

  out.push("## Computed chart");
  out.push("");
  out.push(
    "`H` hit · `S` stand · `Dh` double else hit · `Ds` double else stand · `Rh` surrender else hit · " +
      "`Rs` surrender else stand · `P` split · `Ph` split else hit · `Ps` split else stand — standard " +
      "chart notation, which is what makes the comparison with the published chart meaningful.",
  );
  out.push("");
  out.push(
    "The \"else\" action is not decoration: it is `fallbackAction` in the generated table. On a **hard or " +
      "soft** row it is exactly what the advisor serves when the primary action is not legal — a third " +
      "card, a stack too short to double, a hand that came from a split.",
  );
  out.push("");
  out.push(
    "**The pair rows are not read that way, and the `h`/`s` suffix on a `P` cell is not what a player who " +
      "cannot split is told.** A pair that cannot be split is no longer a pair, it is a total, so the " +
      "advisor re-reads the matching hard or soft row — twice the card value, or soft 12 for aces — and " +
      "serves that solved cell instead. The pair cell's own `fallbackAction` is the last resort, reached " +
      "only when the total row cannot produce a legal action either.",
  );
  out.push("");
  out.push(`- ${describePairFallback(chart, 8, 10)}.`);
  out.push(`- ${describePairFallback(chart, 11, 6)}.`);
  out.push(
    "- The total row answers all the way down: `8,8` vs 10 with surrender unavailable as well resolves " +
      "to the hard-16 row's *own* else, hit. The pair cell's `fallbackAction` is reached only if the " +
      "total row yields nothing legal at all, which cannot happen while hit and stand are on the table.",
  );
  out.push("");
  out.push("### Hard totals");
  out.push("");
  out.push(renderChartTable(chart, "hard"));
  out.push("");
  out.push("### Soft totals");
  out.push("");
  out.push(renderChartTable(chart, "soft"));
  out.push("");
  out.push("### Pairs");
  out.push("");
  out.push(renderChartTable(chart, "pair"));
  out.push("");

  out.push("## Disagreements with the published chart");
  out.push("");
  out.push(`Reference: ${CANONICAL_CHART_SOURCE}.`);
  out.push("");

  const published = disagreements.filter((d) => !d.extrapolatedReference);
  const publishedPrimary = published.filter((d) => !d.fallbackOnly);
  const publishedFallbackOnly = published.filter((d) => d.fallbackOnly);
  const extrapolated = disagreements.filter((d) => d.extrapolatedReference);

  out.push(
    "`Margin` is the solver's EV for its own choice minus its EV for the reference choice. A margin near " +
      "zero means the two plays are all but equivalent and the disagreement is a rounding-level call; a " +
      "large margin means something structural differs and must be investigated before the chart ships.",
  );
  out.push("");

  out.push("### Primary action");
  out.push("");
  if (publishedPrimary.length === 0) {
    out.push(
      `**No disagreements.** All ${countPublishedCells()} published cells — including every cell flagged ` +
        "below as genuinely borderline — match the computed chart's primary action.",
    );
  } else {
    out.push(
      `**${publishedPrimary.length} published cell${publishedPrimary.length === 1 ? "" : "s"} disagree.**`,
    );
    out.push("");
    out.push(...renderDisagreementTable(publishedPrimary));
  }
  out.push("");

  out.push("### Fallback (\"else\") action");
  out.push("");
  if (publishedFallbackOnly.length === 0) {
    out.push(
      "None. Every `Dh` / `Ds` / `Rh` / `Rs` cell resolves to the same secondary action as the published chart.",
    );
  } else {
    out.push(...renderDisagreementTable(publishedFallbackOnly));
  }
  out.push("");

  out.push("### Rows with no published reference");
  out.push("");
  out.push(
    "Hard 4 and soft 12 appear in no published chart, because a two-card 4 or soft 12 is always a pair " +
      "and the pair row answers first. Arc 21 solves them anyway so that \"you hold 2,2 or A,A but cannot " +
      "split\" resolves through a computed cell instead of an invented default. The reference values for " +
      "these rows are an extrapolation by this repository, so a disagreement here is a disagreement with " +
      "an assumption, not with the literature.",
  );
  out.push("");
  if (extrapolated.length === 0) {
    out.push("No differences.");
  } else {
    out.push(...renderDisagreementTable(extrapolated));
  }
  out.push("");

  out.push("## Cells that deserve explicit attention");
  out.push("");
  out.push(
    "These are the cells where basic strategy is genuinely close and where solvers legitimately differ. " +
      "`Margin` here is the gap between the best and second-best action — how much the call is actually worth.",
  );
  out.push("");
  out.push("| Cell | Best | EV | Runner-up | EV | Margin | All EVs |");
  out.push("|---|---|---|---|---|---|---|");
  for (const watched of WATCHED_CELLS) {
    const solved = chart.byKey.get(normalizeStrategyKey(watched.state));
    if (solved === undefined) continue;
    const first = solved.ranked[0];
    const second = solved.ranked[1];
    if (first === undefined || second === undefined) continue;
    const all = solved.ranked.map((entry) => `${entry.action} ${entry.ev.toFixed(5)}`).join("; ");
    out.push(
      `| ${watched.label} | ${first.action} | ${first.ev.toFixed(5)} | ${second.action} | ` +
        `${second.ev.toFixed(5)} | ${(first.ev - second.ev).toFixed(5)} | ${all} |`,
    );
  }
  out.push("");

  out.push("## How to read a margin");
  out.push("");
  out.push(
    "A margin below roughly `0.002` per unit sits inside the combined uncertainty of the approximations " +
      "listed above and of whatever composition basis the reference chart used. Such a cell is a genuine " +
      "coin flip: either play costs a fraction of a percent of one bet, and a difference there is not " +
      "evidence that anything is wrong. A margin above that is substantive and should be chased down in " +
      "the solver rather than absorbed.",
  );
  out.push("");

  return out.join("\n");
}

function countPublishedCells(): number {
  return CANONICAL_SIX_DECK_S17_DAS_LS.filter((row) => row.published !== false).length * 10;
}

// ===========================================================================
// Entry point
// ===========================================================================

function findRepoRoot(start: string): string {
  let current = resolve(start);
  for (;;) {
    if (existsSync(join(current, "package.json"))) return current;
    const parent = dirname(current);
    if (parent === current) {
      throw new Error(`Could not locate the repository root above ${start}`);
    }
    current = parent;
  }
}

function main(): void {
  const rules = ARC_STANDARD_RULES;
  const startedAt = Date.now();

  process.stdout.write(`Solving ${rules.id}@${rules.version} (${rules.deckCount} decks)…\n`);
  const chart = solveChart(rules);
  process.stdout.write(`  ${chart.rows.length} cells solved in ${Date.now() - startedAt} ms\n`);

  const expectedValuePerUnit = overallExpectation(chart, rules);
  process.stdout.write(
    `  expectation playing this chart: ${(expectedValuePerUnit * 100).toFixed(4)}% per unit ` +
      `(house edge ${(-expectedValuePerUnit * 100).toFixed(4)}%)\n`,
  );

  const disagreements = crossValidate(chart);
  const published = disagreements.filter((d) => !d.extrapolatedReference);
  const publishedPrimary = published.filter((d) => !d.fallbackOnly);
  process.stdout.write(
    `  cross-validation: ${publishedPrimary.length} published-cell primary disagreement(s), ` +
      `${published.length - publishedPrimary.length} fallback-only, ` +
      `${disagreements.length - published.length} in rows with no published reference\n`,
  );
  for (const d of disagreements) {
    process.stdout.write(
      `    ${d.rowLabel} vs ${d.upcardLabel}: computed ${d.computed}, reference ${d.canonical}, ` +
        `margin ${signed(d.margin)}${d.extrapolatedReference ? " (extrapolated reference)" : ""}\n`,
    );
  }

  const repoRoot = findRepoRoot(process.cwd());
  const generatedAt = new Date().toISOString();

  const tablePath = join(repoRoot, "supabase", "functions", "_shared", "strategy", "generated-arc-standard-v1.ts");
  mkdirSync(dirname(tablePath), { recursive: true });
  writeFileSync(tablePath, emitTableSource(chart, rules, expectedValuePerUnit, generatedAt), "utf8");
  process.stdout.write(`  wrote ${tablePath}\n`);

  const reportPath = join(repoRoot, "docs", "STRATEGY_VALIDATION.md");
  mkdirSync(dirname(reportPath), { recursive: true });
  writeFileSync(
    reportPath,
    renderValidationReport(chart, rules, disagreements, expectedValuePerUnit, generatedAt),
    "utf8",
  );
  process.stdout.write(`  wrote ${reportPath}\n`);
  process.stdout.write(`Done in ${Date.now() - startedAt} ms\n`);
}

main();
