/**
 * The strategy advisor, reachable from the Edge runtime.
 *
 * Grading a decision is a rule, and this project has exactly one implementation
 * of every rule — so this re-exports the real module rather than copying it. The
 * specifier is a literal `.ts` path because that is the only form the Edge
 * runtime resolves; see `shared/strategy/index.ts` for the measurement behind
 * that, and for why the module physically lives under `supabase/functions`.
 */

export { adviseAction, adviseActionWithDiagnostics } from "./strategy/index.ts";
export type { StrategyRecommendation, StrategyState } from "./strategy/index.ts";
