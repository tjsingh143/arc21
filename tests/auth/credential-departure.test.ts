/**
 * B-F2 — a departure is reported only once the credential has actually left.
 *
 * The final Refresh-B audit (September 30, 2026) persisted player A through the
 * production storage factory, made ONLY the native keychain's delete fail, and
 * called the production `signOut(A)`. The screen showed nobody and the form
 * said nothing had gone wrong — while GoTrue still served A, a relaunch
 * restored A, and a friend request from there was committed as A. A delete that
 * resolved WITHOUT deleting (what the installed iOS wrapper does with a failed
 * `SecItemDelete`) did the same, and so did a confirmed account deletion, which
 * then re-adopted the erased player's UUID on relaunch.
 *
 * Two layers are proved here:
 *
 *  - the storage: a removal is judged by what a fresh start could restore, is
 *    completed by a tombstone or by breaking chunks when the delete itself does
 *    not happen, and reports `retained` — sticky, so a later successful READ of
 *    the surviving credential cannot erase the warning — when nothing works;
 *  - the app path end to end: the production Auth store (hydrated by its own
 *    `hydrate()`), the production adapter, a real `@supabase/supabase-js`
 *    client and the PRODUCTION storage factory, over a double of
 *    `expo-secure-store` and nothing else. GoTrue's HTTP answers are faked;
 *    `tests/server/credential-departure.integration.test.ts` repeats the
 *    reproduction against real GoTrue and Postgres.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createClient, processLock } from "@supabase/supabase-js";

import {
  disposeAuthSubscription,
  setGuestIdentityStore,
  useAuthStore,
} from "../../src/features/auth/auth-store.js";
import { initialAuthFormState } from "../../src/features/auth/auth-machine.js";
import { GuestIdentityStore } from "../../src/features/auth/guest.js";
import { MemoryKeyValueStore } from "../../src/lib/persistence/key-value-store.js";
import { setSupabaseAvailabilityForTests, type ArcSupabaseClient } from "../../src/lib/supabase/client.js";
import {
  ChunkedSecureSessionStorage,
  createSecureSessionStorage,
  getSessionStorageDurability,
  lastSessionRemoval,
  REMOVED_HEAD,
  sessionRemovalMark,
  sessionRemovalSince,
  type SecureStoreLike,
  type SessionRemovalOutcome,
  type SessionStorageDurability,
} from "../../src/lib/supabase/secure-session-storage.js";

/**
 * The platform keychain, and nothing else, is the double. `deletion: silent`
 * resolves without deleting — the installed iOS wrapper ignores the status
 * `SecItemDelete` returns. Crashes are simulated at the storage level below.
 */
const native = vi.hoisted(() => ({
  entries: new Map<string, string>(),
  deletion: "works" as "works" | "throws" | "silent",
  writes: "works" as "works" | "throws",
}));

vi.mock("expo-secure-store", () => ({
  WHEN_UNLOCKED_THIS_DEVICE_ONLY: "WHEN_UNLOCKED_THIS_DEVICE_ONLY",
  getItemAsync: async (key: string) => native.entries.get(key) ?? null,
  setItemAsync: async (key: string, value: string) => {
    if (native.writes === "throws") throw new Error("injected keychain write failure");
    native.entries.set(key, value);
  },
  deleteItemAsync: async (key: string) => {
    if (native.deletion === "throws") throw new Error("injected keychain deletion failure");
    if (native.deletion === "works") native.entries.delete(key);
  },
}));

const URL = "http://127.0.0.1:54321";
/** The SDK's default key for this URL, `sb-<first host label>-auth-token`. */
const SESSION_KEY = "sb-127-auth-token";
const PLAYER_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const PLAYER_C = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

/**
 * A GoTrue session as the SDK stores it. The padding makes it chunked, which a
 * real session with its two JWTs and user record always is.
 */
function sessionFor(userId: string, token: string, expiresInSeconds = 3600): Record<string, unknown> {
  return {
    access_token: token,
    token_type: "bearer",
    refresh_token: `refresh-${token}`,
    expires_in: 3600,
    expires_at: Math.floor(Date.now() / 1000) + expiresInSeconds,
    user: {
      id: userId,
      aud: "authenticated",
      role: "authenticated",
      is_anonymous: true,
      app_metadata: {},
      user_metadata: { padding: "p".repeat(1_500) },
      created_at: "2026-09-30T00:00:00.000Z",
    },
  };
}

interface Sent {
  readonly method: string;
  readonly path: string;
  readonly authorization: string | null;
}

/**
 * GoTrue and PostgREST, answered locally. `/logout` succeeds (the server
 * revoked the session); `/signup` creates player C, which is what a relaunch
 * with nothing stored does; `/user` can be told the session is gone.
 */
function transport(sent: Sent[], overrides: { user?: () => Response; logout?: () => Promise<Response> } = {}) {
  return async (input: RequestInfo | globalThis.URL, init?: RequestInit): Promise<Response> => {
    const url = new globalThis.URL(String(input instanceof Request ? input.url : input));
    sent.push({
      method: init?.method ?? "GET",
      path: `${url.pathname}${url.search}`,
      authorization: new Headers(init?.headers).get("Authorization"),
    });
    // GoTrue reads an error's `code` only from a versioned API answer, which a
    // real server always gives.
    const json = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json", "x-supabase-api-version": "2024-01-01" },
      });
    if (url.pathname === "/auth/v1/logout") return overrides.logout ? overrides.logout() : new Response(null, { status: 204 });
    if (url.pathname === "/auth/v1/signup") return json(sessionFor(PLAYER_C, "token-c"));
    if (url.pathname === "/auth/v1/user") return overrides.user ? overrides.user() : json(sessionFor(PLAYER_A, "token-a").user);
    if (url.pathname === "/auth/v1/token") return json({ code: "refresh_token_not_found", message: "Invalid Refresh Token" }, 400);
    return json(null);
  };
}

/** A device: `client.ts`'s auth options over the PRODUCTION storage factory. */
function device(sent: Sent[], overrides?: Parameters<typeof transport>[1]): ArcSupabaseClient {
  return createClient(URL, "test-anon-key", {
    auth: {
      storage: createSecureSessionStorage(),
      persistSession: true,
      autoRefreshToken: false,
      detectSessionInUrl: false,
      flowType: "pkce",
      lock: processLock,
    },
    global: { fetch: transport(sent, overrides) },
  }) as ArcSupabaseClient;
}

/** Stores A exactly as the production factory would, with a working keychain. */
async function storeA(expiresInSeconds = 3600): Promise<void> {
  const module = (await import("expo-secure-store")) as unknown as SecureStoreLike;
  await new ChunkedSecureSessionStorage(module, { keychainAccessible: "WHEN_UNLOCKED_THIS_DEVICE_ONLY" })
    .setItem(SESSION_KEY, JSON.stringify(sessionFor(PLAYER_A, "token-a", expiresInSeconds)));
}

/** Who a cold start would restore — parsed here, not with the module's helper. */
async function storedPlayer(): Promise<string | null> {
  const module = (await import("expo-secure-store")) as unknown as SecureStoreLike;
  const raw = await new ChunkedSecureSessionStorage(module).getItem(SESSION_KEY);
  return raw === null ? null : ((JSON.parse(raw) as { user?: { id?: string } }).user?.id ?? null);
}

const shownPlayer = (): string | null => useAuthStore.getState().session?.account.userId ?? null;

async function sdkPlayer(client: ArcSupabaseClient): Promise<string | null> {
  return (await client.auth.getSession()).data.session?.user.id ?? null;
}

/** The app starting on `client`, through the production store's own `hydrate()`. */
async function launchOn(client: ArcSupabaseClient): Promise<void> {
  disposeAuthSubscription();
  setSupabaseAvailabilityForTests({ status: "ready", client });
  setGuestIdentityStore(new GuestIdentityStore(new MemoryKeyValueStore()));
  useAuthStore.setState({
    hydrated: false,
    session: null,
    mode: "unknown",
    guest: null,
    form: initialAuthFormState("signIn"),
    bootstrapStatus: "idle",
    bootstrapFailure: null,
    automaticBootstrap: true,
  });
  await useAuthStore.getState().hydrate();
}

/** Every player the screen showed, in order, from the moment this is called. */
function watchShown(): { readonly history: (string | null)[]; stop(): void } {
  const history: (string | null)[] = [];
  const stop = useAuthStore.subscribe((next, previous) => {
    const now = next.session?.account.userId ?? null;
    if (now !== (previous.session?.account.userId ?? null)) history.push(now);
  });
  return { history, stop };
}

beforeEach(() => {
  native.entries.clear();
  native.deletion = "works";
  native.writes = "works";
});

afterEach(() => {
  disposeAuthSubscription();
  useAuthStore.setState({ session: null, mode: "guest" });
  setGuestIdentityStore(null);
  setSupabaseAvailabilityForTests(null);
});

/** An in-memory keychain for the storage-level cases, with the same fault modes. */
function keychain(): SecureStoreLike & {
  entries: Map<string, string>;
  deletion: "works" | "throws" | "silent";
  writes: "works" | "throws";
  reads: "works" | "throws";
  refuse: (key: string) => boolean;
} {
  const chain = {
    entries: new Map<string, string>(),
    deletion: "works" as "works" | "throws" | "silent",
    writes: "works" as "works" | "throws",
    reads: "works" as "works" | "throws",
    refuse: (_key: string) => false,
    async getItemAsync(key: string) {
      if (chain.reads === "throws") throw new Error("injected read failure");
      return chain.entries.get(key) ?? null;
    },
    async setItemAsync(key: string, value: string) {
      if (chain.writes === "throws") throw new Error("injected write failure");
      chain.entries.set(key, value);
    },
    async deleteItemAsync(key: string) {
      if (chain.deletion === "throws" || chain.refuse(key)) throw new Error("injected deletion failure");
      if (chain.deletion === "works") chain.entries.delete(key);
    },
  };
  return chain;
}

function recording(chain: SecureStoreLike): {
  storage: ChunkedSecureSessionStorage;
  removals: SessionRemovalOutcome[];
  states: SessionStorageDurability[];
} {
  const removals: SessionRemovalOutcome[] = [];
  const states: SessionStorageDurability[] = [];
  const storage = new ChunkedSecureSessionStorage(chain, {}, (_key, state) => states.push(state), (_key, outcome) => removals.push(outcome));
  return { storage, removals, states };
}

const CREDENTIAL = JSON.stringify(sessionFor(PLAYER_A, "token-a"));

describe("B-F2 at the storage boundary: a removal is judged by what a relaunch could restore", () => {
  it("removes with a working keychain and says so", async () => {
    const chain = keychain();
    const { storage, removals, states } = recording(chain);
    await storage.setItem(SESSION_KEY, CREDENTIAL);

    await storage.removeItem(SESSION_KEY);

    expect(chain.entries.size).toBe(0);
    expect(await new ChunkedSecureSessionStorage(chain).getItem(SESSION_KEY)).toBeNull();
    expect(states.at(-1)).toBe("unknown");
    expect(removals).toEqual(["removed"]);
  });

  it.each(["throws", "silent"] as const)(
    "completes a delete the platform %s with a tombstone that a relaunch reads as nothing stored",
    async (deletion) => {
      const chain = keychain();
      const { storage, removals } = recording(chain);
      await storage.setItem(SESSION_KEY, CREDENTIAL);
      chain.deletion = deletion;

      await storage.removeItem(SESSION_KEY);

      // A relaunch: a new adapter over the same keychain.
      expect(await new ChunkedSecureSessionStorage(chain).getItem(SESSION_KEY)).toBeNull();
      expect(await storage.getItem(SESSION_KEY)).toBeNull();
      expect(chain.entries.get(SESSION_KEY)).toBe(REMOVED_HEAD);
      expect(removals).toEqual(["removed"]);
    },
  );

  it("reports RETAINED when the keychain refuses every change, keeps serving the credential, and a successful read cannot clear the warning", async () => {
    const chain = keychain();
    const { storage, removals, states } = recording(chain);
    await storage.setItem(SESSION_KEY, CREDENTIAL);
    chain.deletion = "throws";
    chain.writes = "throws";

    await expect(storage.removeItem(SESSION_KEY)).resolves.toBeUndefined();

    expect(states.at(-1)).toBe("unavailable");
    // Honest: this is what GoTrue will serve and what a relaunch restores.
    expect(await storage.getItem(SESSION_KEY)).toBe(CREDENTIAL);
    expect(await new ChunkedSecureSessionStorage(chain).getItem(SESSION_KEY)).toBe(CREDENTIAL);
    // THE AUDIT'S SEAM: the read of the surviving credential used to report
    // `durable` and erase the failure. It must not.
    expect(states.at(-1)).toBe("unavailable");
    expect(removals).toEqual(["retained"]);
  });

  it("breaks the value's chunks when the head can neither be deleted nor overwritten", async () => {
    const chain = keychain();
    const { storage, removals } = recording(chain);
    await storage.setItem(SESSION_KEY, CREDENTIAL);
    chain.refuse = (key) => key === SESSION_KEY;
    chain.writes = "throws";

    await storage.removeItem(SESSION_KEY);

    expect(await new ChunkedSecureSessionStorage(chain).getItem(SESSION_KEY)).toBeNull();
    expect(chain.entries.has(SESSION_KEY)).toBe(true);
    expect(removals).toEqual(["removed"]);
  });

  it("does not count breaking the OTHER bank as a removal", async () => {
    const chain = keychain();
    const { storage, removals } = recording(chain);
    // Two complete generations: an older value in one bank, the live one in the other.
    await storage.setItem(SESSION_KEY, JSON.stringify(sessionFor(PLAYER_C, "older")));
    const olderBank = [...chain.entries.entries()].filter(([key]) => key.startsWith(`${SESSION_KEY}.v2.`));
    await storage.setItem(SESSION_KEY, CREDENTIAL);
    for (const [key, value] of olderBank) chain.entries.set(key, value);
    const live = /:(\d):/.exec(chain.entries.get(SESSION_KEY)!)![1];
    chain.writes = "throws";
    // Only the live bank's chunks, and the head, refuse to go.
    chain.refuse = (key) => key === SESSION_KEY || key.startsWith(`${SESSION_KEY}.v2.${live}.`);

    await storage.removeItem(SESSION_KEY);

    expect(await new ChunkedSecureSessionStorage(chain).getItem(SESSION_KEY)).toBe(CREDENTIAL);
    expect(removals).toEqual(["retained"]);
  });

  it("never takes an unreadable keychain for an empty one", async () => {
    const chain = keychain();
    const { storage, removals } = recording(chain);
    await storage.setItem(SESSION_KEY, CREDENTIAL);
    chain.deletion = "silent";
    chain.writes = "throws";
    const reads = chain.getItemAsync.bind(chain);
    let calls = 0;
    // The inventory read works; every read-back after the delete fails.
    chain.getItemAsync = async (key) => {
      calls += 1;
      if (calls > 1) throw new Error("keychain became unreadable");
      return reads(key);
    };

    await storage.removeItem(SESSION_KEY);

    chain.getItemAsync = reads;
    expect(await new ChunkedSecureSessionStorage(chain).getItem(SESSION_KEY)).toBe(CREDENTIAL);
    expect(removals).toEqual(["retained"]);
  });

  it("a retry once the keychain recovers removes it, and a committed write clears the warning", async () => {
    const chain = keychain();
    const { storage, removals, states } = recording(chain);
    await storage.setItem(SESSION_KEY, CREDENTIAL);
    chain.deletion = "throws";
    chain.writes = "throws";
    await storage.removeItem(SESSION_KEY);
    expect(removals).toEqual(["retained"]);

    chain.deletion = "works";
    chain.writes = "works";
    await storage.removeItem(SESSION_KEY);
    await storage.removeItem(SESSION_KEY);
    expect(removals).toEqual(["retained", "removed", "removed"]);
    expect(chain.entries.size).toBe(0);

    await storage.setItem(SESSION_KEY, CREDENTIAL);
    chain.deletion = "throws";
    chain.writes = "throws";
    await storage.removeItem(SESSION_KEY);
    expect(removals.at(-1)).toBe("retained");
    chain.writes = "works";
    await storage.setItem(SESSION_KEY, JSON.stringify(sessionFor(PLAYER_C, "token-c")));
    expect(states.at(-1)).toBe("durable");
    expect(await storage.getItem(SESSION_KEY)).not.toBeNull();
    expect(states.at(-1)).toBe("durable");
  });

  it.each(["works", "throws", "silent"] as const)(
    "restores all of the credential or nothing after a crash at every native mutation of a removal (delete %s)",
    async (deletion) => {
      const base = keychain();
      await new ChunkedSecureSessionStorage(base).setItem(SESSION_KEY, CREDENTIAL);
      const before = new Map(base.entries);

      // Count the removal's native mutations, then kill it before and after each.
      let mutations = 0;
      const counted = keychain();
      for (const [key, value] of before) counted.entries.set(key, value);
      counted.deletion = deletion;
      const countedDelete = counted.deleteItemAsync.bind(counted);
      const countedSet = counted.setItemAsync.bind(counted);
      counted.deleteItemAsync = async (key) => { mutations += 1; await countedDelete(key); };
      counted.setItemAsync = async (key, value) => { mutations += 1; await countedSet(key, value); };
      await new ChunkedSecureSessionStorage(counted).removeItem(SESSION_KEY);
      expect(mutations).toBeGreaterThan(0);

      for (let boundary = 0; boundary <= mutations; boundary += 1) {
        const chain = keychain();
        for (const [key, value] of before) chain.entries.set(key, value);
        chain.deletion = deletion;
        let done = 0;
        const crash = (): void => {
          if (done >= boundary) throw new Error("simulated process termination");
        };
        const del = chain.deleteItemAsync.bind(chain);
        const set = chain.setItemAsync.bind(chain);
        const get = chain.getItemAsync.bind(chain);
        const interrupted: SecureStoreLike = {
          getItemAsync: async (key) => { crash(); return get(key); },
          setItemAsync: async (key, value) => { crash(); await set(key, value); done += 1; crash(); },
          deleteItemAsync: async (key) => { crash(); await del(key); done += 1; crash(); },
        };
        const outcomes: SessionRemovalOutcome[] = [];
        await new ChunkedSecureSessionStorage(interrupted, {}, undefined, (_key, outcome) => outcomes.push(outcome)).removeItem(SESSION_KEY);

        const restored = await new ChunkedSecureSessionStorage(chain).getItem(SESSION_KEY);
        expect([CREDENTIAL, null], `crash boundary ${boundary}`).toContain(restored);
        // A dead process reports nothing; a live one never reports `removed`
        // for a credential that the relaunch then restores.
        if (outcomes.includes("removed")) expect(restored, `boundary ${boundary}`).toBeNull();
      }
    },
  );
});

describe("B-F2 through the production store, adapter, supabase-js and storage factory", () => {
  it("THE AUDIT'S REPRODUCTION, delete rejected: sign-out completes only because the credential really left", async () => {
    await storeA();
    const sent: Sent[] = [];
    const client = device(sent);
    await launchOn(client);
    expect(shownPlayer()).toBe(PLAYER_A);

    native.deletion = "throws";
    await useAuthStore.getState().signOut(PLAYER_A);

    // The audit read: shown null, form idle, SDK A, relaunch A. Now all agree.
    expect(useAuthStore.getState().form.status.kind).not.toBe("failed");
    expect(shownPlayer()).toBeNull();
    expect(await sdkPlayer(client)).toBeNull();
    expect(await storedPlayer()).toBeNull();
    expect(sent.some((request) => request.path.startsWith("/auth/v1/logout"))).toBe(true);

    // Relaunch with deletion still failing: nothing of A is restored.
    const relaunched: Sent[] = [];
    const next = device(relaunched);
    await launchOn(next);
    expect(shownPlayer()).not.toBe(PLAYER_A);
    expect(await sdkPlayer(next)).not.toBe(PLAYER_A);
    expect(relaunched.some((request) => request.authorization === "Bearer token-a")).toBe(false);
  });

  it("the iOS shape, delete resolved without deleting: same", async () => {
    await storeA();
    const client = device([]);
    await launchOn(client);

    native.deletion = "silent";
    await useAuthStore.getState().signOut(PLAYER_A);

    expect(shownPlayer()).toBeNull();
    expect(await sdkPlayer(client)).toBeNull();
    expect(await storedPlayer()).toBeNull();
  });

  it("a keychain that refuses every change REFUSES the sign-out: A is shown throughout, served, and restored", async () => {
    await storeA();
    const sent: Sent[] = [];
    const client = device(sent);
    await launchOn(client);
    const watch = watchShown();

    native.deletion = "throws";
    native.writes = "throws";
    await useAuthStore.getState().signOut(PLAYER_A);
    watch.stop();

    expect(useAuthStore.getState().form.status).toMatchObject({
      kind: "failed",
      failure: { code: "CREDENTIAL_NOT_REMOVED" },
    });
    // Never shown as signed out, not even for a moment.
    expect(watch.history).toEqual([]);
    expect(shownPlayer()).toBe(PLAYER_A);
    expect(await sdkPlayer(client)).toBe(PLAYER_A);
    expect(await storedPlayer()).toBe(PLAYER_A);
    // The warning survives the reads that just happened.
    expect(getSessionStorageDurability()).toBe("unavailable");

    // What a protected request now carries is the player shown.
    const { bindCurrentPlayer } = await import("../../src/lib/supabase/player-binding.js");
    const bound = await bindCurrentPlayer(client);
    expect(bound.ok && bound.player.userId).toBe(shownPlayer());

    // Relaunch: the same player, consistently.
    const next = device([]);
    await launchOn(next);
    expect(shownPlayer()).toBe(PLAYER_A);
    expect(await sdkPlayer(next)).toBe(PLAYER_A);

    // Retry once the keychain recovers: the departure completes, idempotently.
    native.deletion = "works";
    native.writes = "works";
    await useAuthStore.getState().signOut(PLAYER_A);
    expect(shownPlayer()).toBeNull();
    expect(await sdkPlayer(next)).toBeNull();
    expect(await storedPlayer()).toBeNull();
  });

  it("a sign-out whose UI wait expires still ends showing what the keychain holds", async () => {
    await storeA();
    let answer!: () => void;
    const answered = new Promise<void>((resolve) => { answer = resolve; });
    const client = device([], {
      logout: async () => {
        await answered;
        return new Response(null, { status: 204 });
      },
    });
    await launchOn(client);
    const { createSupabaseAuthAdapter } = await import("../../src/features/auth/supabase-auth-adapter.js");
    const { setAuthAdapter } = await import("../../src/features/auth/auth-store.js");
    const adapter = createSupabaseAuthAdapter(client, { timeoutMs: 50 });
    setAuthAdapter(adapter);
    disposeAuthSubscription();
    useAuthStore.setState({ hydrated: false });
    await useAuthStore.getState().hydrate();
    expect(shownPlayer()).toBe(PLAYER_A);

    try {
      native.deletion = "throws";
      await useAuthStore.getState().signOut(PLAYER_A);
      // The UI stopped waiting; nothing has left yet, so nothing changed.
      expect(useAuthStore.getState().form.status).toMatchObject({ kind: "failed", failure: { code: "NETWORK" } });
      expect(shownPlayer()).toBe(PLAYER_A);

      answer();
      await vi.waitFor(async () => expect(await storedPlayer()).toBeNull());
      await vi.waitFor(() => expect(shownPlayer()).toBeNull());
    } finally {
      setAuthAdapter(null);
    }
  });

  it("an ordinary sign-out still works (positive control)", async () => {
    await storeA();
    const client = device([]);
    await launchOn(client);

    await useAuthStore.getState().signOut(PLAYER_A);

    expect(shownPlayer()).toBeNull();
    expect(useAuthStore.getState().mode).toBe("guest");
    expect(await sdkPlayer(client)).toBeNull();
    expect(native.entries.size).toBe(0);
  });

  it("a server that cannot confirm the revocation does not undo a departure the keychain completed", async () => {
    await storeA();
    const sent: Sent[] = [];
    const client = device(sent, {
      logout: async () =>
        new Response(JSON.stringify({ code: "unexpected_failure", message: "upstream unavailable" }), {
          status: 500,
          headers: { "content-type": "application/json", "x-supabase-api-version": "2024-01-01" },
        }),
    });
    await launchOn(client);

    await useAuthStore.getState().signOut(PLAYER_A);

    // GoTrue removes the local session even when /logout fails; nothing of A
    // is restorable, so this device IS signed out, and says so.
    expect(sent.some((request) => request.path.startsWith("/auth/v1/logout"))).toBe(true);
    expect(shownPlayer()).toBeNull();
    expect(await sdkPlayer(client)).toBeNull();
    expect(await storedPlayer()).toBeNull();
    expect(useAuthStore.getState().form.status.kind).not.toBe("failed");
  });

  it("a deletion the server refuses removes nothing: the player stays shown, served and stored", async () => {
    await storeA();
    const sent: Sent[] = [];
    const client = device(sent);
    await launchOn(client);
    const refuse = client.rpc.bind(client);
    client.rpc = ((name: string, ...rest: unknown[]) => {
      if (name !== "delete_own_account") return (refuse as (n: string, ...r: unknown[]) => unknown)(name, ...rest);
      return Promise.resolve({
        data: null,
        error: { code: "P0001", message: "leave your table before deleting your account", details: "", hint: "" },
      });
    }) as typeof client.rpc;

    expect(await useAuthStore.getState().deleteAccount(PLAYER_A)).toBe(false);

    expect(useAuthStore.getState().form.status.kind).toBe("failed");
    expect(sent.some((request) => request.path.startsWith("/auth/v1/logout"))).toBe(false);
    expect(shownPlayer()).toBe(PLAYER_A);
    expect(await sdkPlayer(client)).toBe(PLAYER_A);
    expect(await storedPlayer()).toBe(PLAYER_A);
  });

  it("a departure reads its own verdict: a removal before its mark is never mistaken for its own", async () => {
    await storeA();
    const client = device([]);
    await launchOn(client);
    const mark = sessionRemovalMark();
    expect(sessionRemovalSince(mark)).toBe("none");

    await useAuthStore.getState().signOut(PLAYER_A);
    expect(sessionRemovalSince(mark)).toBe("removed");
    expect(sessionRemovalSince(sessionRemovalMark())).toBe("none");
  });

  it("account deletion with a rejected keychain delete still leaves nothing that a relaunch could adopt", async () => {
    await storeA();
    const sent: Sent[] = [];
    const client = device(sent);
    await launchOn(client);

    native.deletion = "throws";
    expect(await useAuthStore.getState().deleteAccount(PLAYER_A)).toBe(true);

    expect(sent.some((request) => request.path === "/rest/v1/rpc/delete_own_account")).toBe(true);
    expect(shownPlayer()).toBeNull();
    expect(await storedPlayer()).toBeNull();
    const next = device([]);
    await launchOn(next);
    expect(shownPlayer()).not.toBe(PLAYER_A);
  });

  it("account deletion is refused BEFORE the server is asked when the keychain cannot change", async () => {
    await storeA();
    const sent: Sent[] = [];
    const client = device(sent);
    await launchOn(client);

    native.deletion = "throws";
    native.writes = "throws";
    expect(await useAuthStore.getState().deleteAccount(PLAYER_A)).toBe(false);

    expect(useAuthStore.getState().form.status).toMatchObject({ kind: "failed", failure: { code: "CREDENTIAL_NOT_REMOVED" } });
    expect(sent.some((request) => request.path.includes("delete_own_account"))).toBe(false);
    expect(shownPlayer()).toBe(PLAYER_A);
    expect(await storedPlayer()).toBe(PLAYER_A);
  });

  it("a keychain that fails only AFTER the server erased the account is not reported as a clean deletion, and a retry finishes", async () => {
    await storeA();
    const sent: Sent[] = [];
    let erased = false;
    const client = device(sent);
    await launchOn(client);
    const erase = client.rpc.bind(client);
    // The keychain breaks between the first erasure and its local cleanup.
    client.rpc = ((name: string, ...rest: unknown[]) => {
      const call = (erase as (n: string, ...r: unknown[]) => PromiseLike<unknown>)(name, ...rest);
      if (name !== "delete_own_account" || erased) return call;
      return Promise.resolve(call).then((result) => {
        erased = true;
        native.deletion = "throws";
        native.writes = "throws";
        return result;
      });
    }) as typeof client.rpc;
    const watch = watchShown();

    expect(await useAuthStore.getState().deleteAccount(PLAYER_A)).toBe(false);
    watch.stop();

    expect(erased).toBe(true);
    expect(useAuthStore.getState().form.status).toMatchObject({ kind: "failed", failure: { code: "CREDENTIAL_NOT_REMOVED" } });
    // Shown what the keychain still holds, never "nobody" over a restorable credential.
    expect(watch.history).toEqual([]);
    expect(shownPlayer()).toBe(PLAYER_A);
    expect(await storedPlayer()).toBe(PLAYER_A);

    native.deletion = "works";
    native.writes = "works";
    expect(await useAuthStore.getState().deleteAccount(PLAYER_A)).toBe(true);
    expect(shownPlayer()).toBeNull();
    expect(await storedPlayer()).toBeNull();
  });

  it("a session GoTrue drops on its own, which the keychain keeps, stays shown while it is still served", async () => {
    await storeA();
    // The server ends the session AFTER the launch: a launch now asks `/user`
    // before it adopts anyone (B-G1), and that answer is what admits A.
    let ended = false;
    const client = device([], {
      user: () => ended
        ? new Response(JSON.stringify({ code: "session_not_found", message: "Session not found" }), {
          status: 403,
          headers: { "content-type": "application/json", "x-supabase-api-version": "2024-01-01" },
        })
        : new Response(JSON.stringify(sessionFor(PLAYER_A, "token-a").user), {
          status: 200,
          headers: { "content-type": "application/json", "x-supabase-api-version": "2024-01-01" },
        }),
    });
    await launchOn(client);
    expect(shownPlayer()).toBe(PLAYER_A);
    ended = true;

    native.deletion = "throws";
    native.writes = "throws";
    await client.auth.getUser();

    // GoTrue announced SIGNED_OUT; it will still serve A, and a relaunch
    // would restore A, so A is what is shown.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(await sdkPlayer(client)).toBe(PLAYER_A);
    expect(shownPlayer()).toBe(PLAYER_A);
    expect(lastSessionRemoval()).toBe("retained");
  });

  it("but a dead credential the keychain keeps — refresh refused and expired — is not shown", async () => {
    await storeA();
    const client = device([]);
    await launchOn(client);
    expect(shownPlayer()).toBe(PLAYER_A);

    native.deletion = "throws";
    native.writes = "throws";
    // Expire the stored access token in place (the head and chunks stay put).
    const module = (await import("expo-secure-store")) as unknown as SecureStoreLike;
    native.writes = "works";
    await new ChunkedSecureSessionStorage(module).setItem(SESSION_KEY, JSON.stringify(sessionFor(PLAYER_A, "token-a", -60)));
    native.writes = "throws";

    const result = await client.auth.getSession();
    expect(result.data.session).toBeNull();
    await vi.waitFor(() => expect(shownPlayer()).toBeNull());
    // Still stored, and still dead: a relaunch refreshes, is refused, and adopts nobody.
    expect(await storedPlayer()).toBe(PLAYER_A);
    const next = device([]);
    await launchOn(next);
    expect(shownPlayer()).toBeNull();
  });
});
