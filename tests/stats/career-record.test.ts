/**
 * The Career filter's record.
 *
 * The defect this covers is a SENTENCE, which is why it is worth a test file.
 * The filter read "Career progress is recorded on the server and needs an
 * account" and showed nothing at all — and both halves were false: the stars
 * are written on this device by `career-persistence.ts`, and the map, the node
 * detail and Home have always read them with no account. Only the REWARD needs
 * a server. A screen that says a feature is absent when it is present is the
 * same class of defect as one that says a feature is present when it is absent;
 * this project has shipped eleven of the second kind and this was the first of
 * the first.
 */

import { describe, expect, it } from "vitest";

import {
  CAREER_NODES,
  TOTAL_CAREER_STARS,
  emptyCareerProgress,
  type CareerProgress,
  type NodeProgress,
} from "../../shared/career/index.js";
import {
  describeOwedRewards,
  hasCareerRecord,
  presentCareerRecord,
  summariseCareerRecord,
} from "../../src/features/stats/career-record.js";
import { statsMode } from "../../src/features/stats/modes.js";

function node(slug: string, overrides: Partial<NodeProgress> = {}): NodeProgress {
  return {
    slug,
    bestStars: 0,
    attempts: 0,
    bestAccuracyPercent: null,
    bestEndingBankroll: null,
    lastPlayedAt: null,
    rewardOwed: false,
    rewardClaimed: false,
    ...overrides,
  };
}

function progressWith(nodes: readonly NodeProgress[]): CareerProgress {
  return {
    ...emptyCareerProgress(),
    nodes: Object.fromEntries(nodes.map((entry) => [entry.slug, entry])),
  };
}

const FIRST = CAREER_NODES[0]!.slug;
const SECOND = CAREER_NODES[1]!.slug;
const THIRD = CAREER_NODES[2]!.slug;

describe("the Career filter", () => {
  /** The assertion the whole change turns on. */
  it("reads from this device, not from the server", () => {
    expect(statsMode("career").source).toBe("local");
    expect(statsMode("career").description).not.toContain("needs an account");
  });

  it("says nothing has been played rather than a record of zero", () => {
    const record = summariseCareerRecord(emptyCareerProgress());
    expect(hasCareerRecord(record)).toBe(false);
    expect(record.starsEarned).toBe(0);
    expect(record.starsAvailable).toBe(TOTAL_CAREER_STARS);
  });

  it("counts a started-and-unfinished node as attempted, not completed", () => {
    const record = summariseCareerRecord(
      progressWith([node(FIRST, { attempts: 3, bestStars: 0 })]),
    );
    expect(hasCareerRecord(record)).toBe(true);
    expect(record.nodesAttempted).toBe(1);
    expect(record.nodesCompleted).toBe(0);
    expect(record.attempts).toBe(3);

    const rows = presentCareerRecord(record);
    expect(rows.find((row) => row.key === "nodes")?.detail).toBe(
      "1 started and not finished",
    );
  });

  /**
   * One star means completed, and completion is always awarded — so variance
   * can never make a node that was played look unplayed.
   */
  it("treats one star as completed", () => {
    const record = summariseCareerRecord(
      progressWith([
        node(FIRST, { attempts: 2, bestStars: 1 }),
        node(SECOND, { attempts: 1, bestStars: 3 }),
      ]),
    );
    expect(record.nodesCompleted).toBe(2);
    expect(record.starsEarned).toBe(4);
  });

  it("reports the best accuracy, not an average, and omits it when unmeasured", () => {
    const measured = summariseCareerRecord(
      progressWith([
        node(FIRST, { attempts: 1, bestStars: 1, bestAccuracyPercent: 71 }),
        node(SECOND, { attempts: 1, bestStars: 1, bestAccuracyPercent: 94 }),
      ]),
    );
    expect(measured.bestAccuracyPercent).toBe(94);
    expect(presentCareerRecord(measured).find((row) => row.key === "accuracy")?.value).toBe(
      "94%",
    );

    const unmeasured = summariseCareerRecord(
      progressWith([node(FIRST, { attempts: 1, bestStars: 1 })]),
    );
    expect(unmeasured.bestAccuracyPercent).toBeNull();
    expect(presentCareerRecord(unmeasured).some((row) => row.key === "accuracy")).toBe(false);
  });

  it("takes the most recent play across every node", () => {
    const record = summariseCareerRecord(
      progressWith([
        node(FIRST, { attempts: 1, lastPlayedAt: "2026-01-01T00:00:00.000Z" }),
        node(SECOND, { attempts: 1, lastPlayedAt: "2026-08-01T00:00:00.000Z" }),
        node(THIRD, { attempts: 1, lastPlayedAt: "2026-03-01T00:00:00.000Z" }),
      ]),
    );
    expect(record.lastPlayedAt).toBe("2026-08-01T00:00:00.000Z");
  });
});

/**
 * The one thing an account changes on this screen. Reported as a COUNT of
 * nodes rather than as a warning, and only when the count is real.
 */
describe("rewards a server has not granted", () => {
  it("counts a node finished offline whose reward no server has paid", () => {
    const record = summariseCareerRecord(
      progressWith([
        node(FIRST, { attempts: 1, bestStars: 2, rewardOwed: true, rewardClaimed: false }),
        node(SECOND, { attempts: 1, bestStars: 2, rewardOwed: true, rewardClaimed: true }),
      ]),
    );
    expect(record.owedRewards).toBe(1);
    expect(describeOwedRewards(record, false)).toContain("1 node");
    expect(describeOwedRewards(record, false)).toContain("keep their local stars");
    expect(describeOwedRewards(record, true)).toContain("replayed");
  });

  /** No prompt when there is nothing to prompt about. */
  it("says nothing when nothing is owed", () => {
    const claimed = summariseCareerRecord(
      progressWith([node(FIRST, { attempts: 1, bestStars: 3, rewardOwed: true, rewardClaimed: true })]),
    );
    expect(claimed.owedRewards).toBe(0);
    expect(describeOwedRewards(claimed, false)).toBeNull();
    expect(describeOwedRewards(claimed, true)).toBeNull();
  });

  it("pluralises honestly", () => {
    const two = summariseCareerRecord(
      progressWith([
        node(FIRST, { attempts: 1, bestStars: 1, rewardOwed: true }),
        node(SECOND, { attempts: 1, bestStars: 1, rewardOwed: true }),
      ]),
    );
    expect(describeOwedRewards(two, false)).toContain("2 nodes");
  });
});
