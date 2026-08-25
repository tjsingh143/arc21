/**
 * The Strategy Guide's chart projection.
 *
 * This is the test that catches a chart drifting from the engine. The guide is
 * not allowed to be a second opinion: for every coordinate it renders, the
 * letter in the cell must be the action `adviseAction` would give a player
 * holding that hand at the table. If someone ever "fixes" a cell by hand, or the
 * solver is regenerated and a cell moves, this fails rather than teaching two
 * different strategies in the same app.
 */

import { describe, expect, it } from "vitest";

import { ARC_STANDARD_RULES } from "../../shared/blackjack/rules.js";
import {
  adviseAction,
  ARC_STANDARD_STRATEGY_TABLE,
  normalizeStrategyKey,
  strategyRulesSummary,
  type StrategyAction,
} from "../../shared/strategy/index.js";
import {
  buildStrategyChart,
  CHART_LEGEND,
  CHART_TABS,
  CHART_UPCARDS,
  chartCodeForAction,
  chartRowLabel,
  chartRowValues,
  chartRulesetDetail,
  chartRulesetLine,
  chartState,
  describeChartCell,
  parseChartTab,
  rulesetDisplayName,
  type ChartCode,
} from "../../src/features/learn/strategy-chart.js";
import { buildDrillQuestions } from "../../src/features/learn/drill-questions.js";

const ALL_ACTIONS: StrategyAction[] = ["HIT", "STAND", "DOUBLE", "SPLIT", "SURRENDER"];

/** The letter a code stands for, as an action. Inverse of `chartCodeForAction`. */
const ACTION_FOR_CODE: Readonly<Record<ChartCode, StrategyAction>> = {
  H: "HIT",
  S: "STAND",
  D: "DOUBLE",
  P: "SPLIT",
  R: "SURRENDER",
};

describe("the chart renders what the advisor advises", () => {
  it("agrees with adviseAction on every cell of every tab", () => {
    let checked = 0;

    for (const tab of CHART_TABS) {
      const chart = buildStrategyChart(ARC_STANDARD_STRATEGY_TABLE, tab.id);

      for (const row of chart.rows) {
        for (const cell of row.cells) {
          expect(cell).not.toBeNull();
          if (!cell) continue;

          const recommendation = adviseAction({
            rules: ARC_STANDARD_RULES,
            state: cell.state,
            legalActions: ALL_ACTIONS,
          });

          expect(recommendation).not.toBeNull();
          expect(cell.action).toBe(recommendation?.action);
          expect(ACTION_FOR_CODE[cell.code]).toBe(recommendation?.action);
          checked++;
        }
      }
    }

    // Every solved cell was actually visited; a chart that quietly rendered half
    // the table would otherwise pass the assertions above.
    expect(checked).toBe(ARC_STANDARD_STRATEGY_TABLE.metadata.entryCount);
  });

  it("addresses the same key the advisor would derive from the state", () => {
    for (const tab of CHART_TABS) {
      for (const row of buildStrategyChart(ARC_STANDARD_STRATEGY_TABLE, tab.id).rows) {
        for (const cell of row.cells) {
          if (!cell) continue;
          expect(cell.key).toBe(normalizeStrategyKey(cell.state));
          expect(cell.decision.key).toBe(cell.key);
        }
      }
    }
  });

  it("shows the same play a drill on the same hand would mark correct", () => {
    // Two independent paths reach a cell: the chart builds a state from a row
    // and column, the drill derives one from real cards. They must land on the
    // same advice or the guide and the drills would disagree.
    const cells = new Map(
      CHART_TABS.flatMap((tab) =>
        buildStrategyChart(ARC_STANDARD_STRATEGY_TABLE, tab.id).rows.flatMap((row) =>
          row.cells.filter((cell) => cell !== null).map((cell) => [cell.key, cell] as const),
        ),
      ),
    );

    for (const question of buildDrillQuestions()) {
      const cell = cells.get(question.key);
      expect(cell).toBeDefined();
      // The drill's answer is resolved against its own legal actions, so on a
      // pair row where SPLIT is the chart's answer it must also be the drill's.
      if (cell && question.actions.includes(cell.action)) {
        expect(question.answer).toBe(cell.action);
      }
    }
  });
});

describe("rows and columns come from the table, not from a hand-written list", () => {
  it("uses the ten chart columns, 2 through 10 then ace", () => {
    expect(CHART_UPCARDS.map((upcard) => upcard.label)).toEqual([
      "2",
      "3",
      "4",
      "5",
      "6",
      "7",
      "8",
      "9",
      "10",
      "A",
    ]);
  });

  it("derives rows from the entries actually solved", () => {
    expect(chartRowValues(ARC_STANDARD_STRATEGY_TABLE, "hard")).toEqual([
      4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21,
    ]);
    expect(chartRowValues(ARC_STANDARD_STRATEGY_TABLE, "soft")).toEqual([
      12, 13, 14, 15, 16, 17, 18, 19, 20, 21,
    ]);
    expect(chartRowValues(ARC_STANDARD_STRATEGY_TABLE, "pair")).toEqual([
      2, 3, 4, 5, 6, 7, 8, 9, 10, 11,
    ]);
  });

  it("keys pair rows by pair value, not by total", () => {
    // A,A and 6,6 are both a total of 12; keying by total would collide.
    const aces = chartState("pair", 11, 6);
    const sixes = chartState("pair", 6, 6);
    expect(aces.playerTotal).toBe(12);
    expect(sixes.playerTotal).toBe(12);
    expect(normalizeStrategyKey(aces)).not.toBe(normalizeStrategyKey(sixes));
  });

  it("labels rows the way a chart does", () => {
    expect(chartRowLabel("hard", 16)).toBe("16");
    expect(chartRowLabel("soft", 18)).toBe("A,7");
    expect(chartRowLabel("soft", 12)).toBe("A,A");
    expect(chartRowLabel("pair", 8)).toBe("8,8");
    expect(chartRowLabel("pair", 11)).toBe("A,A");
  });

  it("falls back to the Hard tab for an unknown route parameter", () => {
    expect(parseChartTab(undefined)).toBe("hard");
    expect(parseChartTab("pairs")).toBe("pairs");
    expect(parseChartTab("diagonal")).toBe("hard");
  });
});

describe("every cell carries its letter", () => {
  it("maps each action to exactly one code, and the legend covers them all", () => {
    const codes = new Set<ChartCode>();
    for (const tab of CHART_TABS) {
      for (const row of buildStrategyChart(ARC_STANDARD_STRATEGY_TABLE, tab.id).rows) {
        for (const cell of row.cells) {
          if (!cell) continue;
          expect(cell.code).toMatch(/^[HSDPR]$/);
          expect(cell.accessibilityLabel.length).toBeGreaterThan(0);
          codes.add(cell.code);
        }
      }
    }

    for (const code of codes) {
      expect(CHART_LEGEND.some((entry) => entry.code === code)).toBe(true);
    }
    for (const action of ALL_ACTIONS) {
      expect(chartCodeForAction(action)).toMatch(/^[HSDPR]$/);
    }
  });

  it("states the fallback in words rather than hiding it behind a letter", () => {
    const eleven = ARC_STANDARD_STRATEGY_TABLE.entries["hard:11:6"];
    expect(eleven).toBeDefined();
    if (eleven) {
      expect(eleven.recommendedAction).toBe("DOUBLE");
      expect(describeChartCell(eleven)).toBe("Double if allowed, otherwise hit");
    }

    const seventeen = ARC_STANDARD_STRATEGY_TABLE.entries["hard:17:9"];
    expect(seventeen).toBeDefined();
    if (seventeen) expect(describeChartCell(seventeen)).toBe("Stand");
  });
});

describe("the chart states the rules it belongs to", () => {
  it("prints the required ruleset banner, derived from the solved summary", () => {
    const chart = buildStrategyChart(ARC_STANDARD_STRATEGY_TABLE, "hard");
    expect(chart.rulesetLine).toBe(
      "Arc Standard · 6 decks · dealer stands soft 17 · double after split · late surrender",
    );
  });

  it("changes when the rules change, so one chart never claims to fit all", () => {
    const h17 = strategyRulesSummary({ ...ARC_STANDARD_RULES, dealerHitsSoft17: true });
    expect(chartRulesetLine("arc-standard", h17)).toContain("dealer hits soft 17");

    const noSurrender = strategyRulesSummary({
      ...ARC_STANDARD_RULES,
      lateSurrenderAllowed: false,
      doubleAfterSplit: false,
    });
    const line = chartRulesetLine("arc-standard", noSurrender);
    expect(line).toContain("no surrender");
    expect(line).toContain("no double after split");
  });

  it("reads the banner from the table's own solved summary, not from live rules", () => {
    // The table records what the solver ran over. Reading the live ruleset
    // instead would let a chart solved for one game advertise another.
    expect(chartRulesetLine("arc-standard", ARC_STANDARD_STRATEGY_TABLE.metadata.rulesSummary)).toBe(
      buildStrategyChart(ARC_STANDARD_STRATEGY_TABLE, "soft").rulesetLine,
    );
  });

  it("names the payout and the split policy in the detail line", () => {
    const detail = chartRulesetDetail(ARC_STANDARD_STRATEGY_TABLE.metadata.rulesSummary);
    expect(detail).toContain("blackjack pays 3:2");
    expect(detail).toContain("split any equal values");
    expect(detail).toContain("up to 4 hands");
  });

  it("title-cases a ruleset id", () => {
    expect(rulesetDisplayName("arc-standard")).toBe("Arc Standard");
    expect(rulesetDisplayName("vegas_downtown")).toBe("Vegas Downtown");
  });
});

// ---------------------------------------------------------------------------

describe("cells carry the solver's probabilities through to the guide", () => {
  it("projects them for every cell the table prices", () => {
    const chart = buildStrategyChart(ARC_STANDARD_STRATEGY_TABLE, "hard");
    const cells = chart.rows.flatMap((row) => row.cells).filter((cell) => cell !== null);
    expect(cells.length).toBeGreaterThan(100);
    for (const cell of cells) {
      expect(cell!.probabilities, cell!.key).not.toBeNull();
      expect(cell!.probabilities!.dealerBust, cell!.key).toBeGreaterThan(0);
    }
  });

  it("reads them from the entry rather than recomputing them", () => {
    // The guide must show the same number the table does; a projection that
    // worked one out for itself could drift from the cell it is describing.
    const chart = buildStrategyChart(ARC_STANDARD_STRATEGY_TABLE, "hard");
    const cell = chart.rows
      .flatMap((row) => row.cells)
      .find((candidate) => candidate?.key === "hard:16:10");
    expect(cell).toBeDefined();
    expect(cell!.probabilities).toEqual(
      ARC_STANDARD_STRATEGY_TABLE.entries["hard:16:10"]!.probabilities,
    );
  });

  it("carries null through when the table has none", () => {
    // The fail-safe: a table generated before probabilities existed still
    // renders a complete chart, one block shorter.
    const stripped = {
      ...ARC_STANDARD_STRATEGY_TABLE,
      entries: Object.fromEntries(
        Object.entries(ARC_STANDARD_STRATEGY_TABLE.entries).map(([key, decision]) => {
          const { probabilities, ...rest } = decision;
          void probabilities;
          return [key, rest];
        }),
      ),
    };
    const chart = buildStrategyChart(stripped, "hard");
    const cells = chart.rows.flatMap((row) => row.cells).filter((cell) => cell !== null);
    expect(cells.length).toBeGreaterThan(100);
    for (const cell of cells) {
      expect(cell!.probabilities, cell!.key).toBeNull();
      // ...and everything else about the cell is unchanged.
      expect(cell!.action).toBe(ARC_STANDARD_STRATEGY_TABLE.entries[cell!.key]!.recommendedAction);
    }
  });
});
