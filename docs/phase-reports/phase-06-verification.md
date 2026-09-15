# Phase 6 — independent verification pass

Commit verified: **`f0b4947` — "phase 6: complete private multiplayer"**
Date: 2026-08-31 · Branch: `phase14-s2-security` · Working tree clean at start

This is a re-check of an already-completed phase, not a rebuild. Its question
was narrow: **is every Phase 6 requirement genuinely implemented and genuinely
reachable, and is the one recorded transient a product defect?**

The answer is that the seventeen defects `phase-06.md` records are fixed and
their regressions really do fail without their fixes — verified by reverting
them — and that **five further problems remained**: two product defects, one of
them the exact shape this project keeps rediscovering, and three tests that
assert one outcome where the engine legitimately has several. The last of those
three is the incident `phase-06.md` recorded as "unreproduced, not diagnosed";
it reproduces on demand and is now explained.

---

## The specification was on this machine after all

`phase-06.md` opens with a caveat:

> The Arc 21 PDF is not present in this working tree or anywhere on this
> machine. `docs/ROUTES.md`, `docs/AUDIT.md`, `CLAUDE.md`, `docs/LAUNCH_STATE.md`
> and the phase brief were used as the specification of record.

It is at `~/Desktop/Arc 21 — Deep Research, Product Specification, and Claude
Code Master Build Prompt.pdf`, and its text has been extracted into this
repository since August as `.spec-extracted.txt` and `.spec-partB.txt` (225 KB,
both gitignored). This pass read the Social, Private Table, Realtime, Reconnect,
Room Lifecycle, Private Table Economy, Private Lobby/Join screen, Security and
phase-brief sections from it directly.

**That is where the first defect came from.** One line of the private-table
section had no counterpart anywhere in the app, and no document in the
repository restates it:

> If a private player reaches zero session chips, permit a free reset to 5,000
> between hands; private mode is unranked.

---

## V1 — the free reset was implemented and unreachable

`RESET_PRIVATE_STACK` was, in every respect but one, finished:

| where | what was there |
|---|---|
| `shared/contracts/session-command.ts` | `resetPrivateStackRequestSchema`, in the request union, with a `private_stack_reset` response shape |
| `supabase/functions/create-session/index.ts` | a handler with three correct guards — private table only, between hands only, only when actually broke |
| `supabase/functions/_shared/structured-log.ts` | its own log status |
| `tests/server/rejection-contract.integration.test.ts` | a case asserting its refusal for a missing game |

And **nothing in `src/`, `app/` or `scripts/` had ever sent it.** It was the
only one of the nine session actions with no client caller; a mechanical sweep
of all nine and of all twelve game-command types found no other.

### What that cost, and why nothing looked broken

A seat that cannot cover the 20-chip minimum is sat out by `openBetting`.
`getLegalActions` returns `NO_ACTIONS` for a seat that is sitting out — no bet,
no action, not even `canStartNextHand`. So every branch of the table screen's
control chain is false and it falls through to its last one:

```
Waiting for the next hand.
```

Correct-looking copy, rendered for ever, at the one mode whose entire point is
playing with people you know. The remedy was on the other side of the wire the
whole time. No error, no disabled button, no empty state — this is the
"built-but-never-connected" pattern with the quietest presentation it has had
in this project.

### The fix, and the second half found while making it

Four pieces on the client:

- `TableGateway.resetPrivateStack(gameId)` — at `create-session`, the same
  boundary as the cash-out, because that function owns what a seat is worth.
  Retried on silence only, like every other one-shot; the request names the game
  and nothing else.
- `useOnlineTableStore.resetStack()` — sends, adopts the returned snapshot,
  clears the staged bet and the repeat (both were made against chips that are
  gone), maps a closed seat to the leave path, and is single-flight.
- `src/features/table/broke-affordance.ts` — `mayResetPrivateStack`, pure and
  testable, because *"test the CONTROL, not only the function behind it"*.
- The control itself on `app/table/[gameId].tsx`, ahead of the betting bar in
  the chain, so the one thing a stuck player can do is the one thing on screen.

**And the server's own half was incomplete in a way that only shows on a
device.** `resetPrivateStack` set the stack and stopped. `openBetting` clears
`sittingOut` at the START of a hand, so a reset taken during the betting window
left the player holding 5,000 chips and still sat out of the hand they were
looking at — `getLegalActions` still answering `NO_ACTIONS`, the screen still
saying "waiting". A successful reset would have looked exactly like a failed
one. It now reinstates the seat in the same write, guarded by the phase check
that was already there.

### Proof

- `tests/table/broke-affordance.test.ts` — six cases including the one that
  matters: with the offer removed, a seat with no legal action left has nothing
  true of it at all. **Fails when the predicate is reverted to the pre-fix
  behaviour** (3 of 6).
- `tests/table/online-table-store.test.ts` — six more: it asks the right
  boundary and never `game-command`; it adopts the server's snapshot rather
  than predicting a stack; it clears the staged bet; it keeps the player at the
  table on a refusal; it leaves on `SESSION_CLOSED`; it is single-flight.
- `tests/server/private-rooms.integration.test.ts` — five against the running
  stack, over HTTP, as the real player. The stack is arranged in the database
  (playing 5,000 away 500 at a time against a fair dealer is an unbounded random
  walk, and the subject is what happens ONCE a seat is broke); everything either
  side of the fixture is the real path. **The reinstatement assertion fails when
  `sittingOut: false` is removed from the Edge Function** — verified by removing
  it, restarting `functions serve`, and watching `expected true to be false`.
- `tests/contracts/every-command-has-a-caller.test.ts` — **the gate that would
  have caught this.** It reads the action names out of the contract file rather
  than listing them (a list would stop covering the contract the moment somebody
  added to it), scans `src`, `app` and `scripts`, and fails for any action with
  no caller. `SERVER_ONLY` exists and is empty, which is a stronger statement
  than the test passing. Proved to fail on a breach by renaming the literal in
  the gateway.

---

## V2 — the one notification written to bring a player back led nowhere

`/table/[gameId]` needs a game id **and** a seat id, and every in-app route
supplies both — a `router.replace` from the lobby, `resumeTargetFor`'s resume
card, the quick/public/daily/tournament/career screens.

One route cannot. `notifications.data` may hold only a fixed set of short
scalars, by CHECK constraint, so that a seed, a shoe or a hole card cannot ride
out through a push. `notifyTurnPlayedByTimeout` therefore writes `game_id`
alone, and `destinationFor` maps `your_turn` to `/table/<gameId>`.

So the push whose whole purpose is telling an absent player they are still
seated —

> **A hand was played for you.** You are still seated at a table. Timed-out
> hands stand and decline insurance.

— opened a screen answering:

> This screen needs a table to open. Start or join one from Social.

Both sentences are true of their own half and they contradict each other. It is
live: `game-command` calls `notifyTurnPlayedByTimeout` whenever a
`RESOLVE_TIMEOUT` applies a default — which is the mechanism phase 6 itself
built (B1), so the phase made this route reachable and did not walk it.

**Fix.** `resolveTableSeat` in `src/features/table/active-session.ts` resolves
the seat from `my_active_session()` when the route did not carry one, and only
when the answer names THIS game. It returns three states rather than two, and
the third is the point: `checked` is component state on the screen for the same
reason `mayOpenDealtTable`'s is — the store behind the lookup is a module-level
cache the Play screen also fills, so a `ready` reading can arrive already
carried over from a previous screen. Until this mount's own ask has answered the
screen says "Reading the table…", because rendering the dead end before the
answer is the same defect one beat earlier. Six cases in
`tests/table/active-session.test.ts`; three fail against the pre-fix behaviour.

---

## V3 — the unexplained `reachPlayerTurns` failure, reproduced and diagnosed

`phase-06.md` records one transient it could not explain:

> The first of three `test:server` runs failed a single test:
> `economy-authority.integration.test.ts` threw inside the `reachPlayerTurns`
> helper … The message was lost to a truncated capture … It did not recur …
> Unreproduced, not diagnosed.

**It is not a transient, and it is not a product defect.** It reproduces on
demand at about one run in five.

Twenty consecutive runs of the file on a quiet host (load ≈ 5): **16 passed, 4
failed**, all four with the same error and at both of the helper's two call
sites:

```
Error: could not deal another hand:
  {"status":"rejected","code":"WRONG_PHASE","message":"That action is not available right now. (ref 60e75afd-…)"}
  ❯ reachPlayerTurns economy-authority.integration.test.ts:232
```

The cause, from the engine row of the failing game and the edge runtime's own
log line for that request id:

```
private.game_state_private → phase = INSURANCE_OFFER, dealer upcard = an ACE
edge log → commandType NEXT_HAND, code WRONG_PHASE, "engine: WRONG_PHASE"
```

`LOCK_BET` completes the betting round, so **its cascade runs the deal** and can
stop at three places, not two:

- `PLAYER_TURNS`, the ordinary one;
- `HAND_COMPLETE`, on a natural — which the helper's comment already documents;
- **`INSURANCE_OFFER`, when the dealer's upcard is an ace** — the cascade
  returns while any seat's insurance decision is `PENDING`, because that is a
  decision only a player can make.

The helper assumed the first two, so on a dealer ace it sent `NEXT_HAND` at a
table in `INSURANCE_OFFER` and the server correctly refused. One hand in
thirteen, and the file calls the helper twice: ~15% expected, 4/20 observed.

Everything about the earlier reading was consistent with this and none of it
pointed at it — the file passes alone most of the time, passes twice in a row
often, and the CPU soft-limit counts are irrelevant because the runtime was
never involved.

**Fix:** the helper declines insurance and re-reads the phase, which is what the
absent-player default is anyway and leads to the two phases it already handled.
The remaining throw now NAMES the phase it was in, so a future failure here
diagnoses itself instead of being read as a flake a second time.

**After the fix: 25 consecutive runs, 25 passed, 0 failed.**

---

## V4 and V5 — two more tests making the same kind of claim

Both surfaced in this pass's own `test:server` runs, both are test defects
rather than product defects, and both are the shape of V3: **an assertion that
names one outcome where the engine legitimately has several.**

### V4 — a betting deadline resolving into `INSURANCE_OFFER`

`game-command.integration.test.ts > ignores the poll's version-0 command and
applies the real one` asserted `PLAYER_TURNS` after `RESOLVE_TIMEOUT` closed the
betting window. Resolving a betting deadline stakes the minimum for every seat
and the cascade then **deals**, so the same three destinations apply — and the
full-suite run failed with `expected 'INSURANCE_OFFER' to be 'PLAYER_TURNS'`
while its other 198 tests passed.

The subject of that test is that the version-0 poll applies nothing and the
real-version command does. It now asserts the table MOVED, to one of the three
phases a deal can legitimately reach, plus the two `BET_*` defaults it already
checked. **15 consecutive runs of that test after the change: 15 passed.**

### V5 — "every hand carries the same wager" is false after a double

`two-client-table.integration.test.ts > splits, doubles, surrenders and takes
insurance` asserted, after a SPLIT, that **every** hand in the seat carried the
pre-split wager. That is a claim about hands the split never touched, and it is
false the moment one of them has been doubled: a seat that splits, doubles one
half and then splits the other holds `[200, 100, 100]`. The run failed with
`expected 200 to be 100` — which reads as a wager defect and is not one.

The rule the specification states is about the PAIR: a split makes a second hand
carrying an equal wager, funded from the stack. The assertion now identifies the
two hands of *this* split (the one being split, plus the id that was not there
before) and checks both wagers **and the stack debit** — so it now proves the
"rather than conjured" half of its own comment, which nothing did before.

---

## What was re-verified and found correct

### B14 / B15 — proved by reverting each fix

| revert | result |
|---|---|
| `mayResetPrivateStack`… no — `mayOpenDealtTable` → `return input.dealt !== null` | `tests/rooms/lobby-affordance.test.ts > waits for the server's answer before acting on a pointer` **FAILS** |
| `restore()` → restore `if (get().status.kind === "seated") return;` | `rooms-store.test.ts > forgets a dealt table when there is no open room to restore` and `> re-checks a room already in hand, because a seated reading is a mount old` **both FAIL** |

Neither test steps around the production path: the B14 regression deliberately
leaves the status as `seated` — the state the table screen leaves behind — and
says so in a comment, having been rewritten in phase 6 precisely because its
earlier version reset it by hand.

`dealt` is read for navigation in exactly one place (`app/table/lobby.tsx`), and
the gate is applied there; a full-repository grep found no second path.
`checked` is component state. `refresh()` additionally requires `dealt` to name
the table the room is actually running, which closes the no-mount route
(leave a table, join a new room by code).

### Client ↔ server wiring, swept mechanically

- **All 9 session actions** mapped to callers. One was missing (V1); the other
  eight are wired.
- **All 12 game-command types** mapped. Eleven are wired; `LEAVE` is
  deliberately unsent — the app leaves through `CASH_OUT`, which settles the
  escrow in the same transaction, and `game-command`'s own `LEAVE` path calls
  the same `settleTableClosure`.
- **All 25 social/room SQL functions** mapped to `.rpc(` call sites. Every one
  has a caller except `release_room_seat` and `expire_stale_rooms`, which are
  server-only by design (`revoke execute … from public, anon, authenticated`).
- Every lobby control — create, join, share, ready, remove, invite, start,
  leave — resolves to a function. Share is the only client-only one.

### Realtime

The three policies on `realtime.messages` are applied in the running database
(`arc21_game_topic_is_for_its_seated_players`, SELECT;
`arc21_presence_roster_needs_an_account`, SELECT;
`arc21_only_presence_may_be_written_by_a_client`, INSERT), `anon` has none in
either direction, and both ends declare `private: true`. The read policy builds
the expected topic FROM the seat rather than parsing the topic, so it is total
over every possible topic string. Sequence handling implements the
specification's three rules literally, including the deliberate softening on a
gap (adopt the state, play no events, fetch a snapshot anyway).

### Anti-fake sweep

84 files across `src/features/{rooms,friends,presence,table,notifications}`,
`app/{table,room,friends}`, `app/(tabs)/social.tsx`, `src/lib/notifications`
and `supabase/functions/{create-session,game-command,_shared,send-notifications}`.
Scanned with an array, with the file count printed first — `CLAUDE.md` records a
sweep that reported clean across nine directories without reading a file.

Every match is either prose (a comment describing a past defect), a
`TextInput` placeholder, `kind: "fake"` on a test gateway, or the push
transport's documented `mock` mode, which the specification explicitly asks for
when APNs/FCM credentials are unavailable. No fake players, no local-only
multiplayer, no swallowed errors, no debug bypass. "Not in this build — Arc 21
has no text chat by design" is the specification's own instruction
("Do not create free-form text chat in MVP").

### Deviations from the specification, checked and left alone

- **Seat reservation is not a 90-second window.** The spec asks for one; Arc 21
  holds a seat indefinitely and releases it only on an explicit leave, a
  closure, or `expire_stale_rooms()`. That is a superset of the player-facing
  guarantee the spec is protecting ("if the app was killed, the online server
  session still exists"), and the architecture has no way to observe a socket
  dropping — there is no long-lived game process, which is the same fact that
  makes `RESOLVE_TIMEOUT` client-driven. The table does not freeze, because
  timeout defaults keep it moving. `seat_status`' `disconnected` label is
  consequently never set. Recorded, not "fixed": a reclaim timer would be new
  infrastructure and is phase 7+ work.
- **The join screen does not distinguish its refusals.** The spec's JOIN TABLE
  screen lists six error distinctions; `join_private_room` answers unknown,
  expired, full, blocked, removed and already-playing with one identical
  refusal. That is deliberate anti-enumeration, documented in
  `14_rooms.test.sql`, and it is what makes the 10-per-minute `room_join` limit
  meaningful. Malformed codes are still distinguished locally and cost no
  request, which is the spec's other requirement for this screen.

---

## Measured

```
npx tsc --noEmit                    exit 0
npm run lint                        0 errors, 37 warnings (unchanged from f0b4947)
npm run check:functions             all 3 Edge Functions typecheck
npm run test:unit                 115 files / 2,280 tests PASS   (f0b4947: 113 / 2,239)
npm run test:server                18 files /   199 tests PASS   (f0b4947:  18 /   194)
                                   live stack, freshly restarted `functions serve`
supabase test db                   25 files /   494 tests PASS   on a freshly reset database
supabase db reset                  48 migrations applied from empty, exit 0
npm run contrast:check             46 pairings, 0 failing (+2 Increased-contrast substitutes)
```

The +5 server tests and +41 unit tests are this pass's own; every other count is
unchanged from `f0b4947`.

### The three nondeterministic tests, before and after

| test | before | after |
|---|---|---|
| `economy-authority` (whole file, `reachPlayerTurns`) | **16 pass / 4 fail in 20** | **25 pass / 0 fail in 25** |
| `game-command > ignores the poll's version-0 command` | failed in a full suite run | **15 pass / 0 fail in 15** |
| `two-client-table > splits, doubles, surrenders…` | failed in a full suite run | **8 pass / 0 fail in 8** |
| `career/session-repeat-bet` (found in the final unit run) | failed once | **30 pass / 0 fail in 30** |

The two-client file was confirmed to be RUNNING rather than skipping — 3 tests,
31 s — because "a skipped test is not a passing test" and its own guard is the
kind that hides a dead stack.

### Two iOS simulators, two accounts, one local backend

iPhone 17 Pro (`e2e-lobby@arc21.test`, host) and iPhone 17 Pro Max
(`e2e-guest@arc21.test`, guest), on a database reset from empty for this run,
against a Metro started AFTER every source edit (`lsof -ti:8081` then
`ps -o lstart=`, which is the check `phase-06.md` learned the hard way). Room
`PFD86N`, ten flows, **every one exit 0**:

| # | device | flow | what it establishes |
|---|--------|------|---------------------|
| 0a | A | `mc-sign-in` | a real session — `header-chips` shows a balance, not GUEST |
| 0b | B | `mc-sign-in` | the same for the second account |
| 1 | A | `two-client-host-open` | room created, a valid six-character code, "1 of 2 seated" |
| 2 | B | `two-client-guest-join` | the code typed on the OTHER device, "2 of 2 seated" |
| 3 | A | `two-client-host-deal` | the table deals, own stack rendered, countdown running |
| 4 | B | `two-client-guest-table` | the guest reaches the table by its own path |
| 5 | A | `two-client-leave` | **the host leaves and the lobby offers a NEW table** |
| 6 | B | `two-client-play` | a deliberate 100-chip bet placed and settled through the UI |
| 7 | B | `two-client-timeout` | the table advances unattended to a 20-chip default |
| 8 | B | `two-client-leave` | **the last player out closes the room** |

The server was asked at each checkpoint rather than the screenshots trusted:

```
before any leave        after the HOST left          after the GUEST left
  room   PFD86N active    room   PFD86N active         room   PFD86N closed
  session       active    session       active         session       completed
  joined members     2    joined members     1         joined members      0
  held seats         2    held seats         1         held seats          0
  host  seat 5,020        host  seat left, 0
  guest seat 5,000        guest seat active, 5,000
                          host_user_id → the GUEST
```

That is section J in one reading: the seat settled, the TABLE did not end for
the other player, the host role migrated to the remaining member, and when the
last seat closed the room closed and the session completed with nothing held.

And the economy, from the other direction — after a whole private-table
lifetime of more than twenty hands:

```
wallets                       e2e-lobby 25,000   e2e-guest 25,000
table_buy_in / table_cash_out ledger rows        0
ledger rows of ANY kind                          initial_grant × 2
```

Both wallets sit at exactly the opening grant, and the only ledger rows either
account has ever had are the two grants themselves. Not one chip crossed the
boundary in either direction.

**One interruption, recorded because it is not a result.** The session running
these flows was stopped between steps 5 and 6, mid-Maestro, leaving an
interrupted-coroutine stack trace in `6-two-client-play.log`. Steps 6–8 were
re-run afterwards from the state step 5 left — the room still `active`, the
guest still holding the only seat, and the table by then on hand 20, having
advanced unattended for five hours on the guest client's own `RESOLVE_TIMEOUT`
requests, which is B1's mechanism working for longer than any test would ask of
it. Load was allowed to fall from 112 to under 12 before resuming, per
`CLAUDE.md`.

---

## Verdict

PHASE 6 REVERIFICATION: PASS
