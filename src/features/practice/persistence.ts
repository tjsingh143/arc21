/**
 * Arc 21 — Practice session persistence.
 *
 * Practice must survive the app being killed mid-hand: the player's chips are on
 * the felt and the shoe has a composition they may be reasoning about. Saving
 * only the bankroll would silently reshuffle their hand away.
 *
 * A saved blob is UNTRUSTED INPUT. It may be corrupt, truncated, or written by
 * an older build whose engine or ruleset differs. Every load is validated, and
 * anything that fails validation is archived and discarded rather than fed to
 * the engine — the specification's rule is to degrade safely, never to crash
 * repeatedly on a bad save.
 *
 * TWO RECORDS, AND WHY THAT MATTERS MORE THAN IT LOOKS.
 *
 * The SESSION (a hand in progress) and the STATISTICS (a cumulative record of
 * every hand ever played here) are stored under separate keys. They used to
 * share one blob, which meant a single unparseable byte in the middle of a shoe
 * erased a player's entire practice history — hands, accuracy, EV lost, all of
 * it — because the whole envelope was thrown away together. A session is
 * disposable; a record of months of practice is not. Failing safely has to mean
 * failing safely for the data that was never in question.
 *
 * MIGRATION IS A MIGRATION, NOT A DELETION.
 *
 * `SESSION_SCHEMA_VERSION` 1 saves are UPGRADED, not rejected: v1 carried the
 * statistics inside the session envelope and had no decision log, so the loader
 * lifts the statistics into their own record and defaults the log. An additive
 * schema change must never cost the player anything, and a version this build
 * does not know is archived rather than guessed at.
 */

import { z } from "zod";

import { applyCommand, type EngineState } from "../../../shared/blackjack/reducer.js";
import { rulesetKey } from "../../../shared/blackjack/rules.js";
import type { KeyValueStore } from "../../lib/persistence/key-value-store.js";
import {
  EMPTY_PRACTICE_STATS,
  MAX_HAND_HISTORY,
  type PracticeHandRecord,
  type PracticeStats,
} from "./practice-record.js";
import type { AssistanceMode, DecisionFeedback } from "./practice-store.js";

/**
 * Bump when the persisted SESSION shape changes in a way older code could not
 * read. Additive changes are migrated below instead.
 *
 *   1  engine state + mode + lastBet + embedded statistics
 *   2  statistics moved to their own record; decision log and hand history added
 */
export const SESSION_SCHEMA_VERSION = 2;

/** Versions this build can read. Anything else is archived, never guessed at. */
export const READABLE_SESSION_VERSIONS: readonly number[] = [1, 2];

/** Bump when the persisted STATISTICS shape changes incompatibly. */
export const STATS_SCHEMA_VERSION = 1;

/**
 * Retained name. `PRACTICE_SCHEMA_VERSION` is what the rest of the app and the
 * older tests refer to, and it has always meant the session envelope.
 */
export const PRACTICE_SCHEMA_VERSION = SESSION_SCHEMA_VERSION;

const SESSION_KEY = "practice:session";
const STATS_KEY = "practice:stats";
const ARCHIVE_KEY = "practice:archive";

export { SESSION_KEY, STATS_KEY, ARCHIVE_KEY };

/** How many graded decisions the log keeps. */
export const MAX_DECISION_LOG = 100;

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

/**
 * Statistics are read LENIENTLY on purpose.
 *
 * Every field is a counter with a meaningful zero, so a save written before a
 * counter existed is not a broken save — it is a save from a build that had not
 * started counting that thing yet. Rejecting it would delete a real record to
 * avoid showing a zero. Anything non-numeric is replaced with zero rather than
 * failing the whole record, for the same reason.
 */
const statsSchema = z.record(z.string(), z.unknown());

const decisionSchema = z.object({
  chosen: z.string(),
  recommended: z.string(),
  correct: z.boolean(),
  evLost: z.number().nullable(),
  handLabel: z.string(),
  upcardLabel: z.string(),
  handNumber: z.number(),
});

const handRecordSchema = z.object({
  handNumber: z.number(),
  wagered: z.number(),
  net: z.number(),
  outcomes: z.array(z.string()),
  playerTotals: z.array(z.number()),
  dealerTotal: z.number().nullable(),
  dealerBusted: z.boolean(),
  insuranceNet: z.number(),
});

/**
 * The envelope is validated strictly; the engine state is checked structurally
 * and then *exercised* (see `isEngineStateUsable`) rather than re-declared field
 * by field here. Duplicating the engine's shape in a Zod schema would create a
 * second definition of the game that could drift from the real one.
 */
const envelopeSchema = z.object({
  schemaVersion: z.number(),
  rulesetKey: z.string(),
  savedAt: z.string(),
  mode: z.enum(["play", "learn", "analysis", "challenge"]),
  lastBet: z.number(),
  /** v1 carried the statistics here. v2 keeps them in their own record. */
  stats: statsSchema.optional(),
  decisionLog: z.array(decisionSchema).optional(),
  handHistory: z.array(handRecordSchema).optional(),
  engineState: z.object({
    gameId: z.string(),
    phase: z.string(),
    version: z.number(),
    handNumber: z.number(),
    seats: z.array(z.unknown()).min(1),
    dealer: z.object({ cards: z.array(z.unknown()) }).loose(),
    shoe: z.object({
      cards: z.array(z.unknown()).min(1),
      nextIndex: z.number(),
      shuffleNumber: z.number(),
      cutIndex: z.number(),
    }).loose(),
    rules: z.object({ id: z.string(), version: z.number() }).loose(),
  }).loose(),
});

const statsRecordSchema = z.object({
  schemaVersion: z.number(),
  savedAt: z.string(),
  stats: statsSchema,
});

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PersistedPractice {
  schemaVersion: number;
  rulesetKey: string;
  savedAt: string;
  mode: AssistanceMode;
  lastBet: number;
  stats: PracticeStats;
  decisionLog: DecisionFeedback[];
  handHistory: PracticeHandRecord[];
  engineState: EngineState;
}

export type LoadFailure =
  | "ABSENT"
  | "UNPARSEABLE"
  | "SCHEMA_MISMATCH"
  | "RULESET_MISMATCH"
  | "ENGINE_REJECTED";

export interface LoadResult {
  session: PersistedPractice | null;
  failure: LoadFailure | null;
  /**
   * The cumulative statistics, which survive a session that does not.
   *
   * Null only when there is no statistics record at all — a first launch, or a
   * player who has never completed a command. A session failure never nulls it.
   */
  stats: PracticeStats | null;
}

export interface SavePracticeInput {
  engineState: EngineState;
  stats: PracticeStats;
  mode: AssistanceMode;
  lastBet: number;
  savedAt: string;
  decisionLog?: readonly DecisionFeedback[];
  handHistory?: readonly PracticeHandRecord[];
}

// ---------------------------------------------------------------------------
// Serialisation
// ---------------------------------------------------------------------------

export function serialisePractice(input: SavePracticeInput): string {
  return JSON.stringify({
    schemaVersion: SESSION_SCHEMA_VERSION,
    rulesetKey: rulesetKey(input.engineState.rules),
    savedAt: input.savedAt,
    mode: input.mode,
    lastBet: input.lastBet,
    decisionLog: [...(input.decisionLog ?? [])].slice(0, MAX_DECISION_LOG),
    handHistory: [...(input.handHistory ?? [])].slice(0, MAX_HAND_HISTORY),
    engineState: input.engineState,
  });
}

export function serialisePracticeStats(stats: PracticeStats, savedAt: string): string {
  return JSON.stringify({ schemaVersion: STATS_SCHEMA_VERSION, savedAt, stats });
}

/**
 * Coerces a stored statistics object into the current shape.
 *
 * Missing keys become zero and non-finite values become zero. Unknown keys are
 * dropped. This is the whole of the additive migration: a build that adds a
 * counter reads every older save without losing a single figure from it.
 */
export function migratePracticeStats(input: unknown): PracticeStats {
  const source = (input ?? {}) as Record<string, unknown>;
  const migrated = { ...EMPTY_PRACTICE_STATS } as Record<string, number>;

  for (const key of Object.keys(EMPTY_PRACTICE_STATS)) {
    const value = source[key];
    if (typeof value === "number" && Number.isFinite(value)) migrated[key] = value;
  }

  return migrated as unknown as PracticeStats;
}

/**
 * Proves a restored state is actually drivable before the UI is pointed at it.
 *
 * A blob can satisfy every structural check and still be unusable — a phase the
 * current engine no longer knows, a cursor pointing past the end of a seat's
 * hands. Issuing one no-op command is a cheap end-to-end proof, and it fails
 * here (where we can archive and start clean) rather than on the player's first
 * tap. The result is discarded: this is a rehearsal, not a move.
 */
function isEngineStateUsable(state: EngineState): boolean {
  try {
    applyCommand(state, { type: "ADVANCE" }, {});
    return true;
  } catch {
    return false;
  }
}

export interface DeserialiseResult {
  session: PersistedPractice | null;
  failure: LoadFailure | null;
}

export function deserialisePractice(
  raw: string | null,
  expectedRulesetKey: string,
): DeserialiseResult {
  if (raw === null) return { session: null, failure: "ABSENT" };

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { session: null, failure: "UNPARSEABLE" };
  }

  const result = envelopeSchema.safeParse(parsed);
  if (!result.success) return { session: null, failure: "UNPARSEABLE" };

  const envelope = result.data;
  if (!READABLE_SESSION_VERSIONS.includes(envelope.schemaVersion)) {
    return { session: null, failure: "SCHEMA_MISMATCH" };
  }

  // A ruleset change alters what the saved cards mean — a hand dealt under
  // different rules is not resumable, it is a different game.
  if (envelope.rulesetKey !== expectedRulesetKey) {
    return { session: null, failure: "RULESET_MISMATCH" };
  }

  const engineState = envelope.engineState as unknown as EngineState;
  if (!isEngineStateUsable(engineState)) {
    return { session: null, failure: "ENGINE_REJECTED" };
  }

  return {
    session: {
      schemaVersion: envelope.schemaVersion,
      rulesetKey: envelope.rulesetKey,
      savedAt: envelope.savedAt,
      mode: envelope.mode,
      lastBet: envelope.lastBet,
      // A v1 envelope carries its statistics inline; a v2 one does not, and the
      // caller overrides this from the statistics record.
      stats: migratePracticeStats(envelope.stats),
      decisionLog: (envelope.decisionLog ?? []) as unknown as DecisionFeedback[],
      handHistory: (envelope.handHistory ?? []) as unknown as PracticeHandRecord[],
      engineState,
    },
    failure: null,
  };
}

/** Reads a statistics record, or null when there is none this build can use. */
export function deserialisePracticeStats(raw: string | null): PracticeStats | null {
  if (raw === null) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  const result = statsRecordSchema.safeParse(parsed);
  if (!result.success) return null;
  if (result.data.schemaVersion > STATS_SCHEMA_VERSION) return null;

  return migratePracticeStats(result.data.stats);
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

/** Durable read/write of the Practice session and its cumulative statistics. */
export class PracticePersistence {
  constructor(private readonly store: KeyValueStore) {}

  async save(input: SavePracticeInput): Promise<void> {
    // Statistics first. If the process dies between the two writes, the record
    // that matters longer is the one already on disk.
    await this.store.set(STATS_KEY, serialisePracticeStats(input.stats, input.savedAt));
    await this.store.set(SESSION_KEY, serialisePractice(input));
  }

  async saveStats(stats: PracticeStats, savedAt = new Date().toISOString()): Promise<void> {
    await this.store.set(STATS_KEY, serialisePracticeStats(stats, savedAt));
  }

  async load(expectedRulesetKey: string): Promise<LoadResult> {
    const [rawSession, rawStats] = await Promise.all([
      this.store.get(SESSION_KEY),
      this.store.get(STATS_KEY),
    ]);

    const result = deserialisePractice(rawSession, expectedRulesetKey);
    let stats = deserialisePracticeStats(rawStats);

    // Anything unusable is archived, not silently dropped: keeping the blob
    // makes a bad save diagnosable, and the failure is named in the archive.
    if (rawSession !== null && result.failure !== null && result.failure !== "ABSENT") {
      await this.archive(rawSession, result.failure);
      await this.store.remove(SESSION_KEY);
    }

    if (result.session !== null) {
      // A v1 save carried the statistics inline and has no separate record yet;
      // adopt them and write the record so the next load reads it directly.
      if (stats === null) {
        stats = result.session.stats;
        await this.saveStats(stats, result.session.savedAt);
      }
      result.session.stats = stats;
    }

    return { session: result.session, failure: result.failure, stats };
  }

  /** Removes the session. Statistics are cumulative and are deliberately kept. */
  async clear(): Promise<void> {
    await this.store.remove(SESSION_KEY);
  }

  /** Removes the cumulative statistics. Only ever called by an explicit reset. */
  async clearStats(): Promise<void> {
    await this.store.remove(STATS_KEY);
  }

  private async archive(raw: string, reason: LoadFailure): Promise<void> {
    try {
      await this.store.set(
        ARCHIVE_KEY,
        JSON.stringify({
          reason,
          archivedAt: new Date().toISOString(),
          archivedRaw: raw.slice(0, 20_000),
        }),
      );
    } catch {
      // Archiving is best-effort. Failing to keep a diagnostic copy must never
      // prevent the player from starting a fresh session.
    }
  }

  async readArchive(): Promise<{ reason: LoadFailure; archivedRaw: string } | null> {
    const raw = await this.store.get(ARCHIVE_KEY);
    if (!raw) return null;
    try {
      return JSON.parse(raw) as { reason: LoadFailure; archivedRaw: string };
    } catch {
      return null;
    }
  }
}
