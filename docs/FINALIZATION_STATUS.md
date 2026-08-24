# Arc 21 — Final production-MVP closure ledger

**Mission:** take the repository as it stands to a production-MVP release candidate
against the authoritative specification
(`Arc 21 — Deep Research, Product Specification, and Claude Code Master Build Prompt.pdf`,
137 pages; Part B "MASTER BUILD PROMPT" is the binding half, and the
"MVP ACCEPTANCE CRITERIA" and "DEFINITION OF DONE" sections at its end are the gate).

This file is the finite release ledger. It is not a progress report and it is not
a roadmap. Every material MVP requirement appears here exactly once with the
evidence that decided its status. **A row is VERIFIED COMPLETE only from objective
evidence — a command and its output, a file and its line — never from a document
claiming it.**

| Status | Meaning |
|---|---|
| **VERIFIED COMPLETE** | Objective evidence recorded in the row |
| **IN PROGRESS** | Being worked in this mission |
| **FAILED** | Defect found, fix required |
| **EXTERNAL BLOCKER** | Needs a credential/account/device this machine does not have. Implementation, configuration and local verification are finished |
| **DEFERRED V1.1/FUTURE** | Explicitly out of MVP scope per the specification |

---

## Mission state

**Started:** 2026-08-22. Branch `phase14-s2-security`.

**Baseline measured at the start, before any change:**

```
npx tsc --noEmit            → exit 0
npm test                    → 77 files, 1544 tests, all passed (76.6 s)
```

Local Supabase stack up (12 containers healthy); iOS simulator iPhone 17 Pro booted
with `com.arc21.app` installed; Maestro on PATH; host load average 5.5.

**Section index below is filled as evidence lands. See `.claude/RESUME.md` for the
resume protocol if this session is interrupted.**

---

## Ledger

### R1 — A player could be charged two buy-ins out of one wallet · **VERIFIED COMPLETE**

**Severity:** blocker. Two live escrows from one wallet, on the ordinary path.

**Reproduced** against the running stack, by client-reachable calls only, before
any fix existed. `tests/server/economy-guards.integration.test.ts` failed exactly
here:

```
× refuses a public buy-in while the player holds a live solo seat
  AssertionError: expected 200 to be 409
× refuses to queue a player who already holds a live seat
  AssertionError: expected 200 to be greater than or equal to 400
```

**Root cause — three faults, not one.**

1. `joinPublicTable` (`supabase/functions/create-session/index.ts`) had no
   already-seated check. The solo path had one; the public path bought in
   regardless. The buy-in idempotency key is derived from the GAME, so two
   games are two keys and both are honoured.
2. `join_matchmaking` reused an existing enrolment by `status = 'waiting'`. A
   MATCHED player holds a `matched` row, so the lookup missed, a second
   enrolment was inserted, and `poll_matchmaking` allocated it a different room
   because the first had left `lobby` when it opened.
3. `leave_matchmaking` cancelled `waiting` only — found while fixing (2), and
   fatal to it: once a re-queue reuses a matched entry, a player who backs out
   of a match holds a dead one for ever and keeps an unfunded lobby seat.

`docs/RELEASE.md` carried this as needing a force-quit. **It does not.** Being
MATCHED is not being seated and costs nothing, so a matched player can open a
solo table first and then take the public seat — two escrows, no force-quit, no
race, no service-role fixture.

**Fix.**
- `assertNoOtherLiveSeat(tx, userId, exceptGameId)` in `create-session`, called
  from the solo path (`exceptGameId` null) and from `joinPublicTable`
  (`exceptGameId` = the room's own session, so a reconnect stays idempotent).
- `supabase/migrations/20260823100000_one_live_seat.sql` redefines
  `join_matchmaking` **from the last version** (`20260818100000_rate_limits.sql`,
  not the original) so the rate-limit charge survives, and `leave_matchmaking`
  to release an unfunded lobby seat while never releasing a funded one.
- Client half: `takeSeat` collapsed every refusal into "That seat could not be
  taken." `SESSION_ALREADY_ACTIVE` now names the table holding the chips, and
  `readRejection` moved to `src/lib/supabase/rejection.ts` rather than being
  copied — one decoder, two callers.

**Evidence after the fix.**

```
tests/server/economy-guards.integration.test.ts   3 passed
supabase test db                                  431 assertions, Result: PASS  (was 422)
npm test                                          79 files, 1554 tests passed   (was 1544)
ARC21_REQUIRE_SERVER_STACK=1 vitest run tests/server   6 files, 59 tests passed
npx tsc --noEmit                                  exit 0
```

The client-side guard was proved to discriminate: removing the
`SESSION_ALREADY_ACTIVE` branch fails `take-seat.test.ts` and nothing else.

---

### R2 — The catalogue a deployed database would not have had · **VERIFIED COMPLETE**

**Severity:** blocker. No session of any kind could be opened in a deployed project.

**Found** while preparing the career work, by grepping for the writers of
`public.career_nodes`:

```
grep -ln 'insert into public.cosmetics\|insert into public.rulesets\|insert into public.career_nodes' supabase/migrations/*.sql
  → (only rate_limit_policies, in 20260818100000)
grep -n '^insert into' supabase/seed.sql
  → 23: rulesets   70: cosmetics   111: career_nodes
```

**Root cause.** `supabase/seed.sql` runs on `supabase db reset` and **not** on
`supabase db push`. The ruleset, the 24 cosmetics and the career map lived only
there. `resolveRulesetId` in `create-session` raises on an empty `rulesets`
table, so a deployed Arc 21 could not open a solo table, a public table, a
tournament or a daily challenge. Every local verification in `docs/AUDIT.md`
passed because `db reset` had just run the seed — the one command that hides
this exactly.

**And a second catalogue.** The seed's eighteen career nodes were not the
eighteen the app plays. `foundations-1` "First Hand", five hands,
`{"type": "play_hands", "count": 5}` — a declarative grammar nothing in the
repository has ever interpreted — against `first-deal` "First Deal", ten hands,
60% accuracy in `shared/career/nodes.ts`, which is what every screen renders and
what `stars.ts` grades. `career_progress` and all eight career-gated cosmetics
were keyed to the catalogue the player could not see.

**Fix.**
- `20260823110000_catalogue_ships_in_migrations.sql` — the ruleset and the
  cosmetics, moved from the seed with their `on conflict` clauses intact.
- `20260823120000_career_catalogue.sql` — **generated** by
  `npm run career:generate` from `shared/career/nodes.ts`; deletes the
  placeholder rows (a leftover node nobody can play makes a `career_chapter`
  cosmetic permanently unobtainable), rebuilds the prerequisite chain, repoints
  the three chapter-final cosmetic gates, and raises on an orphaned gate.
- `supabase/seed.sql` now contains zero rows and says why.

**Evidence.**

```
grep -c 'insert into' supabase/seed.sql                        → 0
supabase db reset && psql -c 'select count(*) …'
  rulesets=1  cosmetics=24  career_nodes=18  rate_limit_policies=9   ← from migrations alone
supabase test db                                               435 assertions, PASS  (was 431)
npm test                                                       80 files, 1559 tests passed
tsc --noEmit                                                   exit 0
```

Guarded against recurrence by `tests/career/catalogue-sql.test.ts`, which
regenerates the migration and compares byte for byte, and asserts `seed.sql`
holds no `insert` at all — a file check, because a row count taken after
`db reset` cannot tell the two sources apart, which is precisely how this
survived. `06_catalog.test.sql` adds four assertions that no cosmetic gate names
a node or chapter that does not exist.

---

### R3 — Career progression granted nothing · **VERIFIED COMPLETE**

**Severity:** blocker. Three MVP acceptance criteria and one Definition-of-Done line.

**Verified before any fix:**

```
grep -rn 'career_progress' supabase/functions/ shared/ src/ app/   → (nothing)
```

Nothing anywhere wrote `public.career_progress`. The table existed with its
constraints, its RLS and its `deny_client_write` trigger; the cosmetic gates read
it; `shared/career/progress.ts` marked a completed node's reward `rewardOwed` and
left `rewardClaimed` false "until a server grants them", and `pendingRewards()`
had zero callers.

Failing: `□ Rewards`, `□ Cosmetics earned` (8 of 24 unobtainable — 3 gated on a
chapter final's code, 5 on a chapter), and "complete career progression".

**What the specification requires**, in three separate places:

```
"Career rewards | Server"                                 (authority boundaries)
"A Career node may be practiced offline, but any reward-bearing attempt
 requires server authority."                              (offline design)
"Move reward-bearing Quick Play and Career attempts to authoritative server
 commands."                                               (build phases)
```

So a ranked attempt is a real server session, not a reported score.

**Built.**
- A seventh `game_mode`, `career`, classified NOT wallet-backed in
  `session-economics.ts` — a node's 2,000 chips are a scoring medium, and
  crediting them would mint 2,000 per attempt. Both exhaustiveness tests failed
  until it was classified, which is exactly what they are for.
- `public.career_attempts` + `private.career_drill_seeds`, and
  `record_career_completion` / `record_career_attempt_started` /
  `my_career_progress` (`20260823130000`).
- `START_CAREER_NODE` and `SUBMIT_CAREER_DRILL` in `create-session`. A standard
  node opens a single-seat session on a CSPRNG shoe with the node's wager
  ceiling as the table maximum; a drill's scenarios are built from a 32-byte
  secret in `private` and **regenerated to grade**, so a client cannot answer an
  easier question than it was asked.
- `careerBoundary` in `session-boundary.ts`: stops at the node's hand count or
  at bankroll exhaustion (which is a COMPLETION — one star is always awarded, so
  variance can never wall a player out), calls the same `evaluateStars` the
  offline runner uses, and pays through `_shared/career-rewards.ts` under
  `career_reward:${nodeId}:${userId}`.
- Career decisions are GRADED but not counted towards the ranked accuracy board:
  half the nodes run in "learn", which shows the play before the choice, and the
  specification excludes exactly that. `isGradedMode` is the wider predicate;
  `ACCURACY_ELIGIBLE_MODES` is untouched.
- `shared/career` MOVED to `supabase/functions/_shared/career` with barrels left
  behind — the `shared/strategy` pattern, because `shared/career/**` is not in
  the set of files the Supabase CLI bind-mounts and no import map can add a file
  that is not in the container. One implementation, not two.
- Client: `career-server-store.ts`, a ranked CTA on the node screen that names
  the reward and refuses on the SERVER's prerequisite, `app/career/drill/[slug].tsx`
  for ranked drills, and a career map that unlocks on either record and shows
  the better star count. Offline practice is unchanged and still grants nothing.

**Evidence.** `tests/server/career.integration.test.ts`, 6 tests against the
live stack: a node played for real through the server's shoe awards stars, pays
its chips and XP once, never touches the stack (`career_reward` appears once and
`table_buy_in` never), closes the seat, refuses a node whose predecessor is not
complete, resumes rather than re-deals an attempt in flight, and grades a drill
against server-generated scenarios while refusing a second submission (409).
`17_leaderboards_and_cosmetics.test.sql` adds 5 assertions that the eight
career-gated cosmetics open once the rows exist.

```
supabase test db     440 assertions, PASS   (was 435)
npm test             82 files, 1571 tests passed
tests/server         8 files, 71 tests passed
npm run check:functions   all Edge Functions typecheck
tsc --noEmit / lint  exit 0 / 0 errors
```

---

### R4 — Edge Functions had never been typechecked · **VERIFIED COMPLETE**

**Severity:** blocker (one defect was live on the wire).

`supabase/functions` is excluded from `tsconfig.json`, so `npx tsc --noEmit` had
never read a line of it. It cannot: the `.js` specifiers resolve only through a
per-function `deno.json` import map, and tsc cannot be given a different map per
directory. `deno check --config <fn>/deno.json` can, and had never been run.

**Its first run, and what it found.**

```
8 × TS2345  Argument of type '"NOT_FOUND"' is not assignable to CommandRejectionCode
1 × TS2322  Type '"tournament_entry"' is not assignable to type 'LedgerReason'
1 × TS2741  Property 'insuranceDecision' is missing … but required in 'SeatState'
1 × TS2740  Type '{ id: string; }' is missing … from type 'SeatRow'
5 × TS18047 'seat' is possibly 'null'
```

**The live one, measured against the running stack:**

```
POST /create-session {"action":"JOIN_PUBLIC_TABLE","roomId":"…999"}
→ HTTP 200 {"status":"rejected","code":"NOT_FOUND","message":"undefined (ref …)"}
```

Two failures in one. The player is shown the word "undefined"; and 200 is
SUCCESS to `functions.invoke`, so `result.error` is null and the client reads a
body with no `gameId` in it — the refusal never reaches the code that handles
refusals. `NOT_FOUND` was never a declared code: the contract folds "no such
game" into `NOT_A_PARTICIPANT` deliberately, so ids cannot be enumerated by
comparing responses.

**Fixed:** every site mapped to a declared code (`NOT_A_PARTICIPANT` for
sessions and rooms, `INVALID_REQUEST` for a catalogue slug, which is public);
`LedgerReason` made exhaustive against `public.ledger_reason`;
`insuranceDecision` supplied on the appended seat; the `SeatRow`/null confusion
removed.

**After:**

```
POST /create-session {"action":"JOIN_PUBLIC_TABLE","roomId":"…999"}
→ HTTP 403 {"status":"rejected","code":"NOT_A_PARTICIPANT",
            "message":"You do not hold a seat at this table. (ref …)"}
```

**Held there by** `npm run check:functions` (now a CI step) for the compile
half, and `tests/server/rejection-contract.integration.test.ts` for the wire
half — 6 cases asserting every refusal carries a 4xx status, a declared code, a
message with no "undefined" in it, and no SQL or stack frame.

---

### R5 — Some accounts could not be created at all · **VERIFIED COMPLETE**

**Severity:** blocker. MVP `□ Email account`; Definition of Done "create an account".

**Found** in the auth container's own log while chasing a one-in-three test
failure that looked like flakiness:

```
{"level":"error","path":"/admin/users","status":500,
 "error":"… new row for relation \"profiles\" violates check constraint
          \"profiles_username_is_permitted\" (SQLSTATE 23514)"}
```

**Reproduced deterministically:**

```sql
insert into auth.users (id, …) values ('24552abc-def0-4000-8000-000000000001', …);
ERROR:  new row for relation "profiles" violates check constraint "profiles_username_is_permitted"
DETAIL: Failing row contains (…, p24552abcdef0, …)
CONTEXT: PL/pgSQL function handle_new_user() line 43
```

**Root cause.** `handle_new_user` derives a handle as `'p'` plus twelve hex
digits of the account id and never put it through the filter a **requested**
handle goes through. `username_is_permitted` folds digits before matching —
`0→o 1→i 3→e 4→a 5→s 7→t` — so `p24552abcdef0` folds to `p2ass2abcdef0`, splits
on its remaining digits into `{p, ass, abcdef0}`, and is refused for a forbidden
whole word. The CHECK rejects the row, the trigger aborts, and GoTrue answers
the signup **HTTP 500**.

Confirmed against the live function:

```
select public.username_is_permitted('p24552abcdef0');            → f
select regexp_split_to_array(translate('p24552abcdef','013457','oieast'), '[_0-9]+');
                                                                  → {p,ass,abcdef}
```

About **one account in nine hundred**, chosen at random by a uuid, with nothing
the player could do about it. Only `ass` is reachable this way — every other
word on either list needs a letter no hex digit folds to — which is why it was
rare enough to read as flakiness.

**Fix** (`20260823150000`, restated from the LAST of the function's two prior
definitions). The derived handle now goes through the same filter, and — the
part that matters — an unpermitted base draws a **fresh random base** rather
than a suffix: `p24552abcdef0_1` still contains the segment `ass` once folded,
so the old loop would have spun to fifty and raised, a 500 either way. A
permitted-but-taken base still suffixes, keeping the handle tied to the account
id where it can be.

**Evidence.** The migration inserts the exact reproducing id, asserts the filter
still refuses `p24552abcdef0` (so the check is not vacuous), asserts a permitted
handle was allocated, and deletes the row. Four more assertions in
`08_account_bootstrap.test.sql` hold it there, including that the ordinary
collision path still produces `p1a2b3c4d5e6f_1`.

```
insert '24552abc-…' → username p035ce7eecef6, permitted = t
supabase test db     444 assertions, PASS   (was 440)
```

---

### R6 — Quick Play was unreachable, and the Recovery Grant had no UI · **VERIFIED COMPLETE**

**Severity:** blocker. Two MVP acceptance criteria; the Play screen's own mode list.

**Verified before any fix:**

```
grep -rn '"OPEN"' app src shared
  → app/(tabs)/play.tsx:57   (a comment explaining the card is dead)
  → shared/contracts/session-command.ts:52  (the literal)

grep -rn "claimRecoveryGrant" app src | grep -v src/features/wallet/
  → (nothing)
```

`create-session`'s `OPEN` has been the most heavily covered path in
`tests/server` since the economy shipped and **no client had ever sent it**. The
Recovery Grant had a gateway method, a server RPC, an eligibility module and
twenty unit tests, and no screen could invoke it. The eleventh and twelfth
instances of built-but-never-connected.

**What the specification asks for on this screen**, and where each part landed:

| Requirement | Where |
|---|---|
| "First authenticated Quick Play opens setup. Remember the selection afterward" | `useQuickPlayStore.remember`, persisted; `tests/quick-play/selection.test.ts` |
| Three tiers, fixed buy-in / min / max | `TABLE_TIERS`, read from the engine, never retyped |
| "High … unlock at level 10" | checked on the screen **and** beside the money in `create-session` |
| "If the player cannot afford the selected tier, offer: lower tier / Practice / eligible Recovery Grant. Never route directly to a real-money purchase." | the affordability block. There is no purchase anywhere on the screen |
| assistance selector PLAY / LEARN / ANALYSIS / CHALLENGE | sent once at `OPEN`, recorded on the session row |
| "Guest Quick Play should transparently redirect to equivalent local Practice" | the signed-out branch offers Practice rather than navigating on its own |

**The part that needed real design.** The same specification excludes "modes
where answer was shown before choice" from the qualified accuracy board, and
`solo` is on that board — so Learn and the accuracy leaderboard cannot both be
right unless the SERVER knows which assistance a session is running. It does
now: `game_sessions.assistance` (`20260823140000`), chosen once at OPEN and
never revisable, because a client that could name its assistance per decision
could opt a mistake out of its own accuracy and opt a good one in.

That column decides two things:
- whether `countsTowardsAccuracy` counts the session's decisions, and
- whether the server ATTACHES the recommendation to the snapshot at all.

The advice is computed server-side by `adviceFor`, using the same advisor that
grades the decision, from the same authoritative state, reading only the seat's
own cards and the dealer's UP card. A client that rebuilt advice locally would
be a second implementation of the chart. It rides on the response, not the
broadcast: only a one-seat table can carry it today, but "what one player asked
to be told" is not a property of a table.

**Evidence.** `tests/server/quick-play.integration.test.ts`, 6 tests against the
live stack:

- an unassisted table debits once and carries **no** advice;
- a Learn table carries the recommendation, addressed to that seat, naming an
  action that is actually legal, and **no** EV numbers;
- an Analysis table prices every legal action in integer millionths, and the
  recommendation is among them;
- a Learn table's decision does **not** move `player_decision_periods`;
- an unassisted table's decision **does** — so the exclusion is not blanket;
- an assistance mode outside the four is a 400.

Plus 10 unit tests on the remembered selection (a stored tier that is not a real
tier is dropped, never repaired — repairing it would guess with somebody's
money) and 6 on the eligibility predicate.

```
npm test                  84 files, 1593 tests passed
supabase test db          444 assertions, PASS
npm run check:functions   clean
npx expo export           6 MB Hermes bundle, every import resolves
tsc --noEmit / lint       exit 0 / 0 errors
```

---

### R7 — Three screens asserting things about the player that were not true · **VERIFIED COMPLETE**

**Severity:** major. Two MVP surfaces and one privacy defect.

**Statistics told every signed-in player their competition record required an
account.** `app/stats/index.tsx:94` read
`competitionState({ hasAccount: false, online: false })` — both values written
as **literals**. Nothing anywhere fetched a record either, so fixing the flag
alone would have left the section loading for ever.

`public.my_competition_record()` (`20260823160000`) returns five numbers about
the caller, derived from `auth.uid()`: tournaments entered, wins, best finish,
daily challenges played, best daily rank. The rank uses
`leaderboard_daily_challenge`'s own ordering, tie-breaks included, so "your best
rank" and the board a player can open cannot disagree. No identifier and nothing
about any other player, which is the projection discipline the leaderboards keep.

**Profile rendered the player's EMAIL ADDRESS as their display name**
(`app/profile/index.tsx:91`, `displayName: session?.account.email`) — the
largest type on the screen, in a screenshot anybody might share.
`public.profiles` carries a server-normalised `display_name` and `username`, and
the specification's hierarchy is "Avatar / Display name / @username". All three
are now read through `useAccountProfileStore`, scoped to `id = <you>`.

Also added, from the same spec list: **tournament wins** (null, not zero, until
the server has answered) and a **Friends** button — pointed at `/(tabs)/social`,
because there is no `/friends` route and the route contract forbids a dead link.

**Home advertised career node one to everybody.** `CAREER_NODES[0]`, a literal,
so a player who had finished Foundations was offered "First Deal". It names the
next unfinished node now — merged from the local and server records, so neither
can drag the other back — with its chapter, its star count and a Continue
button, which are the four things the specification asks a progression card to
carry.

Home also gained the compact tiles the spec names (Daily Challenge, Tournament,
Friends, Leaderboards), a **Quick Play primary card** for a signed-in player
that resumes the last setup in one tap, and — the offline rule — Practice as the
primary card when there is no account, because "Quick Play online CTA becomes
Practice" rather than explaining itself. The "you need an account" note is now
shown only to somebody it applies to; it was unconditional, on a screen already
displaying the player's balance.

**Evidence.** 9 new unit tests pinning the boundaries that decide whether a name
or a number appears at all — including that no email can reach either identity
line, and that `tournamentWins` is null rather than 0 before the server has
answered.

```
npm test                85 files, 1604 tests passed
supabase test db        444 assertions, PASS
npx expo export         every import resolves
tsc --noEmit / lint     exit 0 / 0 errors
```

---

### R8 — A table could be swiped away from, and the app had no idea when it was offline · **VERIFIED COMPLETE**

**Severity:** major (one economic, one MVP UX requirement).

**The swipe.** Leaving a table is an economic command — `CASH_OUT` returns the
remaining stack — and the "Leave table" control has sent it since phase 14,
refusing to navigate on a refusal. But `app/_layout.tsx` set
`headerShown: false` and nothing else, and **`gestureEnabled` defaults to true
on an iOS native stack**: a swipe popped the screen without ever reaching that
control, leaving the buy-in in escrow, the seat `active` and the wallet short —
the exact defect the control was written to close, still reachable by a gesture.

Two removals were open besides the gesture (the Android hardware back button and
a deep link resetting the stack), so the fix is both halves:
`TABLE_SCREEN_OPTIONS.gestureEnabled = false`, and a `beforeRemove` listener
that cancels the removal, sends the cash-out, and replays the navigation only if
the server agreed. `src/features/table/leave-guard.ts` holds both as plain
values so `tests/table/leave-guard.test.ts` can assert them — a comment saying
"do not remove this option" is a comment; a failing test is a guard.

Mid-hand needs no confirmation dialog: the server refuses with `SESSION_BUSY`
and the client shows "This hand is still live. Your chips come back as soon as
it settles." A refusal with a reason is stronger than a dialog.

**The offline signal.** There was none — no `expo-network`, no NetInfo, nothing
— so every offline state the specification asks for ("Quick Play online CTA
becomes Practice", "Career reward attempts disabled but Practice node offline
available", "Social/leaderboard cards show offline state") had nothing to drive
it.

Deliberately **not** a radio-state library. Both answer "is there a network
interface", which is the wrong question: a phone on a captive-portal wifi has
one and cannot reach Arc 21, so the banner would say the opposite of the truth
exactly when it matters — for a native module and a prebuild. What ships instead
measures whether the SERVER answered, reported from `withTimeout`, which every
remote call in the app already passes through. A refusal is an answer: a 403, a
409 or a rate limit is the server being reachable, and only a timeout or a
transport failure counts against it. Offline after two consecutive failures,
back after one success.

**A harness defect found on the way, and it explains earlier "flakes".**
PostgREST answers `PGRST303 "JWT issued at future"` when a token's `iat` is
ahead of the DATABASE CONTAINER's clock, and host/container drift under load
makes `iat: now` a coin flip. It surfaced as a wallet reading -1, a profile
column reading null, and a career reward that looked unpaid. All eight server
test files now backdate by 60 seconds — and `career.integration.test.ts`'s
`balanceOf` now THROWS instead of returning `-1`, because a helper that
substitutes a sentinel turns a harness error into a false product defect.

```
npm test                       87 files, 1618 tests passed
npm run test:server            9 files, 77 tests passed — green twice while
                               `npm run test:unit` ran concurrently
tsc --noEmit / lint            exit 0 / 0 errors
```

---

### R9 — Guest conversion, and the host's power to remove a lobby member · **PARTIAL — server done, lobby UI outstanding**

**Guest→account conversion · VERIFIED COMPLETE.** `buildGuestConversionPlan` and
`describeConversion` had **no caller**: the rules were written, typed three ways
so breaking them requires breaking all three, and covered by twenty tests — and
no screen had ever shown them to a player. `app/(auth)/create-account.tsx` now
renders "What carries over" ABOVE the form, so the specification's two
prohibitions ("do NOT create server wallet winnings from guest results", "do NOT
import guest competitive achievements") are read before an email is typed rather
than discovered afterwards as a loss.

**Host can remove a lobby member · SERVER DONE, CLIENT OUTSTANDING.**
`room_member_status` has carried a `kicked` label since the rooms migration and
nothing ever set it — there was no function to remove anybody, so the
specification's rule held only because the capability was absent.
`public.remove_room_member` (`20260823170000`) is host-only, lobby-only, refuses
once a `game_session_id` exists (the seats hold chips by then and the server owns
the game), and refuses to remove the host (that is `leave_room`, which migrates
the role). Six pgTAP assertions in `14_rooms.test.sql`.

**It has no client caller yet, and that is the exact pattern this mission keeps
closing.** Do not count it as done. Still outstanding on the lobby, all three
from the specification's own list — "room code, copy/share, host, seat list,
ready states, invite friends, start, leave":

- **copy/share** — RN's `Share.share` needs no new dependency;
- **ready states** — `set_room_ready` and `get_room_state.member_is_ready`
  already exist and are client-granted; only the UI is missing;
- **host-remove** — the function above.

### R10 — The private lobby: three controls with no client, and two defects underneath · **IN PROGRESS**

**The specification's list for this screen** is one sentence — "Lobby shows: room
code, copy/share, host, seat list, ready states, invite friends, start, leave" —
plus "Host can remove a member only while in lobby" and, on the creation screen,
"MVP fields: max players 2–5" and "Loading/reconnect must preserve room code".
Four of those were missing and two of the four were missing in the way this
mission keeps finding: the server half existed, tested, with no caller.

**Two defects found by reading the server halves before wiring them, both
reproduced against the running stack by client-reachable RPCs only.**

**(a) A removed player walked straight back in.** `remove_room_member` shipped
last commit with six pgTAP assertions, all passing, and removed nobody:
`join_private_room` ends in `on conflict (room_id, user_id) do update set status
= 'joined'`, so the removed player typed the same six characters and was seated
again. pgTAP proved the row said `kicked`; nothing proved it STAYED kicked, which
is the only thing a host removing somebody is asking for.

**(b) A vacated seat could not be refilled — and this one predates the kick
feature entirely.** `leave_room` keeps the member row AND its `seat_index`;
`join_private_room` allocates "the lowest seat no JOINED member holds", the right
rule; and the table carried `unique (room_id, seat_index)` across every row
whatever its status. So the most ordinary sequence a private table has:

```
A joins:  200
A leaves: 204
B joins:  409 {"code":"23505","details":"Key (room_id, seat_index)=(…, 1) already exists.",
               "message":"duplicate key value violates unique constraint
                          \"room_members_room_id_seat_index_key\""}
```

A table refused a join for as long as anybody had ever left it, at a table with a
seat visibly free. Nothing covered it: every room test until now filled a room
and stopped.

**Fix — `20260823180000_room_seats_and_removal.sql`.** The whole-table constraint
becomes a PARTIAL unique index over `status = 'joined'`, which is the same
predicate the allocator uses (the migration says so, and says to change both
together). `join_private_room` — redefined from `20260818100000_rate_limits.sql`,
the LAST definition, so the rate-limit charge and the returns-no-row refusal
contract survive — refuses a `kicked` member, and re-seats a returning player
with `seat_index = excluded.seat_index` rather than their stale number.

The kicked refusal is byte-identical to the answer for a code that never existed,
asserted as such: a removed player's code going quiet is the one refusal that
would otherwise tell a code-guesser their six characters had hit a live room.

**Client half — the four missing pieces.**

- **ready states**: `setReady` on the gateway, `setReady` on the store, a toggle
  and a per-seat indicator on the screen. Re-read from the server rather than
  patched locally, so every client renders the same row.
- **host-remove**: `removeMember` through the gateway; the button appears only
  where `canRemoveMember` allows it. `removed: false` is not an error — it is
  the server's single answer to every refusal it declines to explain.
- **copy/share**: RN `Share.share`, no new dependency; the sheet's own Copy is
  the "copy" half. The message carries the CODE, with the deep link second,
  because a link that dead-ends for somebody without the app is worse than six
  characters anybody can type.
- **max players 2–5**: a seat chooser on the create card, replacing a hardcoded
  `createRoom(5)`.

**And a fifth, found while wiring: the lobby could not be returned to.**
`findOpenRoom` + `restore()` put a player back at the table they are already at.
Before it, a host who force-quit was STUCK — the lobby came back empty and
`create_private_room` refuses a second live room, so the only way out was to wait
thirty minutes for the first to expire. It is a plain select: `rooms_select_member`
already restricts the table to the caller's own rooms, so the policy IS the
lookup. The filter is exported as one string and the integration test sends THAT
string, so a change to the app's query changes the test's subject. `now()` is
evaluated by Postgres, not by the device — an active table keeps its lobby TTL
in `expires_at` and filtering on it would strand every game that outlived its
lobby, so only a LOBBY is expiry-checked.

**Evidence.**

```
tests/server/private-rooms.integration.test.ts   16 tests — 4 failed before the
                                                 migration, all pass after
supabase test db                                 452 assertions, PASS  (was 450)
tests/rooms/                                     30 tests (was 8)
npx tsc --noEmit / npm run lint                  exit 0 / 0 errors
```

Both new gates were proved to discriminate rather than assumed to work: deleting
the `gameSessionId` check from `canRemoveMember` fails exactly one affordance
test, and widening `OPEN_ROOM_FILTER` to include every lobby fails exactly the
expiry test.

**Outstanding on this row:** the end-to-end run. `tests/e2e/private-lobby.yaml`
is written — the first Maestro flow in this repository that signs in and walks a
SERVER-configured build — and needs a debug build to run against.

### R11 — the Daily Challenge intermittent, RESOLVED with its cause named

`game-command.integration.test.ts > the daily challenge > deals two different
accounts the identical shoe` had failed once in a full `npm test` on

```
expected [ 18 items ] to deeply equal [ 20 items ]
```

— a hand-COUNT mismatch, with every visible card agreeing. That reads as a
defect in the deterministic shoe, which is the single most important claim the
whole mode rests on. It was not a card defect, and it was not in the product.

**The cause, from the runtime's own log** (`docker logs
supabase_edge_runtime_arc21`), in this order:

```
CPU time soft limit reached: isolate: 01add706-…
user worker failed to respond: request cannot be handled because the worker
  has already retired
{"message":"command handled", … "commandType":"LOCK_BET", …
  "outcome":"accepted","stateVersion":14}
WorkerAlreadyRetired: request cannot be handled because the worker has already
  retired
```

Read the order. The Edge runtime retires a user worker when its isolate trips
the CPU soft limit; a request already in flight is then answered by a worker
that is gone — and the `command handled … accepted` line lands BETWEEN the
retirement and the error. **The command committed. Only the reply was lost.**
Seventeen of these had accumulated in the container's log, five adjacent to an
accepted command, twice for `NEXT_HAND` — which is exactly the shape of an
attempt that stops two hands short with every card it did record agreeing.

**Why it presented as a card mismatch.** `playOut` discarded every command's
outcome and carried one line, `if (next.status !== 200) break`, which treated
ANY non-200 on `NEXT_HAND` as the ordinary way a finished session says so. It is
not: a finished attempt answers **200** with a `SESSION_COMPLETE` snapshot from
`closeCompetition`. So a lost reply silently truncated the run, the short array
reached `expect(playedA.dealt).toEqual(playedB.dealt)`, and the caller's own
`expect(state.phase).toBe("SESSION_COMPLETE")` — which would have named the
problem — sat on the line AFTER the comparison and never ran.

**The fix, in two parts.**

1. `tests/server/call-function.ts`, the one Edge-Function caller for every
   server suite, replays a 5xx or a thrown fetch with a **byte-identical body**.
   That is what `src/features/table/online-table-gateway.ts` already does with a
   real player's command — a reply it cannot read is `unreachable`, and it
   retries presenting THE SAME `clientActionId`, so `findAppliedCommand` returns
   the first committed result. The test was less robust than the app it tests.
   `JSON.stringify` runs once, outside the loop, because a retry that mints a
   fresh key is not a retry but a second command.
2. `playOut` cannot return a truncated attempt. Every command must be accepted;
   a `stale` verdict counts as a refusal even though it is HTTP 200, because one
   seat playing sequentially cannot race itself; and the helper asserts
   `SESSION_COMPLETE` before handing the array back, so any future truncation
   names itself instead of arriving as a card comparison.

**It cannot hide a real failure.** A 4xx is the server's verdict and is never
retried. A 5xx that persists is returned with its body on the last attempt. A
fetch that keeps throwing raises. And every absorption is announced on stderr —
written with `process.stderr.write`, not `console.warn`, because Vitest 4
defaults to `silent: "passed-only"` and discards console output from a test that
PASSES, which is precisely the run the warning exists for. Measured with a probe
emitting both, not assumed.

**Reproduced deliberately**, per the repository's own rule about flakes: 14
background busy loops driving the host to load 40–94, `tests/server` at full
file parallelism. Three consecutive passes, 100/100 each, with genuine
`WorkerAlreadyRetired` 500s absorbed and logged — the container's retirement
counter moved 19 → 21 across them. Five further daily-challenge-only passes
under load 41–45, all green.

**Two regression tests.**

- `tests/server/call-function.test.ts` (6 tests, needs no stack) drives the
  caller against a stub that answers exactly what the runtime was observed to
  answer. It asserts the retry returns the answer that arrives, that the replayed
  body and `Authorization` header are byte-identical so the idempotency key
  survives, that a 401/403/409/422/429 is never retried, that a persistent 5xx
  comes back with its body, that a dead port raises, and that the diagnostic is
  emitted. Against the old inline caller the first of those fails.
- `deals … > replays the attempt's final command instead of paying a second
  reward` asserts the server property the retry depends on, for the command that
  actually lost its reply. The last `NEXT_HAND` of a challenge never reaches
  `applyCommand`: `closeCompetition` writes the completion, marks the seat
  `left`, marks the session `completed` and PAYS THE REWARD, and records its own
  idempotency row on a different code path from every other command. Its replay
  must survive both closures — which is why `findAppliedCommand` runs ahead of
  the session-closed check. Same body, same response object, same wallet, one
  entry row; and a DIFFERENT action id on the same finished session is refused,
  so the replay is a replay and not an open door.

**And the same latent flake was removed from the four suites that still had it.**
`rejection-contract` and `notifications` carried their own inline `fetch` callers
— including the two calls in the timeout-notification test, which asserts `200`
after a sixteen-second sleep and is therefore the most exposed request in the
repository. Both now use the shared caller. `password-recovery` carried a
`FUNCTIONS` constant it never used; it is gone.

```
tests/server/call-function.test.ts      6 tests, no stack required
npm run test:server                    11 files / 100 tests PASS
npm test                               1,564 unit + 100 server = 1,664 PASS
8 server passes under deliberate load  green, absorptions logged
tsc --noEmit / lint                    exit 0 / 0 errors
```

**Clock skew, fixed properly this time.** Backdating `iat` by 60 s was not
enough — the Docker VM clock JUMPS rather than drifts, so any constant is a
guess about how far. The test tokens now carry **no `iat` at all**: it is an
optional claim PostgREST validates only when present, nothing in the app reads
it, and `exp` still bounds the token. That removes the failure mode instead of
narrowing it.

```
npm run test:server     9 files, 77 tests passed
npm test                87 files, 1617 of 1618 (the intermittent above)
supabase test db        450 assertions, PASS
tsc --noEmit / lint     exit 0 / 0 errors
npm run check:functions clean
```

---

## R12 — the friend profile showed four of nine things, and three screens said something untrue

### The friend profile

The specification's FRIEND PROFILE list is nine items — avatar, display name,
username, level, presence, public stats according to privacy setting, career
stars, tournament wins, Invite to Table — plus Remove Friend and Block. The
screen rendered the first four and a last-seen line, and its closing paragraph
still said friends could be invited to a private table "when private tables are
built", which had been false for two phases.

**There was no source for the rest, and that is why it stayed unfinished.**
`my_competition_record` and `my_career_progress` both derive from `auth.uid()`
and correctly answer only about the caller. `player_public_profile(uuid)` is the
read that was missing; the migration for it existed and **had no client caller
at all** — the twelfth instance of the built-but-never-connected pattern.

**What decides what is shown.** Settings says the privacy choice "controls who
can see your profile and standings", so standings — hands, accuracy, career
stars, tournament wins — are ALL governed by `profiles.privacy`, not only the
ones the word "stats" obviously covers. There is one visibility answer, and the
SERVER gives it: `stats_visible` arrives already decided and the client never
recomputes it from `privacy` and `is_friend`. A second implementation of a
privacy rule is a rule that will eventually disagree with the first, and the
client's copy is the one a player sees.

**NULL, not zero.** Every number is NULL when the record is not visible, and
`null` survives into `PlayerProfile`, so the screen can tell three different
things apart: a hidden record, a record that is genuinely empty, and a read that
did not happen. Each gets its own sentence. A `coalesce` written one line too
early would have turned the first into the second.

**A block returns no row at all** — in either direction, identical to a user id
that never existed. Not an empty profile: a block must not be discoverable by
the person blocked.

**Presence** comes from the Realtime channel and nothing else, per the
specification's "presence is ephemeral Realtime state where possible; persist
only `last_seen_at` for fallback". Absence from the channel is NOT proof of
being offline — a backgrounded app looks the same — so `offline` is reported
with the last-seen line and a sentence saying the app cannot tell a signed-out
player from one on a bad connection. The profile joins the channel itself only
when nobody else holds it, which is the deep-link case (`arc21://friends/<id>`
arrives with Social never mounted).

**Invite to Table** is offered only when it could be accepted. Every branch of
`inviteAffordance` mirrors a check inside `public.invite_friend_to_room`, except
two that do not — inviting somebody to a table they are sitting at, and inviting
them into a table with no free seat. The server accepts both; a player can use
neither. When there is no table at all the button becomes the way to open one,
rather than a dead control with an explanation.

### Three screens that said something untrue

- **`largeCardLabels` governed nothing.** Stored since phase 8, read by no
  screen, with an `UnavailableNote` under it admitting so. It now scales the
  rank and the corner glyph — and the centre glyph SHRINKS to make room, because
  growing all three collides at the compact card size, where the default layout
  has only ~3pt between the corner block and the centre glyph. The two constants
  were chosen together so the enlarged layout has EXACTLY the clearance the
  default one has, at every card size, and `tests/design/card-label-metrics.test.ts`
  asserts that equality rather than a number somebody typed. It also asserts
  that raising the scale alone would collide — so the trade is proved, not
  described. The card face does not follow Dynamic Type on purpose: it is fixed
  geometry, and text that outgrows it truncates a rank rather than reflowing.
- **The Statistics Career filter claimed server-only for local data.** It read
  "Career progress is recorded on the server and needs an account" and showed
  nothing — false twice over. Career stars are written to THIS DEVICE by
  `career-persistence.ts`, and the map, the node detail and Home have always
  read them with no account. What needs a server is the REWARD:
  `rewardClaimed` can only be set by one. The filter now shows the local record
  — stars, nodes completed, attempts, best accuracy — and says what an account
  changes only when something is actually owed, as a COUNT of nodes. "You have
  three rewards waiting" is actionable; "sign in for rewards" is an advert.
  A screen that says a shipped feature is absent is the same class of defect as
  one that says an absent feature has shipped.
- **The Play tab's availability badge was inverted.** The word came from
  `mode.availability` and the colour from `playable` — "is there a route yet".
  Those agreed only while the online modes were unbuilt. Every mode is reachable
  now, so all four ONLINE cards rendered their badge in the green this app
  reserves for "needs no server at all", on the screen whose entire job is
  saying which modes need one. Word and colour come from the same field now.
  The same change revived six sentences of dead copy: `reason` rendered only
  when a mode was NOT playable, so the moment every mode became reachable, what
  each online mode needs was shown to nobody — and a guest learned an account
  was wanted only after tapping.

**Evidence.**

```
tests/friends/player-profile.test.ts          15 tests
tests/server/profile-privacy.integration     10 tests (was 4) — the privacy
                                              rules proved with two real JWTs
tests/rooms/lobby-affordance.test.ts          21 tests (was 15)
tests/design/card-label-metrics.test.ts        8 tests
tests/stats/career-record.test.ts              9 tests
tests/home/play-mode-presentation.test.ts      9 tests
npm run test:unit                             83 files / 1,608 tests PASS
tsc --noEmit / lint                           exit 0 / 0 errors
```

The server suite is the part that matters most here, because
`player_public_profile` returns one player's record TO ANOTHER PLAYER — the most
disclosure-shaped read in this schema. Public, friends-only-with-a-friendship,
friends-only-without, private, a block in both directions, a nonexistent id, and
an unauthenticated caller are each asserted against the running database.
