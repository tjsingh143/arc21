# Arc 21 — Blackjack Rules

The **Arc Standard** ruleset. This is a legitimate player-friendly six-deck rule
family — it is a product choice, not a universal definition of blackjack. Rule
variations materially change both expected return and correct basic strategy, so
every strategy table in this product is keyed to a ruleset id and version.

Canonical source of truth: `shared/blackjack/rules.ts` (`ARC_STANDARD_RULES`).
This document describes it; it does not define it. If the two disagree, the code
is correct and this file is stale.

---

## Arc Standard at a glance

| Rule | Value |
|------|-------|
| Decks | 6 × 52, no jokers |
| Dealer | Stands on all 17, including soft 17 (S17) |
| Hole card | American style |
| Peek | On ace or ten-value upcard; insurance is decided **before** the ace peek |
| Natural blackjack | Exactly two cards totalling 21 on the original unsplit hand |
| Natural payout | 3:2 |
| Ordinary win | 1:1 |
| Push | Wager returned |
| Insurance | Dealer ace only; exactly half the original wager; pays 2:1 |
| Even money | UI shortcut for a natural vs dealer ace; booked as ordinary insurance |
| Surrender | Late surrender, original unsplit two-card hand, after the peek |
| Double | Any initial two cards, exactly one card, then forced stand |
| Double after split | Yes, except split aces |
| Split eligibility | Equal **point value** — any two ten-value cards qualify |
| Max hands after splitting | 4 |
| Resplit non-aces | Yes, up to four hands |
| Split aces | Once only; one card each; no hit, double or resplit |
| 21 after splitting aces | Ordinary 21, pays 1:1 — **not** a natural |
| Dealer natural vs player natural | Push |
| Bet accounting | Integer virtual chips, multiples of 10 |
| Shoe penetration | 75% target |
| Mid-hand reshuffle | Never |
| Side bets | None |

---

## Settlement

The stake leaves the seat stack when the wager is committed, so settlement only
ever **credits**. A losing hand credits zero; it does not subtract twice.

| Result | Credit (× hand wager) |
|--------|----------------------|
| Loss / bust | 0 |
| Push | 1.0 |
| Ordinary win | 2.0 (stake + 1:1) |
| Natural | 2.5 (stake + 3:2) |
| Surrender | 0.5 |

Insurance settles independently: 3× the stake against a dealer natural, zero
otherwise.

All chip arithmetic is integer. Ratios resolve through `ratioProfit`, which
floors. `assertRulesAreCoherent` rejects any ruleset whose minimum bet cannot pay
a natural in whole chips, so flooring never actually shaves chips from a player
under a shipped configuration. **No floating-point arithmetic ever touches a
balance.**

### Even money

Even money is not a separate wager. It is ordinary insurance taken on a natural,
and is booked that way so the ledger has one auditable accounting path rather
than a special case. Both branches net exactly +1× the original bet:

| Dealer | Main hand | Insurance | Net |
|--------|-----------|-----------|-----|
| Natural | Push (1.0×) | Pays 3 × 0.5× | **+1.0×** |
| No natural | Pays 2.5× | Stake lost | **+1.0×** |

`evenMoneyBranchNets` asserts this identity in the test suite rather than leaving
it as a claim in a comment.

---

## Dealer behaviour

The dealer is **not** an AI. It is deterministic and rule-bound:

```
Reveal hole card.
While total < 17:            hit
If total == 17 and soft:     hit only when dealerHitsSoft17 (false in Arc Standard)
If total >= 17:              stand
If total > 21:               bust
```

Dealer behaviour never varies with player skill, purchase status, loss streak,
engagement, table tier, career node or tournament ranking.

That procedure is written down **once**, as `dealerMustDraw` in
`shared/blackjack/hand-value.ts`. Until phase 1 it was written twice — a second
copy lived in `scripts/strategy-solver.ts`, which needs the dealer's final-total
distribution to solve basic strategy. Two copies of the dealer's rule means the
CHART can be solved for a dealer the engine does not deal, and the chart is what
the product grades players against, so the drift would have surfaced as
honest-looking advice that was quietly wrong. Both callers now share the one
function, and `tests/engine/dealer-and-aces.test.ts` proves that function is what
the engine actually does, hand by hand.

### The dealer does not always draw

If no live hand can still be beaten, the dealer reveals but does not draw. This
happens when every remaining hand has busted or surrendered, or when every
remaining hand is a natural (which only a dealer natural could push, and the peek
has already excluded that).

This matches real casino procedure and avoids burning cards that would shift shoe
composition for no reason.

---

## Deliberate deviations from the source specification

### 1. Safety reserve is 52 cards, not 104

The specification asks for both 75% penetration and a reshuffle when fewer than
104 cards remain. **At six decks these cannot both hold.** The cut card falls at
index 234, leaving 78 cards; a 104-card reserve trips first, at index 209, and
real penetration silently becomes ~67%.

Because penetration is a user-facing fairness claim on the Fair Play screen, the
cut card stays the binding trigger and the reserve is set to one full deck (52) —
above any realistic round's consumption, below the 78-card post-cut remainder.

"Above any realistic round's consumption" is a measurement, taken in phase 1.
Over 5,000 five-seat rounds of the most card-hungry legal play there is (split
whenever the engine allows it, then hit every hand to 21 or bust):

| median | p99 | p99.9 | worst |
|--------|-----|-------|-------|
| 23 cards | 40 | 47 | **52** |

The cut card guarantees at least 78 cards at the start of every round, so the
worst round measured still had 26 to spare.

`assertPenetrationIsCoherent` fails any ruleset where the reserve could pre-empt
the cut card, so this relationship cannot silently regress. One-deck
configurations are correctly rejected today for exactly this reason.

### 2. Auto-stand on 21

A hand that reaches 21 is completed automatically. The only outcome of hitting a
21 is an accidental bust, so no decision is being taken away from the player.
This is a UX safety convenience, not a rule change.

### 3. `PLACE_BET` is absolute, not incremental

Chip taps accumulate in the UI; the engine receives the final intended wager.
This keeps the command idempotent under network retry.

### 4. A seat that has left is not dealt in again

`connected` is cleared only by `LEAVE`, by a table closure or by a tournament
elimination, and nothing ever sets it back — so in engine state a disconnected
seat is a **departed** seat, not a flaky one, and the next betting round sits it
out.

This is a rule about money, not about presence. A committed wager still resolves:
leaving mid-hand does not refund anything and the hand plays out. But before
phase 1 the seat then came back round to `BETTING_OPEN` still eligible, and the
betting deadline staked the table minimum out of their stack, hand after hand,
in absentia, until it fell below the minimum. The server's closure path only runs
at a phase where no wager is committed, so a mid-hand departure never reached it.
Leaving is never a way to escape a committed wager; it must not become a way to
keep committing them either.

---

## Fairness invariants

These are absolute and are enforced by tests, not merely by policy.

- Production shuffles use a CSPRNG with unbiased Fisher-Yates. `Math.random()`
  never determines gameplay, and the production random source cannot fall back to
  the seeded test source — a missing CSPRNG is a hard construction failure.
- Bounded random integers use rejection sampling; no modulo bias.
- Cards are drawn strictly in shoe order. Nothing inspects the shoe to choose an
  outcome.
- No algorithm modifies cards based on loss streaks, purchases, engagement risk,
  player level, wallet balance or desired drama.
- The shoe is never reshuffled mid-hand.
- If the shoe is genuinely exhausted mid-hand, the engine throws
  `SHOE_EXHAUSTED`, emits `SHOE_EXHAUSTED_INVARIANT` and leaves the input state
  untouched. **No card is ever fabricated.** Being precise about what that does
  and does not mean, because an earlier version of this line overstated it: the
  COMMAND is voided, not the hand. The server's transaction rolls back, so no
  chips move and the wager is exactly where it was — but the persisted state is
  still mid-hand over a nearly empty shoe, and a retry throws again. There is no
  automatic recovery, and the table would need an operator or a session close.
  The measurement above is why that is acceptable rather than urgent: it cannot
  be reached from the shipped ruleset without a round consuming 78 cards, half
  again the worst of 5,000 maximal-consumption rounds. A `VOID_HAND` command
  would be the fix if it ever became reachable; it touches session lifecycle and
  escrow, so it is not an engine-only change.
- Clients never receive undealt cards or the unrevealed hole card. This is
  enforced by `toPublicState` and asserted by `assertNoHiddenCardLeak`.

---

## Table tiers

Tiers change stakes and nothing else — deck count, dealer rules and payouts are
identical at every tier.

| Tier | Buy-in | Min bet | Max bet | Unlock |
|------|--------|---------|---------|--------|
| Casual | 2,000 | 20 | 500 | Level 1 |
| Standard | 5,000 | 50 | 1,000 | Level 1 |
| High | 20,000 | 200 | 5,000 | Level 10 |

No mode is ever described as having an "easy" or "hard" dealer, because none does.

---

## Configurable variants (supported, not shipped)

`BlackjackRules` already drives these, and each is covered by tests:

- **H17** — `dealerHitsSoft17: true`
- **European / no-hole-card** — `dealerHoleCard: false`, `dealerPeeksForBlackjack: false`
- **Split by rank** — `splitPolicy: "same_rank"` (K+Q no longer splittable)
- **Hit / resplit split aces** — `hitSplitAcesAllowed`, `resplitAcesAllowed`
- **Split-ace 21 as natural** — `splitAceTwentyOneIsBlackjack`
- **Insurance disabled** — `insuranceAllowed: false`
- **Surrender disabled** — `lateSurrenderAllowed: false`
- **DAS disabled** — `doubleAfterSplit: false`
- Alternative deck counts, subject to the penetration/reserve coherence check

Shipping any of these requires a **new ruleset version**, because basic strategy
changes with the rules and strategy tables are keyed to `id@version`.

### Combinations `assertRulesAreCoherent` refuses

Two rule shapes read as features the engine does not model, and would have gone
in silently. Both now fail at session construction rather than at a table:

- **`doubleAllowed: true` with `doubleOnAnyTwoCards: false`.** The flag reads as
  "double on 9, 10 and 11 only", which is what a rule author would mean by it —
  but `getLegalActions` has no allowlist of totals to consult, so the flag did
  not restrict doubling, it removed it. A table advertising a restricted double
  and offering none is exactly the divergence this guard exists to stop. Model
  the allowlist first, then relax the check.
- **`doubleSplitAcesAllowed: true` with `hitSplitAcesAllowed: false`.** A split
  ace that cannot be hit is completed by the engine the instant its one card
  arrives, so the double would never be offered.

And one behaviour that used to depend on the wrong flag: an ace upcard routed
through the insurance offer, and the cascade then peeked **unconditionally**. So
switching insurance on quietly switched peeking on with it, for the one upcard
where the difference decides whether split and doubled wagers survive a dealer
blackjack. `dealerPeeksForBlackjack` now governs both paths.
