/**
 * Completeness and internal consistency of the generated chart.
 *
 * The advisor's fail-safe is "return nothing rather than guess". That is only
 * a virtue if the table actually covers every state a player can reach —
 * otherwise the product is silently silent, and nobody notices until a user
 * reports that the hint vanished on 16 vs 9. This suite is the coverage
 * assertion that keeps the fail-safe from becoming an excuse.
 */

import { describe, expect, it } from "vitest";

import { ARC_STANDARD_RULES } from "../../shared/blackjack/rules.js";
import { ARC_STANDARD_STRATEGY_TABLE } from "../../supabase/functions/_shared/strategy/generated-arc-standard-v1.js";
import {
  DEALER_UPCARD_VALUES,
  PAIR_VALUES,
  normalizeStrategyKey,
} from "../../supabase/functions/_shared/strategy/keys.js";
import { STRATEGY_ACTIONS } from "../../supabase/functions/_shared/strategy/types.js";
import type { StrategyAction, StrategyState } from "../../supabase/functions/_shared/strategy/types.js";

const table = ARC_STANDARD_STRATEGY_TABLE;

/** The reachable decision states the specification requires advice for. */
function requiredStates(): StrategyState[] {
  const states: StrategyState[] = [];
  for (const dealerUpcardValue of DEALER_UPCARD_VALUES) {
    for (let total = 5; total <= 21; total++) {
      states.push({ handClass: "hard", playerTotal: total, dealerUpcardValue });
    }
    for (let total = 13; total <= 21; total++) {
      states.push({ handClass: "soft", playerTotal: total, dealerUpcardValue });
    }
    for (const pairValue of PAIR_VALUES) {
      states.push({
        handClass: "pair",
        playerTotal: pairValue === 11 ? 12 : pairValue * 2,
        pairValue,
        dealerUpcardValue,
      });
    }
  }
  return states;
}

describe("generated table — coverage", () => {
  it("is keyed to the ruleset it was generated for", () => {
    expect(table.rulesetId).toBe(ARC_STANDARD_RULES.id);
    expect(table.rulesetVersion).toBe(ARC_STANDARD_RULES.version);
  });

  it("has an entry for every reachable normalized state", () => {
    const missing = requiredStates()
      .map((state) => normalizeStrategyKey(state))
      .filter((key) => table.entries[key] === undefined);

    expect(missing).toEqual([]);
  });

  it("covers hard 5-21, soft 13-21 and every pair against every upcard", () => {
    // 17 hard totals + 9 soft totals + 10 pairs, across 10 upcards.
    expect(requiredStates()).toHaveLength((17 + 9 + 10) * 10);
  });

  it("also solves the unpublished rows a pair falls back to", () => {
    // 2,2 that cannot be split is a hard 4; A,A that cannot be split is a soft
    // 12. Neither appears in a published chart, and both must resolve through a
    // computed cell rather than an invented default.
    for (const dealerUpcardValue of DEALER_UPCARD_VALUES) {
      expect(table.entries[`hard:4:${dealerUpcardValue}`]).toBeDefined();
      expect(table.entries[`soft:12:${dealerUpcardValue}`]).toBeDefined();
    }
  });

  it("reports its own entry count honestly", () => {
    expect(Object.keys(table.entries)).toHaveLength(table.metadata.entryCount);
  });
});

describe("generated table — entry shape", () => {
  it("gives every entry a self-consistent key and ruleset stamp", () => {
    for (const [key, decision] of Object.entries(table.entries)) {
      expect(decision.key).toBe(key);
      expect(decision.rulesetId).toBe(table.rulesetId);
      expect(decision.rulesetVersion).toBe(table.rulesetVersion);
      expect(normalizeStrategyKey(decision)).toBe(key);
    }
  });

  it("only ever recommends an action the engine understands", () => {
    for (const decision of Object.values(table.entries)) {
      expect(STRATEGY_ACTIONS).toContain(decision.recommendedAction);
    }
  });

  it("carries a pairValue on pair entries and on no others", () => {
    for (const decision of Object.values(table.entries)) {
      if (decision.handClass === "pair") {
        expect(PAIR_VALUES).toContain(decision.pairValue);
      } else {
        expect(decision.pairValue).toBeUndefined();
      }
    }
  });

  it("prices every action it recommends, with finite numbers", () => {
    for (const decision of Object.values(table.entries)) {
      const evs = decision.evs;
      expect(evs).toBeDefined();
      if (evs === undefined) continue;

      expect(typeof evs.STAND).toBe("number");
      expect(typeof evs.HIT).toBe("number");

      for (const [action, ev] of Object.entries(evs)) {
        expect(STRATEGY_ACTIONS).toContain(action as StrategyAction);
        expect(Number.isFinite(ev)).toBe(true);
        // Doubling stakes twice the original wager, so [-2, 2] is the true
        // bound; anything outside it means the units drifted somewhere.
        expect(ev).toBeGreaterThanOrEqual(-2);
        expect(ev).toBeLessThanOrEqual(2);
      }

      expect(evs[decision.recommendedAction]).toBeDefined();
    }
  });

  it("recommends the highest-EV action in its own numbers", () => {
    for (const decision of Object.values(table.entries)) {
      const evs = decision.evs ?? {};
      const recommendedEv = evs[decision.recommendedAction];
      expect(recommendedEv).toBeDefined();
      if (recommendedEv === undefined) continue;

      for (const [action, ev] of Object.entries(evs)) {
        expect(
          recommendedEv,
          `${decision.key} recommends ${decision.recommendedAction} (${recommendedEv}) but ` +
            `${action} scores ${ev}`,
        ).toBeGreaterThanOrEqual(ev);
      }
    }
  });

  it("prices surrender at exactly -0.5 wherever it is offered", () => {
    for (const decision of Object.values(table.entries)) {
      const surrender = decision.evs?.SURRENDER;
      if (surrender === undefined) continue;
      expect(surrender).toBe(-0.5);
    }
  });
});

describe("generated table — fallbacks", () => {
  const CONDITIONAL: readonly StrategyAction[] = ["DOUBLE", "SPLIT", "SURRENDER"];

  it("supplies a fallback for exactly the actions that can be unavailable", () => {
    for (const decision of Object.values(table.entries)) {
      if (CONDITIONAL.includes(decision.recommendedAction)) {
        expect(
          decision.fallbackAction,
          `${decision.key} recommends ${decision.recommendedAction} with no fallback`,
        ).toBeDefined();
      } else {
        expect(decision.fallbackAction).toBeUndefined();
      }
    }
  });

  it("never makes the fallback another action that can itself be illegal", () => {
    // This is what guarantees resolution terminates: HIT and STAND are always
    // on the table, so a fallback chain can never dead-end.
    for (const decision of Object.values(table.entries)) {
      if (decision.fallbackAction === undefined) continue;
      expect(["HIT", "STAND"]).toContain(decision.fallbackAction);
    }
  });

  it("picks the better of hit and stand as the fallback", () => {
    for (const decision of Object.values(table.entries)) {
      const fallback = decision.fallbackAction;
      if (fallback === undefined) continue;
      const stand = decision.evs?.STAND;
      const hit = decision.evs?.HIT;
      expect(stand).toBeDefined();
      expect(hit).toBeDefined();
      if (stand === undefined || hit === undefined) continue;

      const expected = stand >= hit ? "STAND" : "HIT";
      expect(fallback, `${decision.key}: stand ${stand} vs hit ${hit}`).toBe(expected);
    }
  });

  it("expresses double-else-hit and surrender-else-hit as data", () => {
    // The two phrasings the specification calls out by name, taken from the
    // computed chart rather than asserted as a hard-coded expectation.
    const elevenVsSix = table.entries["hard:11:6"];
    expect(elevenVsSix?.recommendedAction).toBe("DOUBLE");
    expect(elevenVsSix?.fallbackAction).toBe("HIT");

    const sixteenVsTen = table.entries["hard:16:10"];
    expect(sixteenVsTen?.recommendedAction).toBe("SURRENDER");
    expect(sixteenVsTen?.fallbackAction).toBe("HIT");
  });
});

describe("generated table — provenance", () => {
  it("records how it was produced", () => {
    const method = table.metadata.method;
    expect(table.metadata.generator).toBe("scripts/generate-strategy-tables.ts");
    expect(table.metadata.deckCount).toBe(ARC_STANDARD_RULES.deckCount);
    expect(method.peekConditioning).toBe(true);
  });

  it("declares whether an infinite-deck approximation was used", () => {
    // The flag exists so a consumer can assert on it rather than parse prose.
    // The solver uses real six-deck removal throughout, so it is false.
    expect(table.metadata.method.infiniteDeckApproximationUsed).toBe(false);
  });

  it("lists its approximations explicitly rather than leaving them in source", () => {
    expect(table.metadata.method.approximations.length).toBeGreaterThan(0);
    for (const note of table.metadata.method.approximations) {
      expect(note.length).toBeGreaterThan(20);
    }
  });

  it("lands inside the expectation range this rule set is known to produce", () => {
    // Six decks, S17, DAS, late surrender, 3:2, no resplit aces. A structural
    // error in the dealer distribution, the peek conditioning or the split
    // model moves this number long before it moves a chart cell.
    const ev = table.metadata.expectedValuePerUnit;
    expect(ev).toBeLessThan(0);
    expect(ev).toBeGreaterThan(-0.006);
    expect(ev).toBeLessThan(-0.001);
  });
});
