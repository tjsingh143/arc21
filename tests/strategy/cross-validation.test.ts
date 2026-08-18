/**
 * Cross-validation of the computed chart against the published one.
 *
 * The point of this suite is *not* to make the solver agree with the published
 * chart. It is to make any disagreement impossible to ship silently. Every
 * difference must be listed below with a note explaining the adjudication; a
 * new one fails the build, and so does a listed one that quietly goes away
 * (which would mean the note is now lying about the solver).
 *
 * The reference chart lives in `scripts/canonical-basic-strategy.ts` and is
 * never imported by anything under `shared/` — the product serves computed
 * advice only.
 *
 * The human-readable version of this comparison, with every EV, is
 * `docs/STRATEGY_VALIDATION.md`.
 */

import { describe, expect, it } from "vitest";

import {
  CANONICAL_SIX_DECK_S17_DAS_LS,
  canonicalCellToActions,
} from "../../scripts/canonical-basic-strategy.js";
import { ARC_STANDARD_STRATEGY_TABLE } from "../../supabase/functions/_shared/strategy/generated-arc-standard-v1.js";
import { DEALER_UPCARD_VALUES, normalizeStrategyKey } from "../../supabase/functions/_shared/strategy/keys.js";
import type { StrategyAction, StrategyState } from "../../supabase/functions/_shared/strategy/types.js";

const table = ARC_STANDARD_STRATEGY_TABLE;

interface Difference {
  key: string;
  computed: StrategyAction;
  reference: StrategyAction;
  published: boolean;
}

function stateFor(
  row: (typeof CANONICAL_SIX_DECK_S17_DAS_LS)[number],
  dealerUpcardValue: number,
): StrategyState {
  if (row.handClass === "pair") {
    return {
      handClass: "pair",
      playerTotal: row.total,
      pairValue: row.pairValue,
      dealerUpcardValue,
    };
  }
  return { handClass: row.handClass, playerTotal: row.total, dealerUpcardValue };
}

function compare(): { primary: Difference[]; fallback: Difference[]; cells: number } {
  const primary: Difference[] = [];
  const fallback: Difference[] = [];
  let cells = 0;

  for (const row of CANONICAL_SIX_DECK_S17_DAS_LS) {
    DEALER_UPCARD_VALUES.forEach((dealerUpcardValue, index) => {
      const cell = row.cells[index];
      if (cell === undefined) return;
      cells++;

      const key = normalizeStrategyKey(stateFor(row, dealerUpcardValue));
      const decision = table.entries[key];
      if (decision === undefined) {
        throw new Error(`The reference chart names a cell the table does not have: ${key}`);
      }

      const reference = canonicalCellToActions(cell);
      const published = row.published !== false;

      if (decision.recommendedAction !== reference.action) {
        primary.push({
          key,
          computed: decision.recommendedAction,
          reference: reference.action,
          published,
        });
      } else if (
        reference.fallback !== undefined &&
        decision.fallbackAction !== undefined &&
        decision.fallbackAction !== reference.fallback
      ) {
        fallback.push({
          key,
          computed: decision.fallbackAction,
          reference: reference.fallback,
          published,
        });
      }
    });
  }

  return { primary, fallback, cells };
}

/**
 * Every adjudicated difference between the solver and the reference chart.
 *
 * Adding an entry here is a deliberate act that requires a reason. The solver
 * is never edited to make a cell match, and a cell is never removed from the
 * comparison to make the suite pass.
 */
const ADJUDICATED_DIFFERENCES: ReadonlyArray<{
  key: string;
  computed: StrategyAction;
  reference: StrategyAction;
  note: string;
}> = [
  {
    key: "soft:12:6",
    computed: "DOUBLE",
    reference: "HIT",
    note:
      "Soft 12 is A,A, which appears in no published chart because the pair row always answers " +
      "first — the reference value here is this repository's own extrapolation, not the " +
      "literature. The cell is only ever reached when A,A cannot be split (a fourth hand is " +
      "already open, or the stack cannot cover a second wager), and the solver prices double at " +
      "0.18997 against hit at 0.18825: a margin of 0.0017, inside the noise of the documented " +
      "approximations. Doubling is also the published call on the adjacent soft 13 vs 6, so the " +
      "computed answer is continuous with the chart rather than an outlier. Whenever DOUBLE is " +
      "not legal — which is most of the time this cell comes up at all — the fallback serves HIT, " +
      "matching the reference exactly.",
  },
];

describe("computed chart vs the published chart", () => {
  const { primary, fallback, cells } = compare();

  it("compares every cell of the reference chart", () => {
    expect(cells).toBe(CANONICAL_SIX_DECK_S17_DAS_LS.length * DEALER_UPCARD_VALUES.length);
    expect(cells).toBe(380);
  });

  it("agrees with every published cell on the primary action", () => {
    const publishedDifferences = primary.filter((difference) => difference.published);
    expect(
      publishedDifferences,
      "The solver disagrees with the published chart on a cell that has not been adjudicated. " +
        "Do not edit the solver to match, and do not add it to ADJUDICATED_DIFFERENCES without " +
        "reading docs/STRATEGY_VALIDATION.md for the EVs first.",
    ).toEqual([]);
  });

  it("agrees with every published cell on the fallback action", () => {
    expect(fallback.filter((difference) => difference.published)).toEqual([]);
  });

  it("has exactly the differences that have been adjudicated, no more and no fewer", () => {
    const actual = [...primary, ...fallback]
      .map(({ key, computed, reference }) => ({ key, computed, reference }))
      .sort((a, b) => a.key.localeCompare(b.key));

    const expected = ADJUDICATED_DIFFERENCES.map(({ key, computed, reference }) => ({
      key,
      computed,
      reference,
    })).sort((a, b) => a.key.localeCompare(b.key));

    expect(actual).toEqual(expected);
  });

  it("keeps a written adjudication for each difference", () => {
    for (const difference of ADJUDICATED_DIFFERENCES) {
      expect(difference.note.length).toBeGreaterThan(80);
    }
  });
});

describe("cells that are genuinely borderline", () => {
  /**
   * The cells named in the specification as deserving explicit attention. Each
   * is asserted against the reference chart *and* has its EV margin printed
   * into docs/STRATEGY_VALIDATION.md, because "we agree" is only meaningful
   * alongside "by how much".
   */
  const WATCHED: ReadonlyArray<{ label: string; key: string; expected: StrategyAction }> = [
    { label: "16 vs 10", key: "hard:16:10", expected: "SURRENDER" },
    { label: "16 vs 9", key: "hard:16:9", expected: "SURRENDER" },
    { label: "16 vs A", key: "hard:16:11", expected: "SURRENDER" },
    { label: "15 vs 10", key: "hard:15:10", expected: "SURRENDER" },
    { label: "15 vs A", key: "hard:15:11", expected: "HIT" },
    { label: "11 vs A", key: "hard:11:11", expected: "HIT" },
    { label: "12 vs 4", key: "hard:12:4", expected: "STAND" },
    { label: "A,7 vs 9", key: "soft:18:9", expected: "HIT" },
    { label: "A,8 vs 6", key: "soft:19:6", expected: "STAND" },
    { label: "8,8 vs 10", key: "pair:8:10", expected: "SPLIT" },
  ];

  it("resolves each one the way the published S17 chart does", () => {
    for (const cell of WATCHED) {
      const decision = table.entries[cell.key];
      expect(decision, `${cell.label} (${cell.key}) missing`).toBeDefined();
      expect(decision?.recommendedAction, cell.label).toBe(cell.expected);
    }
  });

  it("wins each one on EV, not on a tie-break", () => {
    for (const cell of WATCHED) {
      const evs = table.entries[cell.key]?.evs;
      expect(evs).toBeDefined();
      if (evs === undefined) continue;

      const chosen = evs[cell.expected];
      expect(chosen).toBeDefined();
      if (chosen === undefined) continue;

      const runnerUp = Object.entries(evs)
        .filter(([action]) => action !== cell.expected)
        .reduce((best, [, ev]) => (ev > best ? ev : best), -Infinity);

      expect(chosen, `${cell.label}: chose ${cell.expected} at ${chosen}`).toBeGreaterThan(runnerUp);
    }
  });

  it("shows a positive but thin margin, which is why they are watched", () => {
    // If any of these ever opened up a wide margin, the solver changed in a way
    // that deserves a look — these cells are close by nature.
    for (const cell of WATCHED) {
      const evs = table.entries[cell.key]?.evs;
      if (evs === undefined) continue;
      const chosen = evs[cell.expected] ?? 0;
      const runnerUp = Object.entries(evs)
        .filter(([action]) => action !== cell.expected)
        .reduce((best, [, ev]) => (ev > best ? ev : best), -Infinity);
      expect(chosen - runnerUp, cell.label).toBeLessThan(0.1);
    }
  });
});
