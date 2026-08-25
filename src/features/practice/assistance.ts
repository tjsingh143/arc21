/**
 * Arc 21 — what each assistance mode does, as data.
 *
 * The four modes differ in exactly two places: what is on screen WHILE the
 * player decides, and what is on screen AFTER they have. Those two facts used
 * to live as conditions inside the table's JSX — `if (mode === "play" || mode
 * === "challenge") return null` — which meant the product's central teaching
 * contract was only checkable by reading a render function, and only testable by
 * rendering one.
 *
 * This project has been bitten by exactly that shape before: `lockBet` was
 * written, unit-tested and correct, and wired to a button that could not be
 * pressed. The lesson recorded from it is to extract the predicate and assert
 * the predicate. So the contract is here, the components read it, and
 * `tests/features/assistance.test.ts` asserts it directly.
 *
 * THE CONTRACT (from the specification's own table):
 *
 *   Mode       During the decision                      After it
 *   ────────────────────────────────────────────────────────────────────────
 *   Play       nothing                                  hand history only
 *   Learn      "Recommended: HIT", expandable to why    the normal result
 *   Analysis   collapsed chip → EV for every action     the full decision log
 *   Challenge  nothing                                  correct/incorrect,
 *                                                       the ideal action and
 *                                                       the mistake's size
 *
 * Two consequences worth stating, because both are load-bearing:
 *
 *   - Play and Challenge must be IDENTICAL during the decision. If Challenge
 *     showed anything, its grade would measure reading rather than recall, and
 *     the unaided accuracy figure — the headline of the whole Statistics screen
 *     — would be measuring nothing.
 *   - Play must not gain a decision log after the hand. It is the mode for
 *     playing without being coached, and a graded transcript at the end is
 *     coaching with a delay.
 *
 * Runtime-neutral: no React, no React Native.
 */

import type { AssistanceMode } from "./practice-store.js";
import type { TableAdvice } from "./advice.js";

/** Every mode, in the order the selector shows them. */
export const ASSISTANCE_MODES: readonly AssistanceMode[] = [
  "play",
  "learn",
  "analysis",
  "challenge",
];

export interface AssistanceModeDefinition {
  id: AssistanceMode;
  label: string;
  /** The selector's accessibility hint. One line, plain. */
  hint: string;
  /** Is a recommendation on screen while the player is choosing? */
  revealsAnswerBeforeDecision: boolean;
  /** Does the panel expand to per-action expected values? */
  showsExpectedValues: boolean;
  /** Is the choice graded on screen immediately afterwards? */
  gradesAfterDecision: boolean;
  /** What the after-the-hand review offers, in tab order. */
  reviewTabs: readonly ReviewTab[];
}

export type ReviewTab = "hands" | "decisions";

export const ASSISTANCE_MODE_DEFINITIONS: Readonly<
  Record<AssistanceMode, AssistanceModeDefinition>
> = {
  play: {
    id: "play",
    label: "Play",
    hint: "No assistance",
    revealsAnswerBeforeDecision: false,
    showsExpectedValues: false,
    gradesAfterDecision: false,
    reviewTabs: ["hands"],
  },
  learn: {
    id: "learn",
    label: "Learn",
    hint: "Shows the recommended play",
    revealsAnswerBeforeDecision: true,
    showsExpectedValues: false,
    gradesAfterDecision: false,
    reviewTabs: ["hands"],
  },
  analysis: {
    id: "analysis",
    label: "Analysis",
    hint: "Shows expected value for every action",
    revealsAnswerBeforeDecision: true,
    showsExpectedValues: true,
    gradesAfterDecision: false,
    reviewTabs: ["decisions", "hands"],
  },
  challenge: {
    id: "challenge",
    label: "Challenge",
    hint: "Grades each decision after you make it",
    revealsAnswerBeforeDecision: false,
    showsExpectedValues: false,
    gradesAfterDecision: true,
    reviewTabs: ["hands"],
  },
};

export function assistanceMode(mode: AssistanceMode): AssistanceModeDefinition {
  return ASSISTANCE_MODE_DEFINITIONS[mode];
}

/**
 * Whether a decision made in this mode measures the player rather than their
 * reading. The unaided accuracy figure counts exactly these.
 */
export function isUnaided(mode: AssistanceMode): boolean {
  return !assistanceMode(mode).revealsAnswerBeforeDecision;
}

/**
 * Whether the strategy panel renders at all.
 *
 * Two independent reasons for silence, and they are not the same reason:
 * the MODE withholds the answer (Play, Challenge), or the TABLES have no answer
 * to give. The second is the fail-safe contract — a missing recommendation
 * hides the hint and never substitutes a guess — and it applies in every mode.
 */
export function showsStrategyPanel(mode: AssistanceMode, advice: TableAdvice): boolean {
  if (!assistanceMode(mode).revealsAnswerBeforeDecision) return false;
  return advice.recommendation !== null;
}

/**
 * Whether the solver's probabilities for this position are on screen.
 *
 * Two independent gates, and both must hold. The MODE has to be the one that
 * expands to numbers — Learn's one-line rationale is deliberately not a
 * dashboard — and the TABLE being served has to actually carry them. A table
 * generated before probabilities existed is still a valid table; the honest
 * response to its silence is to render nothing, never to compute a substitute
 * here. A probability produced by different arithmetic, sitting beside
 * solver-exact EVs, is indistinguishable from one of them.
 */
export function showsProbabilities(mode: AssistanceMode, advice: TableAdvice): boolean {
  if (!showsStrategyPanel(mode, advice)) return false;
  if (!assistanceMode(mode).showsExpectedValues) return false;
  return advice.probabilities !== null;
}

/** Whether post-decision grading is surfaced at the table in this mode. */
export function showsChallengeFeedback(mode: AssistanceMode): boolean {
  return assistanceMode(mode).gradesAfterDecision;
}

/** Which review tabs this mode is allowed to see, in the order they appear. */
export function reviewTabsFor(mode: AssistanceMode): readonly ReviewTab[] {
  return assistanceMode(mode).reviewTabs;
}

/** The review control's label for a mode. */
export function reviewLabelFor(mode: AssistanceMode): string {
  return reviewTabsFor(mode)[0] === "decisions" ? "Decision log" : "Hand history";
}
