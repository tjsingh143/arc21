# Arc 21 — Strategy Cross-Validation

**GENERATED FILE — regenerate with `npx tsx scripts/generate-strategy-tables.ts`.**

Ruleset `arc-standard@1` · generated 2026-08-17T15:35:50.467Z

The chart Arc 21 serves is computed by an expected-value solver, not copied from a published chart. This document is the independent check: it compares every cell of the computed chart against the widely published six-deck / S17 / DAS / late-surrender basic strategy chart and lists **every** disagreement, with the solver's own EV numbers for that cell.

Disagreements are reported, never reconciled. The solver is not tuned to match the published chart, and a disagreement is not quietly accepted either — every one below is for a human to adjudicate.

## Method

- Six-deck composition with exact card removal. **No infinite-deck approximation anywhere.**
- Dealer final-total distribution by exact recursion honouring S17, conditioned on the peek finding no natural — a ten upcard cannot hold an ace beneath it, an ace upcard cannot hold a ten, and the surviving hole cards are renormalised.
- Player draws recurse with card removal and optimal continuation at every step.
- Split EV uses a pending-hand recursion that tracks the hand count exactly, so the four-hand cap binds where it really binds; DAS per ruleset; split aces take one card and stand, and a resulting 21 pays 1:1 rather than 3:2.
- Surrender is exactly -0.5.
- Every EV is per unit of the **original** wager and is conditional on the dealer not holding a natural — the only state in which a decision is ever offered.

### Approximations

- Dealer final-total distribution is conditioned on the known cards (player's initial cards + upcard) but is not recomputed as the player draws further cards.
- Split hands share the shoe only through their first cards; cards consumed while playing one split hand are not removed from the shoe seen by its siblings.
- Chart cells are averaged over two-card compositions (three-card for hard 21 and soft 21, which two cards cannot make), then applied to hands of the same total regardless of card count.
- Doubles and splits are costed as always affordable; affordability is enforced at lookup time by the caller's legal action set.
- Insurance is excluded; it is a separate wager with its own expectation and is never part of a basic-strategy cell.

### End-to-end sanity signal

Playing this chart from the top of the shoe with insurance always declined returns **-0.3345%** per unit wagered — a house edge of **0.3345%**. Published analyses of a six-deck, S17, DAS, late-surrender, 3:2 game without resplit aces land in the same neighbourhood. A structural error in the dealer distribution, the peek conditioning or the split model would move this figure well before it moved a single chart cell, so it is the cheapest place to notice one.

## Computed chart

`H` hit · `S` stand · `Dh` double else hit · `Ds` double else stand · `Rh` surrender else hit · `Rs` surrender else stand · `P` split · `Ph` split else hit · `Ps` split else stand — standard chart notation, which is what makes the comparison with the published chart meaningful.

The "else" action is not decoration: it is `fallbackAction` in the generated table. On a **hard or soft** row it is exactly what the advisor serves when the primary action is not legal — a third card, a stack too short to double, a hand that came from a split.

**The pair rows are not read that way, and the `h`/`s` suffix on a `P` cell is not what a player who cannot split is told.** A pair that cannot be split is no longer a pair, it is a total, so the advisor re-reads the matching hard or soft row — twice the card value, or soft 12 for aces — and serves that solved cell instead. The pair cell's own `fallbackAction` is the last resort, reached only when the total row cannot produce a legal action either.

- `8,8` vs 10 shows `Ph`, but a player who cannot split is served the hard 16 vs 10 cell (`Rh`) — surrender, or hit when surrender is unavailable too.
- `A,A` vs 6 shows `Ph`, but a player who cannot split is served the soft 12 vs 6 cell (`Dh`) — double, or hit when double is unavailable too.
- The total row answers all the way down: `8,8` vs 10 with surrender unavailable as well resolves to the hard-16 row's *own* else, hit. The pair cell's `fallbackAction` is reached only if the total row yields nothing legal at all, which cannot happen while hit and stand are on the table.

### Hard totals

| Total | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | A |
|---|---|---|---|---|---|---|---|---|---|---|
| 4 | H | H | H | H | H | H | H | H | H | H |
| 5 | H | H | H | H | H | H | H | H | H | H |
| 6 | H | H | H | H | H | H | H | H | H | H |
| 7 | H | H | H | H | H | H | H | H | H | H |
| 8 | H | H | H | H | H | H | H | H | H | H |
| 9 | H | Dh | Dh | Dh | Dh | H | H | H | H | H |
| 10 | Dh | Dh | Dh | Dh | Dh | Dh | Dh | Dh | H | H |
| 11 | Dh | Dh | Dh | Dh | Dh | Dh | Dh | Dh | Dh | H |
| 12 | H | H | S | S | S | H | H | H | H | H |
| 13 | S | S | S | S | S | H | H | H | H | H |
| 14 | S | S | S | S | S | H | H | H | H | H |
| 15 | S | S | S | S | S | H | H | H | Rh | H |
| 16 | S | S | S | S | S | H | H | Rh | Rh | Rh |
| 17 | S | S | S | S | S | S | S | S | S | S |
| 18 | S | S | S | S | S | S | S | S | S | S |
| 19 | S | S | S | S | S | S | S | S | S | S |
| 20 | S | S | S | S | S | S | S | S | S | S |
| 21 | S | S | S | S | S | S | S | S | S | S |

### Soft totals

| Total | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | A |
|---|---|---|---|---|---|---|---|---|---|---|
| 12 (A,A) | H | H | H | H | Dh | H | H | H | H | H |
| 13 (A,2) | H | H | H | Dh | Dh | H | H | H | H | H |
| 14 (A,3) | H | H | H | Dh | Dh | H | H | H | H | H |
| 15 (A,4) | H | H | Dh | Dh | Dh | H | H | H | H | H |
| 16 (A,5) | H | H | Dh | Dh | Dh | H | H | H | H | H |
| 17 (A,6) | H | Dh | Dh | Dh | Dh | H | H | H | H | H |
| 18 (A,7) | S | Ds | Ds | Ds | Ds | S | S | H | H | H |
| 19 (A,8) | S | S | S | S | S | S | S | S | S | S |
| 20 (A,9) | S | S | S | S | S | S | S | S | S | S |
| 21 | S | S | S | S | S | S | S | S | S | S |

### Pairs

| Pair | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | A |
|---|---|---|---|---|---|---|---|---|---|---|
| 2,2 | Ph | Ph | Ph | Ph | Ph | Ph | H | H | H | H |
| 3,3 | Ph | Ph | Ph | Ph | Ph | Ph | H | H | H | H |
| 4,4 | H | H | H | Ph | Ph | H | H | H | H | H |
| 5,5 | Dh | Dh | Dh | Dh | Dh | Dh | Dh | Dh | H | H |
| 6,6 | Ph | Ph | Ps | Ps | Ps | H | H | H | H | H |
| 7,7 | Ps | Ps | Ps | Ps | Ps | Ph | H | H | H | H |
| 8,8 | Ps | Ps | Ps | Ps | Ps | Ph | Ph | Ph | Ph | Ph |
| 9,9 | Ps | Ps | Ps | Ps | Ps | S | Ps | Ps | S | S |
| 10,10 | S | S | S | S | S | S | S | S | S | S |
| A,A | Ph | Ph | Ph | Ph | Ph | Ph | Ph | Ph | Ph | Ph |

## Disagreements with the published chart

Reference: the widely published six-deck, dealer-stands-on-all-17, double-after-split, late-surrender basic strategy chart (Wizard of Odds / Blackjack Apprenticeship lineage).

`Margin` is the solver's EV for its own choice minus its EV for the reference choice. A margin near zero means the two plays are all but equivalent and the disagreement is a rounding-level call; a large margin means something structural differs and must be investigated before the chart ships.

### Primary action

**No disagreements.** All 360 published cells — including every cell flagged below as genuinely borderline — match the computed chart's primary action.

### Fallback ("else") action

None. Every `Dh` / `Ds` / `Rh` / `Rs` cell resolves to the same secondary action as the published chart.

### Rows with no published reference

Hard 4 and soft 12 appear in no published chart, because a two-card 4 or soft 12 is always a pair and the pair row answers first. Arc 21 solves them anyway so that "you hold 2,2 or A,A but cannot split" resolves through a computed cell instead of an invented default. The reference values for these rows are an extrapolation by this repository, so a disagreement here is a disagreement with an assumption, not with the literature.

| Hand | Dealer | Computed | Reference | Margin | Stand | Hit | Double | Split | Surrender |
|---|---|---|---|---|---|---|---|---|---|
| Soft 12 | 6 | DOUBLE/HIT | HIT | +0.00172 | -0.14570 | 0.18825 | 0.18997 | — | -0.50000 |

## Cells that deserve explicit attention

These are the cells where basic strategy is genuinely close and where solvers legitimately differ. `Margin` here is the gap between the best and second-best action — how much the call is actually worth.

| Cell | Best | EV | Runner-up | EV | Margin | All EVs |
|---|---|---|---|---|---|---|
| 16 vs 10 | SURRENDER | -0.50000 | HIT | -0.53462 | 0.03462 | SURRENDER -0.50000; HIT -0.53462; STAND -0.53983; DOUBLE -1.06924 |
| 16 vs 9 | SURRENDER | -0.50000 | HIT | -0.50481 | 0.00481 | SURRENDER -0.50000; HIT -0.50481; STAND -0.54224; DOUBLE -1.00963 |
| 16 vs A | SURRENDER | -0.50000 | HIT | -0.51436 | 0.01436 | SURRENDER -0.50000; HIT -0.51436; STAND -0.66440; DOUBLE -1.02873 |
| 15 vs 10 | SURRENDER | -0.50000 | HIT | -0.50318 | 0.00318 | SURRENDER -0.50000; HIT -0.50318; STAND -0.53947; DOUBLE -1.00651 |
| 15 vs A | HIT | -0.48094 | SURRENDER | -0.50000 | 0.01906 | HIT -0.48094; SURRENDER -0.50000; STAND -0.66560; DOUBLE -0.98382 |
| 11 vs A | HIT | 0.14615 | DOUBLE | 0.12186 | 0.02429 | HIT 0.14615; DOUBLE 0.12186; SURRENDER -0.50000; STAND -0.66373 |
| 12 vs 4 | STAND | -0.20841 | HIT | -0.21277 | 0.00436 | STAND -0.20841; HIT -0.21277; DOUBLE -0.42554; SURRENDER -0.50000 |
| A,7 vs 9 | HIT | -0.09943 | STAND | -0.18264 | 0.08321 | HIT -0.09943; STAND -0.18264; DOUBLE -0.28651; SURRENDER -0.50000 |
| A,8 vs 6 | STAND | 0.49392 | DOUBLE | 0.48004 | 0.01389 | STAND 0.49392; DOUBLE 0.48004; HIT 0.24002; SURRENDER -0.50000 |
| 8,8 vs 10 | SPLIT | -0.47516 | SURRENDER | -0.50000 | 0.02484 | SPLIT -0.47516; SURRENDER -0.50000; HIT -0.53511; STAND -0.53685; DOUBLE -1.07022 |

## How to read a margin

A margin below roughly `0.002` per unit sits inside the combined uncertainty of the approximations listed above and of whatever composition basis the reference chart used. Such a cell is a genuine coin flip: either play costs a fraction of a percent of one bet, and a difference there is not evidence that anything is wrong. A margin above that is substantive and should be chased down in the solver rather than absorbed.
