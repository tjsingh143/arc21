import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    /**
     * The strategy solver's own tests are excluded from the COVERAGE run only.
     *
     * They re-solve split EVs from scratch — deep recursion over a real
     * six-deck composition — which takes seconds normally and **17 minutes**
     * under v8 instrumentation. Nothing is lost by skipping them there: the
     * solver lives in `scripts/`, which coverage does not measure, so these
     * tests contribute no coverage to the thresholds below. They still run, and
     * must still pass, on every ordinary `npm test`.
     *
     * The alternative — a 20-minute timeout — would make a genuine hang
     * indistinguishable from normal operation.
     */
    exclude: [
      "**/node_modules/**",
      "**/dist/**",
      ...(process.env.COVERAGE === "1" ? ["tests/strategy/solver.test.ts"] : []),
    ],
    environment: "node",
    /**
     * The strategy solver tests run exact six-deck recursions that take several
     * seconds each. They pass comfortably in isolation but exceed Vitest's 5s
     * default when the suite runs files in parallel and they are competing for
     * CPU — producing a failure that depends on machine load rather than on
     * correctness. A test that only fails under contention is worse than a slow
     * one: it teaches people to re-run CI instead of reading it.
     */
    testTimeout: 30_000,
    /**
     * Hooks get the same allowance. Several suites build their fixtures once in
     * a `beforeAll` — the drill pools and the full strategy chart are computed,
     * not hardcoded — and those exceed the 10s hook default under v8 coverage
     * instrumentation or when the machine is busy. The resulting failure looks
     * like a broken test and is really a busy CPU.
     */
    hookTimeout: 30_000,
    coverage: {
      provider: "v8",
      /*
       * `supabase/functions/_shared` is measured too, and that is not optional.
       *
       * The strategy module lives there now — moved because the Edge runtime
       * cannot resolve it anywhere else — and when it moved, `shared/**` stopped
       * matching it and the 90% gate below silently passed against zero files. A
       * threshold that matches nothing is worse than no threshold: it reads as
       * enforcement.
       *
       * The same directory also holds the tournament format, the daily challenge
       * and the decision grader, all of which decide a placement, a prize or a
       * leaderboard standing.
       */
      include: ["shared/**/*.ts", "supabase/functions/_shared/**/*.ts"],
      exclude: [
        "shared/**/index.ts",
        "supabase/functions/_shared/**/index.ts",
        // Generated data, not logic: a 453-line lookup table emitted by the EV
        // solver. `tests/strategy/` asserts its CONTENTS cell by cell, which is
        // the thing worth checking about it.
        "supabase/functions/_shared/strategy/generated-*.ts",
      ],
      /**
       * Thresholds are per-area, not one global number.
       *
       * A single blanket figure gets gamed in one of two ways: a well-tested
       * core hides a weak newcomer behind a good average, or a weak newcomer
       * drags the whole gate down until someone lowers it for everyone. Both
       * end with the number meaning nothing.
       *
       * The engine, strategy and money primitives decide outcomes and chips, so
       * they hold the 90% bar the specification asks for. Career is progression
       * logic — real, but it cannot mis-settle a wager — so it carries its own
       * honest bar, to be raised as the session runner lands.
       */
      thresholds: {
        "shared/blackjack/**": {
          statements: 90,
          branches: 90,
          functions: 90,
          lines: 90,
        },
        "supabase/functions/_shared/strategy/**": {
          statements: 90,
          branches: 90,
          functions: 90,
          lines: 90,
        },
        /*
         * The pure logic under `supabase/functions/_shared`, gated file by file.
         *
         * Only these are gated, and that is deliberate. The rest of that
         * directory is server plumbing — the Postgres client, the JWT verifier,
         * the HTTP envelope, the repository — which is exercised by
         * `tests/server/` against the RUNNING functions and therefore scores zero
         * under unit instrumentation. A directory-wide threshold would average
         * real logic against untestable plumbing and mean nothing.
         *
         * Each bar sits just under what the module actually measures, so it
         * ratchets rather than aspires: it fails when coverage drops, not before
         * someone has earned it.
         */
        "supabase/functions/_shared/tournament-format.ts": {
          statements: 90,
          branches: 75,
          functions: 90,
          lines: 90,
        },
        "supabase/functions/_shared/daily-challenge.ts": {
          statements: 95,
          branches: 95,
          functions: 95,
          lines: 95,
        },
        "supabase/functions/_shared/decision-grading.ts": {
          statements: 85,
          branches: 80,
          functions: 90,
          lines: 90,
        },
        /*
         * The push sender's pure half. It decides what a device receives and
         * what the delivery record says — including the distinction between
         * `sent` and `mocked`, which is the difference between an audit trail
         * and a comforting number.
         */
        "supabase/functions/_shared/push-message.ts": {
          statements: 90,
          branches: 85,
          functions: 90,
          lines: 90,
        },
        "supabase/functions/_shared/session-economics.ts": {
          statements: 95,
          branches: 95,
          functions: 95,
          lines: 95,
        },
        "supabase/functions/_shared/settlement-accounting.ts": {
          statements: 95,
          branches: 95,
          functions: 95,
          lines: 95,
        },
        "shared/career/**": {
          statements: 70,
          branches: 60,
          functions: 75,
          lines: 75,
        },
        /*
         * Progression sits at the engine bar rather than the career one. XP is
         * not money, but it decides levels, unlocks and leaderboard standing, so
         * a wrong answer here is as visible to a player as a wrong payout — and
         * the module is small enough that there is no excuse for gaps.
         */
        "shared/progression/**": {
          statements: 90,
          branches: 90,
          functions: 90,
          lines: 90,
        },
      },
    },
  },
});
