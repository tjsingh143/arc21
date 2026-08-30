# Phase 4 — Authoritative wallet, ledger, Quick Play, server game commands, Career reward authority

Date: 2026-08-30 · Branch: `phase14-s2-security` · Preceded by phase 3 (PASS)

The economy was **built** before this phase, and most of it is not merely correct
but correct for stated reasons: chips move only through `apply_wallet_delta`,
which takes the wallet lock *before* consulting its idempotency key; the ledger
is append-only against every role including `postgres`; escrow keys are derived
from the game and the player rather than from a client request id; and
`session-economics.ts` exists because getting the wallet-backed/closed-economy
distinction wrong once minted 5,000 chips per private table.

What this phase found is that the **way back to a table you are already sitting
at did not exist**. Every server-authoritative mode refuses a second buy-in while
a seat is held — the right control, standing next to the money — and the game id
that would let the player release that seat reached the client exactly once, in
the reply to the buy-in, and lived afterwards only in a route parameter. Lose it
and the account was locked out of Quick Play, Public Tables and Career for ever,
with the buy-in stranded, while all three refusals advised the player to "leave
that table first".

Reproduced against the running stack before a line of the fix existed. Every fix
has a regression **proved to fail when the fix is removed** — the first in two
directions.

---

## A. Defects found and fixed

### A1. A player who lost their game id was locked out of every server mode, permanently

The reproduction, in full, against the live stack:

```
A. opening balance      : [{"balance":25000}]
B. OPEN                 : 200 {"gameId":"b3bcfb9b-…","seatId":"41745c30-…","buyIn":2000,"wallet":23000}
   (the app is killed here; both ids existed only as expo-router parameters)
C. OPEN again           : 409 {"code":"SESSION_ALREADY_ACTIVE"}
D. balance now          : [{"balance":23000}]   ← 2,000 in escrow
E. rpc my_active_session: 404 PGRST202 — no such function
```

`assertNoOtherLiveSeat` is right to refuse: one wallet must not fund two tables,
and the buy-in idempotency key is derived from the game, so two games are two
keys and both would be honoured. But **nothing anywhere asked the server which
table the player was at.** `grep -rn "my_active_game\|activeGameId\|active_session"`
over `src`, `app` and `supabase` returned nothing, and
`online-table-store.enter(gameId, seatId)` is only ever called with route
parameters.

Three client stores produce that refusal and all three answered with some form of
"leave that table first":

| store | message before |
|---|---|
| `quick-play-store.ts` | "…Leave that table first — nothing has been charged for this one." |
| `matchmaking-store.ts` | "…Leave that table first — nothing has been charged for this one." |
| `career-server-store.ts` | "You are already seated at a table. Leave it first…" |

Nothing marks a session `abandoned`, so the seat never expires on its own. The
sharper measurement is what happens when the player was mid-hand:

```
PLACE_BET        200 accepted phase=BETTING_OPEN
LOCK_BET         200 accepted phase=PLAYER_TURNS
LEAVE            200 accepted phase=PLAYER_TURNS   ← the wager stands, correctly
seat row         : active stack=2000
session row      : active escrow=2000
RESOLVE_TIMEOUT  422 rejected                      ← a solo table carries no clocks
OPEN again       409 SESSION_ALREADY_ACTIVE
```

A solo table has no deadlines *on purpose* — one player stalls nobody, and
auto-standing would silently change their recorded accuracy — so
`RESOLVE_TIMEOUT` is refused with `DEADLINE_NOT_REACHED` and there is no clock,
no reaper and no client path that can ever move that hand. The table is playable
and cashable; it simply could not be **addressed**.

This is the eleventh-and-a-half instance of the built-but-never-connected
pattern, and the data was readable the whole time — `game_session_seats` is
already selectable by its owner. What was missing was somebody asking.

**The fix.** `20260830120000_active_session_lookup.sql` adds
`public.my_active_session()`: `SECURITY DEFINER`, argument-free, identity from
`auth.uid()`, returning at most one row — game id, seat id, mode, tier, start
time. No stack, no wager, no card, nothing from `private`.

Two things about it are load-bearing:

* **It is a function, not a query the client writes.** A read through RLS is
  scoped to what the POLICY permits, not to "your own rows":
  `game_session_seats_select_participant` correctly shows a player the *other*
  seats at their table, so a hand-written query needs `user_id=eq.<me>` — the
  exact footgun `CLAUDE.md` records twice.
* **Its predicate is `assertNoOtherLiveSeat`'s, written out:** `s.status <>
  'left'` and `g.status in ('lobby','active')`. `active` and `disconnected` are
  seats still HELD; `left` is one already settled. A lookup that disagreed with
  the control would either offer a table the server does not count, or stay
  silent for one it does.

Client side: `src/features/table/active-session.ts` (pure, RN-free — parsing, the
wording, and the `canResume` predicate) and `active-session-store.ts` (the
gateway and cache). A **"Return to your table"** card now appears at the top of
the Play tab and on Quick Play; the two other refusals were reworded to say where
to find it. The card is an inert `SurfaceCard` containing a `Button`, because a
labelled `Pressable` replaces the text of everything inside it in the iOS
accessibility tree — which has cost this project three surfaces already.

### A2. A career node's XP was awarded outside its own claim marker

`settleCareerReward` has two branches. The zero-chip one guards the XP grant on
`stampClaim()` returning true; the paying one called `stampClaim` and **discarded
the answer**, then awarded XP unconditionally. The chips were safe either
way — the ledger's unique idempotency key credits once — but XP has no such key,
so two callers that both found the ledger empty would each call
`award_milestone_xp`.

Not reachable today: the drill path holds `for update` on the attempt row and the
boundary path holds the engine-state lock, so the two finalisation paths
serialise. But that is an argument about locks in other files, and the marker is
already here and already returns whether it won. XP now follows the claim in both
branches, and the response reports `rewardChips: 0` when this call did not move
them, rather than a figure it did not credit.

### A3. `SurfaceCard` silently discarded `testID` on its inert branch

Found while wiring the resume card. `SurfaceCard` renders a plain `View` when it
is given no `onPress` — and that branch forwarded `style`, `disabled` and
`children`, but not `testID`. So `app/table/[gameId].tsx` had carried

```jsx
<SurfaceCard testID="table-advice">
```

since the advice panel shipped: an id present in the source, absent from the
tree, and any selector for it would have failed while looking like a broken
screen. The same class as the three accessibility defects already recorded — a
perfect screenshot and nothing to select.

The inert shape is not an edge case; it is the *correct* shape for a card whose
control is a Button inside it, because a labelled `Pressable` replaces the text
of everything within it on iOS. So the shape that avoids one trap must not fall
into the other. `tests/design/surface-card-test-id.test.ts` guards both
branches, and states plainly what a source scan can and cannot prove: the prop
is forwarded; whether it reaches the rendered tree is a Maestro job.

---

## B. What was checked and found correct

Everything below was exercised against the running stack, not read.

### B1. Server authority (§A)

| Owned by the server | Where |
|---|---|
| shoe, shoe index, hole card | `private.game_state_private`; no API role holds a grant, `service_role` included |
| legal actions | `assertCommandIsLegal` re-runs `getLegalActions` on authoritative state |
| state version | bumped by the engine's own `bump()`, never sent |
| active actor | `state.activeSeatIndex`, compared against the seat looked up from the JWT |
| settlements | the shared engine, in the command transaction |
| wallet, table stack | `apply_wallet_delta`; `game_session_seats.stack` has no client UPDATE |
| competitive stats | `record_hand_settlement`, from `HAND_SETTLED` events |
| Career rewards | `settleCareerReward`, keyed to node + player |

`sanitise()` runs `toPublicState` **and** `assertNoHiddenCardLeak` in production,
so a refactor that widened the public shape fails the request rather than
publishing the shoe.

### B2. The command contract (§B)

`handle()` in `game-command/index.ts` runs the specification's sixteen steps in
order, with the engine-state lock taken **first** — before the idempotency
lookup, for the same reason `apply_wallet_delta` locks the wallet before
consulting its key: two concurrent replays under READ COMMITTED both miss the
other's uncommitted row.

A stale version applies nothing and returns the authoritative snapshot:

```
stale version           : 200 stale → version 1
wallet unchanged        : 23000
```

### B3. The wallet (§C)

```
opening balance                     25000   (the specified figure)
ledger row for it                   initial_grant  +25000  balance_after 25000
PATCH  /wallets                     403 42501
POST   /wallet_ledger               403 42501
DELETE /wallet_ledger               403 42501
rpc    apply_wallet_delta           403 permission denied for function
PATCH  /game_session_seats (stack)  403 42501
PATCH  /player_stats                403 42501
PATCH  /profiles (xp, level)        403 42501
```

Reconciliation, after a buy-in and a cash-out — three independent statements of
the same number:

```
balance             23000   sum(delta)  23000   ✓
lifetime_credited   25000   sum(+)      25000   ✓
lifetime_debited     2000   sum(−)       2000   ✓
last balance_after  23000                       ✓
```

`balance >= 0` is a CHECK constraint, and `02_wallets.test.sql` proves it holds
four layers down: missing grant, granted-but-no-policy, granted-with-a-permissive
policy, and finally under a server role.

### B4. The ledger (§D)

Append-only against **everything**. Attempting to backdate a grant as `postgres`
in order to test a cooldown:

```
ERROR:  wallet_ledger is append-only; record a correcting entry instead
CONTEXT:  PL/pgSQL function guard_ledger_append_only() line 4 at RAISE
```

A row exists for every server-authoritative movement: `initial_grant`,
`table_buy_in`, `table_cash_out`, `recovery_grant`, `career_reward`,
`tournament_entry`, `tournament_prize`, `daily_challenge_reward`.

### B5. Buy-in escrow and safe cash-out (§E, §F)

The buy-in debits once, into a server-owned stack, with the session and seat rows
and the engine state inserted **before** the debit so the wallet lock is held for
the shortest possible time. The cash-out key is `table_cash_out:<gameId>:<seatId>`
— derived from the game and the seat, never from a client request id — which is
what makes `LEAVE` and `CASH_OUT` idempotent *against each other*:

```
CASH_OUT           200 {"returned":2000,"wallet":25000}
replay (same id)   200 {"returned":2000,"wallet":25000}
replay (new id)    200 {"returned":2000,"wallet":25000}
final wallet       25000
ledger             initial_grant:25000, table_buy_in:-2000, table_cash_out:2000
```

Cashing out mid-hand is refused (`409 SESSION_BUSY`) and moves nothing: leaving
is never a way to escape a committed wager.

### B6. Quick Play (§G)

Buy-in, first hand, repeated commands, engine rules, settlement, `NEXT_HAND`,
safe leave and cash-out all run against the real function. The reconnectable
identifier is A1 above and is now covered end to end.

### B7. The Recovery Grant (§I)

Every decision is the server's; the function takes **no arguments at all**, so
there is no clock, balance or amount for a modified client to lie with.

```
at 25,000        400 "a recovery grant is only available below 2000 chips"
at 1,500         200 balance_after 5000, delta 3500, key recovery_grant:<user>:0
claim again      400 (balance is now 5,000)
at 500, in cd    400 "the next recovery grant is available at 2026-08-30 17:34:18+00"
after cooldown   200 balance_after 5000, key recovery_grant:<user>:1
grants recorded  2
```

Restores **to** 5,000 rather than adding 5,000, so it cannot be farmed by
spending down to 1,999. The ordinal in the key makes a retry of *this* claim
deterministic while still permitting a genuine future one.

Race safety, eight simultaneous claims from one account:

```
statuses     200,400,400,400,400,400,400,400
grant rows   1
balance      5000
```

The wallet lock is taken before the balance is read, so the seven losers resume
after the winner commits and re-read 5,000 — above the threshold, and refused.

### B8. Statistics (§J)

Derived in the settlement transaction from the engine's own `HAND_SETTLED`
events, for the commanding seat only. `accountForSettlement` takes counts and
chip totals and has **nowhere to express a wager**, which is how "never award
more XP for betting larger amounts" is kept by construction. The client holds no
write on `player_stats` and none on `profiles.xp` or `profiles.level`.

### B9. Unknown outcome and retry safety (§K)

The situation is not hypothetical here: the local Edge runtime retires a worker
when its isolate trips the CPU soft limit, and the "command handled … accepted"
log line lands *between* the retirement and the failed reply — the command
committed and only the reply was lost. Every economic command was replayed with
an identical body, and cash-out additionally with a **fresh** request id:

| replayed | result |
|---|---|
| `OPEN` (same id) | same game, same seat, one `table_buy_in` row |
| `CASH_OUT` (same id) | same figure, one `table_cash_out` row |
| `CASH_OUT` (fresh id) | same figure, one `table_cash_out` row |
| `LEAVE` then `CASH_OUT` | reports the return, credits once |
| `PLACE_BET` (same id) | the first committed result, no second card |
| another account's `clientActionId` | `403 NOT_A_PARTICIPANT` |

One detail worth writing down: the replayed payload is **not byte-identical**.
It is served from `private.game_commands`, where the first result was stored as
`jsonb`, and jsonb sorts keys by length then bytewise. Same value, different
bytes.

### B10. Failure and rollback (§L)

| intentional failure | left behind |
|---|---|
| buy-in refused (`TABLE_LOCKED`) | no session, no seat, no ledger row, no live seat |
| buy-in overdraws | refused by the `balance >= 0` CHECK — `02_wallets.test.sql` |
| cash-out mid-hand (`SESSION_BUSY`) | balance unchanged, seat still `active`, no ledger row |
| recovery grant refused | wallet identical, no `recovery_grant` row |
| drill graded twice (`SESSION_CLOSED`) | one payment |
| drill answer sheet too short | balance unchanged, attempt **still in progress** |
| drill attempt not the caller's | `403`, no `career_reward` row |

The last two matter beyond the money: a mistyped submission that closed the
attempt would burn a run, leaving the player told to finish something they can no
longer submit.

### B11. The modified client (§M)

All eight attacks the phase names were run against the live stack and every one
failed safely — the table in B3 plus:

```
PLACE_BET 500000 (above the stack)  422 BET_ABOVE_MAXIMUM
PLACE_BET -100                      400 INVALID_REQUEST
PLACE_BET 12.5                      400 INVALID_REQUEST
PLACE_BET 9e15                      400 INVALID_REQUEST
another user's command              403 NOT_A_PARTICIPANT
stale version                       200 stale, nothing applied
replay the buy-in with a fresh id   409 SESSION_ALREADY_ACTIVE
```

`tests/wallet/no-write-path.test.ts` already scanned the *source* for a client
write. That proves what this app says; the table above proves what the server
does, and a source scan cannot see a request made by hand.

---

## C. Both fixes proved load-bearing

Neither regression was assumed to work. Each was run with its fix removed.

**A1, with the function dropped entirely:**

```
× names the very table the second buy-in was refused for
× goes quiet again the moment the seat is settled
× finds a seat left mid-hand, which is the state that stranded chips
× tells one player nothing about another's table
× is closed to an unauthenticated caller
AssertionError: expected { code: 'PGRST202', … } to deeply equal []
```

**A1, with the predicate narrowed to the tempting `s.status = 'active'`:**

```
# Failed test 5: "a disconnected seat is still held, so its table is still offered"
# Failed test 6: "and a closed-economy mode is reported like any other"
24_active_session.test.sql (Wstat: 0 Tests: 14 Failed: 2)
Result: FAIL
```

**A3, with the `testID` forward removed from the inert branch:**

```
× forwards testID to the View it renders
  Tests  1 failed | 3 passed (4)
```

---

## D. Four test defects found while writing the tests

Every one of these would have been an intermittent, which is the failure mode
this repository has spent the most time on.

1. **`expect(phase).toBe("PLAYER_TURNS")` after `LOCK_BET`** — a natural, the
   player's or the dealer's, settles the hand inside `LOCK_BET`'s own cascade and
   lands on `HAND_COMPLETE`. The assertion would have passed roughly fifteen
   times in sixteen. `reachPlayerTurns()` deals again instead of retrying the
   assertion: the dealer is fair, so another hand is the honest answer.
2. **The same, for the mid-hand cash-out refusal** — `SESSION_BUSY` only applies
   when a wager is actually committed.
3. **`expect(replay.raw).toBe(first.raw)`** — see B9. The right assertion is
   value equality.
4. **A drill node looked up through `my_career_progress`** — that RPC returns
   `node_code`, and `format` lives only in the TypeScript catalogue. The
   wrong-length assertion already exists in `career.integration.test.ts`, which
   pays for the two-node walk it needs; the rollback assertions were added
   **there**, where the fixture is, rather than duplicated.

---

## E. Commands run, with results

```
npx tsc --noEmit                    exit 0
npm run lint                        0 errors (37 warnings, unchanged)
npm run check:functions             all 3 Edge Functions typecheck
supabase db reset                   exit 0 · 45 migrations + seed, from empty
supabase db lint                    no schema errors
supabase test db                    25 files /   483 tests PASS   (phase 3: 24 / 469)
npm run test:unit                  105 files / 2,052 tests PASS   (phase 3: 103 / 2,017)
npm run test:server                 16 files /   167 tests PASS   (phase 3: 15 / 130)
                                    live stack, after a clean db reset
```

Not re-run: the Maestro flows, `test:coverage`, `strategy:generate`,
`contrast:check`, `benchmark` and `expo export`. This phase changed no colour
token, no engine hot path and no strategy input. It DID add two screens' worth of
UI — the resume card on Play and on Quick Play — which is exercised by unit tests
of its enablement predicate and its wording, and is assigned to phase 5 for a
Maestro walk, where the flows are already being revisited.

---

## F. Two observations assigned onward

1. **`applyWalletDelta` labels every reference `game_session`.** For a career
   reward the reference is a career NODE id and for a sprint entry a TOURNAMENT
   id, so the `reference_type` column is wrong for three of the eight reasons.
   It is invisible to a player — the wallet screen labels a row from `reason`,
   not from this — and no query depends on it, so nothing was changed in an
   append-only table for a cosmetic label. → **Phase 10**, with the rest of the
   audit-trail review.

2. **The resume card has not been walked by Maestro.** `every-screen.yaml` only
   passes against an UNCONFIGURED build, and the card only appears in a
   configured one with a live seat. `play-resume`, `play-resume-card`,
   `quick-resume` and — now that A3 is fixed — `table-advice` are all
   addressable and none has been asserted on a screen. → **Phase 5**, which owns
   the mobile-product flows.

---

## G. Phase 4 exit criteria

| Requirement | Status |
|---|---|
| Wallet is server-only authority | **PASS** — four independent layers, B3 |
| Ledger reconciles | **PASS** — three statements of the same number, B3 |
| Quick Play is real server gameplay | **PASS** — B6, and now reconnectable |
| Career rewards are authoritative | **PASS** — B1, A2 |
| Economic operations transactional / idempotent | **PASS** — B5, B9, B10 |
| A modified client cannot credit itself | **PASS** — B11 |
| Relevant tests green | **PASS** — E |

**PHASE 4: PASS**
