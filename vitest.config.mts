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
    /**
     * WHY `tests/server/**` NO LONGER RUNS BESIDE THE UNIT SUITE AT ALL.
     *
     * `npm test` used to be one `vitest run` over everything, and on a loaded
     * machine it failed roughly one run in three — always in one of the two
     * places that hold a real clock or a real race open:
     *
     *   × accepts exactly one of twenty simultaneous commands   90065ms  (timeout)
     *   × sends the recommendation on a Learn table            120082ms  (timeout)
     *
     * Neither is a product defect and both pass alone in seconds. The cause is
     * that `tests/server/**` drives ONE local Edge-runtime container over HTTP:
     * ten files at full parallelism queue behind a single Deno instance, and a
     * test that fires twenty simultaneous commands at it while nine other files
     * are mid-command exceeds any budget you give it. Reproduced deliberately —
     * three consecutive `npm test` runs with three background unit suites
     * loading the host, one failed — rather than retried until it passed.
     *
     * So `npm test` is now the two halves in SEQUENCE, and the server half runs
     * `--maxWorkers=2`. Everything still runs exactly once, nothing is skipped,
     * and the run stopped depending on how busy the machine happens to be. CI
     * always split them across two jobs; this makes a local run match.
     */
    /**
     * `tests/server/**` is excluded from the COVERAGE run for the same reason,
     * arrived at by measurement rather than by preference.
     *
     * Those suites drive the REAL Edge Functions over HTTP, inside Docker. The
     * v8 instrumentation here sees the test file and nothing else, so they
     * contribute **exactly zero** to the numbers the thresholds below are
     * measured against — verified by running the coverage report with and
     * without them and comparing: `66.65% / 62.71% / 64.24% / 68.67%` either
     * way, to the decimal.
     *
     * What they DO contribute is 140 seconds and two intermittent failures. Both
     * of the tests involved are wall-clock or concurrency sensitive — twenty
     * simultaneous commands raced at one version, and a sixteen-second real wait
     * for a betting deadline to lapse — and under full file parallelism plus v8
     * instrumentation the machine is oversubscribed enough for them to miss.
     * Measured: at default parallelism the run took 162s and failed a different
     * one of the two on each attempt; at `--maxWorkers=2` it passed in 76s; with
     * these excluded it passes in 18s.
     *
     * They are not being skipped. `npm test` runs them, `npx vitest run
     * tests/server` runs them, and both must be green — this only stops a
     * coverage GATE from depending on a fifteen-second timer, which is the kind
     * of failure that teaches people to re-run a gate instead of reading it.
     */
    exclude: [
      "**/node_modules/**",
      "**/dist/**",
      ...(process.env.COVERAGE === "1"
        ? [
            "tests/strategy/solver.test.ts",
            // Same reason and the same cost: it solves the whole six-deck chart
            // exactly, to prove the committed table is byte-for-byte what the
            // solver emits. Thirty seconds under instrumentation buys nothing —
            // the module it exercises is `scripts/`, which no gate measures.
            "tests/strategy/generated-table.test.ts",
            "tests/server/**",
          ]
        : []),
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
        /*
         * THE CAREER LOGIC, at the path where it actually lives.
         *
         * This gate used to read `shared/career/**` and it MEASURED NOTHING.
         * The career module was MOVED to `supabase/functions/_shared/career/`
         * so the Edge runtime could resolve it, and `shared/career/*.ts` is now
         * five seven-line `export *` shims plus an `index.ts` that
         * `coverage.exclude` skips. A re-export has no executable statements, so
         * v8 reports nothing for it and a threshold over it passes whatever the
         * number is.
         *
         * Proved rather than reasoned: setting this bar to 100/100/100/100 at
         * the old path still exits 0 with no error. Eighteen career nodes, the
         * star evaluation and the progression record were behind a gate that
         * could not fail.
         *
         * CLAUDE.md already records this exact trap for `shared/strategy` — "a
         * coverage threshold that matches no files reads as enforcement" — and
         * it had happened a second time, to the module moved in the same
         * commit, without anybody noticing. When you move code, check the gate
         * still points at it.
         *
         * The numbers are the old ones, unchanged: they were chosen as the
         * honest bar for this module and they sit just under what it measures
         * (72.61 / 63.51 / 79.24 / 79.12), so the gate ratchets rather than
         * aspires. It just applies to the code now.
         */
        "supabase/functions/_shared/career/**": {
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
