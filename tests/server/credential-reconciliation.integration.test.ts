/**
 * B-G1 and B-G3 against real GoTrue and Postgres: what a launch restores is
 * reconciled with the server and the keychain before anybody is shown.
 *
 * The final independent Refresh-B re-audit (October 3, 2026) persisted a real
 * secured player through the PRODUCTION storage factory, hydrated the
 * production Auth store, and ran its `deleteAccount` three ways — the keychain
 * refusing every change once the real `delete_own_account` had committed, the
 * committed reply lost, and the reply withheld while the client was discarded
 * as a terminated process would be. With the keychain healthy again, a cold
 * hydration read `auth.users = 0` and yet `shown = SDK = stored = the erased
 * UUID`, `bootstrap: ready`, `failure: null` (B-G1). And a sign-out whose head
 * delete and every write were refused, but whose chunk deletes worked,
 * succeeded — and every later launch, the keychain healthy, refused to start a
 * player with `PERSISTENCE_UNAVAILABLE` (B-G3).
 *
 * These are those reproductions, inverted: the audit's own native double, the
 * production storage factory, `client.ts`'s auth options, the production store
 * hydrated by its own `hydrate()`, the production adapter and friends store.
 * Readbacks come from the database.
 *
 * Budget: every player is admin-created and signed in with a password except
 * the two players a launch creates, which is what a launch with nothing
 * restorable does. Local GoTrue caps anonymous sign-ins at 30 an hour.
 *
 * A SKIP IS NOT A PASS. `npm run test:server` sets ARC21_REQUIRE_SERVER_STACK.
 */

import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createClient, processLock } from "@supabase/supabase-js";

import { stackUp } from "./stack-guard.js";
import {
  disposeAuthSubscription,
  setGuestIdentityStore,
  useAuthStore,
} from "../../src/features/auth/auth-store.js";
import { initialAuthFormState } from "../../src/features/auth/auth-machine.js";
import { GuestIdentityStore } from "../../src/features/auth/guest.js";
import { MemoryKeyValueStore } from "../../src/lib/persistence/key-value-store.js";
import { resetPlayerState } from "../../src/features/player/reset-player-state.js";
import { useFriendsStore } from "../../src/features/friends/friends-store.js";
import { setSupabaseAvailabilityForTests, type ArcSupabaseClient } from "../../src/lib/supabase/client.js";
import {
  ChunkedSecureSessionStorage,
  createSecureSessionStorage,
  getSessionStorageDurability,
  type SecureStoreLike,
} from "../../src/lib/supabase/secure-session-storage.js";

/** The audit's native double, plus a keychain whose reads can be made to throw. */
const native = vi.hoisted(() => ({
  entries: new Map<string, string>(),
  headRefused: false,
  deletion: "works" as "works" | "throws",
  writes: "works" as "works" | "throws",
  reads: "works" as "works" | "throws",
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
    if (native.headRefused && key === "sb-127-auth-token") throw new Error("head delete denied");
    if (native.deletion === "throws") throw new Error("native deletion denied");
    native.entries.delete(key);
  },
}));

const URL = "http://127.0.0.1:54321";
// Published local-only test keys, identical to the existing integration suites.
const ANON = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0";
const ADMIN_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU";

/** The SDK's default key for this project URL, `sb-<first host label>-auth-token`. */
const SESSION_KEY = "sb-127-auth-token";

const admin = createClient(URL, ADMIN_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
const created: string[] = [];

/** One request a device sent: where, and as whom (the bearer token's subject). */
interface Sent {
  readonly path: string;
  readonly as: string | null;
}

/** The subject of a bearer token, read without verifying it: only to say who a request was SENT as. */
function subjectOf(authorization: string | null): string | null {
  const payload = authorization?.replace(/^Bearer /, "").split(".")[1];
  if (payload === undefined) return null;
  try {
    return (JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { sub?: string }).sub ?? null;
  } catch {
    return null;
  }
}

/**
 * A device: `client.ts`'s auth options over the PRODUCTION storage factory —
 * the audit's harness. `autoRefreshToken: false` so no timer outlives the file.
 * Records what it sends; any player GoTrue creates is recorded for cleanup.
 * `offline` makes GoTrue's `/user` unreachable from this device.
 */
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
        sent.push({ path: new globalThis.URL(url).pathname, as: subjectOf(new Headers(init?.headers).get("Authorization")) });
        if (network.offline && url.includes("/auth/v1/user")) throw new TypeError("Network request failed");
        const response = await fetch(input, init);
        if (url.includes("/auth/v1/signup")) {
          const body = (await response.clone().json().catch(() => null)) as { user?: { id?: string } } | null;
          if (body?.user?.id) created.push(body.user.id);
        }
        return response;
      },
    },
  }) as ArcSupabaseClient;
}

/** Who a cold start would restore — parsed here, so this measures the keychain. */
async function storedPlayer(): Promise<string | null> {
  const reads = native.reads;
  native.reads = "works";
  try {
    const module = (await import("expo-secure-store")) as unknown as SecureStoreLike;
    const raw = await new ChunkedSecureSessionStorage(module).getItem(SESSION_KEY);
    return raw === null ? null : ((JSON.parse(raw) as { user?: { id?: string } }).user?.id ?? null);
  } finally {
    native.reads = reads;
  }
}

async function sdkPlayer(client: ArcSupabaseClient): Promise<string | null> {
  return (await client.auth.getSession()).data.session?.user.id ?? null;
}

const shownPlayer = (): string | null => useAuthStore.getState().session?.account.userId ?? null;

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

/** Every player the store held from the moment this is called. */
function watchShown(): { readonly seen: (string | null)[]; stop(): void } {
  const seen: (string | null)[] = [];
  const stop = useAuthStore.subscribe((next) => { seen.push(next.session?.account.userId ?? null); });
  return { seen, stop };
}

/** A device already holding `email`'s player, saved with a working keychain. */
async function signedInDevice(email: string): Promise<ArcSupabaseClient> {
  native.entries.clear();
  native.headRefused = false;
  native.deletion = "works";
  native.writes = "works";
  native.reads = "works";
  const client = device();
  expect((await client.auth.signInWithPassword({ email, password })).error).toBeNull();
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

function sendersTo(receiver: string): readonly string[] {
  return JSON.parse(
    database(
      `select coalesce(json_agg(sender_id::text order by created_at), '[]'::json)
       from public.friend_requests where receiver_id = '${receiver}'::uuid`,
    ),
  ) as string[];
}

const usersNamed = (id: string): string => database(`select count(*) from auth.users where id = '${id}'::uuid`);

async function createSecured(label: string): Promise<{ id: string; email: string }> {
  const email = `b-g-${label}-${randomUUID()}@arc21.test`;
  const result = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  expect(result.error).toBeNull();
  created.push(result.data.user!.id);
  return { id: result.data.user!.id, email };
}

const password = `Reconcile-${randomUUID()}-Aa1!`;
let stopIdentity: (() => void) | null = null;

const suite = stackUp ? describe : describe.skip;

suite("what a launch restores is reconciled with the server and the keychain first", () => {
  beforeAll(() => {
    // `usePlayerState`'s identity-change body; the hook itself needs React Native.
    stopIdentity = useAuthStore.subscribe((next, previous) => {
      if ((next.session?.account.userId ?? null) !== (previous.session?.account.userId ?? null)) resetPlayerState();
    });
  });

  afterAll(async () => {
    stopIdentity?.();
    disposeAuthSubscription();
    resetPlayerState();
    useAuthStore.setState({ session: null, mode: "guest" });
    setGuestIdentityStore(null);
    setSupabaseAvailabilityForTests(null);
    native.headRefused = false;
    native.deletion = "works";
    native.writes = "works";
    native.reads = "works";
    for (const id of created) {
      const result = await admin.auth.admin.deleteUser(id);
      // The deletion cases erased their players already, through the product.
      expect(result.error === null || result.error.code === "user_not_found").toBe(true);
    }
    expect(database(`select count(*) from auth.users where id in (${created.map((id) => `'${id}'`).join(",")})`)).toBe("0");
  });

  describe("B-G1: an erased account's credential is never adopted, however the deletion was interrupted", () => {
    it.each(["cleanup-refused", "reply-lost", "process-ended-before-reply"] as const)(
      "THE AUDIT'S REPRODUCTION (%s): the relaunch reconciles with the server and adopts nobody",
      async (fault) => {
        const doomed = await createSecured(fault);
        const recipient = await createSecured(`${fault}-recipient`);
        const client = await signedInDevice(doomed.email);
        expect(shownPlayer()).toBe(doomed.id);
        const rpc = client.rpc.bind(client);
        let erased!: () => void;
        const committed = new Promise<void>((resolve) => { erased = resolve; });
        client.rpc = ((name: string, ...args: unknown[]) => {
          const call = (rpc as (n: string, ...a: unknown[]) => PromiseLike<unknown>)(name, ...args);
          if (name !== "delete_own_account") return call;
          return Promise.resolve(call).then((answer) => {
            expect(usersNamed(doomed.id)).toBe("0");
            erased();
            if (fault === "cleanup-refused") {
              native.writes = "throws";
              native.deletion = "throws";
              return answer;
            }
            if (fault === "reply-lost") throw new TypeError("reply lost after a confirmed server commit");
            // This process receives no answer and runs no removal; the next one
            // launches over exactly the native entries it left.
            return new Promise<never>(() => {});
          });
        }) as typeof client.rpc;

        const request = useAuthStore.getState().deleteAccount(doomed.id);
        await committed;
        if (fault !== "process-ended-before-reply") expect(await request).toBe(false);
        expect(await storedPlayer()).toBe(doomed.id);

        native.writes = "works";
        native.deletion = "works";
        const sent: Sent[] = [];
        const relaunched = device(sent);
        const watch = watchShown();
        await launchOn(relaunched);
        watch.stop();
        const after = {
          seenErased: watch.seen.includes(doomed.id),
          shown: shownPlayer(),
          sdk: await sdkPlayer(relaunched),
          stored: await storedPlayer(),
          bootstrap: useAuthStore.getState().bootstrapStatus,
          failure: useAuthStore.getState().bootstrapFailure?.code ?? null,
          rows: usersNamed(doomed.id),
        };
        const friendResult = await useFriendsStore.getState().sendRequest(recipient.id);

        // The audit read: rows 0, shown = sdk = stored = the erased UUID, ready, no failure.
        expect(after).toEqual({
          seenErased: false, shown: null, sdk: null, stored: null, bootstrap: "unavailable", failure: "ACCOUNT_DELETED", rows: "0",
        });
        expect(friendResult).toBe(false);
        expect(sendersTo(recipient.id)).toEqual([]);
        expect(sent.filter((entry) => entry.path.startsWith("/rest/v1/") && entry.as === doomed.id)).toEqual([]);
        void request;
      },
      30_000,
    );

    it("and Connect then starts a NEW player, whose protected request is sent as the player shown", async () => {
      const doomed = await createSecured("converges");
      const recipient = await createSecured("converges-recipient");
      const client = await signedInDevice(doomed.email);
      const rpc = client.rpc.bind(client);
      client.rpc = ((name: string, ...args: unknown[]) => {
        const call = (rpc as (n: string, ...a: unknown[]) => PromiseLike<unknown>)(name, ...args);
        if (name !== "delete_own_account") return call;
        return Promise.resolve(call).then(() => { throw new TypeError("reply lost after a confirmed server commit"); });
      }) as typeof client.rpc;
      expect(await useAuthStore.getState().deleteAccount(doomed.id)).toBe(false);
      expect(usersNamed(doomed.id)).toBe("0");

      const relaunched = device();
      await launchOn(relaunched);
      expect(useAuthStore.getState().bootstrapFailure?.code).toBe("ACCOUNT_DELETED");

      await useAuthStore.getState().ensurePlayer();
      const fresh = shownPlayer();
      expect(fresh).not.toBeNull();
      expect(fresh).not.toBe(doomed.id);
      expect(await sdkPlayer(relaunched)).toBe(fresh);
      expect(await storedPlayer()).toBe(fresh);
      expect(database(`select is_anonymous from auth.users where id = '${fresh}'::uuid`)).toBe("t");
      expect(await useFriendsStore.getState().sendRequest(recipient.id)).toBe(true);
      expect(sendersTo(recipient.id)).toEqual([fresh]);
    }, 30_000);

    it("POSITIVE CONTROL: an account that exists is restored on relaunch", async () => {
      const kept = await createSecured("restored");
      await signedInDevice(kept.email);
      const relaunched = device();
      await launchOn(relaunched);

      expect(shownPlayer()).toBe(kept.id);
      expect(useAuthStore.getState().bootstrapStatus).toBe("ready");
      expect(await sdkPlayer(relaunched)).toBe(kept.id);
      expect(await storedPlayer()).toBe(kept.id);
    });

    it("the relaunch asks GoTrue about the account with the restored credential's own token, once", async () => {
      const kept = await createSecured("asked");
      await signedInDevice(kept.email);
      const sent: Sent[] = [];
      await launchOn(device(sent));

      expect(sent.filter((entry) => entry.path === "/auth/v1/user").map((entry) => entry.as)).toEqual([kept.id]);
      expect(shownPlayer()).toBe(kept.id);
    });

    it("a deletion that never reached the server is not mistaken for an erasure: the account is restored", async () => {
      const kept = await createSecured("not-deleted");
      const client = await signedInDevice(kept.email);
      const rpc = client.rpc.bind(client);
      client.rpc = ((name: string, ...args: unknown[]) => {
        if (name === "delete_own_account") return Promise.reject(new TypeError("Network request failed"));
        return (rpc as (n: string, ...a: unknown[]) => PromiseLike<unknown>)(name, ...args);
      }) as typeof client.rpc;
      expect(await useAuthStore.getState().deleteAccount(kept.id)).toBe(false);
      expect(usersNamed(kept.id)).toBe("1");

      const relaunched = device();
      await launchOn(relaunched);
      expect(shownPlayer()).toBe(kept.id);
      expect(useAuthStore.getState().bootstrapStatus).toBe("ready");
      expect(await storedPlayer()).toBe(kept.id);
    });

    it("a server it cannot reach is not a verdict: nobody adopted, nothing removed, the player restored once reachable", async () => {
      const kept = await createSecured("unreachable");
      await signedInDevice(kept.email);
      const network = { offline: true };
      const sent: Sent[] = [];
      const relaunched = device(sent, network);
      const watch = watchShown();
      await launchOn(relaunched);

      expect(watch.seen).not.toContain(kept.id);
      expect(useAuthStore.getState().bootstrapFailure?.code).toBe("NETWORK");
      expect(await storedPlayer()).toBe(kept.id);
      expect(sent.some((entry) => entry.path === "/auth/v1/logout" || entry.path === "/auth/v1/signup")).toBe(false);
      expect(usersNamed(kept.id)).toBe("1");

      network.offline = false;
      await useAuthStore.getState().ensurePlayer();
      watch.stop();
      expect(shownPlayer()).toBe(kept.id);
      expect(useAuthStore.getState().bootstrapStatus).toBe("ready");
    });
  });

  describe("B-G3: an unrestorable credential is an absence, an unreadable keychain is not", () => {
    it("THE AUDIT'S REPRODUCTION: a sign-out that could only break the chunks, then a healthy launch starts a player", async () => {
      const player = await createSecured("chunk-relaunch");
      const client = await signedInDevice(player.email);
      native.headRefused = true;
      native.writes = "throws";
      await useAuthStore.getState().signOut(player.id);
      const before = {
        status: useAuthStore.getState().form.status.kind,
        shown: shownPlayer(),
        sdk: await sdkPlayer(client),
        stored: await storedPlayer(),
        chunklessHead: /^arc21\.chunked\.v2:[01]:\d+$/.test(native.entries.get(SESSION_KEY) ?? ""),
        durability: getSessionStorageDurability(),
      };

      native.headRefused = false;
      native.writes = "works";
      const sent: Sent[] = [];
      const next = device(sent);
      await launchOn(next);
      await useAuthStore.getState().ensurePlayer();
      const fresh = shownPlayer();
      const after = {
        fresh: fresh !== null && fresh !== player.id,
        sdk: (await sdkPlayer(next)) === fresh,
        stored: (await storedPlayer()) === fresh,
        bootstrap: useAuthStore.getState().bootstrapStatus,
        failure: useAuthStore.getState().bootstrapFailure?.code ?? null,
        head: native.entries.get(SESSION_KEY)?.startsWith("arc21.chunked.v2:") ?? false,
      };

      // The audit read before: durability `unavailable`; after: shown null,
      // bootstrap `unavailable`, PERSISTENCE_UNAVAILABLE, the same chunk-less head.
      expect({ before, after }).toEqual({
        before: { status: "idle", shown: null, sdk: null, stored: null, chunklessHead: true, durability: "unknown" },
        after: { fresh: true, sdk: true, stored: true, bootstrap: "ready", failure: null, head: true },
      });
      expect(database(`select is_anonymous from auth.users where id = '${fresh}'::uuid`)).toBe("t");
      expect(database(`select count(*) from auth.sessions where user_id = '${player.id}'::uuid`)).toBe("0");
      expect(sent.filter((entry) => entry.path === "/auth/v1/signup")).toHaveLength(1);
    }, 30_000);

    it("a keychain that cannot be READ fails closed: nobody created or removed, and the player survives to be restored", async () => {
      const player = await createSecured("unreadable");
      await signedInDevice(player.email);
      const before = new Map(native.entries);
      native.reads = "throws";
      const sent: Sent[] = [];
      await launchOn(device(sent));

      expect(shownPlayer()).toBeNull();
      expect(useAuthStore.getState().bootstrapStatus).toBe("unavailable");
      expect(useAuthStore.getState().bootstrapFailure?.code).toBe("PERSISTENCE_UNAVAILABLE");
      expect(sent.some((entry) => entry.path === "/auth/v1/signup")).toBe(false);
      expect(native.entries).toEqual(before);

      native.reads = "works";
      await useAuthStore.getState().ensurePlayer();
      expect(shownPlayer()).toBe(player.id);
      expect(sent.some((entry) => entry.path === "/auth/v1/signup")).toBe(false);
    });
  });
});
