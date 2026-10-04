/**
 * B-G1 and B-G3 — what a launch restores is reconciled before anybody is shown.
 *
 * The final independent Refresh-B re-audit (October 3, 2026) found the two
 * halves of one lifecycle failure:
 *
 *  - B-G1: an account the server had ERASED, whose credential the device still
 *    held — the deletion's keychain refused afterwards, its reply was lost, or
 *    its process ended before the credential could leave — was adopted on the
 *    next cold launch as an ordinary `ready` player (shown = SDK = stored = the
 *    erased UUID, no failure), and the post-erasure warning was forgotten.
 *  - B-G3: a sign-out whose head delete and tombstone write were refused but
 *    whose chunk deletes worked had made the credential unrestorable and
 *    reported success — and every later launch then read the surviving head as
 *    a STORAGE FAILURE and refused to start a player, the keychain long healthy.
 *
 * Both are the same question asked at start-up — what does this device really
 * hold, and does its account exist — so both are proved here through the
 * production Auth store (its own `hydrate()`), the production adapter, a real
 * `@supabase/supabase-js` client and the PRODUCTION storage factory, over a
 * double of `expo-secure-store` and nothing else. GoTrue's and PostgREST's HTTP
 * answers are faked with the shapes measured against GoTrue v2.195.0: `/user`
 * answers 403 `user_not_found` for an erased account's still-valid token and
 * 403 `session_not_found` for an ended session.
 * `tests/server/credential-reconciliation.integration.test.ts` repeats the
 * audit's reproductions against the real GoTrue and Postgres.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createClient, processLock } from "@supabase/supabase-js";

import {
  disposeAuthSubscription,
  setGuestIdentityStore,
  useAuthStore,
} from "../../src/features/auth/auth-store.js";
import { initialAuthFormState } from "../../src/features/auth/auth-machine.js";
import { ENDED_CREDENTIAL_RETAINED } from "../../src/features/auth/auth-failure.js";
import { GuestIdentityStore } from "../../src/features/auth/guest.js";
import { MemoryKeyValueStore } from "../../src/lib/persistence/key-value-store.js";
import { setSupabaseAvailabilityForTests, type ArcSupabaseClient } from "../../src/lib/supabase/client.js";
import {
  ChunkedSecureSessionStorage,
  getSessionStorageDurability,
  createSecureSessionStorage,
  REMOVED_HEAD,
  type SecureStoreLike,
  type SessionRemovalOutcome,
  type SessionStorageDurability,
} from "../../src/lib/supabase/secure-session-storage.js";

/**
 * The platform keychain, and nothing else, is the double. `refuseDelete` fails
 * one key's deletion; `reads: chunks` fails only the chunk reads, so a head is
 * readable while the value behind it is not.
 */
const native = vi.hoisted(() => ({
  entries: new Map<string, string>(),
  deletion: "works" as "works" | "throws" | "silent",
  writes: "works" as "works" | "throws",
  reads: "works" as "works" | "throws" | "chunks",
  refuseDelete: (_key: string): boolean => false,
}));

vi.mock("expo-secure-store", () => ({
  WHEN_UNLOCKED_THIS_DEVICE_ONLY: "WHEN_UNLOCKED_THIS_DEVICE_ONLY",
  getItemAsync: async (key: string) => {
    if (native.reads === "throws") throw new Error("injected keychain read failure: interaction not allowed");
    if (native.reads === "chunks" && /\.v2\.[01]\.\d+$/.test(key)) throw new Error("injected chunk read failure");
    return native.entries.get(key) ?? null;
  },
  setItemAsync: async (key: string, value: string) => {
    if (native.writes === "throws") throw new Error("injected keychain write failure");
    native.entries.set(key, value);
  },
  deleteItemAsync: async (key: string) => {
    if (native.deletion === "throws" || native.refuseDelete(key)) throw new Error("injected keychain deletion failure");
    if (native.deletion === "works") native.entries.delete(key);
  },
}));

const URL = "http://127.0.0.1:54321";
/** The SDK's default key for this URL, `sb-<first host label>-auth-token`. */
const SESSION_KEY = "sb-127-auth-token";
const PLAYER_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const PLAYER_C = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const PLAYER_R = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const TOKEN_OF: Record<string, string> = { [PLAYER_A]: "token-a", [PLAYER_C]: "token-c", [PLAYER_R]: "token-r" };
const PLAYER_OF: Record<string, string> = { "token-a": PLAYER_A, "token-c": PLAYER_C, "token-r": PLAYER_R };

/** A GoTrue session as the SDK stores it; the padding makes it chunked, as a real one is. */
function sessionFor(userId: string, expiresInSeconds = 3600): Record<string, unknown> {
  const token = TOKEN_OF[userId]!;
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
      created_at: "2026-10-03T00:00:00.000Z",
    },
  };
}

interface Sent {
  readonly method: string;
  readonly path: string;
  readonly authorization: string | null;
}

/**
 * The server: which accounts it has erased and which sessions it has ended, how
 * its `/user` answer behaves, and what the deletion RPC does with its reply.
 */
const server = {
  erased: new Set<string>(),
  ended: new Set<string>(),
  verify: "answers" as "answers" | "offline" | "unavailable" | "held",
  heldVerification: null as Promise<void> | null,
  deletion: "commits" as "commits" | "reply-lost" | "never-replies" | "lost-before-server",
  deletionCommitted: null as (() => void) | null,
  /** The keychain's keys at the moment each new player was requested. */
  keychainAtSignup: [] as string[][],
  /** Holds the answer to one GoTrue path until released: a reply that arrives after the UI stopped waiting. */
  held: null as null | { path: string; gate: Promise<void> },
  /** GoTrue refusing a password update with `same_password`. */
  refusePasswordUpdate: false,
};

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    // GoTrue reads an error's `code` only from a versioned answer, which the
    // hosted service gives; the local one sends `error_code`, read either way.
    headers: { "content-type": "application/json", "x-supabase-api-version": "2024-01-01" },
  });

const bearerPlayer = (authorization: string | null): string | null =>
  PLAYER_OF[authorization?.replace(/^Bearer /, "") ?? ""] ?? null;

function transport(sent: Sent[]) {
  return async (input: RequestInfo | globalThis.URL, init?: RequestInit): Promise<Response> => {
    const url = new globalThis.URL(String(input instanceof Request ? input.url : input));
    const authorization = new Headers(init?.headers).get("Authorization");
    sent.push({ method: init?.method ?? "GET", path: `${url.pathname}${url.search}`, authorization });
    const player = bearerPlayer(authorization);
    if (server.held !== null && `${url.pathname}${url.search}`.startsWith(server.held.path)) {
      const { gate } = server.held;
      server.held = null;
      await gate;
    }

    if (url.pathname === "/auth/v1/user" && init?.method === "PUT" && server.refusePasswordUpdate) {
      return json({ code: "same_password", message: "New password should be different from the old password." }, 422);
    }
    if (url.pathname === "/auth/v1/user") {
      if (server.verify === "offline") throw new TypeError("Network request failed");
      if (server.verify === "unavailable") return json({ message: "upstream unavailable" }, 503);
      if (server.verify === "held") await server.heldVerification;
      if (player !== null && server.erased.has(player)) {
        return json({ code: "user_not_found", message: "User from sub claim in JWT does not exist" }, 403);
      }
      if (authorization !== null && server.ended.has(authorization)) {
        return json({ code: "session_not_found", message: "Session from session_id claim in JWT does not exist" }, 403);
      }
      return player === null ? json({ code: "bad_jwt", message: "invalid JWT" }, 403) : json(sessionFor(player).user);
    }
    if (url.pathname === "/auth/v1/logout") {
      if (player !== null && server.erased.has(player)) {
        return json({ code: "user_not_found", message: "User from sub claim in JWT does not exist" }, 403);
      }
      return new Response(null, { status: 204 });
    }
    // A password sign-in for R, and a password-recovery exchange that recovers R.
    if (url.pathname === "/auth/v1/token" && url.searchParams.get("grant_type") === "password") return json(sessionFor(PLAYER_R));
    if (url.pathname === "/auth/v1/token" && url.searchParams.get("grant_type") === "pkce") return json(sessionFor(PLAYER_R));
    if (url.pathname === "/auth/v1/signup") {
      server.keychainAtSignup.push([...native.entries.keys()].sort());
      return json(sessionFor(PLAYER_C));
    }
    if (url.pathname === "/auth/v1/token") return json({ code: "refresh_token_not_found", message: "Invalid Refresh Token" }, 400);
    if (url.pathname === "/rest/v1/rpc/delete_own_account") {
      if (server.deletion === "lost-before-server") throw new TypeError("Network request failed");
      if (player !== null) server.erased.add(player);
      server.deletionCommitted?.();
      if (server.deletion === "reply-lost") throw new TypeError("Network request failed");
      if (server.deletion === "never-replies") return new Promise<Response>(() => {});
      return new Response(null, { status: 204 });
    }
    return json(null);
  };
}

/** A device: `client.ts`'s auth options over the PRODUCTION storage factory. */
function device(sent: Sent[] = []): ArcSupabaseClient {
  return createClient(URL, "test-anon-key", {
    auth: {
      storage: createSecureSessionStorage(),
      persistSession: true,
      autoRefreshToken: false,
      detectSessionInUrl: false,
      flowType: "pkce",
      lock: processLock,
    },
    global: { fetch: transport(sent) },
  }) as ArcSupabaseClient;
}

const keychainModule = async (): Promise<SecureStoreLike> =>
  (await import("expo-secure-store")) as unknown as SecureStoreLike;

/** Stores `player` exactly as the production factory would, with a working keychain. */
async function store(player: string): Promise<void> {
  await new ChunkedSecureSessionStorage(await keychainModule(), { keychainAccessible: "WHEN_UNLOCKED_THIS_DEVICE_ONLY" })
    .setItem(SESSION_KEY, JSON.stringify(sessionFor(player)));
}

/** Who a cold start would restore — read with the keychain working, then put back as it was. */
async function storedPlayer(): Promise<string | null> {
  const faults = { reads: native.reads, deletion: native.deletion, writes: native.writes };
  native.reads = "works";
  try {
    const raw = await new ChunkedSecureSessionStorage(await keychainModule()).getItem(SESSION_KEY);
    return raw === null ? null : ((JSON.parse(raw) as { user?: { id?: string } }).user?.id ?? null);
  } finally {
    Object.assign(native, faults);
  }
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

/** Every player the store held, and in what bootstrap state, from the moment this is called. */
function watchStore(): { readonly seen: { player: string | null; status: string }[]; stop(): void } {
  const seen: { player: string | null; status: string }[] = [];
  const stop = useAuthStore.subscribe((next) => {
    seen.push({ player: next.session?.account.userId ?? null, status: next.bootstrapStatus });
  });
  return { seen, stop };
}

/**
 * What a relaunch produced, in the audit's own terms: `deletion-boundary-results.json`
 * read `shown = sdk = stored = A`, `bootstrap: ready`, `failure: null` for all three
 * variants. `seenA` adds whether A was EVER shown during the launch, not just at its end.
 */
async function relaunchState(client: ArcSupabaseClient, seen: readonly { player: string | null }[]) {
  return {
    seenA: seen.some((state) => state.player === PLAYER_A),
    shown: shownPlayer(),
    sdk: await sdkPlayer(client),
    stored: await storedPlayer(),
    bootstrap: useAuthStore.getState().bootstrapStatus,
    failure: useAuthStore.getState().bootstrapFailure?.code ?? null,
  };
}

/** The state B-G1 requires after a launch over an erased account's credential, once the keychain works. */
const ERASURE_FINISHED = { seenA: false, shown: null, sdk: null, stored: null, bootstrap: "unavailable", failure: "ACCOUNT_DELETED" };

/** A device already showing A, stored with a working keychain: the starting point of every deletion. */
async function deviceShowingA(sent: Sent[] = []): Promise<ArcSupabaseClient> {
  await store(PLAYER_A);
  const client = device(sent);
  await launchOn(client);
  expect(shownPlayer()).toBe(PLAYER_A);
  return client;
}

const erasedCredentialRequests = (sent: readonly Sent[]): Sent[] =>
  sent.filter((request) => request.authorization === "Bearer token-a" && request.path.startsWith("/rest/v1/"));

beforeEach(() => {
  native.entries.clear();
  native.deletion = "works";
  native.writes = "works";
  native.reads = "works";
  native.refuseDelete = () => false;
  server.erased.clear();
  server.ended.clear();
  server.verify = "answers";
  server.heldVerification = null;
  server.deletion = "commits";
  server.deletionCommitted = null;
  server.keychainAtSignup = [];
  server.held = null;
  server.refusePasswordUpdate = false;
});

afterEach(() => {
  disposeAuthSubscription();
  useAuthStore.setState({ session: null, mode: "guest" });
  setGuestIdentityStore(null);
  setSupabaseAvailabilityForTests(null);
});

describe("B-G1: a restored credential becomes a player only on the server's word", () => {
  it("POSITIVE CONTROL: a credential whose account exists is restored", async () => {
    await store(PLAYER_A);
    const sent: Sent[] = [];
    const client = device(sent);
    await launchOn(client);

    expect(shownPlayer()).toBe(PLAYER_A);
    expect(useAuthStore.getState().bootstrapStatus).toBe("ready");
    expect(useAuthStore.getState().bootstrapFailure).toBeNull();
    expect(await sdkPlayer(client)).toBe(PLAYER_A);
    expect(await storedPlayer()).toBe(PLAYER_A);
    expect(sent.some((request) => request.path === "/auth/v1/signup")).toBe(false);
  });

  it("the server is asked once, with the restored credential's own token, before anybody is shown", async () => {
    await store(PLAYER_A);
    const sent: Sent[] = [];
    await launchOn(device(sent));

    expect(sent.filter((request) => request.path === "/auth/v1/user").map((request) => request.authorization))
      .toEqual(["Bearer token-a"]);
    expect(shownPlayer()).toBe(PLAYER_A);
  });

  it("an account erased elsewhere is never adopted: its credential is removed and the player is told", async () => {
    await store(PLAYER_A);
    server.erased.add(PLAYER_A);
    const sent: Sent[] = [];
    const client = device(sent);
    const watch = watchStore();
    await launchOn(client);
    watch.stop();

    // The audit read shown = SDK = stored = A, `ready`, no failure. Never A now.
    expect(await relaunchState(client, watch.seen)).toEqual(ERASURE_FINISHED);
    expect(erasedCredentialRequests(sent)).toEqual([]);
    // Automatic creation is paused, exactly as after a deletion; Connect starts a player.
    expect(sent.some((request) => request.path === "/auth/v1/signup")).toBe(false);
    await useAuthStore.getState().ensurePlayer();
    expect(shownPlayer()).toBe(PLAYER_C);
    expect(await storedPlayer()).toBe(PLAYER_C);
  });

  it("INITIAL_SESSION and the start-up SIGNED_IN never deliver an unconfirmed player, even while the server is slow", async () => {
    await store(PLAYER_A);
    server.erased.add(PLAYER_A);
    let answer!: () => void;
    server.verify = "held";
    server.heldVerification = new Promise<void>((resolve) => { answer = resolve; });
    const client = device([]);
    const announced: { event: string; player: string | null }[] = [];
    const { data } = client.auth.onAuthStateChange((event, session) => {
      announced.push({ event, player: session?.user.id ?? null });
    });
    const watch = watchStore();

    const launch = launchOn(client);
    await vi.waitFor(() => expect(announced.some((entry) => entry.event === "INITIAL_SESSION" && entry.player === PLAYER_A)).toBe(true));
    // GoTrue announced A from the keychain; the store has not shown it.
    expect(shownPlayer()).toBeNull();
    answer();
    await launch;
    watch.stop();
    data.subscription.unsubscribe();

    expect(watch.seen.some((state) => state.player === PLAYER_A)).toBe(false);
    expect(useAuthStore.getState().bootstrapFailure?.code).toBe("ACCOUNT_DELETED");
  });

  it.each(["offline", "unavailable"] as const)(
    "a server that cannot answer (%s) is not a verdict: nobody adopted, nothing removed, A restored once it answers",
    async (verify) => {
      await store(PLAYER_A);
      server.verify = verify;
      const sent: Sent[] = [];
      const client = device(sent);
      const watch = watchStore();
      await launchOn(client);

      expect(watch.seen.some((state) => state.player === PLAYER_A)).toBe(false);
      expect(shownPlayer()).toBeNull();
      expect(useAuthStore.getState().bootstrapFailure?.code).toBe("NETWORK");
      // NETWORK UNAVAILABLE is not ACCOUNT DOES NOT EXIST.
      expect(await storedPlayer()).toBe(PLAYER_A);
      expect(sent.some((request) => request.path.startsWith("/auth/v1/logout"))).toBe(false);
      expect(sent.some((request) => request.path === "/auth/v1/signup")).toBe(false);

      // The root's reconnect handler asks again once the server is reachable.
      server.verify = "answers";
      await useAuthStore.getState().ensurePlayer();
      watch.stop();
      expect(shownPlayer()).toBe(PLAYER_A);
      expect(useAuthStore.getState().bootstrapStatus).toBe("ready");
      expect(await storedPlayer()).toBe(PLAYER_A);
    },
  );

  it("a session the server ENDED (account still there) is dropped and an ordinary start follows", async () => {
    await store(PLAYER_A);
    server.ended.add("Bearer token-a");
    const sent: Sent[] = [];
    const client = device(sent);
    const watch = watchStore();
    await launchOn(client);
    watch.stop();

    expect(watch.seen.some((state) => state.player === PLAYER_A)).toBe(false);
    expect(shownPlayer()).toBe(PLAYER_C);
    expect(await storedPlayer()).toBe(PLAYER_C);
    expect(sent.filter((request) => request.path === "/auth/v1/signup")).toHaveLength(1);
  });

  it("an ENDED session the keychain keeps is NOT adopted at a launch: the server refused that credential (B-H3)", async () => {
    // Until the B-H3 repair this case was SHOWN, as a session GoTrue drops on
    // its own is shown mid-run (B-F2). The final audit's §24 recommendation:
    // preserve that live behaviour "without treating it as proof for a cold
    // launch". At a launch nothing has been confirmed, and the server's answer
    // about this exact credential is that it cannot authenticate.
    await store(PLAYER_A);
    server.ended.add("Bearer token-a");
    native.deletion = "throws";
    native.writes = "throws";
    const sent: Sent[] = [];
    const client = device(sent);
    const watch = watchStore();
    await launchOn(client);
    watch.stop();

    expect(watch.seen.some((state) => state.player === PLAYER_A)).toBe(false);
    expect(shownPlayer()).toBeNull();
    expect(useAuthStore.getState().bootstrapFailure).toMatchObject({ code: "CREDENTIAL_NOT_REMOVED", message: ENDED_CREDENTIAL_RETAINED });
    // Kept, and still served — but nothing is sent as it.
    expect(await sdkPlayer(client)).toBe(PLAYER_A);
    expect(await storedPlayer()).toBe(PLAYER_A);
    expect(erasedCredentialRequests(sent)).toEqual([]);
    expect(sent.some((request) => request.path === "/auth/v1/signup")).toBe(false);

    // Connect, once the keychain accepts changes: removed, then a new player.
    native.deletion = "works";
    native.writes = "works";
    await useAuthStore.getState().ensurePlayer();
    expect(shownPlayer()).toBe(PLAYER_C);
    expect(await storedPlayer()).toBe(PLAYER_C);
  });

  it("but an ERASED account's credential the keychain keeps is never shown, though it is still served", async () => {
    await store(PLAYER_A);
    server.erased.add(PLAYER_A);
    native.deletion = "throws";
    native.writes = "throws";
    const sent: Sent[] = [];
    const client = device(sent);
    const watch = watchStore();
    await launchOn(client);
    watch.stop();

    expect(watch.seen.some((state) => state.player === PLAYER_A)).toBe(false);
    expect(useAuthStore.getState().bootstrapFailure?.code).toBe("CREDENTIAL_NOT_REMOVED");
    expect(await storedPlayer()).toBe(PLAYER_A);
    expect(erasedCredentialRequests(sent)).toEqual([]);
  });

  it("with no credential at all, the pseudonymous bootstrap is unchanged: one player created, nothing asked first", async () => {
    const sent: Sent[] = [];
    const client = device(sent);
    await launchOn(client);

    expect(shownPlayer()).toBe(PLAYER_C);
    expect(await storedPlayer()).toBe(PLAYER_C);
    expect(sent.filter((request) => request.path === "/auth/v1/signup")).toHaveLength(1);
    expect(sent.some((request) => request.path === "/auth/v1/user")).toBe(false);
  });
});

describe("B-G1's gate never strands a player the server has just issued (VISIBLE == OUTBOUND)", () => {
  /** The UI's wait expires after 50 ms while the operation itself keeps running, as in production. */
  async function launchWithShortWait(client: ArcSupabaseClient): Promise<void> {
    const { createSupabaseAuthAdapter } = await import("../../src/features/auth/supabase-auth-adapter.js");
    const { setAuthAdapter } = await import("../../src/features/auth/auth-store.js");
    setAuthAdapter(createSupabaseAuthAdapter(client, { timeoutMs: 50 }));
    await launchOn(client);
  }

  afterEach(async () => {
    const { setAuthAdapter } = await import("../../src/features/auth/auth-store.js");
    setAuthAdapter(null);
  });

  function holdReply(path: string): () => void {
    let release!: () => void;
    server.held = { path, gate: new Promise<void>((resolve) => { release = resolve; }) };
    return release;
  }

  it("a sign-in whose reply comes after the UI stopped waiting still ends showing the player the SDK serves", async () => {
    await store(PLAYER_A);
    const client = device([]);
    await launchWithShortWait(client);
    expect(shownPlayer()).toBe(PLAYER_A);

    const release = holdReply("/auth/v1/token?grant_type=password");
    useAuthStore.getState().dispatch({ type: "EDIT_EMAIL", value: "r@arc21.test" });
    await useAuthStore.getState().signIn("a-password", PLAYER_A);
    expect(useAuthStore.getState().form.status).toMatchObject({ kind: "failed", failure: { code: "NETWORK" } });
    expect(shownPlayer()).toBe(PLAYER_A);

    release();
    await vi.waitFor(async () => expect(await sdkPlayer(client)).toBe(PLAYER_R));
    await vi.waitFor(() => expect(shownPlayer()).toBe(PLAYER_R));
    expect(await storedPlayer()).toBe(PLAYER_R);
  });

  it("a new player whose creation is answered after the UI stopped waiting is still shown", async () => {
    const release = holdReply("/auth/v1/signup");
    const client = device([]);
    await launchWithShortWait(client);
    expect(useAuthStore.getState().bootstrapFailure?.code).toBe("NETWORK");
    expect(shownPlayer()).toBeNull();

    release();
    await vi.waitFor(() => expect(shownPlayer()).toBe(PLAYER_C));
    expect(await sdkPlayer(client)).toBe(PLAYER_C);
    expect(await storedPlayer()).toBe(PLAYER_C);
  });

  it("a password recovery's exchanged session is shown at once, even when the new password is then refused", async () => {
    await store(PLAYER_A);
    const client = device([]);
    await launchOn(client);
    expect(shownPlayer()).toBe(PLAYER_A);
    // The verifier `resetPasswordForEmail` stored on THIS device, JSON-encoded as
    // GoTrue writes it (a raw value reads back as absent).
    native.entries.set(`${SESSION_KEY}-code-verifier`, JSON.stringify("verifier-on-this-device/PASSWORD_RECOVERY"));

    // The exchange replaces the SDK's session with R; the password update is
    // then refused, so no later announcement carries R. The exchange itself must.
    server.refusePasswordUpdate = true;
    expect(await useAuthStore.getState().completePasswordReset("one-time-code", "the-old-password", PLAYER_A))
      .toMatchObject({ code: "SAME_PASSWORD" });
    expect(await sdkPlayer(client)).toBe(PLAYER_R);
    expect(await storedPlayer()).toBe(PLAYER_R);
    expect(shownPlayer()).toBe(PLAYER_R);

    // The corrected password on the same screen; the recovery screen navigates
    // on "the adapter has already adopted the session".
    server.refusePasswordUpdate = false;
    expect(await useAuthStore.getState().completePasswordReset("one-time-code", "a-new-password", PLAYER_R)).toBeNull();
    expect(shownPlayer()).toBe(PLAYER_R);
  });
});

describe("B-G1: a deletion that could not finish on this device is finished by the next launch", () => {
  it("THE AUDIT'S VARIANT 1: the keychain refuses after the erasure — warned now, never adopted on relaunch", async () => {
    const client = await deviceShowingA();
    server.deletionCommitted = () => {
      native.deletion = "throws";
      native.writes = "throws";
    };

    expect(await useAuthStore.getState().deleteAccount(PLAYER_A)).toBe(false);
    // The surviving process: the B-F2 warning, as before.
    expect(server.erased.has(PLAYER_A)).toBe(true);
    expect(useAuthStore.getState().form.status).toMatchObject({ kind: "failed", failure: { code: "CREDENTIAL_NOT_REMOVED" } });
    expect(await storedPlayer()).toBe(PLAYER_A);
    void client;

    native.deletion = "works";
    native.writes = "works";
    const sent: Sent[] = [];
    const next = device(sent);
    const watch = watchStore();
    await launchOn(next);
    watch.stop();

    expect(await relaunchState(next, watch.seen)).toEqual(ERASURE_FINISHED);
    expect(erasedCredentialRequests(sent)).toEqual([]);
  });

  it("THE AUDIT'S VARIANT 2: the erasure's reply is lost — the relaunch asks the server and finishes the departure", async () => {
    await deviceShowingA();
    server.deletion = "reply-lost";

    expect(await useAuthStore.getState().deleteAccount(PLAYER_A)).toBe(false);
    expect(server.erased.has(PLAYER_A)).toBe(true);
    expect(useAuthStore.getState().form.status).toMatchObject({ kind: "failed", failure: { code: "NETWORK" } });
    expect(await storedPlayer()).toBe(PLAYER_A);

    const sent: Sent[] = [];
    const next = device(sent);
    const watch = watchStore();
    await launchOn(next);
    watch.stop();

    expect(await relaunchState(next, watch.seen)).toEqual(ERASURE_FINISHED);
    expect(erasedCredentialRequests(sent)).toEqual([]);
  });

  it("THE AUDIT'S VARIANT 3: the process ends after the erasure, before any reply or removal — the relaunch does not resurrect it", async () => {
    await deviceShowingA();
    server.deletion = "never-replies";
    let committed!: () => void;
    const erased = new Promise<void>((resolve) => { committed = resolve; });
    server.deletionCommitted = () => committed();

    // Never awaited: this process gets no answer and runs no removal, and is
    // then abandoned exactly as a terminated one would be.
    void useAuthStore.getState().deleteAccount(PLAYER_A);
    await erased;
    expect(await storedPlayer()).toBe(PLAYER_A);

    const sent: Sent[] = [];
    const next = device(sent);
    const watch = watchStore();
    await launchOn(next);
    watch.stop();

    expect(await relaunchState(next, watch.seen)).toEqual(ERASURE_FINISHED);
    expect(erasedCredentialRequests(sent)).toEqual([]);
  });

  it("a keychain STILL refusing at relaunch: not adopted, the truth is said, and Connect converges once it recovers", async () => {
    await deviceShowingA();
    server.deletionCommitted = () => {
      native.deletion = "throws";
      native.writes = "throws";
    };
    expect(await useAuthStore.getState().deleteAccount(PLAYER_A)).toBe(false);

    // Relaunch with the keychain still refusing every change.
    const sent: Sent[] = [];
    const next = device(sent);
    const watch = watchStore();
    await launchOn(next);

    expect(watch.seen.some((state) => state.player === PLAYER_A)).toBe(false);
    expect(useAuthStore.getState().bootstrapStatus).toBe("unavailable");
    expect(useAuthStore.getState().bootstrapFailure).toMatchObject({ code: "CREDENTIAL_NOT_REMOVED" });
    expect(useAuthStore.getState().bootstrapFailure?.message).toMatch(/was deleted/);
    expect(await storedPlayer()).toBe(PLAYER_A);
    expect(getSessionStorageDurability()).toBe("unavailable");
    expect(erasedCredentialRequests(sent)).toEqual([]);

    // The keychain recovers; Connect retries the removal, then starts a player.
    native.deletion = "works";
    native.writes = "works";
    await useAuthStore.getState().ensurePlayer();
    expect(useAuthStore.getState().bootstrapFailure?.code).toBe("ACCOUNT_DELETED");
    expect(await storedPlayer()).toBeNull();
    expect(await sdkPlayer(next)).toBeNull();
    await useAuthStore.getState().ensurePlayer();
    watch.stop();
    expect(watch.seen.some((state) => state.player === PLAYER_A)).toBe(false);
    expect(shownPlayer()).toBe(PLAYER_C);
    expect(await storedPlayer()).toBe(PLAYER_C);
  });

  it("a deletion that never reached the server is NOT taken for an erasure: the relaunch restores the account", async () => {
    await deviceShowingA();
    server.deletion = "lost-before-server";

    expect(await useAuthStore.getState().deleteAccount(PLAYER_A)).toBe(false);
    expect(server.erased.has(PLAYER_A)).toBe(false);

    const next = device([]);
    await launchOn(next);
    expect(shownPlayer()).toBe(PLAYER_A);
    expect(useAuthStore.getState().bootstrapStatus).toBe("ready");
    expect(await sdkPlayer(next)).toBe(PLAYER_A);
    expect(await storedPlayer()).toBe(PLAYER_A);
  });

  it("POSITIVE CONTROL: an uninterrupted deletion and an ordinary sign-out still finish, and the relaunch starts a new player", async () => {
    await deviceShowingA();
    expect(await useAuthStore.getState().deleteAccount(PLAYER_A)).toBe(true);
    expect(shownPlayer()).toBeNull();
    expect(await storedPlayer()).toBeNull();
    await launchOn(device([]));
    expect(shownPlayer()).toBe(PLAYER_C);

    await useAuthStore.getState().signOut(PLAYER_C);
    expect(useAuthStore.getState().form.status.kind).not.toBe("failed");
    expect(shownPlayer()).toBeNull();
    expect(await storedPlayer()).toBeNull();
  });
});

describe("B-G3: a credential provably unrestorable is an absence, never a storage failure", () => {
  it("THE AUDIT'S REPRODUCTION: a sign-out that could only break the chunks no longer poisons every later launch", async () => {
    await deviceShowingA();
    // Head delete refused, every write refused (so no tombstone), chunk deletes allowed.
    native.refuseDelete = (key) => key === SESSION_KEY;
    native.writes = "throws";

    await useAuthStore.getState().signOut(PLAYER_A);
    const head = native.entries.get(SESSION_KEY);
    const before = {
      signOut: useAuthStore.getState().form.status.kind,
      shown: shownPlayer(),
      stored: await storedPlayer(),
      chunklessHead: /^arc21\.chunked\.v2:[01]:\d+$/.test(head ?? ""),
      // The audit's `before` read `unavailable` here, from the chunk-less head.
      durabilityUnavailable: getSessionStorageDurability() === "unavailable",
    };

    // The keychain is healthy again; a cold launch.
    native.refuseDelete = () => false;
    native.writes = "works";
    const sent: Sent[] = [];
    const next = device(sent);
    await launchOn(next);
    const after = {
      shown: shownPlayer(),
      sdk: await sdkPlayer(next),
      stored: await storedPlayer(),
      bootstrap: useAuthStore.getState().bootstrapStatus,
      failure: useAuthStore.getState().bootstrapFailure?.code ?? null,
      signups: sent.filter((request) => request.path === "/auth/v1/signup").length,
    };

    // The audit read after: shown null, bootstrap `unavailable`, PERSISTENCE_UNAVAILABLE.
    expect({ before, after }).toEqual({
      before: { signOut: "idle", shown: null, stored: null, chunklessHead: true, durabilityUnavailable: false },
      after: { shown: PLAYER_C, sdk: PLAYER_C, stored: PLAYER_C, bootstrap: "ready", failure: null, signups: 1 },
    });
    // A's head and fragments were swept before C was even requested — not
    // merely overwritten by C's write afterwards.
    expect(server.keychainAtSignup).toEqual([[]]);
  });

  it("the same, without a relaunch: Connect starts a player once the keychain is healthy", async () => {
    await deviceShowingA();
    native.refuseDelete = (key) => key === SESSION_KEY;
    native.writes = "throws";
    await useAuthStore.getState().signOut(PLAYER_A);
    expect(shownPlayer()).toBeNull();
    expect(getSessionStorageDurability()).not.toBe("unavailable");

    native.refuseDelete = () => false;
    native.writes = "works";
    await useAuthStore.getState().ensurePlayer();
    expect(useAuthStore.getState().bootstrapFailure).toBeNull();
    expect(shownPlayer()).toBe(PLAYER_C);
    expect(await storedPlayer()).toBe(PLAYER_C);
  });

  it("a creation tried while writes are STILL refused is refused (B-R6: no player it cannot store), and the next launch starts one", async () => {
    await deviceShowingA();
    native.refuseDelete = (key) => key === SESSION_KEY;
    native.writes = "throws";
    await useAuthStore.getState().signOut(PLAYER_A);

    await useAuthStore.getState().ensurePlayer();
    expect(shownPlayer()).toBeNull();
    expect(useAuthStore.getState().bootstrapFailure?.code).toBe("PERSISTENCE_UNAVAILABLE");

    native.refuseDelete = () => false;
    native.writes = "works";
    await launchOn(device([]));
    expect(useAuthStore.getState().bootstrapFailure).toBeNull();
    expect(shownPlayer()).toBe(PLAYER_C);
    expect(await storedPlayer()).toBe(PLAYER_C);
  });

  it.each([
    ["one chunk evicted", (): void => { native.entries.delete(`${SESSION_KEY}.v2.0.1`); }],
    ["every chunk gone", (): void => { for (const key of [...native.entries.keys()]) if (key.startsWith(`${SESSION_KEY}.v2.0.`)) native.entries.delete(key); }],
    ["a malformed manifest", (): void => { native.entries.set(SESSION_KEY, "arc21.chunked.v2:0:0"); }],
  ])("%s: the launch starts a player, and the leftovers are swept first", async (_shape, damage) => {
    await store(PLAYER_A);
    damage();
    const next = device([]);
    await launchOn(next);

    expect(useAuthStore.getState().bootstrapFailure).toBeNull();
    expect(shownPlayer()).toBe(PLAYER_C);
    expect(await storedPlayer()).toBe(PLAYER_C);
    expect(server.keychainAtSignup).toEqual([[]]);
  });

  it("GENUINELY UNREADABLE storage still fails closed: nobody created or removed, and the credential survives", async () => {
    await store(PLAYER_A);
    const before = new Map(native.entries);
    native.reads = "throws";
    const sent: Sent[] = [];
    const next = device(sent);
    await launchOn(next);

    expect(shownPlayer()).toBeNull();
    expect(useAuthStore.getState().bootstrapStatus).toBe("unavailable");
    expect(useAuthStore.getState().bootstrapFailure?.code).toBe("PERSISTENCE_UNAVAILABLE");
    expect(sent.some((request) => request.path === "/auth/v1/signup")).toBe(false);
    expect(native.entries).toEqual(before);

    // Unlocked: A is still there, and is restored rather than replaced.
    native.reads = "works";
    await useAuthStore.getState().ensurePlayer();
    expect(shownPlayer()).toBe(PLAYER_A);
    expect(sent.some((request) => request.path === "/auth/v1/signup")).toBe(false);
  });

  it("a head that reads but whose chunks THROW is unreadable, not absent: fail closed, nothing touched", async () => {
    await store(PLAYER_A);
    const before = new Map(native.entries);
    native.reads = "chunks";
    const sent: Sent[] = [];
    await launchOn(device(sent));

    expect(shownPlayer()).toBeNull();
    expect(useAuthStore.getState().bootstrapFailure?.code).toBe("PERSISTENCE_UNAVAILABLE");
    expect(sent.some((request) => request.path === "/auth/v1/signup")).toBe(false);
    expect(native.entries).toEqual(before);
  });

  it("an unreadable launch that later reads an empty keychain is not stuck: Connect starts a player", async () => {
    native.reads = "throws";
    await launchOn(device([]));
    expect(useAuthStore.getState().bootstrapFailure?.code).toBe("PERSISTENCE_UNAVAILABLE");

    native.reads = "works";
    await useAuthStore.getState().ensurePlayer();
    expect(shownPlayer()).toBe(PLAYER_C);
  });
});

describe("B-G3 at the storage boundary: one judgement for a read and a removal", () => {
  function keychain(): SecureStoreLike & { entries: Map<string, string>; refuse: boolean; writable: boolean } {
    const chain = {
      entries: new Map<string, string>(),
      refuse: false,
      writable: true,
      async getItemAsync(key: string) { return chain.entries.get(key) ?? null; },
      async setItemAsync(key: string, value: string) {
        if (!chain.writable) throw new Error("injected write failure");
        chain.entries.set(key, value);
      },
      async deleteItemAsync(key: string) {
        if (chain.refuse) throw new Error("injected deletion failure");
        chain.entries.delete(key);
      },
    };
    return chain;
  }

  const CREDENTIAL = JSON.stringify(sessionFor(PLAYER_A));
  const SHAPES: readonly [string, (chain: Map<string, string>) => void][] = [
    ["nothing stored", (entries) => { entries.clear(); }],
    ["the tombstone", (entries) => { entries.set(SESSION_KEY, REMOVED_HEAD); }],
    ["a complete chunked value", () => undefined],
    ["a plain value", (entries) => { entries.clear(); entries.set(SESSION_KEY, "plain-credential"); }],
    ["a missing chunk", (entries) => { entries.delete(`${SESSION_KEY}.v2.0.2`); }],
    ["every chunk missing", (entries) => { for (const key of [...entries.keys()]) if (key !== SESSION_KEY) entries.delete(key); }],
    ["a malformed v2 manifest", (entries) => { entries.set(SESSION_KEY, "arc21.chunked.v2:4:2"); }],
    ["a malformed v1 manifest", (entries) => { entries.set(SESSION_KEY, "arc21.chunked.v1:2junk"); }],
    ["a v1 manifest whose chunks are gone", (entries) => { entries.clear(); entries.set(SESSION_KEY, "arc21.chunked.v1:3"); }],
  ];

  it.each(SHAPES)("%s: a relaunch's read and a removal's verdict agree, and an absence is never `unavailable`", async (_shape, shape) => {
    const chain = keychain();
    await new ChunkedSecureSessionStorage(chain).setItem(SESSION_KEY, CREDENTIAL);
    shape(chain.entries);

    const states: SessionStorageDurability[] = [];
    const read = await new ChunkedSecureSessionStorage({ ...chain, deleteItemAsync: async () => { throw new Error("read-only"); } }, {}, (_key, state) => states.push(state))
      .getItem(SESSION_KEY);

    // A removal that can neither delete nor write can only JUDGE what is there.
    chain.refuse = true;
    chain.writable = false;
    const verdicts: SessionRemovalOutcome[] = [];
    await new ChunkedSecureSessionStorage(chain, {}, undefined, (_key, outcome) => verdicts.push(outcome)).removeItem(SESSION_KEY);

    expect(verdicts).toEqual([read === null ? "removed" : "retained"]);
    if (read === null) expect(states).not.toContain("unavailable");
    else expect(states.at(-1)).toBe("durable");
  });

  it("the sweep can be cut at any native mutation and still leave nothing a relaunch restores", async () => {
    const base = keychain();
    await new ChunkedSecureSessionStorage(base).setItem(SESSION_KEY, CREDENTIAL);
    base.entries.delete(`${SESSION_KEY}.v2.0.0`);
    const before = new Map(base.entries);

    let mutations = 0;
    const counted = keychain();
    for (const [key, value] of before) counted.entries.set(key, value);
    const countedDelete = counted.deleteItemAsync.bind(counted);
    counted.deleteItemAsync = async (key) => { mutations += 1; await countedDelete(key); };
    expect(await new ChunkedSecureSessionStorage(counted).getItem(SESSION_KEY)).toBeNull();
    expect(mutations).toBeGreaterThan(0);
    expect([...counted.entries.keys()]).toEqual([]);

    for (let boundary = 0; boundary <= mutations; boundary += 1) {
      const chain = keychain();
      for (const [key, value] of before) chain.entries.set(key, value);
      let done = 0;
      const crash = (): void => {
        if (done >= boundary) throw new Error("simulated process termination");
      };
      const del = chain.deleteItemAsync.bind(chain);
      const interrupted: SecureStoreLike = {
        getItemAsync: async (key) => chain.getItemAsync(key),
        setItemAsync: async () => { throw new Error("the sweep never writes"); },
        deleteItemAsync: async (key) => { crash(); await del(key); done += 1; crash(); },
      };
      expect(await new ChunkedSecureSessionStorage(interrupted).getItem(SESSION_KEY), `boundary ${boundary}`).toBeNull();
      expect(await new ChunkedSecureSessionStorage(chain).getItem(SESSION_KEY), `relaunch after boundary ${boundary}`).toBeNull();
    }
  });

  it("a platform that refuses the sweep is asked once per head, and a later commit is unaffected", async () => {
    const chain = keychain();
    await new ChunkedSecureSessionStorage(chain).setItem(SESSION_KEY, CREDENTIAL);
    chain.entries.delete(`${SESSION_KEY}.v2.0.1`);
    chain.refuse = true;
    let deletes = 0;
    const del = chain.deleteItemAsync.bind(chain);
    chain.deleteItemAsync = async (key) => { deletes += 1; await del(key); };
    const storage = new ChunkedSecureSessionStorage(chain);

    expect(await storage.getItem(SESSION_KEY)).toBeNull();
    const first = deletes;
    expect(first).toBeGreaterThan(0);
    expect(await storage.getItem(SESSION_KEY)).toBeNull();
    expect(deletes).toBe(first);

    chain.refuse = false;
    await storage.setItem(SESSION_KEY, JSON.stringify(sessionFor(PLAYER_C)));
    expect(JSON.parse((await new ChunkedSecureSessionStorage(chain).getItem(SESSION_KEY))!).user.id).toBe(PLAYER_C);
  });
});
