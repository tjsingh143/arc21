# Arc 21 Launch State

**Current Phase:** 2 — Practice / Learning / Local Persistence (not started)
**Last Completed Phase:** 1 — Blackjack Engine (PASS, 2026-08-24)

Detailed evidence lives in `docs/phase-reports/`. This file is the index a fresh
context reads first. `docs/FINALIZATION_STATUS.md` remains the historical ledger
and `docs/AUDIT.md` grades every area by HOW it was verified.

---

## Phase Status

| Phase | Status | One-line basis |
|-------|--------|----------------|
| 0 — Baseline | **PASS** | Every gate below run and green on 2026-08-24. |
| 1 — Blackjack Engine | **PASS** | 471 engine tests; six defects fixed, each regression proved to fail without its fix. |
| 2 — Practice / Learning / Local Persistence | IN PROGRESS | Built; RAN (`practice-hand.yaml`, device SQLite inspected). |
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

## Last known green verification — 2026-08-24

```
npx tsc --noEmit                    exit 0
npm run lint                        0 errors (38 warnings)
npm run check:functions             all 3 Edge Functions typecheck
npx vitest run tests/engine         17 files /   471 tests PASS   (phase 1: was 209)
npm run test:unit                   94 files / 1,901 tests PASS   (phase 0: 86 / 1,639)
npm run test:server                 13 files /   116 tests PASS  (load ~5, 0 absorptions)
npm run test:coverage               exit 0 — every gate met; shared/blackjack 98.76/95.85/100/99.70
supabase db reset                   43 migrations + seed, clean
supabase test db                    23 files /   453 assertions PASS
npm run benchmark                   1204-1347 us/hand (stashed baseline 1204-1246 on the same host)
```

**Not re-run in phase 1:** the four Maestro E2E flows (need an idle host, a
booted simulator and a debug build), `supabase db lint`, `npm run contrast:check`,
`expo-doctor` and `expo export` — phase 1 changed no schema, no colour and no
asset. All were green in phase 0 and nothing since touches them.

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

**Phase 2 — Practice / Learning / Local Persistence.** Do not start it from this
file alone: read `docs/phase-reports/phase-01.md` for what the engine now
guarantees and `CLAUDE.md` for the invariants.

Two things phase 1 leaves for phase 2 to know. `src/features/practice/
persistence.ts` proves a restored blob by issuing one `ADVANCE` — the engine's
round-trip safety is now tested directly in `tests/engine/serialization.test.ts`,
so a Practice resume failure is a persistence-layer question, not an engine one.
And `tests/helpers/engine-harness.ts` now REFUSES a fixture shoe shorter than the
52-card safety reserve: such a fixture used to be silently reshuffled away by
`startSession` and the test then ran against random cards.
