/**
 * Arc 21 — the guest identity.
 *
 * Guest is a first-class mode, not a waiting room. The whole offline product —
 * Practice, Learn, Career, statistics, settings — belongs to a guest and works
 * exactly as well without an account as with one. Nothing in this file nags,
 * expires, degrades or counts down.
 *
 * What a guest identity is: a local, unguessable string that lets device-local
 * records be attributed to "this player on this device" rather than to nobody.
 * What it is NOT: an identity the server recognises. It never appears in a
 * request, never authenticates anything, and is namespaced `guest_…` so it can
 * never be mistaken for an `auth.users.id` (see `src/lib/supabase/ids.ts`).
 *
 * It is written to the same `KeyValueStore` as the practice save rather than to
 * SecureStore. It is not a credential — it authorises nothing — and putting
 * non-secrets in the keychain trains people to look for secrets there.
 */

import { z } from "zod";

import type { KeyValueStore } from "../../lib/persistence/key-value-store.js";
import { newGuestId } from "../../lib/supabase/ids.js";

export const GUEST_SCHEMA_VERSION = 1;

/** Namespaced so it cannot collide with the practice or onboarding keys. */
export const GUEST_IDENTITY_KEY = "auth:guest:v1";

export interface GuestIdentity {
  readonly schemaVersion: number;
  readonly guestId: string;
  /** ISO 8601. Used only to date an eventual conversion. */
  readonly createdAt: string;
}

const guestSchema = z.object({
  schemaVersion: z.number(),
  guestId: z.string().min(8).max(64),
  createdAt: z.string().min(1),
});

export function serialiseGuestIdentity(identity: GuestIdentity): string {
  return JSON.stringify(identity);
}

/**
 * Parses a stored identity. Untrusted input, like every stored blob in this
 * app: anything that does not validate is treated as absent, and a fresh
 * identity is minted. The cost of that is losing the attribution of local
 * records to a string nobody ever sees.
 */
export function parseGuestIdentity(raw: string | null): GuestIdentity | null {
  if (raw === null) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  const result = guestSchema.safeParse(parsed);
  if (!result.success) return null;
  if (result.data.schemaVersion !== GUEST_SCHEMA_VERSION) return null;
  return result.data;
}

export function buildGuestIdentity(now: Date, guestId: string = newGuestId()): GuestIdentity {
  return { schemaVersion: GUEST_SCHEMA_VERSION, guestId, createdAt: now.toISOString() };
}

export class GuestIdentityStore {
  constructor(private readonly store: KeyValueStore) {}

  async read(): Promise<GuestIdentity | null> {
    return parseGuestIdentity(await this.store.get(GUEST_IDENTITY_KEY));
  }

  /**
   * Returns the stored identity, creating one if there is none.
   *
   * A write failure is not fatal: the identity is returned anyway and the app
   * runs with an in-memory one for this launch. A guest who cannot be given a
   * durable local id must still be able to play.
   */
  async ensure(now: Date = new Date()): Promise<GuestIdentity> {
    const existing = await this.read().catch(() => null);
    if (existing !== null) return existing;

    const created = buildGuestIdentity(now);
    try {
      await this.store.set(GUEST_IDENTITY_KEY, serialiseGuestIdentity(created));
    } catch {
      // Ephemeral for this launch rather than no guest at all.
    }
    return created;
  }

  async clear(): Promise<void> {
    await this.store.remove(GUEST_IDENTITY_KEY);
  }
}
