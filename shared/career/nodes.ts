/**
 * Arc 21 — the eighteen MVP career nodes.
 *
 * Runtime-neutral data. Three chapters of six, played in order; each node needs
 * only ONE star from its predecessor to unlock, so a run of bad cards can slow
 * a player down but can never wall them out (see `stars.ts`).
 *
 * Every threshold here is an integer percentage. Star evaluation therefore
 * compares whole numbers and is exact at the boundary — a session that lands
 * on precisely 75% earns the 75% star, with no float rounding deciding it.
 *
 * The rules are the same Arc Standard rules Practice uses, at Casual stakes.
 * Career changes what you are asked to do; it never changes the game or the
 * dealer. There is no "harder dealer" anywhere in this product.
 */

import {
  ARC_STANDARD_RULES,
  rulesForTier,
  TABLE_TIERS,
  type BlackjackRules,
} from "../blackjack/rules.js";
import type {
  CareerChapter,
  CareerChapterId,
  CareerNode,
} from "./types.js";

/**
 * Career runs at Casual stakes (min 20, max 500) so a 2,000-chip session
 * bankroll stays playable for thirty hands without forcing large bets.
 */
export const CAREER_RULES: BlackjackRules = rulesForTier(
  TABLE_TIERS.find((tier) => tier.id === "casual") ?? TABLE_TIERS[0]!,
  ARC_STANDARD_RULES,
);

/**
 * Session bankroll for every node.
 *
 * This is a **session-local** stack, not the global wallet. Nothing in the
 * career runner can credit server chips; see docs/ARCHITECTURE.md.
 */
export const CAREER_STARTING_BANKROLL = 2_000;

/**
 * The configured mastery threshold for "Precision" (S3): total estimated
 * expectation the session may give up, in units of the original wager.
 *
 * Derived as 0.02 of a bet per hand across S3's twenty-five hands. It is a
 * named constant rather than a literal in the node table because it is the one
 * star target expressed in EV, and it should be tunable in one place.
 */
export const MASTERY_EV_LOST_THRESHOLD = 0.5;

export const CAREER_CHAPTERS: readonly CareerChapter[] = [
  {
    id: "foundations",
    order: 1,
    title: "Foundations",
    subtitle: "The shape of a hand, and the four decisions that matter.",
  },
  {
    id: "workshop",
    order: 2,
    title: "The Workshop",
    subtitle: "Surrender, soft hands, splits, and betting within a limit.",
  },
  {
    id: "skyline",
    order: 3,
    title: "Skyline",
    subtitle: "No prompts. Play the hand, then read what it cost.",
  },
];

/** Foundations rewards. Declared, never credited locally. */
const F_REWARD = { chips: 200, xp: 40 } as const;
const F_FINAL_REWARD = { chips: 500, xp: 100 } as const;
const W_REWARD = { chips: 350, xp: 60 } as const;
const W_FINAL_REWARD = { chips: 800, xp: 150 } as const;
const S_REWARD = { chips: 500, xp: 80 } as const;
const S_FINAL_REWARD = { chips: 1_200, xp: 250 } as const;

/**
 * The node table.
 *
 * Ordering in this array is the route order the map renders and the order
 * prerequisites chain through, so it is the single source of progression.
 */
export const CAREER_NODES: readonly CareerNode[] = [
  // ------------------------------------------------------------------ FOUNDATIONS
  {
    id: "F1",
    slug: "first-deal",
    chapter: "foundations",
    order: 1,
    title: "First Deal",
    summary: "Ten hands with the recommended play on screen before you choose.",
    format: "standard",
    hands: 10,
    decisions: null,
    drillFocus: null,
    assistance: "learn",
    accuracyBasis: "all",
    startingBankroll: CAREER_STARTING_BANKROLL,
    maxWagerPercentOfStart: null,
    accuracyStarPercent: 60,
    mastery: { kind: "finish_bankroll", percentOfStart: 100 },
    reward: F_REWARD,
    prerequisiteSlug: null,
  },
  {
    id: "F2",
    slug: "hit-or-hold",
    chapter: "foundations",
    order: 2,
    title: "Hit or Hold",
    summary: "Twelve hands, graded after each decision instead of before it.",
    format: "standard",
    hands: 12,
    decisions: null,
    drillFocus: null,
    assistance: "challenge",
    accuracyBasis: "unaided",
    startingBankroll: CAREER_STARTING_BANKROLL,
    maxWagerPercentOfStart: null,
    accuracyStarPercent: 70,
    mastery: { kind: "finish_bankroll", percentOfStart: 100 },
    reward: F_REWARD,
    prerequisiteSlug: "first-deal",
  },
  {
    id: "F3",
    slug: "double-time",
    chapter: "foundations",
    order: 3,
    title: "Double Time",
    summary: "Twelve constructed scenarios where doubling is the live question.",
    format: "drill",
    hands: null,
    decisions: 12,
    drillFocus: "double",
    assistance: "challenge",
    accuracyBasis: "unaided",
    startingBankroll: CAREER_STARTING_BANKROLL,
    maxWagerPercentOfStart: null,
    accuracyStarPercent: 75,
    mastery: { kind: "accuracy", percent: 90 },
    reward: F_REWARD,
    prerequisiteSlug: "hit-or-hold",
  },
  {
    id: "F4",
    slug: "pair-work",
    chapter: "foundations",
    order: 4,
    title: "Pair Work",
    summary: "Twelve constructed pair scenarios, split or otherwise.",
    format: "drill",
    hands: null,
    decisions: 12,
    drillFocus: "pair",
    assistance: "challenge",
    accuracyBasis: "unaided",
    startingBankroll: CAREER_STARTING_BANKROLL,
    maxWagerPercentOfStart: null,
    accuracyStarPercent: 75,
    mastery: { kind: "accuracy", percent: 90 },
    reward: F_REWARD,
    prerequisiteSlug: "double-time",
  },
  {
    id: "F5",
    slug: "shoe-run",
    chapter: "foundations",
    order: 5,
    title: "Shoe Run",
    summary: "Fifteen hands. Hold your accuracy over a longer stretch.",
    format: "standard",
    hands: 15,
    decisions: null,
    drillFocus: null,
    assistance: "challenge",
    accuracyBasis: "unaided",
    startingBankroll: CAREER_STARTING_BANKROLL,
    maxWagerPercentOfStart: null,
    accuracyStarPercent: 75,
    mastery: { kind: "finish_bankroll", percentOfStart: 105 },
    reward: F_REWARD,
    prerequisiteSlug: "pair-work",
  },
  {
    id: "F6",
    slug: "foundation-final",
    chapter: "foundations",
    order: 6,
    title: "Foundation Final",
    summary: "Twenty hands, everything Foundations covered, graded as you go.",
    format: "standard",
    hands: 20,
    decisions: null,
    drillFocus: null,
    assistance: "challenge",
    accuracyBasis: "unaided",
    startingBankroll: CAREER_STARTING_BANKROLL,
    maxWagerPercentOfStart: null,
    accuracyStarPercent: 80,
    mastery: { kind: "finish_bankroll", percentOfStart: 110 },
    reward: F_FINAL_REWARD,
    prerequisiteSlug: "shoe-run",
  },

  // ------------------------------------------------------------------- WORKSHOP
  {
    id: "W1",
    slug: "clean-decisions",
    chapter: "workshop",
    order: 1,
    title: "Clean Decisions",
    summary: "Fifteen hands at a higher accuracy bar than Foundations asked for.",
    format: "standard",
    hands: 15,
    decisions: null,
    drillFocus: null,
    assistance: "challenge",
    accuracyBasis: "unaided",
    startingBankroll: CAREER_STARTING_BANKROLL,
    maxWagerPercentOfStart: null,
    accuracyStarPercent: 80,
    mastery: { kind: "finish_bankroll", percentOfStart: 100 },
    reward: W_REWARD,
    prerequisiteSlug: "foundation-final",
  },
  {
    id: "W2",
    slug: "know-when-to-leave",
    chapter: "workshop",
    order: 2,
    title: "Know When to Leave",
    summary: "Twelve constructed hands where late surrender is on the table.",
    format: "drill",
    hands: null,
    decisions: 12,
    drillFocus: "surrender",
    assistance: "challenge",
    accuracyBasis: "unaided",
    startingBankroll: CAREER_STARTING_BANKROLL,
    maxWagerPercentOfStart: null,
    accuracyStarPercent: 80,
    mastery: { kind: "accuracy", percent: 95 },
    reward: W_REWARD,
    prerequisiteSlug: "clean-decisions",
  },
  {
    id: "W3",
    slug: "controlled-risk",
    chapter: "workshop",
    order: 3,
    title: "Controlled Risk",
    summary: "Twenty hands with every wager capped at a tenth of your starting stack.",
    format: "standard",
    hands: 20,
    decisions: null,
    drillFocus: null,
    assistance: "challenge",
    accuracyBasis: "unaided",
    startingBankroll: CAREER_STARTING_BANKROLL,
    maxWagerPercentOfStart: 10,
    accuracyStarPercent: 82,
    mastery: { kind: "finish_bankroll", percentOfStart: 105 },
    reward: W_REWARD,
    prerequisiteSlug: "know-when-to-leave",
  },
  {
    id: "W4",
    slug: "soft-touch",
    chapter: "workshop",
    order: 4,
    title: "Soft Touch",
    summary: "Fifteen constructed soft hands, where the ace changes the answer.",
    format: "drill",
    hands: null,
    decisions: 15,
    drillFocus: "soft",
    assistance: "challenge",
    accuracyBasis: "unaided",
    startingBankroll: CAREER_STARTING_BANKROLL,
    maxWagerPercentOfStart: null,
    accuracyStarPercent: 85,
    mastery: { kind: "accuracy", percent: 95 },
    reward: W_REWARD,
    prerequisiteSlug: "controlled-risk",
  },
  {
    id: "W5",
    slug: "split-decisions",
    chapter: "workshop",
    order: 5,
    title: "Split Decisions",
    summary: "Fifteen constructed pairs. Splitting is legal far more often than it is right.",
    format: "drill",
    hands: null,
    decisions: 15,
    drillFocus: "split",
    assistance: "challenge",
    accuracyBasis: "unaided",
    startingBankroll: CAREER_STARTING_BANKROLL,
    maxWagerPercentOfStart: null,
    accuracyStarPercent: 85,
    mastery: { kind: "accuracy", percent: 95 },
    reward: W_REWARD,
    prerequisiteSlug: "soft-touch",
  },
  {
    id: "W6",
    slug: "workshop-final",
    chapter: "workshop",
    order: 6,
    title: "Workshop Final",
    summary: "Twenty-five hands drawing on everything the Workshop covered.",
    format: "standard",
    hands: 25,
    decisions: null,
    drillFocus: null,
    assistance: "challenge",
    accuracyBasis: "unaided",
    startingBankroll: CAREER_STARTING_BANKROLL,
    maxWagerPercentOfStart: null,
    accuracyStarPercent: 88,
    mastery: { kind: "finish_bankroll", percentOfStart: 110 },
    reward: W_FINAL_REWARD,
    prerequisiteSlug: "split-decisions",
  },

  // -------------------------------------------------------------------- SKYLINE
  {
    id: "S1",
    slug: "no-hints",
    chapter: "skyline",
    order: 1,
    title: "No Hints",
    summary: "Twenty hands with nothing on screen. Every decision is reviewed afterwards.",
    format: "standard",
    hands: 20,
    decisions: null,
    drillFocus: null,
    assistance: "play",
    accuracyBasis: "unaided",
    startingBankroll: CAREER_STARTING_BANKROLL,
    maxWagerPercentOfStart: null,
    accuracyStarPercent: 85,
    mastery: { kind: "finish_bankroll", percentOfStart: 100 },
    reward: S_REWARD,
    prerequisiteSlug: "workshop-final",
  },
  {
    id: "S2",
    slug: "long-shoe",
    chapter: "skyline",
    order: 2,
    title: "Long Shoe",
    summary: "Twenty hands unaided, at a bar that leaves little room for drift.",
    format: "standard",
    hands: 20,
    decisions: null,
    drillFocus: null,
    assistance: "play",
    accuracyBasis: "unaided",
    startingBankroll: CAREER_STARTING_BANKROLL,
    maxWagerPercentOfStart: null,
    accuracyStarPercent: 87,
    mastery: { kind: "finish_bankroll", percentOfStart: 105 },
    reward: S_REWARD,
    prerequisiteSlug: "no-hints",
  },
  {
    id: "S3",
    slug: "precision",
    chapter: "skyline",
    order: 3,
    title: "Precision",
    summary: "Twenty-five hands measured by what your mistakes cost, not by what you won.",
    format: "standard",
    hands: 25,
    decisions: null,
    drillFocus: null,
    assistance: "play",
    accuracyBasis: "unaided",
    startingBankroll: CAREER_STARTING_BANKROLL,
    maxWagerPercentOfStart: null,
    accuracyStarPercent: 90,
    mastery: { kind: "ev_lost", maxEvLost: MASTERY_EV_LOST_THRESHOLD },
    reward: S_REWARD,
    prerequisiteSlug: "long-shoe",
  },
  {
    id: "S4",
    slug: "decision-mix",
    chapter: "skyline",
    order: 4,
    title: "Decision Mix",
    summary: "Twenty-five constructed scenarios drawn from every decision family at once.",
    format: "drill",
    hands: null,
    decisions: 25,
    drillFocus: "mixed",
    assistance: "challenge",
    accuracyBasis: "unaided",
    startingBankroll: CAREER_STARTING_BANKROLL,
    maxWagerPercentOfStart: null,
    accuracyStarPercent: 90,
    mastery: { kind: "accuracy", percent: 96 },
    reward: S_REWARD,
    prerequisiteSlug: "precision",
  },
  {
    id: "S5",
    slug: "table-test",
    chapter: "skyline",
    order: 5,
    title: "Table Test",
    summary: "Twenty-five hands unaided. Accuracy is read back to you at the end.",
    format: "standard",
    hands: 25,
    decisions: null,
    drillFocus: null,
    assistance: "play",
    accuracyBasis: "unaided",
    startingBankroll: CAREER_STARTING_BANKROLL,
    maxWagerPercentOfStart: null,
    accuracyStarPercent: 92,
    mastery: { kind: "finish_bankroll", percentOfStart: 105 },
    reward: S_REWARD,
    prerequisiteSlug: "decision-mix",
  },
  {
    id: "S6",
    slug: "skyline-final",
    chapter: "skyline",
    order: 6,
    title: "Skyline Final",
    summary: "Thirty hands unaided. The last node of the MVP career.",
    format: "standard",
    hands: 30,
    decisions: null,
    drillFocus: null,
    assistance: "play",
    accuracyBasis: "unaided",
    startingBankroll: CAREER_STARTING_BANKROLL,
    maxWagerPercentOfStart: null,
    accuracyStarPercent: 92,
    mastery: { kind: "finish_bankroll", percentOfStart: 110 },
    reward: S_FINAL_REWARD,
    prerequisiteSlug: "table-test",
  },
];

/** Every node earns exactly three stars, so the ceiling is fixed. */
export const STARS_PER_NODE = 3;

/** Total stars available across the MVP career. */
export const TOTAL_CAREER_STARS = CAREER_NODES.length * STARS_PER_NODE;

const NODES_BY_SLUG: ReadonlyMap<string, CareerNode> = new Map(
  CAREER_NODES.map((node) => [node.slug, node]),
);

const NODES_BY_ID: ReadonlyMap<string, CareerNode> = new Map(
  CAREER_NODES.map((node) => [node.id, node]),
);

/** Null rather than a throw: a bad URL segment is a 404, not a crash. */
export function careerNodeBySlug(slug: string): CareerNode | null {
  return NODES_BY_SLUG.get(slug) ?? null;
}

export function careerNodeById(id: string): CareerNode | null {
  return NODES_BY_ID.get(id) ?? null;
}

export function careerNodesInChapter(chapter: CareerChapterId): readonly CareerNode[] {
  return CAREER_NODES.filter((node) => node.chapter === chapter);
}

export function careerChapter(id: CareerChapterId): CareerChapter | null {
  return CAREER_CHAPTERS.find((chapter) => chapter.id === id) ?? null;
}

/** The node immediately after this one in route order, or null at the end. */
export function nextCareerNode(node: CareerNode): CareerNode | null {
  const index = CAREER_NODES.indexOf(node);
  if (index < 0) return null;
  return CAREER_NODES[index + 1] ?? null;
}

/**
 * How many decisions a node asks for, whichever unit it counts in.
 * Standard nodes count hands; drills count decisions.
 */
export function careerNodeWorkload(node: CareerNode): { count: number; unit: "hands" | "decisions" } {
  return node.format === "standard"
    ? { count: node.hands ?? 0, unit: "hands" }
    : { count: node.decisions ?? 0, unit: "decisions" };
}

/**
 * The wager ceiling for a node, floored to the table's bet increment so the
 * returned value is always placeable.
 */
export function maxWagerForNode(node: CareerNode, rules: BlackjackRules = CAREER_RULES): number {
  if (node.maxWagerPercentOfStart === null) return rules.maxBet;
  const cap = Math.floor((node.startingBankroll * node.maxWagerPercentOfStart) / 100);
  const bounded = Math.min(cap, rules.maxBet);
  return Math.floor(bounded / rules.betIncrement) * rules.betIncrement;
}
