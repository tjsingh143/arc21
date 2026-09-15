# Phase 7 — Public matchmaking, public tables, escrow, join/leave, online integrity

Date: 2026-09-01 · Branch: `phase14-s2-security` · Preceded by phase 6 (PASS, reverified)

Public multiplayer was **built**, typechecked, unit-tested and covered by a
server suite — and **two people could not sit at the same table**. That is the
finding this phase turns on, and it was not visible from any of those places.

The specification's text was read from `.spec-extracted.txt` and
`.spec-partB.txt`, which are in this working tree (gitignored). Phase 6's report
states the PDF "is not present … anywhere on this machine"; it is, and reading
it is how the tier gate and the twenty-second offer below got their exact terms.

**Eight defects found and fixed. Every fix has a regression proved to fail when
the fix is removed**, by reverting it against the running stack and watching the
named test go red — not by reasoning about it.

---

## A. A public table stopped taking players the moment the first one bought in

Measured with two real accounts before a line of the fix was written:

```
A join_matchmaking  200
A poll              matched, room 4285219d-…   (lobby)
A JOIN_PUBLIC_TABLE 200  buyIn 2000             (room -> active)
B join_matchmaking  200
B poll              matched, room e67e20e4-…   <- a different table
```

`poll_matchmaking` considered only rooms at `status = 'lobby'`, and the buy-in
sets a room to `active`. So the ordinary sequence — queue, tap "Take the seat",
somebody else queues ten seconds later — allocated a brand new table every time.

The consequence is larger than a matchmaking miss. The specification's mid-shoe
join — a seat reserved at a running table and dealt in at the next
`BETTING_OPEN` — is code no allocation could reach, and `joinPublicTable`'s
whole "append a seat to a live engine state" branch was unreachable in
production. **A "public table" was a solo table with a queue in front of it.**

Nothing in the build noticed, and the reason is the shape this repository keeps
finding: `tests/server` reached `JOIN_PUBLIC_TABLE` by handing it a room id, so
the handler was well covered and *the path to it* was never exercised. Every
test in `tests/server/public-table.integration.test.ts` therefore goes **through
the queue**.

The candidate predicate now accepts `lobby` and `active`, and excludes a room
whose session has completed or been abandoned. Proved by reverting: with
`'lobby'` alone, `seats two players who chose the same stakes at ONE table`
fails.

## B. Nobody ever waited, so three specified controls were unreachable

`poll_matchmaking` created a room on a lone player's very first poll and
answered `matched`. `waiting` therefore existed for a few milliseconds at most,
and the Keep Waiting / Play Solo / Cancel offer the specification puts after
about twenty seconds **could not be reached by anybody**.

A room is now opened only when there is somebody to share it with: one other
live enrolment at the tier is enough, and that player's next poll finds the
table. The advisory lock per tier is what makes it safe — two simultaneous
pollers cannot both decide they are the one who opens it.

The client half was missing too, and is now real: `keepWaiting()` snoozes the
offer for another window and re-enrols, `Play solo instead` cancels the search
and opens the server's one-player table at the same stakes, and the card states
how many others are queueing **because the server counted them** — it used to
claim "nobody else is queueing" without having asked, which is wrong in exactly
the case where waiting a few more seconds is worth doing.

`tests/e2e/public-matchmaking.yaml` renders that offer on a device. It is the
first time it has ever been on a screen.

## C. A public room's code admitted anyone who typed it

`join_private_room` did not check `visibility`. Public room codes are shown to
matched players, so a code shared out of band seated a stranger at a public
table through the private path, bypassing the queue, the tier and the
one-live-seat guard. It returns `null` for a public room now.

## D. The accidental host of a public room could kick matched strangers

`remove_room_member` is the host's control over a lobby they created. Whoever
arrives first at a tier becomes the host of the room `poll_matchmaking` opens —
by accident, not by choice — and could then remove players matchmaking had
seated. Refused for public rooms.

Both C and D were proved by restoring the previous function bodies into the
running database and re-running `14_rooms.test.sql`: four assertions fail.

## E. A lock-order inversion between CASH_OUT and JOIN_PUBLIC_TABLE

Reachable only once A was fixed, because it needs a player leaving while another
sits down at a **running** table:

```
JOIN_PUBLIC_TABLE   locks `rooms` (`for update` on the id it was given),
                    then the engine state, then the wallet
CASH_OUT            locked the engine state, then the wallet, and reached
                    `rooms` only at the end, inside `release_room_seat`
```

Postgres picks a victim and aborts it, so nothing is corrupted and no chips
move — the player who lost the toss is answered **HTTP 500 "Something went
wrong"** for an ordinary leave. The fix is an ORDER, not a retry:
`lockRoomForSession` takes the room row first on every path that will touch
both. Modes with no room (solo, career, tournament, daily) match no row and take
no lock.

Every path was then checked rather than assumed. The only code that touches a
room row is `startPrivateTable`, `joinPublicTable`, `cashOut`, `game-command`'s
`handle` (for `LEAVE`, the only command that ends at a room — `sessionEnded` is
set only inside `if (closing)`, and `closing` requires `LEAVE`), and
`closeCompetition`, which runs only for tournament, daily and career sessions
that have no room at all. `tests/contracts/room-lock-order.test.ts` pins that as
an allowlist, so a sixth one fails a test rather than a race — and it is proved
to fail when the order is inverted.

## F. An emptied room left behind by an earlier run seated a lone player

Found by running the public suite twice. The first run abandoned a room; the
second run's lone player was matched into it, which is the same outcome as
defect B by a different cause — a room nobody is in is a leftover, not a table.
Two halves: the candidate predicate requires `seats.taken > 0`, and
`retire_empty_lobby_room` closes a lobby room whose last member leaves, wired
into both `leave_matchmaking` and `expire_stale_queue_entries`. Proved by
reverting both and building the leftover through the public API.

## G. A refused mid-hand leave was a promise the app did not keep

The server is right to refuse: a committed wager must resolve before the stack
can go anywhere, and `SESSION_BUSY` says so. The screen said *"This hand is
still live. Your chips come back as soon as it settles"* — and nothing made that
happen. The player had to still be watching, remember, and tap the control again
at the right moment. **Somebody who taps leave and puts the phone down stays
seated at a live public table, is stood in by the action timer hand after hand,
and their buy-in sits in escrow.**

`SESSION_BUSY` is the one refusal that is a "not yet" rather than a "no", so the
intent is now held (`leavingWhenSafe`) and completed at the first safe boundary,
driven by the poll that is already running. Staking chips cancels it, because
that is what changing your mind looks like.

The phase test is the engine's own. `canCloseSeat` **moved** into
`shared/blackjack/table-closure.ts` so `engine-bridge.ts`'s `canCloseSession`
and the client's held leave are one implementation — a second copy of the phase
list would be a second answer to one question, and the client's is the one that
would drift, asking three seconds at a time for something about to be refused.

## H. Two smaller ones, found while proving the above

- **A capacity control beside the money.** `joinPublicTable` trusted allocation
  for occupancy. `TABLE_FULL` (409) is now checked against
  `game_session_seats` inside the same transaction as the buy-in, and a room
  that is no longer `lobby` or `active` is refused as `SESSION_CLOSED` — a
  stale room id charges nothing.
- **An unfunded reservation held a seat indefinitely.** A player matched into a
  room who never bought in kept the seat. `expire_stale_queue_entries` now
  releases a `matched` reservation older than two minutes whose owner holds no
  live seat, and retires any room thereby emptied.

---

## Two test defects that were hiding real ones

Recorded separately because neither is a product bug and both mattered more than
some that are.

**`call-function.ts` retried the function's own rejection envelope.** It replays
a 5xx byte-identically, which is correct and well argued for the retired-worker
case it was written for. But `{"status":"rejected","code":"INTERNAL", …}` is our
handler answering: the reply was not lost, the command failed. The deadlock in E
produced that envelope on **three runs out of three** and the race test passed
all three, because by the time the body was replayed the other transaction had
committed. The rule now matches the app — `online-table-gateway.ts` reads a
parseable rejection, INTERNAL included, as `refused` and retries only an answer
it could not read. A retired worker never reaches our handler, so the
intermittent the retry exists for is untouched. With that fixed, reverting E
fails the race test on the first attempt.

**`SPLIT` can settle the hand.** `CLAUDE.md` records that `LOCK_BET` can, and
that the cascade after betting closes stops in three places. This is a fourth:
Arc Standard deals one card to each half of a split pair of aces and stands
both, so a seat that splits aces while it is the last one with a hand to play
runs the dealer and settles inside its own `SPLIT`. `two-client-table` asserted
`stack === stackBefore - wager` and read `expected 10200 to be 9800` once in a
`test:server` run whose other 221 tests passed — which looks exactly like a
wager defect. Reproduced deliberately over a seeded shoe rather than retried
(`AS 10C AD 6H 9S 8S 10D`: dealer 16 draws to 26, both split hands win) and
pinned in `tests/engine/split-settlement.test.ts`. The server assertion now
covers the accounting — the debit plus whatever the hand returned — which is
correct in both cases and stronger than what it replaced.

---

## What the tests actually exercise

`tests/server/public-table.integration.test.ts` is 22 tests against the live
stack, every one through calls a shipped client can make: the two matchmaking
RPCs, `create-session` and `game-command`, with a real JWT per account. Nothing
is inserted by the service role — `rooms`, `room_members`, `game_sessions` and
`game_session_seats` carry no write grant to it — so a fixture that could not be
produced by playing is not available.

| Brief | Covered by |
|---|---|
| A. Public queues, tiers | the high table refused below level 10 with a code a client branches on; the screen disables it and says why |
| B. Matchmaking | lone player waits; two at the same stakes share ONE table; `others_waiting` counted by the server; Keep Waiting / Play Solo / Cancel on a device |
| C. Seat allocation | a table fills before another opens; a sixth player is refused `TABLE_FULL` |
| D. Buy-in escrow | one debit, one ledger row, chips in the table stack; a retry with a FRESH request id buys no second seat |
| E. Conflicting session | solo live, private live, already at this table, already at another public table, stale room id — each refused before any chips move, `PT409` rather than a 500 |
| F. Joining mid-hand | a third account joins a table in PLAYER_TURNS, is dealt nothing, keeps its full stack, and bets in the next window |
| G. Leaving mid-hand | mid-hand cash-out refused, the committed wager resolves, payment at the boundary; the client holds the intent |
| H. Safe cash-out | credited exactly once however many times it is asked for |
| I. Public gameplay | one shoe (keyed on the physical card id), the hole card hidden, turns in seat order, tier bet band enforced by the server |
| J. Reconnect | the table found from the JWT alone, deadline restored from the server, the match did not pause, a safe leave still works |
| K. Concurrency | two commands racing one version; the same account on TWO DEVICES; a duplicated command replayed exactly once; a leave racing a join |
| L. Multi-client | three accounts match, play three hands, one leaves, the remaining two stay coherent and cash out; wallets, ledger rows and table stacks all reconciled exactly |

Chip arithmetic is asserted against authoritative values only — wallet balances
read back through PostgREST, `wallet_ledger` rows counted by reason, and seat
stacks from the server's own snapshot. There is no tolerance anywhere in the
file.

**Isolation is relational, not absolute.** Allocation is global by design — the
point of a queue is that strangers share a table — so every assertion is about
this file's own accounts, wallets and seats, never about how many rooms the
database happens to hold. The lone-player test states the rule the server
implements (a table is opened only when there is somebody to share it with)
rather than an absolute `expect("waiting")`, which failed on two runs in three
because CI runs two server files at once and another suite's enrolled player is
a real waiter. It is falsifiable in both directions and proved so.

---

## Green, 2026-09-01, on a database reset from empty

```
npx tsc --noEmit                    exit 0
npm run lint                        0 errors, 37 warnings (unchanged)
npm run check:functions             all 3 Edge Functions typecheck
npm run test:unit                 116 files / 2,299 tests PASS  (phase 6: 115 / 2,280)
npm run test:server                19 files /   223 tests PASS  (phase 6:  18 /   199)
supabase test db                   25 files /   513 tests PASS  (phase 6:  25 /   494)
npm run contrast:check             46 pairings, 0 failing (+2 Increased-contrast substitutes)
npm run test:coverage              per-area gates pass, exit 0
supabase db reset                  49 migrations applied from empty, exit 0

Maestro, iPhone 17 Pro (iOS 26.5), dev build, Metro restarted with --clear
AFTER the client edits and confirmed by pid start time:
  online-table.yaml                 exit 0, 44 steps COMPLETED
  public-matchmaking.yaml           exit 0, 31 steps COMPLETED  (new)
```

The three defect classes were each re-proved by reverting the fix in the running
system and watching the named test fail:

```
poll_matchmaking without the `v_waiting = 0` guard
  -> "matched at a table of 1 with 0 others queueing"          FAIL
poll_matchmaking without `seats.taken > 0`, retire_empty_lobby_room a no-op,
with a leftover room built through the public API
  -> the same assertion                                        FAIL
cashOut without lockRoomForSession
  -> "keeps the table coherent when a leave races a join"      FAIL (500)
create-session with the engine lock taken before the room lock
  -> tests/contracts/room-lock-order.test.ts                   FAIL
```

## Not done, and deliberately

- **No two-simulator run for public tables.** Phase 6 proved the two-device
  private-table lifecycle on real simulators; §L here is proved with three
  genuinely independent authenticated clients against the live stack, which
  exercises the same server guarantees. A second simulator would test the
  private-table screen again, which phase 6 already did.
- **Phase 8 is not begun.**
