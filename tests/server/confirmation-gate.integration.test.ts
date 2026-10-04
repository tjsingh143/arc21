/**
 * B-H1 and B-H3 against real GoTrue, Postgres and the running Edge Functions.
 *
 * The final independent Refresh-B re-audit (October 4, 2026) found both halves
 * of one confusion — "the SDK can produce a credential" taken for "this player
 * may do account-owned server work":
 *
 *  - B-H1: a valid player's credential, cold-launched with only `/auth/v1/user`
 *    failing, correctly showed nobody (`unavailable`, `NETWORK`) — and
 *    Inventory's `load()` granted FOUR cosmetics (`user_cosmetics` 0 → 4) and
 *    Daily opened a RANKED game, every request sent as the unadopted UUID.
 *  - B-H3: an ERASED account's credential, cold-launched while the keychain
 *    threw for the duration of the SDK's `getUser()`, was adopted as `ready`:
 *    `getUser()` made `AuthSessionMissingError` locally, before any request,
 *    and the adapter took it for GoTrue's `session_not_found`. Zero `/user`.
 *
 * These are the audit's reproductions, inverted: its own native double, the
 * production storage factory, `client.ts`'s auth options, the production Auth
 * store hydrated by its own `hydrate()`, the production adapter and stores.
 * The verdicts are read out of Postgres. Every account is admin-created and
 * signed in with a password, so this file creates no anonymous player at all —
 * local GoTrue caps anonymous sign-ins at 30 an hour.
 *
 * A SKIP IS NOT A PASS. `npm run test:server` sets ARC21_REQUIRE_SERVER_STACK.
 */

import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { afterAll, describe, expect, it, vi } from "vitest";
import { createClient, processLock } from "@supabase/supabase-js";

import { stackUp } from "./stack-guard.js";
import { disposeAuthSubscription, setGuestIdentityStore, useAuthStore } from "../../src/features/auth/auth-store.js";
import { initialAuthFormState } from "../../src/features/auth/auth-machine.js";
import { GuestIdentityStore } from "../../src/features/auth/guest.js";
import { useCosmeticsStore } from "../../src/features/cosmetics/cosmetics-store.js";
import { useDailyStore } from "../../src/features/daily/daily-store.js";
import { useFriendsStore } from "../../src/features/friends/friends-store.js";
import { usePresenceStore } from "../../src/features/presence/presence-store.js";
import { resetPlayerState } from "../../src/features/player/reset-player-state.js";
import { useWalletStore } from "../../src/features/wallet/wallet-store.js";
import { useTournamentStore } from "../../src/features/tournament/tournament-store.js";
import { useCareerServerStore } from "../../src/features/career/career-server-store.js";
import { MemoryKeyValueStore } from "../../src/lib/persistence/key-value-store.js";
import { setSupabaseAvailabilityForTests, type ArcSupabaseClient } from "../../src/lib/supabase/client.js";
import {
  ChunkedSecureSessionStorage,
  createSecureSessionStorage,
  type SecureStoreLike,
} from "../../src/lib/supabase/secure-session-storage.js";

/** The audit's native double: a keychain whose reads, writes and deletes can be made to throw. */
const native = vi.hoisted(() => ({
  entries: new Map<string, string>(),
  reads: "works" as "works" | "throws",
  writes: "works" as "works" | "throws",
  deletion: "works" as "works" | "throws",
}));

vi.mock("expo-secure-store", () => ({
  WHEN_UNLOCKED_THIS_DEVICE_ONLY: 1,
  getItemAsync: async (key: string) => {
    if (native.reads === "throws") throw new Error("injected keychain read failure: interaction not allowed");
    return native.entries.get(key) ?? null;
  },
  setItemAsync: async (key: string, value: string) => {
    if (native.writes === "throws") throw new Error("injected keychain write failure");
    native.entries.set(key, value);
  },
  deleteItemAsync: async (key: string) => {
    if (native.deletion === "throws") throw new Error("native deletion denied");
    native.entries.delete(key);
  },
}));

const URL = "http://127.0.0.1:54321";
// Published local-only test keys, identical to the existing integration suites.
const ANON = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0";
const ADMIN_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU";
const SESSION_KEY = "sb-127-auth-token";

const admin = createClient(URL, ADMIN_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
const created: string[] = [];
const password = `Confirm-${randomUUID()}-Aa1!`;

/** One request a device sent: where, as whom (the bearer's subject), and the status it was answered — or null. */
interface Sent {
  readonly path: string;
  readonly as: string | null;
  status: number | null;
}

function subjectOf(authorization: string | null): string | null {
  const payload = authorization?.replace(/^Bearer /, "").split(".")[1];
  if (payload === undefined) return null;
  try {
    return (JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { sub?: string }).sub ?? null;
  } catch {
    return null;
  }
}

/** `client.ts`'s auth options over the PRODUCTION storage factory; `offline` makes only `/auth/v1/user` unreachable. */
function device(sent: Sent[] = [], network: { offline: boolean } = { offline: false }): ArcSupabaseClient {
  return createClient(URL, ANON, {
    auth: {
      storage: createSecureSessionStorage(),
      persistSession: true,
      autoRefreshToken: false,
      detectSessionInUrl: false,
      flowType: "pkce",
      lock: processLock,
    },
    global: {
      fetch: async (input: RequestInfo | globalThis.URL, init?: RequestInit) => {
        const url = String(input instanceof Request ? input.url : input);
        const record: Sent = { path: new globalThis.URL(url).pathname, as: subjectOf(new Headers(init?.headers).get("Authorization")), status: null };
        sent.push(record);
        if (network.offline && url.includes("/auth/v1/user")) throw new TypeError("Network request failed");
        const response = await fetch(input, init);
        record.status = response.status;
        return response;
      },
    },
  }) as ArcSupabaseClient;
}

async function storedPlayer(): Promise<string | null> {
  const reads = native.reads;
  native.reads = "works";
  try {
    const keychain = (await import("expo-secure-store")) as unknown as SecureStoreLike;
    const raw = await new ChunkedSecureSessionStorage(keychain).getItem(SESSION_KEY);
    return raw === null ? null : ((JSON.parse(raw) as { user?: { id?: string } }).user?.id ?? null);
  } finally {
    native.reads = reads;
  }
}

const shownPlayer = (): string | null => useAuthStore.getState().session?.account.userId ?? null;

async function launchOn(client: ArcSupabaseClient): Promise<void> {
  disposeAuthSubscription();
  resetPlayerState();
  setSupabaseAvailabilityForTests({ status: "ready", client });
  setGuestIdentityStore(new GuestIdentityStore(new MemoryKeyValueStore()));
  useAuthStore.setState({
    hydrated: false, session: null, mode: "unknown", guest: null, form: initialAuthFormState("signIn"),
    bootstrapStatus: "idle", bootstrapFailure: null, automaticBootstrap: true,
  });
  await useAuthStore.getState().hydrate();
}

function watchShown(): { readonly seen: (string | null)[]; stop(): void } {
  const seen: (string | null)[] = [];
  const stop = useAuthStore.subscribe((next) => { seen.push(next.session?.account.userId ?? null); });
  return { seen, stop };
}

/** A device holding `email`'s player, saved with a working keychain and confirmed once — the audit's starting point. */
async function signedInDevice(email: string): Promise<ArcSupabaseClient> {
  native.entries.clear();
  native.reads = "works";
  native.writes = "works";
  native.deletion = "works";
  const client = device();
  const signedIn = await client.auth.signInWithPassword({ email, password });
  expect(signedIn.error).toBeNull();
  await launchOn(client);
  return client;
}

/** Readbacks straight from the database; THROWS when it cannot run. */
function database(sql: string): string {
  return execFileSync(
    "docker",
    ["exec", "supabase_db_arc21", "psql", "-U", "postgres", "-d", "postgres", "-X", "-v", "ON_ERROR_STOP=1", "-Atc", sql],
    { encoding: "utf8" },
  ).trim();
}

async function secured(label: string): Promise<{ id: string; email: string }> {
  const email = `b-h-${label}-${randomUUID()}@arc21.test`;
  const result = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  expect(result.error).toBeNull();
  created.push(result.data.user!.id);
  return { id: result.data.user!.id, email };
}

/** Account-owned work: anything sent as `player` that is not the auth server's own business. */
const accountWork = (sent: readonly Sent[], player: string): Sent[] =>
  sent.filter((request) => request.as === player && !request.path.startsWith("/auth/v1/"));

/** Everything the server holds that the audit's operations, or the sweep's, would have changed. */
function serverState(player: string): Record<string, string> {
  return {
    cosmetics: database(`select count(*) from public.user_cosmetics where user_id = '${player}'`),
    dailyEntries: database(`select count(*) from public.daily_entries where user_id = '${player}'`),
    seats: database(`select count(*) from public.game_session_seats where user_id = '${player}'`),
    rateLimitEvents: database(`select count(*) from public.rate_limit_events where user_id = '${player}'`),
    lastSeen: database(`select coalesce(last_seen_at::text, 'never') from public.profiles where id = '${player}'`),
  };
}

const suite = stackUp ? describe : describe.skip;

suite("B-H1 / B-H3: account-owned work and adoption wait for the auth server's own answer", () => {
  afterAll(async () => {
    usePresenceStore.getState().leave();
    disposeAuthSubscription();
    resetPlayerState();
    useAuthStore.setState({ session: null, mode: "guest" });
    setGuestIdentityStore(null);
    setSupabaseAvailabilityForTests(null);
    for (const id of created) await admin.auth.admin.deleteUser(id);
    expect(database(`select count(*) from auth.users where id in (${created.map((id) => `'${id}'`).join(",")})`)).toBe("0");
  });

  it("THE AUDIT'S B-H1 REPRODUCTION, inverted: with /user unreachable, Inventory, Daily and the startup sweep change nothing on the server", async () => {
    const kept = await secured("unconfirmed");
    await signedInDevice(kept.email);
    const before = serverState(kept.id);
    expect(before.cosmetics).toBe("0");

    const sent: Sent[] = [];
    const network = { offline: true };
    await launchOn(device(sent, network));
    expect(shownPlayer()).toBeNull();
    expect(useAuthStore.getState().bootstrapFailure?.code).toBe("NETWORK");
    expect(await storedPlayer()).toBe(kept.id);

    // The audit's operations, through the production functions the screens call…
    await useCosmeticsStore.getState().load();
    await useDailyStore.getState().load();
    const opened = await useDailyStore.getState().start();
    // …and the other startup-reachable account work that would write something.
    useFriendsStore.getState().setQuery("ab");
    await useFriendsStore.getState().search();
    await useWalletStore.getState().refresh();
    await useTournamentStore.getState().load();
    await useCareerServerStore.getState().refresh();
    usePresenceStore.getState().join(kept.id, "available");
    usePresenceStore.getState().setOwnState("in_game");
    await new Promise((resolve) => setTimeout(resolve, 200));

    // The audit measured user_cosmetics 0 → 4, Daily `ready`, a ranked game opened.
    expect(useCosmeticsStore.getState().status.kind).not.toBe("ready");
    expect(useDailyStore.getState().status.kind).not.toBe("ready");
    expect(opened).toBeNull();
    expect(accountWork(sent, kept.id)).toEqual([]);
    expect(serverState(kept.id)).toEqual(before);

    // The server reachable again: confirmation, then the same production
    // operations work, as that player — with Postgres as the witness.
    network.offline = false;
    await useAuthStore.getState().ensurePlayer();
    expect(shownPlayer()).toBe(kept.id);
    await useCosmeticsStore.getState().load();
    await useDailyStore.getState().load();
    const ranked = await useDailyStore.getState().start();
    expect(useCosmeticsStore.getState().status.kind).toBe("ready");
    expect(Number(database(`select count(*) from public.user_cosmetics where user_id = '${kept.id}'`))).toBeGreaterThan(0);
    expect(useDailyStore.getState().status.kind).toBe("ready");
    expect(ranked).toMatchObject({ ranked: true });
    expect(database(`select count(*) from public.daily_entries where user_id = '${kept.id}'`)).toBe("1");
    expect(database(`select count(*) from public.game_session_seats where user_id = '${kept.id}' and game_session_id = '${ranked!.gameId}'`)).toBe("1");
  }, 60_000);

  it("THE AUDIT'S B-H3 REPRODUCTION, inverted: the keychain throws inside getUser() and the erased account is still never adopted", async () => {
    const doomed = await secured("erased-at-verify");
    await signedInDevice(doomed.email);
    disposeAuthSubscription();
    resetPlayerState();
    expect((await admin.auth.admin.deleteUser(doomed.id)).error).toBeNull();
    expect(database(`select count(*) from auth.users where id = '${doomed.id}'`)).toBe("0");

    const sent: Sent[] = [];
    const next = device(sent);
    const getUser = next.auth.getUser.bind(next.auth);
    next.auth.getUser = (async (...args: Parameters<typeof getUser>) => {
      native.reads = "throws";
      try { return await getUser(...args); } finally { native.reads = "works"; }
    }) as typeof next.auth.getUser;
    const watch = watchShown();
    await launchOn(next);
    watch.stop();

    // The audit read shown = SDK = stored = the erased UUID, `ready`, 0 `/user`.
    expect(watch.seen).not.toContain(doomed.id);
    expect(shownPlayer()).toBeNull();
    expect(useAuthStore.getState().bootstrapFailure?.code).toBe("ACCOUNT_DELETED");
    expect(await storedPlayer()).toBeNull();
    // The verdict is a response from the real GoTrue: one question, answered 403.
    expect(sent.filter((request) => request.path === "/auth/v1/user").map(({ as, status }) => ({ as, status })))
      .toEqual([{ as: doomed.id, status: 403 }]);
    expect(accountWork(sent, doomed.id)).toEqual([]);
  });

  it("a keychain that cannot be read while the launch obtains the credential sends no question, adopts nobody, removes nothing — then the server decides", async () => {
    const doomed = await secured("unreadable-then-erased");
    await signedInDevice(doomed.email);
    disposeAuthSubscription();
    resetPlayerState();
    expect((await admin.auth.admin.deleteUser(doomed.id)).error).toBeNull();

    native.reads = "throws";
    const sent: Sent[] = [];
    const watch = watchShown();
    await launchOn(device(sent));

    expect(watch.seen).not.toContain(doomed.id);
    expect(shownPlayer()).toBeNull();
    expect(useAuthStore.getState().bootstrapFailure?.code).toBe("PERSISTENCE_UNAVAILABLE");
    // NO AUTHORITATIVE RESPONSE: nothing was even asked.
    expect(sent.filter((request) => request.path === "/auth/v1/user")).toEqual([]);
    expect(sent.some((request) => request.path === "/auth/v1/signup")).toBe(false);
    expect(await storedPlayer()).toBe(doomed.id);

    // Storage recovers: the authoritative reconciliation runs and its verdict stands.
    native.reads = "works";
    await useAuthStore.getState().ensurePlayer();
    watch.stop();
    expect(watch.seen).not.toContain(doomed.id);
    expect(useAuthStore.getState().bootstrapFailure?.code).toBe("ACCOUNT_DELETED");
    expect(await storedPlayer()).toBeNull();
    expect(sent.filter((request) => request.path === "/auth/v1/user").map((request) => request.status)).toEqual([403]);
    expect(accountWork(sent, doomed.id)).toEqual([]);
  });

  it("a REAL ended session (account still there) the keychain keeps is not adopted at a launch, and nothing is sent as it", async () => {
    const ended = await secured("ended-kept");
    const client = await signedInDevice(ended.email);
    const token = (await client.auth.getSession()).data.session!.access_token;
    disposeAuthSubscription();
    resetPlayerState();
    // Revoke every session of the account server-side; the account itself stays.
    expect((await admin.auth.admin.signOut(token, "global")).error).toBeNull();
    expect(database(`select count(*) from auth.users where id = '${ended.id}'`)).toBe("1");

    native.deletion = "throws";
    native.writes = "throws";
    const sent: Sent[] = [];
    const watch = watchShown();
    await launchOn(device(sent));
    watch.stop();
    native.deletion = "works";
    native.writes = "works";

    expect(sent.filter((request) => request.path === "/auth/v1/user").map(({ as, status }) => ({ as, status })))
      .toEqual([{ as: ended.id, status: 403 }]);
    expect(watch.seen).not.toContain(ended.id);
    expect(shownPlayer()).toBeNull();
    expect(useAuthStore.getState().bootstrapFailure?.code).toBe("CREDENTIAL_NOT_REMOVED");
    expect(await storedPlayer()).toBe(ended.id);
    expect(accountWork(sent, ended.id)).toEqual([]);
  });

  it("POSITIVE CONTROL: a live account is confirmed by one answered /user and is then served normally", async () => {
    const live = await secured("live");
    await signedInDevice(live.email);
    disposeAuthSubscription();
    resetPlayerState();

    const sent: Sent[] = [];
    await launchOn(device(sent));
    expect(shownPlayer()).toBe(live.id);
    expect(sent.filter((request) => request.path === "/auth/v1/user").map(({ as, status }) => ({ as, status })))
      .toEqual([{ as: live.id, status: 200 }]);
    await useWalletStore.getState().refresh();
    expect(useWalletStore.getState().status).toMatchObject({ kind: "ready" });
  });
});
