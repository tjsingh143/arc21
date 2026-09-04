# Phase 11 — independent reverification

**Result: PASS, after three product defects were found and fixed.** The phase-11
verdict itself holds: every one of its ten findings is present, wired to a
regression, and — where I reverted it — provably failing without its fix. What
this pass adds is what phase 11's own fix made reachable and nobody looked at:
**a public table's engine seat list grew without bound as players came and
went**, and beneath it two more defects on the same path — **leaving a public
table left a matchmaking reservation behind that refused the player's next
search for two minutes**, and **the seat a returning player was handed was the
one they had already left**.

All three were reproduced against the running stack, fixed at the root, given
regressions at the level that can actually fail (HTTP, pgTAP, the device), and
each fix was proved by reverting it and watching the new test fail.

Verified commit: `98c6301` — *phase 11: record the CI progression through run
10*, the tip of `phase11-adversarial-qa`, and the commit CI run **33808002785**
is green on.

**This pass's own fixes are commit `fc5568e`, and they are now on the remote and
green on a runner of their own — run 33848267009, both jobs, first attempt.**
The two evidence gaps the reverification recorded are closed in §X and §Y: the
push and its CI run, and a registry-backed dependency audit that `npm audit`
itself still cannot provide here.

`.claude/RESUME.md` carries the same summary and is deliberately untracked —
`.git/info/exclude` holds it, as the local resume checkpoint it is.

---

## What was checked, and how

Nothing below was accepted because a report, a comment or a green suite said so.
Where a claim was about behaviour, the behaviour was measured; where a fix was
claimed, the fix was reverted and the failure observed.

| area | how it was verified here |
|---|---|
| public-table seat reuse (F-10) | 16 players driven through one table over HTTP; the allocator reverted in the running function and the eighth arrival answered **HTTP 500** again |
| engine seat growth | measured: 12 seats on a 5-seat table, snapshot 2,040 B → 6,442 B — **new defect V-01** |
| leaving and searching again | measured: **HTTP 403 NOT_A_PARTICIPANT** for two minutes — **new defect V-02**, and **V-03** underneath it |
| native crash | the `.ips` re-parsed: `EXC_BAD_ACCESS`, thread 27, `NotificationCenterManager.addDelegate`, **`Arc21.debug.dylib`**, 8 JS runtimes, 10 `hades` |
| Release build | both simulators carry `main.jsbundle` and no debug dylib; 31 flow runs tonight, **no Arc21 crash report written** |
| dependencies | `npm ls decode-uri-component` walked; every live `query-string` call read; the reachability test's positive control confirmed |
| bounded reads | the four boards, push registration and `search_players` re-measured over PostgREST; the whole catalogue of client-callable set-returning functions re-read |
| replay, races, hostile client, Realtime, RLS | `npm run test:server` — **23 files, 302 tests, all pass** on a fresh runtime |
| deep links | four hostile links opened **on the device**; the table screen obtains no state |
| local tampering | the simulator's SQLite **hand-edited** and the app relaunched |
| accessibility | asserted on the **rendered** Release build: "Dealer hidden card", `.* of (Spades\|Hearts\|Diamonds\|Clubs)`, "Add 100 chips" |
| two-simulator public lifecycle | walked **twice**, end to end, on two Release builds and two real accounts |
| CI | run **33848267009** on the reverified code itself (`fc5568e`): both jobs green on a real runner, first attempt |
| dependency advisories | 926 lockfile versions asked of the **GitHub Global Advisory Database**; 6 advisories, **0 of them in the shipped bundle** — proved from Metro's own source map |

---

## A · Ground truth

Working tree clean at `98c6301` apart from an untracked `AGENTS.md` (a copy of
`CLAUDE.md`, not referenced by anything and left alone). Branch
`phase14-s2-security`, tracking `origin/phase11-adversarial-qa`, checked out at
the phase-11 tip.

`gh run list` shows **eleven** real CI runs on this branch, not ten: the report's
table describes runs 1–10 and the eleventh is the run on the commit that
recorded the table. Its result is the one that matters —

```
33808002785 success 98c6301a4   Lint, typecheck, unit tests, bundle: success
                                pgTAP and server integration:      success
```

so phase 11's HEAD is green on both jobs on a real runner. **My own changes have
not been through CI**, because this pass does not push; they are validated
locally against the same gates, and the distinction is stated rather than
blurred.

---

## B · The phase-11 defect ledger, re-checked

| # | claim | present | regression | verified how |
|---|---|---|---|---|
| F-01 | leaderboard page had no ceiling | `leaderboard_page_maximum()` = 10,000, read by all four boards **and** `my_leaderboard_position` | `25_bounded_reads.test.sql` (moves the ceiling to 3), `bounded-reads.integration.test.ts` | re-measured over PostgREST: `p_limit = 2147483647` answers 200, bounded |
| F-02 | unlimited push registrations | `push_tokens_per_account_maximum()` = 10, eviction excludes the token just written | 40 registrations → 10 rows, including the newest | ran in the server suite |
| F-03 | `search_players` was an unmetered dump | `escape '\'` + `player_search` policy (30/min, 300/hr), limit spent **before** the length guard | `bounded-reads.integration.test.ts` | re-measured: `%%`, `%_%`, `__`, `%a` all **0 rows**; a 108-call walk refused with `PT429` |
| F-04 | notification payload interpolated into a route | `looksLikeRoomCode` + a uuid pattern in `destinationFor` | `tests/notifications/notifications.test.ts`, incl. `../../settings` | read; and the database refuses an unexpected key at all (`notification_data_is_safe`) |
| F-05 | assistance pills broke at large text | `STACK_ABOVE_FONT_SCALE` in `type-metrics.ts`, read by `StrategyPanel` and `ScreenHeader` | `tests/design/font-scale-stacking.test.ts` | read; ran in the unit suite |
| F-06 | a held leave stranded the player | `shouldExitAfterHeldLeave` in `leave-guard.ts`, called from the table screen | `tests/table/leave-guard.test.ts`, `tests/e2e/online-leave-mid-hand.yaml` | read; the leave path re-walked on two devices tonight |
| F-07 | every `public` function anon-executable | the missing `alter default privileges … revoke all on functions` line in `20260813120000_foundation.sql` | `20_authorization_surface.test.sql` + the gate called from the migration | applied from empty tonight; 576 pgTAP assertions pass |
| F-08 | app-art test could only pass on one platform | the test decodes and compares pixels | `tests/art/generated-app-art.test.ts` | ran in the unit suite |
| F-09 | the app could only be bundled on a machine that had bundled before | `scripts/bundle-check.sh`, two passes, only the second gating | the script itself | `npm run bundle:check` exit 0 tonight |
| F-10 | a public table became unjoinable after seven players | partial unique index + lowest-free-index allocator | `26_seat_index_reuse.test.sql` | **reverted and reproduced** — see §C |

Nothing in the ledger was found absent, mis-wired, or defended by a test that
could not fail. Two smaller things were found **stale rather than wrong**, and
both are corrected in `docs/SECURITY.md`: the rate-limit table never gained the
`player_search` row phase 11 added, and the injection table still claimed
`search_players('%_%')` returns "25 rows, the function's own cap" — which was
true before F-03 escaped the metacharacters and is **0 rows** now, re-measured.

---

## C · Public-table seat reuse, and what it uncovered

### F-10 holds, and was proved by reverting it

`scripts/`-free throwaway harness, driving only the real production path — auth
admin to mint accounts, PostgREST for matchmaking, `create-session` for
`JOIN_PUBLIC_TABLE`, `create-session` for `CASH_OUT` — with a drained pool so
the table under test is the test's own.

**With the allocator reverted to `coalesce(max(seat_index) + 1, 0)` in the
running function:**

```
cycle 1: player 3 seated at index 2 · live=[1,2] rows=3
cycle 2: player 4 seated at index 3 · live=[2,3] rows=4
cycle 3: player 5 seated at index 4 · live=[3,4] rows=5
cycle 4: player 6 seated at index 5 · live=[4,5] rows=6     <- past max_seats
cycle 5: player 7 seated at index 6 · live=[5,6] rows=7
cycle 6 (player 8 ever): JOIN_PUBLIC_TABLE answered 500
  {"status":"rejected","code":"INTERNAL","message":"Something went wrong. …"}
```

Two things that reading the migration would not have told me: the eighth arrival
is refused, exactly as reported — and indices **5 and 6 were handed out at a
five-seat table** on the way there, which the old code permitted because it
counted from the highest index ever used rather than from the room's capacity.

**With the fix restored:** 16 players through one table, indices reused, never
duplicated, never outside 0..6, no refusal.

```
# 16 players passed through the table; 16 seat rows, 2 live
OK: no refusal, no duplicate live index, no out-of-bounds index
```

A **full** table still refuses the way a player can act on. Staged with five live
seats and a sixth account holding the `joined` membership the guard's own comment
says can outlive its allocation:

```
sixth arrival: HTTP 409 {"code":"TABLE_FULL","message":"That table just filled up.
                         Nothing has been charged."}
live seats after the refusal: 5; table ledger rows for the refused account: 0; balance 25000
```

`26_seat_index_reuse.test.sql` proves the constraint and the allocator
expression; what it cannot do is ask the FUNCTION. That gap is now closed by
`tests/server/public-table.integration.test.ts` → *"seats the eighth arrival, and
never carries more seats than it has"*, which drives nine arrivals through one
table over HTTP.

### V-01 · A public table's seat list grew without bound · FIXED

**The defect phase 11's own fix made reachable.** Until F-10, the eighth arrival
was answered 500 — which accidentally bounded how many departed seats one table
could accumulate. With that removed, `joinPublicTable` **appended** every
arrival to the engine's seat list and nothing ever removed one.

Measured on the running stack, ten ordinary arrivals and departures at a
five-seat casual table, reading the snapshot as the resident player:

| after | seats in `publicState` | of which departed | snapshot bytes |
|---|---|---|---|
| 1 turnover | 3 | 1 | 2,040 |
| 5 turnovers | 7 | 5 | 3,997 |
| 10 turnovers | **12** | **10** | **6,442** |

That list is persisted under lock on every command, returned in every response,
broadcast to every subscriber, and **drawn on every remaining player's screen**:
`app/table/[gameId].tsx` renders every seat that is not the viewer's own, and a
departed one renders as their display name, a zero stack, "Yet to bet" and
*"Disconnected — their clock keeps running."* — which is not true of somebody
who has left.

**The fix** is in the same place F-10 was, and is the same idea one level up: a
newcomer takes a **vacated slot** in the engine's seat list, exactly as they take
the seat INDEX a departure freed. `isVacatedSeat` in
`shared/blackjack/table-closure.ts` is the predicate — the mirror of
`canCloseSeat`, which answers "may this seat leave"; this one answers "has it,
completely": `connected` false **and** no chips, no wager, no insurance, no hand.

All five conditions carry weight. A player who leaves **mid-hand** is
`connected: false` immediately while their committed hand resolves — "leaving is
never a way to escape a committed wager" — so their slot is not free until that
hand is over and the stack has gone back. A tournament seat eliminated with chips
still on it is excluded by `stack`, because the result screen reports the
bankroll they went out on.

The list is therefore bounded by `max_seats` by pigeonhole: a slot is only
appended when every existing one is live, and the occupancy guard has already
refused `TABLE_FULL` unless a live seat is missing.

**After, same measurement, twelve turnovers:**

```
cycle 1 … cycle 12: publicState seats=2 ghosts=0 payload=1551B engine_seats=2
```

Constant. And the accounting still closes: 12 players through, 12 rows of
history, 2 live seats, `escrow_chips` 4,000 = Σ live stacks 4,000.

**Proved by reverting.** With the slot reuse removed and everything else in
place, the new integration test fails at exactly the assertion written for it:

```
AssertionError: after 6 arrivals: expected 6 to be less than or equal to 5
```

### V-02 · Leaving a public table left a reservation that refused the next search · FIXED

Found while asking §C's own question — *does a stale seat block a future
legitimate allocation?* — from the player's side rather than the table's.

`release_room_seat` sets the departing player's `room_members` row to `left` and
left `matchmaking_queue` reading **`matched`**, naming the room they had just
left. `join_matchmaking` returns a live entry rather than enrolling again —
deliberately, and its comment says why: *"a matched player who re-queues is
reconnecting to the room they were already given"*. So the next search handed
back a room this account was no longer a member of, the screen said **"Seat
found"**, and the buy-in came back:

```
B re-matched into the SAME room
B rejoin: HTTP 403 {"code":"NOT_A_PARTICIPANT","message":"You do not hold a seat at this table."}
```

`matchmaking-store.ts` renders that message and leaves the "Take the seat"
control on screen, so every further tap was refused the same way — until
`expire_stale_queue_entries` retired the reservation **two minutes** after it was
made. A player who left a public table could not take another one in that window.

**The fix is at both ends**, because they answer different questions.
`release_room_seat` is where the reservation is spent, so that is where it is
closed; and `join_matchmaking` will not hand back a `matched` entry whose
membership has gone, *whatever* emptied it — which is what makes the guarantee
hold for a room emptied by some path nobody has written yet. The reconnect the
branch exists for is untouched and asserted: a matched player who has **not**
bought in still holds a `joined` row, put there by the allocation itself.

`supabase/migrations/20260907120000_leaving_clears_the_reservation.sql`, with
both bodies taken from the last migration to define each function, per the
`create or replace` rule.

### V-03 · A returning player was handed the seat they had left · FIXED

Fixing V-02 made this reachable, and it would have been worse than what it
replaced: the rejoin then answered **HTTP 200** while seating the player on their
own departed row.

```
B rejoin: HTTP 200 … "seatId":"5bc4fa5a-…"      <- the seat they LEFT
B wallet after rejoin:   25000                  <- no buy-in taken
B seat rows: 1:left:0                           <- still `left`, still empty
```

Their next command would have been refused `SESSION_CLOSED`, on a table screen
with nothing on it. Two causes, both in `joinPublicTable`:

* `findSeat` answers with the latest seat row **whatever its status** —
  deliberately, because the command that closes a table also ends the seat and
  has to find its own idempotency record on a retry. Reusing that row here made a
  departed seat look like a held one.
* the buy-in idempotency key was `public_buy_in:<game>:<user>`, so a second
  visit found the first visit's ledger row and **skipped the debit**. With the
  seat lookup fixed and the key left alone, that is a funded seat nobody paid
  for.

Both are fixed together: only a **live** seat is reused, and the key is derived
from the **seat** — `public_buy_in:<game>:<seatId>` — the same shape
`cashOutKey(gameId, seatId)` already had, and for the same reason. A retry with a
fresh request id still lands on the same live seat and therefore the same key, so
the property phase 4 established ("a retry with a new request id must not buy a
second seat") is unchanged; a genuinely new visit is a new seat and is charged.

Measured after:

```
B rejoin: HTTP 200 … "buyIn":2000,"walletBalance":23000
B seat rows: 1:left:0 | 1:active:2000
escrow 4000 vs sum(live stacks) 4000
```

### Regressions, and each proved to fail

| regression | reverting… | fails with |
|---|---|---|
| `public-table.integration.test.ts` → *seats the eighth arrival…* | the vacated-slot reuse | `after 6 arrivals: expected 6 to be less than or equal to 5` |
| `public-table.integration.test.ts` → *lets a player who left come back…* | both halves of V-02 | `JOIN_PUBLIC_TABLE was refused: 403 … NOT_A_PARTICIPANT` |
| the same test | only V-03's half | `expected '…' not to be '…'` — the seat id came back identical |
| `27_leaving_clears_the_reservation.test.sql` (9 assertions) | both halves of V-02 | 3 of 9 fail, naming the reservation, the re-enrolment and the second lock |
| `tests/engine/vacated-seat.test.ts` | — | pins the predicate, including the mid-hand and eliminated cases |
| `tests/e2e/two-client-public-leave.yaml` | — | takes the seat after leaving, on the device |

---

## D · The native crash, re-examined rather than re-explained

`~/Library/Logs/DiagnosticReports/Arc21-2026-09-03-023020.ips` is still there and
was re-parsed rather than quoted:

```
exception      EXC_BAD_ACCESS (SIGSEGV) KERN_INVALID_ADDRESS at 0x09be4bead677e1c6
procLaunch     2026-09-03 02:28:35.1170 -0700
captureTime    2026-09-03 02:29:21.8108 -0700
faultingThread 27  (com.facebook.react.runtime.JavaScript)
```

The faulting frames, bottom-up, and the image each belongs to:

```
libswiftCore   _swift_release_dealloc
libswiftCore   RefCounts::doDecrementSlow
libswiftCore   _ArrayBuffer._consumeAndCreateNew(bufferIsUnique:minimumCapacity:growForAppend:)
libswiftCore   Array.append(_:)
Arc21.debug.dylib   NotificationCenterManager.addDelegate(_:)      <- the DEBUG image
Arc21.debug.dylib   closure #1 in EmitterModule.definition()
ExpoModulesCore     ModuleHolder.post(event:)
```

and the thread census, counted from the report rather than taken on trust:

```
 10  hades                                  (Hermes GC — one per runtime)
  8  com.facebook.react.runtime.JavaScript
```

So phase 11's account is confirmed in every particular I can check: the crashing
image is `Arc21.debug.dylib`, the mutation is an unsynchronised `Array.append` on
a process-global in a dependency, and the process carried eight React Native
runtimes when a shipped one carries one.

**What that does not prove is the Release claim**, and phase 11 was right to say
so and to answer it with a measurement instead. I re-established the measurement
from scratch:

* both simulators carry a **Release** build — `main.jsbundle` (6,223,467 bytes)
  present, identical on both, and no `Arc21.debug.dylib` in either bundle;
* the Release products in DerivedData were built at **11:11** and relinked at
  **12:18** on 3 September, and the sweep's own run directories span 11:31–12:30
  — the 12:19 install lands two seconds before the `every-screen-online` run that
  finally went green, which is what a rebuild-and-reinstall looks like;
* **31 Maestro runs tonight** against that build, including the two-simulator
  lifecycle twice, and `~/Library/Logs/DiagnosticReports/` has gained **no Arc21
  report at all**. The newest is still the 02:30 Debug one.

The defensible statement, and the one this report makes: *the crash is a real
memory-safety defect in `expo-notifications`, whose precondition is concurrent
Expo module registration across several React Native runtimes; that precondition
has never been observed in a Release build, and 31 further Release runs did not
produce it.* Not "cannot happen" — that is upstream's to say.

---

## E · Dependencies and the native install

`npx expo-doctor@latest` → **21/21 checks passed**. The installed tree matches
`package.json` (`react-native 0.86.3`, `expo 57.0.19` — three SDK-57 patches
later that day moved this to `expo 57.0.20`, `expo-notifications 57.0.17` and
`expo-router 57.0.19`; see §Z), `package-lock.json` and
`ios/Podfile.lock` are both committed and both older than the Release build that
was produced from them, and `npm run bundle:check` exits 0 from this checkout —
so the build does not depend on an untracked local fix. `git status` shows no
modified native file.

---

## F · The `decode-uri-component` advisory

**Disposition unchanged, and re-established from the tree rather than from the
report.** `npm audit` cannot run here — this environment has no route to the
registry's advisory endpoint, and saying so is part of the answer — so the chain
was walked directly:

```
arc21@1.0.0
└─┬ expo-router@57.0.18
  └─┬ query-string@7.1.3
    └── decode-uri-component@0.2.2      (the vulnerable version)
```

exactly one path, no second consumer. (Re-walked after §Z's SDK realignment:
`expo-router@57.0.19 -> query-string@7.1.3 -> decode-uri-component@0.2.2`, the
same one path, and `tests/deep-links` still 6/6.) Inside `query-string/index.js`,
`decodeComponent` is reached only through `decode()`, and every `decode()` call
site is on the **parse** path; `stringify` encodes.

Inside `expo-router`, the only live `query-string` calls are two
`queryString.stringify` in `fork/getPathFromState*.js` — the outbound direction.
The vendored `react-navigation/core/getStateFromPath.js`, which does call
`queryString.parse`, is **imported by no `.js` file in the package**. That is the
whole of the reachability argument, and
`tests/deep-links/decode-uri-component-reachability.test.ts` pins it with the
vendored copy as a positive control, so a pattern that cannot find the call
proves nothing. It passes: 6 tests.

No known reachable high or critical dependency vulnerability remains.

**Closed by a registry-backed sweep — see §Y, which supersedes this section's
"cannot run here".** The npm advisory endpoint is still unreachable, but the
GitHub Global Advisory Database is not, and it was asked about all 926
`name@version` pairs in the committed lockfile. It agrees: `decode-uri-component
0.2.2` is affected by `GHSA-vcc3-ghjq-m6fr` — recorded there as **moderate**, not
high — and the sweep found four more advisories nobody had looked at, none of
them reachable. The evidence is in §Y.

---

## G · Bounded work per request

The three phase-11 findings re-measured over PostgREST with a real token, and
then the question asked of the **catalogue** rather than of the report: every
`public` function `authenticated` may execute that returns a set was listed and
read. Twenty-five of them. The ones taking a caller-supplied page size —
the four boards and `my_notifications` — are all clamped (10,000 and 100
respectively); the rest are bounded by the thing they describe (a room's seats, a
tournament's four entries, the career map, the cosmetics catalogue, one profile,
`search_players`' own `limit 25`).

One thing worth stating plainly, because the F-03 write-up frames a rate limit as
bounding a directory walk. It bounds **that function**. `profiles` carries a
`SELECT` grant to `authenticated`, so the public half of the directory is
readable straight from PostgREST without touching `search_players` at all —
measured here: **690 profiles in one 68 ms request**, and `anon` refused
`42501`. That is the specification working (a searchable directory, global boards
of "avatar, display name, value") and a `private` or `friends-only` profile is
**not** in the answer, which is the distinction that matters. It is now written
down in `docs/SECURITY.md` beside the limit, rather than left for the next
reader to discover.

---

## H · Replay and idempotency · I · Concurrency

`npm run test:server` — **23 files, 302 tests, all pass, exit 0**, against a
database reset from empty and a freshly restarted `functions serve`. That suite
is where these live, and it covers each item asked for: a replayed OPEN returning
the first committed result; the same command replayed **concurrently**; a retry
with a **fresh** request id buying no second seat; one buy-in, one cash-out, one
career reward, one tournament prize, one recovery grant under eight simultaneous
claims; twenty simultaneous commands of which exactly one is accepted; two
`LOCK_BET`s racing; the same account on two devices; a leave racing a join; a
settlement that rolls back entirely when the prize credit fails.

The two new tests in this pass ride in the same file and add the turnover cases
above.

**One failure was seen and is not a product defect.** In the first full run,
`hostile-payloads` → *"refuses a 32 MB body quickly"* timed out at 120 s. The
runtime log for that run carried **48 CPU soft-limit and 2 hard-limit events** —
the accumulation `CLAUDE.md` already records for a long-lived
`supabase functions serve`. Measured directly against a fresh runtime, the same
request is refused **HTTP 400 in 824–1,845 ms** over three attempts, the whole
file passes in 3.1 s, and the whole suite then passes 302/302. The product
behaviour is the one `SECURITY.md` describes: the body is counted and drained,
never buffered and never cancelled.

---

## J · K · L · M · N · O — the hostile surfaces

**Modified client.** `hostile-payloads` (35), `object-substitution` and
`rls-idor` all pass. Object substitution is the one worth naming: every session
command, **all twelve game commands** and every room RPC, each naming another
player's game, room or attempt, each refused — with the owner's chips and seat
read back unchanged afterwards, and a positive control proving the owner can
still act.

**Realtime.** The suite holds a real `signInWithPassword` session for its
positive control, which is the distinction that cost phase 10 an afternoon: a
hand-signed JWT is not a session, and on a private channel the difference is
invisible until the second message. A subscriber with no seat is refused, an
anonymous one is refused, a forged state pushed by an account with no seat is
refused, and one signed-in player's state does reach another.

**Local tampering — measured, not reasoned.** The device's store is four rows:

```
auth:guest:v1 · onboarding:completion · practice:session · practice:stats
```

No wallet, no XP, no career, no cosmetics, no tournament result — the competitive
values are simply not on the device. I edited what is there: practice bankroll to
**5,000,000**, lifetime hands to **999,999**, net chips to **987,654,321**, the
seat's display name to `TAMPERED`. The app **loaded** the edited save (the table
came back mid-hand from it), so this is about reach rather than about a rejected
file. On the relaunched Release build: the header still showed the server's
wallet, Statistics and Leaderboards showed none of those figures, and the server
read back unchanged —

```
before  wallet=25120 xp=165 level=2
after   wallet=25120 xp=165 level=2 display_name=p9d8bf779cb38 · 33 hands recorded server-side
```

**Rate limits.** Eleven policies in `public.rate_limit_policies`, every window a
row, none carried by an enforcement point — including the `player_search` pair
phase 11 added. `19_rate_limits.test.sql` asserts the absence by pattern-matching
the function bodies. Auth's own limits (sign-in/sign-up 30 per 5 minutes per IP)
are GoTrue configuration in `config.toml`, where `minimum_password_length = 8`
now matches what `credentials.ts` has always required.

**Deep links, on the device.** Four hostile links opened against a signed-in
Release build:

| link | result |
|---|---|
| `arc21://table/<random uuid>` | *"This screen needs a table to open."* — no stack, no cards, no controls, no progress line |
| `arc21://table/../../settings` | same; no table state |
| `arc21://room/ZZZZZZ` | no lobby, no table |
| `arc21://room/%20%20%20` | no lobby |

and the app still alive and still signed in afterwards, which is what stops those
assertions being vacuous. One thing this cost, and it is worth recording: my
first probe asserted `"Leave table"` was not visible and failed — because that is
the **back bar's** label on that screen. The screenshot showed the empty state
rendered correctly. The probe was wrong, not the app.

**Notifications.** `notifications.data` is bounded by a CHECK over a fixed key
set of short scalars (`room_code`, `tournament_id`, `game_id`, `entry_id`,
`challenge_date`, `from_user_id`, `from_display_name`, `placement`, each ≤ 64
characters), so a seed, a shoe or a hole card cannot ride out even by accident;
`destinationFor` shape-checks the two identifiers it routes on.

---

## P · The two-simulator public-table lifecycle

Walked **twice tonight**, end to end, on two Release builds and two real accounts
(`e2e-lobby@` and `e2e-guest@`), with the server asked as each account through
PostgREST — never with the service key.

| step | flow | result |
|---|---|---|
| 1 | `two-client-public-queue` | exit 0 — a genuine wait, "only charged once a seat is opened" |
| 2 | `two-client-public-join` | exit 0 — the second player opens the room and takes the first seat |
| 3 | `two-client-public-seat` | exit 0 — both dealt; the other player's handle on a device that has never seen it |
| 4 | `two-client-public-leave` | exit 0 — leave, and **search again and take a seat** |
| 5 | `two-client-public-survives` | exit 0 — the table did not end with the other seat; dealt again afterwards |

At the moment both were seated:

```
session 81af6ec9-…  mode public_table
  seat 0  p0aafd8dd8882  stack 2000  buy_in 2000  active  connected
  seat 1  p9d8bf779cb38  stack 2050  buy_in 2000  active  connected
wallets: 23 000 and 23 000
```

and the ledger closed per row, not by a sum over a window:

```
e2e-guest  initial_grant 25000 · table_buy_in -2000 · table_cash_out +2020
                                · table_buy_in -2000 · table_cash_out +2000
                                · table_buy_in -2000 · table_cash_out +1980
e2e-lobby  initial_grant 25000 · table_buy_in -2000 · table_cash_out +2055
                                · table_buy_in -2000 · table_cash_out +2115
```

strictly alternating, never two of either in a row. Both sessions ended
`completed` with `escrow_chips = 0` and no live seat. The extra pair on the guest
is the strengthened step 4 buying back in and leaving again.

**Step 4 was strengthened, because its old last assertion could not fail.** It
ended by deep-linking to Public Table and asserting the tier chooser was visible,
under a comment claiming it had asked the SERVER whether the seat was released.
It had not: the matchmaking store starts `idle` and that screen does not poll
until a tier is **tapped**, so the chooser is what a cold mount shows whatever the
server thinks — the same shape as `home-practice` being asserted to prove a
sign-in that a guest also reaches. It now taps the tier, waits for the seat, takes
it, and asserts the table — which is precisely what V-02 refused — and then leaves
again so step 5's premise is restored.

---

## Q · Continuous integration

The workflow was read rather than assumed, and it does what it claims: install,
lint, `tsc`, `deno check` per function, the unit suite **excluding**
`tests/server/**`, the coverage gates, expo-doctor and the iOS bundle in one job;
`supabase start`, every migration from empty, pgTAP, and the server suite under
`ARC21_REQUIRE_SERVER_STACK=1` in the other — which turns a skip into a failure,
and `stack-guard.ts` was read to confirm it.

Phase 11's "ten runs, six red, every red a real defect" is accurate as far as it
goes; there are eleven, and the eleventh (the commit that recorded the table) is
green on both jobs. Each red run's cause is traceable to the commit that follows
it: F-07 and F-08 (run 1), the drifted packages and a cold-worker timeout (run
2), F-09 (run 3), the shared-public-table assertions (runs 6 and 8), and a field
read off a refusal body (run 9).

**One honest limitation.** This pass does not push, so the three fixes above have
**not** run on the remote runner. What they have run against locally is the same
set of gates, in the same order, listed in §W — including a database reset from
empty, so the new migration is applied by the same path CI would apply it by.

---

## R · Test integrity

Two weak tests were found and fixed, and both were phase 11's own.

**1 · A step that could not fail.** `two-client-public-leave.yaml`'s final
assertion, above.

**2 · A tap that races the screen it was guarded on.** `practice-hand.yaml`
failed tonight on the Release build at load 5.6 with
`Element not found: Id matching regex: home-practice` — and the failure
screenshot shows the **Practice table already open**. The block is a
`repeat: times: 3` around `runFlow when: visible home-practice → tapOn
home-practice`; the tap that lands navigates away, and the next iteration's
`when` was evaluated against a hierarchy captured mid-transition, so the tap ran
at a control that had gone. Phase 11 fixed exactly this in the two-client flows —
*"an element that was visible when the branch was evaluated can be gone by the
time the tap lands"* — and did not carry it across to the three practice flows
and `career-node` it rewrote in the same commit. `CLAUDE.md`'s own rule: when two
files do the same job and one of them gets fixed, the other is now the bug.

The taps are `optional: true` now. Nothing is weakened by that: what each block
proves is the assertion that follows it — the betting prompt, the chip rail, a
hand played to settlement — and a tap was never the evidence.

Beyond those: `stackUp` was read and does hard-fail under
`ARC21_REQUIRE_SERVER_STACK=1`; the anti-fake sweep (§U) found no dev bypass, no
`|| true` on a gate, no skipped security test; and `call-function.ts` still
refuses to retry a parseable rejection, so a deterministic 5xx cannot hide.

---

## S · Accessibility, on the rendered Release build

Asserted against the running app rather than a snapshot:

```
Assert that "Add 100 chips" is visible                                COMPLETED
Assert that "Dealer hidden card" is visible                           COMPLETED
Assert that ".* of (Spades|Hearts|Diamonds|Clubs)" is visible         COMPLETED
Assert that id: action-stand is visible                               COMPLETED
Assert that id: action-hit is visible                                 COMPLETED
```

so the dealer's face-down card announces itself as hidden and never as a card,
every dealt card carries rank **and suit by name** (suit is never colour-only),
and the chip rail says what it does. `npm run contrast:check`: **50 pairings, 0
failing**, plus the four hairline borders that are deliberately under 3:1 and
whose Increased-contrast substitutes both pass. Dynamic Type and reduced motion
are covered by `tests/design/*` in the unit suite, including
`font-scale-stacking.test.ts` from F-05.

The first attempt at this probe failed and is worth recording: both taps reported
COMPLETED against a **degraded hierarchy** — sixteen nodes, identifier-bearing
only — and left BET on 0. That is `CLAUDE.md`'s documented driver signature, and
the fix was to tap inside a `repeat` guarded on the betting prompt and assert the
result.

---

## T · Performance and stability

| measure | result |
|---|---|
| engine hot path | **781 µs per hand**, 196 µs per command over 5,000 hands — inside the recorded 752–808 range |
| memory | +11 KB Node heap over 50 hands with `--expose-gc` (phase 11: +10 KB) |
| snapshot size at a busy public table | **constant** after V-01: 1,551 B at 12 turnovers, against 6,442 B and rising before |
| cold start, Release build | launch → Home rendered: **4.6 s, 6.8 s, 5.3 s** over three runs |
| long session | `career-node` played its full twenty-hand loop to a graded result; `two-client-public-survives` played on after the other seat left |

The cold-start numbers are stated with their caveat: this is a simulator on a
host carrying a full Supabase stack, Docker and a load average around 5–10, the
interval includes restoring the stored session, and Maestro's own hierarchy
polling is inside it. The specification's `<2.5 s` is a target for
"representative midrange test hardware", which this is not, and no earlier
measurement exists to call this a regression. It is recorded so the next pass has
a number to compare with.

V-01 is the one measure here that was a real defect: an unbounded snapshot is
unbounded render work, unbounded broadcast and an unbounded row rewritten under
lock on every command.

---

## U · Anti-fake sweep

272 TypeScript files under `src`, `app`, `shared` and `supabase/functions`,
scanned with an array rather than an unquoted parameter — and with a positive
control printed first (1,693 lines matching `^export`), because
`CLAUDE.md` records a sweep that reported nine clean directories before it had
scanned a single file.

`TODO`, `FIXME`, `HACK`, `XXX`, `Coming Soon`, `not implemented`: **none**. The
`fake`/`mock` hits are the gateway union members (`"supabase" | "unconfigured" |
"fake"`) and the push transport that records `mocked` rather than `sent` when no
credentials exist — both deliberate and documented. The only `|| true` on a gate
is the priming pass in `bundle-check.sh`, whose failure is expected and whose
**second** pass is unguarded and is the exit status.

---

## V · W · Final validation

Everything below was run tonight, on this commit plus the fixes in this pass,
after `supabase db reset` applied all **57** migrations from empty.

```
npx tsc --noEmit                    exit 0
npm run lint                        0 errors, 37 warnings (unchanged baseline)
npm run check:functions             all 3 Edge Functions typecheck
npm run test:unit                 123 files / 2,399 tests PASS   (phase 11: 122 / 2,395)
npm run test:server                23 files /   302 tests PASS   (phase 11:  23 /   300)
supabase db reset                  57 migrations from empty, exit 0
supabase test db                   28 files /   576 assertions PASS (phase 11: 27 / 567)
npm run test:coverage              per-area gates pass, exit 0
npm run contrast:check             50 pairings, 0 failing (+2 Increased-contrast substitutes)
npm run benchmark                  781 µs/hand at load 4.9; heap +11 KB over 50 hands
npx expo-doctor@latest             21/21 checks passed
npm run bundle:check               exit 0 (two passes, the second gating)
```

Maestro, **Release build**, two simulators (iPhone 17 Pro and 17 Pro Max, iOS
26.5) — **31 runs, no Arc21 crash report written by any of them**:

```
mc-sign-in ×3 · two-client-public-{queue,join,seat,leave,survives} ×2 rounds
practice-hand · practice-analysis · practice-resume · career-node
online-table · every-screen-online
hostile deep links · accessibility labels · local tampering · cold start ×5
```

Four runs failed on the way and each was diagnosed rather than retried: one real
harness defect (§R, fixed), one wrong selector in my own deep-link probe, one
degraded driver hierarchy, and one wrong assertion in my own tamper probe.

---

## X · Pushed, and verified on the remote runner

The reverification above was committed locally as **`fc5568e`** and left there,
because that pass did not push. This section closes that gap and the one below
it.

**Pushed.** `git push origin HEAD:phase11-adversarial-qa` — a normal
fast-forward from `98c6301`, no force, no rebase, no amend. The remote branch
now contains `fc5568e`, and PR **#1** (`phase11-adversarial-qa` →
`phase14-s2-security`) carries it.

**CI on the exact pushed HEAD.** Not an older green run:

```
run   33848267009        event pull_request        sha fc5568e598b5ae45f7d2928e89e64757c857e192
  pgTAP and server integration            success   07:20:27 -> 07:28:23
  Lint, typecheck, unit tests, bundle     success   07:20:26 -> 07:37:10
```

Both jobs green first time — no retry, and no post-push fix was required. Every
number the runner produced matches what this machine measured:

| step | runner | this machine |
|---|---|---|
| migrations applied from scratch | 57, ending `20260907120000_leaving_clears_the_reservation.sql` | 57 |
| pgTAP | `Files=28, Tests=576 … Result: PASS` | 28 / 576 |
| server integration | 23 files / **302** tests | 23 / 302 |
| lint | 0 errors, 37 warnings | same |
| unit | 123 files / **2,399** tests | same |
| coverage gates | 121 files / 2,373 tests, pass | pass |
| expo-doctor | 21/21 | 21/21 |
| bundle | `iOS Bundled … (2,655 modules)`, exported | exit 0 |

That is the first time this project's new migration, its two new server
regressions and its new pgTAP file have been applied and run by a runner from a
clean checkout.

**And the documentation commit that records all this is green too.** The
workflow's `concurrency` block cancels an in-progress run when the ref moves, so
each documentation push is left to finish rather than superseded:

```
run   33849934174        sha 8467389 (documentation only)
  pgTAP and server integration            success   07:42:16 -> 07:51:02
  Lint, typecheck, unit tests, bundle     success   07:42:16 -> 08:07:05
```

Worth one line because of this project's own history: two of phase 11's six red
runs were commits that changed only markdown, and both were real — a shared
public table treated as the test's own. Those fixes are still holding.

**CODE HEAD VERIFIED BY CI at the time this section was written: `fc5568e`.**
That sentence did not survive the next push. The documentation commit after it
failed the database job on a real product race — §Z below — so the code head this
report finally stands on is `aeb8a76`, and `fc5568e` is the state before its fix.

---

## Y · The registry-backed dependency audit

The reverification recorded that `npm audit` could not reach the registry and
validated the advisory from the installed tree instead. That is now closed —
partly.

**What is still unavailable, precisely.** `registry.npmjs.org` itself is
reachable from this machine (`GET /decode-uri-component` → **HTTP 200 in
0.17 s**), but the endpoint `npm audit` posts to is not:

```
POST https://registry.npmjs.org/-/npm/v1/security/advisories/bulk  ->  HTTP 000 after 30.0 s
npm warn audit request to …/advisories/bulk failed, reason: socket hang up
npm error audit endpoint returned an error
```

Reproduced, not transient. GitHub's Dependabot alerts are the other configured
route and they are **disabled for this repository** (`403 Dependabot alerts are
disabled`). So `npm audit`'s own output remains unobtainable, and this report
does not pretend otherwise.

**What IS available, and was used.** The GitHub **Global Advisory Database** —
the same corpus of GHSA records `npm audit` reports against — is reachable, and
its `affects=<name>@<version>` filter answers about the **exact installed
version** rather than about a range. Every one of the **926** distinct
`name@version` pairs in the committed `package-lock.json` was submitted, in
batches, with no errors.

**Six advisories affect an exact version in the lockfile** (the API's `severity`
field says `medium` where GitHub's own interface says "Moderate"; they are the
same level, and the literal API value is what was read):

| GHSA | severity | package | installed | first patched |
|---|---|---|---|---|
| `GHSA-w3rx-r6r6-pgpr` | **high** | `image-size` (ICNS parser infinite loop) | 1.2.1 | **none — unfixed upstream** |
| `GHSA-5p2g-fcmc-qvqq` | **high** | `image-size` (JXL/HEIF parser infinite loops) | 1.2.1 | **none — unfixed upstream** |
| `GHSA-6gmq-8vp8-gcm6` | moderate | `@xmldom/xmldom` | 0.8.14 and 0.9.11 | 0.8.15 / 0.9.12 |
| `GHSA-vcc3-ghjq-m6fr` | moderate | `decode-uri-component` | 0.2.2 | 0.5.0 |
| `GHSA-w5hq-g745-h8pq` | moderate | `uuid` | 7.0.3 | 11.1.1 |
| `GHSA-qmq6-f8pr-cx5x` | low | `uuid` (duplicate of the above) | 7.0.3 | 14.0.0 |

**The dependency paths, walked rather than guessed:**

```
image-size@1.2.1      <- metro@0.84.4 <- @react-native/community-cli-plugin <- react-native
@xmldom/xmldom@0.8.14 <- @expo/plist  <- @expo/config-plugins <- expo-splash-screen
@xmldom/xmldom@0.9.11 <- plist <- simple-plist <- xcode <- @expo/config-plugins <- …
uuid@7.0.3            <- xcode@3.0.1  <- @expo/config-plugins <- expo-splash-screen
decode-uri-component  <- query-string@7.1.3 <- expo-router@57.0.18
```

(`expo-router` is `57.0.19` after §Z's realignment; the sweep was re-run on the
realigned lockfile and returns these same six advisories byte for byte.)

Every one of the first four is **toolchain**: `metro` is the bundler and
`@expo/config-plugins` runs at `expo prebuild`, writing `Info.plist` and
`AndroidManifest.xml`. None of them is in the app.

**Proved, not asserted.** Metro was asked to emit a source map for the shipped
bundle, and its `sources` array is the list of every module it actually
included — 2,641 of them:

```
image-size            -> 0 modules in the shipped bundle
@xmldom/xmldom        -> 0
xmldom                -> 0
uuid                  -> 0
metro                 -> 0
@expo/config-plugins  -> 0
xcode                 -> 0

decode-uri-component  -> 1   /node_modules/decode-uri-component/index.js
query-string          -> 1   /node_modules/query-string/index.js
```

The last two are the **positive control**: a sweep that found nothing at all
would prove nothing about the method. It finds the one package that genuinely
ships — and that one is the package phase 11 already showed to be bundled and
dead, because the live resolver parses an inbound query with `URLSearchParams`
and never calls `queryString.parse`.

**So, per finding:**

* **`image-size` ×2 (high).** Not in the shipped bundle. Reached only by Metro,
  at build time, reading the image assets in this repository's own tree — which
  are generated by `scripts/generate-app-art.ts` and byte-compared by a test, so
  a hostile image would have to be committed here first. **No remediation
  exists**: the advisory covers `<= 2.0.2`, `first_patched` is null, and 2.0.2
  is the latest published version — so this is unfixed upstream rather than
  declined here. `metro@0.84.4` requires `^1.0.2`, and `metro` is pinned by
  `react-native@0.86.3`, the version Expo SDK 57 expects and expo-doctor checks.
* **`@xmldom/xmldom` (moderate).** Not in the shipped bundle. Parses this
  project's own plist and manifest during prebuild. Fixed versions exist but the
  package is a transitive dependency of `@expo/config-plugins@57.0.9`, which the
  SDK pins; forcing it is exactly the upgrade this closure was told not to run,
  and it would buy nothing that ships.
* **`uuid@7.0.3` (moderate + a duplicate low).** Not in the shipped bundle.
  Generates Xcode project identifiers. The flaw is a missing bounds check when a
  caller supplies its own `buf`; `xcode` supplies none.
* **`decode-uri-component` (moderate).** In the bundle, and dead — re-verified
  above and pinned by
  `tests/deep-links/decode-uri-component-reachability.test.ts` with its own
  positive control. Note the severity: GitHub records this as **moderate**, where
  the phase-11 report calls it "the one runtime-reachable advisory" inherited
  from phase 10's `npm audit` output. The characterisation that matters is
  reachability, and it is not reachable.

**Nothing was upgraded, and nothing needed to be.** No high or critical advisory
affects code that ships, no reachable serious vulnerability was found, and the
one advisory that touches shipped code is the one already investigated,
measured on the device, and pinned by a test.

---

## Z · The documentation commit failed CI, and it was right to

`011cbdc` changed two markdown files. Its run failed:

```
run   33852015342        sha 011cbdc (documentation only)
  Lint, typecheck, unit tests, bundle     success   08:08:46 -> 08:19:55
  pgTAP and server integration            FAILURE   08:08:45 -> 08:21:06

  FAIL tests/server/game-command.integration.test.ts > public tables
       > returns the stack when the player leaves
  Error: six matched public rooms and none could be sat at: 409
    {"status":"rejected","code":"SESSION_CLOSED","message":"This table has closed. …"}
  Test Files  1 failed | 22 passed (23)
       Tests  1 failed | 301 passed (302)
```

It was **not retried**. §X above had just written "POST-PUSH FIXES REQUIRED:
none" and "anything after `fc5568e` is a DOCUMENTATION-ONLY HEAD", and this is
the third time in this project's life that a markdown-only commit has failed the
database job for a real reason. The helper it failed in asks for a matched public
room six times and gives up; six refusals in a row is not a shared-table
coincidence, it is the same room being handed back.

**Reproduced deterministically**, with two transactions against the running
stack and the real functions — no test double, no injected sleep:

```
T1  begin; select release_room_seat(R, <the last joined member>);   -- not committed
T2  join_matchmaking('casual'); poll_matchmaking();                 -- matched -> R
T1  commit;                                                         -- R is now closed

room status                = closed
joined members             = 1
newcomer membership        = joined
newcomer queue entry       = matched -> R
```

**The root cause.** `poll_matchmaking` serialises allocation on
`pg_advisory_xact_lock(hashtext('matchmaking:' || tier))` and took **no lock on
the room it handed out**. `release_room_seat` takes the room row `for update` and
closes the room when it counts no `joined` member. Neither excluded the other, so
under READ COMMITTED the poller read a room the leaver had already emptied,
inserted a membership into it, and committed — and the leaver then closed it.

The player is now a live `joined` member of a **closed** room, with a `matched`
queue entry naming it. `joinPublicTable` checks the room's status before it looks
at who is asking — correctly, because a closed room must take no more buy-ins —
so every buy-in is answered `409 SESSION_CLOSED`, and `join_matchmaking` hands
the same entry back each time, for the two minutes `expire_stale_queue_entries`
takes to retire the reservation. On CI that is exactly six refusals and a
give-up; on a device it is a player told "Seat found" and then "This table has
closed", over and over, with no control that changes the answer.

Note what makes it reachable at all: **a public room keeps taking players while
it is running** (F-10's fix, and 20260901120000's), so one player leaving as
another is being seated is now an ordinary evening rather than an impossibility.
Same family as the `JOIN_PUBLIC_TABLE`/`CASH_OUT` lock inversion CLAUDE.md
already records — a lock order is a property of every path, not of the two that
happened to collide.

**Two changes, answering different questions.**

* **Root cause** — `poll_matchmaking` re-asks its candidate question while
  holding that room's own row lock (`perform 1 from public.rooms where id =
  v_candidate for update`, then the same predicate again). A room a concurrent
  leave is closing is no longer a candidate; the poller falls through to opening
  one or to `waiting`. The room lock is taken **after** the tier advisory lock
  and nothing takes them the other way round.
* **Recovery** — `join_matchmaking` will not hand back a `matched` entry whose
  room is no longer joinable. This is 20260907120000's predicate ("the
  membership is gone") widened with "or the room is closed", so a player
  stranded by this race — or by some path nobody has written yet — re-enrols
  instead of retrying a refusal until housekeeping.

Both bodies were taken from the **last** migration to define each function
(20260901120000 for `poll_matchmaking`, 20260907120000 for `join_matchmaking`),
per the `create or replace` rule, and the migration ends with
`select public.assert_client_authorization_surface();`.

**Regression** — `supabase/tests/28_a_room_must_not_close_under_a_newcomer.test.sql`,
six assertions. The root cause is pinned on the function **source**, as
`19_rate_limits.test.sql` pins a window: the race needs two concurrent
transactions and pgTAP runs in one session, so the behavioural proof is the
interleaving above rather than something this file can express. The recovery half
IS behavioural and is asserted in both directions — a matched entry at a closed
room is spent and re-enrols `waiting`; one at an open room is still a reconnect
and is handed back unchanged. **Proved to fail without the fix**: with both
function bodies reverted in the running database, `Failed 3/6 subtests …
Result: FAIL`; restored, `All tests successful`.

**Re-validated locally on a database rebuilt from empty**, because a migration
that only ever runs against a database that already had the old bodies proves
nothing about a clean checkout:

```
supabase db reset            58 migrations from empty, ending
                             20260908120000_a_room_must_not_close_under_a_newcomer.sql
supabase test db             Files=29, Tests=582 … Result: PASS
npx tsc --noEmit             exit 0
npm run check:functions      all Edge Functions typecheck
npm run test:server          Test Files 23 passed (23) · Tests 302 passed (302)
```

The last line is the one that matters: the test CI failed on passes, and it
passes in the file that has been failing it, not in isolation.

### And then the toolchain moved underneath it

The SQL-only commit was pushed and its **database job went green** — the job
that had been red. The other job then failed, at `npx expo-doctor@latest`:

```
run   33863844020        sha aeb8a76 (the SQL fix)
  pgTAP and server integration            success   10:34:04 -> 10:41:04
  Lint, typecheck, unit tests, bundle     FAILURE   10:34:04 -> 10:53:19

  20/21 checks passed. 1 checks failed.
  ✖ Check that packages match versions required by installed Expo SDK
    package             expected  found
    expo                ~57.0.20  57.0.19
    expo-notifications  ~57.0.17  57.0.16
    expo-router         ~57.0.19  57.0.18
```

That commit changed two `.sql` files and nothing else, so the cause is not in it.
The three patches were published upstream **while this closure was running**:

```
expo@57.0.20                2026-09-04T07:46:21Z
expo-notifications@57.0.17  2026-09-04T07:47:33Z
expo-router@57.0.19         2026-09-04T08:05:15Z
```

and run 33852015342 started at **08:08** and still reported 21/21, so the check's
expected-version data refreshed between the two runs. `expo-doctor@latest`
resolves both the tool and the SDK's expected versions at run time; a green
commit can therefore go red with no repository change, which is exactly what
happened here. This is not an infrastructure fault — the runner did its job — and
it is not a defect in the fix above. It is dependency drift, caught in the two
hours it takes to be caught.

**Aligned rather than suppressed.** `npx expo install --fix` — the same remedy
`bb66f80` used for thirteen packages earlier in this phase, and the reason it is
not a "force upgrade": it installs the versions the SDK itself expects, every one
of them patch-level inside SDK 57 and inside the `~` ranges `package.json`
already declared. Seven lockfile entries move (the three above plus `@expo/cli`,
`@expo/ui`, `expo-modules-core`, `expo-modules-jsi`). The alternative the tool
offers — adding the three to `expo.install.exclude` — would have made the check
green by making it blind, permanently.

**Re-verified on the aligned tree, including the two things a dependency change
could invalidate in this very report:**

```
npx expo-doctor@latest    21/21
npx tsc --noEmit          exit 0
npm run lint              0 errors, 37 warnings (baseline unchanged)
npm run test:unit         123 files / 2,399 tests PASS
npm run bundle:check      exit 0
tests/deep-links          6/6 — decode-uri-component still unreachable from the
                          live resolver on expo-router 57.0.19, the case
                          bb66f80 wrote down for exactly this event
advisory sweep (§Y)       926 lockfile pairs re-asked: the SAME six advisories,
                          byte for byte
source map (§Y)           2,641 modules again; image-size, @xmldom/xmldom, uuid,
                          metro, @expo/config-plugins, xcode -> 0 each;
                          decode-uri-component and query-string -> 1 each
```

**What this does cost, stated plainly.** The 31 Release-build Maestro runs in §V
were taken on the previous patch trio. The delta is three patch releases inside
SDK 57 — one of them `expo-notifications`, which is the module §D's crash
analysis is about. Nothing was re-run on device for this, because a patch bump is
not a reason to spend the sweep again; it is a reason to say which build the
sweep was of. Phase 12 rebuilds natively in any case.

### The head this phase stands on

```
run   33865868043        sha ac9ae0a
  pgTAP and server integration            success   11:00:16 -> 11:10:17
  Lint, typecheck, unit tests, bundle     success   11:00:16 -> 11:24:57
```

Every number read out of that run's own log, not from this machine:

| step | runner |
|---|---|
| migrations applied from scratch | **58**, ending `20260908120000_a_room_must_not_close_under_a_newcomer.sql` |
| pgTAP | `Files=29, Tests=582 … Result: PASS` |
| server integration | 23 files / **302** tests, including the one that was red |
| lint | `37 problems (0 errors, 37 warnings)` |
| unit | 123 files / **2,399** tests |
| coverage gates | 121 files / 2,373 tests, pass |
| expo-doctor | **21/21** |
| bundle | `iOS Bundled … (2,655 modules)` |

**CODE HEAD VERIFIED BY CI: `ac9ae0a`.** The four runs from `fc5568e` to here are
the whole story of this closure, and two of the four were red for reasons worth
having found.


---

## Defects found in this pass

| id | defect | fix | regression |
|---|---|---|---|
| V-01 | a public table's engine seat list grew without bound; departed players were drawn on every remaining screen | `isVacatedSeat` + slot reuse in `joinPublicTable` | `tests/engine/vacated-seat.test.ts`, `public-table.integration.test.ts` |
| V-02 | leaving left a `matched` reservation that refused the next search for two minutes | `release_room_seat` cancels it; `join_matchmaking` will not return one whose membership has gone | `27_leaving_clears_the_reservation.test.sql`, `public-table.integration.test.ts`, `two-client-public-leave.yaml` |
| V-03 | a returning player was seated on their departed row, with no buy-in taken | only a live seat is reused; the buy-in key is derived from the seat | `public-table.integration.test.ts` |
| V-04 | a room could be CLOSED under a player being seated into it, so their every buy-in was answered `SESSION_CLOSED` until housekeeping | `poll_matchmaking` confirms its candidate under that room's row lock; `join_matchmaking` spends an entry whose room has closed | `28_a_room_must_not_close_under_a_newcomer.test.sql` (fails 3/6 without it) |
| — | `two-client-public-leave.yaml` asserted something that could not fail | takes the seat after leaving | the flow itself |
| — | four flows tapped non-optionally inside a conditional `repeat` | `optional: true`, as the two-client flows already had | the flows themselves |
| — | `expo-doctor` went from 21/21 to 20/21 with no repository change: three SDK-57 patches were published upstream mid-closure | `npx expo install --fix`, patch-level and inside the ranges already declared | the check itself, plus the advisory sweep and source map re-measured and unchanged |
| — | `docs/SECURITY.md` claimed `search_players('%_%')` returns 25 rows, and listed no `player_search` limit | corrected and re-measured; the scope of the limit written down | — |

---

## Verdict

**PHASE 11 REVERIFICATION: PASS**, with its two recorded evidence gaps closed —
and two post-push fixes, both of which the closure found rather than assumed
away.

Phase 11's own findings stand. **Four** product defects on the path its best fix
opened up were found, reproduced, fixed and re-proved, and two of its tests were
strengthened where they could not have failed. The fourth is the one the remote
runner found on a commit that changed nothing but markdown, and it is why this
section no longer says what it said an hour ago. No known release-blocking crash,
race, replay, authorization or resource defect remains that this machine can
reach.

```
CODE HEAD VERIFIED BY CI        ac9ae0a3139967e7e08787a634d14b90cefff3b0
REMOTE BRANCH                   origin/phase11-adversarial-qa  (PR #1)
REMOTE CI RUN                   33865868043 — both jobs success
POST-PUSH FIXES REQUIRED        two, and both were found by CI rather than by
                                asserting the previous run still applied
  1 · V-04                      a room could close under a player being seated
                                into it, so their every buy-in was answered
                                SESSION_CLOSED until housekeeping. Found by run
                                33852015342 on a DOCUMENTATION-ONLY commit,
                                reproduced with two transactions rather than
                                retried, fixed in `aeb8a76`, pinned by a pgTAP
                                file that fails 3 of its 6 assertions without it
  2 · SDK patch drift           three SDK-57 patches were published upstream
                                mid-closure (07:46, 07:47, 08:05 UTC), so
                                `expo-doctor@latest` went 21/21 -> 20/21 with no
                                repository change. Aligned with
                                `npx expo install --fix` in `ac9ae0a`; the
                                advisory sweep and the bundle source map were
                                re-measured afterwards and are unchanged
REGISTRY-BACKED DEPENDENCY AUDIT
  npm advisories/bulk endpoint  UNAVAILABLE (HTTP 000 after 30 s, reproducible)
  GitHub Dependabot alerts      UNAVAILABLE (disabled for this repository)
  GitHub Global Advisory DB     RAN — 926 lockfile versions, 6 advisories,
                                0 reachable in the shipped bundle; re-run after
                                the realignment and identical
KNOWN PHASE-11 RELEASE-BLOCKING SOFTWARE DEFECTS   0
```

Any commit after `ac9ae0a` on this branch is **documentation only**; the code
that CI verified is `ac9ae0a`.
