# Arc 21 Launch State

**Current Phase:** 3 — Database / Auth (not started)
**Last Completed Phase:** 2 — Practice / Learning / Local Persistence (PASS, 2026-08-24)

Detailed evidence lives in `docs/phase-reports/`. This file is the index a fresh
context reads first. `docs/FINALIZATION_STATUS.md` remains the historical ledger
and `docs/AUDIT.md` grades every area by HOW it was verified.

---

## Phase Status

| Phase | Status | One-line basis |
|-------|--------|----------------|
| 0 — Baseline | **PASS** | Every gate below run and green on 2026-08-24. |
| 1 — Blackjack Engine | **PASS** | 471 engine tests; six defects fixed, each regression proved to fail without its fix. |
| 2 — Practice / Learning / Local Persistence | **PASS** | Nine defects fixed, each regression proved to fail without its fix; kill/resume verified on device with the same CARDS, not just the same bankroll. |
| 3 — Database / Auth | IN PROGRESS | Built; 453 pgTAP assertions pass; auth boundary RAN. |
| 4 — Economy / Server Solo | IN PROGRESS | Built; escrow/idempotency/overflow all graded RAN. |
| 5 — Mobile Product / Career / Stats | IN PROGRESS | Built; `career-node.yaml` and `every-screen.yaml` RAN. |
| 6 — Social / Private Multiplayer | IN PROGRESS | Built; `private-lobby.yaml` passed 37 steps against a real server. |
| 7 — Public Multiplayer | IN PROGRESS | Built; `online-table.yaml` RAN. |
| 8 — Sprint Tournament | IN PROGRESS | Built; TESTED, with a documented pool-drain fix for a real flake. |
| 9 — Daily / Leaderboards / Cosmetics | IN PROGRESS | Built; the daily-challenge intermittent is CLOSED (see below). |
| 10 — Backend/API Security | IN PROGRESS | Built; IDOR sweep over 32 tables with two real JWTs. |
| 11 — Adversarial QA / E2E / CI | IN PROGRESS | 4 Maestro flows exist; **CI has never run on a runner**. |
| 12 — Production Release Candidate | **EXTERNAL BLOCKER** | Needs Apple/Play/EAS/domain/Supabase-cloud credentials. |

**IN PROGRESS here means:** substantial implementation exists and is locally
green — it does NOT mean this launch sequence has validated or signed the phase
off. Treat every one as unverified until its own phase runs.

---

## Architecture truths a future phase must not rediscover

`CLAUDE.md` is authoritative and long; these are the ones that bite first.

- **One engine.** `shared/blackjack` is runtime-neutral. Never write a second
  implementation of a rule. Phase 1 found the one that existed: the dealer's
  drawing rule was in `playDealer` AND in `scripts/strategy-solver.ts`, so the
  strategy chart could be solved for a dealer the engine does not deal. It is now
  `dealerMustDraw` in `hand-value.ts`, called by both.
- **A disconnected seat is a DEPARTED seat.** `connected` is cleared by LEAVE, by
  a closure and by tournament elimination, and nothing ever sets it back, so
  `openBetting` sits it out. Before phase 1 a player who left mid-hand kept being
  staked the table minimum every hand by the betting timeout.
- **Three definitions mirror the engine's vocabularies** — the TS union, a Zod
  enum in `shared/contracts`, and a Postgres enum in the foundation migration.
  `tests/engine/status-taxonomy.test.ts` compares all three; add a value to one
  and you must add it to the others.
- **`toPublicState()` is the only sanitisation boundary.** Undealt cards and the
  unrevealed hole card never leave the server.
- **Integer chips only**; chips move only through `apply_wallet_delta`; identity
  comes from the verified JWT.
- **Edge-function imports:** reaching into `shared/` uses `.js` specifiers
  resolved by a PER-FUNCTION `deno.json` import map; everything WITHIN
  `supabase/functions` uses `.ts`. A new function directory without a copy of
  that map takes the WHOLE stack down at startup.
- **`supabase/functions` is excluded from `tsconfig.json`** — it is typechecked
  only by `npm run check:functions`.
- Server-needed code lives in `supabase/functions/_shared/`; `shared/` holds a
  one-line barrel re-exporting it.
- **Practice statistics and the Practice session are SEPARATE records.**
  `practice:stats` and `practice:session`, written statistics-first. They shared
  one blob before phase 2, so any reason to reject a session — a truncated write,
  a schema bump, a ruleset change — destroyed the player's entire history along
  with it.
- **Failing safe on strategy is THREE things, not two:** play continues, the
  recommendation is hidden, and the reason is RECORDED
  (`features/practice/strategy-diagnostics.ts`). Without the third, a hole in the
  tables is indistinguishable from an advisor with nothing to say.
- **A label on a `Pressable` REPLACES the text of everything inside it on iOS.**
  So a scrim that wraps a sheet silences the sheet. Both Practice sheets did
  this; the dismiss target is now a sibling occupying the visible scrim only.
  This has now bitten three times (the Home card, the accessibility switches,
  these two sheets) — always invisibly, always with a perfect screenshot.

## Current migration head

`supabase/migrations/20260824020000_cosmetic_unlock_fallthrough.sql`
(43 migrations, all applied from scratch cleanly on 2026-08-24).

## Important contracts / interfaces

- `shared/contracts` — wire schemas. Strict; a non-strict schema once silently
  DELETED `canStartNextHand` and stopped every online table after hand one.
- `supabase/functions/_shared/session-economics.ts` — the single answer to which
  modes are wallet-backed. Getting it wrong mints chips.
- `_shared/session-boundary.ts` — competition shape; never touches a card.
- `_shared/decision-grading.ts` — `ACCURACY_ELIGIBLE_MODES` allowlist.
- `tests/server/call-function.ts` — the ONE way a server test calls a function.
  Replays a 5xx with a byte-identical body (same idempotency key).
- `tests/server/stack-guard.ts` — the ONE probe deciding whether server tests
  run. Requires a 401 AND a sub-500 answer to a real command.

## Known unresolved defects

None blocking. Recorded observations, all assigned onward:

1. **Local edge runtime is load-gated** (environment, not product). Above host
   load ~12 the runtime hits CPU soft/hard limits and retires workers; the
   stack-guard's 5 s probe then reports a healthy stack as absent. Measured:
   6 concurrent requests at load 13–16 → 3 answered, 3 × HTTP 504 after 150 s;
   the same 4-way test at load 5.8 → all under 0.2 s. **Run the server suite on
   an idle machine**, exactly as `CLAUDE.md` already requires for Maestro.
2. **`rate_limit_events` FK violation for a non-existent user** — a validly
   signed token for an account that does not exist cannot have its rate limit
   recorded (`rate_limit_events_user_id_fkey`). Logged as a warning and handled;
   unreachable in production, where tokens are minted only for real accounts.
   → **Phase 10.**
3. **`supabase start` reports containers unhealthy on this host** (`vector`,
   `analytics`, `storage`) while the containers themselves work. Use
   `supabase start --ignore-health-check`. Environment, not repo.
4. **CI has never executed on a runner.** Every step has been run locally in the
   workflow's order. → **Phase 11.**

## External blockers

Apple Developer, Play Console, Expo/EAS project id, a domain, a Supabase cloud
project, APNs/FCM credentials, a physical iOS device. Documented in
`docs/RELEASE.md`. None blocks Phases 1–11.

## Last known green verification — 2026-08-24 (end of phase 2)

```
npx tsc --noEmit                    exit 0
npm run lint                        0 errors (37 warnings)
npm run check:functions             all 3 Edge Functions typecheck
npm run strategy:generate           380 cells, 21.9 s, expectation -0.3345%/unit, 0 disagreements
npm run test:unit                  103 files / 2,017 tests PASS   (phase 1: 94 / 1,901)
npm run test:coverage              101 files / 1,991 tests, every gate met
                                    shared/blackjack        98.76/95.85/100/99.70
                                    _shared/strategy        98.12/94.40/100/99.29
                                    src/features/practice   94.01/82.56/95.91/97.80  (NEW gate)
npm run test:server                 13 files /   116 tests PASS  (live stack)
maestro practice-hand.yaml          PASS
maestro practice-resume.yaml        PASS   (extended: same cards, no duplicate settlement)
maestro practice-analysis.yaml      PASS   (new)
maestro career-node.yaml            PASS   (28 steps, after a selector fix)
```

Phase 1's figures, unchanged by phase 2 and not re-run: `supabase db reset` (43
migrations + seed, clean), `supabase test db` (23 files / 453 assertions),
`npm run benchmark` (1204-1347 us/hand).

**Not re-run in phase 2:** `every-screen.yaml` — a `.env.local` is present and
that flow asserts ".*no server configured.*" in five places, true only of an
unconfigured build. Move it aside or expect those five to fail; it is not a
regression. Also not re-run: `supabase db lint`, `npm run contrast:check`,
`expo-doctor`, `expo export` and the benchmark — phase 2 changed no schema, no
colour token and no engine hot path.

**Benchmark note:** both figures above sit well over the 752-808 us/hand
`CLAUDE.md` records. That is this host today, not a regression — proved by
stashing the phase-1 changes and re-measuring, rather than by comparing against a
written-down number.

## How to bring the stack up — THE PART THAT WASTED A WHOLE SESSION

```bash
export PATH="/opt/homebrew/bin:$PATH"
supabase start --ignore-health-check
supabase functions serve --no-verify-jwt     # ← REQUIRED, and not optional
```

`supabase start` alone leaves the functions unable to reach Postgres. Its
containerised edge runtime is injected
`SUPABASE_DB_URL=…@supabase_db_arc21:5432` — the container NAME — and Deno's
resolver refuses to parse a DNS label containing an underscore, so every command
answers `HTTP 500 INTERNAL … getaddrinfo ENOTFOUND`. `supabase functions serve`
is injected `…@db:5432`, the underscore-free network ALIAS, and works. Full
proof in `docs/phase-reports/phase-00.md`. CI already does this correctly.

## Exact next phase

**Phase 3 — Database / Auth.** Do not start it from this file alone: read
`docs/phase-reports/phase-02.md` and `CLAUDE.md` for the invariants.

Four things phase 2 leaves for a later phase to know.

1. **`src/features/practice` is now a COVERAGE-GATED area** (92/80/94/96 in
   `vitest.config.mts`), and the gate is proved to fail when breached. Two React
   hooks in that directory are excluded by name because React Native cannot be
   parsed under Node.
2. **Strategy cells now carry `probabilities`** (`bustIfHit`, `dealerBust`),
   emitted by the solver and optional on the type. A consumer that finds them
   absent must render nothing rather than compute a substitute — the same
   fail-safe rule as the recommendation itself, one level down.
3. **A deep link is how a Maestro flow should reach a screen.** Two flows lost
   runs this phase to selectors that COMPLETED against the wrong destination or
   against an unreadable hierarchy. `arc21://game/practice` and `arc21://career`
   both land directly.
4. **`every-screen.yaml` has still never been walked against a configured
   build.** It asserts what a screen *says* in one configuration. → Phase 11.
