# Phase 8 — Sprint Tournament

**Status: PASS**, 2026-09-01.

Seven defects found and fixed. Six of them were proved to fail by REVERTING the
fix in the running system and watching the exact assertion break; the seventh —
a public-table test helper — was diagnosed by reproducing its trigger on purpose.
A whole four-player tournament now runs entry → twelve hands → elimination after
six → placements → prizes → closed result through the real Edge Functions, and
the tournament screen and table were walked on a device against the real backend.

---

## What was already right

Most of the format was built, and built well. The configuration matches the
specification field for field — four players, 10,000 equal stacks, twelve
scheduled hands, 100 minimum, 2,000 through hand eight and 5,000 from hand nine,
lowest stack out after hand six, 500 entry, 2,000/1,000/500/0 prizes, no rebuys.
`supabase/functions/_shared/tournament-format.ts` is pure arithmetic over that
structure with 32 unit tests over its boundaries; `sprint_format()` publishes the
same numbers to the client before a chip is spent; the entry fee and every prize
move only through `apply_wallet_delta` under a key derived from the tournament
and the player; tournament stacks never reach a wallet; the button is chosen by
the server's CSPRNG and rotates by rotating the engine's seat array, so there is
no second notion of who acts first; and tournament decisions are excluded from
ranked strategy accuracy by an allowlist rather than by construction.

What follows is what was wrong with it.

---

## The defects

### 1. Betting was not sequential — the format's defining mechanic did not exist

The specification is explicit twice over: *"Betting: sequential and visible"*,
*"Bet timer: 7 seconds/person"*, and *"Betting is sequential. Earlier committed
tournament bets become visible. This is intentional because bankroll-position
strategy matters."*

It was simultaneous. `activeSeatId` was **null for the whole betting round**, so
nothing named a first bettor at all; every seat could stake at any moment; and
one shared seven-second clock covered all four players rather than giving each
their own. Measured against the running stack before anything was changed — the
LAST seat in button order placed and locked before the first, and the server
answered `200` to both:

```
seat order (engine order = button order): 2d73701b a2aa9376 2623d2fc 6d9cbf59
activeSeatId (during BETTING_OPEN): null
--- last seat in order (6d9cbf59) bets FIRST ---
PLACE_BET status 200 … "version":2 …
LOCK_BET  status 200 … "version":3 …
```

Without it a Sprint Tournament is a four-seat table with a hand count. The
project's own `docs/TEST_PLAN.md` recorded this area as *"Still open: sequential
betting asserted as **visible** to other seats"* — the visibility half. The
ORDER half was simply absent, and the note reads as though it were present.

**The fix.** `BlackjackRules.sequentialBetting`, a posted table property beside
`minBet`/`maxBet`/`betIncrement`. It changes who may stake chips at a given
moment and nothing about what a hand is worth, so it alters no cell of the
strategy chart and does not bump `rulesetId@version` —
`tests/strategy/lookup.test.ts` forces that decision to be made explicitly, and
it is recorded there as `irrelevant`.

When set, `positionBettor` names the next seat in `state.seats` order that is
still in the hand and has not locked, and restarts the bet clock only when the
turn genuinely moves. `isBettingTurn` is the single definition of "may this seat
stake now", with three callers: `getLegalActions` draws the controls from it,
the reducer refuses a command that contradicts it, and the server's
`assertCommandIsLegal` uses it to answer **NOT_YOUR_TURN** rather than
WRONG_PHASE — the same distinction the player actions already drew, because the
first is a synchronisation problem a client recovers from and the second reads
as a bug.

A seat that cannot cover the minimum is sat out at positioning time rather than
left to time out. With one shared clock a broke seat costs the table one betting
window; with a clock each it would cost seven seconds of everybody's time per
broke seat, every hand, and the round cannot close until every eligible seat has
locked.

`RESOLVE_TIMEOUT` at BETTING_OPEN now applies the default to the CURRENT bettor
alone. Staking everybody at once would collapse the whole round the moment one
player looked away — and the players after them would never see the bets they
are entitled to bet against, which is the entire point of the format.

After the fix, measured the same way:

```
current bettor: 5f32e58f   canPlaceBet true   bounds {"min":100,"max":2000,…}
   2b3df0b5 canPlaceBet false bounds null
   60509afc canPlaceBet false bounds null
   e5fdb0f6 canPlaceBet false bounds null
OUT-OF-TURN PLACE_BET -> 422 {"code":"NOT_YOUR_TURN"}
OUT-OF-TURN LOCK_BET  -> 422 {"code":"NOT_YOUR_TURN"}
in-turn bet -> 200   next bettor: 2b3df0b5   (expected 2b3df0b5)
bets visible to everyone: 5f32e58f=300L 2b3df0b5=0 60509afc=0 e5fdb0f6=0
```

**Reverted to prove it:** `positionBettor` made a no-op → 10 of 13 assertions in
`tests/engine/sequential-betting.test.ts` fail; restored → 13 pass.

### 2. The competition boundary was skipped whenever the settlement window lapsed

`game-command` ran `resolveHandBoundary` for `NEXT_HAND` **and for nothing
else**. But a settled hand also advances when its eight-second rest window
lapses and any connected client asks the server to resolve the deadline: the
engine's `RESOLVE_TIMEOUT` handler calls `advanceToNextHand` at HAND_COMPLETE.

So the next hand was dealt with no boundary at all. Measured:

```
after hand 1 phase: HAND_COMPLETE  deadlineAt: …:39:15Z
tournament BEFORE: {"status":"running","scheduled_hands_played":0}
waiting 9002 ms for the settlement window…
RESOLVE_TIMEOUT at HAND_COMPLETE -> 200 accepted   phase now: BETTING_OPEN  handNumber: 2
tournament AFTER:  {"status":"running","scheduled_hands_played":0}
```

Hand two was dealt with the scheduled counter still at zero. Nobody is
eliminated after hand six, the ceiling never rises at hand nine, the button does
not rotate for that hand, and — because the counter can never reach twelve — the
tournament can **never finalise and never pay a prize**. Four players watching an
eight-second clock is not an edge case; it is what a tournament looks like when
somebody puts their phone down. The same path silently broke the Daily
Challenge's twenty-hand stop and a Career node's stars.

**The fix.** `commandStartsNextHand(state, commandType, now)` in
`_shared/session-boundary.ts`, used by `game-command` in place of the literal
comparison. The deadline check is part of the predicate rather than a detail:
`assertCommandIsLegal` returns early for `RESOLVE_TIMEOUT` because the engine
owns that clock, and the boundary runs BEFORE the engine — so a boundary that
can END a tournament would otherwise be reachable by any client willing to ask
early. `isDeadlineReached` is the engine's own comparison, exported rather than
copied.

**Reverted to prove it:** the predicate returning `NEXT_HAND` only →
`expected +0 to be 1` on the scheduled-hand assertion in the full-progression
test; restored → pass.

### 3. A paid entry could never be given up, and nothing ever cancelled a sprint

Registration debits 500 chips and holds the player in the oldest tournament
still short of players. `registerSprint` returns that SAME entry to anybody
already in a `registering` or `running` tournament — so a player whose three
companions never arrived was locked to it permanently: the fee spent, the screen
reading "Waiting for 3 more players", and every other online mode refusing them
for as long as it lasted. Measured: a lone registrant, re-registering, got
`entryFee 0` and the same `tournamentId`, for ever.

The specification asks for the missing half in its own error handling — *"if a
committed tournament is cancelled server-side, refund through ledger"* — and
`tournament_entry_status` already had a `withdrawn` label that nothing wrote.

**The fix.** `WITHDRAW_SPRINT`: contract, handler, client store action and a
control on the screen. It is refused once the cards are out (`SESSION_BUSY`, not
a flat refusal — a player must not be able to buy out of a tournament they are
losing) and the refund rides a `sprint_refund:<tournamentId>:<userId>` key, so a
retry with a fresh request id returns the first result instead of minting a
second 500 chips. A withdrawal that empties a tournament cancels it.

`expireStaleSprints` is the server-side trigger the specification's sentence
needs: a tournament that has sat `registering` past the thirty-minute window is
cancelled and every entry refunded, run from registration under the same
advisory lock — for the same reason the daily challenge row and the matchmaking
room are created on demand, that a cron job which has not run yet is an outage.

`tournament_refund` is its own ledger reason rather than a `tournament_entry`
with the sign flipped, because a player reads their own ledger.

### 4. Registering did not check for a seat elsewhere, in either direction

`OPEN`, `JOIN_PUBLIC_TABLE` and `START_CAREER_NODE` all refuse a player who
already holds a live seat. `REGISTER_SPRINT` did not. Measured: an account
holding a live solo table registered, its field filled, and the server dealt it a
**second live seat** —

```
OPEN -> 200 gameId 3528df90-…
REGISTER_SPRINT -> 200 filled 1        (three more players registered)
my_sprint_entry -> tournament_status "running", game_session_id 727483b4-…
my_active_session -> [{"game_session_id":"727483b4-…","mode":"tournament"}]
```

`my_active_session()` names only the newer of the two, which is exactly the
failure phase 7 recorded as *"a live seat must be ADDRESSABLE"*: the solo
table's buy-in sat in escrow at a game id the player could no longer discover.

The other direction is reached by SOMEBODY ELSE'S command — the fourth
registrant's request seats the whole field without asking the other three — so a
player who registered and then opened a solo table would be given a second seat
by a stranger. `assertNoOtherLiveSeat` now also refuses while a PAID sprint entry
is pending, and skips that question for a player returning to a table they
already hold. The refusal names something the player can do, because the entry is
now withdrawable.

**Reverted to prove it:** both guards removed → `expected 200 to be 409` twice;
restored → pass.

### 5. The result vanished in the transaction that created it

`my_sprint_entry` filtered on `t.status in ('registering', 'running')`, and
finalisation sets a tournament `completed` in the same transaction as the last
hand. So the moment a tournament ended, the one lookup the client has for
finding its own tournament stopped naming it: the Sprint screen fell back to
offering a fresh entry, with no placement, no prize and no standings anywhere on
it. The specification asks for a result page with placement, final bankroll,
prize and XP; it was unreachable.

The screen also offered "Review the table" for a completed tournament — a
control that could only land on a session answering `SESSION_CLOSED`.

**The fix.** `my_sprint_entry` also returns a tournament that finished within the
last day, bounded so a week-old result is not still presented as current. The
screen renders the result and the specification's *"rematch/new tournament"*
instead of the dead review control, and a completed entry does not block a new
one — `registerSprint` looks only at `registering` and `running`.

`my_sprint_entry` and `sprint_standings` also now exclude `withdrawn` entries: a
player who took their fee back is not somebody the field is waiting for, and
rendering them in the standings with a zero stack would read as somebody who had
gone broke.

**Reverted to prove it:** the pre-phase-8 function definition restored in the
live database → 3 pgTAP assertions fail (`have: NULL, want: …a2` for the
result lookup, and `have: 2, want: 1` for the field count); migration re-applied
→ 520 pass.

### 6. Every message the Sprint screen produced was destroyed before it was read

Found on a device, not here. `register` and `withdraw` both finish by reloading —
they have to, because what the player now holds is the server's answer and not
theirs — and `load` ended with `notice: null`. So the refund sentence a player
needs in order to believe their 500 chips came back, and "You were already
entered. No second fee was taken.", were both written and then wiped a few
milliseconds later.

Nothing failed. The Maestro flow tapped "Leave the queue and refund 500 chips",
the tap COMPLETED, the control disappeared, the entry was gone and the money was
back — and the sentence explaining it was never on screen. It was caught by
asserting the RESULT rather than the tap, which is the rule this repository has
now paid for five times.

**The fix.** `load` no longer clears a notice it does not own, and both actions
set theirs AFTER the reload. The 3-second poll therefore cannot wipe a message
either.

**Reverted to prove it:** the pre-fix shape restored → 4 of 7 assertions in
`tests/tournament/tournament-store.test.ts` fail; restored → 7 pass.

### 7. A public-table test helper assumed it owned the table

One full `npm run test:server` in four failed in
`public-table.integration.test.ts`'s `standToSettlement`, on
`the active seat X is not one of ours`. Allocation is global, CI runs two server
files at once, and a public room keeps taking players while it has room — so a
seat that suite never created can legitimately be the one being waited on. It is
the same lesson `tests/server/public-seat.ts` already records one layer up.

Reproduced on purpose rather than retried: a background loop seating a stranger
into a casual table every 1.5 seconds broke the same file's helpers on the first
run. The helper now waits a stranger out the way the app does — a public table
carries clocks, `snapshot()` already sends the resolve request, so the next pass
advances the table — and names the seats it holds when it does give up. Four
consecutive clean `npm run test:server` runs since.

---

## What was verified, and how

### A real tournament, unabridged

`tests/server/sprint-tournament.integration.test.ts` opens a four-player
tournament through the real functions and plays it out. Every assertion below is
on the live run, not on a fixture:

- four distinct accounts, four distinct seats, 10,000 each;
- 500 debited once per player, one `tournament_entry` ledger row each, and a
  retry with a fresh request id charging nothing;
- twelve SCHEDULED hands played and bet on, the button moving every hand and
  never repeating consecutively, the first bettor being the first live seat
  clockwise from it, and the server asking the seats for their bets in exactly
  that order — four bettors before the elimination, three after it;
- the ceiling 2,000 for hands one to eight and 5,000 from hand nine;
- one hand advanced by letting the settlement window LAPSE, with the scheduled
  counter asserted to move (defect 2's regression);
- exactly one elimination, `eliminated_after_hand = 6`;
- `status=completed`, `scheduled_hands_played=12`, every entry placed;
- prizes never exceeding the schedule, one ledger row per paid placement, and
  the wallet arithmetic reconciling to `paid - 2,000` across all four accounts;
- the settled tournament replayed from every seat, moving no chips;
- the result readable afterwards through `my_sprint_entry` and
  `sprint_standings`, and a rematch accepted at full price.

### The boundaries a fair shoe will not produce to order

Three cases construct a STANDING — stacks, or the scheduled hand count — in
`private.game_state_private` and then let the server decide what follows. Not
outcomes: a tie at the elimination boundary, a player below the table minimum
and a tie at the top after hand twelve cannot be produced on demand by betting
into a fair shoe, and retrying a tournament until the cards cooperate is the
flake this project has twice learned to refuse.

- **Elimination tie.** Two seats level at the lowest stack after hand six →
  `tie_break_boundary = 6`, both entries `in_tie_break`, nobody eliminated, only
  the tied pair dealt in, and the sudden-death hand carrying hand SIX's ceiling
  rather than hand seven's. Resolving it eliminates exactly one, leaves
  `scheduled_hands_played` at 6 with `tie_break_hands_used` at 1, and does not
  disturb the four-seat order.
- **Bankruptcy.** A stack below the 100 minimum at hand one → eliminated
  `after_hand = 1`, seat sat out and disconnected, the other three carrying on
  with the button still rotating over four positions.
- **Final tie.** Two leaders level after hand twelve → `tie_break_boundary = 12`,
  the final hand's 5,000 ceiling, only the two leaders playing, and a terminal
  `completed` result with the winner paid 2,000 once the tie breaks.

The five-hand cap, shared placements and pooled-and-floored prizes are covered by
the 32 unit assertions in `tests/tournament/tournament-format.test.ts`.

### Adversarial

Duplicate entry; duplicate prize (replayed from every seat after settlement);
reconnect (`my_sprint_entry` naming the game AND the seat, and that seat still
able to act); a stale command answered with the snapshot and nothing applied; a
repeated bet replayed byte for byte with one debit; a stranger's command refused
`NOT_A_PARTICIPANT`; an out-of-turn bet refused `NOT_YOUR_TURN`; invalid bets
refused below the minimum, above the ceiling and off the increment; an absent
bettor staked the table minimum by the clock **without touching anybody else's**;
and a **database failure during prize settlement** injected with a trigger on
`wallet_ledger`, proving nothing at all was written — not the tournament's
status, not a placement, not a prize, not a chip — and that the retry settles it
exactly once and notifies all four players.

Ranked coaching: no `advice` on any tournament snapshot, and no rows added to
`player_decision_periods` by a tournament hand.

### On a device

Two Maestro flows against the real backend, on a build served by a Metro started
after the edits (`--clear`, confirmed by pid start time — a stale bundle has cost
this project three device runs and two wrong diagnoses).

- `tests/e2e/sprint-wait-and-withdraw.yaml` — the format read from the server,
  an entry paid, "Waiting for 3 more players. 1 of 4 seats taken", the new
  withdrawal control tapped, and the RESULT asserted: *"Your entry fee of 500
  chips is back in your balance."*, the entry card gone and the Enter button
  back. This is the flow that found defect 6.
- `tests/e2e/sprint-table.yaml` — three players arrive from outside the device
  through the real `REGISTER_SPRINT`, the device account's entry deals the
  table, and the table screen renders with its clocks, its rules line and its
  10,000 stack. Sequential betting from BOTH sides in one run: the device was
  not the first bettor, so the screen said *"…is betting."*; then the device's
  own timeout requests staked each absent seat the table minimum in turn until
  the chip tray arrived, the bet was placed, and the turn left.

The rendered table was also looked at rather than only asserted: hand 1, shoe 1,
the rules line, the dealer's hole card face down, and every seat showing
`Bet 100` against a 9,900 stack — the bets are visible to everyone, which is what
sequential betting is for.

---

## Gates

| Gate | Result |
|------|--------|
| `npx tsc --noEmit` | clean |
| `npm run check:functions` | all three Edge Functions typecheck |
| `npm run lint` | 0 errors, 37 warnings (unchanged from the phase-7 baseline) |
| `npm run test:unit` | **118 files, 2,330 tests** |
| `npm run test:server` | **20 files, 243 tests** — four consecutive clean runs |
| `supabase db reset && supabase test db` | **25 files, 520 assertions** |
| `npm run test:coverage` | per-area gates pass |
| `npm run benchmark` | 811 µs/hand (documented range 752–808 on a single run; a cold run on an unchanged commit has measured 1,242) |
| Maestro | `sprint-wait-and-withdraw`, `sprint-table` — both green on an idle host |

New this phase: `tests/engine/sequential-betting.test.ts` (13),
`tests/tournament/tournament-store.test.ts` (7),
`tests/server/sprint-tournament.integration.test.ts` (21), plus additions to
`tests/table/betting-affordance.test.ts`, `tests/table/table-deadline.test.ts`
and `supabase/tests/16_sprint_and_daily.test.sql` (7).

`game-command.integration.test.ts`'s twelve-hand tournament suite MOVED into the
new file rather than being deleted: it is a strict superset, and two copies of a
twenty-second tournament run is one implementation too many. Its drain helper
now lives in `tests/server/sprint-table.ts` so there is one of that too.

---

## Migration added

`supabase/migrations/20260902120000_sprint_withdrawal_and_result.sql` —
`tournament_refund` added to `ledger_reason`; `my_sprint_entry` returns a
tournament that finished within the last day and excludes withdrawn entries from
the field count; `sprint_standings` excludes withdrawn entries. Both functions
were copied from the LAST migration that defined them, per the
`create or replace` rule, and the migration ends with
`assert_client_authorization_surface()`.

---

## What a later phase should not rediscover

- **`sequentialBetting` is a posted table property, not a rule of blackjack.**
  It is on `BlackjackRules` beside the bet band, it does not alter a strategy
  cell, and it must stay false everywhere except the Sprint Tournament. Three
  callers share `isBettingTurn`; do not add a fourth definition.
- **A settlement-window timeout starts the next hand.** Anything that must
  happen between hands belongs behind `commandStartsNextHand`, not behind
  `command.type === "NEXT_HAND"`.
- **A sudden-death hand is an EXTRA hand at its boundary.** It does not consume
  one of the twelve and it carries the boundary's bet ceiling, which is why
  `scheduled_hands_played` is counted separately from the engine's hand number.
- **The button rotates over all four seats; the first BETTOR is the first live
  one clockwise from it.** They are the same seat until somebody goes out after
  hand six. Asserting they are always identical fails on hand seven, and that is
  the format working.
- **A tournament entry is a seat already bought.** It becomes a real seat when
  somebody else registers fourth, so every mode that refuses a second seat has
  to refuse a pending entry too.
- **`load()` must not wipe a notice an action just set.** The screen polls.
