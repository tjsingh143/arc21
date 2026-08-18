/**
 * Arc 21 — basic strategy, re-exported.
 *
 * The implementation lives in `supabase/functions/_shared/strategy/`. This file
 * is the entry point the client, the tests and the tooling import, so nothing
 * outside this barrel needs to know where the module physically sits.
 *
 * WHY IT SITS THERE, AND WHY THERE IS STILL ONLY ONE COPY
 *
 * The strategy leaderboard requires decisions to be graded by the SERVER — the
 * specification's "minimum 100 eligible server-authoritative decisions" — and
 * that means the advisor has to run inside the Edge runtime. It could not: every
 * attempt died with
 *
 *   failed to read file: open shared/strategy/index.js: no such file or directory
 *
 * Measured, not guessed. Working through it produced the actual rule, which was
 * previously written down in this repository as "a NEW file under shared/ will
 * not resolve" — close, but wrong about the cause:
 *
 *   * inside `supabase/functions`, an import specifier must be a literal `.ts`
 *     path. A `.js` specifier fails there even for a file that is definitely
 *     present — proven with a two-file probe inside the wholesale mount;
 *   * nested directories under `supabase/functions` are fine;
 *   * `shared/blackjack/*.js` and `shared/contracts/*.js` resolve because the
 *     CLI bind-mounts those individual files from the graph it walks at
 *     `supabase start`; `shared/strategy` was never in that set and could not be
 *     added, whether imported from a helper or from the function entrypoint,
 *     with a `.js` or a `.ts` specifier.
 *
 * So the module moved to the one place that provably mounts, and this barrel
 * keeps every other caller unchanged. There is exactly ONE implementation of
 * every function — moved, not copied — which is what invariant 7 asks for. Note
 * the specifier below is `.js`: this file is only ever loaded by Metro, tsc and
 * vitest, all of which resolve it, and never by the Edge runtime.
 */

export * from "../../supabase/functions/_shared/strategy/index.js";
