# Arc 21 — Implementation Status

> **Historical release record.** Read [the current launch index](LAUNCH_STATE.md)
> for the integrated milestone and [the test plan](TEST_PLAN.md) for
> commit-specific verification. Dates, measurements, wording and decisions below
> retain their original checkpoint scope. This record does not establish current
> deployment readiness. (Navigation pointer updated October 30, 2026.)

> **Arc 21 is a temporary development codename.** It has not been trademark-cleared.
> Arc 21 is a simulated card game. Virtual chips have no monetary value, cannot be
> withdrawn, and cannot be exchanged for money or prizes.

Last updated: 2026-09-04 (phase 12 — migration counts corrected; see the pointer below)

> **This file predates the launch sequence and does not track it.**
> **`docs/FINAL_RELEASE_REPORT.md` is the document to read first now** — the
> launch sequence finished with phase 12, and that report carries the MVP
> requirement matrix item by item, every command and its result, the device
> evidence and the ten external owner actions. `docs/LAUNCH_STATE.md` remains the
> index of the architecture facts a change must not rediscover, the current
> migration head and the verification history. Per-phase evidence is in
> `docs/phase-reports/`. What is below remains accurate about the areas it
> describes; it is simply not the whole picture any more.
> (Pointer added 2026-09-02, end of phase 9; updated 2026-09-04, end of phase 12.)
>
> **Superseded again by Astra Refresh A (PASS, 2026-09-14 PDT).** The current
> release index is `docs/LAUNCH_STATE.md`, and the current software evidence is
> `docs/astra-refresh/baseline-audit.md`; the phase 12 report above is now
> historical too. (Pointer added 2026-09-14.)

---

## Current phase

**Phase 14, session 3 of 6: resilience and network faults.**

The specification names four fault scenarios and requires each implemented
explicitly. Three were genuinely fixed or newly proved this session; one — no
internet at launch — was verified by code inspection rather than re-driven
through the simulator, and that gap is stated below rather than papered over.

**Server unavailable / connection lost mid-hand.** `src/lib/supabase/with-timeout.ts`
bounded one call; nothing retried, and a silent failure and a server refusal
rendered as the same generic notice. Both fixed:

- `src/lib/supabase/with-retry.ts` — bounded exponential backoff (three
  attempts, ~0.4s then ~0.8s apart, equal jitter from the same CSPRNG the shoe
  uses). Retry is a property of the FAILURE, never of the call: only a
  `reason: "unreachable"` outcome retries, a server refusal (including
  `RATE_LIMITED`) never does, and `clientActionId` is minted once per intent
  outside the retry loop so a retried attempt cannot become a second bet. The
  gateway now distinguishes a parsed server rejection from true silence by
  reading the rejection envelope off the `Response` `functions.invoke` hands
  back on error — a 503 with the Edge runtime down, a captive portal's HTML, or
  a body that fails the schema are all "unreachable", never guessed as
  "refused".
- `online-table-store.ts` gained a `connection` field (`live` / `reconnecting`)
  kept deliberately separate from `status`: a reconnecting client still renders
  its last snapshot — blanking the felt would hide the cards, the wager and
  whose turn it was — but every command control disables, and the banner states
  the two things a player cannot see for themselves: the hand has not stopped,
  and the server will stand and decline insurance by default if this seat's
  turn passes. The three-second poll passes `retry: false` explicitly, so a
  struggling server never sees several backoff loops stacked on its own poll
  cadence; a command in flight fires `onRetry` from its FIRST silent attempt
  so the banner appears before the whole backoff has run out, not after.

  This was **found mid-session, not designed up front**: the previous session
  left the retry/backoff machinery built and typechecking cleanly (`npx tsc
  --noEmit` failed on a missing `connection` field in the store's initial
  state — the tree was NOT green at this session's baseline check) with the
  connection state scaffolded but never wired into `enter`/`refresh`/
  `lockBet`/`act`/`nextHand`, and one existing test asserting the OLD,
  pre-this-session behaviour (a generic notice on a silent poll failure).
  Finished the wiring, updated that test to assert the specification's actual
  behaviour with the reasoning written into the test itself, and added
  coverage for the poll-recovery and command-retry paths. 27 tests across
  `tests/table/online-table-store.test.ts` and the new
  `tests/table/with-retry.test.ts`.

**Reconnect and stale-version recovery**, believed working, now proved against
the running stack rather than reasoned about from the code
(`tests/server/realtime.integration.test.ts`): a second client subscribed to
`game:<gameId>` and never polled or sent a command received the host's
`PLACE_BET` over its channel at the exact new version — the "reconnect"
mechanism, demonstrated by a client that only listens. In the same run, that
client's own command at its now-stale version returned `status: "stale"` with
the authoritative snapshot and applied nothing — "stale versions recover".
Real output pasted in the session report.

**Malformed room code**, typed rather than a deep link: `app/table/lobby.tsx`
already called `looksLikeRoomCode` before any request — verified against the
code, not assumed, and given regression coverage in
`tests/rooms/rooms-store.test.ts`, which had no tests at all before this
session.

**The password-reset deep link — genuinely broken, not merely unhandled.**
`requestPasswordReset` called `resetPasswordForEmail` with no `redirectTo`, so
GoTrue fell back to `site_url` (`http://127.0.0.1:3000`, a URL this app never
serves) — the email sent, and looked sent, and its link pointed nowhere the
app could catch. Fixed with `PASSWORD_RECOVERY_REDIRECT_URL` in
`supabase-auth-adapter.ts`, matching the exact string
`supabase/config.toml`'s `additional_redirect_urls` already carried from the
previous session's work. `app/auth/recovery.tsx` is the new route — a literal
`auth/` directory, not the `(auth)` route GROUP `sign-in.tsx` lives in, because
this path is registered by exact match with Supabase and cannot be renamed
unilaterally. It follows the same deep-link discipline as
`app/room/[code].tsx`: a missing code is refused locally with no request, a
server-side error on the URL is shown as the server's own reason, and a good
code drives `completePasswordReset` (new on `AuthAdapter`) — `exchangeCodeForSession`
then `updateUser`, with a new `RECOVERY_LINK_INVALID` failure code for a used,
expired or foreign one.

Proved end to end against the local stack, not merely typechecked:
`tests/server/password-recovery.integration.test.ts` requests a real reset,
reads the real email from Mailpit, follows the real verify link (capturing its
redirect rather than fetching an `arc21://` URL, which no HTTP client can
open), exchanges the code, sets a new password, and confirms it by signing in
— the OLD password refused, the NEW one accepted. Building this test caught a
second, sharper mistake: the test's first Supabase client did not set
`flowType: "pkce"`, so the redirect came back as an implicit-flow hash
fragment (`#access_token=…`) instead of PKCE's `?code=…` — a real difference in
server behaviour driven entirely by client configuration, and a reminder that
a test client must mirror the real client's auth options, not just its URL and
key.

**No internet at launch** — verified by reading the code across the gateway
pattern shared by the table, rooms, and friends features (each classifies a
failure into `not-configured` / `signed-out` / `unreachable` / `refused`, and
every consuming screen renders a stated "unavailable" note) and confirming
Practice and the Strategy Guide have zero Supabase imports. **Not re-driven
through the simulator with the stack stopped** — the weakest-verified of the
four scenarios this session, and left that way rather than claimed RAN.

**`tests/e2e/practice-resume.yaml` reconfirmed still flaky**, same failure as
previously diagnosed: the `.*4,900.*` bankroll assertion after a kill/relaunch
times out while every step before it — including the kill and relaunch
themselves — completes. Not re-attempted against a release build this session
(EAS/production builds are session 5's territory). It was already excluded
from the standard three-flow gate by omission — no script anywhere in this
repository globs `tests/e2e/*.yaml` — and that exclusion is now stated
explicitly in the flow's own header and in `docs/AUDIT.md`, not left implicit.

Measured this session, stack live throughout, freshly reset before the final
run:

| Check | Result |
|---|---|
| `npx tsc --noEmit` | clean |
| `npm run lint` | 0 errors, 32 warnings (identical count to before this session) |
| `npm test` | **1,439** passing across 70 files (stack live, so `tests/server` ran within it) |
| `npm run test:coverage` | 1,363 across 65 files, all per-area gates met |
| `supabase test db` | **422** assertions across 23 files, from a clean reset |
| `npx vitest run tests/server` | **52** running, not skipped |
| `supabase db reset` | applies all 58 migrations clean from empty |
| Maestro `every-screen.yaml` | exit 0, 84 steps |
| Maestro `practice-hand.yaml` | exit 0 |
| Maestro `career-node.yaml` | exit 0, all 20 hand iterations, stars progressed |
| Maestro `practice-resume.yaml` | **fails**, reconfirmed — see above |

One Maestro-harness lesson from this session, worth carrying forward: **an
exit code alone is not proof a flow ran.** The first `every-screen.yaml`
attempt exited 0 after the simulator had shut down between runs — Maestro
reported "0 devices connected" and exited cleanly rather than failing loudly.
The tell was the step count (0 `COMPLETED` lines instead of ~84), not the exit
code. Re-booting the simulator before each subsequent run and checking the
step-by-step log, not just the process exit status, is what caught it.

Same phase 14 session 2 also documented: load must be checked and stayed under
control throughout — one every-screen retry was deliberately delayed with a
load-average wait (peaked past 40 mid-session from ordinary desktop activity,
not a leak this session created) before running, per the standing rule that
Maestro above load ~12 is not to be trusted.

---

Rate limiting is built. It was named in the specification's acceptance criteria,
described in `docs/SECURITY.md` in the present tense, and **did not exist** —
including `RATE_LIMITED`, which has had a message and an HTTP 429 mapping in the
command contract since it was written and had never been thrown by anything. All
six named actions are now limited from a single table, `rate_limit_policies`:
friend requests (20/hour), room creation (5/minute and 40/hour), room joins
(10/minute), matchmaking enrolments (10/minute, 60/hour), username renames
(1/30 days), display-name renames (5/hour) and game commands outside an active
game (30/minute). Windows roll rather than resetting on a boundary, refusals are
not themselves recorded so a limit can never become a ban, and every refusal is
consumed before the target is looked at so it cannot report anything about one.
Refusals reach the client as **HTTP 429** through SQLSTATE `PT429` — the
pre-existing username limit raised `55000`, which PostgREST renders as a 500, so
a player who renamed twice in a month was told the server had broken.

The systematic RLS audit found that **the authorization gate had stopped running
sixteen migrations ago.** `20260813121200_hardening.sql`'s DO blocks fail the
migration if a client role gains an unexpected privilege — and they execute once,
thirteenth of thirty-two, so nothing applied after them had ever been checked.
Behind it, `anon` could execute **seventeen** public functions against a
documented rule of one, including all four leaderboards. The cause was not a
grant anybody wrote: a new function's default ACL is `EXECUTE TO PUBLIC`, and
sixteen migrations wrote `grant … to authenticated` without the matching
`revoke … from public`. Narrowed to **one** function for `anon` and 63 → **54**
for `authenticated`, every survivor traced to an RLS policy, a CHECK constraint
or a real `.rpc(` call site. The gate is now
`assert_client_authorization_surface()`, called at migration time and from pgTAP,
and its strongest check is mechanical rather than a list: no function in `public`
may be executable by `PUBLIC`.

All **34 tables** (32 before this phase, plus the two rate-limit tables) carry an
audit row in `docs/SECURITY.md` — RLS, policies, client grants, and a
justification per grant — and the same claims are asserted mechanically, so a
seventh client-writable table fails the suite.

The Daily Challenge's tie-breaks are no longer ABSENT. The grading was never the
missing part: every decision at a ranked table has been graded since phase 12 and
`daily_challenge` was already eligible. The gap was that a daily ENTRY recorded
nothing about its own attempt, and the week bucket it fed mixes in every solo and
public-table decision from the same week. Entries now carry `decisions_total`,
`decisions_optimal` and `ev_lost_micros` — the last an integer in millionths,
because no floating-point column exists in this schema and a float ordering key
can rank two identical records differently on two machines — and the board orders
by score, accuracy, EV lost, then submission time.

`docs/DATABASE.md` states the recovery position for every one of the 32
migrations: 29 additive DDL, one irreversible `alter type … add value`, and two
backfills, both re-derivable. No down-migration framework was added; a `down.sql`
nobody runs describes a rollback somebody believes in.

Measured this session:

| Check | Result |
|---|---|
| `npx tsc --noEmit` | clean |
| `npm run lint` | 0 errors, 32 warnings (unchanged) |
| `npm test` | **1,413** passing across 66 files |
| `supabase test db` | **422** assertions across 23 files |
| `npx vitest run tests/server` | **50** running, not skipped |
| `npm run test:coverage` | 1,339 across 63 files, all gates met, deterministic |
| `supabase db reset` | applies all 58 migrations clean from empty |

---

## Verification performed

Not self-reported — actually executed (re-run in full, 2026-08-18, Phase 14
session 2):

```
JS tests    1413 passed (66 files)  — npm test
            (+12 this session: 4 EV-lost grading, 4 room-join refusal parsing,
             3 out-of-game rate limiting, 1 daily attempt accuracy)
pgTAP        422 passed (23 files)  — supabase test db, after a clean reset
            (+67 this session: 29 rate limits, 16 authorization surface,
             15 daily tie-breaks, 7 migration recovery)
Server        50 passed against the RUNNING Edge Functions, not skipped —
            the 401 gate was checked immediately before the run
E2E         ALL THREE PASS (exit 0) on iPhone 17 Pro / iOS 26.5 —
            every-screen 129s, practice-hand 78s, career-node 304s.
            career-node could not be completed DURING session 2 and was
            reported as a suspected driver fault rather than a regression.
            That diagnosis was confirmed afterwards: re-run on an idle host
            (load average 10.8, versus 40+ during the session) it passed
            first time, exit 0, all 28 steps. The cause was host load, not
            the app and not session 2's changes. Detail below.
Typecheck   clean (tsc --noEmit)
Lint        0 errors, 32 warnings — identical count to the tree before this
            session
Migrations  32 applied from scratch + seed, and the authorization gate now
            runs LAST rather than thirteenth, so it sees all of them
Coverage    deterministic and 16x faster: tests/server is excluded from the
            COVERAGE run only, having been measured to contribute exactly
            zero to it (66.65/62.71/64.24/68.67 either way) while costing
            140 seconds and two intermittent failures

Two cautions for re-runners, both learned the expensive way here:

  * career-node PASSES on an idle host — confirmed after the session, exit 0
    in 304s at load average 10.8. What follows is why it did not pass during
    the session, kept because the diagnosis is the reusable part.

    Its four failures were all the same fault in a different place:
    `Request for viewHierarchy failed, code: 500` / a hang inside
    `getHierarchyWithFallback`, raised by the XCUITest runner, at driver
    start-up, after hand 1, after hand 4 and after hand 13 respectively. The
    flow itself was correct every time — onboarding, Home, Play, Career, the
    Locked marker, First Deal, career-start, chip-50, bet-deal, four STANDs and
    career-next-hand all COMPLETED. `practice-hand` plays a full hand through
    the same table components and passes, which is the reason to believe the
    app rather than the driver. Load was taken from 40 to 5.7 (Supabase
    stopped, stale runners killed, simulator rebooted) and it made no
    difference; `MAESTRO_DRIVER_STARTUP_TIMEOUT=180000` fixed the START-UP half
    and nothing fixed the snapshot half. One earlier failure ran
    `xcrun simctl uninstall` for five minutes and left the app UNINSTALLED,
    costing a ten-minute rebuild — check the app is still installed before
    diagnosing a Maestro failure.
  * A load-generating experiment left eight busy-loop shells running and took
    the load average to 75. Every measurement taken after that point is
    suspect until the load is back under 10 — check `uptime` before
    diagnosing anything.

Coverage, per area rather than one blanket number:
  shared/blackjack           97.31% statements · 93.81% branches  (gate 90)
  _shared/strategy           98.12% statements · 94.40% branches  (gate 90)
  shared/career              72.61% statements · 63.51% branches  (gate 70/60)
  shared/progression         98.52% statements · 97.50% branches  (gate 90)
  _shared/tournament-format  94.50% statements · 79.16% branches  (gate 90/75)
  _shared/daily-challenge     100%  statements ·  100%  branches  (gate 95)
  _shared/decision-grading   88.46% statements · 83.33% branches  (gate 85/80)
  _shared/session-economics   100%  statements ·  100%  branches  (gate 95)
  _shared/push-message        100%  statements · 96.42% branches  (gate 90/85)
```

The push-message gate was verified to fail when breached, not assumed to work:
temporarily raised to 101% it reported
`ERROR: Coverage for statements (100%) does not meet ... threshold (101%)`, and
was then restored. That check exists because a threshold matching zero files
silently passed in this repository once already.

**Live database integrity, after the full server suite:**

```
wallets = ledger            true
negative balances           0
level disagrees with xp     0
notifications written       38
unsafe payloads             0        <- the data allowlist holds
delivery states             mocked=2, no_device=22, pending=14
pushes actually sent        0        <- honest: no credentials exist
devices registered          4
queued to an unwanted kind  0        <- per-device allowlist is enforced
```

`pushes actually sent = 0` is the number this build should report. Nothing is
delivered without APNs/FCM credentials, and the sender says so rather than
recording a success it did not have.

**Performance review, measured rather than claimed:**

Re-measured in phase 14 s4 by `npm run benchmark` — a COMMITTED script
(`scripts/benchmark.ts`), where the phase-13 figures came from an ad-hoc one
that was never checked in and so could not be re-derived.

```
Engine hot path    5,000 hands · 19,961 commands per run
                   752–808 µs per hand · 188–202 µs per command
                   (five runs, load ~5; reproduces the 776/195 quoted since
                    phase 13, so nothing has regressed)
                   — about 1% of a 60 fps frame budget per command

Memory             50 hands adds +10 KB of settled Node heap
                   (GC forced either side; a leak would show as unbounded
                    growth, because the engine returns new state per command)

iOS export         5.9 MB Hermes bytecode
                   224 KB assets total, of which 103 KB is the sound palette
                   32 bundled assets: 23 PNGs from expo-router, 9 WAVs of ours
```

**Quote the range, not one run.** A single cold run on the same commit measured
1,242 µs per hand — 1.6× the steady figure. Check `uptime` and re-run before
believing a regression, for the same reason Maestro needs an idle machine.

**The 60 fps claim is a BUDGET, not a measurement.** A four-card deal staggers
at 60 ms with each cue running 200 ms, so the last card starts at 180 ms and the
deal completes at 380 ms — 23 frames at 60 Hz. That is arithmetic over the
constants in `src/design/motion-timing.ts`. **No frame was measured**: native
frame profiling needs Instruments driving a release build, which cannot be
automated from this environment.

The nine cues appear in the export's `metadata.json`, which is how "the audio
ships" is known rather than assumed.

Two deliberate structures keep re-render cost down at a live table. `lastEvents`
is set to a single shared `EMPTY_EVENTS` constant on every poll rather than a
fresh `[]`, because the feedback hook decides whether a batch is new by identity
— a new empty array three times a second would replay the last hand's win sound
forever. And the audio sink pools three players for `cardDeal`, because a deal
staggers cards at 60 ms while each cue runs for 120 ms, so a single player would
cut its own tail off on every second card.

Coverage gates are scoped per area deliberately. A single global figure gets
gamed in one of two ways — a well-tested core hides a weak newcomer behind a
good average, or a weak newcomer drags the gate down until someone lowers it for
everyone. The engine, strategy and money primitives decide outcomes and chips
and hold the 90% bar; career is progression logic that cannot mis-settle a
wager, so it carries a lower but honest bar, to be raised as its session runner
lands.

The suite is run repeatedly before any claim of stability. A test that fails only
under load is a real defect — it teaches people to re-run CI instead of reading
it — and two distinct causes have been found and fixed here:

- The solver's six-deck recursions exceeded Vitest's 5s default when competing
  for CPU. Fixed with explicit `testTimeout`/`hookTimeout`.
- `tests/strategy/solver.test.ts` takes seconds normally and **17 minutes** under
  v8 coverage instrumentation, because instrumenting a deep recursion is
  pathological. It is excluded from the coverage run only — the solver lives in
  `scripts/`, which coverage does not measure, so no measured coverage is lost,
  and it still runs and must still pass on every `npm test`. A 20-minute timeout
  would have made a genuine hang indistinguishable from normal operation.

**Live gameplay verification.** The app was run and driven end to end. Five
consecutive hands settled with exact bankroll arithmetic:

```
start 5,000 → Loss 4,900 → Win 5,000 → Win 5,100 → Loss 5,000 → Win 5,100
```

Confirmed on screen: dealer hole card rendered face-down with the displayed
total reflecting **face-up cards only** (ace showing → "11", never the hidden
total); insurance offered only against an ace, at exactly half the wager;
Split correctly legal on K♦ K♣ under the equal-value policy; the 1,000 chip
absent and the 500 chip auto-disabling once it would exceed the table maximum.

**Randomised soak through the live UI**, choosing among legal actions at random:

```
38 hands · 11 splits · 15 doubles · 2 insurance offers · 3 blackjacks
1 shoe reshuffle (reached shoe 2) · 0 errors
```

**In-process fuzz (permanent, in CI).** `tests/features/practice-store.test.ts`
plays 150 randomised hands through the store and asserts after every one that
the bankroll equals the starting bankroll plus the sum of settled outcomes
exactly — proving chips are never created or destroyed, never drift through
rounding, and never go negative. It also asserts the shuffle number cannot
change while a hand is in progress.

---

## Completed requirements

### Shared blackjack engine (`shared/blackjack/`)

Runtime-neutral TypeScript — no React, React Native, Expo or Supabase imports.
The same module serves the client, the future Edge Functions and the tests, so
there is exactly one implementation of the game.

Six-deck configurable engine; full state machine; S17 (H17 configurable); 3:2
naturals; peek; insurance and even money; late surrender; double and DAS; split,
resplit and split-ace restrictions; integer chip math; 75% penetration with
between-hands-only reshuffles; transactional shoe-exhaustion abort; predictable
timeout defaults; sequential multi-seat turn order (and, for the Sprint
Tournament alone, sequential BETTING — one seat at a time with a clock each,
`rules.sequentialBetting`); typed errors that leave state
untouched; monotonic versioning; and a sanitisation boundary with automated
leak assertions.

### Application shell

- Expo SDK 57.0.12, React Native 0.86.2, React 19.2.3 — matching the spec
- Expo Router, TypeScript strict + `noUncheckedIndexedAccess`
- Reanimated 4 **Bundle Mode enabled** (babel plugin + Metro config), the
  current recommended workaround for SDK 57's Hermes memory overhead
- Design tokens, typography with tabular figures, motion tokens with a
  Reduce Motion hook
- Playing cards rendered **programmatically** from vector primitives — no image
  assets, original by construction, suit never carried by colour alone
- Practice table: betting bar, action dock, insurance sheet, split-hand selector,
  outcome badges, result summary

### Learning modes

All four assistance modes are live at the Practice table, every one backed by
the generated tables — no placeholder advice anywhere.

| Mode | During the decision | After |
|------|--------------------|-------|
| Play | Nothing | Logged for review |
| Learn | "Recommended: HIT", expandable to a rationale | Logged |
| Analysis | Collapsed chip expanding to EVs for every legal action | Logged |
| Challenge | Nothing | Immediate correct/incorrect with the EV cost |

`src/features/practice/advice.ts` is the bridge, and it is deliberately pure so
it can be tested against the real engine. Three properties it guarantees:

- **It never reads hidden state.** Only the player's cards and the dealer's
  *upcard*. A test asserts identical advice for identical upcards over different
  hole cards — if the hole card ever leaked into the model, that test fails.
- **It never recommends an illegal action.** Recommendations are resolved
  against `getLegalActions`, so an unaffordable double falls back to hit.
- **It never guesses.** When the tables cannot answer, it returns null and the
  UI shows nothing. Ungradeable decisions are excluded from accuracy entirely,
  so a state the solver does not price can never be recorded as a mistake.

Strategy accuracy is tracked locally, and separately for decisions made *unaided*
(Play and Challenge) versus with the answer already on screen — a "correct"
choice made while reading the recommendation measures nothing about the player.
Assistance can only be changed between hands, so a graded decision cannot be
converted into a revealed one mid-hand.

### Practice persistence

The session autosaves to SQLite after every accepted engine transition, so an
app kill loses at most the command in flight rather than the hand. The **shoe is
saved with the chips**: resuming with a fresh shoe would silently reshuffle the
composition the player was reasoning about.

A saved blob is treated as untrusted input from disk. Every load is validated —
schema version, ruleset key, and structure — and then *exercised*: the engine is
handed one no-op command to prove the state is actually drivable. A blob can
satisfy every shape check and still be undrivable (an unknown phase, a cursor
past the end of a seat's hands), and it is far better to find that here, where
the session can be archived and replaced, than on the player's first tap.

Anything that fails is archived for diagnosis and removed, so a bad save cannot
crash the app on every launch.

Hydration is also **time-bounded**. A rejected promise was already handled, but a
promise that never settles was not: a storage module that fails to initialise
left the table showing "Shuffling…" forever with no way forward. That was caught
by running the app, not by the tests, and is now covered by one that wedges the
store deliberately.

### Server command layer

`supabase/functions/game-command` and `create-session`, exercised over HTTP
against the running local stack by `tests/server/`. Those tests **skip** when the
stack is not reachable, so a machine without Docker still gets a green suite —
and the guard requires a 401 from the function itself, because the API gateway
answers 503 with the runtime stopped and an "any response" check reported the
stack as up.

Verified by attacking the running function, not by reading the code:

| Attack | Result |
|--------|--------|
| No token / forged signature | 401 |
| Expired beyond clock skew | 401 |
| `alg: none` | 401 |
| `role: "anon"` (the bundled publishable key) | 401 |
| Wrong audience / non-UUID subject | 401 |
| Replayed `clientActionId` | first result returned, no second chip movement |
| Replayed session open | same gameId/seatId/buyIn, one debit |
| Stale `expectedVersion` | `stale` + authoritative snapshot, nothing applied |
| Negative wager | 400 before any state is touched |
| Command on another account's session | rejected |
| Any response body | no undealt card, no hole card, no `nextIndex` |

Errors return a generic message plus a correlation ref matching a structured log
line — no SQL, no stack frames, no row contents.

#### Two defects found and fixed

1. **`jsonb` double-encoding.** `${json}::jsonb` stored a JSON *string* rather
   than an object, so persisted engine state could never be read back: every
   game command returned 500 *after* `create-session` had already debited a
   buy-in. Fixed with `::text::jsonb` at the write sites.
   My first attempt made the reader tolerate strings, which papered over it —
   a `CHECK` constraint (`jsonb_typeof(response) = 'object'`) refused the fudge
   and exposed the real cause. The reader keeps the tolerance as belt-and-braces
   for rows written before the fix.
2. **Session-open replay returned 500** instead of the first committed result,
   so a client retrying after a network blip got an error rather than its table.
   Resolved by the same fix.

#### Still unattacked

Concurrency (two commands racing at the same `expectedVersion`) and double
cash-out. Integer overflow is covered at the contract boundary —
`MAX_CHIP_AMOUNT * 4 < Number.MAX_SAFE_INTEGER` is asserted — but not yet
end-to-end through settlement.

### Crypto

`CryptoRandomSource` throws rather than falling back to `Math.random()`, so the
root layout installs a Web Crypto polyfill backed by `expo-crypto` (platform
secure random) before any game module loads.

---

## Defects found and fixed

1. **Turn cursor never advanced.** Positioned only in the peek branch, so deals
   where the dealer showed neither ace nor ten began player turns with no active
   seat and never progressed. Broke 32 tests at once.
2. **Self-extending action deadline.** Refreshed on every cascade pass, letting
   an online player extend their own clock with no-op commands.
3. **Split-ace status ignored the ruleset**, hardcoding `TWENTY_ONE`.
4. **No way to clear a staged bet.** The store faked it in the UI while the
   engine still held the chips. Fixed at the root: `PLACE_BET` with amount 0 is
   now the authoritative "take chips back off the felt" command.
5. **Legality frozen at first render.** The table called a Zustand getter during
   render. That does not subscribe, and under the React Compiler it memoised
   against a stable function reference and never recomputed — leaving Deal
   permanently disabled. Now derived from subscribed state via `useMemo`.
   *This class of bug is invisible to unit tests and was only caught by running
   the app.*
6. **Insurance sheet stayed mounted after the phase advanced**, rendering
   meaningless props ("Insurance costs 0 chips"). Now conditionally mounted.

### Found by adversarial verification of the database and strategy work

Each was demonstrated with a live exploit against the running stack, not by
reading code, and each fix below was re-verified the same way.

7. **Social-graph RPC oracle.** `are_friends(uuid,uuid)` and
   `has_blocked(uuid,uuid)` are `SECURITY DEFINER`, take an arbitrary pair, and
   were granted to `authenticated` — making them PostgREST endpoints that
   answered questions about *any* two accounts, defeating the RLS on
   `friendships` and `blocks` entirely. Replaced with caller-scoped `viewer_*`
   predicates that derive the viewer from `auth.uid()` and take only the
   counterparty, so there is no pair to probe. Verified: the two-argument
   functions now return `permission denied` for `authenticated`.
8. **Hardening gate blind to column grants.** The deploy gate read only
   table-level grants, so `grant update (balance) on public.wallets to
   authenticated` passed it untouched — on the table the gate singles out as
   mattering most. Added a column-privilege gate. Verified: the old check
   reports `f` for that grant while the new one raises.
9. **Hardening gate blind to views.** It filtered `relkind = 'r'`, so a view
   over `wallets` without `security_invoker` laundered RLS past it. Added a view
   gate. Verified against a live `wallet_summary` view exposing every balance.
10. **Tournament standings leaked account UUIDs.** `tournament_entries` and
    `tournament_matches` had `using (true)` SELECT policies, exposing `user_id`
    — an `auth.users` id — for private profiles and for users who had blocked
    the requester. Now scoped to your own entry, fellow competitors, or entrants
    whose profile is already visible to you (delegated to the profiles policies
    rather than restated).
11. **pgTAP suite was not hermetic.** Global `count(*)` assertions meant it only
    passed against an untouched database. Scoped to per-file fixtures. Verified
    by running it twice against a deliberately dirtied database.
12. **Strategy fail-safe checked only the version stamp**, not the rules — a
    ruleset with the same `id@version` but different strategy-relevant fields
    was served the stale chart silently. Now compares the recorded
    `rulesSummary` against the rules actually in force.
13. **Pair validation reported a symptom, not a cause.** A pair of twelves was
    rejected as "total 24 outside 2..21" when the real problem is that twelve is
    not a card value; for a pair the total is *derived* from `pairValue`, so
    that field is now validated first.
14. **EV helpers could crash the table.** `evMistakeForDecision` threw on a
    missing legal-action set. It now fails safe and returns null, which the UI
    already handles by hiding the number.

---

## Deliberate deviations from the specification

### Safety reserve reduced from 104 cards to 52
The spec asks for both 75% penetration and a 104-card reserve. At six decks these
are mutually exclusive — the cut card falls at index 234 (78 cards left), so a
104-card reserve always trips first at index 209, silently reducing real
penetration to ~67%. Penetration is a user-facing fairness claim, so the cut card
stays primary and the reserve became a true backstop at one deck.
`assertPenetrationIsCoherent` prevents this from regressing. See
[BLACKJACK_RULES.md](./BLACKJACK_RULES.md).

### `PLACE_BET` carries an absolute amount
Chip taps accumulate in the UI; the engine receives the final wager. Idempotent
under network retry. Amount 0 clears.

### Auto-stand on 21
A hand reaching 21 completes automatically — the only outcome of hitting is an
accidental bust. UX safety, not a rule change.

### `babel-preset-expo` added as an explicit devDependency
Required once a custom `babel.config.js` exists: the preset ships nested under
`expo/node_modules` and is not resolvable by bare name from the project root.

### Metro resolves TypeScript `.js` specifiers
`shared/` imports its own modules with explicit `.js` extensions because the same
engine will be imported by Supabase Edge Functions, where Deno mandates them.
TypeScript and Vite map `.js`→`.ts` natively; Metro does not, so `metro.config.js`
adds it as a fallback **after** normal resolution fails, changing nothing else.

### `react-native-web` added as a development verification surface
**Not a product direction** — the spec is explicit that the primary product is
not a web app, and it is not being built as one. Xcode is not installed on this
machine (see blockers), so the web target is currently the only way to actually
run and verify the app rather than merely assert it compiles. It should be
removed, or kept strictly as a dev dependency, once native builds are possible.

---

## Known defects

None outstanding.

### Economy phase — closed out

The three items left behind when this phase was first marked done:

| Item | State |
|------|-------|
| **Opening wallet 25,000** | Done. Was seeding 10,000 — never reconciled against the specification, not a considered deviation |
| **Recovery Grant** | Done. `claim_recovery_grant()` restores a wallet under 2,000 **to** 5,000, once per 12 hours, deciding everything server-side from a locked balance |
| **XP / levels** | Done. Awarded in the settlement transaction, under the 300/day UTC cap |
| **Delete account** | Done. `delete_own_account()` plus a two-step confirmation in Settings → Account |
| **Reconnectable active game** | Done, in phase 4. `public.my_active_session()` names the caller's own live seat — game id, seat id, mode, tier, start time — and a "Return to your table" card renders on Play and Quick Play. Before it, a killed app meant every online mode answered `SESSION_ALREADY_ACTIVE` for ever with the buy-in stranded |

**XP is deliberately inert.** `shared/progression/` implements the curve
(`100 + 25 × (L-1)`, cap 50, 300/day repeatable cap) at 98% coverage, but no
settlement path calls it yet, so no player earns XP. It is a finished component
awaiting its wiring, not a working feature — recorded here so the distinction
does not blur.

**Server-authoritative statistics are written too.** No Edge Function had ever
written `player_stats`, so hands played online lived in the engine state and the
event log but never reached the statistics screen. Stats and XP share the one
settlement hook — a hand either updates the record or does not settle.

Verified against the live stack: one settled hand produced
`played=1 lost=1 wagered=50 net=-50`, `xp=5`, `daily=5`.

Two properties that must survive any change here:

- The award API takes a **count** of hands and decisions, with nowhere to put a
  stake. "Never award more XP for betting larger amounts" is therefore
  structural rather than a check that could be removed.
- Everything at the level cap reports `null`, not `0`, so a progress bar cannot
  divide by it.

### Money lens — five attack angles against the live stack

Concurrency, cash-out, overflow-through-settlement, self-credit and ledger
integrity were each attacked against the running database and Edge Functions.
Full evidence in [AUDIT.md](./AUDIT.md).

| Angle | Result |
|-------|--------|
| Racing commands at one version | **Clean.** 130+ simultaneous commands, 2/5/20 wide; exactly one accepted every time, with the database confirming a single version bump and a single event |
| Double cash-out | **Clean.** Same and differing request ids, raced, mid-hand, on a closed session, cross-account — one credit in every case; the key is derived from `gameId:seatId`, not from client input |
| Overflow through settlement | **Clean.** Doubled and 3:2 payouts exact at the real ceiling; every chip column is `bigint` and overflow fails closed inside the transaction |
| Self-credit | **Clean.** Every PostgREST write path, the direct `apply_wallet_delta` RPC and repeated Recovery Grants all rejected |
| Ledger apply order | **One defect, fixed.** `created_at` is transaction-start time and inverts under contention, so the ledger could not be replayed in order. No chips were affected. Fixed by adding a `seq` identity assigned under the wallet lock |

The concurrency result is now held by three tests in `tests/server/`, and the
ledger ordering invariant by `supabase/tests/09_ledger_apply_order.test.sql`.

---

## Blocked external integrations

| Integration | Status | What is needed |
|-------------|--------|----------------|
| **iOS native build** | ✅ **Working** | Builds, installs and launches on iPhone 17 Pro / iOS 26.5. Metro bundles 2,449 modules; the app renders correctly and produces no crash reports. **CocoaPods requires a UTF-8 locale** — without `LANG=en_US.UTF-8` it fails with `Encoding::CompatibilityError`, and the build then reports the misleading "sandbox is not in sync with Podfile.lock". Export `LANG`/`LC_ALL` before `pod install` or `expo run:ios`. |
| On-device interaction testing | Not possible yet | `simctl` cannot synthesise taps and `idb` is not installed, so gameplay cannot be driven on the simulator. Deep links reach the app but iOS raises an "Open in Arc 21?" confirmation that itself needs a tap. Gameplay is therefore verified through the web target, which runs the same store and engine. Installing `idb` (or a Maestro E2E suite) would close this gap. |
| Claude Code simulator panel | Unavailable | The MCP simulator server reports "Xcode is installed but not selected" even though `xcode-select -p` returns `/Applications/Xcode.app/Contents/Developer`, first-launch status is clean and the license is accepted. Appears to be a bug in that server. The simulator is driven directly with `xcrun simctl` instead. |
| Android native build | Not attempted | Requires Android Studio + SDK. |
| Supabase cloud project | Local stack in progress | Docker and Supabase CLI are installed and working. Cloud project + keys needed only for deployment. |
| Apple Push / FCM | Not started | Paid developer accounts. Token schema, permission flow and adapter can be built and tested against a no-op adapter first. |
| EAS build credentials | Not started | Expo account. |
| Analytics provider | Not started | Vendor-neutral interface + console adapter until a credential exists. |

---

## Next work (in order)

1. Land the strategy tables and Supabase foundation currently in flight.
2. Wire Learn / Analysis / Challenge assistance modes to the validated tables.
   *No placeholder advice has been shipped* — the spec forbids guessed strategy,
   so those modes are absent until real tables exist.
3. Practice persistence via Expo SQLite, autosaving after every terminal engine
   transition so an app kill resumes the exact hand.
4. Table polish: card deal/flip animation, chip movement, audio, haptics.
5. Component and E2E tests (RNTL + Maestro) for the table interactions that unit
   tests cannot reach — defect 5 above is exactly the class these would catch.
6. App shell: four-tab navigation, onboarding, profile, stats.

---

## Deferred to V1.1 / Future

Explicitly **not** in the MVP: side bets, slot mechanics, loot boxes, wheels,
gems, chip purchases, real-money gambling, cash-out, card-counting tools, text
chat, purchased XP, paid competitive advantages, or a "hot/cold" dealer.

Already supported by `BlackjackRules` and tested, but not shipped: H17,
European no-hole-card, split-by-rank, hit/resplit aces, alternative deck counts.
Shipping any of them requires a new ruleset version, because basic strategy
changes with the rules and strategy tables are keyed to `id@version`.
