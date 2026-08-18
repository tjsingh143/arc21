/**
 * Arc 21 — expected-value helpers for the strategy advisor.
 *
 * **Precomputed lookup only.** Nothing in this module solves anything: every
 * number it returns was computed once, at generation time, by
 * `scripts/generate-strategy-tables.ts`. A recursive solve during a render pass
 * would be both far too slow for a 60fps table and a second source of truth for
 * strategy, and there is only ever one.
 *
 * Units: every `ev` is the expected net result of an action **per unit of the
 * ORIGINAL wager**, conditional on the dealer not holding a natural. Doubling
 * therefore ranges over [-2, +2] while standing ranges over [-1, +1] — a
 * doubled loss really does cost twice the original bet, and flattening that
 * would understate the cost of a bad double.
 *
 * **Legality is part of the answer, not a caller's afterthought.** A chart cell
 * is total-dependent: `hard:16:10` is served for a three-card 16 and for a 16
 * on a split hand, where the engine allows neither SURRENDER nor DOUBLE. Its
 * priced actions therefore include plays that were never on the table. Grading
 * a player against the best *priced* action would charge them 0.0346 of a bet
 * for not surrendering a hand that could not be surrendered — the advisor is
 * careful never to recommend an illegal action, and the EV helpers must be
 * equally careful never to price one as the play they should have made. That is
 * why `evMistakeForDecision` takes the legal action set rather than accepting
 * an optional hint, and why the unfiltered list is named plainly as such.
 */

import type { PlayerActionType } from "../engine-primitives.ts";
import type { ActionEV, StrategyAction, StrategyDecision } from "./types.ts";

export type { ActionEV } from "./types.ts";

/**
 * The engine's own action vocabulary is accepted anywhere a strategy action is,
 * so `getLegalActions(...).actions` can be passed straight in.
 */
export type LegalActionSet = readonly StrategyAction[] | readonly PlayerActionType[];

function isLegal(action: StrategyAction, legalActions: LegalActionSet): boolean {
  // Defensive: a JavaScript caller (or a stale call site) can pass undefined
  // through the typed parameter. Treating that as "nothing is legal" makes the
  // helpers return null, which the UI already handles by hiding the number.
  // Throwing here would take down the table mid-hand over a missing argument.
  if (!Array.isArray(legalActions)) return false;
  return (legalActions as readonly string[]).includes(action);
}

/**
 * The highest-EV action in a list, or null when the list is empty.
 *
 * Ties keep the earlier entry, so the caller's ordering decides — pass the
 * conservative action first if a coin flip should not advise committing chips.
 */
export function bestEV(list: readonly ActionEV[]): ActionEV | null {
  let best: ActionEV | null = null;
  for (const candidate of list) {
    if (best === null || candidate.ev > best.ev) best = candidate;
  }
  return best;
}

function evOf(value: ActionEV | number): number {
  return typeof value === "number" ? value : value.ev;
}

/**
 * How much expectation a decision gave up: `best - chosen`, in units of the
 * original wager.
 *
 * Never negative. If the "chosen" action scores above the "best" one the caller
 * has passed something that was not actually the best, and reporting a negative
 * mistake to a learning UI would read as a reward for a wrong play; the clamp
 * turns that into an honest zero instead.
 */
export function evMistake(best: ActionEV | number, chosen: ActionEV | number): number {
  const delta = evOf(best) - evOf(chosen);
  return delta > 0 ? delta : 0;
}

/** Raw, unclamped `best - chosen`. Useful when a test wants to see the sign. */
export function evDelta(best: ActionEV | number, chosen: ActionEV | number): number {
  return evOf(best) - evOf(chosen);
}

/**
 * Every action the generator priced for this cell, best first — **including
 * actions that may be illegal for the hand in front of the player**.
 *
 * This is the chart view: what the cell is worth in the abstract, which is what
 * a strategy-chart or cell-detail screen wants to show. Anything that grades a
 * decision a player actually faced wants `legalActionEVs` instead.
 *
 * Returns an empty list when the decision carries no EVs — a table emitted
 * without them is still usable for advice, and callers must not invent numbers
 * to fill the gap.
 */
export function actionEVs(decision: StrategyDecision): ActionEV[] {
  const evs = decision.evs;
  if (evs === undefined) return [];

  const list: ActionEV[] = [];
  for (const [action, ev] of Object.entries(evs)) {
    if (typeof ev === "number" && Number.isFinite(ev)) {
      list.push({ action: action as StrategyAction, ev });
    }
  }
  return list.sort((a, b) => b.ev - a.ev);
}

/**
 * The priced actions that are actually available, best first.
 *
 * Pass the same set the advisor was given — `getLegalActions(...).actions`.
 * An action with no price is omitted rather than assumed: "we did not compute
 * that" is not the same as "it is worthless".
 */
export function legalActionEVs(decision: StrategyDecision, legalActions: LegalActionSet): ActionEV[] {
  return actionEVs(decision).filter((entry) => isLegal(entry.action, legalActions));
}

/**
 * The best action the player could actually have taken, or null when the cell
 * prices none of them.
 */
export function bestLegalEV(
  decision: StrategyDecision,
  legalActions: LegalActionSet,
): ActionEV | null {
  return bestEV(legalActionEVs(decision, legalActions));
}

/** The precomputed EV of one action, or null when the cell does not price it. */
export function evForAction(decision: StrategyDecision, action: StrategyAction): number | null {
  const ev = decision.evs?.[action];
  return typeof ev === "number" && Number.isFinite(ev) ? ev : null;
}

/**
 * What playing `chosen` cost against the best action that was **available**,
 * per unit of the original wager.
 *
 * `legalActions` is required, and is the same set the advisor was given. A
 * three-card 16 vs a ten reads the `hard:16:10` cell, which prices SURRENDER at
 * -0.5 — but surrender is long gone by the third card, so grading against it
 * would bill the player 0.0346 of a bet for a play the engine would have
 * rejected. Chart-wide numbers are still available through `actionEVs`; this
 * function is about a decision someone really made.
 *
 * Returns null rather than 0 when the answer is unknown: the cell prices no
 * legal action, `chosen` was not legal, or `chosen` is unpriced. Zero would
 * claim "that play was free", which is a different statement from "we do not
 * know", and the learning product must never conflate them.
 */
export function evMistakeForDecision(
  decision: StrategyDecision,
  chosen: StrategyAction,
  legalActions: LegalActionSet,
): number | null {
  if (!isLegal(chosen, legalActions)) return null;
  const best = bestLegalEV(decision, legalActions);
  if (best === null) return null;
  const chosenEv = evForAction(decision, chosen);
  if (chosenEv === null) return null;
  return evMistake(best, chosenEv);
}
