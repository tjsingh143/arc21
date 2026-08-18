/**
 * Arc 21 — the onboarding completion flag.
 *
 * One boolean decides which screen the app opens on, so it is worth treating
 * carefully. The record is written to the SAME durable store the Practice
 * session uses (`KeyValueStore`) rather than to a second storage layer: two
 * storage layers means two failure modes, two migration stories and two places
 * to look when a launch goes wrong.
 *
 * A stored record is UNTRUSTED INPUT. It may be corrupt, truncated, or written
 * by an older build. Anything that does not validate is treated as "not
 * onboarded" — the failure mode is showing three short pages again, which costs
 * the player seconds. The opposite failure mode is skipping the 18+ and
 * no-monetary-value disclosure, which is not acceptable at any price.
 *
 * Pure functions here, so `tests/onboarding` can exercise every branch without
 * a device, a renderer, or SQLite.
 */

import { z } from "zod";

import type { KeyValueStore } from "../../lib/persistence/key-value-store.js";

/** Bump when the record shape or the disclosure it acknowledges changes. */
export const ONBOARDING_SCHEMA_VERSION = 1;

/** Namespaced so it cannot collide with the Practice session's keys. */
export const ONBOARDING_KEY = "onboarding:completion";

/**
 * How the player entered the app.
 *
 * How the player left the introduction: straight into Practice, or via the
 * account screens. Recorded rather than inferred, because "they have seen the
 * disclosure" and "they have an account" are different facts and a future
 * disclosure change needs to know which.
 * When one lands, `"account"` joins this union and the schema version is bumped
 * so an old guest record is re-evaluated rather than silently reinterpreted.
 */
export type OnboardingEntry = "guest" | "account";

export interface OnboardingCompletion {
  schemaVersion: number;
  /** ISO 8601. Recorded so a future disclosure change can be dated. */
  completedAt: string;
  entry: OnboardingEntry;
}

const completionSchema = z.object({
  schemaVersion: z.number(),
  completedAt: z.string().min(1),
  entry: z.enum(["guest", "account"]),
});

export function serialiseCompletion(completion: OnboardingCompletion): string {
  return JSON.stringify(completion);
}

/**
 * Parses a stored record.
 *
 * Returns null — meaning "show onboarding" — for absent, unparseable,
 * structurally wrong, or unrecognised-version records. A record from a NEWER
 * build is also rejected: this build cannot know what that version acknowledged.
 */
export function parseCompletion(raw: string | null): OnboardingCompletion | null {
  if (raw === null) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  const result = completionSchema.safeParse(parsed);
  if (!result.success) return null;
  if (result.data.schemaVersion !== ONBOARDING_SCHEMA_VERSION) return null;

  return {
    schemaVersion: result.data.schemaVersion,
    completedAt: result.data.completedAt,
    entry: result.data.entry,
  };
}

export function buildCompletion(entry: OnboardingEntry, now: Date): OnboardingCompletion {
  return {
    schemaVersion: ONBOARDING_SCHEMA_VERSION,
    completedAt: now.toISOString(),
    entry,
  };
}

/** Durable read/write of the flag over any `KeyValueStore`. */
export class OnboardingFlagStore {
  constructor(private readonly store: KeyValueStore) {}

  async read(): Promise<OnboardingCompletion | null> {
    return parseCompletion(await this.store.get(ONBOARDING_KEY));
  }

  async complete(entry: OnboardingEntry, now: Date = new Date()): Promise<OnboardingCompletion> {
    const completion = buildCompletion(entry, now);
    await this.store.set(ONBOARDING_KEY, serialiseCompletion(completion));
    return completion;
  }

  /** Used by Settings' "replay the introduction", and by tests. */
  async clear(): Promise<void> {
    await this.store.remove(ONBOARDING_KEY);
  }
}
