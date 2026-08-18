/**
 * Arc 21 — career progress persistence.
 *
 * Career progress is small, and unlike the Practice session it is not resumable
 * state: it records what a player has already achieved. It is therefore written
 * whole after every completed attempt rather than after every engine
 * transition.
 *
 * A saved blob is UNTRUSTED INPUT — it may be corrupt, truncated, written by an
 * older build, or edited by the user. Everything is validated on load, unknown
 * node slugs are dropped rather than resurrected as phantom entries, and a blob
 * that fails validation is archived for diagnosis and replaced with empty
 * progress. Losing local star records is a disappointment; crashing on every
 * launch is a broken app.
 *
 * LOCAL PROGRESS UNLOCKS LOCAL CONTENT AND NOTHING ELSE. There is no
 * `rewardClaimed: true` write path here, because chips and XP are
 * server-authoritative and a client that could grant them is a client an
 * attacker could grant them from.
 */

import { z } from "zod";

import {
  CAREER_NODES,
  CAREER_PROGRESS_VERSION,
  emptyCareerProgress,
  type CareerProgress,
  type NodeProgress,
} from "../../../shared/career/index.js";
import type { KeyValueStore } from "../../lib/persistence/key-value-store.js";

const PROGRESS_KEY = "career:progress";
const ARCHIVE_KEY = "career:archive";

const KNOWN_SLUGS: ReadonlySet<string> = new Set(CAREER_NODES.map((node) => node.slug));

const nodeProgressSchema = z.object({
  slug: z.string(),
  // Clamped by the schema rather than trusted: a hand-edited 99 must not print
  // ninety-nine stars on the map.
  bestStars: z.number().int().min(0).max(3),
  attempts: z.number().int().min(0),
  bestAccuracyPercent: z.number().int().min(0).max(100).nullable(),
  bestEndingBankroll: z.number().int().min(0).nullable(),
  lastPlayedAt: z.string().nullable(),
  rewardOwed: z.boolean(),
  rewardClaimed: z.boolean(),
});

const progressSchema = z.object({
  version: z.number(),
  nodes: z.record(z.string(), nodeProgressSchema),
});

export type CareerLoadFailure = "ABSENT" | "UNPARSEABLE" | "SCHEMA_MISMATCH";

export interface CareerLoadResult {
  progress: CareerProgress;
  failure: CareerLoadFailure | null;
}

export function serialiseCareerProgress(progress: CareerProgress): string {
  return JSON.stringify(progress);
}

export function deserialiseCareerProgress(raw: string | null): CareerLoadResult {
  if (raw === null) return { progress: emptyCareerProgress(), failure: "ABSENT" };

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { progress: emptyCareerProgress(), failure: "UNPARSEABLE" };
  }

  const result = progressSchema.safeParse(parsed);
  if (!result.success) return { progress: emptyCareerProgress(), failure: "UNPARSEABLE" };

  if (result.data.version !== CAREER_PROGRESS_VERSION) {
    return { progress: emptyCareerProgress(), failure: "SCHEMA_MISMATCH" };
  }

  // Keep only nodes this build actually ships, keyed by their own slug. A blob
  // written by a future build with extra nodes, or one whose key and `slug`
  // field disagree, must not leak entries the map cannot render.
  const nodes: Record<string, NodeProgress> = {};
  for (const [key, entry] of Object.entries(result.data.nodes)) {
    if (!KNOWN_SLUGS.has(key)) continue;
    if (entry.slug !== key) continue;
    nodes[key] = {
      slug: entry.slug,
      bestStars: entry.bestStars as NodeProgress["bestStars"],
      attempts: entry.attempts,
      bestAccuracyPercent: entry.bestAccuracyPercent,
      bestEndingBankroll: entry.bestEndingBankroll,
      lastPlayedAt: entry.lastPlayedAt,
      rewardOwed: entry.rewardOwed,
      rewardClaimed: entry.rewardClaimed,
    };
  }

  return { progress: { version: CAREER_PROGRESS_VERSION, nodes }, failure: null };
}

/** Durable read/write of career progress. */
export class CareerPersistence {
  constructor(private readonly store: KeyValueStore) {}

  async load(): Promise<CareerLoadResult> {
    const raw = await this.store.get(PROGRESS_KEY);
    const result = deserialiseCareerProgress(raw);

    if (raw !== null && result.failure !== null && result.failure !== "ABSENT") {
      await this.archive(raw, result.failure);
      await this.store.remove(PROGRESS_KEY);
    }

    return result;
  }

  async save(progress: CareerProgress): Promise<void> {
    await this.store.set(PROGRESS_KEY, serialiseCareerProgress(progress));
  }

  async clear(): Promise<void> {
    await this.store.remove(PROGRESS_KEY);
  }

  private async archive(raw: string, reason: CareerLoadFailure): Promise<void> {
    try {
      await this.store.set(
        ARCHIVE_KEY,
        JSON.stringify({ reason, archivedRaw: raw.slice(0, 20_000) }),
      );
    } catch {
      // Best effort. Failing to keep a diagnostic copy must never stop a player
      // from starting again.
    }
  }

  async readArchive(): Promise<{ reason: CareerLoadFailure; archivedRaw: string } | null> {
    const raw = await this.store.get(ARCHIVE_KEY);
    if (!raw) return null;
    try {
      return JSON.parse(raw) as { reason: CareerLoadFailure; archivedRaw: string };
    } catch {
      return null;
    }
  }
}
