# Arc 21 Launch State

**Current Phase:** 1 — Blackjack Engine (not started)
**Last Completed Phase:** 0 — Baseline (PASS, 2026-08-24)

Detailed evidence lives in `docs/phase-reports/`. This file is the index a fresh
context reads first. `docs/FINALIZATION_STATUS.md` remains the historical ledger
and `docs/AUDIT.md` grades every area by HOW it was verified.

---

## Phase Status

| Phase | Status | One-line basis |
|-------|--------|----------------|
| 0 — Baseline | **PASS** | Every gate below run and green on 2026-08-24. |
| 1 — Blackjack Engine | IN PROGRESS | Built; AUDIT grades it RAN. Not signed off under this sequence. |
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
  implementation of a rule.
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
npm run test:unit                   86 files / 1,639 tests PASS
npm run test:server                 13 files /   116 tests PASS  (load 5.8, 0 absorptions)
npm run test:coverage               exit 0 — 84 files / 1,613 tests, every gate met
supabase test db                    23 files /   453 assertions PASS
supabase db lint                    No schema errors found
npm run contrast:check              exit 0
npx expo-doctor@latest              21/21
npx expo export --platform ios      6.1 MB Hermes bundle
```

**Not re-run this phase:** the four Maestro E2E flows (need an idle host, a
booted simulator and a debug build) and `npm run benchmark`.

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

**Phase 1 — Blackjack Engine.** Do not start it from this file alone: read
`docs/phase-reports/phase-00.md` for the baseline evidence and `CLAUDE.md` for
the invariants. Phase 0 changed no product code.
