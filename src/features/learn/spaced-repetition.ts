/**
 * Arc 21 — drill scheduling.
 *
 * A deliberately SIMPLE local spaced-repetition weighting, kept as pure
 * functions so it can be reasoned about and tested without a device, a clock or
 * a render.
 *
 *     weight = clamp((BASE + MISS_GAIN · timesWrong · recency) · MASTERY^timesRight)
 *
 * Three properties are what the model is for, and each is asserted in
 * `tests/learn/spaced-repetition.test.ts`:
 *
 *   1. A key you just missed outranks one you have never seen, so mistakes come
 *      back quickly.
 *   2. That pressure fades with time — `recency` halves every
 *      `MISS_HALF_LIFE_MS` — so a mistake from last month does not crowd out
 *      the rest of the chart forever.
 *   3. Getting a key right repeatedly decays it geometrically, so mastered
 *      hands stop dominating the rotation.
 *
 * Nothing ever reaches zero (`MIN_WEIGHT`): basic strategy is not a checklist
 * you finish, and a hand you drilled to death six months ago should still turn
 * up occasionally.
 *
 * This is not SM-2 and does not claim to be. It is an honest weighting over a
 * 330-question bank, which is the size of problem actually in front of us.
 */

// ---------------------------------------------------------------------------
// Tuning
// ---------------------------------------------------------------------------

/** Weight of a key the player has never been asked. The unit of the scale. */
export const BASE_WEIGHT = 1;

/** How much a single recent miss adds. Four means one miss beats four unseen keys. */
export const MISS_GAIN = 4;

/** Each correct answer multiplies the weight by this. 0.6^5 ≈ 0.08. */
export const MASTERY_DECAY = 0.6;

/** A miss loses half its urgency after three days. */
export const MISS_HALF_LIFE_MS = 3 * 24 * 60 * 60 * 1_000;

/** Nothing ever leaves the rotation entirely. */
export const MIN_WEIGHT = 0.05;

// ---------------------------------------------------------------------------
// Records
// ---------------------------------------------------------------------------

/**
 * One drilled strategy key. Keyed by the strategy key itself (`hard:16:10`), so
 * history is per *decision*, not per rendered hand — 6,10 and 8,8-played-as-16
 * are the same thing to learn.
 */
export interface DrillRecord {
  key: string;
  timesRight: number;
  timesWrong: number;
  /** Epoch ms of the most recent answer, right or wrong. */
  lastSeenAt: number;
  /** Epoch ms of the most recent WRONG answer, or null if never missed. */
  lastWrongAt: number | null;
}

export type DrillHistory = Readonly<Record<string, DrillRecord>>;

export function emptyDrillRecord(key: string): DrillRecord {
  return { key, timesRight: 0, timesWrong: 0, lastSeenAt: 0, lastWrongAt: null };
}

/**
 * Folds one answer into the history.
 *
 * Pure: returns a new history rather than mutating, so a caller can grade
 * optimistically and persist afterwards without the two disagreeing.
 */
export function recordDrillAnswer(
  history: DrillHistory,
  key: string,
  correct: boolean,
  now: number,
): DrillHistory {
  const existing = history[key] ?? emptyDrillRecord(key);

  const next: DrillRecord = {
    key,
    timesRight: existing.timesRight + (correct ? 1 : 0),
    timesWrong: existing.timesWrong + (correct ? 0 : 1),
    lastSeenAt: now,
    lastWrongAt: correct ? existing.lastWrongAt : now,
  };

  return { ...history, [key]: next };
}

// ---------------------------------------------------------------------------
// Weighting
// ---------------------------------------------------------------------------

/**
 * How much urgency a past miss still carries: 1 immediately after, halving every
 * `MISS_HALF_LIFE_MS`.
 *
 * A negative elapsed time (a device clock moved backwards, or a record restored
 * from a future-dated write) is treated as "just now" rather than amplified into
 * an absurd weight.
 */
export function missRecency(lastWrongAt: number | null, now: number): number {
  if (lastWrongAt === null) return 0;
  const elapsed = now - lastWrongAt;
  if (!Number.isFinite(elapsed) || elapsed <= 0) return 1;
  return Math.pow(2, -elapsed / MISS_HALF_LIFE_MS);
}

/**
 * The scheduling weight for one key. Higher means "ask this sooner".
 *
 * `weight = f(timesWrong, timesRight, recency)` — exactly the shape the brief
 * asks for, and the three arguments are the only inputs.
 */
export function reviewWeight(record: DrillRecord | undefined, now: number): number {
  if (record === undefined) return BASE_WEIGHT;
  if (record.timesRight === 0 && record.timesWrong === 0) return BASE_WEIGHT;

  const pressure = MISS_GAIN * record.timesWrong * missRecency(record.lastWrongAt, now);
  const mastery = Math.pow(MASTERY_DECAY, record.timesRight);
  const weight = (BASE_WEIGHT + pressure) * mastery;

  return Math.max(MIN_WEIGHT, weight);
}

// ---------------------------------------------------------------------------
// Selection
// ---------------------------------------------------------------------------

/**
 * Picks an index from `weights` in proportion to them.
 *
 * `roll` is a value in [0, 1) supplied by the caller rather than drawn here:
 * this module stays pure and deterministic under test, and the app supplies a
 * CSPRNG-backed roll (see `random.ts`) instead of `Math.random`.
 */
export function weightedIndex(weights: readonly number[], roll: number): number {
  if (weights.length === 0) return -1;

  let total = 0;
  for (const weight of weights) {
    total += Math.max(0, weight);
  }
  if (total <= 0) {
    // Degenerate but survivable: fall back to a uniform pick rather than
    // always returning the first entry.
    return Math.min(weights.length - 1, Math.floor(clampRoll(roll) * weights.length));
  }

  let target = clampRoll(roll) * total;
  for (let index = 0; index < weights.length; index++) {
    target -= Math.max(0, weights[index] ?? 0);
    if (target < 0) return index;
  }
  return weights.length - 1;
}

function clampRoll(roll: number): number {
  if (!Number.isFinite(roll)) return 0;
  if (roll < 0) return 0;
  if (roll >= 1) return 0.999_999_999;
  return roll;
}

export interface SelectOptions<T> {
  items: readonly T[];
  keyOf: (item: T) => string;
  history: DrillHistory;
  now: number;
  /** A value in [0, 1). */
  roll: number;
  /**
   * Key of the question just answered. Excluded when there is anything else to
   * ask — being handed the same hand twice in a row reads as a bug even when the
   * weighting genuinely chose it.
   */
  excludeKey?: string | null;
}

/** Weighted choice over drillable items, or null when there are none. */
export function selectWeighted<T>(options: SelectOptions<T>): T | null {
  const { items, keyOf, history, now, roll, excludeKey } = options;
  if (items.length === 0) return null;

  const pool =
    excludeKey != null && items.length > 1
      ? items.filter((item) => keyOf(item) !== excludeKey)
      : [...items];

  if (pool.length === 0) return items[0] ?? null;

  const weights = pool.map((item) => reviewWeight(history[keyOf(item)], now));
  const index = weightedIndex(weights, roll);
  return pool[index] ?? pool[0] ?? null;
}

// ---------------------------------------------------------------------------
// Summaries
// ---------------------------------------------------------------------------

export interface DrillHistorySummary {
  /** Distinct keys answered at least once. */
  keysSeen: number;
  /** Distinct keys currently carrying at least one miss. */
  keysMissed: number;
  answered: number;
  correct: number;
  /** 0..1, or null when nothing has been answered — never a fabricated zero. */
  accuracy: number | null;
}

export function summariseDrillHistory(history: DrillHistory): DrillHistorySummary {
  let keysSeen = 0;
  let keysMissed = 0;
  let answered = 0;
  let correct = 0;

  for (const record of Object.values(history)) {
    const attempts = record.timesRight + record.timesWrong;
    if (attempts === 0) continue;
    keysSeen++;
    if (record.timesWrong > 0) keysMissed++;
    answered += attempts;
    correct += record.timesRight;
  }

  return {
    keysSeen,
    keysMissed,
    answered,
    correct,
    accuracy: answered > 0 ? correct / answered : null,
  };
}

/** Keys the player has missed at least once — the "My mistakes" pool. */
export function missedKeys(history: DrillHistory): string[] {
  return Object.values(history)
    .filter((record) => record.timesWrong > 0)
    .map((record) => record.key)
    .sort();
}
