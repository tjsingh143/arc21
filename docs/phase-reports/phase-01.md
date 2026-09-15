# Phase 1 — Blackjack engine, state machine, settlement, randomness, integrity

**Date:** 2026-08-24 · **Branch:** `phase14-s2-security` · **Result: PASS**

Engine files changed: 6 (`shared/blackjack/*`), plus one solver call site and the
test harness. **No behaviour visible to a correctly-playing player changed** —
every defect fixed here is a rule the engine got wrong in a configuration or a
situation the shipped tables reach only at the edges.

Engine tests: **209 → 471**. `shared/blackjack` coverage: **97.17 / 93.39 /
97.11 / 98.17 → 98.76 / 95.85 / 100 / 99.70** (stmts / branch / funcs / lines).

---

## A. Defects found and fixed

Each one is pinned by a regression test that was **proved to fail without the
fix** — reverted, re-run, observed red, restored. That is recorded per item.

### A1. A player who left mid-hand kept being staked, hand after hand

**Severity: chips.** `handleLeave` clears `connected`. The server's closure path
(`settleTableClosure`) only runs at a phase where no wager is committed, so a
`LEAVE` sent during `PLAYER_TURNS` never reached it — and `openBetting` had no
branch for a disconnected seat. The seat came round to `BETTING_OPEN` still
eligible, and `RESOLVE_TIMEOUT` then staked the table minimum out of their stack.
Every hand. Until the stack fell below the minimum.

Traced end to end: `handleLeave` → `connected = false` only → `openBetting` reads
`sittingOut && connected && stack >= minBet`, which leaves a departed seat *not*
sitting out → `cascade` waits for it to lock → betting deadline expires →
`RESOLVE_TIMEOUT` stakes `minBet` for somebody who has gone.

`connected` is set to `true` in exactly two places (seat creation) and cleared in
three (`LEAVE`, closure, tournament elimination). **Nothing anywhere sets it back
to true.** So a disconnected seat is a departed seat, and `openBetting` now sits
it out.

*Regression:* `table-integrity.test.ts` → "does not stake a seat that left
mid-hand when the next betting round times out". Reverted the branch → **failed**.
The neighbouring test proves the other direction still holds: a committed wager
is not refunded and the hand still resolves.

### A2. Taking insurance conjured a peek the ruleset had switched off

`performInitialDeal` routes a non-peeking ruleset straight to `PLAYER_TURNS` on a
ten upcard. An **ace** upcard went to `INSURANCE_OFFER` first, and the cascade
then set `DEALER_PEEK` **unconditionally**. So `insuranceAllowed: true` quietly
implied `dealerPeeksForBlackjack: true` — for the one upcard where the difference
decides whether split and doubled wagers survive a dealer blackjack.

Not reachable from the shipped ruleset (Arc Standard peeks), and the European
variant is saved by having no hole card to peek at. It is a latent rule bug in a
configuration the repository documents as supported.

*Regression:* `table-integrity.test.ts` → "goes to PLAYER_TURNS after the offer,
with no DEALER_PEEKED event". Reverted → **failed**.

### A3. A table could wait forever on an insurance answer from somebody who left

`cascade` holds at `INSURANCE_OFFER` while any decision is `PENDING`. A seat that
left there stayed pending, and on a table carrying no insurance clock nothing
else would move it. `LEAVE` now answers the offer the way the clock would —
`DECLINED`, the stated default, which costs the departing seat nothing and
touches no card. An insurance bet already **taken** is left exactly where it is.

*Regression:* `table-integrity.test.ts` → "is declined on the way out, and the
round carries on". Reverted → **failed**.

### A4. Two rule shapes that read as features the engine does not model

`assertRulesAreCoherent` now refuses both:

- **`doubleAllowed: true` with `doubleOnAnyTwoCards: false`.** Reads as "double
  on 9-11 only". `getLegalActions` has no allowlist of totals to consult, so the
  flag did not restrict doubling — it **removed** it, on a table whose Fair Play
  copy would have said otherwise.
- **`doubleSplitAcesAllowed: true` with `hitSplitAcesAllowed: false`.** A split
  ace that cannot be hit is completed the instant its one card arrives, so the
  double is a decision nobody would ever be offered.

### A5. The dealer's drawing rule existed twice

`playDealer` in the engine and `dealerDrawDistribution` in
`scripts/strategy-solver.ts` each carried their own
`best < 17 || (best === 17 && soft && rules.dealerHitsSoft17)`. The solver needs
the dealer's final-total distribution to solve basic strategy, so a drift between
the two means **the chart is solved for a dealer the engine does not deal** — and
the chart is what the product grades players against, so it would have surfaced
as honest-looking advice that was quietly wrong.

Extracted as `dealerMustDraw` in `hand-value.ts`; both call it. Taking primitives
rather than a `HandValue` is what lets the solver, which works over rank counts,
share it.

*Proof it is behaviour-preserving:* `tests/strategy/generated-table.test.ts`
re-solves the committed chart from scratch and compares **byte for byte**. It
still passes, so the consolidation changed no EV and no cell.

### A6. Two comments claimed call sites that did not exist

- `assertShoeIntegrity` said "used in tests and as a server-side sanity check
  after shuffling". **The server never called it.** Made true rather than
  softened: `createShoe` and `reshuffle` now call it, so every shoe the product
  ever deals from has been checked — client, server and tests alike. Cost is one
  pass over 312 cards roughly once every thirty hands; the benchmark below shows
  it in the noise.
- `isActionLegal` said the server calls it "before applying a command". It does
  not — `engine-bridge.assertCommandIsLegal` reads the full `LegalActionSet`,
  because it must distinguish `NOT_YOUR_TURN` from `ILLEGAL_ACTION`. The comment
  now says what is true, and a test pins the two to the same answer so they can
  never diverge.

### A7. A short `pad` silently threw the test fixture away

Not product code, but it cost eleven failing cases to find and would have cost
somebody else the same. `openBetting` reshuffles whenever fewer than
`SAFETY_RESERVE_CARDS` remain — which is true of **any** fixture shoe shorter
than 52 cards. `startSession` opens the first betting round, so a short fixture
was replaced by a real random six-deck shoe before the first card was dealt. No
error, no skip: the test simply stopped testing what it said it tested.

`harness()` now refuses such a fixture with a message naming the fix.

---

## B. What was verified, and how

### The default ruleset, item by item

Every rule in the phase brief's list was checked against **engine behaviour**,
not against the ruleset object. Six decks, S17, American hole card, peek on ace
*and* on ten, insurance before the ace peek, natural = two cards on an unsplit
hand, 3:2 / 1:1 / push, insurance half-stake at 2:1, even money, late surrender
only where legal, double on any initial two cards with exactly one card after,
DAS, equal-point-value splits including K+Q, four hands maximum, resplit
non-aces, split aces once with one card each and no hit or double, split 21 as an
ordinary 21, dealer natural vs player natural as a push, integer chips, and the
bet increment.

**No required rule is implemented only in UI conditionals.** Searched for
duplicate rule logic across `src/`, `app/` and `supabase/functions/`: the UI
either calls the engine (`evaluateHand` in `HandCards`), renders a
`LegalActionSet` the server computed, or derives display copy from the ruleset
fields (`ruleset-facts.ts`, `fair-play-facts.ts`, `strategy-chart.ts`). The two
extracted affordance predicates (`betting-affordance.ts`,
`insurance-affordance.ts`) read `LegalActionSet` and decide only whether a
control is worth offering. The one genuine second implementation was A5.

### The published payout table now has to agree with the engine

`settlementRows()` builds the Learn screen's payout table from the ruleset's
ratios, and its own tests asserted the **strings** — `"2.5× your bet"`,
`"0.5× your bet"`. Nothing compared either side to `settleHand`. Both could have
drifted together with two green suites. `split-settlement.test.ts` now reads the
published table and settles a real hand for each row, including under a 6:5
payout so the two move together from the same field.

### Fairness — what is actually provable

A statistical "the shuffle looks random" test passes on a broken implementation
and fails at random on a correct one, so none was written. What is proved
deterministically in `fairness.test.ts`:

1. **Cards come out of the shoe in order and nowhere else.** Over a 25-hand
   session on a real seeded six-deck shoe, every card dealt is inside
   `cards[0..nextIndex)`, none beyond it, and no card twice. `drawCard` is
   verified index by index for 100 draws, returning a new shoe and never
   reordering.
2. **Nothing about the player changes the cards.** Identical shoes, identical
   actions, varying only what the invariant names: a 5,000,000-chip stack against
   1,000; two different accounts; a wager of 1,000 against 50; and a bankroll
   *falling* 100,000 → 30,000 across fifteen hands against one *rising* by the
   same amount. Identical card sequences in every pair.
3. **Playing a hand consumes no randomness at all.** A full deal-split-double-
   settle sequence runs against a `RandomSource` that throws if read. The only
   entropy the engine takes is at the reshuffle boundary, from the injected
   source; refusing to supply one produces a refusal, never a reused order.
4. **The shuffle is uniform, by enumeration rather than sampling.** Fisher-Yates
   over four items asks for indices in [0,4), [0,3), [0,2) — exactly 24 draw
   sequences. All 24 are enumerated and produce 24 **distinct** permutations, so
   the map is a bijection and a uniform source yields a uniform shuffle. The
   biased "swap with any index" variant cannot be one: it has 4³ = 64 sequences
   for 24 permutations.
5. **Source scan.** No `Math.random(` call, no `Date.now()`, no bare `new Date()`
   anywhere in the eleven engine files — matched against code with comments and
   string literals stripped, because `rng.ts` names `Math.random()` in the message
   it throws when refusing to fall back to it. And `shoe.ts` / `rng.ts`, which are
   the whole of card selection, name no player-state identifier at all.

**Both source-scan gates were proved to fail when breached**, because a gate that
matches nothing reads exactly like a gate that passes. A planted
`Math.random()` in `shoe.ts` → failed. A planted `seat.walletBalance` in `rng.ts`
→ **passed**, on the first version of the check: `\bwallet\b` finds no word
boundary inside `walletBalance`. The plain-substring fix then failed on every
file, because `export` contains `xp`. The check now splits identifiers on
camelCase and underscores; re-planted `walletBalance` → failed, `lossStreak` →
failed, clean tree → passes.

### The state machine

`state-machine.test.ts` runs the full matrix: **6 resting phases × 12 commands**,
each asserted as accepted or refused with the exact `EngineErrorCode` a client
branches on, plus `RESOLVE_TIMEOUT` separately because its legality turns on the
clock rather than the phase. A closed-union check fails the matrix if a command
is added without a decision about where it is legal.

The seven **transient** phases (`BETTING_LOCKED`, `INITIAL_DEAL`, `DEALER_PEEK`,
`DEALER_REVEAL`, `DEALER_TURN`, `SETTLEMENT`, `BETWEEN_HANDS`) never rest —
`cascade` drives through them inside one accepted command — so each is entered
deliberately and driven with `ADVANCE`. A separate test asserts the phases a real
round actually stops in, so a future change that made one of them resting would
strand a client on a step that answers no command.

`PLAYER_TURNS` bookkeeping is asserted directly: the cursor moves to the seat's
*second split hand* before it passes along the table, per-hand terminal statuses,
and the clock and cursor clearing when nothing is left to act.

### Resume safety

`serialization.test.ts` round-trips five resting states through JSON — including
mid-split and with an insurance decision pending. Field equality is checked, but
the load-bearing assertion is stronger: **apply the same command to the original
and the restored copy and require byte-identical state and events.** Anything
lost in the round trip changes a card, a chip or a status, and all three are in
there.

Also proved: three `ADVANCE`s at a restored `HAND_COMPLETE` emit nothing and
credit nothing (no duplicate settlement); a restored `HAND_COMPLETE` cannot start
two rounds; the hole card stays hidden and the assertion is run **against the
restored state** so a round trip that shuffled the dealer's cards would be caught
rather than compared with itself; a real 312-card shoe survives intact; and
`structuredClone` and the JSON fallback agree. The fallback is the path an older
Hermes takes and nothing had exercised it — it is now run with the global deleted.

### Shoe and reserve — measured, not assumed

The comment on `SAFETY_RESERVE_CARDS` said a five-seat round uses "roughly 20-30
cards". That was the median with no tail. Measured over **5,000 five-seat rounds**
of the most card-hungry legal play there is (split whenever the engine allows it,
then hit every hand to 21 or bust):

| median | p99 | p99.9 | worst |
|--------|-----|-------|-------|
| 23 | 40 | 47 | **52** |

The cut card guarantees ≥ 78 cards at the start of every round (312 − 234), so
the worst round measured had 26 to spare. Both the comment and
`docs/BLACKJACK_RULES.md` now carry the figures. A smaller soak
(3 seats × 60 rounds, ≥ 2 reshuffles) runs in the suite and asserts the
relationship: no round begins below the guarantee, no round exceeds it, no card
is dealt twice from one shoe generation, no reshuffle happens inside a hand, and
every reshuffled shoe is a true six decks.

**One claim was corrected rather than defended.** `BLACKJACK_RULES.md` said an
exhausted shoe means "the hand is voided transactionally, wagers are restored".
The COMMAND is voided, not the hand: the transaction rolls back so no chips move,
but the persisted state is still mid-hand over an empty shoe and a retry throws
again. There is no automatic recovery. It is unreachable from the shipped ruleset
without a round consuming 78 cards — half again the worst of 5,000 maximal-
consumption rounds — and the fix (`VOID_HAND`) touches session lifecycle and
escrow, so it is not an engine-only change. Recorded honestly instead of quietly.

### Vocabulary drift across three definitions

`PlayerHandStatus`, `HandOutcomeKind` and `PlayerActionType` are each written
down **three times**: the TypeScript union, a Zod enum in `shared/contracts`, and
a Postgres enum in `20260813120000_foundation.sql` whose comment says "Mirrors X
in shared/blackjack/types.ts". Nothing compared them. A value the engine can set
that the schema cannot name is a payload the client silently fails to parse —
the same shape as the `canStartNextHand` defect that stopped every online table
after hand one.

`status-taxonomy.test.ts` parses the enums out of the migration text (no database
needed, so it runs where the drifting change is actually made) and compares all
three, plus `GamePhase` against the wire enum. Each union now has an exhaustive
`as const satisfies` array, so adding a member without adding it to the list fails
`tsc`.

That surfaced `RESOLVED` — a status the engine never sets and nothing reads. It
is **kept**, because a Postgres enum cannot drop a value and narrowing two of the
three definitions would create exactly the drift this file exists to catch. It is
now documented as reserved, and the suite proves both that a full session never
produces it and that every *other* status is produced by a real fixture, so the
list is not aspirational.

---

## C. Anti-fake-completeness sweep

`TODO|FIXME|HACK|placeholder|stub|mock|fake|hardcoded|temporary|not implemented|
coming soon|for now|XXX` across `shared/blackjack`, `shared/contracts`,
`shared/strategy`, the practice and table features, the card/table components and
the engine-facing Edge Function helpers.

**Zero TODO, FIXME or HACK.** Every hit investigated:

| Hit | Verdict |
|-----|---------|
| `public-state.ts` "placeholder" | The hole card is replaced by `{hidden:true}` rather than omitted, so a client can render a face-down card. Describes real behaviour. |
| `contract-primitives.ts` "placeholder" | Same fact, on the wire schema. |
| `rng.ts` "tests can pass a stub" | `CounterStreamRandomSource` takes an injected `digest`. Real dependency injection. |
| `PlayingCard.tsx` "Outline placeholder" | A drop-target outline. A drawing, not a stand-in. |
| `*-gateway.ts` `kind: "fake"` | A discriminant for test doubles. Used in `tests/` only; no production path constructs one. Repo-wide established pattern. |

Two *genuine* fake-completeness findings did not match any of those words, which
is why the sweep is not the whole of section A: the two comments in **A6** naming
call sites that did not exist.

---

## D. Commands run, with results

```
npx tsc --noEmit                       exit 0
npm run lint                           0 errors, 38 warnings (baseline: 38)
npm run check:functions                all 3 Edge Functions typecheck
npx vitest run tests/engine            17 files /   471 tests PASS
npm run test:unit                      94 files / 1,901 tests PASS   (was 93 / 1,639)
npm run test:coverage                  exit 0 — every gate met
supabase db reset                      43 migrations + seed, clean
supabase test db                       23 files /   453 assertions PASS
npm run test:server                    13 files /   116 tests PASS  (load ~5, 0 absorptions)
npm run benchmark                      see below
```

`npm run test:server` is the integration smoke test for this phase: it drives the
**real** Edge Functions over HTTP, and those functions consume the engine files
this phase changed. Confirmed the runtime was reading the edited files
(`docker exec … grep` for two of the new lines inside the container) rather than
a stale copy.

### Coverage — `shared/blackjack`

| | statements | branches | functions | lines |
|---|---|---|---|---|
| before | 97.17 | 93.39 | 97.11 | 98.17 |
| after | **98.76** | **95.85** | **100** | **99.70** |

Gate is 90% on all four. Nothing was covered by asserting a constant: the lines
that moved are `isActionLegal`, `privateTableRules`, `isVisibleCard`,
`assertShoeIntegrity`'s three failure branches, the JSON clone fallback, the
double-answered insurance path at a shared table, and the legal-action set of a
seat waiting its turn — every one a real call somebody makes.

Four lines remain uncovered and are left so deliberately, because faking them
would be worse than the gap: two defensive `throw`s unreachable through
`applyCommand` (`reducer.ts:945` rethrowing a non-shoe error, `reducer.ts:961`
re-checking split eligibility the legality gate already enforced) and two `??`
fallbacks in `public-state.ts` for an out-of-range cursor.

### Benchmark — quoted as a range, and against a same-day baseline

```
with these changes    1204 · 1220 · 1249 · 1347 · 1242 µs per hand
stashed baseline      1204 · 1216 · 1246                µs per hand
```

Identical ranges: `assertShoeIntegrity` on every shuffle costs nothing
measurable (103 shuffles over 5,000 hands). Note both are well above the
752-808 µs `CLAUDE.md` records — that is **this machine today**, not a
regression, which is exactly why the baseline was re-measured from a stash rather
than compared against a written-down number.

---

## E. Phase 1 exit criteria

| Criterion | Met |
|---|---|
| Every MVP blackjack rule implemented in engine logic | ✅ section B, item by item |
| Deterministic tests prove edge behaviour | ✅ 471 engine tests, no statistical assertions |
| Production RNG appropriate | ✅ CSPRNG only, no fallback, unbiased shuffle proved by enumeration |
| No outcome manipulation exists | ✅ four behavioural proofs + two source gates, both proved to fail when breached |
| No required rule exists only in UI | ✅ searched; the one duplicate (the dealer's rule) is consolidated |
| Engine tests green | ✅ 471/471, and 1,901 unit + 116 server + 453 pgTAP |
| No known engine-integrity blocker | ✅ see below |

**Open, non-blocking, assigned onward:** an exhausted shoe has no automatic
recovery (section B). Unreachable from the shipped ruleset by a margin of 26
cards against a measured worst case; the fix is a `VOID_HAND` command that
touches session lifecycle and escrow rather than the engine.

**PHASE 1: PASS**
