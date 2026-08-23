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

