/**
 * The advisor's safety properties.
 *
 * Three failures are unacceptable in a product that teaches people to play:
 * recommending an action they cannot take, answering from a table computed for
 * different rules, and inventing advice for a state nobody solved. Each gets
 * its own section here.
 */

import { describe, expect, it } from "vitest";

import { parseCardShorthand } from "../../shared/blackjack/cards.js";
import { ARC_STANDARD_RULES, rulesetKey } from "../../shared/blackjack/rules.js";
import type { BlackjackRules } from "../../shared/blackjack/rules.js";
import type { PlayerActionType } from "../../shared/blackjack/types.js";
import { ARC_STANDARD_STRATEGY_TABLE } from "../../supabase/functions/_shared/strategy/generated-arc-standard-v1.js";
import {
  STRATEGY_RULE_FIELDS,
  STRATEGY_TABLES,
  adviseAction,
  adviseActionWithDiagnostics,
  describeStrategyState,
  describeStrategyStateLabel,
  describeUpcardLabel,
  findStrategyDecision,
  lookupStrategy,
  lookupStrategyForRulesWithDiagnostics,
  lookupStrategyWithDiagnostics,
  normalizeStrategyKey,
  pairTotal,
  strategyRulesMismatches,
  strategyTableFor,
  totalRowStateForPair,
  validateStrategyState,
} from "../../supabase/functions/_shared/strategy/index.js";
import type { HandClass, StrategyState, StrategyTable } from "../../supabase/functions/_shared/strategy/types.js";

const table = ARC_STANDARD_STRATEGY_TABLE;

const ALL: readonly PlayerActionType[] = ["HIT", "STAND", "DOUBLE", "SPLIT", "SURRENDER"];
const HIT_STAND: readonly PlayerActionType[] = ["HIT", "STAND"];

function look(state: StrategyState, legalActions: readonly PlayerActionType[]) {
  return lookupStrategyWithDiagnostics({
    table,
    rules: ARC_STANDARD_RULES,
    state,
    legalActions,
  });
}

const hard = (playerTotal: number, dealerUpcardValue: number): StrategyState => ({
  handClass: "hard",
  playerTotal,
  dealerUpcardValue,
});

const soft = (playerTotal: number, dealerUpcardValue: number): StrategyState => ({
  handClass: "soft",
  playerTotal,
  dealerUpcardValue,
});

const pair = (pairValue: number, dealerUpcardValue: number): StrategyState => ({
  handClass: "pair",
  playerTotal: pairValue === 11 ? 12 : pairValue * 2,
  pairValue,
  dealerUpcardValue,
});

describe("normalizeStrategyKey", () => {
  it("keys hard and soft rows by total and pairs by pair value", () => {
    expect(normalizeStrategyKey(hard(16, 10))).toBe("hard:16:10");
    expect(normalizeStrategyKey(soft(18, 3))).toBe("soft:18:3");
    expect(normalizeStrategyKey(pair(8, 11))).toBe("pair:8:11");
  });

  it("cannot collide A,A with 6,6 even though both total 12", () => {
    expect(normalizeStrategyKey(pair(11, 6))).not.toBe(normalizeStrategyKey(pair(6, 6)));
  });

  it("refuses to invent a key for a malformed state", () => {
    expect(() =>
      normalizeStrategyKey({ handClass: "pair", playerTotal: 16, dealerUpcardValue: 10 }),
    ).toThrow(TypeError);
  });

  it("rejects an ace expressed as 1 rather than 11", () => {
    // The engine's `cardValue` reports aces as 11; accepting 1 here would map a
    // dealer ace onto a state that does not exist and answer with silence.
    expect(validateStrategyState(hard(16, 1))).not.toBeNull();
    expect(validateStrategyState(hard(16, 11))).toBeNull();
  });

  it("names the problem rather than just refusing", () => {
    expect(
      validateStrategyState({ ...hard(16, 10), handClass: "quad" as unknown as HandClass }),
    ).toContain("handClass");
    expect(validateStrategyState(hard(99, 10))).toContain("outside 2..21");
    expect(validateStrategyState(hard(16, 1))).toContain("not 2..10 or 11");
    expect(
      validateStrategyState({ handClass: "pair", playerTotal: 16, dealerUpcardValue: 10 }),
    ).toContain("pairValue is missing");
    expect(
      validateStrategyState({
        handClass: "pair",
        playerTotal: 24,
        pairValue: 12,
        dealerUpcardValue: 10,
      }),
    ).toContain("not 2..10 or 11");
  });

  it("labels a state the way a chart does", () => {
    expect(describeStrategyStateLabel(hard(16, 10))).toBe("Hard 16");
    expect(describeStrategyStateLabel(soft(18, 3))).toBe("Soft 18");
    expect(describeStrategyStateLabel(pair(8, 10))).toBe("8,8");
    expect(describeStrategyStateLabel(pair(11, 6))).toBe("A,A");
    expect(describeUpcardLabel(10)).toBe("10");
    expect(describeUpcardLabel(11)).toBe("A");
  });
});

describe("a pair's total must agree with its pair value", () => {
  /**
   * `normalizeStrategyKey` keys a pair by `pairValue` and never looks at
   * `playerTotal`, so an incoherent total stays invisible until SPLIT turns out
   * to be illegal — and then chooses which hard/soft row answers. A caller that
   * builds the coordinate by hand (the exported signature invites exactly that,
   * `playerTotal` being required) could be told to stand on a hard 4.
   */
  const INCOHERENT: ReadonlyArray<{ label: string; state: StrategyState }> = [
    {
      label: "2,2 carrying a 20",
      state: { handClass: "pair", pairValue: 2, playerTotal: 20, dealerUpcardValue: 5 },
    },
    {
      label: "6,6 carrying a 6",
      state: { handClass: "pair", pairValue: 6, playerTotal: 6, dealerUpcardValue: 5 },
    },
    {
      label: "8,8 carrying an 8",
      state: { handClass: "pair", pairValue: 8, playerTotal: 8, dealerUpcardValue: 6 },
    },
    {
      label: "A,A carrying a 20",
      state: { handClass: "pair", pairValue: 11, playerTotal: 20, dealerUpcardValue: 6 },
    },
    {
      label: "A,A carrying a hard 2",
      state: { handClass: "pair", pairValue: 11, playerTotal: 2, dealerUpcardValue: 6 },
    },
  ];

  for (const { label, state } of INCOHERENT) {
    it(`refuses ${label} instead of resolving through the wrong row`, () => {
      expect(validateStrategyState(state)).not.toBeNull();
      expect(() => normalizeStrategyKey(state)).toThrow(TypeError);

      // SPLIT withheld, so the total-row path is the one that would have fired.
      const result = look(state, HIT_STAND);
      expect(result.recommendation).toBeNull();
      expect(result.diagnostic?.code).toBe("INVALID_STATE");
      expect(result.diagnostic?.message).toContain("playerTotal");
    });
  }

  it("accepts every coherent pair, and only those", () => {
    for (const pairValue of [2, 3, 4, 5, 6, 7, 8, 9, 10, 11]) {
      const coherent = pair(pairValue, 6);
      expect(coherent.playerTotal).toBe(pairTotal(pairValue));
      expect(validateStrategyState(coherent)).toBeNull();

      for (const wrongTotal of [4, 12, 16, 20]) {
        if (wrongTotal === pairTotal(pairValue)) continue;
        expect(
          validateStrategyState({ ...coherent, playerTotal: wrongTotal }),
          `pair ${pairValue} accepted a total of ${wrongTotal}`,
        ).not.toBeNull();
      }
    }
  });

  it("derives the fallback row from the pair value, not from the supplied total", () => {
    // Defence in depth behind the validation: this function decides which
    // solved row answers, so it must not be steerable by a field the key never
    // reads, even if a future caller reaches it without validating first.
    expect(totalRowStateForPair({ ...pair(8, 6), playerTotal: 4 })).toEqual({
      handClass: "hard",
      playerTotal: 16,
      dealerUpcardValue: 6,
    });
    expect(totalRowStateForPair({ ...pair(11, 6), playerTotal: 20 })).toEqual({
      handClass: "soft",
      playerTotal: 12,
      dealerUpcardValue: 6,
    });
    expect(totalRowStateForPair(hard(16, 10))).toBeNull();
    expect(
      totalRowStateForPair({ handClass: "pair", playerTotal: 24, pairValue: 12, dealerUpcardValue: 5 }),
    ).toBeNull();
  });
});

describe("fallback resolution — never an illegal action", () => {
  it("returns the fallback when DOUBLE is not legal", () => {
    const withDouble = look(hard(11, 6), ALL);
    expect(withDouble.recommendation?.action).toBe("DOUBLE");
    expect(withDouble.recommendation?.usedFallback).toBe(false);

    const withoutDouble = look(hard(11, 6), HIT_STAND);
    expect(withoutDouble.recommendation?.action).toBe("HIT");
    expect(withoutDouble.recommendation?.usedFallback).toBe(true);
    expect(withoutDouble.recommendation?.resolution).toBe("FALLBACK");
  });

  it("returns the fallback when SURRENDER is not legal", () => {
    const withSurrender = look(hard(16, 10), ALL);
    expect(withSurrender.recommendation?.action).toBe("SURRENDER");

    const withoutSurrender = look(hard(16, 10), HIT_STAND);
    expect(withoutSurrender.recommendation?.action).toBe("HIT");
    expect(withoutSurrender.recommendation?.usedFallback).toBe(true);
  });

  it("plays a pair as its total when SPLIT is not legal", () => {
    // Four hands already open, or not enough chips for a second wager: 8,8 is
    // simply a 16, and the answer comes from the solved hard-16 row.
    const withSplit = look(pair(8, 10), ALL);
    expect(withSplit.recommendation?.action).toBe("SPLIT");

    const withoutSplit = look(pair(8, 10), ["HIT", "STAND", "SURRENDER"]);
    expect(withoutSplit.recommendation?.resolution).toBe("TOTAL_ROW");
    expect(withoutSplit.recommendation?.action).toBe("SURRENDER");
    expect(withoutSplit.recommendation?.decision.key).toBe("hard:16:10");
    expect(withoutSplit.recommendation?.matchedDecision.key).toBe("pair:8:10");
  });

  it("resolves a pair through the total row's own fallback when needed", () => {
    // 8,8 vs 10 with neither split nor surrender available: the hard-16 row
    // recommends surrender, whose fallback is hit.
    const result = look(pair(8, 10), HIT_STAND);
    expect(result.recommendation?.resolution).toBe("TOTAL_ROW");
    expect(result.recommendation?.action).toBe("HIT");
  });

  it("routes A,A through the soft-12 row rather than a hard 12", () => {
    const result = look(pair(11, 6), HIT_STAND);
    expect(result.recommendation?.decision.key).toBe("soft:12:6");
    expect(HIT_STAND).toContain(result.recommendation?.action);
  });

  it("never returns an action outside the legal set, for any state or subset", () => {
    const subsets: ReadonlyArray<readonly PlayerActionType[]> = [
      ALL,
      ["HIT", "STAND", "DOUBLE"],
      ["HIT", "STAND", "SPLIT"],
      ["HIT", "STAND", "SURRENDER"],
      HIT_STAND,
    ];

    for (const decision of Object.values(table.entries)) {
      for (const legalActions of subsets) {
        const result = look(decision, legalActions);
        expect(
          result.recommendation,
          `${decision.key} produced no advice for [${legalActions.join(",")}]`,
        ).not.toBeNull();
        expect(
          legalActions,
          `${decision.key} recommended ${result.recommendation?.action}`,
        ).toContain(result.recommendation?.action);
      }
    }
  });
});

describe("ruleset version mismatch fails safe", () => {
  it("serves nothing when the table version is behind the session", () => {
    const nextVersion: BlackjackRules = { ...ARC_STANDARD_RULES, version: 2 };
    const result = lookupStrategyForRulesWithDiagnostics({
      registry: STRATEGY_TABLES,
      rules: nextVersion,
      state: hard(16, 10),
      legalActions: ALL,
    });

    expect(result.recommendation).toBeNull();
    expect(result.diagnostic?.code).toBe("NO_TABLE");
  });

  it("serves nothing when a registry entry holds a table for another version", () => {
    const stale: StrategyTable = { ...table, rulesetVersion: 0 };
    const registry = { [rulesetKey(ARC_STANDARD_RULES)]: stale };

    const result = lookupStrategyForRulesWithDiagnostics({
      registry,
      rules: ARC_STANDARD_RULES,
      state: hard(16, 10),
      legalActions: ALL,
    });

    expect(result.recommendation).toBeNull();
    expect(result.diagnostic?.code).toBe("RULESET_MISMATCH");
  });

  it("serves nothing when the id matches but the version is ahead of the table", () => {
    const result = lookupStrategyWithDiagnostics({
      table,
      rules: { ...ARC_STANDARD_RULES, version: 7 },
      state: hard(16, 10),
      legalActions: ALL,
    });

    expect(result.recommendation).toBeNull();
    expect(result.diagnostic?.code).toBe("RULESET_MISMATCH");
    expect(result.diagnostic?.message).toContain("arc-standard@1");
  });

  it("does not register a table for a ruleset under another id", () => {
    const renamed: BlackjackRules = { ...ARC_STANDARD_RULES, id: "arc-other", version: 1 };
    expect(strategyTableFor(renamed)).toBeNull();
  });
});

describe("rules edited without a version bump fail safe", () => {
  /**
   * The realistic staleness. Renaming a ruleset is a deliberate act nobody
   * performs by accident; editing a field of `ARC_STANDARD_RULES` and leaving
   * `version: 1` alone is a one-character mistake, and it leaves the stamp
   * saying `arc-standard@1` while every affected cell of the chart is wrong.
   * The id and version cannot detect it. `metadata.rulesSummary` can.
   */
  const VARIANTS: ReadonlyArray<{ label: string; rules: BlackjackRules; moves: string }> = [
    {
      label: "H17",
      rules: { ...ARC_STANDARD_RULES, dealerHitsSoft17: true },
      moves: "11 vs A becomes a double, A,8 vs 6 becomes a double, 15 vs A becomes a surrender",
    },
    {
      label: "no late surrender",
      rules: { ...ARC_STANDARD_RULES, lateSurrenderAllowed: false },
      moves: "every Rh and Rs cell",
    },
    {
      label: "DAS off",
      rules: { ...ARC_STANDARD_RULES, doubleAfterSplit: false },
      moves: "4,4 vs 5 and 6, 2,2 and 3,3 vs 2 and 3, 6,6 vs 2",
    },
    {
      label: "split by rank",
      rules: { ...ARC_STANDARD_RULES, splitPolicy: "same_rank" },
      moves: "K,Q stops being a pair row at all",
    },
    {
      label: "single deck",
      rules: { ...ARC_STANDARD_RULES, deckCount: 1 },
      moves: "removal effects across the whole chart",
    },
    {
      label: "6:5 naturals",
      rules: { ...ARC_STANDARD_RULES, blackjackPayoutNumerator: 6, blackjackPayoutDenominator: 5 },
      moves: "the expectation the table publishes for itself",
    },
    {
      label: "resplit aces",
      rules: { ...ARC_STANDARD_RULES, resplitAcesAllowed: true },
      moves: "the value of A,A",
    },
    {
      label: "no hole card",
      rules: { ...ARC_STANDARD_RULES, dealerHoleCard: false, dealerPeeksForBlackjack: false },
      moves: "every double and split against a ten or an ace",
    },
  ];

  for (const variant of VARIANTS) {
    it(`serves nothing under ${variant.label}, which moves ${variant.moves}`, () => {
      // The stamp is untouched: this is still `arc-standard@1` by id and version.
      expect(rulesetKey(variant.rules)).toBe(rulesetKey(ARC_STANDARD_RULES));

      const result = adviseActionWithDiagnostics({
        rules: variant.rules,
        state: hard(16, 10),
        legalActions: ALL,
      });

      expect(result.recommendation, `${variant.label} was served the S17 chart`).toBeNull();
      expect(result.diagnostic?.code).toBe("RULES_MISMATCH");
      expect(strategyTableFor(variant.rules)).toBeNull();
    });
  }

  it("names the offending field, and what it was solved for, in the diagnostic", () => {
    // A silent refusal is only marginally better than silent staleness: whoever
    // edited the ruleset has to be able to see which field did it.
    const result = adviseActionWithDiagnostics({
      rules: { ...ARC_STANDARD_RULES, dealerHitsSoft17: true },
      state: hard(16, 10),
      legalActions: ALL,
    });

    expect(result.diagnostic?.message).toContain("dealerHitsSoft17");
    expect(result.diagnostic?.message).toContain("solved for false, playing true");
  });

  it("treats a summary that never recorded a field as a mismatch, not as agreement", () => {
    // A table emitted before the field existed was solved without considering
    // it. "It wasn't written down" is not evidence that it matched.
    const { dealerHitsSoft17: _dropped, ...partial } = table.metadata.rulesSummary;
    const mismatches = strategyRulesMismatches(partial, ARC_STANDARD_RULES);
    expect(mismatches.map((mismatch) => mismatch.field)).toEqual(["dealerHitsSoft17"]);
    expect(mismatches[0]?.solvedFor).toBe("(not recorded)");
    expect(strategyRulesMismatches(undefined, ARC_STANDARD_RULES)).toHaveLength(
      STRATEGY_RULE_FIELDS.length,
    );
  });

  it("classifies every field of BlackjackRules as strategy-relevant or not", () => {
    // A rule added to the engine without a decision here would silently fall
    // outside the fingerprint. The type of this map makes omitting one a
    // compile error; the assertions make misclassifying one a test failure.
    const CLASSIFICATION: Readonly<Record<keyof BlackjackRules, "moves-a-cell" | "irrelevant">> = {
      id: "irrelevant", // the stamp itself, checked separately
      version: "irrelevant",
      deckCount: "moves-a-cell",
      dealerHitsSoft17: "moves-a-cell",
      dealerHoleCard: "moves-a-cell",
      dealerPeeksForBlackjack: "moves-a-cell",
      blackjackPayoutNumerator: "moves-a-cell",
      blackjackPayoutDenominator: "moves-a-cell",
      insuranceAllowed: "irrelevant", // insurance is never part of a cell
      insuranceFractionNumerator: "irrelevant",
      insuranceFractionDenominator: "irrelevant",
      insurancePayoutNumerator: "irrelevant",
      insurancePayoutDenominator: "irrelevant",
      lateSurrenderAllowed: "moves-a-cell",
      doubleAllowed: "moves-a-cell",
      doubleOnAnyTwoCards: "moves-a-cell",
      doubleAfterSplit: "moves-a-cell",
      splitPolicy: "moves-a-cell",
      maxSplitHands: "moves-a-cell",
      splitAcesAllowed: "moves-a-cell",
      resplitAcesAllowed: "moves-a-cell",
      hitSplitAcesAllowed: "moves-a-cell",
      doubleSplitAcesAllowed: "moves-a-cell",
      splitAceTwentyOneIsBlackjack: "moves-a-cell",
      targetPenetration: "irrelevant", // shoe management, not a decision
      minBet: "irrelevant", // table tiers differ only in stakes
      maxBet: "irrelevant",
      betIncrement: "irrelevant",
    };

    expect(Object.keys(CLASSIFICATION).sort()).toEqual(Object.keys(ARC_STANDARD_RULES).sort());

    for (const [field, classification] of Object.entries(CLASSIFICATION)) {
      const key = field as keyof BlackjackRules;
      const current = ARC_STANDARD_RULES[key];
      const changed =
        typeof current === "boolean"
          ? !current
          : typeof current === "number"
            ? current + 1
            : `${String(current)}-changed`;
      const edited = { ...ARC_STANDARD_RULES, [key]: changed } as BlackjackRules;

      const detected = strategyRulesMismatches(table.metadata.rulesSummary, edited).length > 0;
      expect(detected, `${field} is ${classification} but detection is ${String(detected)}`).toBe(
        classification === "moves-a-cell",
      );
    }
  });

  it("still answers for the ruleset it was actually generated for", () => {
    expect(strategyTableFor(ARC_STANDARD_RULES)).toBe(table);
    expect(strategyRulesMismatches(table.metadata.rulesSummary, ARC_STANDARD_RULES)).toEqual([]);
    expect(adviseAction({ rules: ARC_STANDARD_RULES, state: hard(16, 10), legalActions: ALL })).not.toBeNull();
  });
});

describe("missing data returns null rather than a guess", () => {
  it("returns null for a state the table has no entry for", () => {
    const sparse: StrategyTable = { ...table, entries: {} };
    const result = lookupStrategyWithDiagnostics({
      table: sparse,
      rules: ARC_STANDARD_RULES,
      state: hard(16, 10),
      legalActions: ALL,
    });

    expect(result.recommendation).toBeNull();
    expect(result.diagnostic?.code).toBe("NO_ENTRY");
    expect(result.diagnostic?.key).toBe("hard:16:10");
  });

  it("does not answer a missing cell from a neighbouring one", () => {
    const { ["hard:16:10"]: _removed, ...rest } = table.entries;
    const holed: StrategyTable = { ...table, entries: rest };

    expect(
      lookupStrategy({
        table: holed,
        rules: ARC_STANDARD_RULES,
        state: hard(16, 10),
        legalActions: ALL,
      }),
    ).toBeNull();

    // ...and the surrounding cells still answer, so this is a hole, not an outage.
    expect(
      lookupStrategy({
        table: holed,
        rules: ARC_STANDARD_RULES,
        state: hard(15, 10),
        legalActions: ALL,
      }),
    ).not.toBeNull();
  });

  it("returns null when no table is registered at all", () => {
    const result = lookupStrategyWithDiagnostics({
      table: null,
      rules: { ...ARC_STANDARD_RULES, id: "unknown" },
      state: hard(16, 10),
      legalActions: ALL,
    });

    expect(result.recommendation).toBeNull();
    expect(result.diagnostic?.code).toBe("NO_TABLE");
  });

  it("returns null for a malformed state instead of throwing at the caller", () => {
    const result = look({ handClass: "pair", playerTotal: 16, dealerUpcardValue: 10 }, ALL);
    expect(result.recommendation).toBeNull();
    expect(result.diagnostic?.code).toBe("INVALID_STATE");
  });

  it("returns null when the cell exists but nothing in it is legal", () => {
    const result = look(hard(11, 6), ["SURRENDER"]);
    expect(result.recommendation).toBeNull();
    expect(result.diagnostic?.code).toBe("NO_LEGAL_RESOLUTION");
  });

  it("always pairs a null recommendation with a diagnostic to log", () => {
    const cases = [
      look({ handClass: "hard", playerTotal: 99, dealerUpcardValue: 10 }, ALL),
      look(hard(16, 10), []),
    ];
    for (const result of cases) {
      expect(result.recommendation).toBeNull();
      expect(result.diagnostic).not.toBeNull();
      expect(result.diagnostic?.message.length).toBeGreaterThan(0);
    }
  });

  it("findStrategyDecision reports absence rather than approximating", () => {
    expect(findStrategyDecision(table, hard(16, 10))).not.toBeNull();
    expect(findStrategyDecision(table, { handClass: "hard", playerTotal: 3, dealerUpcardValue: 10 })).toBeNull();
  });
});

describe("describeStrategyState — deriving coordinates from real cards", () => {
  const card = (shorthand: string, suffix = "") => parseCardShorthand(shorthand, 0, suffix);

  it("classifies a hard hand", () => {
    const state = describeStrategyState([card("10S"), card("6H")], card("9C"));
    expect(state).toEqual({ handClass: "hard", playerTotal: 16, dealerUpcardValue: 9 });
  });

  it("classifies a soft hand and counts the ace as 11", () => {
    const state = describeStrategyState([card("AS"), card("7H")], card("9C"));
    expect(state).toEqual({ handClass: "soft", playerTotal: 18, dealerUpcardValue: 9 });
  });

  it("classifies K,Q as a pair under the same-value policy", () => {
    // Arc Standard splits on equal value, so K+Q is a legal split. Advice and
    // legality are separate concerns — the chart will still say stand.
    const state = describeStrategyState([card("KS"), card("QH")], card("6C"));
    expect(state?.handClass).toBe("pair");
    expect(state?.pairValue).toBe(10);

    const byRank = describeStrategyState([card("KS"), card("QH")], card("6C"), {
      splitPolicy: "same_rank",
    });
    expect(byRank?.handClass).toBe("hard");
    expect(byRank?.playerTotal).toBe(20);
  });

  it("reports an ace pair with pairValue 11 and total 12", () => {
    const state = describeStrategyState([card("AS"), card("AH", "b")], card("6C"));
    expect(state).toEqual({
      handClass: "pair",
      playerTotal: 12,
      pairValue: 11,
      dealerUpcardValue: 6,
    });
  });

  it("returns null where there is no decision to advise on", () => {
    expect(describeStrategyState([card("AS"), card("KH")], card("6C"))).toBeNull();
    expect(describeStrategyState([card("10S"), card("9H"), card("8C")], card("6D"))).toBeNull();
    expect(describeStrategyState([card("10S")], card("6C"))).toBeNull();
  });

  it("treats a split hand's two-card 21 as an ordinary decision state", () => {
    // Split-ace 21 is not a natural under Arc Standard, so it is a real 21 the
    // advisor can speak to rather than a blackjack it must stay silent about.
    const state = describeStrategyState([card("AS"), card("KH")], card("6C"), {
      cameFromSplit: true,
      cameFromSplitAces: true,
      splitAceTwentyOneIsBlackjack: false,
    });
    expect(state).toEqual({ handClass: "soft", playerTotal: 21, dealerUpcardValue: 6 });
  });

  it("feeds straight into the advisor", () => {
    const state = describeStrategyState([card("8S"), card("8H")], card("10C"));
    expect(state).not.toBeNull();
    if (state === null) return;

    const result = adviseActionWithDiagnostics({
      rules: ARC_STANDARD_RULES,
      state,
      legalActions: ALL,
    });
    expect(result.diagnostic).toBeNull();
    expect(result.recommendation?.action).toBe("SPLIT");
  });
});
