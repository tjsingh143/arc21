# Arc 21

A simulated blackjack game for iOS and Android — clean, portrait-first, and
mathematically transparent. Expo (React Native) client, Supabase backend.

> **Arc 21 is a temporary development codename.** It has not been
> trademark-cleared.

> **This is a simulated card game.** Virtual chips have no monetary value. They
> cannot be withdrawn or exchanged for money or prizes. There is no real-money
> gambling, no cash-out, and no in-app purchases.

---

## Status

**Latest integrated milestone: Refresh C — AI Tables.** The feature was merged
into `main` on October 19, 2026 via [PR #5](https://github.com/tjsingh143/arc21/pull/5)
([merge commit](https://github.com/tjsingh143/arc21/commit/9eba544ca2d7fb115dc75dcdd0ec078cea479564)).
It adds server-authoritative computer opponents, AI-table UI and lifecycle,
cross-mode admission protections, and two forward database migrations.

The final independent Refresh-C review reported **PASS**. The integrated
feature-branch revision also passed [both hosted CI jobs](https://github.com/tjsingh143/arc21/actions/runs/39218823512):
3,056 unit tests, 3,030 coverage tests with all gates satisfied, 439 server
tests, 672 database assertions, and a clean replay of 63 migrations. Expo
Doctor passed 21/21 checks and the iOS Hermes bundle completed at 6.5 MB.
See the separate [post-merge `main` workflow](https://github.com/tjsingh143/arc21/actions/runs/39305983730)
for its independently reported result.

**Previous milestone: Refresh B.** Its October 4, 2026 closure review passed
2,907 unit tests, 392 server tests and 640 SQL assertions at that checkpoint;
both [hosted CI jobs](https://github.com/tjsingh143/arc21/actions/runs/37243705811)
also passed at `059ee0ba9b848254fecd024daae7e2a60be374aa`.
These are historical results, not current Refresh-C test totals.

Refresh D (Home and Play product hierarchy) has a local implementation awaiting
independent review, recorded in
[refresh-d.md](./docs/astra-refresh/refresh-d.md); it is not published to
GitHub or merged. Refresh E has not begun. Source integration is **not** a production
deployment: store submission, hosted application/backend activation, Android
builds, physical-device testing and live push delivery remain outside the
verified release evidence.

Where to read the current state:

- [Launch state](docs/LAUNCH_STATE.md) — current integration and release index.
- [Refresh C](docs/astra-refresh/refresh-c.md) — feature, historical findings,
  fixes and verification.
- [Release readiness](docs/RELEASE.md) — deployment dependencies and limits.
- [Refresh B closure](docs/astra-refresh/refresh-b.md#26-closure-verification-audit--october-4-2026)
  — prior milestone evidence.
- [SDK maintenance history](docs/CI_MAINTENANCE_2026_10_11.md) — October 11
  checkpoint; later patch alignment is recorded in PR #5.
- [Dependency disposition](docs/astra-refresh/dependency-disposition.md)
  — historical security-advisory assessment.

## Getting started

Requires Node 22+, plus Docker and the Supabase CLI for the backend. Hosted CI
pins Node 26; the October 11 portable maintenance checks also passed on Node 24.19.0.

```bash
npm ci
npm run typecheck
npm run lint
npm run test:unit            # unit suites, no stack required

npm run db:start            # applies the documented local PostgREST pin
supabase db reset --local
supabase test db
```

Keep the Edge Functions running in a second terminal:

```bash
supabase functions serve --no-verify-jwt   # the functions still verify JWTs
```

Then run `npm run test:server` in the first terminal. It fails rather than skips
when the backend is absent.

Copy `.env.example` to `.env.local` to point the app at a server; without it the
app runs Practice offline and says that no server is configured. Only
`EXPO_PUBLIC_` values reach the bundle — never put a server secret there.

The full command set (Edge Function typecheck, coverage gates, contrast, bundle
check, iOS Release builds and Maestro flows) is in [AGENTS.md](AGENTS.md), and
the hard-won operational notes behind it are in [CLAUDE.md](CLAUDE.md).

## Layout

| Path | Contents |
|------|----------|
| `app/` | Expo Router screens |
| `src/` | Client components, design tokens, feature stores and gateways, platform libraries |
| `shared/blackjack/` | The single runtime-neutral game engine, used by client, server and tests |
| `shared/contracts/` | Strict request/response schemas |
| `shared/strategy/`, `shared/career/`, `shared/progression/` | Re-exports of canonical server-side learning and progression logic |
| `supabase/migrations/` | Database schema, RLS, grants and product catalogues |
| `supabase/functions/` | Edge Functions: `create-session`, `game-command`, `send-notifications` |
| `supabase/tests/` | pgTAP authorization and database assertions |
| `tests/` | Vitest unit and server-integration suites; `tests/e2e/` holds Maestro flows |
| `scripts/` | Strategy-table, audio and art generators; local test tooling |
| `assets/` | App icon, splash and generated sound palette |
| `docs/` | Architecture, rules, security, privacy, release and audit records |

Native `ios/` and `android/` projects are generated by `expo prebuild` and are
not tracked.

## Documentation

Current reference:

- [Architecture](docs/ARCHITECTURE.md) — engine, authority boundaries, command model
- [Blackjack rules](docs/BLACKJACK_RULES.md) — Arc Standard, settlement, fairness invariants
- [Database](docs/DATABASE.md) — schema, ledger, migrations
- [Security](docs/SECURITY.md) — threat model, RLS, money integrity
- [Test plan](docs/TEST_PLAN.md) and [audit grades](docs/AUDIT.md)
- [Privacy](docs/PRIVACY.md), [Terms](docs/TERMS.md), [Responsible play](docs/RESPONSIBLE_PLAY.md)
- [Store listing](docs/STORE_LISTING.md), [Routes](docs/ROUTES.md), [Asset licenses](docs/ASSET_LICENSES.md)

Historical records, kept as evidence rather than as current instructions:

- `docs/phase-reports/` — per-phase reports, phases 0–11
- `docs/FINAL_RELEASE_REPORT.md` — phase 12 release-candidate report
- `docs/FINALIZATION_STATUS.md`, `docs/IMPLEMENTATION_STATUS.md` — earlier status trackers
- `docs/astra-refresh/REFRESH-A-HANDOFF.md`, `docs/astra-refresh/NEXT.md` —
  in-progress Refresh A checkpoints, superseded by the baseline audit

## Core invariants

The engine exists to make these true, and the test suite exists to keep them true:

- One implementation of the rules, shared by client, server and tests.
- Production shuffles use a CSPRNG with unbiased Fisher-Yates. `Math.random()`
  never determines gameplay.
- Cards are never modified in response to wins, losses, purchases, engagement,
  player level or desired drama.
- Clients never receive undealt cards or the unrevealed dealer hole card.
- Chips are integers. No floating-point arithmetic touches a balance.
- The shoe is never reshuffled mid-hand, and a card is never fabricated.
- Identity comes from the verified JWT; the server is authoritative for every
  wallet, seat, result and score.

## Code excerpts

[Verified code excerpts](docs/CODE_SAMPLES.md) provide direct source links for the main implementation boundaries.

## Review material

[Project portfolio](https://drive.google.com/drive/folders/1TZOI26W1vDebR4cEnA-JnhNpGNTCFuOY) contains the project overview, architecture,
code examples, testing notes, and supporting evidence. Portfolio measurements
retain their stated snapshot and verification boundaries.

[Review entry point](https://drive.google.com/file/d/1MLABU2Y_iZAQuzPHN2MqA0qQuWsqjAL-/view?usp=drivesdk) · [Overview](https://drive.google.com/file/d/1JOdDQEyl_TtFdlJOov9uHfI00MnqHFAV/view?usp=drivesdk) · [Testing](https://drive.google.com/file/d/1BXVJ2G-8JGh8UvxOyzuIS9rvEPVNktPm/view?usp=drivesdk) · [Code samples](https://drive.google.com/file/d/13V14LeAI4aziC_QEEYzQYtlsF2ndLjG4/view?usp=drivesdk)
