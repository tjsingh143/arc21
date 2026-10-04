/**
 * B-H3 — only the auth server's own answer can confirm, or erase, a restored
 * player.
 *
 * The final independent Refresh-B re-audit (October 4, 2026) persisted a
 * player, erased the account, and cold-launched over the retained credential.
 * During the SDK's `getUser()` — the call the adapter asked "does this account
 * exist?" through — the native keychain reads threw, and recovered when the
 * call returned. `getUser()` loads the session out of storage BEFORE it sends
 * anything; with nothing readable it RETURNS `AuthSessionMissingError` locally,
 * the same name GoTrue's own `session_not_found` is given. The adapter took the
 * name for the server's word ("session ended, account found"), re-read the
 * recovered keychain and adopted the erased UUID: `shown = SDK = stored`,
 * `bootstrap: ready`, and **zero** `/auth/v1/user` requests.
 *
 * Here: the production Auth store (its own `hydrate()`), the production
 * adapter, a real `@supabase/supabase-js` client and the PRODUCTION storage
 * factory over a double of `expo-secure-store` — the native keychain is the
 * only double. GoTrue's and PostgREST's HTTP answers are faked with the shapes
 * measured against GoTrue v2.195.0, and every request is recorded WITH the
 * status it was answered, so "the server said so" is a fact about a response,
 * not about an error's name. `tests/server/confirmation-gate.integration.test.ts`
 * repeats the interleaving against the real GoTrue and Postgres.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createClient, processLock } from "@supabase/supabase-js";

import { disposeAuthSubscription, setGuestIdentityStore, useAuthStore } from "../../src/features/auth/auth-store.js";
import { initialAuthFormState } from "../../src/features/auth/auth-machine.js";
import { GuestIdentityStore } from "../../src/features/auth/guest.js";
import { MemoryKeyValueStore } from "../../src/lib/persistence/key-value-store.js";
import { setSupabaseAvailabilityForTests, type ArcSupabaseClient } from "../../src/lib/supabase/client.js";
import {
  ChunkedSecureSessionStorage,
  createSecureSessionStorage,
  type SecureStoreLike,
} from "../../src/lib/supabase/secure-session-storage.js";

/** The platform keychain, and nothing else, is the double. */
const native = vi.hoisted(() => ({
  entries: new Map<string, string>(),
  reads: "works" as "works" | "throws",
  deletion: "works" as "works" | "throws",
}));

vi.mock("expo-secure-store", () => ({
  WHEN_UNLOCKED_THIS_DEVICE_ONLY: "WHEN_UNLOCKED_THIS_DEVICE_ONLY",
  getItemAsync: async (key: string) => {
    if (native.reads === "throws") throw new Error("injected keychain read failure: interaction not allowed");
    return native.entries.get(key) ?? null;
  },
  setItemAsync: async (key: string, value: string) => { native.entries.set(key, value); },
  deleteItemAsync: async (key: string) => {
    if (native.deletion === "throws") throw new Error("injected keychain deletion failure");
    native.entries.delete(key);
  },
}));

const URL = "http://127.0.0.1:54321";
const SESSION_KEY = "sb-127-auth-token";
const PLAYER_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const PLAYER_C = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const STRANGER = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const TOKEN_OF: Record<string, string> = { [PLAYER_A]: "token-a", [PLAYER_C]: "token-c" };
const PLAYER_OF: Record<string, string> = { "token-a": PLAYER_A, "token-c": PLAYER_C };

function sessionFor(userId: string): Record<string, unknown> {
  const token = TOKEN_OF[userId]!;
  return {
    access_token: token,
    token_type: "bearer",
    refresh_token: `refresh-${token}`,
    expires_in: 3600,
    expires_at: Math.floor(Date.now() / 1000) + 3600,
    user: {
      id: userId,
      aud: "authenticated",
      role: "authenticated",
      is_anonymous: true,
      app_metadata: {},
      user_metadata: { padding: "p".repeat(1_500) },
      created_at: "2026-10-04T00:00:00.000Z",
    },
  };
}

/** One request, and — only if the server answered — the status it was answered. */
interface Sent {
  readonly method: string;
  readonly path: string;
  readonly authorization: string | null;
  readonly apikey: string | null;
  status: number | null;
}

/** How GoTrue answers `GET /user`: as itself, unreachable, or with a fixed reply. */
type Verify =
  | { readonly kind: "answers" }
  | { readonly kind: "offline" }
  | { readonly kind: "replies"; readonly status: number; readonly body: string };

const server = {
  erased: new Set<string>(),
  ended: new Set<string>(),
  verify: { kind: "answers" } as Verify,
};

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "x-supabase-api-version": "2024-01-01" },
  });

function transport(sent: Sent[]) {
  return async (input: RequestInfo | globalThis.URL, init?: RequestInit): Promise<Response> => {
    const url = new globalThis.URL(String(input instanceof Request ? input.url : input));
    const headers = new Headers(init?.headers);
    const record: Sent = {
      method: init?.method ?? "GET",
      path: url.pathname,
      authorization: headers.get("Authorization"),
      apikey: headers.get("apikey"),
      status: null,
    };
    sent.push(record);
    const answer = await answerFor(url, init, record.authorization);
    record.status = answer.status;
    return answer;
  };
}

async function answerFor(url: globalThis.URL, init: RequestInit | undefined, authorization: string | null): Promise<Response> {
  const player = PLAYER_OF[authorization?.replace(/^Bearer /, "") ?? ""] ?? null;
  if (url.pathname === "/auth/v1/user" && (init?.method ?? "GET") === "GET") {
    if (server.verify.kind === "offline") throw new TypeError("Network request failed");
    if (server.verify.kind === "replies") {
      return new Response(server.verify.body, {
        status: server.verify.status,
        headers: { "content-type": "application/json", "x-supabase-api-version": "2024-01-01" },
      });
    }
    if (player !== null && server.erased.has(player)) {
      return json({ code: 403, error_code: "user_not_found", msg: "User from sub claim in JWT does not exist" }, 403);
    }
    if (authorization !== null && server.ended.has(authorization)) {
      return json({ code: 403, error_code: "session_not_found", msg: "Session from session_id claim in JWT does not exist" }, 403);
    }
    return player === null ? json({ code: "bad_jwt", message: "invalid JWT" }, 403) : json((sessionFor(player) as { user: unknown }).user);
  }
  if (url.pathname === "/auth/v1/logout") {
    if (player !== null && server.erased.has(player)) return json({ code: "user_not_found", message: "gone" }, 403);
    return new Response(null, { status: 204 });
  }
  if (url.pathname === "/auth/v1/signup") return json(sessionFor(PLAYER_C));
  return json(null);
}

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

const keychain = async (): Promise<SecureStoreLike> => (await import("expo-secure-store")) as unknown as SecureStoreLike;

async function store(player: string): Promise<void> {
  await new ChunkedSecureSessionStorage(await keychain(), { keychainAccessible: "WHEN_UNLOCKED_THIS_DEVICE_ONLY" })
    .setItem(SESSION_KEY, JSON.stringify(sessionFor(player)));
}

/** Who a cold start would restore, read with a working keychain. */
async function storedPlayer(): Promise<string | null> {
  const reads = native.reads;
  native.reads = "works";
  try {
    const raw = await new ChunkedSecureSessionStorage(await keychain()).getItem(SESSION_KEY);
    return raw === null ? null : ((JSON.parse(raw) as { user?: { id?: string } }).user?.id ?? null);
  } finally {
    native.reads = reads;
  }
}

const shownPlayer = (): string | null => useAuthStore.getState().session?.account.userId ?? null;

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

function watchShown(): { readonly seen: (string | null)[]; stop(): void } {
  const seen: (string | null)[] = [];
  const stop = useAuthStore.subscribe((next) => { seen.push(next.session?.account.userId ?? null); });
  return { seen, stop };
}

/** The audit's injection: the keychain throws for exactly the duration of every `getUser()` call. */
function keychainThrowsDuringGetUser(client: ArcSupabaseClient): { readonly calls: () => number } {
  const original = client.auth.getUser.bind(client.auth);
  let calls = 0;
  client.auth.getUser = (async (...args: Parameters<typeof original>) => {
    calls += 1;
    native.reads = "throws";
    try {
      return await original(...args);
    } finally {
      native.reads = "works";
    }
  }) as typeof client.auth.getUser;
  return { calls: () => calls };
}

const userQuestions = (sent: readonly Sent[]): Sent[] => sent.filter((request) => request.path === "/auth/v1/user" && request.method === "GET");
const sentAsA = (sent: readonly Sent[]): Sent[] =>
  sent.filter((request) => request.authorization === "Bearer token-a" && !request.path.startsWith("/auth/v1/"));

beforeEach(() => {
  native.entries.clear();
  native.reads = "works";
  native.deletion = "works";
  server.erased.clear();
  server.ended.clear();
  server.verify = { kind: "answers" };
});

afterEach(() => {
  disposeAuthSubscription();
  useAuthStore.setState({ session: null, mode: "guest" });
  setGuestIdentityStore(null);
  setSupabaseAvailabilityForTests(null);
});

describe("B-H3: a verdict on a restored player is made only from the auth server's response", () => {
  it("THE AUDIT'S INTERLEAVING: the keychain throws inside getUser() — the erased player is never adopted, and the verdict is the server's 403", async () => {
    await store(PLAYER_A);
    server.erased.add(PLAYER_A);
    const sent: Sent[] = [];
    const client = device(sent);
    keychainThrowsDuringGetUser(client);
    const watch = watchShown();
    await launchOn(client);
    watch.stop();

    // The audit read shown = SDK = stored = A, `ready`, no failure, 0 `/user`.
    expect(watch.seen).not.toContain(PLAYER_A);
    expect(shownPlayer()).toBeNull();
    expect(useAuthStore.getState().bootstrapStatus).toBe("unavailable");
    expect(useAuthStore.getState().bootstrapFailure?.code).toBe("ACCOUNT_DELETED");
    expect(await storedPlayer()).toBeNull();
    // The erasure verdict came out of a response: one question, with A's own
    // token, answered 403 by the server.
    expect(userQuestions(sent).map(({ authorization, status }) => ({ authorization, status })))
      .toEqual([{ authorization: "Bearer token-a", status: 403 }]);
    expect(sentAsA(sent)).toEqual([]);
  });

  it("an SDK-made session-missing error with NO server answer is no verdict: nobody adopted, nothing removed, then the server decides", async () => {
    await store(PLAYER_A);
    server.erased.add(PLAYER_A);
    // Both at once: `getUser()` can only answer with its locally made
    // `AuthSessionMissingError` (the keychain throws inside it), and the
    // server cannot be reached at all.
    server.verify = { kind: "offline" };
    const sent: Sent[] = [];
    const client = device(sent);
    keychainThrowsDuringGetUser(client);
    const watch = watchShown();
    await launchOn(client);

    expect(watch.seen).not.toContain(PLAYER_A);
    expect(shownPlayer()).toBeNull();
    expect(useAuthStore.getState().bootstrapFailure?.code).toBe("NETWORK");
    // NO AUTHORITATIVE RESPONSE: no `/user` question was answered.
    expect(userQuestions(sent).filter((request) => request.status !== null)).toEqual([]);
    // Pending, not decided: the credential is exactly where it was.
    expect(await storedPlayer()).toBe(PLAYER_A);
    expect(sent.some((request) => request.path === "/auth/v1/logout")).toBe(false);
    expect(sent.some((request) => request.path === "/auth/v1/signup")).toBe(false);
    expect(sentAsA(sent)).toEqual([]);

    // The server reachable again: ITS answer is applied — the erasure.
    server.verify = { kind: "answers" };
    await useAuthStore.getState().ensurePlayer();
    watch.stop();
    expect(watch.seen).not.toContain(PLAYER_A);
    expect(useAuthStore.getState().bootstrapFailure?.code).toBe("ACCOUNT_DELETED");
    expect(await storedPlayer()).toBeNull();
    expect(userQuestions(sent).filter((request) => request.status !== null).map((request) => request.status)).toEqual([403]);
  });

  it("THE TOKEN CANNOT BE READ: a keychain that throws while the launch obtains the credential asks nothing, adopts nobody, removes nothing — and recovers", async () => {
    await store(PLAYER_A);
    server.erased.add(PLAYER_A);
    native.reads = "throws";
    const sent: Sent[] = [];
    const client = device(sent);
    const watch = watchShown();
    await launchOn(client);

    // In this design the credential's own read is the only place a keychain
    // fault can stand between the credential and the question.
    expect(watch.seen).not.toContain(PLAYER_A);
    expect(shownPlayer()).toBeNull();
    expect(useAuthStore.getState().bootstrapStatus).toBe("unavailable");
    expect(useAuthStore.getState().bootstrapFailure?.code).toBe("PERSISTENCE_UNAVAILABLE");
    expect(userQuestions(sent)).toEqual([]);
    expect(sent.some((request) => request.path === "/auth/v1/signup")).toBe(false);
    expect(await storedPlayer()).toBe(PLAYER_A);

    // Storage recovers: the authoritative reconciliation runs, and its verdict stands.
    native.reads = "works";
    await useAuthStore.getState().ensurePlayer();
    expect(watch.seen).not.toContain(PLAYER_A);
    expect(useAuthStore.getState().bootstrapFailure?.code).toBe("ACCOUNT_DELETED");
    expect(await storedPlayer()).toBeNull();
    expect(userQuestions(sent).map((request) => request.status)).toEqual([403]);

    // And Connect then starts a new player, as after any deletion.
    await useAuthStore.getState().ensurePlayer();
    watch.stop();
    expect(shownPlayer()).toBe(PLAYER_C);
    expect(watch.seen).not.toContain(PLAYER_A);
  });

  it("the question is the server's: one GET /auth/v1/user with exactly the restored token and the project key; getUser() is not asked", async () => {
    await store(PLAYER_A);
    const sent: Sent[] = [];
    const client = device(sent);
    const getUser = keychainThrowsDuringGetUser(client);
    await launchOn(client);

    expect(shownPlayer()).toBe(PLAYER_A);
    expect(userQuestions(sent)).toEqual([
      { method: "GET", path: "/auth/v1/user", authorization: "Bearer token-a", apikey: "test-anon-key", status: 200 },
    ]);
    expect(getUser.calls()).toBe(0);
  });

  it("a client whose auth transport the adapter does not recognise asks nothing and adopts nobody (fail closed)", async () => {
    await store(PLAYER_A);
    const sent: Sent[] = [];
    const client = device(sent);
    (client.auth as unknown as { url: unknown }).url = undefined;
    await launchOn(client);

    expect(shownPlayer()).toBeNull();
    expect(useAuthStore.getState().bootstrapFailure?.code).toBe("NETWORK");
    expect(userQuestions(sent)).toEqual([]);
    expect(await storedPlayer()).toBe(PLAYER_A);
  });
});

describe("B-H3: what each server answer means — and that only one of them adopts", () => {
  const CASES: readonly {
    readonly answer: string;
    readonly verify: Verify;
    readonly erased?: boolean;
    readonly ended?: boolean;
    readonly shown: string | null;
    readonly failure: string | null;
    readonly stored: string | null;
  }[] = [
    { answer: "200, the same account", verify: { kind: "answers" }, shown: PLAYER_A, failure: null, stored: PLAYER_A },
    { answer: "200, another account", verify: { kind: "replies", status: 200, body: JSON.stringify({ id: STRANGER }) }, shown: null, failure: "IDENTITY_CHANGED", stored: PLAYER_A },
    { answer: "200, an unreadable body", verify: { kind: "replies", status: 200, body: "<html>" }, shown: null, failure: "NETWORK", stored: PLAYER_A },
    { answer: "403 user_not_found (unversioned)", verify: { kind: "answers" }, erased: true, shown: null, failure: "ACCOUNT_DELETED", stored: null },
    { answer: "403 user_not_found (versioned)", verify: { kind: "replies", status: 403, body: JSON.stringify({ code: "user_not_found", message: "gone" }) }, shown: null, failure: "ACCOUNT_DELETED", stored: null },
    { answer: "403 session_not_found", verify: { kind: "answers" }, ended: true, shown: PLAYER_C, failure: null, stored: PLAYER_C },
    { answer: "403 bad_jwt", verify: { kind: "replies", status: 403, body: JSON.stringify({ code: "bad_jwt", message: "invalid JWT" }) }, shown: null, failure: "SERVER", stored: PLAYER_A },
    // The SDK's own mapping treats 500-504 and 520-530 as infrastructure; kept.
    { answer: "500", verify: { kind: "replies", status: 500, body: JSON.stringify({ message: "boom" }) }, shown: null, failure: "NETWORK", stored: PLAYER_A },
    { answer: "422, a code GoTrue gives no verdict with", verify: { kind: "replies", status: 422, body: JSON.stringify({ code: "validation_failed", message: "no" }) }, shown: null, failure: "SERVER", stored: PLAYER_A },
    { answer: "503", verify: { kind: "replies", status: 503, body: JSON.stringify({ message: "unavailable" }) }, shown: null, failure: "NETWORK", stored: PLAYER_A },
    { answer: "403, an unreadable body", verify: { kind: "replies", status: 403, body: "<html>" }, shown: null, failure: "UNKNOWN", stored: PLAYER_A },
    { answer: "no answer (transport failure)", verify: { kind: "offline" }, shown: null, failure: "NETWORK", stored: PLAYER_A },
  ];

  it.each(CASES)("$answer", async ({ verify, erased, ended, shown, failure, stored }) => {
    await store(PLAYER_A);
    server.verify = verify;
    if (erased) server.erased.add(PLAYER_A);
    if (ended) server.ended.add("Bearer token-a");
    const sent: Sent[] = [];
    const client = device(sent);
    const watch = watchShown();
    await launchOn(client);
    watch.stop();

    expect({ shown: shownPlayer(), failure: useAuthStore.getState().bootstrapFailure?.code ?? null, stored: await storedPlayer() })
      .toEqual({ shown, failure, stored });
    // A is adopted for exactly one answer, and only then is anything sent as A.
    expect(watch.seen.includes(PLAYER_A)).toBe(shown === PLAYER_A);
    if (shown !== PLAYER_A) expect(sentAsA(sent)).toEqual([]);
  });
});
