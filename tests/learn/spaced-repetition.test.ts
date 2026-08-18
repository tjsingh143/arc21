/**
 * Drill scheduling.
 *
 * The two claims the product makes about "My mistakes" are that a missed hand
 * comes back sooner and that a mastered one fades. Both are asserted here as
 * properties of the weighting, and then again as observable selection frequency
 * over a deterministic sweep of rolls — a weight nobody ever picks from is not a
 * scheduler.
 */

import { describe, expect, it } from "vitest";

import {
  BASE_WEIGHT,
  MASTERY_DECAY,
  MIN_WEIGHT,
  MISS_HALF_LIFE_MS,
  emptyDrillRecord,
  missRecency,
  missedKeys,
  recordDrillAnswer,
  reviewWeight,
  selectWeighted,
  summariseDrillHistory,
  weightedIndex,
  type DrillHistory,
} from "../../src/features/learn/spaced-repetition.js";

const NOW = Date.UTC(2026, 7, 14, 12, 0, 0);
const DAY = 24 * 60 * 60 * 1_000;

function historyOf(...records: { key: string; right: number; wrong: number; lastWrongAt?: number; lastSeenAt?: number }[]): DrillHistory {
  const history: Record<string, ReturnType<typeof emptyDrillRecord>> = {};
  for (const record of records) {
    history[record.key] = {
      key: record.key,
      timesRight: record.right,
      timesWrong: record.wrong,
      lastSeenAt: record.lastSeenAt ?? NOW,
      lastWrongAt: record.wrong > 0 ? (record.lastWrongAt ?? NOW) : null,
    };
  }
  return history;
}

describe("reviewWeight", () => {
  it("gives an unseen key the base weight", () => {
    expect(reviewWeight(undefined, NOW)).toBe(BASE_WEIGHT);
    expect(reviewWeight(emptyDrillRecord("hard:16:10"), NOW)).toBe(BASE_WEIGHT);
  });

  it("ranks a key you just missed above one you have never seen", () => {
    const missed = historyOf({ key: "hard:16:10", right: 0, wrong: 1 })["hard:16:10"];
    expect(reviewWeight(missed, NOW)).toBeGreaterThan(reviewWeight(undefined, NOW));
  });

  it("ranks two misses above one", () => {
    const once = historyOf({ key: "a", right: 0, wrong: 1 })["a"];
    const twice = historyOf({ key: "a", right: 0, wrong: 2 })["a"];
    expect(reviewWeight(twice, NOW)).toBeGreaterThan(reviewWeight(once, NOW));
  });

  it("decays a mastered key below an unseen one", () => {
    const mastered = historyOf({ key: "a", right: 3, wrong: 0 })["a"];
    expect(reviewWeight(mastered, NOW)).toBeLessThan(BASE_WEIGHT);
    expect(reviewWeight(mastered, NOW)).toBeCloseTo(BASE_WEIGHT * MASTERY_DECAY ** 3, 10);
  });

  it("decays monotonically with each additional correct answer", () => {
    let previous = Infinity;
    for (let right = 0; right <= 6; right++) {
      const weight = reviewWeight(historyOf({ key: "a", right, wrong: 0 })["a"], NOW);
      expect(weight).toBeLessThanOrEqual(previous);
      previous = weight;
    }
  });

  it("lets a miss cool off over time instead of dominating forever", () => {
    const record = historyOf({ key: "a", right: 0, wrong: 1 })["a"];
    const fresh = reviewWeight(record, NOW);
    const later = reviewWeight(record, NOW + MISS_HALF_LIFE_MS);
    const muchLater = reviewWeight(record, NOW + 10 * MISS_HALF_LIFE_MS);

    expect(later).toBeLessThan(fresh);
    expect(muchLater).toBeLessThan(later);
    // Still above an unseen key at one half-life: a recent mistake matters.
    expect(later).toBeGreaterThan(BASE_WEIGHT);
  });

  it("never lets a key fall out of rotation entirely", () => {
    const drilled = historyOf({ key: "a", right: 50, wrong: 0 })["a"];
    expect(reviewWeight(drilled, NOW)).toBe(MIN_WEIGHT);
    expect(reviewWeight(drilled, NOW)).toBeGreaterThan(0);
  });

  it("treats a clock that ran backwards as 'just now' rather than amplifying it", () => {
    expect(missRecency(NOW + DAY, NOW)).toBe(1);
    expect(missRecency(null, NOW)).toBe(0);
    expect(missRecency(NOW - MISS_HALF_LIFE_MS, NOW)).toBeCloseTo(0.5, 10);
  });
});

describe("recordDrillAnswer", () => {
  it("does not mutate the history it is given", () => {
    const before: DrillHistory = {};
    const after = recordDrillAnswer(before, "hard:16:10", false, NOW);
    expect(before["hard:16:10"]).toBeUndefined();
    expect(after["hard:16:10"]?.timesWrong).toBe(1);
  });

  it("stamps lastWrongAt only on a miss, and keeps it after a later success", () => {
    let history = recordDrillAnswer({}, "a", false, NOW);
    expect(history["a"]?.lastWrongAt).toBe(NOW);

    history = recordDrillAnswer(history, "a", true, NOW + DAY);
    expect(history["a"]?.timesRight).toBe(1);
    expect(history["a"]?.timesWrong).toBe(1);
    expect(history["a"]?.lastSeenAt).toBe(NOW + DAY);
    // The miss still happened; forgetting when would reset the cooling curve.
    expect(history["a"]?.lastWrongAt).toBe(NOW);
  });

  it("leaves lastWrongAt null for a key that has only ever been right", () => {
    const history = recordDrillAnswer({}, "a", true, NOW);
    expect(history["a"]?.lastWrongAt).toBeNull();
  });
});

describe("weightedIndex", () => {
  it("never picks a zero-weight entry when another has weight", () => {
    for (let step = 0; step < 100; step++) {
      expect(weightedIndex([0, 1, 0], step / 100)).toBe(1);
    }
  });

  it("splits proportionally", () => {
    // 3:1 — the first entry should take roughly three quarters of the range.
    let first = 0;
    for (let step = 0; step < 1_000; step++) {
      if (weightedIndex([3, 1], step / 1_000) === 0) first++;
    }
    expect(first).toBeGreaterThan(720);
    expect(first).toBeLessThan(780);
  });

  it("survives degenerate input rather than always answering zero", () => {
    expect(weightedIndex([], 0.5)).toBe(-1);
    expect(weightedIndex([0, 0], 0.9)).toBe(1);
    expect(weightedIndex([1, 1], Number.NaN)).toBe(0);
    expect(weightedIndex([1, 1], 1.5)).toBe(1);
  });
});

describe("selectWeighted", () => {
  const items = [{ key: "missed" }, { key: "unseen" }, { key: "mastered" }];
  const keyOf = (item: { key: string }) => item.key;

  const history = historyOf(
    { key: "missed", right: 0, wrong: 2 },
    { key: "mastered", right: 5, wrong: 0 },
  );

  it("asks a missed key far more often than a mastered one", () => {
    const counts: Record<string, number> = { missed: 0, unseen: 0, mastered: 0 };
    for (let step = 0; step < 1_000; step++) {
      const picked = selectWeighted({ items, keyOf, history, now: NOW, roll: step / 1_000 });
      if (picked) counts[picked.key] = (counts[picked.key] ?? 0) + 1;
    }

    expect(counts["missed"] ?? 0).toBeGreaterThan(counts["unseen"] ?? 0);
    expect(counts["unseen"] ?? 0).toBeGreaterThan(counts["mastered"] ?? 0);
    // Nothing is starved: the mastered key still comes round.
    expect(counts["mastered"] ?? 0).toBeGreaterThan(0);
  });

  it("does not hand back the question just answered when there is another", () => {
    for (let step = 0; step < 200; step++) {
      const picked = selectWeighted({
        items,
        keyOf,
        history,
        now: NOW,
        roll: step / 200,
        excludeKey: "missed",
      });
      expect(picked?.key).not.toBe("missed");
    }
  });

  it("repeats the only question rather than returning nothing", () => {
    const single = [{ key: "only" }];
    const picked = selectWeighted({
      items: single,
      keyOf,
      history: {},
      now: NOW,
      roll: 0.5,
      excludeKey: "only",
    });
    expect(picked?.key).toBe("only");
  });

  it("returns null for an empty pool rather than inventing a question", () => {
    expect(selectWeighted({ items: [], keyOf, history: {}, now: NOW, roll: 0.5 })).toBeNull();
  });
});

describe("summaries", () => {
  it("reports null accuracy before anything has been answered", () => {
    const summary = summariseDrillHistory({});
    expect(summary.accuracy).toBeNull();
    expect(summary.answered).toBe(0);
  });

  it("ignores records with no attempts rather than counting them as zero", () => {
    const summary = summariseDrillHistory({ a: emptyDrillRecord("a") });
    expect(summary.keysSeen).toBe(0);
    expect(summary.accuracy).toBeNull();
  });

  it("counts attempts, keys seen and keys missed", () => {
    const history = historyOf(
      { key: "a", right: 3, wrong: 1 },
      { key: "b", right: 2, wrong: 0 },
    );
    const summary = summariseDrillHistory(history);
    expect(summary.keysSeen).toBe(2);
    expect(summary.keysMissed).toBe(1);
    expect(summary.answered).toBe(6);
    expect(summary.correct).toBe(5);
    expect(summary.accuracy).toBeCloseTo(5 / 6, 10);
  });

  it("lists missed keys in a stable order", () => {
    const history = historyOf(
      { key: "soft:18:9", right: 0, wrong: 1 },
      { key: "hard:16:10", right: 0, wrong: 2 },
      { key: "pair:8:7", right: 4, wrong: 0 },
    );
    expect(missedKeys(history)).toEqual(["hard:16:10", "soft:18:9"]);
  });
});
