/**
 * Arc 21 — where a missing strategy recommendation is RECORDED.
 *
 * The advisor's contract is "return nothing rather than guess", and the table
 * honours it: when `computeAdvice` cannot answer, the hint is hidden and play
 * carries on. Until this module existed, that was the whole story — the
 * diagnostic explaining WHY was computed, handed to the UI, and dropped. A
 * silent hint and a silent log are indistinguishable from a working advisor
 * that simply had nothing to say, so a table with a hole in it could ship and
 * nobody would find out from the app.
 *
 * Failing safe means three things, and the third is this one:
 *
 *   1. gameplay continues                    — the store never blocks on advice
 *   2. the recommendation is hidden          — `StrategyPanel` renders null
 *   3. the reason is recorded                — here
 *
 * WHAT IS RECORDED, AND WHAT IS NOT. A diagnostic carries the reason code, the
 * normalized state key (`hard:16:10`), the ruleset it was looked up under and a
 * count. It carries no cards, no shoe, no hole card and nothing about the
 * player — a strategy key is a coordinate on a published chart, not private
 * information, and there is nothing else here worth having.
 *
 * Runtime-neutral: a plain module with no React and no storage, so the store,
 * the tests and any future reporter all see the same sink.
 */

import type { StrategyDiagnosticCode } from "../../../shared/strategy/index.js";

export interface StrategyDiagnosticRecord {
  code: StrategyDiagnosticCode;
  /** The normalized state key, or null when the state itself was malformed. */
  key: string | null;
  rulesetId: string;
  rulesetVersion: number;
  /** How many times this exact code/key/ruleset triple has been seen. */
  count: number;
  /** Epoch milliseconds of the most recent occurrence. */
  lastSeenAt: number;
}

/**
 * How many DISTINCT diagnostics are kept.
 *
 * Distinct, not total: a table with a hole in it produces the same diagnostic
 * on every hand that reaches the hole, and an unbounded list would be a slow
 * leak that reports one fact thousands of times. Occurrences are counted
 * instead, which is the number anybody investigating actually wants.
 */
export const MAX_STRATEGY_DIAGNOSTICS = 32;

type Listener = (record: StrategyDiagnosticRecord) => void;

const records = new Map<string, StrategyDiagnosticRecord>();
const listeners = new Set<Listener>();

function identity(input: {
  code: StrategyDiagnosticCode;
  key: string | null;
  rulesetId: string;
  rulesetVersion: number;
}): string {
  return `${input.rulesetId}@${input.rulesetVersion}|${input.code}|${input.key ?? "-"}`;
}

/**
 * Records one occurrence and returns the running record for it.
 *
 * Idempotent in the sense that matters: the same hole seen a hundred times is
 * one entry with a count of a hundred, not a hundred entries.
 */
export function recordStrategyDiagnostic(input: {
  code: StrategyDiagnosticCode;
  key: string | null;
  rulesetId: string;
  rulesetVersion: number;
  at?: number;
}): StrategyDiagnosticRecord {
  const id = identity(input);
  const existing = records.get(id);
  const at = input.at ?? Date.now();

  const record: StrategyDiagnosticRecord = existing
    ? { ...existing, count: existing.count + 1, lastSeenAt: at }
    : {
        code: input.code,
        key: input.key,
        rulesetId: input.rulesetId,
        rulesetVersion: input.rulesetVersion,
        count: 1,
        lastSeenAt: at,
      };

  records.set(id, record);

  // Evict the least recently seen rather than the oldest inserted: a hole that
  // is still being hit every hand is the one worth keeping.
  if (records.size > MAX_STRATEGY_DIAGNOSTICS) {
    let oldestId: string | null = null;
    let oldestAt = Number.POSITIVE_INFINITY;
    for (const [candidateId, candidate] of records) {
      if (candidate.lastSeenAt < oldestAt) {
        oldestAt = candidate.lastSeenAt;
        oldestId = candidateId;
      }
    }
    if (oldestId !== null) records.delete(oldestId);
  }

  // Announced only on the FIRST occurrence. A per-hand warning in a hot loop is
  // noise that trains everybody to ignore the channel.
  if (existing === undefined) {
    for (const listener of listeners) listener(record);
  }

  return record;
}

/** Every distinct diagnostic seen this run, most recent first. */
export function strategyDiagnostics(): StrategyDiagnosticRecord[] {
  return [...records.values()].sort((a, b) => b.lastSeenAt - a.lastSeenAt);
}

/** Total occurrences across every distinct diagnostic. */
export function strategyDiagnosticCount(): number {
  let total = 0;
  for (const record of records.values()) total += record.count;
  return total;
}

/** Test hook. Production never calls this. */
export function resetStrategyDiagnostics(): void {
  records.clear();
}

/**
 * Subscribes to first sightings. Returns an unsubscribe function.
 *
 * Kept as a listener rather than a hardcoded `console.warn` so a test can assert
 * on the report without capturing global console output, and so a future crash
 * reporter can be attached in one place.
 */
export function onStrategyDiagnostic(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** One line, safe to log. Contains no cards and nothing about the player. */
export function describeStrategyDiagnostic(record: StrategyDiagnosticRecord): string {
  return (
    `[strategy] ${record.code} for ${record.key ?? "an invalid state"} ` +
    `under ${record.rulesetId}@${record.rulesetVersion} — no recommendation was shown`
  );
}
