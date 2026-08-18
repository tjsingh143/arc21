/**
 * Arc 21 — strategy lookup.
 *
 * Three rules govern everything in this file.
 *
 * 1. **Never guess.** If there is no entry for a state, the lookup returns
 *    null. It does not fall back to a neighbouring cell, a heuristic, or "hit
 *    when below 17". The caller hides the recommendation and logs the
 *    diagnostic. Silence is a correct answer; an invented one is not, and this
 *    is a product that teaches people how to play.
 *
 * 2. **Never serve stale advice.** Tables are keyed to `rulesetId` +
 *    `rulesetVersion`, and every strategy-relevant rule the solver ran over is
 *    recorded in `metadata.rulesSummary`. Both are checked against the ruleset
 *    in force. A version mismatch fails closed; so does a ruleset whose rules
 *    were edited *without* a version bump, which is the mistake a stamp alone
 *    cannot catch and the one most likely to actually happen.
 *
 * 3. **Never recommend an illegal action.** The caller passes the legal action
 *    set — the same one `getLegalActions` produced — and the resolved action is
 *    always a member of it. A recommendation to double on a three-card hand is
 *    worse than no recommendation: the player taps a button that is not there
 *    and learns that the advisor lies.
 */

import { rulesetKey, type BlackjackRules } from "../engine-primitives.ts";
import type { PlayerActionType } from "../engine-primitives.ts";
import { normalizeStrategyKey, totalRowStateForPair, validateStrategyState } from "./keys.ts";
import { describeRulesMismatch, strategyRulesMismatches } from "./rules-summary.ts";
import type {
  StrategyAction,
  StrategyDecision,
  StrategyDiagnostic,
  StrategyLookupResult,
  StrategyRecommendation,
  StrategyState,
  StrategyTable,
} from "./types.ts";

export interface StrategyLookupOptions {
  table: StrategyTable | null | undefined;
  /**
   * The ruleset in force. Required, and deliberately the whole ruleset rather
   * than an id and a version: the check that the table was solved for *these
   * rules* cannot be skipped by a caller who only had the stamp to hand.
   */
  rules: BlackjackRules;
  state: StrategyState;
  /** Typically `getLegalActions(state, seatId).actions`. */
  legalActions: readonly PlayerActionType[];
}

function diagnostic(
  code: StrategyDiagnostic["code"],
  message: string,
  key: string | null,
  rulesetId: string,
  rulesetVersion: number,
): StrategyDiagnostic {
  return { code, message, key, rulesetId, rulesetVersion };
}

/** Reads a cell out of a table without any resolution or legality logic. */
export function findStrategyDecision(
  table: StrategyTable,
  state: StrategyState,
): StrategyDecision | null {
  if (validateStrategyState(state) !== null) return null;
  return table.entries[normalizeStrategyKey(state)] ?? null;
}

/**
 * Resolves a state to a legal action, with the full diagnostic on failure.
 *
 * Resolution order:
 *   1. The cell's `recommendedAction`, if legal.
 *   2. For a pair whose SPLIT is not legal: the matching hard/soft total row,
 *      resolved the same way. This is a real solved cell — "you hold 8,8 but
 *      cannot split, so play it as a 16" — not a substitute invented here.
 *      Note the ordering: for a pair, the total row answers *before* the pair
 *      cell's own fallback, so `8,8` that cannot be split is served the hard-16
 *      answer (surrender vs a ten) rather than the pair cell's `HIT`.
 *   3. The cell's own `fallbackAction`, if legal. This is what expresses
 *      "double if allowed, otherwise hit" and "surrender if allowed, otherwise
 *      hit"; the generator restricts it to HIT or STAND so the chain always
 *      terminates. For a pair it is the last resort, reached only when the
 *      total row could not produce a legal action either.
 *   4. Failure. Null, with a `NO_LEGAL_RESOLUTION` diagnostic.
 */
export function lookupStrategyWithDiagnostics(
  options: StrategyLookupOptions,
): StrategyLookupResult {
  const { table, rules, state, legalActions } = options;
  const rulesetId = rules.id;
  const rulesetVersion = rules.version;

  if (table === null || table === undefined) {
    return {
      recommendation: null,
      diagnostic: diagnostic(
        "NO_TABLE",
        `No strategy table is registered for ${rulesetId}@${rulesetVersion}.`,
        null,
        rulesetId,
        rulesetVersion,
      ),
    };
  }

  if (table.rulesetId !== rulesetId || table.rulesetVersion !== rulesetVersion) {
    return {
      recommendation: null,
      diagnostic: diagnostic(
        "RULESET_MISMATCH",
        `Strategy table is keyed to ${table.rulesetId}@${table.rulesetVersion} but the session is ` +
          `running ${rulesetId}@${rulesetVersion}. Basic strategy changes with the rules, so no ` +
          "advice is served rather than advice computed for a different game.",
        null,
        rulesetId,
        rulesetVersion,
      ),
    };
  }

  // The stamp matched. Now the substance: a rule edited without a version bump
  // leaves `arc-standard@1` pointing at a chart solved for a different game.
  const mismatches = strategyRulesMismatches(table.metadata.rulesSummary, rules);
  if (mismatches.length > 0) {
    return {
      recommendation: null,
      diagnostic: diagnostic(
        "RULES_MISMATCH",
        `Strategy table ${rulesetId}@${rulesetVersion} was solved for different rules: ` +
          `${mismatches.map(describeRulesMismatch).join("; ")}. Basic strategy changes with the ` +
          "rules, so no advice is served. Re-run scripts/generate-strategy-tables.ts and bump the " +
          "ruleset version.",
        null,
        rulesetId,
        rulesetVersion,
      ),
    };
  }

  const problem = validateStrategyState(state);
  if (problem !== null) {
    return {
      recommendation: null,
      diagnostic: diagnostic("INVALID_STATE", problem, null, rulesetId, rulesetVersion),
    };
  }

  const key = normalizeStrategyKey(state);
  const decision = table.entries[key];
  if (decision === undefined) {
    return {
      recommendation: null,
      diagnostic: diagnostic(
        "NO_ENTRY",
        `Strategy table ${rulesetId}@${rulesetVersion} has no entry for "${key}".`,
        key,
        rulesetId,
        rulesetVersion,
      ),
    };
  }

  const isLegal = (action: StrategyAction): boolean =>
    (legalActions as readonly string[]).includes(action);

  // 1. The recommendation itself.
  if (isLegal(decision.recommendedAction)) {
    return {
      recommendation: {
        action: decision.recommendedAction,
        decision,
        matchedDecision: decision,
        resolution: "RECOMMENDED",
        usedFallback: false,
      },
      diagnostic: null,
    };
  }

  // 2. A pair that cannot be split is simply a hand of that total.
  if (state.handClass === "pair" && decision.recommendedAction === "SPLIT") {
    const totalState = totalRowStateForPair(state);
    if (totalState !== null) {
      const totalKey = normalizeStrategyKey(totalState);
      const totalDecision = table.entries[totalKey];
      if (totalDecision !== undefined) {
        const resolved = resolveWithinDecision(totalDecision, isLegal);
        if (resolved !== null) {
          return {
            recommendation: {
              action: resolved,
              decision: totalDecision,
              matchedDecision: decision,
              resolution: "TOTAL_ROW",
              usedFallback: true,
            },
            diagnostic: null,
          };
        }
      }
    }
  }

  // 3. The cell's own fallback.
  const fallback = decision.fallbackAction;
  if (fallback !== undefined && isLegal(fallback)) {
    return {
      recommendation: {
        action: fallback,
        decision,
        matchedDecision: decision,
        resolution: "FALLBACK",
        usedFallback: true,
      },
      diagnostic: null,
    };
  }

  return {
    recommendation: null,
    diagnostic: diagnostic(
      "NO_LEGAL_RESOLUTION",
      `Entry "${key}" recommends ${decision.recommendedAction}` +
        `${fallback !== undefined ? ` (fallback ${fallback})` : ""} but neither is legal in ` +
        `[${legalActions.join(", ")}].`,
      key,
      rulesetId,
      rulesetVersion,
    ),
  };
}

function resolveWithinDecision(
  decision: StrategyDecision,
  isLegal: (action: StrategyAction) => boolean,
): StrategyAction | null {
  if (isLegal(decision.recommendedAction)) return decision.recommendedAction;
  const fallback = decision.fallbackAction;
  if (fallback !== undefined && isLegal(fallback)) return fallback;
  return null;
}

/**
 * The fail-safe lookup. Null means "no advice"; the caller hides the hint.
 *
 * Use `lookupStrategyWithDiagnostics` when the caller also wants to log *why*
 * nothing was served — a silent advisor with no diagnostic is a bug that hides
 * itself.
 */
export function lookupStrategy(options: StrategyLookupOptions): StrategyRecommendation | null {
  return lookupStrategyWithDiagnostics(options).recommendation;
}

// ---------------------------------------------------------------------------
// Table registry
// ---------------------------------------------------------------------------

/**
 * Tables by `id@version`. A ruleset with no table gets no advice, which is the
 * intended behaviour for a variant nobody has solved yet.
 */
export type StrategyTableRegistry = Readonly<Record<string, StrategyTable>>;

export function getStrategyTable(
  registry: StrategyTableRegistry,
  rules: BlackjackRules,
): StrategyTable | null {
  const table = registry[rulesetKey(rules)];
  if (table === undefined) return null;
  // Belt and braces: a registry keyed correctly but holding a mismatched table
  // would otherwise serve advice for the wrong game.
  if (table.rulesetId !== rules.id || table.rulesetVersion !== rules.version) return null;
  // And the check the stamp cannot make: were these actually the rules solved?
  if (strategyRulesMismatches(table.metadata.rulesSummary, rules).length > 0) return null;
  return table;
}

/**
 * The registry entry as stored, mismatch and all.
 *
 * The lookup path uses this rather than `getStrategyTable` so that a table
 * filed under the right key but stamped for the wrong version is reported as
 * `RULESET_MISMATCH` — the diagnostic that names the actual problem — instead
 * of collapsing into an indistinguishable `NO_TABLE`. Verification still
 * happens in exactly one place: `lookupStrategyWithDiagnostics`.
 */
function registeredTable(
  registry: StrategyTableRegistry,
  rules: BlackjackRules,
): StrategyTable | null {
  return registry[rulesetKey(rules)] ?? null;
}

export interface RulesLookupOptions {
  registry: StrategyTableRegistry;
  rules: BlackjackRules;
  state: StrategyState;
  legalActions: readonly PlayerActionType[];
}

export function lookupStrategyForRules(
  options: RulesLookupOptions,
): StrategyRecommendation | null {
  return lookupStrategyForRulesWithDiagnostics(options).recommendation;
}

export function lookupStrategyForRulesWithDiagnostics(
  options: RulesLookupOptions,
): StrategyLookupResult {
  const { registry, rules, state, legalActions } = options;
  return lookupStrategyWithDiagnostics({
    table: registeredTable(registry, rules),
    rules,
    state,
    legalActions,
  });
}
