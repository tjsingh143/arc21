/**
 * B-R6 at the storage boundary: when may a failed keychain write be reported
 * to GoTrue as a success?
 *
 * GoTrue keeps no session in memory. Every `getSession()` — and so every
 * outbound request — reads the credential back from this adapter, and GoTrue
 * announces SIGNED_IN the moment `setItem` resolves. So `setItem` resolving is
 * a statement about identity: "the player you are about to announce is the one
 * every request will now be sent as". The audit's split (screen B, requests A)
 * was that statement made falsely.
 *
 * These cases pin the rule down against an in-memory keychain:
 *
 *   - a failed write that would change the stored PLAYER rejects, and the
 *     previous player is still served;
 *   - a failed write for the SAME player still degrades quietly (a token
 *     refresh, securing on the same UUID) — refusing it would only take a
 *     working player offline;
 *   - a value that is not a session carries no identity and keeps the
 *     historical never-throw behaviour;
 *   - "did it land?" is answered by reading storage, not by which native call
 *     threw — and at every crash boundary, `setItem` resolves exactly when a
 *     relaunch would restore the new player.
 *
 * `tests/server/credential-replacement.integration.test.ts` is the same rule
 * proved through the real SDK, GoTrue and the production Auth store.
 */

import { describe, expect, it } from "vitest";

import { classifyAuthError } from "../../src/features/auth/auth-failure.js";
import {
  ChunkedSecureSessionStorage,
  SessionReplacementError,
  storedPlayerOf,
  type SecureStoreLike,
  type SessionStorageDurability,
} from "../../src/lib/supabase/secure-session-storage.js";

const KEY = "sb-test-auth-token";
const PLAYER_A = "11111111-1111-4111-8111-111111111111";
const PLAYER_B = "22222222-2222-4222-8222-222222222222";

/** Who a stored value restores, parsed here so the crash case measures storage rather than trusting it. */
function restoredPlayer(raw: string | null): string | null {
  return raw === null ? null : ((JSON.parse(raw) as { user?: { id?: string } }).user?.id ?? null);
}

/** A GoTrue-shaped session: long enough to be chunked, as real ones are. */
function session(userId: string, token: string): string {
  return JSON.stringify({
    access_token: `${token}.${"x".repeat(900)}`,
    refresh_token: `refresh-${token}`,
    token_type: "bearer",
    expires_in: 3600,
    expires_at: 2_000_000_000,
    user: { id: userId, aud: "authenticated", role: "authenticated", app_metadata: {}, user_metadata: {} },
  });
}

interface Keychain extends SecureStoreLike {
  readonly entries: Map<string, string>;
  failWrites: boolean;
  failReads: boolean;
}

function keychain(): Keychain {
  const entries = new Map<string, string>();
  const chain: Keychain = {
    entries,
    failWrites: false,
    failReads: false,
    async getItemAsync(key) {
      if (chain.failReads) throw new Error("keychain read failed");
      return entries.get(key) ?? null;
    },
    async setItemAsync(key, value) {
      if (chain.failWrites) throw new Error("keychain write failed");
      entries.set(key, value);
    },
    async deleteItemAsync(key) {
      entries.delete(key);
    },
  };
  return chain;
}

describe("a failed keychain write that would change the stored player", () => {
  it("rejects, keeps serving the previous player, and says durability is unavailable", async () => {
    const chain = keychain();
    const states: SessionStorageDurability[] = [];
    const storage = new ChunkedSecureSessionStorage(chain, {}, (_key, state) => states.push(state));
    const a = session(PLAYER_A, "token-a");
    await storage.setItem(KEY, a);

    chain.failWrites = true;
    await expect(storage.setItem(KEY, session(PLAYER_B, "token-b"))).rejects.toBeInstanceOf(SessionReplacementError);

    expect(await storage.getItem(KEY)).toBe(a);
    expect(await new ChunkedSecureSessionStorage(chain).getItem(KEY)).toBe(a);
    expect(states.at(-1)).toBe("unavailable");
  });

  it("rejects the first session a device could not store at all", async () => {
    const chain = keychain();
    chain.failWrites = true;
    const storage = new ChunkedSecureSessionStorage(chain);

    // Nothing would be served, so no player may be announced.
    await expect(storage.setItem(KEY, session(PLAYER_A, "token-a"))).rejects.toBeInstanceOf(SessionReplacementError);
    expect(await storage.getItem(KEY)).toBeNull();
  });

  it("rejects when it cannot even read back what is stored", async () => {
    const chain = keychain();
    const storage = new ChunkedSecureSessionStorage(chain);
    await storage.setItem(KEY, session(PLAYER_A, "token-a"));

    chain.failWrites = true;
    chain.failReads = true;
    await expect(storage.setItem(KEY, session(PLAYER_A, "token-a2"))).rejects.toBeInstanceOf(SessionReplacementError);
  });

  it("rejects a session whose player cannot be read, rather than guessing it matches", async () => {
    const chain = keychain();
    const storage = new ChunkedSecureSessionStorage(chain);
    await storage.setItem(KEY, session(PLAYER_A, "token-a"));

    chain.failWrites = true;
    const anonymous = JSON.stringify({ access_token: "t".repeat(900), refresh_token: "r" });
    await expect(storage.setItem(KEY, anonymous)).rejects.toBeInstanceOf(SessionReplacementError);
  });

  it("is classified as the device being unable to store credentials, never as a wrong password", () => {
    expect(classifyAuthError(new SessionReplacementError())).toMatchObject({ code: "PERSISTENCE_UNAVAILABLE" });
  });
});

describe("a failed keychain write that cannot split identity", () => {
  it("still degrades quietly for the same player, serving that player's previous session", async () => {
    const chain = keychain();
    const states: SessionStorageDurability[] = [];
    const storage = new ChunkedSecureSessionStorage(chain, {}, (_key, state) => states.push(state));
    const before = session(PLAYER_A, "token-a");
    await storage.setItem(KEY, before);

    chain.failWrites = true;
    await expect(storage.setItem(KEY, session(PLAYER_A, "token-a-rotated"))).resolves.toBeUndefined();
    expect(await storage.getItem(KEY)).toBe(before);
    expect(states.at(-1)).toBe("unavailable");
  });

  it("keeps the never-throw behaviour for values that are not sessions, such as a PKCE verifier", async () => {
    const chain = keychain();
    chain.failWrites = true;
    const storage = new ChunkedSecureSessionStorage(chain);

    // `setItemAsync` JSON-encodes what GoTrue stores; a verifier is a string.
    await expect(storage.setItem(`${KEY}-code-verifier`, JSON.stringify("verifier/PASSWORD_RECOVERY"))).resolves.toBeUndefined();
    await expect(storage.setItem("k", "v")).resolves.toBeUndefined();
  });

  it("judges a write that reported failure by what storage now serves", async () => {
    // A platform that applies the write and then reports a failed flush —
    // Android's preferences update memory before `commit()` can fail.
    const chain = keychain();
    const states: SessionStorageDurability[] = [];
    const landsThenThrows: SecureStoreLike = {
      ...chain,
      setItemAsync: async (key, value) => {
        chain.entries.set(key, value);
        if (key === KEY) throw new Error("flush failed after the value was applied");
      },
    };
    const storage = new ChunkedSecureSessionStorage(landsThenThrows, {}, (_key, state) => states.push(state));
    await storage.setItem(KEY, session(PLAYER_A, "token-a")).catch(() => undefined);

    const b = session(PLAYER_B, "token-b");
    await expect(storage.setItem(KEY, b)).resolves.toBeUndefined();
    expect(await storage.getItem(KEY)).toBe(b);
    expect(states.at(-1)).toBe("durable");
  });
});

describe("replacing one player with another across a crash", () => {
  it("never announces a player that a relaunch would not restore, at every mutation boundary", async () => {
    const a = session(PLAYER_A, "token-a");
    const b = session(PLAYER_B, "token-b");

    const initial = keychain();
    await new ChunkedSecureSessionStorage(initial).setItem(KEY, a);
    const before = new Map(initial.entries);

    let mutations = 0;
    const counter: SecureStoreLike = {
      ...initial,
      setItemAsync: async (key, value) => { mutations += 1; initial.entries.set(key, value); },
      deleteItemAsync: async (key) => { mutations += 1; initial.entries.delete(key); },
    };
    await new ChunkedSecureSessionStorage(counter).setItem(KEY, b);
    expect(mutations).toBeGreaterThan(3);

    for (let boundary = 0; boundary <= mutations; boundary += 1) {
      const backend = keychain();
      for (const [key, value] of before) backend.entries.set(key, value);
      let writes = 0;
      // Once the process is "killed", every later native call fails too —
      // including the read-back — so nothing can make the crash recoverable.
      const crash = (): void => {
        if (writes >= boundary) throw new Error("simulated process termination");
      };
      const interrupted: SecureStoreLike = {
        getItemAsync: async (key) => { crash(); return backend.entries.get(key) ?? null; },
        setItemAsync: async (key, value) => { crash(); backend.entries.set(key, value); writes += 1; crash(); },
        deleteItemAsync: async (key) => { crash(); backend.entries.delete(key); writes += 1; crash(); },
      };
      const announced = await new ChunkedSecureSessionStorage(interrupted).setItem(KEY, b).then(() => true, () => false);

      const restored = restoredPlayer(await new ChunkedSecureSessionStorage(backend).getItem(KEY));
      // A relaunch restores one complete player, never a mixture.
      expect([PLAYER_A, PLAYER_B], `crash boundary ${boundary}`).toContain(restored);
      /*
       * GoTrue adopts B the moment `setItem` resolves, so a resolution must
       * mean B is what a relaunch restores. The converse is deliberately not
       * asserted: a process killed after the head landed announces nothing —
       * it is gone — and its relaunch adopts B consistently.
       */
      if (announced) expect(restored, `crash boundary ${boundary}`).toBe(PLAYER_B);
      // Only a failed native call refuses; an uninterrupted replacement lands.
      if (boundary === mutations) expect(announced).toBe(true);
    }
  });
});

describe("reading the player a stored value authenticates as", () => {
  it("reads only sessions, and treats an unreadable player as unknown", () => {
    expect(storedPlayerOf(null)).toBeNull();
    expect(storedPlayerOf(session(PLAYER_A, "t"))).toBe(PLAYER_A);
    expect(storedPlayerOf(JSON.stringify({ refresh_token: "r" }))).toBeNull();
    expect(storedPlayerOf(JSON.stringify({ access_token: "t", user: { id: "" } }))).toBeNull();
    expect(storedPlayerOf(JSON.stringify("verifier"))).toBeUndefined();
    expect(storedPlayerOf(JSON.stringify({ user: { id: PLAYER_A } }))).toBeUndefined();
    expect(storedPlayerOf("not json")).toBeUndefined();
  });
});
