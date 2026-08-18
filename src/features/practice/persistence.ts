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
 */

import { z } from "zod";

import { applyCommand, type EngineState } from "../../../shared/blackjack/reducer.js";
import { rulesetKey } from "../../../shared/blackjack/rules.js";
import type { KeyValueStore } from "../../lib/persistence/key-value-store.js";
import type { AssistanceMode, PracticeStats } from "./practice-store.js";

/** Bump when the persisted shape changes incompatibly. */
export const PRACTICE_SCHEMA_VERSION = 1;

const SESSION_KEY = "practice:session";
const ARCHIVE_KEY = "practice:archive";

const statsSchema = z.object({
  handsPlayed: z.number(),
  decisions: z.number(),
  correct: z.number(),
  unaidedDecisions: z.number(),
  unaidedCorrect: z.number(),
  estimatedEvLost: z.number(),
  hardDecisions: z.number(),
  hardCorrect: z.number(),
  softDecisions: z.number(),
  softCorrect: z.number(),
  pairDecisions: z.number(),
  pairCorrect: z.number(),
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
  stats: statsSchema,
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

export interface PersistedPractice {
  schemaVersion: number;
  rulesetKey: string;
  savedAt: string;
  mode: AssistanceMode;
  lastBet: number;
  stats: PracticeStats;
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
}

export function serialisePractice(input: {
  engineState: EngineState;
  stats: PracticeStats;
  mode: AssistanceMode;
  lastBet: number;
  savedAt: string;
}): string {
  const payload: PersistedPractice = {
    schemaVersion: PRACTICE_SCHEMA_VERSION,
    rulesetKey: rulesetKey(input.engineState.rules),
    savedAt: input.savedAt,
    mode: input.mode,
    lastBet: input.lastBet,
    stats: input.stats,
    engineState: input.engineState,
  };
  return JSON.stringify(payload);
}

/**
 * Proves a restored state is actually drivable before the UI is pointed at it.
 *
 * A blob can satisfy every structural check and still be unusable — a phase the
 * current engine no longer knows, a cursor pointing past the end of a seat's
 * hands. Issuing one no-op command is a cheap end-to-end proof, and it fails
 * here (where we can archive and start clean) rather than on the player's first
 * tap.
 */
function isEngineStateUsable(state: EngineState): boolean {
  try {
    applyCommand(state, { type: "ADVANCE" }, {});
    return true;
  } catch {
    return false;
  }
}

export function deserialisePractice(
  raw: string | null,
  expectedRulesetKey: string,
): LoadResult {
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
  if (envelope.schemaVersion !== PRACTICE_SCHEMA_VERSION) {
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
      stats: envelope.stats,
      engineState,
    },
    failure: null,
  };
}

/** Durable read/write of the Practice session. */
export class PracticePersistence {
  constructor(private readonly store: KeyValueStore) {}

  async save(input: Parameters<typeof serialisePractice>[0]): Promise<void> {
    await this.store.set(SESSION_KEY, serialisePractice(input));
  }

  async load(expectedRulesetKey: string): Promise<LoadResult> {
    const raw = await this.store.get(SESSION_KEY);
    const result = deserialisePractice(raw, expectedRulesetKey);

    // Anything unusable is archived, not silently dropped: the stats and final
    // bankroll are still meaningful to the player even when the hand is not
    // resumable, and keeping the blob makes a bad save diagnosable.
    if (raw !== null && result.failure !== null && result.failure !== "ABSENT") {
      await this.archive(raw, result.failure);
      await this.store.remove(SESSION_KEY);
    }

    return result;
  }

  async clear(): Promise<void> {
    await this.store.remove(SESSION_KEY);
  }

  private async archive(raw: string, reason: LoadFailure): Promise<void> {
    try {
      await this.store.set(
        ARCHIVE_KEY,
        JSON.stringify({ reason, archivedRaw: raw.slice(0, 20_000) }),
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
