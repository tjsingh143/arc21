/**
 * Arc 21 — career progress model.
 *
 * Pure, runtime-neutral state transitions. The client persists the result of
 * these functions to local storage; the future server will recompute them from
 * its own authoritative session records rather than trusting a client blob.
 *
 * PROGRESS IS LOCAL AND SO ARE ITS LIMITS. Stars recorded here unlock career
 * nodes and nothing else. They do not credit the global wallet, XP, level,
 * cosmetics or any leaderboard, because every one of those is server-owned
 * (docs/ARCHITECTURE.md) and a client that could write them is a client that an
 * attacker could write them from. First-completion rewards are therefore
 * recorded as OWED — `rewardClaimed` stays false until a server grants them.
 */

import { CAREER_NODES, STARS_PER_NODE } from "./nodes.ts";
import type { CareerSessionResult, StarCount, StarEvaluation } from "./stars.ts";
import type { CareerChapterId, CareerNode } from "./types.ts";

/** Bump when the persisted shape changes incompatibly. */
export const CAREER_PROGRESS_VERSION = 1;

export interface NodeProgress {
  readonly slug: string;
  readonly bestStars: StarCount;
  readonly attempts: number;
  /** Best whole-percent accuracy across attempts, or null if never measured. */
  readonly bestAccuracyPercent: number | null;
  /** Best finishing bankroll across attempts, or null for drill nodes. */
  readonly bestEndingBankroll: number | null;
  readonly lastPlayedAt: string | null;
  /**
   * True once the node has been completed at least once. The reward is owed
   * from that moment; `rewardClaimed` records whether a SERVER has granted it.
   */
  readonly rewardOwed: boolean;
  /**
   * Only a server may ever set this true. The local client has no path to it,
   * which is why it is written nowhere in this module.
   */
  readonly rewardClaimed: boolean;
}

export interface CareerProgress {
  readonly version: number;
  readonly nodes: Readonly<Record<string, NodeProgress>>;
}

export function emptyCareerProgress(): CareerProgress {
  return { version: CAREER_PROGRESS_VERSION, nodes: {} };
}

function blankNodeProgress(slug: string): NodeProgress {
  return {
    slug,
    bestStars: 0,
    attempts: 0,
    bestAccuracyPercent: null,
    bestEndingBankroll: null,
    lastPlayedAt: null,
    rewardOwed: false,
    rewardClaimed: false,
  };
}

export function progressForNode(progress: CareerProgress, slug: string): NodeProgress {
  return progress.nodes[slug] ?? blankNodeProgress(slug);
}

export function starsForNode(progress: CareerProgress, slug: string): StarCount {
  return progressForNode(progress, slug).bestStars;
}

/**
 * A node is open once its predecessor has earned ANY star.
 *
 * One star means "completed", and completion is always awarded, so the only
 * way to be blocked here is to not have played the previous node yet. Variance
 * cannot close this gate.
 */
export function isNodeUnlocked(progress: CareerProgress, node: CareerNode): boolean {
  if (node.prerequisiteSlug === null) return true;
  return starsForNode(progress, node.prerequisiteSlug) >= 1;
}

/** The first unlocked node that has not yet been completed, or null when done. */
export function nextRecommendedNode(progress: CareerProgress): CareerNode | null {
  for (const node of CAREER_NODES) {
    if (!isNodeUnlocked(progress, node)) return null;
    if (starsForNode(progress, node.slug) === 0) return node;
  }
  return null;
}

export function totalStars(progress: CareerProgress): number {
  return CAREER_NODES.reduce((sum, node) => sum + starsForNode(progress, node.slug), 0);
}

export function chapterStars(
  progress: CareerProgress,
  chapter: CareerChapterId,
): { earned: number; available: number } {
  const nodes = CAREER_NODES.filter((node) => node.chapter === chapter);
  return {
    earned: nodes.reduce((sum, node) => sum + starsForNode(progress, node.slug), 0),
    available: nodes.length * STARS_PER_NODE,
  };
}

/**
 * Folds one attempt into progress.
 *
 * Records are monotonic bests: a worse retry never takes a star away. That is
 * deliberate — a player who scores three stars and then replays a node for fun
 * must not be punished for it, and a progression system that can move backwards
 * makes replay feel dangerous.
 *
 * An abandoned attempt still increments `attempts` (it happened) but changes
 * nothing else.
 */
export function recordSessionResult(
  progress: CareerProgress,
  node: CareerNode,
  evaluation: StarEvaluation,
  result: CareerSessionResult,
  at: string,
): CareerProgress {
  const previous = progressForNode(progress, node.slug);

  const bestStars = (
    evaluation.stars > previous.bestStars ? evaluation.stars : previous.bestStars
  ) as StarCount;

  const bestAccuracyPercent = bestOf(previous.bestAccuracyPercent, evaluation.accuracyPercent);

  // Only a completed session's bankroll is meaningful; an abandoned one stopped
  // mid-hand with chips still on the felt.
  const bestEndingBankroll =
    result.completed && node.format === "standard"
      ? bestOf(previous.bestEndingBankroll, result.endingBankroll)
      : previous.bestEndingBankroll;

  const next: NodeProgress = {
    slug: node.slug,
    bestStars,
    attempts: previous.attempts + 1,
    bestAccuracyPercent,
    bestEndingBankroll,
    lastPlayedAt: at,
    rewardOwed: previous.rewardOwed || result.completed,
    // Never set locally. A client that could claim a reward is a client that
    // could mint chips, and the wallet has no client write path at all.
    rewardClaimed: previous.rewardClaimed,
  };

  return {
    version: CAREER_PROGRESS_VERSION,
    nodes: { ...progress.nodes, [node.slug]: next },
  };
}

function bestOf(previous: number | null, candidate: number | null): number | null {
  if (candidate === null) return previous;
  if (previous === null) return candidate;
  return candidate > previous ? candidate : previous;
}

/** Nodes whose first-completion reward is owed but not yet granted by a server. */
export function pendingRewards(progress: CareerProgress): readonly CareerNode[] {
  return CAREER_NODES.filter((node) => {
    const entry = progressForNode(progress, node.slug);
    return entry.rewardOwed && !entry.rewardClaimed;
  });
}
