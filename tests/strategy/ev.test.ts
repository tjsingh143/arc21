/**
 * The EV helpers the learning product reports mistakes with.
 *
 * These numbers end up in front of a player as "that cost you 0.04 of a bet",
 * so the two properties that matter are that they come from the precomputed
 * table (never a runtime solve) and that "we don't know" never renders as
 * "that was free".
 */

import { describe, expect, it } from "vitest";

import type { PlayerActionType } from "../../shared/blackjack/types.js";
import { ARC_STANDARD_STRATEGY_TABLE } from "../../supabase/functions/_shared/strategy/generated-arc-standard-v1.js";
import {
  actionEVs,
  bestEV,
  bestLegalEV,
  evDelta,
  evForAction,
  evMistake,
  evMistakeForDecision,
  legalActionEVs,
} from "../../supabase/functions/_shared/strategy/ev.js";
import { STRATEGY_ACTIONS } from "../../supabase/functions/_shared/strategy/types.js";
import type { ActionEV, StrategyAction, StrategyDecision } from "../../supabase/functions/_shared/strategy/types.js";

const table = ARC_STANDARD_STRATEGY_TABLE;

/** Everything the chart can price. Two initial cards, full stack, first hand. */
const ALL: readonly StrategyAction[] = STRATEGY_ACTIONS;

/** What the engine leaves on a three-card hand, or any hand born of a split. */
const HIT_STAND: readonly PlayerActionType[] = ["HIT", "STAND"];

function decisionFor(key: string): StrategyDecision {
  const decision = table.entries[key];
  if (decision === undefined) throw new Error(`missing test fixture entry ${key}`);
  return decision;
}

describe("bestEV", () => {
  it("returns the highest-EV action", () => {
    const list: ActionEV[] = [
      { action: "HIT", ev: -0.53 },
      { action: "STAND", ev: -0.54 },
      { action: "SURRENDER", ev: -0.5 },
    ];
    expect(bestEV(list)).toEqual({ action: "SURRENDER", ev: -0.5 });
  });

  it("returns null for an empty list rather than a placeholder action", () => {
    expect(bestEV([])).toBeNull();
  });

  it("keeps the first entry on a tie, so the caller's ordering decides", () => {
    const list: ActionEV[] = [
      { action: "STAND", ev: -0.2 },
      { action: "HIT", ev: -0.2 },
    ];
    expect(bestEV(list)?.action).toBe("STAND");
  });
});

describe("evMistake", () => {
  it("reports what the chosen action gave up", () => {
    expect(evMistake(-0.5, -0.54)).toBeCloseTo(0.04, 12);
  });

  it("is zero when the best action was played", () => {
    expect(evMistake(-0.5, -0.5)).toBe(0);
  });

  it("never reports a negative mistake", () => {
    // A negative "mistake" would read to a player as a reward for a wrong play.
    expect(evMistake(-0.54, -0.5)).toBe(0);
  });

  it("accepts ActionEV values as well as raw numbers", () => {
    const best: ActionEV = { action: "SPLIT", ev: -0.475 };
    const chosen: ActionEV = { action: "SURRENDER", ev: -0.5 };
    expect(evMistake(best, chosen)).toBeCloseTo(0.025, 12);
  });

  it("exposes the raw signed difference separately", () => {
    expect(evDelta(-0.54, -0.5)).toBeCloseTo(-0.04, 12);
  });
});

describe("precomputed EV access", () => {
  it("reads action EVs straight out of the table, best first", () => {
    const ranked = actionEVs(decisionFor("hard:16:10"));
    expect(ranked.length).toBeGreaterThan(1);
    expect(ranked[0]?.action).toBe("SURRENDER");
    for (let i = 1; i < ranked.length; i++) {
      expect(ranked[i - 1]?.ev ?? 0).toBeGreaterThanOrEqual(ranked[i]?.ev ?? 0);
    }
  });

  it("agrees with the recommendation stored in the same cell", () => {
    for (const decision of Object.values(table.entries)) {
      const best = bestEV(actionEVs(decision));
      expect(best, decision.key).not.toBeNull();
      const recommendedEv = evForAction(decision, decision.recommendedAction);
      expect(recommendedEv, decision.key).not.toBeNull();
      expect(best?.ev, decision.key).toBeCloseTo(recommendedEv ?? Number.NaN, 12);
    }
  });

  it("prices a real mistake against the best play", () => {
    const decision = decisionFor("pair:8:10");
    // Standing on 8,8 against a ten instead of splitting.
    const cost = evMistakeForDecision(decision, "STAND", ALL);
    expect(cost).not.toBeNull();
    expect(cost ?? 0).toBeGreaterThan(0.05);
  });

  it("scores the correct play as costing nothing", () => {
    const decision = decisionFor("pair:8:10");
    expect(evMistakeForDecision(decision, decision.recommendedAction, ALL)).toBe(0);
  });

  it("returns null, not zero, when an action was never priced", () => {
    // Zero would claim the play was free. "We do not know" is a different
    // statement and the learning product must not conflate them.
    const decision = decisionFor("hard:16:10");
    expect(evForAction(decision, "SPLIT")).toBeNull();
    expect(evMistakeForDecision(decision, "SPLIT", ALL)).toBeNull();
  });

  it("returns nothing at all for a decision that carries no EVs", () => {
    const bare: StrategyDecision = {
      key: "hard:16:10",
      rulesetId: "arc-standard",
      rulesetVersion: 1,
      handClass: "hard",
      playerTotal: 16,
      dealerUpcardValue: 10,
      recommendedAction: "STAND",
    };
    expect(actionEVs(bare)).toEqual([]);
    expect(evForAction(bare, "STAND")).toBeNull();
    // Legal to stand, but the cell prices nothing: "unknown", not "free".
    expect(evMistakeForDecision(bare, "STAND", ["HIT", "STAND"])).toBeNull();
  });

  it("fails safe instead of throwing when handed no legal action set", () => {
    const decision = decisionFor("hard:16:10");
    // A stale JS call site can pass undefined through the typed parameter.
    // Returning null keeps the table alive; the UI already hides a null EV.
    expect(
      evMistakeForDecision(decision, "HIT", undefined as never),
    ).toBeNull();
  });

  it("keeps doubling in units of the original wager", () => {
    // A double that wins pays two units, so its EV legitimately exceeds the
    // [-1, 1] range a single-unit action is bounded by.
    const elevenVsSix = decisionFor("hard:11:6");
    expect(evForAction(elevenVsSix, "DOUBLE") ?? 0).toBeGreaterThan(
      evForAction(elevenVsSix, "HIT") ?? 0,
    );
    const badDouble = evForAction(decisionFor("hard:16:10"), "DOUBLE") ?? 0;
    expect(badDouble).toBeLessThan(-1);
  });
});
