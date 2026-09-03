# Phase 11 — Adversarial QA, E2E, CI, Runtime QA

**Result: PASS.** Eight defects fixed, each proved to fail by reverting it in the
running system. One advisory investigated and found NOT reachable — the guard
written for it was deleted rather than shipped, and replaced by a test that pins
the reason. The two-simulator public-table lifecycle that phase 7 deferred was
walked end to end on two devices with the server asked at every step. **CI ran on
a real runner for the first time in this project's life and failed both jobs** —
one of them because every function in `public` shipped executable by `anon` on
any database whose migrations are applied by the role a current CLI uses.

---

## What this phase was for

Phases 1–10 built and hardened. This one attacks: replay, races, a modified
client, Realtime, rate limits, local tampering, deep links, notifications,
dependencies, and then walks the product on real devices and asks whether the
CI that is supposed to guard all of it has ever actually run.

The rule throughout was the project's own: **a failure is work, not a report
entry.** Every finding below was reproduced, fixed at the root, given a
regression that was proved to fail without the fix, and re-verified.

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

**Both jobs failed on the first run, and both failures were real.** Everything
was green locally; neither of these could be seen on this machine at all. This
is the whole reason the brief said not to call CI complete because a YAML file
exists.

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

---

## Gates

| gate | result |
|---|---|
| `npx tsc --noEmit` | 0 errors |
| `npm run lint` | 0 errors, 37 warnings (unchanged baseline) |
| `npm run check:functions` | all three functions typecheck |
| `npm run test:unit` | **122 files, 2,395 tests, all pass** |
| `supabase db reset` + `supabase test db` | **26 files, 560 assertions, all pass, from empty** |
| `npm run test:server` | **23 files, 300 tests, all pass** (fresh `functions serve`, load 3.6) |
| `npm run benchmark` | 795 µs/hand at load 4.4 — inside the recorded 752–808 range; heap delta +10 KB over 50 hands |
| Maestro | practice ×3, career-node, online-table, every-screen ×2, online-leave-mid-hand, two-client-public ×5 |

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
