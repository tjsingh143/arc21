/**
 * The guest identity.
 *
 * A stored record is untrusted input, exactly like the practice save and the
 * onboarding flag: it can be truncated, hand-edited, or written by a build whose
 * shape differed. Anything that does not validate is treated as absent and a
 * fresh identity is minted — the cost of that is losing the attribution of local
 * records to a string nobody ever sees, which is the right thing to lose.
 */

import { describe, expect, it } from "vitest";

import { MemoryKeyValueStore, type KeyValueStore } from "../../src/lib/persistence/key-value-store.js";
import {
  GUEST_IDENTITY_KEY,
  GuestIdentityStore,
  buildGuestIdentity,
  parseGuestIdentity,
  serialiseGuestIdentity,
} from "../../src/features/auth/guest.js";
import { isGuestId } from "../../src/lib/supabase/ids.js";

const NOW = new Date("2026-08-15T12:00:00.000Z");

describe("identity", () => {
  it("is namespaced so it can never pass for a server user id", () => {
    // Anything that receives this string and expects a UUID is a bug; the
    // prefix makes that visible at the first hop rather than three layers down.
    const identity = buildGuestIdentity(NOW);

    expect(isGuestId(identity.guestId)).toBe(true);
    expect(identity.guestId).toMatch(
      /^guest_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });

  it("is not guessable — two identities never collide", () => {
    const ids = new Set(Array.from({ length: 500 }, () => buildGuestIdentity(NOW).guestId));
    expect(ids.size).toBe(500);
  });

  it("round-trips", () => {
    const identity = buildGuestIdentity(NOW);
    expect(parseGuestIdentity(serialiseGuestIdentity(identity))).toEqual(identity);
  });
});

describe("parsing a stored record", () => {
  it.each([
    ["absent", null],
    ["not JSON", "{{{"],
    ["not an object", '"hello"'],
    ["missing the id", '{"schemaVersion":1,"createdAt":"2026-01-01T00:00:00.000Z"}'],
    [
      "a future schema version",
      '{"schemaVersion":99,"guestId":"guest_abcdefgh","createdAt":"2026-01-01T00:00:00.000Z"}',
    ],
  ])("treats %s as absent", (_label, raw) => {
    expect(parseGuestIdentity(raw)).toBeNull();
  });
});

describe("the store", () => {
  it("creates an identity on first use and reuses it after", async () => {
    const backing = new MemoryKeyValueStore();
    const store = new GuestIdentityStore(backing);

    const first = await store.ensure(NOW);
    const second = await store.ensure(NOW);

    expect(second.guestId).toBe(first.guestId);
    expect(await backing.get(GUEST_IDENTITY_KEY)).toBeTypeOf("string");
  });

  it("replaces a corrupt record rather than failing", async () => {
    const backing = new MemoryKeyValueStore();
    await backing.set(GUEST_IDENTITY_KEY, "not json");

    const identity = await new GuestIdentityStore(backing).ensure(NOW);

    expect(isGuestId(identity.guestId)).toBe(true);
  });

  it("still returns an identity when the write fails", async () => {
    // A guest who cannot be given a durable local id must still be able to play;
    // the identity is simply ephemeral for this launch.
    const failing: KeyValueStore = {
      get: async () => null,
      set: () => Promise.reject(new Error("disk full")),
      remove: async () => {},
    };

    await expect(new GuestIdentityStore(failing).ensure(NOW)).resolves.toMatchObject({
      schemaVersion: 1,
    });
  });

  it("still returns an identity when the read rejects", async () => {
    const failing: KeyValueStore = {
      get: () => Promise.reject(new Error("storage unavailable")),
      set: async () => {},
      remove: async () => {},
    };

    const identity = await new GuestIdentityStore(failing).ensure(NOW);
    expect(isGuestId(identity.guestId)).toBe(true);
  });
});
