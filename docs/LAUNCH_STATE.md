# Arc 21 Launch State

**Current Phase:** 6 — Social / Private Multiplayer (not started)
**Last Completed Phase:** 5 — Mobile Product / Career / Stats (PASS, 2026-08-30)

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
| 5 — Mobile Product / Career / Stats | **PASS** | Eight defects fixed, each regression proved to fail without its fix; the rename proved against the live stack, the last defect found only by looking at a rendered screen, and a guard that had stopped covering its own subject strengthened and proved to fail on three breaches. |
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

- **A PREFERENCE THAT NOTHING READS IS A FEATURE THAT DOES NOT EXIST.**
  `confirmLeavingOnlineGame` was declared, defaulted, validated and persisted,
  and a full-repository grep found three references, all inside `settings.ts`.
  The stored blob was well-formed, so it looked like a working feature on disk.
  It now gates the only economic command a single mis-tap can fire — "Leave
  table" sends `CASH_OUT` — through `shouldConfirmLeavingTable`, and BOTH leave
  paths go through it: the control and the `beforeRemove` listener.
- **THE THREE TABLES THAT DEAL CARDS MUST SHARE THEIR PRESENTATION.** Practice,
  the career table and `/table/[gameId]` each render `BettingBar`, `ActionDock`
  and `HandCards`, and the two written later kept the gaps the first one had
  already filled: no split-hand chip row, `lastBet={0}` with an empty
  `onRepeat`, and — at the career table — no `OutcomeBadge` at all.
  `src/features/table/split-hands.ts` and `HandSelector.tsx` are now the single
  implementation. When you touch one table, check the other two.
- **A SERVER TABLE MUST STATE ITS OWN TERMS.** `rulesSummary`, `handNumber` and
  `shoe` have been on every snapshot since the wire contract was written and
  `/table/[gameId]` rendered none of them — so the tables where the rules are
  NOT the player's own choice were the only ones that never said what they were.
  `table-rules.ts` derives both lines from the snapshot; nothing is typed.
  In the same block, every OTHER seat rendered its stack and the player's own
  did not, outside the betting bar.
- **RENAMING EXISTED ON THE SERVER AND HAD NO CONTROL.** Two triggers, a unique
  key, two rate-limit policies, a column-level grant, and a documented
  55000 → PT429 fix "so a player who renamed twice in a month is not told the
  server broke" — and nothing in the app had ever written either column after
  signup. `profile-rename.ts` plus `EditIdentityCard` are the missing half;
  `tests/server/profile-rename.integration.test.ts` drives every one of those
  guards over HTTP, including the 429.
- **`tests/wallet/no-write-path.test.ts` NAMES THE DIRECTORIES IT SCANS**, and
  had stopped covering one: `src/features/settings` wrote `profiles.privacy`
  from outside the scan. It now scans four directories and allowlists exactly
  one table, one verb and six columns — and it is proved to fail on a wallet
  write, an off-allowlist column and an untyped patch, rather than assumed to.

- **A UNIT TEST CANNOT SEE A SHAPE.** `HandSelector`'s chip row rendered as two
  ELLIPSES with the labels spilling out of them — a `ScrollView` with no
  `flexGrow: 0` expanded to fill `playerArea`, its children stretched, and
  `radius.pill` (999) on a 200-point-tall box is an ellipse. `tsc`, `lint` and 21
  green assertions could not see it; one screenshot could. When a change is
  visual, LOOK at it.

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
6. **Maestro's load sensitivity was met head on, not worked around.**
   `online-table.yaml` on an iPhone 17e failed at load average **142** — a second
   simulator booting while Metro re-bundled — with the Quick Play buy-in never
   completing. Bringing the machine back to idle first and re-running the same
   commit passed. Nothing product-side changed between the two. The rule stands:
   **build, wait for `uptime` below ~10, then run flows.**
7. **The simulator reached a broken install state twice in phase 5.**
   `simctl get_app_container` returned a `com.arc21.app-<timestamp>.app`
   placeholder and every launch failed `FBSOpenApplicationServiceErrorDomain
   code=1`; separately the XCUITest driver refused to start with a repeating
   `Failed to connect to 127.0.0.1:54474`. Both cleared by `simctl uninstall` +
   `install` from DerivedData, and by rebooting the simulator with stale
   `maestro-driver-ios` processes killed. Harness, not product — but check the
   container path FIRST, because a missing app reads as a broken flow.

## External blockers

Apple Developer, Play Console, Expo/EAS project id, a domain, a Supabase cloud
project, APNs/FCM credentials, a physical iOS device. Documented in
`docs/RELEASE.md`. None blocks Phases 1–11.

## Last known green verification — 2026-08-30 (end of phase 5)

```
npx tsc --noEmit                    exit 0  (covers tests/ too — see below)
npm run lint                        0 errors (37 warnings, unchanged)
npm run check:functions             all 3 Edge Functions typecheck
npm run test:unit                  112 files / 2,183 tests PASS  (phase 4: 105 / 2,052)
npm run test:server                 17 files /   175 tests PASS  (phase 4:  16 /   167)
                                    live stack, edge runtime at 9 CPU soft limits / 0 hard
supabase test db                    25 files /   483 tests PASS
npm run contrast:check              46 pairings, 0 failing (+2 Increased-contrast substitutes)

Maestro, iPhone 17 Pro (iOS 26.5), dev build + Metro, stack live:
  practice-hand.yaml                exit 0, every step COMPLETED
  career-node.yaml                  exit 0, all 20 hand iterations, stars progressed
  online-table.yaml                 exit 0 — updated for the new leave confirmation
  every-screen.yaml                 exit 0, with .env.local moved aside
```

The database was NOT reset during phase 5; the migration head is unchanged from
phase 4, which applied all 45 from empty.

**`tsc` covers `tests/` and vitest does not typecheck.**
`tests/table/split-hands.test.ts` built a `Card` with no `deckIndex` and ran
green under vitest; `npx tsc --noEmit` caught it. A test that passes is not a
test that compiles.
