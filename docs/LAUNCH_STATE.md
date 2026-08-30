# Arc 21 Launch State

**Current Phase:** 5 — Mobile Product / Career / Stats (not started)
**Last Completed Phase:** 4 — Economy / Server Solo (PASS, 2026-08-30)

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
| 3 — Database / Auth | **PASS** | Seven defects fixed, each regression proved to fail without its fix; the account lifecycle run end to end against the real GoTrue. |
| 4 — Economy / Server Solo | **PASS** | Three defects fixed, each regression proved to fail without its fix; every economic command replayed, every modified-client attack run against the live stack. |
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
- **Account deletion is TOTAL and refuses for exactly one reason.** It is
  refused only while the caller still HOLDS a seat (`active` or `disconnected`)
  at a running table — a `left` seat is already settled, and refusing on one
  told a player to leave a table they had left. A lobby the departing player
  hosts is handed over through `leave_room`, never deleted from under the
  players in it. `23_account_lifecycle.test.sql` asks the CATALOGUE which
  cascading references survive, so a new table with a user column and no cascade
  fails it without anybody editing it.
- **A foreign key anonymises a REFERENCE, not the copy beside it.**
  `game_session_seats.display_name` is a copy of the profile's name; nothing
  cleared it, so a deleted player stayed named on every table they had sat at.
  Deletion now sets it to `Deleted player` explicitly.
- **A uniqueness pre-check is advisory.** `handle_new_user` checks whether a
  handle is taken and then inserts it; concurrent signups for one handle gave
  the loser HTTP 500 and no account. The insert now catches `unique_violation`
  on `profiles_username_key` and derives a fresh handle. Third version of this
  same bug — see `docs/DATABASE.md`.
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

- **A live seat must be ADDRESSABLE, not just refusable.** Every online mode
  refuses a second buy-in while a seat is held, and the game id reached the
  client once — in the reply to the buy-in — and lived only in a route
  parameter. Losing it locked the account out of Quick Play, Public Tables and
  Career for ever with the buy-in stranded, and all three refusals advised the
  player to "leave that table first". `public.my_active_session()` is the ask
  that was missing; its predicate is `assertNoOtherLiveSeat`'s, and the server
  suite asserts they agree by provoking the refusal rather than by comparing two
  copies of a predicate.
- **A solo or career table has no clocks on purpose**, so `RESOLVE_TIMEOUT`
  cannot rescue a hand its player walked away from and nothing marks a session
  abandoned. The way back is the only way back.
- **XP has no idempotency key**, so anything that grants it must ride on
  something that does — `career_progress.reward_claimed_at` for a career reward.
  The chips were always safe; the ledger's unique key sees to that.
- **A replayed command's payload is not byte-identical.** It is served from
  `private.game_commands` as `jsonb`, which sorts keys by length then bytewise.
  Same value, different bytes: assert equality of the parsed body.
- **`LOCK_BET` can settle the hand.** A natural — the player's or the dealer's —
  lands on HAND_COMPLETE inside the same cascade, so a test that assumes
  PLAYER_TURNS after locking passes about fifteen times in sixteen. Deal again
  rather than retrying the assertion.
- **An inert `SurfaceCard` is the right shape and used to be unaddressable.**
  With no `onPress` it renders a plain `View`, which is what keeps a labelled
  `Pressable` from silencing everything inside it — and that branch dropped
  `testID`, so `table-advice` had matched nothing in the tree since the advice
  panel shipped. Both branches forward it now.

## Current migration head

`supabase/migrations/20260830120000_active_session_lookup.sql`
(45 migrations, all applied from scratch cleanly on 2026-08-30).

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
- `public.my_active_session()` — where the caller's own chips are. Argument-free,
  identity from `auth.uid()`, and it mirrors `assertNoOtherLiveSeat`'s predicate.
- `src/features/table/active-session.ts` — the RN-free half of the resume path:
  parsing, wording and the `canResume` predicate the card is gated on.

## Known unresolved defects

None blocking. Recorded observations, all assigned onward:

1. **Local edge runtime is load-gated** (environment, not product). Above host
   load ~12 the runtime hits CPU soft/hard limits and retires workers; the
   stack-guard's 5 s probe then reports a healthy stack as absent. Measured:
   6 concurrent requests at load 13–16 → 3 answered, 3 × HTTP 504 after 150 s;
   the same 4-way test at load 5.8 → all under 0.2 s. **Run the server suite on
   an idle machine**, exactly as `CLAUDE.md` already requires for Maestro.
   Seen twice again in phase 3, in both of its shapes: a collection failure from
   the stack guard, and `accepts exactly one of twenty simultaneous commands`
   timing out at 90 s. **`functions serve` ALSO accumulates** — the failing runs
   had logged 45 CPU soft-limit and 16 hard-limit events; a freshly restarted
   one logged 21 and went green. Restart it before a full server run. And never
   `docker restart supabase_edge_runtime_arc21` while it is running: that kills
   the process and the gateway then answers 503.
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
5. **`tests/strategy/generated-table.test.ts` is load-gated.** Its `beforeAll`
   re-solves the six-deck chart against a 180 s budget. Measured on this host by
   loading it on purpose: **29.9 s at load 5.8, 149.7 s at load 25.** Above
   roughly load 30 it crosses the budget and fails with a hook timeout that
   reads like a solver regression. Environment, not product — but a shared CI
   runner is exactly that machine. → **Phase 11.**

## External blockers

Apple Developer, Play Console, Expo/EAS project id, a domain, a Supabase cloud
project, APNs/FCM credentials, a physical iOS device. Documented in
`docs/RELEASE.md`. None blocks Phases 1–11.

## Last known green verification — 2026-08-30 (end of phase 4)

```
supabase db reset                   exit 0 · 45 migrations + seed, from empty
supabase db lint                    no schema errors (extensions, private, public)
supabase test db                    25 files /   483 tests PASS   (phase 3: 24 / 469)
npx tsc --noEmit                    exit 0
npm run lint                        0 errors (37 warnings)
npm run check:functions             all 3 Edge Functions typecheck
npm run test:unit                  105 files / 2,052 tests PASS   (phase 3: 103 / 2,017)
npm run test:server                 16 files /   167 tests PASS   (phase 3: 15 / 130)
                                    live stack, after a clean db reset
```

Additionally exercised by hand against the running stack and recorded in
`docs/phase-reports/phase-04.md`: the buy-in/cash-out round trip and its replays,
the LEAVE-then-CASH_OUT pair, the mid-hand refusals, eight simultaneous recovery
grants, the cooldown and its expiry, and every modified-client write attempt.

**Not re-run in phase 4:** the Maestro flows, `npm run test:coverage`,
`npm run strategy:generate`, `npm run contrast:check`, `npm run benchmark` and
`expo export` — phase 4 changed no colour token, no engine hot path and no
strategy input. It DID add a resume card to Play and to Quick Play, whose
enablement predicate and wording are unit-tested and whose Maestro walk is
assigned to phase 5.

## Previous green verification — 2026-08-29 (end of phase 3)

```
supabase db reset                   exit 0 · 44 migrations + seed, from empty
supabase db lint                    no schema errors (extensions, private, public)
supabase test db                    24 files /   469 tests PASS   (phase 2: 23 / 453)
npx tsc --noEmit                    exit 0
npm run lint                        0 errors (37 warnings)
npm run check:functions             all 3 Edge Functions typecheck
npm run test:unit                  103 files / 2,017 tests PASS
npm run test:server                 15 files /   130 tests PASS   (phase 2: 13 / 116)
                                    live stack, after a clean db reset AND a
                                    freshly restarted `functions serve`
```

Auth journeys additionally exercised by hand against the running GoTrue and
Mailpit — sign-up, sign-in, wrong password, unknown account, refresh, rotation,
sign-out, recovery link, weak password, anonymous sign-in. Table in
`docs/phase-reports/phase-03.md` §B5.

**Not re-run in phase 3:** the Maestro flows, `npm run test:coverage`,
`npm run strategy:generate`, `npm run contrast:check`, `npm run benchmark` and
`expo export` — phase 3 changed no screen, no colour token, no engine hot path
and no strategy input. Its own surface is the database, the Edge-function
authorization boundary and GoTrue, all of which were run.

## Earlier green verification — 2026-08-24 (end of phase 2)

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

**Phase 5 — Mobile Product / Career / Stats.** Do not start it from this file
alone: read `docs/phase-reports/phase-04.md` and `CLAUDE.md` for the invariants.

Four things phase 4 leaves for a later phase to know.

1. **The resume card is new UI and Maestro has never seen it.** It renders on
   Play and on Quick Play whenever `my_active_session()` names a seat, which
   needs a CONFIGURED build and a live table — and `every-screen.yaml` only
   passes against an unconfigured one. Phase 5 owns the flows.
2. **`ACTIVE_SESSION_MODES` mirrors the `game_mode` enum** and
   `tests/table/active-session.test.ts` compares the two. A mode added to one
   and not the other would strand the player it was added for, so it fails the
   suite instead.
3. **`applyWalletDelta` labels every reference `game_session`**, including career
   rewards (a node id) and sprint entries (a tournament id). Invisible to a
   player — the wallet screen labels rows from `reason` — and deliberately not
   changed in an append-only table for a cosmetic fix. → Phase 10.
4. **A test that asserts a phase after `LOCK_BET` must handle a natural.** See
   `reachPlayerTurns()` in `tests/server/economy-authority.integration.test.ts`.

And from phase 3, still true.

1. **`service_role` holds NO grant on any table in this schema**, deliberately —
   the Edge Functions connect to Postgres directly. Reaching for the service key
   over PostgREST answers 403 with a hint telling you to grant it, which is the
   opposite of what this project wants. Read a profile with a real player's
   token; confirm a deleted account through GoTrue's admin API.
2. **`rls-idor` reads and `rls-writes` writes.** The write sweep covers all
   thirteen client write grants with a second real token, and its completeness
   is guaranteed by `assert_client_authorization_surface()` refusing a
   fourteenth. Two shapes of denial are both correct: a `with check` violation
   is a 403, a `using` mismatch is a 200 with an empty list — so assert the
   TARGET ROW afterwards, never the status code alone.
3. **`23_account_lifecycle.test.sql` names no tables.** It populates every
   user-scoped table, deletes, then asks `pg_constraint` which cascading
   references survive. Adding a table with a user column and no cascade fails it
   with the table named and no edit to the file.
4. **The gate now covers `private` too.** `assert_client_authorization_surface()`
   refuses a `private` table without RLS, not only a `public` one. A new private
   table needs `revoke all … from anon, authenticated, service_role` and
   `enable row level security`, the same as its two neighbours.
5. **`minimum_password_length` is 8 in `config.toml`**, matching
   `PASSWORD_MIN_LENGTH`. Keep the two together: the client one is not a
   security control and says so.
6. **`every-screen.yaml` has still never been walked against a configured
   build.** It asserts what a screen *says* in one configuration. → Phase 11.

And from phase 2, still true:

- **`src/features/practice` is a COVERAGE-GATED area** (92/80/94/96 in
  `vitest.config.mts`), proved to fail when breached.
- **Strategy cells carry optional `probabilities`**; a consumer that finds them
  absent renders nothing rather than computing a substitute.
- **A deep link is how a Maestro flow should reach a screen** —
  `arc21://game/practice`, `arc21://career`.
