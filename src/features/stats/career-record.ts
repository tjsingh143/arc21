/**
 * The Career filter on the Statistics screen.
 *
 * WHAT WAS WRONG. The filter said "Career progress is recorded on the server
 * and needs an account", and showed nothing. That is false in both halves:
 * career progress is persisted ON THIS DEVICE by `career-persistence.ts`, and
 * the map, the node detail and Home all read it without any account at all. The
 * specification's line is "a Career node may be practiced offline, but any
 * reward-bearing attempt requires server authority" — and the note collapsed
 * that into "there is nothing here", which turned a shipped feature into an
 * apparently missing one.
 *
 * WHAT IS ACTUALLY SERVER-OWNED is the REWARD, and only the reward. A node
 * completed offline sets `rewardOwed` and grants nothing; only a server may set
 * `rewardClaimed`, and the local client has no path to it — which is why
 * `owedRewards` exists here. It is the one honest thing to say about an account
 * on this screen, and it is a number rather than a warning.
 *
 * Pure, so all of it is provable under Node.
 */

import {
  CAREER_NODES,
  TOTAL_CAREER_STARS,
  progressForNode,
  totalStars,
  type CareerProgress,
} from "../../../shared/career/index.js";

export interface CareerRecord {
  readonly starsEarned: number;
  readonly starsAvailable: number;
  readonly nodesCompleted: number;
  readonly nodesAttempted: number;
  readonly nodesTotal: number;
  readonly attempts: number;
  /** Best whole-percent accuracy across every node, or null if never measured. */
  readonly bestAccuracyPercent: number | null;
  /**
   * Nodes completed on this device whose reward no server has granted.
   *
   * The only figure on this screen that an account changes, and the reason it
   * is reported as a count: "you have three rewards waiting" is actionable,
   * "sign in for rewards" is an advert.
   */
  readonly owedRewards: number;
  readonly lastPlayedAt: string | null;
}

export function summariseCareerRecord(progress: CareerProgress): CareerRecord {
  let nodesCompleted = 0;
  let nodesAttempted = 0;
  let attempts = 0;
  let bestAccuracyPercent: number | null = null;
  let owedRewards = 0;
  let lastPlayedAt: string | null = null;

  for (const node of CAREER_NODES) {
    const record = progressForNode(progress, node.slug);
    if (record.attempts > 0) nodesAttempted += 1;
    attempts += record.attempts;
    // One star means completed — completion is always awarded, so variance can
    // never make a played node look unplayed.
    if (record.bestStars >= 1) nodesCompleted += 1;
    if (record.rewardOwed && !record.rewardClaimed) owedRewards += 1;
    if (
      record.bestAccuracyPercent !== null &&
      (bestAccuracyPercent === null || record.bestAccuracyPercent > bestAccuracyPercent)
    ) {
      bestAccuracyPercent = record.bestAccuracyPercent;
    }
    if (
      record.lastPlayedAt !== null &&
      (lastPlayedAt === null || record.lastPlayedAt > lastPlayedAt)
    ) {
      lastPlayedAt = record.lastPlayedAt;
    }
  }

  return {
    starsEarned: totalStars(progress),
    starsAvailable: TOTAL_CAREER_STARS,
    nodesCompleted,
    nodesAttempted,
    nodesTotal: CAREER_NODES.length,
    attempts,
    bestAccuracyPercent,
    owedRewards,
    lastPlayedAt,
  };
}

/** True when anything at all has been played. Never a record of zero. */
export function hasCareerRecord(record: CareerRecord): boolean {
  return record.attempts > 0 || record.nodesAttempted > 0;
}

export interface CareerRecordRow {
  readonly key: string;
  readonly label: string;
  readonly value: string;
  readonly detail?: string;
}

/** The record as the rows the screen renders. */
export function presentCareerRecord(record: CareerRecord): readonly CareerRecordRow[] {
  const rows: CareerRecordRow[] = [
    {
      key: "stars",
      label: "Stars",
      value: `${record.starsEarned} of ${record.starsAvailable}`,
    },
    {
      key: "nodes",
      label: "Nodes completed",
      value: `${record.nodesCompleted} of ${record.nodesTotal}`,
      detail:
        record.nodesAttempted > record.nodesCompleted
          ? `${record.nodesAttempted - record.nodesCompleted} started and not finished`
          : undefined,
    },
    { key: "attempts", label: "Attempts", value: String(record.attempts) },
  ];

  // Omitted rather than shown as 0% — a node whose accuracy was never measured
  // has no accuracy, which is not the same as playing it badly.
  if (record.bestAccuracyPercent !== null) {
    rows.push({
      key: "accuracy",
      label: "Best accuracy",
      value: `${record.bestAccuracyPercent}%`,
      detail: "The best single attempt, not an average.",
    });
  }

  return rows;
}

/**
 * What an account would change, said once and only when it is true.
 *
 * `null` when nothing is owed, so a player who is signed in — or who has
 * finished nothing — is not shown a prompt about rewards that do not exist.
 */
export function describeOwedRewards(record: CareerRecord, hasAccount: boolean): string | null {
  if (record.owedRewards === 0) return null;
  const nodes = `${record.owedRewards} node${record.owedRewards === 1 ? "" : "s"}`;
  return hasAccount
    ? `${nodes} finished offline are waiting to be replayed for their reward. Offline attempts prove the play; only a server-run attempt pays the chips and XP.`
    : `${nodes} finished offline are waiting for an account. Offline attempts prove the play and keep their stars; only a server-run attempt pays the chips and XP.`;
}
