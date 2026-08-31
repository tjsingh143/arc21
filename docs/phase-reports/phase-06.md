# Phase 6 — Social, private lobby, real multiplayer, Realtime, reconnect

Date: 2026-08-31 · Branch: `phase14-s2-security` · Preceded by phase 5 (PASS)

The social and private-table systems were **built** before this phase, and much
of the server half was built well: the room code is drawn from a CSPRNG, the
friend graph is normalised and policed by RLS, `join_private_room` answers a bad
code and a full room with the same silence, the command transaction locks the
engine row and checks an idempotency key, and `toPublicState()` really is the
only thing that builds a client payload.

What this phase found is **two distinct shapes of defect**, and it is worth
separating them because they were caught by completely different means.

The first shape is the one this project keeps finding: **a mechanism that exists
on one side of a boundary and has no counterpart on the other.** `deadlineAt`
had been on every snapshot since the wire contract was written, under a comment
saying clients render countdowns against it — and no client code read it, so no
client ever asked the server to resolve a lapsed timer, and a table with an
absent player froze for everybody. `profiles.last_seen_at` was read by two RPCs
and rendered by the Social screen, and nothing had written it since signup.
`publicGameEventSchema.seq` existed, was documented as the thing clients dedupe
on, and was stripped by the gateway before the store could see it.

The second shape is new here, and it is the more serious: **a permission that
was never asked for.** `realtime.messages` has had RLS enabled since the
platform created it and carried **no policy at all** — which does not mean
"deny". It means the channels were never declared private, so Realtime never
consulted the table, and `game:<gameId>` was an open topic in both directions.
Measured, not inferred: a client holding nothing but the anon key received a
live table's whole fan-out, and a second account pushed a forged `state` onto
the topic that a seated player's client accepted.

**Seventeen defects found and fixed. Every fix has a regression proved to fail
when the fix is removed**, and every fix that crosses into the database or
Realtime is proved against the running stack rather than reasoned about.

> The Arc 21 PDF is not present in this working tree or anywhere on this
> machine. `docs/ROUTES.md`, `docs/AUDIT.md`, `CLAUDE.md`, `docs/LAUNCH_STATE.md`
> and the phase brief were used as the specification of record. Stated rather
> than left implicit, as in phase 5.

---

## A. The Realtime channel was a public address

This is the finding worth reading first, because nothing in the repository
pointed at it. There was no missing call site, no unread column, no disabled
button — the code was complete and it worked. What was absent was an
**authorization decision that had never been made**.

### A1. Any client could read any table it knew the id of

`online-table-gateway.ts` subscribed to `client.channel(\`game:${gameId}\`)` and
`realtime-broadcast.ts` published to the same topic with the service role. A
Supabase Realtime topic is **public unless the channel declares itself private**,
and neither end did.

Measured against the running stack, with a client that held the published local
anon key and no account whatsoever:

```
subscribe status: SUBSCRIBED
broadcast POST: 202
stranger received: {"events":[],"publicState":{...}}
RESULT: TOPIC IS OPEN — no seat required
```

The payload is `toPublicState()`'s output, so no hole card and no shoe left the
server — the sanitisation boundary held. What did leave was every seat's
`displayName`, `userId`, `stack` and `originalBet`, to somebody with no seat at
the table. `game_session_seats` is deliberately readable only by a participant
(`game_session_seats_select_participant`); the fan-out went around its own RLS.

### A2. Any client could push a forged table onto another player's screen

Worse, and the reason this is not merely eavesdropping. On a public topic,
clients may broadcast to each other:

```
attacker send: ok
victim received: {"publicState":{"gameId":"forged","version":999,...}}
RESULT: CLIENT-TO-CLIENT STATE INJECTION IS POSSIBLE
```

`subscribe()` parses whatever arrives with `broadcastSchema` and hands it to the
store's `applyPushedState`, which applies a payload whose `seq` is the next one
it expects. That is a client-supplied game state rendered as authoritative —
precisely what invariant 6 exists to forbid, reached by a route the invariant's
usual enforcement point (the verified JWT on a command) never sees.

### The fix

`supabase/migrations/20260831120000_realtime_channel_authorization.sql` writes
the three policies `realtime.messages` had never had, and both ends of every
channel now declare `private: true`:

- **reading a game topic requires a live seat at that game.** The policy never
  parses the topic — casting `substring(topic from 6)` to `uuid` would raise on a
  malformed one and take the subscription down with an error rather than a
  refusal. It builds the expected topic string *from the seat* and compares text
  to text, which is total over every possible topic and cannot be tricked by a
  clever one. `status <> 'left'` is deliberate: a player who has cashed out has
  settled, and a settled table is no longer theirs to watch.
- **the presence roster requires an account.** It stays one shared topic on
  purpose — everybody publishes and each client renders only its own friends —
  but an anon key used to be enough to read the whole thing.
- **a client may write to the presence topic and nowhere else.** There is no
  insert policy for a game topic anywhere, which is what closes A2. The server
  broadcasts as the service role and is unaffected by RLS.

`anon` gets no policy in either direction, so an unauthenticated socket can
subscribe to nothing.

### Proof, in both directions

`tests/server/realtime.integration.test.ts` gained three tests. The refusals:

```
[isolation proof] stranger:  CHANNEL_ERROR: Unauthorized: You do not have
                             permissions to read from this Channel topic: game:7defedae-…
                 anonymous:  CHANNEL_ERROR: Unauthorized: …
[injection proof] broadcast API answered 202 and the seated listener received []
[presence proof] a second signed-in player saw the first: true
                 an anonymous socket got: CHANNEL_ERROR: Unauthorized: …
```

Note what the injection test asserts. The broadcast endpoint **accepts** the
forged request with a 202 — refusing at the API would have been a different
design — so the assertion is about the seated player's screen, which is where the
harm would have been.

And the pre-fix path is pinned too, which matters because the exposure was never
the join. A plain, non-private subscribe is *still allowed to join* a public
topic; what it must no longer get is a message. With `private: true` removed from
the broadcast, that test fails with the whole table in the failure message:

```
AssertionError: expected [ { events: [ … ], publicState: { seats: [
  { displayName: "peb17e889c4b4", stack: 4980, originalBet: 20, userId: "eb17e889-…" }, … ] } } ]
  to deeply equal []
```

`supabase/tests/20_authorization_surface.test.sql` carries four assertions about
the *shape* of the policy set rather than its text, each proved to fail on a
deliberate breach: adding a fourth policy takes the count to 4, adding a second
write policy takes that count to 2, and widening the presence write policy to
mention `game_session_seats` flips the fourth assertion to false.

---

## B. Defects found and fixed

### B1. Nothing ever resolved an expired deadline — sections I, J, N

Arc 21 runs no long-lived game process. The specification is explicit that a
deadline is a stored `deadline_at` and that "when a deadline is visually reached,
any connected client may request `RESOLVE_TIMEOUT`". The only `RESOLVE_TIMEOUT`
this app sent was `TableGateway.snapshot()`'s, deliberately pinned to
`expectedVersion: 0` so it can never apply — a read dressed as a command.

So an absent player froze a shared table for everybody, indefinitely, with the
fifteen-second timer that exists to prevent exactly that already long expired.
Proved on the stack: sixteen seconds past a two-seat table's betting deadline the
client's own poll answered `stale` with the phase unchanged, and the same command
at the current version advanced it to `PLAYER_TURNS` in one round trip.

`src/features/table/table-deadline.ts` is the new, runtime-neutral half: the
countdown copy, the grace, and the predicate for when to ask.

### B2. The countdown told the wrong player they were about to be defaulted — section I

The first version of `describeDeadline` took only the phase. On the
two-simulator run the host's screen read **"10 seconds to act · you stand if you
do not"** while the *other* seat was the one being waited on — wrong twice, since
that player had nothing to do and standing was not what would happen to them.

Every assertion about that string passed, because each was written for the case
it described. Found by looking at a rendered screen, which is the only thing that
could have found it. `awaitingYou` now comes from the snapshot's own account of
who the clock is for.

### B3. The debounce marker deadlocked the very table it was protecting — sections I, J

`alreadyAskedForVersion` alone stops a request per render tick. It also blocks
for ever: an ask that goes unanswered leaves the version exactly where it was, so
"already asked at 28" refuses every later attempt at 28.

Not theoretical. On the two-simulator run the local edge runtime saturated (104
CPU soft-limit events), one ask was lost, and the client sat at "Reconnecting…"
on hand 8 with a lapsed clock — the frozen table this whole mechanism exists to
prevent, reached by the mechanism itself. `TIMEOUT_RETRY_MS` makes the marker
bound the RATE and never the total.

### B4. The client threw away the sequence number it was documented to use — section L

`publicGameEventSchema.seq` exists, and both the contract and
`realtime-broadcast.ts` say clients track `lastAppliedSeq` and refetch on a gap.
`readState()` and `subscribe()` stripped `seq` before the store saw it, so the
store deduped on `version` and re-applied an EQUAL version — a duplicate
broadcast produced a new `lastEvents` array identity and replayed the settled
outcome sound.

The gateway now keeps the envelope; the store implements the three rules
(ignore `≤ lastAppliedSeq`, apply `+1`, and on a gap adopt the state *and* fetch
an authoritative snapshot).

### B5. A private room never closed, so its host could never open another — sections C, M

Only `leave_room` closed a room, and only when the last member left;
`expire_stale_rooms()` expired `status = 'lobby'` alone. `CASH_OUT` at
`/table/[gameId]` never called `leave_room`. An `active` room therefore lived for
ever: the host was told "you already have a table open", the six-character code
was never released, and `restore()` put players back into a dead lobby.

`release_room_seat(room_id, user_id)` is `leave_room`'s body with the identity as
a parameter, so the Edge Function can retire a seat on the player's behalf, and
`settleTableClosure`'s `sessionEnded` is what closes the room. **A seat closing
and a table closing stay different events** — one player leaving a five-seat
table must not end it for the other four, and a test asserts exactly that.

### B6. A newcomer could join a table that had already dealt, and was stranded — sections C, O

`join_private_room` admitted `status in ('lobby','active')`. Seats are fixed when
the host deals, so a player arriving afterwards got a `room_members` row and no
`game_session_seats` row — and the lobby, which resolves its own seat from that
table, polled for one for ever with nothing on screen to explain why. Reproduced:
a third player joined a playing room, `get_room_state` listed them, and their
seat query returned `[]`.

The guard sits *below* the "already joined" branch and past a player who HOLDS a
seat in the session, so an ordinary reconnect never reaches it — a player whose
membership ended while their seat was still live gets back in by typing the same
code, which is what reconnection is.

### B7. `last_seen_at` was the signup timestamp, for ever — section A

Written once by `handle_new_user`, read by `list_friends` and
`player_public_profile`, rendered by `describeLastSeen`. The specification's
presence fallback ("persist only `last_seen_at`") was a column nothing updated.
`touch_last_seen()` is the RPC; the presence store calls it on join and on every
`setOwnState`, including when no channel is held — sitting down at a table is a
player being present, and the durable fallback should say so for the many players
who never open Social.

### B8. Every deliberate refusal in five functions was an HTTP 500 — sections A, C

`send_friend_request`, `accept_friend_request`, `invite_friend_to_room`,
`get_room_state` and `set_room_ready` raised `P0002`, and two comments in the
repository asserted that PostgREST maps it to 404. It does not — `P0002` has no
mapping, so it renders as **500**. Every one of these is a refusal a player can
provoke by ordinary use, and each told them the server had broken. `PT404` is the
mapped code, exactly as `CLAUDE.md` already records for `PT429`.

Redefining those five meant starting from the LAST migration that defined each,
not the first — the trap `CLAUDE.md` documents.

### B9. A lost cash-out reply left the player on a dead table — section J

If the reply to `CASH_OUT` never arrived, the seat was closed on the server and
the client kept polling it. The screen showed another player's cards beside a
developer message with a request reference in it: *"This table has closed. (ref
f77e1b11-…)"*. `dropIfSeatIsClosed` maps the closed-seat rejection codes to the
app's own words and leaves the table, from every path that can meet one —
`enter`, `refresh`, both `lockBet` branches, `nextHand`, `resolveTimeout` and
`sendSimpleCommand`.

### B10. Leaving a table could fail with a navigator error — section C

Photographed on the simulator: **"The action 'GO_BACK' was not handled by any
navigator"**. A table reached by a deep link or a stack reset has nothing to go
back to. `tableExitDestination(canGoBack)` picks between the two, and both leave
paths — the control and the `beforeRemove` listener — use it.

### B11. Leaving asked twice, and the second dialog trapped the app — sections C, J

Found on the last device run of the phase, and only there. The screen has two
leave paths — the back bar's control and the `beforeRemove` listener that catches
Android back and a stack-resetting deep link — and each carried its own copy of
the exit steps. **One copy left out the line that records the screen is
leaving.**

So the back bar confirmed, cashed out (the seat really did settle — the database
showed `left`), and navigated; `beforeRemove` then fired with
`alreadyLeaving: false`, cancelled that navigation, and asked a second time
whether to leave a table the player had already left, quoting the 5,020 chips the
seat no longer held. Because an `Alert` is modal, the app was then stuck behind
it: `openLink arc21://table/lobby` reported **COMPLETED** and landed underneath a
dialog nobody could see past.

The failure screenshot is the whole diagnosis — the confirmation sitting directly
over the screen's own *"You are no longer at this table. Your seat is settled and
anything it held has been returned."*

`tableExitSequence(canGoBack)` now returns the ordered steps and both callers run
it, so the mark cannot be forgotten by one of them. The four regressions in
`tests/table/leave-guard.test.ts` assert the property that failed — the mark
happens FIRST, in both branches — rather than the destination, which was never
wrong; two of them fail when the omission is restored.

This is the phase's own lesson arriving one more time: **a step present in one of
two paths is a step that is missing.**

### B12. `beforeRemove` cancelled every route away from a settled table, for ever — sections C, J

The other half of B11, and the one that actually trapped the player. Found
because fixing B11 removed the second dialog and left the screen exactly where it
was.

`beforeRemove` exists to stop an accidental exit from a table whose escrow is
still open, and it asked its question **whether or not the seat still existed**.
After a settled cash-out the store has no seat, so there was nothing to protect —
but the listener still called `event.preventDefault()` first. Every route away
from the table fires that listener, so every route away was cancelled: the screen
sat on its own "You are no longer at this table. Your seat is settled and
anything it held has been returned." with the table gone, and
`arc21://table/lobby` reported **COMPLETED** and changed nothing. Only killing the
app got the player out — verified by doing exactly that, after which the lobby
correctly offered a new table.

`mayLeaveTable` now takes `holdsSeat` and checks it first, so a screen with no
seat never cancels anything. Its regression sweeps all four combinations of the
other two inputs and fails when the term is removed.

Worth naming the shape: **a guard that protects a resource must ask whether the
resource is still there.** That is the same lesson as the account-deletion guard
in `CLAUDE.md` — which counted seats without asking what a seat's STATUS meant —
arriving from the opposite direction.

### B13. A second "Leave table" tap while the first dialog was closing froze the screen — sections C, J, O

The third and last of the leaving defects, and the one that made the other two
hard to see: it is intermittent.

`Alert.alert` is fire-and-forget, and iOS presents at most one alert. A second
raised while the first is still dismissing is **dropped** — which leaves
`confirmThenLeave`'s promise with no button left to settle it, so the call never
returns. Its caller hangs; and when that caller is `beforeRemove`, the navigation
has already been cancelled, so the screen stops accepting any route away at all.
Same wedged screen as B12, reached from the other end.

A player produces this by tapping "Leave table" twice when the first tap seems to
do nothing — which is exactly what a mid-hand `SESSION_BUSY` refusal looks like.
The E2E flow produces it once a second, which is why two consecutive runs of the
same commit gave different answers: one reached Home with the balance restored,
the next sat on the settled table.

The confirmation is now single-flight. Refusing the second ask is right on its
own terms: there is one question on screen and it is already being asked.

### B14. The lobby bounced a player back onto a table they had left — sections C, M

`findSeat` matched a seat of any status, so a `left` seat still read as a live
one and `dealt` was set again from `restore()`. Three small fixes: `.neq("status",
"left")`, clearing `dealt` on a refused read, and clearing it when `restore()`
finds no open room.

**Two of those three were unreachable, and the flow that would have said so was
read as a harness flake for two sessions.** `restore()` opened with

```ts
if (get().status.kind === "seated") return;
```

— "never over a room already in hand: the poll is more current than this". But
`restore()` runs on MOUNT, and on mount a `seated` reading is by definition one
carried over from a previous mount, because `dealt` navigating to the table is
what unmounted the lobby in the first place. There is no poll yet for it to be
older than. The single case the guard skipped is the only case that matters: a
player who left through the TABLE screen, whose store still said `seated`
because `CASH_OUT` never touches it. The lookup never ran, so the branch that
clears `dealt` could not run either.

The tell was in the test file. `"forgets a dealt table when there is no open
room to restore"` had to set the status to `idle` by hand before calling
`restore()` — stepping around the guard to reach the code it was covering. A
test that has to disarm a guard to test the code behind it is describing a guard
that should not be there.

`restore()` now asks every time, and acts on the whole answer: no open room
means no dealt table AND no seated lobby, because `rooms_select_member` admits
only rooms the caller is a `joined` member of. `refresh()` additionally requires
`dealt` to NAME the table the room is actually running, which closes a second
route to the same bounce that needs no mount at all — leave a table, join a new
room by code, and `joinRoom` calls `refresh` directly with a pointer at the old
table that was kept merely because it was non-null.

### B15. The lobby acted on the pointer before the answer came back — sections C, M

Fixing B14 was necessary and did not fix it. The flow still failed, on both
devices, with the same photograph: the table route showing "You are no longer at
this table", and `arc21://table/lobby` reporting COMPLETED while changing
nothing.

**`restore()` is asynchronous and the navigation effect is not.** Both are mount
effects, so the effect had already read the stale `dealt` and dispatched
`router.replace` by the time the lookup resolved. Clearing the value earlier
does not help either: effects in one commit run against the render that
scheduled them, so a `set` from the effect above cannot change what the one
below sees.

So the rule is about ORDER, not about the value: a pointer that has not been
checked against the server ON THIS MOUNT is not a pointer to navigate on.
`mayOpenDealtTable({ checked, dealt })` states it, and `checked` is component
state rather than store state for exactly the reason the bug exists — anything
module-level would arrive already true, carried over from the mount before.

Isolated deliberately rather than inferred. The first fix went in, both apps
were rebundled and relaunched, and the guest's leave flow was run again: it
failed identically. Only then was the race the remaining explanation, and a
fresh JS context — where `dealt` starts null — was shown to reach the create/join
screen correctly, which is what named the surviving value as the cause.

Both halves are required. Without B14's fix `checked` becomes true with `dealt`
still stale; without B15's, `dealt` is cleared a beat after the screen has
already left.

---

## C. What was checked and found already correct

Recorded because "verified" and "untouched" are different states, and section C
of the brief asks specifically for the search in both directions.

- **Room-code entropy.** 32 characters (Crockford-style, no `I`/`O`/`0`/`1`) to
  the sixth power is 2^30 codes, drawn with `extensions.gen_random_bytes` and
  re-drawn on a collision with live rooms only. With `room_join` limited to 10
  attempts a minute per account and a refusal that is identical for unknown,
  expired, full, blocked, removed and already-playing, guessing is impractical
  and learns nothing on the way.
- **The limit is consumed BEFORE the code is looked at**, so a refusal cannot
  differ by target — and `join_private_room` RETURNS rather than raises, so the
  attempt commits and counts. A raise would roll the limit back and hand a
  code-guesser an unlimited budget.
- **Every server function has a client caller, and every client control has a
  server implementation.** All 34 social/room functions were listed from the
  migrations and matched against every `.rpc(` call site in `src`, `app` and
  `scripts`. The unmatched ones are trigger functions, RLS predicates, internal
  helpers (`generate_room_code`, `expire_stale_rooms`) and the two server-only
  ones (`notify_user`, `release_room_seat`). In the other direction, every
  control on the lobby — create, join, share, ready, remove, invite, start,
  leave — resolves to a function, and Share is the only client-only one.
- **Host migration is social control only.** `release_room_seat` hands the host
  role to the longest-connected remaining member and touches nothing about the
  session: not the shoe, not the dealer, not a seat. The integration test
  "hands the room over, keeps the game running, and is free to open another"
  asserts the game continues across the transfer.
- **Private-table economy is closed.** `WALLET_BACKED_MODES` names `solo` and
  `public_table` only, and `settleTableClosure` reads the mode from the session
  row rather than trusting a caller.

---

## D. Multi-client proof

Two genuinely independent clients, twice over, because they prove different
things.

**Two iOS simulators** — iPhone 17 Pro and iPhone 17 Pro Max, two accounts
(`e2e-lobby@arc21.test`, `e2e-guest@arc21.test`), one local backend. The host
created a room; the guest typed the six-character code; both lobbies showed
"2 of 2 seated" with two distinct `auth.users` rows behind them; the host dealt;
**both devices reached the table independently** (the guest's path exists because
of a phase-14 fix, and this is the first time it was walked by a second device);
both rendered the countdown; the table advanced unattended from hand 1 to **hand
25**, which is the client-driven `RESOLVE_TIMEOUT` working over and over; both
placed deliberate 100-chip bets; and after both left, the room was `closed`, the
session `completed`, and zero seats remained.

**The whole lifecycle was then re-run end to end on the build that carries the
B14/B15 fixes**, because until those landed the last flow of the sequence had
never passed. Room `QW9RGX`, eight flows, every one exit 0:

| # | device | flow | what it establishes |
|---|--------|------|---------------------|
| 1 | A | `two-client-host-open` | room created, six-character code on screen |
| 2 | B | `two-client-guest-join` | the code typed on the OTHER device, "2 of 2 seated" |
| 3 | A | `two-client-host-deal` | the table deals, stack 5,000, countdown running |
| 4 | B | `two-client-guest-table` | the guest reaches the table by its own path |
| 5 | A | `two-client-leave` | **the host leaves and the lobby offers a NEW table** |
| 6 | B | `two-client-play` | a deliberate 100-chip bet placed and settled through the UI |
| 7 | B | `two-client-timeout` | the table advances unattended to a 20-chip default |
| 8 | B | `two-client-leave` | **the last player out closes the room** |

The server was asked after step 5 and again after step 8, rather than the
screenshots being trusted:

```
after the HOST left            after the GUEST left
  room   QW9RGX  active          room   QW9RGX  closed
  session        active          session        completed
  e2e-lobby seat left,  0        held seats     0
  e2e-guest seat active, 5040    joined members 0
  host_user_id → e2e-guest
  e2e-lobby membership left
```

Which is the whole of section M in one reading: the seat settled and its escrow
returned; the TABLE did not end for the other player; the host role migrated to
the remaining member; the departed player's membership ended; and when the last
seat closed, the room closed and the session completed with nothing left held.
Step 6 is the other direction of the same fix — a player who genuinely still
holds a seat is still carried to their table by the lobby, so B15's gate refuses
a stale pointer without refusing a live one.

**Two SDK clients in `tests/server/two-client-table.integration.test.ts`**, each
holding a genuine GoTrue session from `signInWithPassword` and driving the app's
own `createSupabaseTableGateway`. These cover what a screenshot cannot assert:
one shoe and one dealer across both seats, independent wagers, sequential
card-consuming actions in seat order, split/double/surrender/insurance settled
correctly, a sequenced broadcast arriving at the other client's gateway, and a
reconnect that replaces state from an authoritative snapshot.

Neither proof uses a local array of fake players.

---

## E. Measured

```
npx tsc --noEmit                    exit 0
npm run lint                        0 errors (37 warnings, unchanged from phase 5)
npm run check:functions             all 3 Edge Functions typecheck
npm run test:unit                 113 files / 2,239 tests PASS  (phase 5: 112 / 2,183)
npm run test:server                18 files /   194 tests PASS  (phase 5:  17 /   175)
supabase test db                   25 files /   494 tests PASS  (phase 5:  25 /   483)
npm run contrast:check             46 pairings, 0 failing
npm run test:coverage              per-area gates pass
supabase db reset                  48 migrations applied from empty, exit 0
```

**One transient, recorded because it was not diagnosed.** The first of three
`test:server` runs failed a single test: `economy-authority.integration.test.ts`
threw inside the `reachPlayerTurns` helper — line 700 is the helper call itself,
and its only reachable throw at that point is a `NEXT_HAND` that did not answer
200. The message was lost to a truncated capture, which is the lesson: capture
the whole failure, not its tail. It did not recur — the file passed alone, and
the full suite passed twice more afterwards, once on a freshly restarted edge
runtime. The runtime logged **19** CPU soft-limit events in the failing run and
**20** in the green one, so the usual explanation for a flaky server run does not
fit this one; and the file imports nothing that changed this session. Left
recorded as unreproduced rather than explained away.

---

## F. Harness lessons worth carrying forward

**A long-lived Metro can serve a stale bundle, and it says so in a line nobody
reads.** Three device runs and two wrong diagnoses went to this. The dev server
had been up fifteen hours and had stopped picking up edits; a second
`npx expo start` did not replace it, because 8081 was taken and a
non-interactive shell cannot answer "Use port 8082 instead?" — so it printed
`› Skipping dev server` and exited. The app kept loading from the original
bundler. `launchApp` and Fast Refresh both looked normal, so three fixes with
passing unit regressions appeared to do nothing on the device, and the
intermittent results (one run reaching Home, the next wedged) were the OLD code
taking different branches. Before believing device evidence about a change you
just made, check that the process on 8081 started AFTER the edit —
`lsof -ti:8081` then `ps -o lstart=`. This is the project's own "a step that
COMPLETED did not necessarily do anything" one level up: a build that looks live
and is not.

**A hand-signed JWT is not a session, and on Realtime that difference is
invisible until the second message.** Chasing what looked like "the Edge
Function's broadcast is never delivered" cost most of an afternoon. The truth was
that the probe's client, built by `createClient` with no session, runs its own
auth listener and sets the socket's token back to the anon key shortly after
start-up — *after* an explicit `realtime.setAuth()`. The private channel joins as
the user and is refused as `anon` when Realtime re-checks it to deliver, so the
symptom is `SUBSCRIBED` followed by exactly one message and then silence. Every
false lead in between (payload double-encoding, `SET LOCAL realtime.topic`,
message size, WAL decoding, replication-slot lag) was a real difference that
turned out not to matter. The thing that settled it was running the existing
integration test, which holds a real session and passed.

`accessToken` alone does not fix it either — that is what the SDK uses for
PostgREST, and it never reaches the socket. A non-session test client needs
**both** `accessToken` and `realtime.setAuth`. This is `CLAUDE.md`'s "a test
client must mirror the real client's auth options" one layer down.

**`realtime.send()` cannot fail.** Its body wraps the insert in `EXCEPTION WHEN
OTHERS THEN RAISE WARNING`, and `postgres-client.ts` sets `onnotice: () => {}` so
that a NOTICE cannot carry row values into a log. A broken call through it is
completely silent. Worth knowing before reaching for it.

**`${json}::jsonb` really does double-encode.** Written into a scratch
implementation while chasing the above, and the stored value was
`jsonb_typeof = 'string'` exactly as `CLAUDE.md` warns. `::text::jsonb` is not a
style preference.

**A failure that reproduces identically is not a flake, however much it looks
like one.** `two-client-leave` failed four times across two sessions and was
read three of those times as harness trouble — the loop's "Leave table" tap was
racing the cash-out, the driver was dropping view hierarchies, the machine was
loaded. Two of those were real and both were fixed, which is exactly what made
the fourth so easy to keep mis-reading. The tell was in the logs the whole time:
the run at 02:53 and the run at 03:10 stopped at the *same assertion* with the
same screenshot, and a run whose cause is timing does not stop in the same place
twice. Compare the failure ARTEFACTS across runs before reaching for load or
driver explanations; `CLAUDE.md` already says not to retry a flake until it can
be reproduced on purpose, and the inverse holds too.

**When a fix does not take, re-run before adding a second fix.** B14 and B15
looked like one defect and were two. Re-running the failing flow with only B14's
fix in place — after confirming both apps had rebundled — is what separated them:
the identical failure proved the value was still stale at the moment the screen
acted, which pointed at the ORDER rather than at the value. Shipping both at once
would have left it unclear which mattered, and B14 alone would have been recorded
as the fix for something it does not fix.

**A signed-out device shows the same screen as a device with no table.**
`restore()` is silent on failure by design — "a player who has no table open must
see the ordinary create/join screen, not an error about a lookup they did not
make" — and a signed-out client fails that lookup. So device B, whose GoTrue
session had lapsed overnight, rendered a perfectly ordinary lobby and read as a
product regression in the flow that expected a table. `auth.sessions` had no row
for that account, which is the cheap check; the screen cannot tell you.
