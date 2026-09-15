/**
 * Arc 21 — the expected-value solver behind the basic-strategy chart.
 * DEVELOPMENT TOOLING: nothing under `shared/`, `src/` or `app/` imports this.
 *
 * The CLI that drives it and writes the generated table is
 * `scripts/generate-strategy-tables.ts`. This module holds the mathematics so
 * it can be exercised directly by `tests/strategy/solver.test.ts` — a solver
 * whose dealer distribution is only ever checked through its own chart output
 * is a solver nobody has actually verified.
 *
 * ===========================================================================
 * METHOD
 * ===========================================================================
 *
 * Every EV is expressed per unit of the ORIGINAL wager, and every EV is
 * conditional on the dealer not holding a natural — which is exactly the state
 * the player is in whenever a decision is offered under a peeking ruleset.
 *
 * 1. SHOE MODEL.  A real six-deck composition: 24 of each rank value 1..9 and
 *    96 ten-value cards, 312 cards. **There is no infinite-deck approximation
 *    anywhere in this solver**, which is why the emitted metadata can set
 *    `infiniteDeckApproximationUsed: false` as a fact rather than a hope.
 *
 * 2. KNOWN-CARD REMOVAL.  The player's own cards and the dealer's upcard are
 *    removed from the shoe before anything is computed, so a 16 made of {10,6}
 *    and a 16 made of {9,7} get genuinely different numbers.
 *
 * 3. DEALER DISTRIBUTION.  Exact recursion over the dealer's draws with card
 *    removal at every step, honouring S17/H17 from the ruleset. The hole card
 *    is drawn from the post-removal shoe, and when the ruleset peeks the
 *    hole-card distribution is **conditioned on the peek finding no natural**:
 *    a ten upcard cannot hold an ace beneath it, an ace upcard cannot hold a
 *    ten, and the surviving hole cards are renormalised. Omitting this
 *    conditioning is the classic way to produce a chart that is quietly wrong
 *    against 10 and A.
 *
 * 4. PLAYER DRAWS.  Exact recursion with card removal. At every drawn card the
 *    player takes max(stand, hit), so the hit EV is the EV of optimal
 *    continuation rather than of "hit exactly once".
 *
 * 5. DOUBLE.  2 x E[one card, then forced stand], a bust costing -2.
 *
 * 6. SPLIT.  Recursion over the pending split hands that tracks the hand count
 *    exactly, so `maxSplitHands` binds where it really binds. At each first
 *    card the solver takes max(play this hand out, resplit into one more hand)
 *    whenever a resplit is legal. Split hands are played with DAS per the
 *    ruleset and without surrender. Split aces receive exactly one card and
 *    stand, and a resulting 21 settles as an ordinary 21, per
 *    `splitAceTwentyOneIsBlackjack: false`.
 *
 * 7. SURRENDER.  Exactly -0.5.
 *
 * 8. TOTAL-DEPENDENT AGGREGATION.  A chart cell covers every hand of that class
 *    and total, so each cell is the probability-weighted average over the card
 *    combinations that make it, weighted by how often the shoe deals them.
 *    "Hard 16 vs 10" is the average over {10,6}, {9,7} and {8,8}.
 *
 * ===========================================================================
 * APPROXIMATIONS — the complete list
 * ===========================================================================
 *
 * Repeated verbatim in `SOLVER_APPROXIMATIONS` below and written into every
 * generated table's metadata, so an approximation can never be discovered only
 * by reading source.
 *
 * A. FROZEN DEALER DISTRIBUTION.  The dealer's final-total distribution is
 *    conditioned on the known cards (the player's initial cards and the upcard)
 *    but is not recomputed as the player draws further cards. The player's own
 *    draw probabilities do deplete exactly; only the dealer's distribution is
 *    held at the pre-hit composition. Recomputing it along every player-draw
 *    path is a different order of computation entirely; the residual error is
 *    around 1e-4 per EV and matters only where the top two actions are already
 *    within a thousandth of each other. Those cells are listed by margin in
 *    `docs/STRATEGY_VALIDATION.md`.
 *
 * B. INDEPENDENT SPLIT HANDS.  The first card of each split hand is dealt with
 *    exact removal, but cards consumed while playing one split hand are not
 *    removed from the shoe its siblings see.
 *
 * C. TWO-CARD COMPOSITION BASIS.  Cells are averaged over two-card hands
 *    (three-card for hard 21 and soft 21, which two cards cannot make) and then
 *    applied to hands of the same total whatever their card count. That is what
 *    "total-dependent basic strategy" means, and it is the same basis published
 *    charts use.
 *
 * D. UNLIMITED BANKROLL.  Doubles and splits are costed as always affordable.
 *    Affordability is a legality question and is resolved at lookup time from
 *    the caller's legal action set.
 *
 * E. NO INSURANCE.  Insurance is a separate wager with its own expectation and
 *    is never part of a basic-strategy cell.
 */

import { dealerMustDraw } from "../shared/blackjack/hand-value.js";
import type { BlackjackRules } from "../shared/blackjack/rules.js";
import { DEALER_UPCARD_VALUES, normalizeStrategyKey } from "../supabase/functions/_shared/strategy/keys.js";
import type { HandClass, StrategyAction, StrategyState } from "../supabase/functions/_shared/strategy/types.js";

export const SOLVER_APPROXIMATIONS: readonly string[] = [
  "Dealer final-total distribution is conditioned on the known cards (player's initial cards + upcard) but is not recomputed as the player draws further cards.",
  "Split hands share the shoe only through their first cards; cards consumed while playing one split hand are not removed from the shoe seen by its siblings.",
  "Chart cells are averaged over two-card compositions (three-card for hard 21 and soft 21, which two cards cannot make), then applied to hands of the same total regardless of card count.",
  "Doubles and splits are costed as always affordable; affordability is enforced at lookup time by the caller's legal action set.",
  "Insurance is excluded; it is a separate wager with its own expectation and is never part of a basic-strategy cell.",
];

// ===========================================================================
// Shoe composition primitives
// ===========================================================================

/**
 * Card values as the solver counts them: an ace is 1 here and is promoted to 11
 * by hand evaluation, exactly as `evaluateHand` treats `hardTotal`.
 */
const VALUES: readonly number[] = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];

/** Counts indexed 1..10; index 0 is unused. */
export type Counts = number[];

function at(counts: Counts, value: number): number {
  return counts[value] ?? 0;
}

export function fullShoe(deckCount: number): Counts {
  const counts: Counts = new Array<number>(11).fill(0);
  for (let value = 1; value <= 9; value++) counts[value] = 4 * deckCount;
  counts[10] = 16 * deckCount;
  return counts;
}

export function totalCards(counts: Counts): number {
  let n = 0;
  for (let value = 1; value <= 10; value++) n += at(counts, value);
  return n;
}

function compositionKey(counts: Counts): string {
  let key = "";
  for (let value = 1; value <= 10; value++) {
    key += `${at(counts, value)}.`;
  }
  return key;
}

/** Best total for a hard total plus ace flag, matching `evaluateHand`. */
function bestTotalOf(hardTotal: number, hasAce: boolean): number {
  return hasAce && hardTotal + 10 <= 21 ? hardTotal + 10 : hardTotal;
}

// ===========================================================================
// Dealer final-total distribution
// ===========================================================================

/** Index 0..4 are dealer totals 17..21; index 5 is bust. */
export type DealerDistribution = number[];

export const DEALER_BUST_INDEX = 5;

function bustDistribution(): DealerDistribution {
  return [0, 0, 0, 0, 0, 1];
}

function standDistribution(total: number): DealerDistribution {
  const dist: DealerDistribution = [0, 0, 0, 0, 0, 0];
  dist[total - 17] = 1;
  return dist;
}

function accumulate(into: DealerDistribution, from: DealerDistribution, weight: number): void {
  for (let i = 0; i < 6; i++) {
    into[i] = (into[i] ?? 0) + weight * (from[i] ?? 0);
  }
}

/**
 * Dealer draw recursion with exact card removal.
 *
 * The dealer is not an opponent making choices — it is the fixed procedure in
 * `docs/BLACKJACK_RULES.md`: draw below 17, stand at 17 or better, and hit soft
 * 17 only when the ruleset says so (Arc Standard says no).
 */
function dealerDrawDistribution(
  counts: Counts,
  hardTotal: number,
  hasAce: boolean,
  rules: BlackjackRules,
  memo: Map<string, DealerDistribution>,
): DealerDistribution {
  const soft = hasAce && hardTotal + 10 <= 21;
  const best = soft ? hardTotal + 10 : hardTotal;

  if (best > 21) return bustDistribution();

  // The engine's rule, imported rather than restated. See `dealerMustDraw`.
  const mustDraw = dealerMustDraw({ bestTotal: best, isSoft: soft }, rules);
  if (!mustDraw) return standDistribution(best);

  const key = `${compositionKey(counts)}|${hardTotal}|${hasAce ? 1 : 0}`;
  const cached = memo.get(key);
  if (cached !== undefined) return cached;

  const remaining = totalCards(counts);
  const out: DealerDistribution = [0, 0, 0, 0, 0, 0];

  for (const value of VALUES) {
    const available = at(counts, value);
    if (available === 0) continue;
    counts[value] = available - 1;
    const sub = dealerDrawDistribution(
      counts,
      hardTotal + value,
      hasAce || value === 1,
      rules,
      memo,
    );
    counts[value] = available;
    accumulate(out, sub, available / remaining);
  }

  memo.set(key, out);
  return out;
}

/**
 * Dealer final-total distribution for an upcard, given a shoe from which the
 * upcard and the player's cards have already been removed.
 *
 * When the ruleset peeks, the hole-card distribution is conditioned on the peek
 * finding nothing. Every EV downstream is therefore conditional on "the dealer
 * looked and does not have blackjack", which is the only state in which a
 * decision is ever offered.
 *
 * `counts` is restored to its input value before returning.
 */
export function dealerFinalDistribution(
  counts: Counts,
  upcard: number,
  rules: BlackjackRules,
): DealerDistribution {
  if (!rules.dealerHoleCard || !rules.dealerPeeksForBlackjack) {
    throw new Error(
      "This solver models American peek rulesets only. A no-hole-card ruleset " +
        "changes what a dealer natural costs a doubled or split hand, and needs " +
        "its own settlement model rather than a silent reinterpretation of this one.",
    );
  }

  const naturalHole = upcard === 1 ? 10 : upcard === 10 ? 1 : 0;

  let denominator = 0;
  for (const value of VALUES) {
    if (value === naturalHole) continue;
    denominator += at(counts, value);
  }

  const memo = new Map<string, DealerDistribution>();
  const out: DealerDistribution = [0, 0, 0, 0, 0, 0];

  for (const hole of VALUES) {
    if (hole === naturalHole) continue;
    const available = at(counts, hole);
    if (available === 0) continue;
    counts[hole] = available - 1;
    const sub = dealerDrawDistribution(
      counts,
      upcard + hole,
      upcard === 1 || hole === 1,
      rules,
      memo,
    );
    counts[hole] = available;
    accumulate(out, sub, available / denominator);
  }

  return out;
}

/** P(dealer holds a natural | upcard), from the post-removal shoe. */
export function dealerNaturalProbability(counts: Counts, upcard: number): number {
  if (upcard !== 1 && upcard !== 10) return 0;
  const naturalHole = upcard === 1 ? 10 : 1;
  return at(counts, naturalHole) / totalCards(counts);
}

// ===========================================================================
// Player expectations
// ===========================================================================

interface PlayerContext {
  rules: BlackjackRules;
  /** Stand EV indexed by best total, 0..21. */
  standEV: number[];
  hitMemo: Map<string, number>;
}

export function standEVForTotal(best: number, dist: DealerDistribution): number {
  let ev = dist[DEALER_BUST_INDEX] ?? 0;
  for (let dealerTotal = 17; dealerTotal <= 21; dealerTotal++) {
    const p = dist[dealerTotal - 17] ?? 0;
    if (best > dealerTotal) ev += p;
    else if (best < dealerTotal) ev -= p;
  }
  return ev;
}

function createPlayerContext(rules: BlackjackRules, dist: DealerDistribution): PlayerContext {
  const standEV = new Array<number>(22).fill(0);
  for (let total = 0; total <= 21; total++) {
    standEV[total] = standEVForTotal(total, dist);
  }
  return { rules, standEV, hitMemo: new Map<string, number>() };
}

function standEVOf(ctx: PlayerContext, best: number): number {
  return ctx.standEV[best] ?? -1;
}

/**
 * EV of hitting and then continuing optimally, with exact card removal on every
 * draw.
 *
 * A hand that reaches 21 stands: Arc 21 auto-completes 21 (see
 * `docs/BLACKJACK_RULES.md`) and hitting a 21 could only bust it.
 */
function hitEV(counts: Counts, hardTotal: number, hasAce: boolean, ctx: PlayerContext): number {
  const key = `${compositionKey(counts)}|${hardTotal}|${hasAce ? 1 : 0}`;
  const cached = ctx.hitMemo.get(key);
  if (cached !== undefined) return cached;

  const remaining = totalCards(counts);
  let ev = 0;

  for (const value of VALUES) {
    const available = at(counts, value);
    if (available === 0) continue;
    const p = available / remaining;

    const nextHard = hardTotal + value;
    if (nextHard > 21) {
      ev -= p;
      continue;
    }

    const nextHasAce = hasAce || value === 1;
    const nextBest = bestTotalOf(nextHard, nextHasAce);
    const stand = standEVOf(ctx, nextBest);

    if (nextBest === 21) {
      ev += p * stand;
      continue;
    }

    counts[value] = available - 1;
    const hit = hitEV(counts, nextHard, nextHasAce, ctx);
    counts[value] = available;

    ev += p * Math.max(stand, hit);
  }

  ctx.hitMemo.set(key, ev);
  return ev;
}

/** EV of doubling: one card, forced stand, doubled stake. */
function doubleEV(counts: Counts, hardTotal: number, hasAce: boolean, ctx: PlayerContext): number {
  const remaining = totalCards(counts);
  let ev = 0;

  for (const value of VALUES) {
    const available = at(counts, value);
    if (available === 0) continue;
    const p = available / remaining;

    const nextHard = hardTotal + value;
    if (nextHard > 21) {
      ev -= p;
      continue;
    }
    ev += p * standEVOf(ctx, bestTotalOf(nextHard, hasAce || value === 1));
  }

  return 2 * ev;
}

/**
 * EV of splitting a pair, summed over every hand the split produces.
 *
 * `pending` is how many hands still need their first card; `handsTotal` is how
 * many hands exist. Tracking both makes the `maxSplitHands` cap exact rather
 * than a depth heuristic: a hand may resplit only while `handsTotal` is below
 * the cap, and a resplit turns one pending hand into two.
 */
function splitEV(
  pairValue: number,
  counts: Counts,
  ctx: PlayerContext,
  rules: BlackjackRules,
): number {
  const splittingAces = pairValue === 1;
  const resplitAllowed = splittingAces ? rules.resplitAcesAllowed : true;
  const oneCardOnly = splittingAces && !rules.hitSplitAcesAllowed;
  const doubleAllowedHere =
    rules.doubleAllowed &&
    rules.doubleOnAnyTwoCards &&
    rules.doubleAfterSplit &&
    (!splittingAces || rules.doubleSplitAcesAllowed);

  const pendingMemo = new Map<string, number>();

  /** EV of one split hand that has just received `drawn` as its second card. */
  function playSplitHand(drawn: number): number {
    const hardTotal = pairValue + drawn;
    const hasAce = pairValue === 1 || drawn === 1;
    const best = bestTotalOf(hardTotal, hasAce);
    const stand = standEVOf(ctx, best);

    if (oneCardOnly) return stand;
    if (best === 21) return stand;

    let bestEv = Math.max(stand, hitEV(counts, hardTotal, hasAce, ctx));
    if (doubleAllowedHere) {
      bestEv = Math.max(bestEv, doubleEV(counts, hardTotal, hasAce, ctx));
    }
    return bestEv;
  }

  function resolvePending(pending: number, handsTotal: number): number {
    if (pending === 0) return 0;

    const key = `${pending}|${handsTotal}|${compositionKey(counts)}`;
    const cached = pendingMemo.get(key);
    if (cached !== undefined) return cached;

    const remaining = totalCards(counts);
    let ev = 0;

    for (const value of VALUES) {
      const available = at(counts, value);
      if (available === 0) continue;
      const p = available / remaining;

      counts[value] = available - 1;

      // Play this hand out, then resolve whatever is still pending...
      let branch = playSplitHand(value) + resolvePending(pending - 1, handsTotal);

      // ...or, if the draw pairs up again and the cap allows it, split once
      // more: this hand becomes two hands that both still need a first card.
      if (value === pairValue && resplitAllowed && handsTotal < rules.maxSplitHands) {
        branch = Math.max(branch, resolvePending(pending + 1, handsTotal + 1));
      }

      counts[value] = available;
      ev += p * branch;
    }

    pendingMemo.set(key, ev);
    return ev;
  }

  return resolvePending(2, 2);
}

// ===========================================================================
// Solving one concrete hand
// ===========================================================================

export interface ActionEVs {
  STAND: number;
  HIT: number;
  DOUBLE: number | null;
  SPLIT: number | null;
  SURRENDER: number | null;
}

/**
 * The two probabilities the Analysis surface is allowed to show.
 *
 * Both come out of the SAME solve that produces the EVs above — the same
 * depleted shoe, the same peek-conditioned dealer distribution — rather than
 * from a second model that could drift from the first. That is the whole reason
 * they are computed here instead of being estimated at render time: a number a
 * player is shown next to an EV must have been produced by the same arithmetic
 * as the EV, or the two can disagree and nothing will notice.
 *
 * They carry the solver's documented approximations and no others.
 */
export interface CompositionProbabilities {
  /**
   * P(the next single card takes this hand over 21).
   *
   * Zero for every soft hand — a hand whose ace can drop from 11 to 1 cannot
   * bust on one card — and that zero is a real answer, not a missing one.
   */
  bustIfHit: number;
  /**
   * P(dealer's final total is a bust), conditioned exactly as every EV here is:
   * the dealer has already peeked and does not hold a natural, and the player's
   * own cards are out of the shoe.
   */
  dealerBust: number;
}

export type CompositionSolution = ActionEVs & CompositionProbabilities;

/**
 * P(the next single card busts a hand of this hard total), from the shoe as it
 * actually stands after removal.
 *
 * Exported so `tests/strategy/solver.test.ts` can check it against a hand
 * counted by hand rather than against another run of this function.
 */
export function bustIfHitProbability(
  counts: Counts,
  hardTotal: number,
  hasAce: boolean,
): number {
  const remaining = totalCards(counts);
  if (remaining === 0) return 0;

  let busts = 0;
  for (const value of VALUES) {
    const available = at(counts, value);
    if (available === 0) continue;
    if (bestTotalOf(hardTotal + value, hasAce || value === 1) > 21) busts += available;
  }
  return busts / remaining;
}

export interface CompositionOptions {
  allowDouble: boolean;
  allowSplit: boolean;
  allowSurrender: boolean;
}

/**
 * Full EV set for a concrete hand (a multiset of card values, aces as 1)
 * against a concrete upcard, with the shoe depleted of exactly those cards.
 */
export function solveComposition(
  cards: readonly number[],
  upcard: number,
  rules: BlackjackRules,
  options: CompositionOptions,
): CompositionSolution {
  const counts = fullShoe(rules.deckCount);
  counts[upcard] = at(counts, upcard) - 1;
  for (const card of cards) {
    counts[card] = at(counts, card) - 1;
  }

  const dist = dealerFinalDistribution(counts, upcard, rules);
  const ctx = createPlayerContext(rules, dist);

  let hardTotal = 0;
  let hasAce = false;
  for (const card of cards) {
    hardTotal += card;
    if (card === 1) hasAce = true;
  }
  const best = bestTotalOf(hardTotal, hasAce);

  const stand = standEVOf(ctx, best);
  const hit = best === 21 ? stand : hitEV(counts, hardTotal, hasAce, ctx);

  const double =
    options.allowDouble && rules.doubleAllowed && rules.doubleOnAnyTwoCards
      ? doubleEV(counts, hardTotal, hasAce, ctx)
      : null;

  const surrender = options.allowSurrender && rules.lateSurrenderAllowed ? -0.5 : null;

  let split: number | null = null;
  if (options.allowSplit) {
    const pairValue = cards[0] ?? 0;
    const aceSplitOk = pairValue !== 1 || rules.splitAcesAllowed;
    if (aceSplitOk && rules.maxSplitHands >= 2) {
      split = splitEV(pairValue, counts, ctx, rules);
    }
  }

  return {
    STAND: stand,
    HIT: hit,
    DOUBLE: double,
    SPLIT: split,
    SURRENDER: surrender,
    bustIfHit: bustIfHitProbability(counts, hardTotal, hasAce),
    dealerBust: dist[DEALER_BUST_INDEX] ?? 0,
  };
}

// ===========================================================================
// Composition enumeration and weighting
// ===========================================================================

export function combinations(n: number, k: number): number {
  if (k < 0 || k > n) return 0;
  let result = 1;
  for (let i = 0; i < k; i++) {
    result = (result * (n - i)) / (i + 1);
  }
  return result;
}

/** Ways to be dealt this exact multiset from a shoe with the upcard removed. */
export function dealWays(
  cards: readonly number[],
  upcard: number,
  rules: BlackjackRules,
): number {
  const shoe = fullShoe(rules.deckCount);
  shoe[upcard] = at(shoe, upcard) - 1;

  const multiplicity = new Map<number, number>();
  for (const card of cards) {
    multiplicity.set(card, (multiplicity.get(card) ?? 0) + 1);
  }

  let ways = 1;
  for (const [value, count] of multiplicity) {
    ways *= combinations(at(shoe, value), count);
  }
  return ways;
}

/**
 * The card combinations a chart row covers.
 *
 * Two-card hands are the basis wherever they exist. Hard 21 and soft 21 cannot
 * be made with two cards — A+10 is a natural, not a decision — so those two
 * rows fall back to three-card hands.
 */
export function enumerateCompositions(
  handClass: HandClass,
  total: number,
  pairValue: number | undefined,
): number[][] {
  if (handClass === "pair") {
    const value = pairValue === 11 ? 1 : (pairValue ?? 0);
    return [[value, value]];
  }

  const twoCard: number[][] = [];
  for (let a = 1; a <= 10; a++) {
    for (let b = a; b <= 10; b++) {
      const hardTotal = a + b;
      const hasAce = a === 1 || b === 1;
      const soft = hasAce && hardTotal + 10 <= 21;
      const best = soft ? hardTotal + 10 : hardTotal;
      if (best !== total) continue;
      if (handClass === "soft" && !soft) continue;
      if (handClass === "hard" && soft) continue;
      // A two-card 21 is a natural, never a decision state.
      if (best === 21) continue;
      twoCard.push([a, b]);
    }
  }
  if (twoCard.length > 0) return twoCard;

  const threeCard: number[][] = [];
  for (let a = 1; a <= 10; a++) {
    for (let b = a; b <= 10; b++) {
      for (let c = b; c <= 10; c++) {
        const hardTotal = a + b + c;
        const hasAce = a === 1 || b === 1 || c === 1;
        const soft = hasAce && hardTotal + 10 <= 21;
        const best = soft ? hardTotal + 10 : hardTotal;
        if (best !== total) continue;
        if (handClass === "soft" && !soft) continue;
        if (handClass === "hard" && soft) continue;
        threeCard.push([a, b, c]);
      }
    }
  }
  return threeCard;
}

// ===========================================================================
// Row aggregation
// ===========================================================================

export interface RowResult {
  state: StrategyState;
  evs: Partial<Record<StrategyAction, number>>;
  recommendedAction: StrategyAction;
  fallbackAction?: StrategyAction;
  /** Sorted best-to-worst; used for margin reporting. */
  ranked: Array<{ action: StrategyAction; ev: number }>;
  /**
   * Averaged over the same compositions and the same weights as the EVs, so a
   * cell's probability and its EV always describe the same population of hands.
   */
  probabilities: CompositionProbabilities;
  compositions: Array<{ cards: number[]; weight: number; evs: CompositionSolution }>;
}

/**
 * Tie-break order, applied only when two actions have *identical* EV. The
 * conservative actions come first, so a genuine coin-flip never advises
 * committing extra chips.
 */
const TIE_BREAK_ORDER: readonly StrategyAction[] = ["STAND", "HIT", "DOUBLE", "SPLIT", "SURRENDER"];

function pickBest(candidates: ReadonlyArray<{ action: StrategyAction; ev: number }>): {
  action: StrategyAction;
  ev: number;
} {
  let best = candidates[0];
  if (best === undefined) {
    throw new Error("pickBest called with no candidates");
  }
  for (const candidate of candidates.slice(1)) {
    if (candidate.ev > best.ev) {
      best = candidate;
    } else if (candidate.ev === best.ev) {
      const bestRank = TIE_BREAK_ORDER.indexOf(best.action);
      const candidateRank = TIE_BREAK_ORDER.indexOf(candidate.action);
      if (candidateRank < bestRank) best = candidate;
    }
  }
  return best;
}

export function solveRow(
  handClass: HandClass,
  total: number,
  pairValue: number | undefined,
  upcard: number,
  rules: BlackjackRules,
): RowResult {
  const compositions = enumerateCompositions(handClass, total, pairValue);
  if (compositions.length === 0) {
    throw new Error(`No card composition makes ${handClass} ${total}`);
  }

  const weighted = compositions.map((cards) => ({
    cards,
    ways: dealWays(cards, upcard, rules),
  }));
  const totalWays = weighted.reduce((sum, entry) => sum + entry.ways, 0);
  if (totalWays <= 0) {
    throw new Error(`No dealable composition for ${handClass} ${total} vs ${upcard}`);
  }

  const isPairRow = handClass === "pair";
  const twoCard = (weighted[0]?.cards.length ?? 0) === 2;

  const options: CompositionOptions = {
    allowDouble: twoCard,
    // The hard/soft rows are the "not splitting" rows even when the only
    // two-card composition happens to be a pair (10,10 makes hard 20).
    allowSplit: isPairRow,
    allowSurrender: twoCard,
  };

  let stand = 0;
  let hit = 0;
  let doubleEv = 0;
  let splitEv = 0;
  let surrenderEv = 0;
  let doubleDefined = false;
  let splitDefined = false;
  let surrenderDefined = false;
  let bustIfHit = 0;
  let dealerBust = 0;

  const perComposition: RowResult["compositions"] = [];

  for (const entry of weighted) {
    if (entry.ways === 0) continue;
    const weight = entry.ways / totalWays;
    const evs = solveComposition(entry.cards, upcard, rules, options);

    stand += weight * evs.STAND;
    hit += weight * evs.HIT;
    if (evs.DOUBLE !== null) {
      doubleEv += weight * evs.DOUBLE;
      doubleDefined = true;
    }
    if (evs.SPLIT !== null) {
      splitEv += weight * evs.SPLIT;
      splitDefined = true;
    }
    if (evs.SURRENDER !== null) {
      surrenderEv += weight * evs.SURRENDER;
      surrenderDefined = true;
    }

    bustIfHit += weight * evs.bustIfHit;
    dealerBust += weight * evs.dealerBust;

    perComposition.push({ cards: entry.cards, weight, evs });
  }

  const evs: Partial<Record<StrategyAction, number>> = { STAND: stand, HIT: hit };
  if (doubleDefined) evs.DOUBLE = doubleEv;
  if (splitDefined) evs.SPLIT = splitEv;
  if (surrenderDefined) evs.SURRENDER = surrenderEv;

  const candidates: Array<{ action: StrategyAction; ev: number }> = [
    { action: "STAND", ev: stand },
    { action: "HIT", ev: hit },
  ];
  if (doubleDefined) candidates.push({ action: "DOUBLE", ev: doubleEv });
  if (splitDefined) candidates.push({ action: "SPLIT", ev: splitEv });
  if (surrenderDefined) candidates.push({ action: "SURRENDER", ev: surrenderEv });

  const best = pickBest(candidates);

  // The fallback answers "what if that action is not available right now?". It
  // is deliberately restricted to HIT and STAND — the two actions that are
  // always on the table — so resolution can never dead-end on a second
  // unavailable action.
  let fallbackAction: StrategyAction | undefined;
  if (best.action !== "HIT" && best.action !== "STAND") {
    fallbackAction = pickBest([
      { action: "STAND", ev: stand },
      { action: "HIT", ev: hit },
    ]).action;
  }

  const ranked = [...candidates].sort((a, b) => b.ev - a.ev);

  const state: StrategyState = isPairRow
    ? { handClass, playerTotal: total, pairValue, dealerUpcardValue: upcard === 1 ? 11 : upcard }
    : { handClass, playerTotal: total, dealerUpcardValue: upcard === 1 ? 11 : upcard };

  const result: RowResult = {
    state,
    evs,
    recommendedAction: best.action,
    ranked,
    probabilities: { bustIfHit, dealerBust },
    compositions: perComposition,
  };
  if (fallbackAction !== undefined) result.fallbackAction = fallbackAction;
  return result;
}

// ===========================================================================
// Chart construction
// ===========================================================================

/**
 * Hard 4 and soft 12 sit outside every published chart, because a two-card 4 or
 * soft 12 is always a pair and the pair row answers first. They are solved
 * anyway so that "you hold 2,2 but already have four hands" resolves through a
 * real computed cell instead of an invented default.
 */
export const HARD_TOTALS: readonly number[] = [
  4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21,
];
export const SOFT_TOTALS: readonly number[] = [12, 13, 14, 15, 16, 17, 18, 19, 20, 21];
export const PAIR_CARD_VALUES: readonly number[] = [2, 3, 4, 5, 6, 7, 8, 9, 10, 11];

export interface Chart {
  rows: RowResult[];
  byKey: Map<string, RowResult>;
}

export function solveChart(rules: BlackjackRules): Chart {
  const rows: RowResult[] = [];

  for (const upcardValue of DEALER_UPCARD_VALUES) {
    const upcard = upcardValue === 11 ? 1 : upcardValue;

    for (const total of HARD_TOTALS) {
      rows.push(solveRow("hard", total, undefined, upcard, rules));
    }
    for (const total of SOFT_TOTALS) {
      rows.push(solveRow("soft", total, undefined, upcard, rules));
    }
    for (const pairValue of PAIR_CARD_VALUES) {
      const cardValue = pairValue === 11 ? 1 : pairValue;
      const total = pairValue === 11 ? 12 : cardValue * 2;
      rows.push(solveRow("pair", total, pairValue, upcard, rules));
    }
  }

  const byKey = new Map<string, RowResult>();
  for (const row of rows) {
    byKey.set(normalizeStrategyKey(row.state), row);
  }
  return { rows, byKey };
}

// ===========================================================================
// Overall expectation — an independent, end-to-end sanity signal
// ===========================================================================

export function strategyStateForCards(cards: readonly number[], upcard: number): StrategyState {
  const dealerUpcardValue = upcard === 1 ? 11 : upcard;
  const first = cards[0] ?? 0;
  const second = cards[1] ?? 0;
  let hardTotal = 0;
  let hasAce = false;
  for (const card of cards) {
    hardTotal += card;
    if (card === 1) hasAce = true;
  }
  const best = bestTotalOf(hardTotal, hasAce);

  if (cards.length === 2 && first === second) {
    return {
      handClass: "pair",
      playerTotal: best,
      pairValue: first === 1 ? 11 : first,
      dealerUpcardValue,
    };
  }
  return {
    handClass: hasAce && hardTotal + 10 <= 21 ? "soft" : "hard",
    playerTotal: best,
    dealerUpcardValue,
  };
}

function resolveChartActionEV(row: RowResult, evs: ActionEVs): number {
  const direct = evs[row.recommendedAction];
  if (direct !== null && direct !== undefined) return direct;
  const fallback = row.fallbackAction;
  if (fallback !== undefined) {
    const value = evs[fallback];
    if (value !== null && value !== undefined) return value;
  }
  return Math.max(evs.STAND, evs.HIT);
}

/**
 * Expectation per unit wagered when the generated chart is actually played from
 * the top of the shoe, insurance always declined.
 *
 * This is the strongest end-to-end check available: a mistake in the dealer
 * distribution, in the peek conditioning or in the split model moves this number
 * clean out of the range every published analysis of a rule set like this one
 * agrees on.
 *
 * The chart's action is applied per hand; the continuation after a hit is
 * optimal play rather than chart play, which is the usual (very small) optimism
 * in a figure of this kind.
 */
export function overallExpectation(chart: Chart, rules: BlackjackRules): number {
  const shoe = fullShoe(rules.deckCount);
  const shoeSize = totalCards(shoe);

  let expectation = 0;
  let weightSum = 0;

  for (const upcardValue of DEALER_UPCARD_VALUES) {
    const upcard = upcardValue === 11 ? 1 : upcardValue;
    const upcardCount = at(shoe, upcard);
    const pUpcard = upcardCount / shoeSize;

    const afterUpcardSize = shoeSize - 1;

    for (let a = 1; a <= 10; a++) {
      for (let b = a; b <= 10; b++) {
        const ways = dealWays([a, b], upcard, rules);
        if (ways === 0) continue;
        const pHand = ways / combinations(afterUpcardSize, 2);
        const weight = pUpcard * pHand;
        weightSum += weight;

        const counts = fullShoe(rules.deckCount);
        counts[upcard] = at(counts, upcard) - 1;
        counts[a] = at(counts, a) - 1;
        counts[b] = at(counts, b) - 1;
        const pDealerNatural = dealerNaturalProbability(counts, upcard);

        const hardTotal = a + b;
        const hasAce = a === 1 || b === 1;
        const best = bestTotalOf(hardTotal, hasAce);

        if (best === 21) {
          // Player natural: push against a dealer natural, otherwise 3:2.
          const payout = rules.blackjackPayoutNumerator / rules.blackjackPayoutDenominator;
          expectation += weight * (1 - pDealerNatural) * payout;
          continue;
        }

        const key = normalizeStrategyKey(strategyStateForCards([a, b], upcard));
        const row = chart.byKey.get(key);
        if (row === undefined) {
          throw new Error(`No chart row for ${key}`);
        }

        const composition = row.compositions.find(
          (entry) => entry.cards.length === 2 && entry.cards[0] === a && entry.cards[1] === b,
        );
        if (composition === undefined) {
          throw new Error(`No solved composition ${a},${b} in row ${key}`);
        }

        const chosen = resolveChartActionEV(row, composition.evs);
        expectation += weight * (pDealerNatural * -1 + (1 - pDealerNatural) * chosen);
      }
    }
  }

  // `weightSum` is 1 when every combination is accounted for. Dividing keeps the
  // figure honest rather than quietly under-reporting the edge if one is ever
  // skipped.
  return expectation / weightSum;
}
