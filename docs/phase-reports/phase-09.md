# Phase 9 — Daily Challenge, Leaderboards, Cosmetics, Notifications

**Status: PASS**, 2026-09-02.

Five defects found and fixed. Every one was proved to fail by REVERTING the fix
in the running system and watching the exact assertion break. The historical
"18 items versus 20 items" intermittent is **conclusively resolved**: it was
reproduced ON PURPOSE against the real Edge Functions, through a proxy that
reproduces the runtime fault that caused it, and the reproduction is now a
permanent regression test.

---

## A. The Daily Challenge intermittent — closed

### What was observed

`the daily challenge > deals two different accounts the identical shoe` failed
occasionally with

```
expected [ 18 items ] to deeply equal [ 20 items ]
```

— a hand-COUNT mismatch, with every card that *was* recorded agreeing. It reads
as a defect in the deterministic shoe, which is the most important claim the
whole mode makes.

### The mechanism, and why the earlier account was right but unproved

Phase 0 diagnosed it from `docker logs supabase_edge_runtime_arc21`: the edge
runtime retires a user worker when its isolate trips the CPU soft limit, and a
request already in flight is then answered by a worker that is gone — with the
`{"message":"command handled", …,"outcome":"accepted"}` line landing BETWEEN the
retirement and the error. **The command committed; only the reply was lost.**
The pre-fix test helper carried `if (next.status !== 200) break`, so a lost
`NEXT_HAND` reply truncated the attempt and handed back a short array.

That account was correct and it was also **unproved**. `call-function.test.ts`
drove the caller against a stub; nothing had ever shown the REAL server surviving
the real fault, and nothing had shown the reported symptom arising from it.

### Reproduced on purpose

`tests/server/game-command.integration.test.ts > the daily challenge >
reproduces the lost-reply truncation, and survives it` stands an HTTP proxy in
front of the real function. Each request is forwarded, the real reply is awaited
— so the command genuinely commits — and then that reply is thrown away and
replaced with the runtime's own words:

```
HTTP 546 {"code":"WORKER_LIMIT",
          "message":"request cannot be handled because the worker has already retired"}
```

The test then does three things:

1. **Reproduces the reported symptom exactly.** With one `NEXT_HAND` reply lost
   at hand 18 and the PRE-FIX caller (a plain `fetch`, breaking on a non-200),
   the attempt yields **18 hands against a reference attempt's 20, with all 18
   identical**. Not a plausible cause — the failure itself, on demand.
2. **Shows the current caller surviving it.** Four replies are lost — a
   `LOCK_BET`, two mid-run `NEXT_HAND`s and the FINAL `NEXT_HAND` — and the
   attempt completes twenty hands with the same cards as an attempt that lost
   nothing. All four retries announce themselves as `HTTP 546`.
3. **Shows nothing was applied twice**: one `daily_entries` row, `hands_played`
   20, and one 1,000-chip reward.

The final `NEXT_HAND` is in the fault list deliberately. It never reaches
`applyCommand` — it closes the session, marks the seat left and pays the reward
— and its idempotency record is written on a different code path from every
other command's.

### Stability

`-t "daily challenge"` (9 tests), against the live stack:

* **12 consecutive runs** during development, all green;
* **10 further quiet runs** after the final database reset, all green;
* **4 runs under load**, each started five seconds into a full `npm run test:unit`
  — the shape the original failure was seen in — all green;
* **3 confirmation runs** against the final code on a freshly reset database, all
  green. **29 runs, 0 failures.**

No `[call-function]` retry warning appeared in any of them, which is the other
thing worth reporting: on an idle machine the runtime is not retiring workers,
and the suite is passing on its own merits rather than because something was
absorbed.

### What it was NOT

Checked and ruled out, rather than assumed: missing idempotency (the replayed
final command returns the FIRST committed response byte for byte, asserted),
duplicate command application (one entry row, one reward), partial progression
(`SESSION_COMPLETE` is asserted before the array is returned), and a race (one
seat, strictly sequential; a `stale` verdict is treated as a failure precisely
because this attempt cannot legitimately race itself).

---

## The defects

### 1. A Daily Challenge attempt that ran out of chips could never end

`dailyBoundary` checked one thing: `isComplete(handNumber, handCount)`. A
challenge stack can be exhausted long before hand twenty — 5,000 chips with a
1,000 ceiling is five losing hands at the maximum — and below the 100-chip
minimum there is no legal bet to place. `careerBoundary` has had the other branch
since career sessions shipped ("BANKROLL EXHAUSTION IS A COMPLETION"); this one
never did.

Measured against the running stack with the fix reverted, after forcing the seat
to 50 chips at a settled hand:

```
NEXT_HAND -> 200 phase BETTING_OPEN handNumber 2
legalActions for the seat -> {"actions":[],"canPlaceBet":false,"canLockBet":false,
                              "betBounds":null,"canStartNextHand":false}
entry   -> in_progress hands=0 final=5000 score=0
session -> active
```

Nothing on screen to press, no clock (a Daily Challenge carries none on purpose),
and — because `startDailyChallenge` RESUMES an in-progress attempt — that
account's one ranked run for the day was permanently unfinishable. The entry
would have read `final_chips = 5000` for ever, which is not merely stuck but
wrong.

With the fix:

```
NEXT_HAND -> 200 phase SESSION_COMPLETE handNumber 1
entry   -> completed hands=1 final=50 score=50
session -> completed
```

`attemptCompletion` in `_shared/daily-challenge.ts` is the single definition, and
it prefers `hand_count` when both are true so a player who busts on the last hand
has still COMPLETED the challenge.

### 2. Starting the challenge took a second live seat, and hid the first

Every other mode that opens a seat asks whether the caller already holds a table
— `open`, `joinPublicTable`, `startCareerNode`, `registerSprint`. This one did
not. Measured, before the guard existed:

```
OPEN solo             -> 200  gameId 431ef063…      wallet 25,000 -> 20,000
my_active_session     -> [{ mode: "solo",             game 431ef063… }]
START_DAILY_CHALLENGE -> 200  gameId 06412d8e…       (a SECOND live seat)
my_active_session     -> [{ mode: "daily_challenge",  game 06412d8e… }]
my seats              -> [431ef063… active, 06412d8e… active]
wallet                -> 20,000
```

`my_active_session()` orders by start time, so the solo table holding 5,000 chips
of escrow became unaddressable from every screen — which is the precise failure
that function was written to close, and the one phase 8 closed for a Sprint
entry, reached through the one mode neither phase checked. After the fix the
second call is `409 SESSION_ALREADY_ACTIVE`, one seat remains, and
`my_active_session()` still names the table the chips are at.

The guard sits BELOW the resume branch: returning to an attempt already in
progress takes no new seat, so a player whose ranked run is open can always get
back to it. Verified both ways.

### 3. A reshuffle mid-challenge would have been dealt from the CSPRNG

Randomness reaches the engine at exactly two points — `createShoe` when the
session opens, and `reshuffle` inside `openBetting` once the cut card is passed.
The first came from the challenge's secret seed. The second came from
`serverRandom()`, because `game-command` handed every command the CSPRNG. So an
attempt that crossed the cut card would have been dealt a shoe nobody else was
dealt, and **nothing would have failed**: both attempts still play twenty hands,
they simply stop being the same challenge.

Measured over 400 attempts per configuration with the most card-hungry legal play
there is (split whenever allowed, then hit to 21 or bust):

| hands | cut card | worst index reached | attempts that reshuffled |
|-------|----------|---------------------|--------------------------|
| 20 (always stand) | 234 | 108 | 0 of 400 |
| 20 (greedy) | 234 | 160 | 0 of 400 |
| 40 (always stand) | 234 | 213 | 0 of 400 |
| 40 (greedy) | 234 | 250 | **385 of 400** |
| 60 (either) | 234 | 240–250 | **400 of 400** |

So it was LATENT at the shipped twenty hands rather than live. But `hand_count`
is the challenge ROW's, constrained only to 1..100 and honoured as authored, and
past roughly forty hands a reshuffle is ordinary. A guarantee that holds because
of a number nobody is checking is not a guarantee.

`dailyShoeSource(seed, shuffleNumber)` keys the stream on the shuffle number, so
shuffle two is reproducible AND different from shuffle one, and every entrant
faces the same stream — `shuffle 1 ‖ shuffle 2 ‖ …` — however differently they
play. `game-command` chooses the source from the SESSION ROW's mode, never from
the request.

Proved by reverting `shoeSourceFor` to `serverRandom()` and winding two accounts'
shoes to the cut card:

```
AssertionError: expected 'd4-9S,d2-3H,d5-QH,d3-3D,…' to be 'd5-7H,d0-5H,d3-2D,d1-QC,…'
```

### 4. The seed was never published, so the commitment could never be checked

`daily_challenges.revealed_seed` has existed since the table did. A trigger
refuses a reveal before `closes_at` and refuses one that does not match the
secret; the client projection carries the column; `daily.ts` parses it; the Daily
screen renders it; and `describeVerification` tells the player, in so many words,
that "the seed itself stays secret until the challenge closes, **then it can be
checked against this hash**".

**Nothing in the product ever wrote the column.** Outside pgTAP, no code path set
`revealed_seed` — so the seed was never published, the render branch was dead,
and the promise on the screen could not be kept by anybody. The commitment
migration's own header warns about exactly this: *"a commitment nobody checks is
theatre"*. A commitment nobody CAN check is worse.

The specification: *"After challenge closes, the seed may become publicly
viewable in an audit/fairness view."*

`reveal_closed_daily_seeds()` publishes every closed challenge's seed, and
`ensure_todays_daily_challenge` calls it as its first act — on demand rather than
on a schedule, the same reasoning the challenge row itself is created under.
`latest_verifiable_daily_challenge()` returns the most recent published one with
its commitment and **no verdict**: the device recomputes SHA-256 with
`expo-crypto`, because a server that also said "yes, it matches" would be asking
to be believed twice.

Three things have to agree before a byte moves, and today's seed stays secret
through all of them: the reveal's own `closes_at <= now()`, the table's trigger,
and the fact that `revealed_seed` is a different column from `seed_secret` — which
the `authenticated` grant does not list.

On the device, with yesterday's challenge closed:

> **Verified: 2026-09-01**
> Checked on this device: SHA-256 of the published seed is exactly the commitment
> published before anyone played.

### 5. Two server-owned tables had no write guard, and one of them is a leaderboard's whole input

`deny_client_write()` is the second lock on a server-owned table; the first is
the absence of a grant, and this repository has added a client grant by accident
sixteen times. `player_daily_xp` — the weekly XP leaderboard's entire input — had
no trigger at all. Measured by granting `insert` to `authenticated` and pointing
the new forgery test at it:

```
XP for this week was not refused: HTTP 201
  [{"user_id":"318f791d…","utc_day":"2026-09-02",
    "repeatable_xp":999999,"milestone_xp":999999}]
```

One grant, top of the board. `wallet_ledger` was the same shape — `wallets` has
carried the trigger since the foundation migration and the ledger beside it never
did.

Then the CATALOGUE was asked which tables lack it, rather than the question being
answered from memory, and it named three more: `rooms`, `room_members` and
`matchmaking_queue`. All five now carry it; every function that writes any of
them is SECURITY DEFINER (checked in `pg_proc.prosecdef`, not assumed), so
nothing legitimate changed.

`20_authorization_surface.test.sql` now asks the same question mechanically, so a
table added tomorrow without a guard fails a test rather than an audit — proved
by dropping one trigger and watching it fail.

---

## What phase 9 also completed

### Leaderboard pagination

The four boards took a row COUNT and nothing else, which is not pagination: a
player at rank 130 could see their own position and had no way to look at the
players around them. Each board now takes `p_limit` and `p_offset`.

The one thing worth knowing about the implementation: `rank()` is what a player
reads — equal XP is equal placing — but it is **not a total order**, so
`order by rank offset 100 limit 25` over a tie can put one row on two pages and
another on none. Each board now also computes `row_number()` over the IDENTICAL
window (every window ends in `user_id`) and pages on that. The returned row type
is unchanged.

Adding a defaulted parameter would have created a SECOND function rather than
replacing the first, and `leaderboard_weekly_xp(100)` would then answer "function
is not unique" — so the old arities are dropped, and `hasnt_function` asserts
they are gone.

Verified on the device with 30 ranked players seeded: page one ends at rank 25
with "Load more"; the tap appends rank 26 onward and the control disappears when
the short page comes back. Ranks are continuous across the boundary.

### The qualification thresholds

Unchanged and re-checked against the specification: 100 server-graded decisions
in the ISO week to appear on the strategy board, with the volume tie-break capped
at 1,000 so grinding cannot outrank accuracy, and a player below the bar told
"62 of 100" rather than shown an empty list.

### Leaderboard security

`gives a modified client no way to manufacture a leaderboard figure` attacks all
four board inputs over PostgREST with a real session token — `player_daily_xp`,
`player_decision_periods`, `daily_entries.score`, `tournament_entries.placement`
— plus `user_cosmetics`, plus direct RPC calls to the six server-only functions
behind them. Proved to fail on a real breach before being trusted.

### The Fair Play screen said nothing about the online shoe

The specification's Fair Play list names *"Online cards are selected on the
server"* beside *"Practice uses secure device randomness"*. Every one of the
sixteen facts on that screen described PRACTICE, which runs on the device — so
the one claim a player would most want checked was the one the page did not
make, and the Daily Challenge's commitment (the strongest evidence this product
has for it) was discoverable only from the Daily screen.

One fact added, verified on the device, and asserted by `every-screen.yaml`
because it is a statement about the CODE and is true whether or not a server is
configured. `tests/stats/fair-play.test.ts` sweeps it for forbidden claims like
every other — note that "provably fair" is on that list, which is why the wording
describes the mechanism instead of naming it.

### Cosmetics and assets

No defect found. 12 avatars, 8 card backs and 4 table themes — the
specification's minimum, met exactly — every one a hand-authored SVG component in
this repository, every unlock earned by playing, and `cosmetic_unlock_type`
carrying no member that could express a purchase or a random draw. Ownership is
server-granted with no client write path, and the loadout trigger refuses an
unowned item for any write path.

`docs/ASSET_LICENSES.md` reviewed and corrected: it still said the registry test
parses the catalogue from `supabase/seed.sql`, which stopped being true when the
catalogue moved into a migration.

### Notifications

No defect found. Token registration, per-kind preferences honoured by the sender,
the four specified kinds written by the routines that cause them
(`send_friend_request`, `accept_friend_request`, `invite_friend_to_room`, plus
`tournament_starting`, `tournament_result` and `your_turn` from the Edge
Functions), deep links derived from the notification's KIND rather than from a
path in its payload, and cold-start routing through
`getLastNotificationResponseAsync`. Without `EXPO_ACCESS_TOKEN` the mock
transport records `mocked` rather than `sent` and leaves `sent_at` null, so a
development run cannot be mistaken for evidence of delivery.

Two enum values — `career_unlocked` and `system` — have no producer today. Both
route correctly if one is ever written; neither is asked for by the
specification's push list. Recorded rather than built.

---

## One test defect, worth recording

The lost-reply test first asserted the FAILURE MESSAGE — that it named 18 and 20
— and passed three times before failing on the fourth. Vitest renders
`[ …(18) ]` when the leading array elements differ and
`[ 'd5-4H,d0-6S|d5-QC,d0-9D', …(17) ]` when they agree, so the numbers in the
sentence depend on the shoe. The lengths themselves are asserted separately and
deterministically; the message assertion is now that the comparison throws at
all, with the rendering recorded in a comment.

---

## Verification

Against a database reset from empty (53 migrations) with `functions serve`
restarted first:

```
npx tsc --noEmit                    exit 0
npm run check:functions             all 3 Edge Functions typecheck
npm run lint                        0 errors, 37 warnings (baseline unchanged)
npm run test:unit                 118 files / 2,359 tests PASS   (phase 8: 118 / 2,330)
npm run test:server                20 files /   250 tests PASS   (phase 8:  20 /   243)
supabase test db                   25 files /   532 tests PASS   (phase 8:  25 /   520)
npm run test:coverage              per-area gates pass, exit 0
npm run contrast:check             50 pairings, 0 failing (+2 Increased-contrast)
npm run benchmark                  802 µs/hand (range 752–808)
supabase db reset                  53 migrations applied from empty, exit 0

Maestro, iPhone 17 Pro Max (iOS 26.5), dev build, Metro restarted with --clear
AFTER the client edits and confirmed by its pid's start time:
  every-screen-online.yaml          exit 0, 46 steps COMPLETED
  every-screen.yaml                 exit 0, 87 steps COMPLETED (.env.local moved aside)
```

`every-screen.yaml` failed twice before that on an assertion nothing in this
phase touched, and the failure was real rather than load: returning from
Leaderboards left the Social tab at the TOP, and the flow waited for a footer
that was in the tree and not on screen, under a comment asserting that
"returning keeps that position". CLAUDE.md already records the rule — *"returning
from a pushed screen sometimes restores the previous scroll position and
sometimes returns to the top, so assert on text that is actually on screen at
that point"* — and the flow had made the assumption anyway. It is a
`scrollUntilVisible` now, which copes with either answer.

`npm run contrast:check` went from 46 pairings to 50: `accent` is used as body
TEXT in five places (the Learn screens, the Home overline, and now the
leaderboard's "Load more") and had only ever been measured as a button FILL. All
four new pairings pass — 7.54:1 at the worst.

### Each fix proved by reverting it

| Fix | Reverted how | What failed |
|-----|--------------|-------------|
| bankroll exhaustion ends the attempt | dropped the branch from `attemptCompletion` | `expected 'BETTING_OPEN' to be 'SESSION_COMPLETE'` |
| one live seat | commented out `assertNoOtherLiveSeat` | `expected 200 to be 409` |
| deterministic reshuffle | `shoeSourceFor` → `serverRandom()` | the two entrants' second shoes differ |
| deterministic reshuffle (unit) | `dailyShoeSource` ignores the shuffle number | shuffle two IS shuffle one |
| the seed reveal | removed the call from `ensure_todays_daily_challenge` | `expected undefined to be '2019-07-04'` |
| the write guards | `grant insert … to authenticated` + a permissive policy | `HTTP 201` with 999,999 XP |
| the write-guard rule | dropped one trigger | pgTAP test 22 fails, naming the table |

---

## Known limits

* **`career_unlocked` and `system` notification kinds have no producer.** Routed
  if written; not asked for by the specification. → whoever adds the feature.
* **Push delivery has never reached a device.** No EAS project id, so no token
  can be issued; the mock transport records `mocked`, never `sent`.
  → phase 12 / external.
* **A mismatch between a published seed and its commitment has never been seen,
  because one cannot be produced.** The trigger refuses a reveal that does not
  match the stored secret, so the `does-not-match` branch is covered by unit
  tests on the wording and not by a live case. That is the right way round.
