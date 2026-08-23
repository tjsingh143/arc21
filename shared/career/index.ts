/**
 * Arc 21 — the career module, re-exported.
 *
 * The implementation lives in `supabase/functions/_shared/career/`. This barrel
 * and its five neighbours are the entry points the client, the tests and the
 * tooling import, so nothing outside them needs to know where the module
 * physically sits.
 *
 * WHY IT MOVED, AND WHY THERE IS STILL ONLY ONE COPY
 *
 * The specification puts career rewards on the server — "Career rewards |
 * Server", and "any reward-bearing attempt requires server authority" — so
 * `evaluateStars`, `buildDrillScenarios` and `gradeDrillDecision` have to run
 * inside the Edge runtime. They could not: `shared/career/**` is not in the set
 * of files the Supabase CLI bind-mounts, and no import-map entry can add a file
 * that is not in the container. `shared/strategy` hit the same wall first and
 * documents the mechanism in full.
 *
 * So the module MOVED — not copied — and these barrels keep every call site
 * unchanged. There is exactly one implementation of every function they name,
 * which is what invariant 7 asks for.
 *
 * The specifiers below are `.js`: these files are only ever loaded by Metro,
 * tsc and vitest, all of which resolve them, and never by the Edge runtime.
 */

export * from "../../supabase/functions/_shared/career/index.js";
