# Phase 11 — Adversarial QA, E2E, CI, Runtime QA

**Result: PASS.** Ten defects fixed, each proved to fail by reverting it in the
running system. One advisory investigated and found NOT reachable — the guard
written for it was deleted rather than shipped, and replaced by a test that pins
the reason. The two-simulator public-table lifecycle that phase 7 deferred was
walked end to end on two devices with the server asked at every step. **CI ran on
a real runner for the first time in this project's life and failed both jobs** —
one of them because every function in `public` shipped executable by `anon` on
any database whose migrations are applied by the role a current CLI uses.

The device sweep was then repeated against a **Release build** — the first time
this project has run Maestro against the configuration it actually ships. That
is what settled the one crash seen in this phase (a data race in a dependency's
process-global, reachable only while several React Native runtimes wait on
Metro) and it found four more defects in the harness itself, each invisible to a
Debug run.

---

## What this phase was for

Phases 1–10 built and hardened. This one attacks: replay, races, a modified
client, Realtime, rate limits, local tampering, deep links, notifications,
dependencies, and then walks the product on real devices and asks whether the
CI that is supposed to guard all of it has ever actually run.

The rule throughout was the project's own: **a failure is work, not a report
entry.** Every finding below was reproduced, fixed at the root, given a
regression that was proved to fail without the fix, and re-verified.

### What was asked of each part of the surface

Six of these produced findings, listed below. The rest are recorded here because
"we attacked it and it held" is only worth something if the reader can see what
the attack actually was.

| surface | asked by | what it had to survive |
|---|---|---|
| Replay, command idempotency | `tests/server/game-command.integration.test.ts` | a replayed OPEN returning the first committed result; the same command replayed *concurrently* returning one identical result; a retry with a **fresh** request id not buying a second seat |
| Economic idempotency | `economy-authority.integration.test.ts` | one buy-in for a replayed OPEN; a career reward paid once and a replay refused ranking; every ledger movement reconciling in both directions |
| Concurrency and races | `game-command.integration.test.ts`, `tests/contracts/room-lock-order.test.ts` | twenty simultaneous commands of which exactly one is accepted; two racing `LOCK_BET`s not double-dealing; a fixed lock order held as an allowlist so a sixth function fails a test rather than a race |
| Modified client | `hostile-payloads.integration.test.ts` | `alg:none`, a wrong signing key, an expired token, the publishable **and** service keys offered as player credentials, a validly signed token claiming a privileged role, a non-uuid subject, a 32 MB body, a body that is not JSON at all |
| Object substitution | `object-substitution.integration.test.ts` | every session command, all twelve game commands and every room RPC, each naming **another player's** game, room or attempt — and the owner's chips and seat read back unchanged afterwards |
| Bounded work per request | `bounded-reads.integration.test.ts`, `25_bounded_reads.test.sql` | `p_limit = 2147483647`; forty push registrations; a directory walk — findings F-01, F-02, F-03 |
| Realtime authorization | `realtime.integration.test.ts` | a subscriber holding no seat, and an anonymous one; a **forged state** pushed by an account with no seat; and, as the positive control, one signed-in player's state reaching another |
| Cross-room isolation | `object-substitution`, `rls-idor.integration.test.ts` | a stranger seeing nothing of a table or room they are not at, asked with **no filter at all** so the sweep cannot pass on emptiness |
| Local device-state tampering | `tests/features/local-state-authority.test.ts` | the storage-key inventory derived from source rather than listed, every value classified, and no local-persistence module naming a privileged verb |
| Rate limiting | `19_rate_limits.test.sql`, F-02, F-03 | every window a row in `rate_limit_policies`; no enforcement point carrying one of its own; a refusal never itself recorded |
| Deep links | see below | a `gameId` or room code granting no authority |
| Notifications | `notifications.integration.test.ts`, `rls-writes.integration.test.ts` | nobody able to write a notification; only its recipient able to read, mark or remove one — findings F-02, F-04 |
| Dependencies | `npm audit`, `expo-doctor` in CI, `tests/deep-links/…` | the one advisory phase 10 deferred, measured rather than assumed |
| Platform surface | `ios/Arc21/Info.plist`, read after the rebuild | `NSAllowsArbitraryLoads = false`; no `UIBackgroundModes`; the only usage description on the whole build is `NSFaceIDUsageDescription`, so the microphone permission phase 10 removed has stayed removed |

### A deep link locates state; it never grants authorization

The app's scheme is `arc21`, and the routes that take an identifier are
`table/[gameId]`, `room/…`, `profile/…` and the notification deep links. The
identifier is the entire payload — there is nothing else in the link to forge.

The table route is the one worth stating explicitly, because it looks like the
dangerous one and is the easiest to reason about wrongly. `app/table/[gameId].tsx`
renders the server's last snapshot and derives nothing, and the client's **only**
read of table state is `onlineTableGateway.snapshot()`, which sends
`RESOLVE_TIMEOUT` for that `gameId`. That command is in the list
`object-substitution.integration.test.ts` fires at a table the caller does not
sit at, and it answers **HTTP 403 `NOT_A_PARTICIPANT`** — measured, alongside the
other eleven. So a deep link carrying somebody else's `gameId` reaches a screen
that can obtain no state, and every control on it acts through the same gateway.
Rooms are the same shape through `get_room_state`, and profiles through the RLS
sweep. A notification's payload cannot even carry an arbitrary string: `data` has
a CHECK constraint over a fixed key set holding short scalars, which is what F-04
turned out to be about.

---

## Findings

### F-01 · A leaderboard page had no ceiling · fixed

`leaderboard_weekly_xp(p_limit, p_offset)` and its three siblings clamped the
page size from BELOW only — `limit greatest(p_limit, 1)`. `p_limit =
2147483647` was answered with **every ranked row in the database**, in one
request, by any authenticated caller.

`public.leaderboard_page_maximum()` is the one ceiling; all four boards and
`my_leaderboard_position` read it, and it is revoked from every client role
because each reader is a `security definer` body that runs as the owner.

The hard part was testing it: a local board holds a hundred-odd rows, so
asserting "2147483647 returns everything" passes identically with the clamp
present and absent — the empty-fixture mistake in another costume.
`25_bounded_reads.test.sql` **moves the ceiling** to 3 inside the transaction
and asserts the answer follows, which proves the clamp is wired to the constant
AND that the constant bounds the answer.

### F-02 · Any account could register unlimited push devices · fixed

Measured before the fix: **200 rows in 1,863 ms** for one account, with no
ceiling in that number — only in how long the loop was left running. Rows are
the cheap half. `pending_push_deliveries` JOINs notifications to tokens, so N
registrations turn one notification into N outbound messages.

`register_push_token` now evicts by least-recent-use down to
`push_tokens_per_account_maximum()` = 10.

**The first fix was wrong and the test caught it.** It kept "the newest ten" and
argued the row just inserted is always newest. `now()` is FIXED for a
transaction, so forty registrations tied on `last_used_at`, survivors were
chosen by a random uuid, and the registration the caller had just made was among
the thirty deleted — a device left with no working registration by the very call
that registered it. The delete now names the token explicitly.

### F-03 · `search_players` was an unmetered directory dump · fixed

Two defects in one function. The query interpolated the caller's string into a
`LIKE` pattern without escaping, so `%%` matched every profile; and there was no
rate limit at all. Measured: **108 calls enumerated 445 distinct accounts, none
refused.**

Metacharacters are now escaped with an explicit `escape '\'`, and the function
consumes `player_search` (30/minute, 300/hour). After: `%%` returns 0 rows, and
108 calls returned 0 accounts with 78 × `PT429`.

**A wrapper was written first and rejected before it shipped.** It spent the
rate limit while leaving the unlimited `search_players` still granted to
`authenticated` — a control the client enforces and the server does not, which
is a stated policy, not an enforced one. The limit went inside the function
instead, which is why it became `volatile`.

### F-04 · A notification's payload was interpolated into a router path · fixed

`destinationFor` took `data.room_code` and `data.game_id` and put them straight
into `/room/${code}` and `/table/${gameId}`. A crafted `room_code` of
`../../settings` produced the path `/room/../../settings`. Both are now shape-
checked — a room code against the product's own `looksLikeRoomCode`, a game id
against a uuid pattern — and anything else falls back to the notifications
screen.

### F-05 · The Practice assistance selector broke at accessibility text sizes · fixed

Found by **looking at a rendered screen** at
`accessibility-extra-extra-extra-large`. Four `flex: 1` pills each get a quarter
of a 440pt screen, about 91pt; the 13pt caption sets at roughly 40pt there, so
"Challenge" needs about 200pt. The labels broke mid-word AND were drawn OUTSIDE
the pill outlines — "Lear/n", "Anal/ysis", "Chal/leng/e" — because a React
Native view does not clip by default and `alignItems: "center"` leaves a child
at its intrinsic width. Nothing reported an error; the action dock beside it was
correctly capped, which is what made the contrast visible.

`flexWrap` alone could not fix it, for the reason `app/profile/index.tsx`
already writes down: a `flex: 1` child has a flex-basis of 0, so it never
overflows its line and never wraps — it only shrinks further. The row COUNT had
to change. Above `STACK_ABOVE_FONT_SCALE` the pills reflow to two rows of two,
and the label is capped at `MAX_FIXED_CONTROL_FONT_SCALE` because two columns is
about 193pt and a single word cannot wrap except mid-word.

The threshold moved into `type-metrics.ts` and `ScreenHeader` now reads the same
export rather than its own copy of 1.5.

Re-screenshotted at the same content size: "Play | Learn" then "Analysis |
Challenge", every label on one line inside its pill. The felt's message is
clipped by the taller dock and **scrolls** — verified by scrolling it, not
assumed.

### F-06 · A leave the server deferred settled the chips and stranded the player · fixed

The worst one, and it was found only because two devices were sharing a table.

A cash-out refused mid-hand is correct — "leaving is never a way to escape a
committed wager" — and the request is HELD as `leavingWhenSafe` and completed by
the store's poll at the first boundary where `canCloseSeat` agrees. That path
settles the seat, returns the chips and calls `forgetTable()`. **It does not
navigate**, because navigation belongs to the screen, and `finishLeaving` was
only ever called by the two INTERACTIVE paths — the back bar and the
`beforeRemove` listener. A poll is neither.

So the table screen re-rendered into its "Reading the table…" branch and stayed
there. Measured on both simulators and then reproduced with one: the wallet was
credited and correct, the seat was closed, and the only control on screen was
"Leave table" — which cashes out an already-settled seat and navigates nowhere.
The app had to be force-quit.

Nothing in the build could see it. `tests/server` posts `CASH_OUT` over HTTP and
never renders; the store's own tests call `leaveTable` directly; and
`online-table.yaml` leaves BETWEEN hands, which is the path that works.

`shouldExitAfterHeldLeave` is the rule, in `leave-guard.ts` with the others so
it can be asserted without React Navigation, and `tests/e2e/online-leave-mid-hand.yaml`
is the control-level proof. **Reverted the effect and re-ran: the flow fails at
exactly the assertion it was written for. Restored: it passes.**

The diagnosis needed one wrong turn recorded: the first suspicion was the resume
path, and a Quick Play repro of that path passed with `canGoBack=false → replace`
landing on Home. The resume path was innocent; what the two failures had in
common was a hand still live.

---

## Investigated and NOT a defect

### `decode-uri-component` GHSA-vcc3-ghjq-m6fr — not runtime-reachable

Phase 10 deferred this as "the one runtime-reachable advisory". It is not.

The flaw is real and expensive. Measured in Node against the version this app
ships (0.2.2), decoding one hostile value costs

| query length | time |
|---|---|
| 195 chars | 51 ms |
| 771 chars | 992 ms |
| 3 075 chars | 22 330 ms |

`expo-router` reaches it through `query-string@7.1.3`. The vendored upstream
`react-navigation/core/getStateFromPath.js` does call `queryString.parse` on an
inbound URL's query — **and is imported by nothing.** The fork that actually
runs, `fork/getStateFromPath.js`, has that call commented out and uses
`parseUrlUsingCustomBase(path).searchParams` — the platform's own
`URLSearchParams` — decoding with a `safelyDecodeURIComponent` that catches and
returns the raw string. No fallback, no recursion. Every surviving
`query-string` call in the router is `stringify`, the outbound direction, which
never touches the decoder.

Confirmed on the simulator as well as by reading: with a **12,291-character**
`%FF` payload in the query, `arc21://career?x=…` navigated in **1.0 s**. The
same string takes minutes in Node.

Neither remediation `npm audit` offers is one. `decode-uri-component@0.5.0` is
`"type": "module"` and `query-string@7` reaches it through `require()`, so an
override swaps a denial of service for a crash; and `expo-router@5.1.11` is a
**downgrade of fifty-two major versions** from the 57.0.16 this app is built on.

**A `redirectSystemPath` guard was written, tested, and then deleted.** It
refused a query the platform decoder rejects — which is exactly the input that
takes the slow path — and it defended nothing. Shipping it would have changed
deep-link behaviour, put the PKCE recovery `code` at risk, and left a comment in
the tree claiming a 22-second freeze that cannot happen.

What shipped instead is `tests/deep-links/decode-uri-component-reachability.test.ts`,
which measures that the hazard is still real in the installed package and
asserts that the live resolver does not go near it — with the vendored copy as a
**positive control**, so a pattern that cannot find the call proves nothing. If
an upgrade ever re-wires the inbound path onto `queryString.parse`, that file
fails; `npm audit`'s output would not change by one character.

### The `practice-hand` crash after the rebuild — a data race in a dependency, reachable only from a debug build

The dependency alignment (react-native 0.86.2 → 0.86.3 and twelve others) needed
a native rebuild, and the first `practice-hand` run against the rebuilt app
failed like this:

```
02:29:21.178 [WARN]  XCTestDriver request failed. Status code: 500, path: viewHierarchy,
                     body: {"code":"internal","errorMessage":"Error getting main window kAXErrorCannotComplete"}
02:29:21.232 [ERROR] Request for viewHierarchy failed, because of app crash
02:29:23.454 [INFO]  Assert that id: home-practice is visible FAILED
```

Every previous failure of that shape in this project has been the **driver**,
and `CLAUDE.md` records the signature twice — a degraded hierarchy of
identifier-bearing nodes only, `kAXError`, an idle-machine rerun that passes.
The host was at load 15.7, above the reliable range, and the rerun three minutes
later passed. Both facts point at the harness and **both are misleading.**

**The app really had gone.** Maestro saves the hierarchy it asserted against,
and the one for the failing step is 92 KB of the iOS *springboard* — `Page 2 of
2`, `2 apps`, the `Arc 21` icon beside Safari and Messages, a `spotlight-pill`.
Not a degraded dump: a complete one, of a home screen with the app dead behind
it.

`~/Library/Logs/DiagnosticReports/Arc21-2026-09-03-023020.ips` says why:

```
exception   EXC_BAD_ACCESS (SIGSEGV)
            KERN_INVALID_ADDRESS at 0x09be4bead677e1c6 -> 0xffffcbead677e1c6
            (possible pointer authentication failure)
procLaunch  2026-09-03 02:28:35.1170     <- the flow's own launchApp
captureTime 2026-09-03 02:29:21.8108     <- the same second Maestro gave up
```

Faulting thread 27, `com.facebook.react.runtime.JavaScript`:

```
-[EXReactNativeFactory host:didInitializeRuntime:]
  AppContext.registerNativeModules()
    ModuleRegistry.register(fromProvider:)
      ModuleHolder.init(appContext:module:name:)
        ModuleHolder.post(event:)
          closure #1 in EmitterModule.definition()
            NotificationCenterManager.addDelegate(_:)
              Array.append(_:)
                _ArrayBuffer._consumeAndCreateNew(bufferIsUnique:minimumCapacity:growForAppend:)
                  RefCounts::doDecrementSlow
                    _swift_release_dealloc        <- SIGSEGV
```

`node_modules/expo-notifications/ios/ExpoNotifications/Notifications/NotificationCenterManager.swift`
is the whole explanation:

```swift
public class NotificationCenterManager: NSObject, … {
  @objc public static let shared = NotificationCenterManager()
  var delegates: [NotificationDelegate] = []
  public func addDelegate(_ delegate: NotificationDelegate) {
    delegates.append(delegate)
```

A process-global singleton holding a plain Swift `Array`, mutated with **no
synchronisation of any kind**. Append to one of those from two threads at once
and the buffer's old storage is released twice; releasing a freed object through
a signed pointer is exactly `_swift_release_dealloc` on a non-canonical address.

And it was being appended from more than one thread. At the instant of the
crash, **six other threads were inside Expo module registration**: 25 in
`HandlerModule.init(appContext:)` under `ModuleRegistry.register`, 14, 16, 18
and 20 building `AsyncFunction` dynamic types inside a `definition()`, 22 in
Swift's protocol-conformance cast machinery. The process carried **eight**
`com.facebook.react.runtime.JavaScript` threads and **ten** `hades` — Hermes'
garbage collector, one per runtime. A shipped app has one of each.

Why a debug build has eight is in the simulator's own log:

```
02:28:41.317  GET http://localhost:8081/.expo/.virtual-metro-entry.bundle?platform=ios&dev=true&lazy=true…
02:29:14.749  … cancelled                     (33.4 s later)
02:29:15.943  … start                         (a second connection)
```

The dev bundle did not arrive. At the crash instant thread 6 was inside Hermes'
`ESTreeIRGen`, still compiling JavaScript. A debug build fetches its bundle over
HTTP from a Metro that was, at that moment, building 2 655 modules on a host at
load 41 with two simulators on it; a release build has `main.jsbundle` inside
it, registers its modules once, and never opens that socket.

So this is neither "a product defect" nor "merely host load". It is a real
memory-safety bug in a dependency, whose precondition — concurrent Expo module
registration on several React Native runtimes — **the shipping configuration
cannot reach**, and which host load made likely enough to hit once.

Nothing in `src`, `app` or `supabase/functions` can lock another package's
global, and there is no in-app mitigation worth shipping: the correct fix is
upstream, in `expo-notifications`. What this phase owes instead is a measurement
rather than that argument, so the device QA below was re-run against a **Release
build** — no Metro, no bundle fetch, one runtime.

### The Release sweep, and the four things only it could find

Every Maestro flow this project has ever run went against a Debug build. The
sweep was repeated against `--configuration Release` — `main.jsbundle` embedded,
no `Arc21.debug.dylib`, no Metro socket — and it found four defects, all of them
in the harness rather than the product, and each of a kind the Debug sweep could
not have reached.

**The measurement the crash needed.** Eighteen flow runs, and
`~/Library/Logs/DiagnosticReports/` gained **no Arc21 report at all** — the
newest is still the 02:29 one analysed above. Concurrent module registration
cannot happen where modules are registered once.

#### 1 · `online-leave-mid-hand.yaml` assumed the deal lands in PLAYER_TURNS

It bet, waited for cards and tapped "Leave table". A run whose dealer showed an
ace failed there, and the saved hierarchy had `insurance-decline` and
`insurance-take` in it and nothing else. `CLAUDE.md` already records this
assumption failing two SERVER tests — "the cascade after betting closes stops in
three places, not two" — and the flow I wrote for F-06 this same phase made it
again, in a file whose whole purpose is a hand that is still live.

About one hand in thirteen. Fixed by answering each state at the top level of an
iteration and only then asserting `action-stand`, which is what makes the refusal
that follows a refusal rather than an ordinary between-hands leave. Two
consecutive runs after the fix: 25 steps, exit 0, at loads 3.9 and 8.2.

#### 2 · `scripts/e2e-account.ts` said a mid-hand table "will settle on its own"

It cashes an account out of any table an earlier run abandoned. A seat refused
`SESSION_BUSY` was left alone, with that sentence as the reason. It is true of a
table with clocks and **false of every table this account plays**: solo, career
and the daily challenge carry no clocks on purpose, so `RESOLVE_TIMEOUT` can
never fire and a hand left mid-play stays mid-play for ever. Finding 1 left
exactly that, and the next flow was answered "You are already seated at a
table" — the product working, and unstageable.

Now the hand is PLAYED OUT first through `game-command`, with the same three
branches `reachPlayerTurns` needs, and then cashed out. Standing and declining
are the server's own absent-player defaults, so nothing is played differently
from letting a clock run out. Measured: `played out a hand left mid-play, then
cashed out`, and the seat gone.

#### 3 · `sign-in.yaml` still pasted, and the rewrite that fixed pasting never reached it

`mc-sign-in.yaml` types its credential and its comment says why: *"the paste path
proved unreliable on the second simulator — three taps on Paste reported
COMPLETED and left both fields empty, which is the failure screenshot that sent
this flow back to be rewritten."* That rewrite was never carried across to
`sign-in.yaml`, which **four** server-configured flows use, so the identical
failure was still waiting there.

`every-screen-online.yaml` found it: both `Tap on "Paste"` steps COMPLETED, and
the failure screenshot is the Sign in screen with an untouched
`you@example.com` placeholder. Sixth instance of "a step that COMPLETED did not
necessarily do anything", and the reason the paste existed does not apply here at
all — it is the CREATE-ACCOUNT screen whose `textContentType="newPassword"`
swallows typing; this is the sign-IN screen, which types fine.

Two things were wrong and both are fixed. It types now, erasing first so a
dropped character is retyped rather than appended — which is what makes the
surrounding loop a retry instead of a second way to fail. And its exit condition
was `home-practice`, **which a guest also sees**; a sign-in that quietly failed
would have satisfied it. It is `header-chips` now, a balance a guest never has,
which is the distinction `mc-sign-in.yaml` had already drawn. The flow went from
7 completed steps to 40 on the next run.

#### 4 · The notifications screen was asserted EMPTY, and the account is not fresh

`every-screen-online.yaml` waited for `notifications-empty`, with a comment
beside it reading "an empty inbox is the honest answer for a fresh account" —
which names the assumption that expires. `two-client-public-*` seats this account
at a PUBLIC table, a public table carries clocks, and the server writes a
`your_turn` notification exactly when it has **applied a default**. One real row,
written at 18:58:09, and a correct screen failed a correct-looking assertion.

Fourth instance in this project of a test asserting a global, time-dependent fact
rather than a relationship — after the pgTAP file that counted global rows, the
leaderboard place, and the daily-challenge superlative.

The screen's actual promise is that it never leaves you looking at nothing:
either it says WHY it is empty, or it lists what it has. That is now what is
asserted, and it needed one product change to be assertable at all — the list had
no stable identifier, because `notifications-mark-all` renders only while
something is unread. `testID="notifications-list"` is the whole of it.

---

## The evidence gap phase 7 deferred, now closed

Phase 7 built public multiplayer and never walked it on two devices.
`public-matchmaking.yaml` proves the lone-player wait, the twenty-second offer
and the tier gate, and stops before a seat is ever taken — one account cannot be
two players.

Five flows now run the whole lifecycle across **two simulators with two real
accounts**, and the server is asked as each of them, through PostgREST, never
with the service key:

| step | flow | what only this can prove |
|---|---|---|
| 1 | `two-client-public-queue.yaml` | a genuine wait, and "you are only charged once a seat is opened" |
| 2 | `two-client-public-join.yaml` | the second player's poll opens the room and takes the first seat |
| 3 | `two-client-public-seat.yaml` | "1 already seated", and the other player's handle on a device that has never seen theirs |
| 4 | `two-client-public-leave.yaml` | a live seat is addressable after a relaunch, and cashes out |
| 5 | `two-client-public-survives.yaml` | **the table did not end with the other player's seat** |

Measured at the moment both were seated — two independent tokens, the same
`game_session_id`:

```
session 51ed7726-… mode public_table
 seat 0 pe362917cce03 stack 2000 active connected True
 seat 1 p6e261eee9bae stack 2050 active connected True
```

and immediately after one left:

```
 seat 0 pe362917cce03 stack 0    left   connected False
 seat 1 p6e261eee9bae stack 2080 active connected True
```

The ledger closes: each account exactly one `table_buy_in -2000` and one
`table_cash_out`, no orphaned escrow.

**Walked again, end to end, against the RELEASE build.** All five steps green,
and the server asked as each account through PostgREST at the moment both were
seated:

```
session a52dce04-5d77-4f05-9b17-11b5e7657e61   mode public_table
  seat 0  p0d2f786d6da0  stack 2020  buy_in 2000  active  connected
  seat 1  pa6ae05cf32cf  stack 2000  buy_in 2000  active  connected
wallets: 23 000 and 23 000   (25 000 opening grant, one 2 000 buy-in each)
```

and the ledger read back per row rather than summed, because a sum over a time
window clips whatever it starts after — device B has exactly one
`table_buy_in -2000` at 18:55:55 and exactly one `table_cash_out +2000` at
18:59:29, and device A's five tables across the whole sweep are five buy-ins and
five cash-outs, strictly alternating, never two of either in a row. Wallets after
everyone had left: 25 000 and 25 035, which is the opening grant plus what the
cards did.

Three things had to be learnt to stage it at all, and each is written into the
flows:

- **Allocation is global, so the pool must be drained first.** A public table
  left by `npm run test:server` is a table the device account is CORRECTLY
  matched into — the first run was answered "Seat found — 4 already seated",
  which is the phase 7 fix working exactly as specified and makes the scenario
  impossible to stage. `scripts/e2e-public-drain.ts` is the narrow version of
  the `supabase db reset` that `public-matchmaking.yaml` demands for the same
  reason.
- **A waiting queue entry expires in five minutes, and an expiry releases the
  room seat.** A relaunch between allocation and taking the seat does the same:
  measured, both `room_members` rows went to `left` and the room closed with
  nobody having taken a seat. Step 3 therefore does not relaunch.
- **A tap that reports COMPLETED did not necessarily do anything.** Twice —
  once on the tier chooser, once on the resume card — a tap was swallowed while
  the screen settled, and the failure surfaced a minute and a half later on the
  OTHER simulator as "never matched". Both are now tapped inside a `repeat`
  guarded on the control disappearing.

---

## Continuous integration

**A real runner has now executed this workflow.** The header of
`.github/workflows/ci.yml` said "there is no remote and no CI runner has ever
executed this workflow"; that was true when written and had stopped being true —
`origin` is a private GitHub repository holding `main` and the working branch,
and `gh` is authenticated with the `workflow` scope. The comment is corrected
rather than left to be read as current.

Validated locally first, because a workflow that names a script which does not
exist fails on the runner for a reason that has nothing to do with the code:
every `run:` step invokes an npm script that is present in `package.json`, and
the two-job split is real — `checks` EXCLUDES `tests/server/**` and `database`
runs it with `ARC21_REQUIRE_SERVER_STACK=1`, so a stack that fails to come up
reports a broken stack rather than a green suite that tested nothing.

**Both jobs failed on the first run, and every failure was real.** Everything was
green locally; none of these could be seen on this machine at all. This is the
whole reason the brief said not to call CI complete because a YAML file exists.

Four runs, and the progression is the evidence:

| run | `checks` | `database` | what it found |
|---|---|---|---|
| 1 | fail | fail | F-07 (every `public` function anon-executable) and F-08 (art byte-compare) |
| 2 | fail | fail | expo-doctor's thirteen drifted packages; a cold-worker timeout |
| 3 | fail | **pass** | F-09 (the bundle needs a directory only a previous bundle creates) |
| 4 | **pass** | **pass** | — |
| 5 | **pass** | **pass** | the Release-sweep fixes, re-validated on the runner |
| 6 | **pass** | fail | two assertions about a SHARED public table — on a commit that changed two markdown files |
| 7 | **pass** | **pass** | — |

Runs 4 and 5 are green on both jobs: lint, typecheck, Edge Function typecheck,
2,395 unit tests, coverage, `expo-doctor` 21/21 and the iOS bundle on one side;
and on the other `supabase start`, every migration applied from empty, 560 pgTAP
assertions and all 300 server integration tests against a real stack.

Run 5 matters for a reason beyond being green. The Release sweep changed a
product file — one `testID` — and the pgTAP and server suites are the two gates
this machine had not re-run since. Rather than assert they were still valid, the
runner re-applied every migration from empty and re-ran both suites against the
exact commit: `33796454953`.

### Run 6 · a DOCS-ONLY commit failed the database job

The commit after run 5 changed two markdown files and nothing else, and
`pgTAP and server integration` **failed**. That is the strongest evidence a
failure can carry that it is not about the change: it is about the suite.

```
FAIL tests/server/public-table.integration.test.ts
  › the public buy-in is one atomic escrow › debits once, records one ledger row…
    AssertionError: expected 6000 to be 4000
  › a second live seat is refused before any chips move › refuses a public buy-in while a SOLO table is live
    AssertionError: expected 'SESSION_CLOSED' to be 'SESSION_ALREADY_ACTIVE'
```

Both are the lesson this file's own helper already carries in a doc comment —
**a shared public table is not your test's table** — reaching two assertions
that had not been told.

`6000` is three seats of 2 000. The line asserted `escrow_chips === buyIn * 2`,
which is a claim about the WHOLE table, and a public table keeps taking players
while it has room: that is the phase 7 fix working as specified, and allocation
is global, so a file running beside this one is legitimately entitled to the
third seat. It now asserts `escrow === Σ stacks` — the invariant that actually
matters, nothing minted or stranded on the way in — which holds for any number
of players and is strictly stronger than what it replaced.

The second is two correct refusals and a test that assumed which one it would
get. A room closes when the last seat at its table leaves, and
`JOIN_PUBLIC_TABLE` checks the room's status **before** it looks at who is
asking — correctly, because a closed room must take no more buy-ins. So
strangers finishing with the room made `SESSION_CLOSED` the true answer. The
fix is to make the premise real rather than assumed: the partner takes their
seat first, a seat nobody has given up cannot be closed out from under the test,
and the guard under test becomes the only thing left that can refuse.

**The first reproduction attempt proved nothing, and said so only in its own
log.** A seeder was written to seat a stranger into the casual pool on a loop;
the test then passed, which looked like evidence. It was not: the seeder had
died instantly on `Top-level await is currently not supported with the "cjs"
output format`. Reading the seeder's own output rather than the test's is what
caught it — the same rule as every "COMPLETED but did nothing" note in
`CLAUDE.md`, one layer out.

**Then the faithful condition found a third.** Rather than tune the synthetic
seeder, the reproduction that matters is CI's own invocation —
`npm run test:server`, which is `--maxWorkers=2` and therefore two files sharing
the pool exactly as the runner does. It threw
`unexpected phase while standing out a hand: INSURANCE_OFFER` from inside
`closeTable`: `standToSettlement` handled PLAYER_TURNS, HAND_COMPLETE and
SESSION_COMPLETE, and a dealer ace is none of them. **Third helper in this
project to make that assumption**, after the two `CLAUDE.md` already records —
about one hand in thirteen, and nothing to do with contention at all.
`dealAHand` needed the neighbouring fix: betting closes on the LAST seat to
lock, so a stranger who has not bet leaves it open until the 15-second deadline,
which a snapshot's own `RESOLVE_TIMEOUT` is what asks for.

Run 7 is green on both jobs with those four fixes in it.

**Where the hardening stopped, and why.** Driven harder — a fresh stranger
seated every three seconds — the suite fails in ways no test change should
address: a five-seat pool saturates, and `expected 409 to be 200` on a public
buy-in is a player being told a table is full, which is the product working.
That is past the condition CI creates, so it was not chased. The calibration
that counts is CI's own, and against it the suite ran **four consecutive times,
300 of 300, exit 0.**

### F-07 · Every function in `public` shipped anon-executable, depending on who applied the migrations · fixed

The `database` job stopped at `20260813121200_hardening.sql` — thirteenth of
the set — with

```
ERROR: anon can execute unexpected public function(s): apply_block_side_effects,
are_friends, create_friendship_on_accept, deny_client_write, deny_truncate,
guard_daily_challenge_seed, guard_friend_request_transition,
guard_ledger_append_only, guard_loadout_slots, guard_notification_client_update,
guard_profile_server_columns, guard_profile_username,
guard_session_escrow_on_delete, has_blocked, is_session_participant,
normalise_profile_display_name, sanitise_display_name, set_updated_at,
username_is_permitted, viewer_has_blocked, viewer_is_blocked_by,
viewer_is_friend_of, viewer_is_in_tournament (SQLSTATE P0001)
```

The gate was right, and it had never been asked on a database built the way a
deployment builds one.

`20260813120000_foundation.sql` revokes default privileges in `private` on
tables, sequences **and functions**, then says "the same protection for
`public`" and revokes tables and sequences only. The functions line was missing.

Why that was invisible here: `pg_default_acl` carries one row per (role, schema,
object type), and the stock image ships **both**

```
postgres       | public | f | {postgres=X/postgres}
supabase_admin | public | f | {postgres=X, anon=X, authenticated=X, service_role=X}
```

So the protection depended entirely on WHICH ROLE applied the migrations. The
CLI on this machine applies them as `postgres`, where the default grants nobody
EXECUTE; the newer CLI `supabase/setup-cli@v1` installs applies them as
`supabase_admin`, where the default grants **anon**. Twenty-three functions —
the trigger guards and the RLS helper predicates, `deny_client_write`,
`guard_ledger_append_only` and `guard_session_escrow_on_delete` among them —
were therefore executable by an unauthenticated caller on any database built
that way.

Fixed by adding the one line the comment already promised. It is a DEFAULT
privilege, so the explicit `revoke … from public, anon; grant … to
authenticated;` pair that every client-facing function carries still does its
own job — this makes the pair's first half redundant rather than load-bearing,
which is the right way round.

### F-08 · The app-art test could only ever pass on the machine the art was generated on · fixed

The `checks` job failed with `icon.png drifted from its generator` and 2,394 of
2,395 tests green.

`scripts/generate-app-art.ts` writes its IDAT with `deflateSync(raw, { level: 9 })`
from `node:zlib`, and the test compared the whole file byte for byte. Node does
not bundle one zlib: a macOS arm64 host and a Linux x64 runner emit different,
equally valid compressed streams for identical input. The committed PNG could
only ever match on the platform it was generated on.

The claim the test defends is `docs/ASSET_LICENSES.md`'s "originally generated",
which is a claim about the IMAGE. It now decodes both sides with the strict
reader already in the file and compares dimensions and pixels — not weaker,
because that reader still refuses anything but the exact PNG shape the generator
writes, so a drift in size, bit depth, colour type, chunk layout or one pixel
still fails.

### F-09 · The app could only be bundled on a machine that had bundled before · fixed

The third CI run got the whole `database` job green — `supabase start`, every
migration from empty, pgTAP and the entire server suite on a runner — and
`checks` failed at the last step:

```
iOS Bundling failed 30608ms node_modules/expo-router/entry.js (2619 modules)
Error: Failed to get the SHA-1 for: node_modules/react-native-worklets/.worklets/12466881117457.js
```

Bundle Mode has the Babel plugin extract every worklet into its own file under
`node_modules/react-native-worklets/.worklets/`, and `generatedWorkletsDir` is a
hard-coded constant, so there is nowhere else for them to go. They are written
DURING the transform, and Metro builds its file map by crawling once before
transforming anything — so `getSha1` fails for a path the crawl never saw.

On a machine that has bundled before, the directory is already populated when
the crawl runs and nothing goes wrong. **That is why this was invisible here for
the entire life of the project and failed on the first clean checkout CI ever
gave it.** Reproduced locally by moving the directory aside, and the two failure
modes are different: with the directory ABSENT the plugin cannot write at all
(`ENOENT … open '.worklets/12466881117457.js'`), and with it EMPTY the write
succeeds and Metro cannot hash the result — which is the runner's error.

`npm run bundle:check` creates the directory, bundles once to generate the
artefacts (that pass is expected to fail and its result is discarded), then
bundles again for the result that counts. Verified from a state with no
`.worklets` directory at all: pass one leaves 509 files, pass two exits 0.

---

### F-10 · A public table became unjoinable once seven players had passed through it · fixed

Found by accident, which is the point: the load generator written to reproduce a
FLAKY TEST produced eleven HTTP 500s from the product, and the test log said
only `expected 500 to be 200`. The runtime log said the rest:

```
{"level":"error","message":"session command failed","fn":"create-session",
 "commandType":"JOIN_PUBLIC_TABLE","code":"INTERNAL",
 "detail":"PostgresError: new row for relation \"game_session_seats\"
           violates check constraint \"game_session_seats_seat_index_check\""}
```

`JOIN_PUBLIC_TABLE` allocated its seat as

```sql
(select coalesce(max(seat_index) + 1, 0) from public.game_session_seats
 where game_session_id = …)
```

over **every row the session had ever held**, and `game_session_seats_unique_index`
reserved an index for a seat that had long since left. `seat_index` is
`check (seat_index between 0 and 6)`. So the **eighth person ever to sit at a
public table** was handed index 7 and the insert was refused by the check —
which the function turns into HTTP 500 INTERNAL, not a refusal a player can act
on.

**It is not the full-table case.** That one is handled correctly, by a guard
that counts live seats under the room lock and answers `TABLE_FULL`. The shape
that matters has seats FREE. Reproduced deliberately in SQL, two live seats and
five departed:

```
 live_seats | rows_ever | highest
          2 |         7 |       6
ERROR:  new row for relation "game_session_seats" violates check constraint
        "game_session_seats_seat_index_check"
```

Three of five seats advertised, and nobody able to take one. And a public table
stays `active` while anybody is sitting at it, so matchmaking keeps allocating
it: from the eighth arrival onwards it offered seats to everyone and answered
500 to all of them, **for the life of the table**. Turnover of seven is an
ordinary evening at a five-seat table, not an attack.

The uniqueness that matters is over LIVE seats. A departed seat's row is kept on
purpose — `display_name` is a copy taken when the seat opened, and a game other
people played is not deleted under them — but it is history, not an occupant. So
the constraint became a **partial** unique index over `status <> 'left'`, and the
allocator picks the lowest index no live seat holds. No `coalesce` is needed:
the occupancy guard runs with the room row locked, live seats hold distinct
indices, and one of the `max_seats` candidates is therefore always free.

`26_seat_index_reuse.test.sql` pins both halves, because a file that only proved
a freed index is reusable would pass against a table with no uniqueness at all:
the eighth arrival is given seat 0, the departed player's row is still there, and
**two live seats on one index are still refused with 23505**.

Measured across two runs of the whole server suite under the same load:

| | `JOIN_PUBLIC_TABLE` → HTTP 500 |
|---|---|
| before | **11** |
| after | **0** |

The only INTERNAL errors left in the runtime log are the two a fault-injection
test asks for by name.

---

## Gates

| gate | result |
|---|---|
| `npx tsc --noEmit` | 0 errors |
| `npm run lint` | 0 errors, 37 warnings (unchanged baseline) |
| `npm run check:functions` | all three functions typecheck |
| `npm run test:unit` | **122 files, 2,395 tests, all pass** |
| `supabase db reset` + `supabase test db` | **27 files, 567 assertions, all pass, from empty** |
| `npm run test:server` | **23 files, 300 tests, all pass — four consecutive runs** after the run-6 fixes (fresh `functions serve`) |
| `npm run benchmark` | 795 µs/hand at load 4.4 — inside the recorded 752–808 range; heap delta +10 KB over 50 hands |
| Maestro, Debug build | practice ×3, career-node, online-table, every-screen ×2, online-leave-mid-hand, two-client-public ×5 |
| Maestro, **Release build** | **18 green runs**: practice-hand, practice-analysis, practice-resume, career-node, online-table ×2, online-leave-mid-hand ×2, every-screen-online, private-lobby, public-matchmaking, mc-sign-in ×2 and all five two-client-public flows — and **no Arc21 crash report written by any of them** |

### Two server tests were wrong, not the server

**The sprint tournament's twelve-hand run.** `expect(bettingOrders).toHaveLength(12)`
failed as `expected [ … ] to have a length of 12 but got 13` on a run where
every other assertion passed. The cards left two players level at the final
boundary, the server played a tie-break hand to separate them, and that hand has
a betting round like any other. A correct server, a fair deal, and a test that
assumed no tie — with the comment fifteen lines above it already saying "a
sudden-death hand is an extra hand at its boundary", which is what the
`ceilings` assertion had been written to tolerate and this one had not. It now
asserts `scheduled_hands_played + tie_break_hands_used`, the server's own
counters, so the relationship holds however the cards fall.

### And the daily challenge

`game-command.integration.test.ts` asserted that
`latest_verifiable_daily_challenge()` returned the 2019 fixture it had just
inserted. That function answers with the most recent revealed challenge, so the
assertion was a claim about every OTHER row in the table.
`scripts/e2e-account.ts` creates yesterday's challenge deliberately — the reveal
needs something to publish — and the moment it had been run before the suite, a
correct answer failed a correct-looking test: `expected '2026-09-02' to be
'2019-07-04'`.

Fixed by asserting the relationship rather than the superlative: the fixture's
own row IS revealed, and whatever row the function returns is a CLOSED one. The
same mistake as the pgTAP file that counted global rows and the leaderboard test
that asserted a place — third instance, one layer up.
