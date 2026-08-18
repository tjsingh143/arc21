/**
 * Arc 21 — basic strategy advisor.
 *
 * Runtime-neutral: no React, React Native, Expo or Supabase imports anywhere in
 * this package. The mobile client, the Edge Functions and the test suite all
 * consume this same module, so there is exactly one source of strategy advice.
 *
 * The chart is **computed, not remembered**. `scripts/generate-strategy-tables.ts`
 * solves the game with an expected-value solver over `ARC_STANDARD_RULES` and
 * emits `generated/arc-standard-v1.ts`; the cross-validation against the
 * published chart, with every disagreement and its EV margin, is in
 * `docs/STRATEGY_VALIDATION.md`. Nothing here solves at runtime.
 *
 * Two properties matter more than anything else this module does:
 *
 *   - A state with no entry returns **null**, never a guess.
 *   - A table whose ruleset id or version does not match the session returns
 *     **null**, never stale advice — and so does a table whose recorded
 *     `rulesSummary` disagrees with the rules actually in force, which is what
 *     catches a rule edited without a version bump.
 *
 * Both are covered by `tests/strategy/`.
 */

export * from "./types.ts";
export * from "./keys.ts";
export * from "./ev.ts";
export * from "./lookup.ts";
export * from "./rules-summary.ts";

import { ARC_STANDARD_RULES, rulesetKey } from "../engine-primitives.ts";
import { ARC_STANDARD_STRATEGY_TABLE } from "./generated-arc-standard-v1.ts";
import type { StrategyTableRegistry } from "./lookup.ts";
import {
  getStrategyTable,
  lookupStrategyForRules,
  lookupStrategyForRulesWithDiagnostics,
} from "./lookup.ts";
import type { BlackjackRules } from "../engine-primitives.ts";
import type { PlayerActionType } from "../engine-primitives.ts";
import type {
  StrategyLookupResult,
  StrategyRecommendation,
  StrategyState,
  StrategyTable,
} from "./types.ts";

export { ARC_STANDARD_STRATEGY_TABLE };

/**
 * Every solved table the product ships, keyed by `id@version`.
 *
 * Adding a ruleset variant means running the solver for it and registering the
 * result here. It does **not** mean reusing a neighbouring table: DAS, S17 and
 * surrender each move cells, which is exactly why tables are version-keyed.
 */
export const STRATEGY_TABLES: StrategyTableRegistry = {
  [rulesetKey(ARC_STANDARD_RULES)]: ARC_STANDARD_STRATEGY_TABLE,
};

/** The table for a ruleset, or null when none is registered or the version differs. */
export function strategyTableFor(rules: BlackjackRules): StrategyTable | null {
  return getStrategyTable(STRATEGY_TABLES, rules);
}

export interface AdviseOptions {
  rules: BlackjackRules;
  state: StrategyState;
  /** Typically `getLegalActions(gameState, seatId).actions`. */
  legalActions: readonly PlayerActionType[];
}

/**
 * The one call a UI should need: null means "show nothing".
 *
 * Callers must treat null as "hide the hint and log the diagnostic", never as
 * "pick something sensible".
 */
export function adviseAction(options: AdviseOptions): StrategyRecommendation | null {
  return lookupStrategyForRules({ registry: STRATEGY_TABLES, ...options });
}

/** As `adviseAction`, but also returns why nothing was served. */
export function adviseActionWithDiagnostics(options: AdviseOptions): StrategyLookupResult {
  return lookupStrategyForRulesWithDiagnostics({ registry: STRATEGY_TABLES, ...options });
}
