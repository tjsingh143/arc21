/**
 * Arc 21 — the published basic strategy chart, for CROSS-VALIDATION ONLY.
 *
 * ===========================================================================
 * THIS IS NOT THE STRATEGY ARC 21 SERVES.
 * ===========================================================================
 *
 * The chart the product uses is computed from first principles by
 * `scripts/generate-strategy-tables.ts` and lives in
 * `supabase/functions/_shared/strategy/`. Nothing in this file is ever loaded by the app,
 * the server or the advisor — `shared/` does not import it and cannot.
 *
 * What this file is: the widely published six-deck / dealer-stands-on-all-17 /
 * double-after-split / late-surrender chart, transcribed so the solver's output
 * can be checked against an independent reference. Its only consumers are the
 * generator's validation report and `tests/strategy/cross-validation.test.ts`.
 *
 * The check is deliberately one-directional. Disagreements are reported with
 * the solver's EV numbers so a human can adjudicate. The solver is never edited
 * to make a cell match, and a disagreement is never silently accepted either.
 *
 * Two rows here — hard 4 and soft 12 — do not appear in any published chart,
 * because a two-card 4 or soft 12 is always a pair and the pair row answers
 * first. They are included as `H` throughout, which is not a judgement call:
 * a soft 12 cannot bust, and a hard 4 cannot be improved by standing.
 */

import type { HandClass, StrategyAction } from "../supabase/functions/_shared/strategy/types.js";

/**
 * Standard chart notation.
 *   H  hit                      S   stand
 *   Dh double, else hit         Ds  double, else stand
 *   Rh surrender, else hit      Rs  surrender, else stand
 *   P  split                    Ph  split, else hit
 */
export type CanonicalCell = "H" | "S" | "Dh" | "Ds" | "Rh" | "Rs" | "P" | "Ph";

export interface CanonicalRow {
  handClass: HandClass;
  label: string;
  /** Best total, matching `StrategyState.playerTotal`. */
  total: number;
  /** Card value of each card of the pair; aces are 11. */
  pairValue?: number;
  /** Dealer 2,3,4,5,6,7,8,9,10,A — ten cells, in that order. */
  cells: readonly CanonicalCell[];
  /**
   * False for rows that appear in no published chart and are therefore this
   * repository's own extrapolation. A disagreement on such a row is a
   * disagreement with an assumption, not with the literature, and the report
   * says so rather than inflating the headline count.
   */
  published?: boolean;
}

export const CANONICAL_CHART_SOURCE =
  "the widely published six-deck, dealer-stands-on-all-17, double-after-split, " +
  "late-surrender basic strategy chart (Wizard of Odds / Blackjack Apprenticeship lineage)";

export function canonicalCellToActions(cell: CanonicalCell): {
  action: StrategyAction;
  fallback?: StrategyAction;
} {
  switch (cell) {
    case "H":
      return { action: "HIT" };
    case "S":
      return { action: "STAND" };
    case "Dh":
      return { action: "DOUBLE", fallback: "HIT" };
    case "Ds":
      return { action: "DOUBLE", fallback: "STAND" };
    case "Rh":
      return { action: "SURRENDER", fallback: "HIT" };
    case "Rs":
      return { action: "SURRENDER", fallback: "STAND" };
    case "P":
      return { action: "SPLIT" };
    case "Ph":
      return { action: "SPLIT", fallback: "HIT" };
  }
}

// Dealer upcard order for every row below: 2 3 4 5 6 7 8 9 10 A
export const CANONICAL_SIX_DECK_S17_DAS_LS: readonly CanonicalRow[] = [
  // --- Hard totals -------------------------------------------------------
  { handClass: "hard", label: "4", total: 4, published: false, cells: ["H", "H", "H", "H", "H", "H", "H", "H", "H", "H"] },
  { handClass: "hard", label: "5", total: 5, cells: ["H", "H", "H", "H", "H", "H", "H", "H", "H", "H"] },
  { handClass: "hard", label: "6", total: 6, cells: ["H", "H", "H", "H", "H", "H", "H", "H", "H", "H"] },
  { handClass: "hard", label: "7", total: 7, cells: ["H", "H", "H", "H", "H", "H", "H", "H", "H", "H"] },
  { handClass: "hard", label: "8", total: 8, cells: ["H", "H", "H", "H", "H", "H", "H", "H", "H", "H"] },
  { handClass: "hard", label: "9", total: 9, cells: ["H", "Dh", "Dh", "Dh", "Dh", "H", "H", "H", "H", "H"] },
  { handClass: "hard", label: "10", total: 10, cells: ["Dh", "Dh", "Dh", "Dh", "Dh", "Dh", "Dh", "Dh", "H", "H"] },
  { handClass: "hard", label: "11", total: 11, cells: ["Dh", "Dh", "Dh", "Dh", "Dh", "Dh", "Dh", "Dh", "Dh", "H"] },
  { handClass: "hard", label: "12", total: 12, cells: ["H", "H", "S", "S", "S", "H", "H", "H", "H", "H"] },
  { handClass: "hard", label: "13", total: 13, cells: ["S", "S", "S", "S", "S", "H", "H", "H", "H", "H"] },
  { handClass: "hard", label: "14", total: 14, cells: ["S", "S", "S", "S", "S", "H", "H", "H", "H", "H"] },
  { handClass: "hard", label: "15", total: 15, cells: ["S", "S", "S", "S", "S", "H", "H", "H", "Rh", "H"] },
  { handClass: "hard", label: "16", total: 16, cells: ["S", "S", "S", "S", "S", "H", "H", "Rh", "Rh", "Rh"] },
  { handClass: "hard", label: "17", total: 17, cells: ["S", "S", "S", "S", "S", "S", "S", "S", "S", "S"] },
  { handClass: "hard", label: "18", total: 18, cells: ["S", "S", "S", "S", "S", "S", "S", "S", "S", "S"] },
  { handClass: "hard", label: "19", total: 19, cells: ["S", "S", "S", "S", "S", "S", "S", "S", "S", "S"] },
  { handClass: "hard", label: "20", total: 20, cells: ["S", "S", "S", "S", "S", "S", "S", "S", "S", "S"] },
  { handClass: "hard", label: "21", total: 21, cells: ["S", "S", "S", "S", "S", "S", "S", "S", "S", "S"] },

  // --- Soft totals -------------------------------------------------------
  { handClass: "soft", label: "12 (A,A)", total: 12, published: false, cells: ["H", "H", "H", "H", "H", "H", "H", "H", "H", "H"] },
  { handClass: "soft", label: "13 (A,2)", total: 13, cells: ["H", "H", "H", "Dh", "Dh", "H", "H", "H", "H", "H"] },
  { handClass: "soft", label: "14 (A,3)", total: 14, cells: ["H", "H", "H", "Dh", "Dh", "H", "H", "H", "H", "H"] },
  { handClass: "soft", label: "15 (A,4)", total: 15, cells: ["H", "H", "Dh", "Dh", "Dh", "H", "H", "H", "H", "H"] },
  { handClass: "soft", label: "16 (A,5)", total: 16, cells: ["H", "H", "Dh", "Dh", "Dh", "H", "H", "H", "H", "H"] },
  { handClass: "soft", label: "17 (A,6)", total: 17, cells: ["H", "Dh", "Dh", "Dh", "Dh", "H", "H", "H", "H", "H"] },
  { handClass: "soft", label: "18 (A,7)", total: 18, cells: ["S", "Ds", "Ds", "Ds", "Ds", "S", "S", "H", "H", "H"] },
  { handClass: "soft", label: "19 (A,8)", total: 19, cells: ["S", "S", "S", "S", "S", "S", "S", "S", "S", "S"] },
  { handClass: "soft", label: "20 (A,9)", total: 20, cells: ["S", "S", "S", "S", "S", "S", "S", "S", "S", "S"] },
  { handClass: "soft", label: "21", total: 21, cells: ["S", "S", "S", "S", "S", "S", "S", "S", "S", "S"] },

  // --- Pairs -------------------------------------------------------------
  { handClass: "pair", label: "2,2", total: 4, pairValue: 2, cells: ["P", "P", "P", "P", "P", "P", "H", "H", "H", "H"] },
  { handClass: "pair", label: "3,3", total: 6, pairValue: 3, cells: ["P", "P", "P", "P", "P", "P", "H", "H", "H", "H"] },
  { handClass: "pair", label: "4,4", total: 8, pairValue: 4, cells: ["H", "H", "H", "P", "P", "H", "H", "H", "H", "H"] },
  { handClass: "pair", label: "5,5", total: 10, pairValue: 5, cells: ["Dh", "Dh", "Dh", "Dh", "Dh", "Dh", "Dh", "Dh", "H", "H"] },
  { handClass: "pair", label: "6,6", total: 12, pairValue: 6, cells: ["P", "P", "P", "P", "P", "H", "H", "H", "H", "H"] },
  { handClass: "pair", label: "7,7", total: 14, pairValue: 7, cells: ["P", "P", "P", "P", "P", "P", "H", "H", "H", "H"] },
  { handClass: "pair", label: "8,8", total: 16, pairValue: 8, cells: ["P", "P", "P", "P", "P", "P", "P", "P", "P", "P"] },
  { handClass: "pair", label: "9,9", total: 18, pairValue: 9, cells: ["P", "P", "P", "P", "P", "S", "P", "P", "S", "S"] },
  { handClass: "pair", label: "10,10", total: 20, pairValue: 10, cells: ["S", "S", "S", "S", "S", "S", "S", "S", "S", "S"] },
  { handClass: "pair", label: "A,A", total: 12, pairValue: 11, cells: ["P", "P", "P", "P", "P", "P", "P", "P", "P", "P"] },
];
