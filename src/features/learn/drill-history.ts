/**
 * Arc 21 — drill history persistence.
 *
 * Drill history is local learning data: which strategy keys you have been asked,
 * how often you got them right, and when you last missed one. It carries no
 * chips and no competitive standing, so it lives entirely on the device through
 * the existing `KeyValueStore`.
 *
 * A saved blob is UNTRUSTED INPUT — it may be corrupt, truncated, or written by
 * an older build. Every load is validated and anything that fails is discarded
 * rather than fed to the scheduler; the worst case is that the player's review
 * queue resets, which is recoverable, whereas a crash loop on launch is not.
 * This mirrors `src/features/practice/persistence.ts` deliberately: two
 * different answers to "what do we do with a bad save" would be one too many.
 *
 * Runtime-neutral apart from Zod: no React, no Expo, no direct SQLite import.
 */

import { z } from "zod";

import type { KeyValueStore } from "../../lib/persistence/key-value-store.js";
import type { DrillHistory, DrillRecord } from "./spaced-repetition.js";

/** Bump when the persisted shape changes incompatibly. */
export const DRILL_HISTORY_SCHEMA_VERSION = 1;

export const DRILL_HISTORY_KEY = "learn:drill-history";

/**
 * The whole two-card question bank is ~330 keys, so this is roughly double the
 * reachable size. The cap exists so a future ruleset (or a corrupt write) can
 * never grow the blob without bound; the least recently seen records are dropped
 * first, which is also the least useful history to keep.
 */
export const MAX_DRILL_RECORDS = 700;

const recordSchema = z.object({
  key: z.string().min(1).max(64),
  timesRight: z.number().int().min(0),
  timesWrong: z.number().int().min(0),
  lastSeenAt: z.number().int().min(0),
  lastWrongAt: z.number().int().min(0).nullable(),
});

const envelopeSchema = z.object({
  schemaVersion: z.number(),
  records: z.array(recordSchema).max(MAX_DRILL_RECORDS * 2),
});

export type DrillHistoryLoadFailure = "ABSENT" | "UNPARSEABLE" | "SCHEMA_MISMATCH";

export interface DrillHistoryLoadResult {
  history: DrillHistory;
  failure: DrillHistoryLoadFailure | null;
}

const EMPTY: DrillHistory = Object.freeze({});

/**
 * Drops the least recently seen records once the cap is exceeded.
 *
 * Ties are broken by key so pruning is deterministic — a save that reorders
 * itself between runs makes a support report unreproducible.
 */
export function pruneDrillHistory(history: DrillHistory, max = MAX_DRILL_RECORDS): DrillHistory {
  const records = Object.values(history);
  if (records.length <= max) return history;

  const kept = [...records]
    .sort((a, b) => b.lastSeenAt - a.lastSeenAt || a.key.localeCompare(b.key))
    .slice(0, max);

  const next: Record<string, DrillRecord> = {};
  for (const record of kept) {
    next[record.key] = record;
  }
  return next;
}

export function serialiseDrillHistory(history: DrillHistory): string {
  // Sorted so the same history always serialises to the same bytes.
  const records = Object.values(pruneDrillHistory(history)).sort((a, b) =>
    a.key.localeCompare(b.key),
  );
  return JSON.stringify({ schemaVersion: DRILL_HISTORY_SCHEMA_VERSION, records });
}

export function deserialiseDrillHistory(raw: string | null): DrillHistoryLoadResult {
  if (raw === null) return { history: EMPTY, failure: "ABSENT" };

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { history: EMPTY, failure: "UNPARSEABLE" };
  }

  const result = envelopeSchema.safeParse(parsed);
  if (!result.success) return { history: EMPTY, failure: "UNPARSEABLE" };

  if (result.data.schemaVersion !== DRILL_HISTORY_SCHEMA_VERSION) {
    // No migration exists yet, and inventing one for a shape that has never
    // shipped would be fiction. Start clean instead.
    return { history: EMPTY, failure: "SCHEMA_MISMATCH" };
  }

  const history: Record<string, DrillRecord> = {};
  for (const record of result.data.records) {
    history[record.key] = {
      key: record.key,
      timesRight: record.timesRight,
      timesWrong: record.timesWrong,
      lastSeenAt: record.lastSeenAt,
      lastWrongAt: record.lastWrongAt,
    };
  }

  return { history: pruneDrillHistory(history), failure: null };
}

/** Durable read/write of drill history. */
export class DrillHistoryStore {
  constructor(private readonly store: KeyValueStore) {}

  async load(): Promise<DrillHistoryLoadResult> {
    const raw = await this.store.get(DRILL_HISTORY_KEY);
    const result = deserialiseDrillHistory(raw);

    // A blob we could not read is removed so the next write starts from a clean
    // slate rather than repeatedly failing to parse the same bytes.
    if (raw !== null && result.failure !== null && result.failure !== "ABSENT") {
      await this.store.remove(DRILL_HISTORY_KEY);
    }

    return result;
  }

  async save(history: DrillHistory): Promise<void> {
    await this.store.set(DRILL_HISTORY_KEY, serialiseDrillHistory(history));
  }

  async clear(): Promise<void> {
    await this.store.remove(DRILL_HISTORY_KEY);
  }
}
