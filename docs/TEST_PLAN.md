# Arc 21 — Test Plan

## Philosophy

The engine and the money primitives are the integrity core, so they carry the
highest coverage bar. Determinism is non-negotiable: card behaviour is verified
with seeded sources and preordered shoes, never with statistical assertions.

> A "the shuffle looks random" test with a loose tolerance passes on a broken
> implementation and fails at random on a correct one. Permutation integrity and
> RNG plumbing are tested instead — including an explicit assertion that biased
> values in the modulo tail are *rejected* rather than folded in.

## Targets

| Area | Target | Current |
|------|--------|---------|
| Engine, strategy, money primitives | ≥ 90% statements **and** branches | 97.23% / 92.73% |
| Core application logic | ≥ 75% meaningful | Practice store covered; UI components pending |

Coverage thresholds are enforced in `vitest.config.mts`; the suite fails below
them. Percentage is never chased by testing generated constants — state branches
matter far more than line counts.

## Commands

```bash
npm test              # full suite
npm run test:coverage # with coverage and thresholds
npm run typecheck     # tsc --noEmit
```

---

## Status

**1,060 JavaScript tests across 48 files, 237 pgTAP assertions across 15 SQL files,
and 4 Maestro flows on a real simulator. Typecheck clean.**

```bash
npm test                                  # 1060 passing
supabase test db                          # 237 passing
maestro test tests/e2e/practice-hand.yaml # a hand, on device
maestro test tests/e2e/career-node.yaml   # a career node to its stars
maestro test tests/e2e/every-screen.yaml  # all 14 destinations render
```

### What each layer can and cannot prove

Recorded because this project has already been bitten by the difference: the
server command layer typechecked and had a passing suite for an entire working
session while **every command it served returned 500**.

| Layer | Proves | Cannot prove |
|-------|--------|--------------|
| `tsc --noEmit` | The types line up | That anything runs |
| `tests/engine`, `tests/strategy` | Rules and maths are right | That a player can reach them |
| `tests/features` | Stores behave under real sequences | That a screen renders |
| `tests/server` | The live function answers correctly | Anything, when it silently skips |
| `supabase test db` | Authorization holds in the database | That the app uses those paths |
| `tests/e2e` | The real app on a real device | Anything about the server |

A green suite is necessary and not sufficient. Claims in status documents are
graded by **how** they were verified — see [AUDIT.md](./AUDIT.md).

| Suite | File | Covers |
|-------|------|--------|
| Hand evaluation | `tests/engine/hand-value.test.ts` | Ace normalisation, naturals, split-hand 21 |
| Shoe and RNG | `tests/engine/shoe-and-rng.test.ts` | Permutation integrity, bias rejection, penetration, reserve, exhaustion |
| Reducer | `tests/engine/reducer.test.ts` | Full gameplay matrix over deterministic shoes |
| Settlement | `tests/engine/settlement.test.ts` | Payout math, integrality, even-money identity |
| Public state | `tests/engine/public-state.test.ts` | Hole card and future-shoe leak guards |
| Rules and helpers | `tests/engine/rules-and-helpers.test.ts` | Ruleset validation, bet bounds, accessibility labels |
| Edge cases | `tests/engine/edge-cases.test.ts` | Exhaustion, reshuffle, leaving, lifecycle |
| Rule variants | `tests/engine/rule-variants.test.ts` | H17, European, split-ace and insurance variants |

### Engine matrix — implemented

Ace handling: A+6 soft 17 · A+A+9 = 21 · A+A+9+10 = 21 · multi-ace downgrade ·
hard 17 · soft 17 · soft 18 · bust transitions.

Naturals: A+K · A+10 · three-card 21 is not natural · split-ace 21 is not natural
· split-hand 21 is not natural · natural vs natural pushes · dealer natural beats
non-natural 21.

Outcomes: ordinary win · loss · push · dealer bust · player bust · 3:2 · 1:1 ·
push return · surrender half return.

Insurance: offered only vs ace · exactly half the wager · pays 2:1 · lost
otherwise · even money nets +1× on both branches · double-answer rejected ·
unaffordable insurance refused · insurance disabled.

Double: legality · debit · exactly one card · forced stand · bust · win · illegal
after hit · illegal without stack · DAS on and off.

Split: creation · wager debit · ten-value cross-rank split · `same_rank` policy ·
resplit to the four-hand cap · left-to-right resolution · split-ace one-card rule
· no hit/double/resplit on split aces · optional hit/resplit ace variants ·
split-ace 21 as ordinary 21 (and as natural when configured).

Surrender: late surrender on the initial hand · unavailable after a hit ·
unavailable on split hands · unavailable before the peek · disabled by ruleset.

Dealer: S17 stands on soft 17 · H17 hits · hits hard 16 · draws through aces ·
busts · peek on ace · peek on ten · does not draw when only naturals remain ·
does not draw when all hands busted · reveals before drawing.

Shoe: six unique physical copies per rank/suit · permutation integrity with no
missing cards · deterministic seeded shuffles · preordered fixtures · penetration
cut · safety reserve as an independent trigger · cut card binds before the
reserve · no mid-hand reshuffle · exhaustion aborts without fabricating a card ·
reshuffle refused without a random source.

State machine: every phase transition · invalid phase/action combinations ·
rejected commands leave state untouched · version increments once per command ·
multi-seat dealing order and sequential turns · timeouts for betting, insurance
and player actions · leaving mid-hand cannot escape a wager.

Public state: no undealt card serialised · hole card placeholder before reveal ·
face-up-only dealer total · leak detection for both hole card and shoe order.

---

## Implemented since the engine phase

### Strategy suite — `tests/strategy/` (128 tests, 6 files)
Every hard total, soft total and pair against dealer 2–A under Arc Standard;
double and surrender fallbacks; a completeness assertion that every reachable
normalized state has an entry; ruleset mismatch fails safe; missing data returns
null rather than a guess; monotonicity sanity; and cross-validation of all 360
published cells.

Strategy tables are **generated** by `scripts/generate-strategy-tables.ts` — a
six-deck EV solver with exact card removal — and never hand-typed. The
generator's own dealer distributions are checked against published figures, and
the chart it produces returns a −0.3345% expectation, consistent with published
analyses of this rule set. Disagreements with the published chart are reported
in `docs/STRATEGY_VALIDATION.md`, never silently reconciled.

### Practice store — `tests/features/practice-store.test.ts` (15 tests)
Bet staging, clearing and repeating; deal on lock; bankroll reset; illegal
commands surfacing as UI state rather than throwing. Its centrepiece is a
150-hand randomised fuzz asserting after every hand that the bankroll equals the
starting chips plus the sum of settled outcomes **exactly** — chips are never
created, destroyed, or drifted by rounding — and that the shuffle number cannot
change mid-hand.

### Database authorization — `supabase/tests/` (237 pgTAP assertions, 15 files)
Private engine state unreachable by any client role; no client write path to
wallets or the ledger; `level`/`xp` not client-writable; cross-account reads
blocked; balance cannot go negative; seed catalogue correct.

Assertions are scoped to each file's own fixtures rather than to global row
counts, so the suite passes against a database that already contains data —
verified by running it against a deliberately dirtied database, twice.

---

## Written since — server and client

### Contract suite — `tests/contracts/` (19 tests)
The wire schema rejects a non-uuid `clientActionId`, a negative/fractional/NaN
amount, an unknown command type, an unknown top-level field, and a bet amount
smuggled onto a payload-free command. It also pins the overflow headroom:
`MAX_CHIP_AMOUNT * 4 < Number.MAX_SAFE_INTEGER`, so a doubled-and-settled wager
cannot overflow.

### Server integration — `tests/server/` (19 tests, against the live function)
The full auth matrix (forged, expired, `alg:none`, anon-role, wrong audience,
non-uuid subject), replay idempotency for both commands and session opens, stale
version returning the authoritative snapshot without applying, cross-account
rejection, and no hidden state in any response body.

**These skip when the stack is not reachable, and a skip is not a pass.** The
guard requires a 401 from the function itself: with the Edge runtime stopped the
API gateway still answers 503, and an "any response" check reported the stack as
up while nine tests failed instead of skipping.

### Auth and wallet — `tests/auth/`, `tests/wallet/`
The auth state machine over every transition, guest conversion never fabricating
chips, recovery-grant eligibility at the exact boundaries, and missing Supabase
configuration degrading to a stated state rather than throwing.

---

## Not yet written (blocked on later phases)

### Economy suite — partially covered
Buy-in debit, cash-out credit and idempotent replay are covered in
`tests/server/`, as are **private tables cannot move global chips** (both at
seating and, after a live mint was found, on the way out), **the daily challenge
risks no global chips**, and **tournament entry and prize**. Still open: recovery
grant cooldown end-to-end.

### Multiplayer suite — partially written
Written: room create/join/full/leave, host migration, code normalisation and the
unambiguous alphabet (`supabase/tests/14_rooms.test.sql`), plus two integration
tests proving a two-seat table deals from one shoe with **no wallet movement**.

Still open: simultaneous betting · dealing
order · sequential actions · split actions · insurance responses · timeout ·
disconnect and reconnect · seat reclaim · duplicate Realtime event · stale
version · two devices submitting the same action · racing commands · wrong-actor
rejection · impossible-action rejection · room cleanup · stack reconciliation.

### Tournament suite — **written**
`tests/tournament/tournament-format.test.ts` (40 assertions) covers the format
against the specification, both bet ceilings at their exact boundary, button
rotation including the negative-offset case, bankruptcy versus the ranked
elimination, ties of two and three, the fifth tie-break hand versus the sixth,
placement ordering (a survivor always finishes above an eliminated player with
more chips), pooled-and-floored prizes for a shared placement, and the invariant
that a payout never exceeds the schedule.

`tests/server/game-command.integration.test.ts` plays a whole four-player
tournament through the real functions: entry debited once per player and not again
on a retry with a fresh request id, four equal stacks, twelve scheduled hands, the
ceiling changing, the button moving every hand, exactly one elimination after hand
six, placements assigned to all four, prizes never exceeding the schedule, and the
wallet arithmetic reconciling to fees-out minus prizes-in.

`supabase/tests/16_sprint_and_daily.test.sql` holds `sprint_format()` to the
specification field by field, so the client's format, the server's enforcement and
`SPRINT` in `tournament-format.ts` cannot drift apart.

Still open: sequential betting asserted as *visible* to other seats (the data is
sent; no test yet reads one seat's staged bet from another's snapshot), and hints
disabled in ranked play asserted on device.

### Daily challenge suite — **written**
`tests/daily/daily-challenge.test.ts` (24 assertions) covers same-seed-same-shoe
at both the raw-stream and the dealt-shoe level, independence from read batch
size, divergence on a one-character seed change, that the stream is genuinely
HMAC-SHA-256 over a big-endian counter (recomputed independently), commitment
verification, that the commitment covers the date, the score being the ending
bankroll with no speed term, and the one-ranked-attempt rule including after an
abandoned attempt.

`tests/server/…` proves the claim that matters end to end: two different accounts
dealt the identical twenty-hand sequence, the seed absent from every response, the
session stopping at hand 20, the reward paid exactly once, and a replay reporting
`ranked: false` while leaving the ranked row untouched.

`supabase/tests/05_daily_challenge.test.sql` and `16_sprint_and_daily.test.sql`
cover seed secrecy at the privilege layer, commitment verification on write, the
refusal to reveal early, and today's challenge being created on demand exactly
once.

Deterministic leaderboard ordering is now covered — the daily board orders by
score, then `completed_at`, then a stable key. Still open: the accuracy and
EV-lost tie-breaks above those, which need a daily ENTRY to record its own
accuracy. Server-side decision grading now exists (below), so this is no longer
blocked, only unbuilt; recorded in `docs/AUDIT.md` as ABSENT rather than
approximated.

### Leaderboards and cosmetics suite — **written**
`tests/features/leaderboards-and-cosmetics.test.ts` (28 assertions) covers
reading a board, dropping an unreadable row rather than half-rendering it,
formatting each board's value in the units it is actually in — accuracy arrives in
basis points, so 8,734 is 87.34% — the four categories being the specification's
four with global bankroll absent, every board explaining why it is empty, and a
locked cosmetic never showing anything that reads as a price.

`tests/progression/decision-grading.test.ts` (13 assertions) covers eligibility as
an allowlist, the exclusions the specification names, and the four cases that are
deliberately not counted: an excluded mode, a server-applied timeout default, an
absent seat, and a hand the chart has no cell for. It also asserts the diagnostic
never names the recommended action, which would be a hint leaking through the logs.

`tests/progression/level-curve.test.ts` (7 assertions) recomputes the database's
level curve independently and asserts it against the engine's at every level,
including the level-10 gate and the honest answer at the cap.

`supabase/tests/17_leaderboards_and_cosmetics.test.sql` (34 assertions) holds the
public-safe row type, the week boundary, the privilege boundary on every
server-only function, the derived level, and the structural claim that no gameplay
or economy table references a cosmetic.

`tests/server/` plays real hands and asserts the decisions land, that an unranked
private table contributes none, that a board agrees with "my position", and that
equipping an unowned cosmetic is refused.

### RLS and authorization suite — **written**
`supabase/tests/` proves a client cannot read `game_state_private`, write wallets
or ledger entries, mutate `level`/`xp`, or read another user's private stats.
Exploits were additionally attempted against the live database, which is how a
`SECURITY DEFINER` RPC oracle over the entire social graph was found and closed.

### E2E flows (Maestro) — partially written

Written and passing on an iPhone 17 Pro simulator:

| Flow | Covers |
|------|--------|
| `practice-hand.yaml` | Onboarding → Home → bet → deal → insurance → stand → settlement → next hand |
| `career-node.yaml` | Tabs → Career map → node detail → a full session → stars → progress persisted |
| `every-screen.yaml` | All 16 destinations render their own content, incl. honest empty states and the Notifications inbox |
| `practice-resume.yaml` | Kill mid-hand and resume. **Known-flaky against a dev build** — see the header comment; resume itself is verified by direct observation |

Still to write: sign-up → Home, Quick Play buy-in → hand → cash-out, split across
multiple hands, friends and private tables, tournament, daily challenge, reduced
motion, sign out leaving Practice usable.

**A loop whose progress branch is nested inside one state can deadlock.**
`career-node.yaml` tapped "Next hand" inside its betting branch, so an iteration
that arrived at a settled hand did nothing — and neither did any iteration after
it, because nothing else brings the betting bar back. It failed intermittently
and read as flakiness for months. Every state is now handled at the TOP level of
an iteration, so a pass copes with whatever it finds. Diagnosed from the
failure's own hierarchy dump, which showed the table stuck at hand 2 of 10 with
"Next hand" on screen — read the artefacts before re-running.

**A single tap can be swallowed.** All three flows now tap `onboarding-guest`
inside a small `repeat`: a tap issued while the screen is settling occasionally
did nothing, and the flow then sat on onboarding until its wait expired, which
looks like a broken app rather than a lost tap.

**Selector discipline, learned the hard way.** Use `id:` against a real `testID`,
and a `".*regex.*"` when asserting on copy. On iOS an `accessibilityLabel`
*replaces* child text in the tree, and Maestro matches text exactly unless given
a pattern — `assertVisible: "PRACTICE"` matched both Home's overline and the
table header and passed while verifying nothing.

---

## Notifications and audio

| Suite | What it holds |
|-------|---------------|
| `tests/notifications/notifications.test.ts` | A payload is untrusted input: unreadable rows are dropped, non-allowlisted keys stripped, and the destination derived from a notification's KIND — a payload naming `../../settings` still routes to Social. Also that every kind has a destination, and that the Settings toggles map onto kinds the server actually filters on |
| `tests/notifications/push-message.test.ts` | What reaches a device and what is recorded afterwards. An unrecognised ticket is a failure, not a success; a dead token is retired server-side; and a mocked send is never recorded as sent. `fetch` is stubbed so the unhappy replies can be produced on demand |
| `tests/audio/generated-audio.test.ts` | Every `SoundName` has a file and every file has a name; each is byte-identical when regenerated; each is mono 16-bit PCM starting and ending at silence; and the palette's loudness ordering holds — loss < win < blackjack, with cards and chips quietest |
| `supabase/tests/18_notifications.test.sql` | The privileges and the constraints: `notify_user` revoked from every client role, the payload allowlist rejecting an array or an unlisted key, dedupe collapsing per player, only `read_at` writable by a client, and `sent_at` stamped only by a real delivery |
| `tests/server/notifications.integration.test.ts` | The pipeline against the running stack: a friend request becomes a row for the recipient only, the sender drains it as `mocked`, a kind a device did not ask for is never queued to it, and a lapsed betting deadline produces a `your_turn` notification — the last one waits sixteen real seconds, which is what it costs to prove the feature fires at all |

**The audio test is the licence check.** `docs/ASSET_LICENSES.md` claims every cue
is originally generated; that claim is only worth anything if regenerating
reproduces the committed bytes, which is why the noise source is a seeded LCG and
why the comparison is an equality rather than a tolerance.

---

## CI

A pull request must not pass with TypeScript errors or failing engine tests. The
pipeline runs install → lint → typecheck → unit tests → database tests where the
environment supports them → build/config validation.
