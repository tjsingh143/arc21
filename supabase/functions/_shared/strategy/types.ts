/**
 * Arc 21 — basic-strategy advisor types.
 *
 * Runtime-neutral: this module must never import React, React Native, Expo,
 * Supabase or any other host-specific package.
 *
 * A strategy table is **data**. It is produced by
 * `scripts/generate-strategy-tables.ts`, which solves the game with an
 * expected-value solver over the ruleset in force. Nothing here solves anything
 * at runtime and no chart is ever typed in by hand: the specification forbids
 * guessed recommendations, and a remembered chart is a guess.
 *
 * Every table is keyed to `rulesetId` + `rulesetVersion`. A mismatch is a hard
 * lookup failure, never a silent fallback to stale advice — rule changes move
 * cells in the chart, so serving a v1 table under v2 rules is worse than
 * serving nothing.
 */

import type { PlayerActionType } from "../engine-primitives.ts";
import type { StrategyRulesSummary } from "./rules-summary.ts";

// ---------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------

export type HandClass = "hard" | "soft" | "pair";

export type StrategyAction = "HIT" | "STAND" | "DOUBLE" | "SPLIT" | "SURRENDER";

export const STRATEGY_ACTIONS: readonly StrategyAction[] = [
  "HIT",
  "STAND",
  "DOUBLE",
  "SPLIT",
  "SURRENDER",
];

/** Actions that are legal on essentially every decision the advisor sees. */
export const ALWAYS_AVAILABLE_ACTIONS: readonly StrategyAction[] = ["HIT", "STAND"];

type MutuallyAssignable<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

/**
 * Compile-time guard. If the engine's `PlayerActionType` ever gains, loses or
 * renames a member, this assignment stops type-checking and the advisor cannot
 * silently drift out of sync with what the engine will actually accept.
 */
const STRATEGY_VOCABULARY_MATCHES_ENGINE: MutuallyAssignable<StrategyAction, PlayerActionType> =
  true;
void STRATEGY_VOCABULARY_MATCHES_ENGINE;

// ---------------------------------------------------------------------------
// Normalized decision state
// ---------------------------------------------------------------------------

/**
 * The normalized coordinates of a decision.
 *
 * Card values follow the engine's `cardValue`: **aces are 11**, every ten-value
 * card is 10. So `A,A` is `{ handClass: "pair", pairValue: 11, playerTotal: 12 }`
 * and a dealer ace is `dealerUpcardValue: 11`.
 */
export interface StrategyState {
  handClass: HandClass;
  /** Best total: a soft hand counts its ace as 11, so `A,7` is 18. */
  playerTotal: number;
  /** Value of each card of the pair. Required when `handClass` is `"pair"`. */
  pairValue?: number;
  /** Dealer upcard value, 2..10 or 11 for an ace. */
  dealerUpcardValue: number;
}

// ---------------------------------------------------------------------------
// Decisions
// ---------------------------------------------------------------------------

/**
 * One cell of a generated chart.
 *
 * `fallbackAction` is what makes "Double if allowed, otherwise Hit" and
 * "Surrender if allowed, otherwise Hit" expressible as data rather than as a
 * rule buried in the UI. It is populated whenever `recommendedAction` is an
 * action that can be illegal (`DOUBLE`, `SPLIT`, `SURRENDER`) and is always
 * itself `HIT` or `STAND`, so resolution can never dead-end on another
 * unavailable action.
 */
export interface StrategyDecision {
  key: string;
  rulesetId: string;
  rulesetVersion: number;
  handClass: HandClass;
  playerTotal: number;
  pairValue?: number;
  dealerUpcardValue: number;
  recommendedAction: StrategyAction;
  fallbackAction?: StrategyAction;
  /**
   * Solver output for this cell: expected net result **per unit of the original
   * wager**. Precomputed at generation time; see `ev.ts` — nothing solves during
   * rendering.
   */
  evs?: Readonly<Partial<Record<StrategyAction, number>>>;
  /**
   * The two probabilities the Analysis surface may show, from the same solve as
   * `evs`.
   *
   * Optional because a table generated before they existed is still a valid
   * table: a consumer that finds them absent must show nothing rather than
   * compute a substitute. That is the same fail-safe rule the recommendation
   * itself follows, applied one level down — an estimated probability presented
   * beside solver-exact EVs would be indistinguishable from one of them.
   */
  probabilities?: Readonly<StrategyProbabilities>;
}

/**
 * Probabilities attached to a cell.
 *
 * Per DECISION, not per action: both are properties of the position the player
 * is looking at — what one more card does to their hand, and how often the
 * dealer breaks from that upcard — and neither depends on which action is
 * eventually chosen.
 */
export interface StrategyProbabilities {
  /**
   * P(one more card busts this hand). Always 0 for a soft hand, which is a real
   * answer rather than a missing one.
   */
  bustIfHit: number;
  /**
   * P(the dealer busts), conditioned on the peek having found no natural —
   * the only state in which the player is ever asked to decide.
   */
  dealerBust: number;
}

// ---------------------------------------------------------------------------
// Tables
// ---------------------------------------------------------------------------

/**
 * Exactly how the numbers were produced. Written into every generated table so
 * an approximation can never be discovered only by reading the solver source.
 */
export interface StrategySolverMethod {
  dealerDistribution: string;
  /** True when the dealer distribution is conditioned on the peek finding no natural. */
  peekConditioning: boolean;
  playerDraws: string;
  splitModel: string;
  compositionBasis: string;
  /** Every approximation made, spelled out. Empty means the solve is exact. */
  approximations: readonly string[];
  /** Hard flag so a consumer can assert on it rather than parse prose. */
  infiniteDeckApproximationUsed: boolean;
}

export interface StrategyTableMetadata {
  generator: string;
  generatedAt: string;
  deckCount: number;
  /**
   * The rules the solver actually ran over, not just the id it was stamped
   * with. `lookupStrategyWithDiagnostics` re-derives this from the live ruleset
   * and refuses to serve the table when they differ, so a rule edited without a
   * version bump fails closed instead of answering from a chart solved for a
   * different game.
   */
  rulesSummary: Readonly<StrategyRulesSummary>;
  method: StrategySolverMethod;
  /**
   * Expectation per unit wagered when this chart is played from the top of a
   * six-deck shoe, insurance always declined. Negative is a house edge.
   */
  expectedValuePerUnit: number;
  entryCount: number;
}

export interface StrategyTable {
  rulesetId: string;
  rulesetVersion: number;
  metadata: StrategyTableMetadata;
  entries: Readonly<Record<string, StrategyDecision>>;
}

// ---------------------------------------------------------------------------
// Lookup results
// ---------------------------------------------------------------------------

export type StrategyResolution =
  /** The chart's recommended action was legal and is being served as-is. */
  | "RECOMMENDED"
  /** The recommended action was not legal; the cell's own fallback was used. */
  | "FALLBACK"
  /** SPLIT was not legal, so the matching hard/soft total row answered instead. */
  | "TOTAL_ROW";

export interface StrategyRecommendation {
  /** Guaranteed to be a member of the legal action set that was supplied. */
  action: StrategyAction;
  /** The cell the action was ultimately taken from. */
  decision: StrategyDecision;
  /** The cell originally addressed, which may differ under `TOTAL_ROW`. */
  matchedDecision: StrategyDecision;
  resolution: StrategyResolution;
  usedFallback: boolean;
}

export type StrategyDiagnosticCode =
  /** The supplied state is not a well-formed decision coordinate. */
  | "INVALID_STATE"
  /** No table is registered for the ruleset. */
  | "NO_TABLE"
  /** A table exists but is keyed to a different ruleset id or version. */
  | "RULESET_MISMATCH"
  /**
   * The id and version match, but a strategy-relevant rule does not: the
   * ruleset was edited without bumping `version`. The stamp says the table
   * fits; the rules say it does not, and the rules win.
   */
  | "RULES_MISMATCH"
  /** The table has no cell for this state. The advisor must stay silent. */
  | "NO_ENTRY"
  /** A cell exists but none of its actions are legal right now. */
  | "NO_LEGAL_RESOLUTION";

/**
 * Why a lookup produced nothing. Callers hide the recommendation and log this;
 * they must never substitute a guess.
 */
export interface StrategyDiagnostic {
  code: StrategyDiagnosticCode;
  message: string;
  key: string | null;
  rulesetId: string;
  rulesetVersion: number;
}

export interface StrategyLookupResult {
  recommendation: StrategyRecommendation | null;
  diagnostic: StrategyDiagnostic | null;
}

// ---------------------------------------------------------------------------
// Expected value
// ---------------------------------------------------------------------------

/** Expected net result of one action, per unit of the ORIGINAL wager. */
export interface ActionEV {
  action: StrategyAction;
  ev: number;
}
