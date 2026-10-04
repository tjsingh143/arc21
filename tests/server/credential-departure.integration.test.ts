/**
 * B-F2 — a player is signed out of this device only once their credential has
 * actually left it. Against real GoTrue and Postgres.
 *
 * The final Refresh-B audit (September 30, 2026) persisted player A through the
 * PRODUCTION storage factory, hydrated the production Auth store on a real
 * supabase-js client, and made only the native keychain's delete fail. The
 * production `signOut(A)` then left the screen showing nobody and the form
 * reporting nothing wrong, while the SDK still held A. A fresh launch restored
 * A, and a friend request from there was committed with **A as the sender**. A
 * delete that resolved WITHOUT deleting — how the installed iOS wrapper treats
 * a failed `SecItemDelete` — did the same. And a confirmed account deletion
 * with the same failure left `auth.users` without A while a cold start adopted
 * A's UUID again.
 *
 * This is that reproduction, inverted: the production storage factory over a
 * double of `expo-secure-store` (and nothing else), `client.ts`'s auth options,
 * real GoTrue, the production store hydrated by its own `hydrate()`, the
 * production adapter, and the production friends store for the protected
 * request. Readbacks come from the database.
 *
 * Budget: every player is admin-created and signed in with a password except
 * the two players a relaunch creates, which is what a relaunch with nothing
 * stored does. Local GoTrue caps anonymous sign-ins at 30 an hour.
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

/**
 * The native keychain double: the audit's own. `silent` resolves without
 * deleting, as the installed iOS wrapper does with a failed `SecItemDelete`.
 */
const native = vi.hoisted(() => ({
  entries: new Map<string, string>(),
  deletion: "works" as "works" | "throws" | "silent",
  writes: "works" as "works" | "throws",
}));

vi.mock("expo-secure-store", () => ({
  WHEN_UNLOCKED_THIS_DEVICE_ONLY: 1,
  getItemAsync: async (key: string) => native.entries.get(key) ?? null,
  setItemAsync: async (key: string, value: string) => {
    if (native.writes === "throws") throw new Error("injected keychain write failure");
    native.entries.set(key, value);
  },
  deleteItemAsync: async (key: string) => {
    if (native.deletion === "throws") throw new Error("native deletion denied");
    if (native.deletion === "works") native.entries.delete(key);
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

/**
 * A device: `client.ts`'s auth options over the PRODUCTION storage factory —
 * the audit's harness. `autoRefreshToken: false` so no timer outlives the file.
 * Any player GoTrue creates is recorded for cleanup.
 */
function device(): ArcSupabaseClient {
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
        const response = await fetch(input, init);
        if (String(input instanceof Request ? input.url : input).includes("/auth/v1/signup")) {
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
  const module = (await import("expo-secure-store")) as unknown as SecureStoreLike;
  const raw = await new ChunkedSecureSessionStorage(module).getItem(SESSION_KEY);
  return raw === null ? null : ((JSON.parse(raw) as { user?: { id?: string } }).user?.id ?? null);
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

/** A device already holding `email`'s player, saved with a working keychain. */
async function signedInDevice(email: string, password: string): Promise<ArcSupabaseClient> {
  native.entries.clear();
  native.deletion = "works";
  native.writes = "works";
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

async function createSecured(label: string, password: string): Promise<{ id: string; email: string }> {
  const email = `b-f2-${label}-${randomUUID()}@arc21.test`;
  const result = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  expect(result.error).toBeNull();
  created.push(result.data.user!.id);
  return { id: result.data.user!.id, email };
}

const password = `Departure-${randomUUID()}-Aa1!`;
let playerA = { id: "", email: "" };
let recipient = { id: "", email: "" };
let stopIdentity: (() => void) | null = null;

const suite = stackUp ? describe : describe.skip;

suite("B-F2: a sign-out or deletion never leaves a restorable credential behind a signed-out screen", () => {
  beforeAll(async () => {
    playerA = await createSecured("a", password);
    recipient = await createSecured("recipient", password);
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
    native.deletion = "works";
    native.writes = "works";
    for (const id of created) {
      const result = await admin.auth.admin.deleteUser(id);
      // The deletion cases erased their players already, through the product.
      expect(result.error === null || result.error.code === "user_not_found").toBe(true);
    }
    expect(database(`select count(*) from auth.users where id in (${created.map((id) => `'${id}'`).join(",")})`)).toBe("0");
  });

  it("THE AUDIT'S REPRODUCTION: a rejected keychain delete, and the relaunched app is not player A", async () => {
    const client = await signedInDevice(playerA.email, password);
    expect(shownPlayer()).toBe(playerA.id);

    native.deletion = "throws";
    await useAuthStore.getState().signOut(playerA.id);

    // The audit read: shown null, form idle, SDK still A. All three now agree.
    expect(useAuthStore.getState().form.status.kind).not.toBe("failed");
    expect(shownPlayer()).toBeNull();
    expect(await sdkPlayer(client)).toBeNull();
    expect(await storedPlayer()).toBeNull();

    // A cold start, with the keychain's delete still failing.
    const relaunched = device();
    await launchOn(relaunched);
    const restored = shownPlayer();
    expect(restored).not.toBeNull();
    expect(restored).not.toBe(playerA.id);
    expect(await sdkPlayer(relaunched)).toBe(restored);

    // The audit's protected request, from the relaunched app: it is NOT A's.
    expect(await useFriendsStore.getState().sendRequest(recipient.id)).toBe(true);
    expect(sendersTo(recipient.id)).toEqual([restored]);
    expect(sendersTo(recipient.id)).not.toContain(playerA.id);
  });

  it("the iOS shape: a delete that resolves without deleting, and nothing of A survives", async () => {
    const client = await signedInDevice(playerA.email, password);

    native.deletion = "silent";
    await useAuthStore.getState().signOut(playerA.id);

    expect(shownPlayer()).toBeNull();
    expect(await sdkPlayer(client)).toBeNull();
    expect(await storedPlayer()).toBeNull();
    // A relaunch's SDK finds nothing to restore.
    expect(await sdkPlayer(device())).toBeNull();
  });

  it("a keychain that refuses every change refuses the sign-out: screen, SDK, keychain, requests and relaunch all stay A", async () => {
    const client = await signedInDevice(playerA.email, password);

    native.deletion = "throws";
    native.writes = "throws";
    await useAuthStore.getState().signOut(playerA.id);

    expect(useAuthStore.getState().form.status).toMatchObject({
      kind: "failed",
      failure: { code: "CREDENTIAL_NOT_REMOVED" },
    });
    expect(shownPlayer()).toBe(playerA.id);
    expect(await sdkPlayer(client)).toBe(playerA.id);
    expect(await storedPlayer()).toBe(playerA.id);
    // Reads of the surviving credential did not erase the warning.
    expect(getSessionStorageDurability()).toBe("unavailable");

    // A protected request is sent as the player the screen shows.
    const before = sendersTo(recipient.id);
    useFriendsStore.setState(useFriendsStore.getInitialState(), true);
    const other = await createSecured("other", password);
    expect(await useFriendsStore.getState().sendRequest(other.id)).toBe(true);
    expect(sendersTo(other.id)).toEqual([shownPlayer()]);
    expect(sendersTo(recipient.id)).toEqual(before);

    // Relaunch. The sign-out's own `/logout` revoked this session on the
    // server and the keychain kept it. Until the B-H1/B-H3 repair the relaunch
    // ADOPTED A again ("the same player, consistently"), because the keychain
    // still served it. The final audit's §24 B-H3 recommendation: keep B-F2's
    // live retained-session behaviour (above, mid-run, A stays shown) "without
    // treating it as proof for a cold launch". A launch adopts only on the
    // server's word, and its word about THIS credential is `session_not_found`.
    // B-F2's invariant still holds, more strictly: nobody is shown AND nothing
    // is sent as A, because account-owned work requires an adopted player.
    const relaunched = device();
    await launchOn(relaunched);
    expect(shownPlayer()).toBeNull();
    expect(useAuthStore.getState().bootstrapFailure?.code).toBe("CREDENTIAL_NOT_REMOVED");
    expect(await sdkPlayer(relaunched)).toBe(playerA.id);
    expect(await storedPlayer()).toBe(playerA.id);
    const unseen = await createSecured("unseen", password);
    expect(await useFriendsStore.getState().sendRequest(unseen.id)).toBe(false);
    expect(sendersTo(unseen.id)).toEqual([]);

    // Retry once the keychain works: it completes, and says so.
    native.deletion = "works";
    native.writes = "works";
    await useAuthStore.getState().signOut(playerA.id);
    expect(useAuthStore.getState().form.status.kind).not.toBe("failed");
    expect(shownPlayer()).toBeNull();
    expect(await sdkPlayer(relaunched)).toBeNull();
    expect(await storedPlayer()).toBeNull();
    expect(native.entries.size).toBe(0);
  });

  it("confirmed account deletion with a rejected keychain delete: the erased UUID is not adopted on relaunch", async () => {
    const doomed = await createSecured("deleted", password);
    const client = await signedInDevice(doomed.email, password);
    expect(shownPlayer()).toBe(doomed.id);

    native.deletion = "throws";
    expect(await useAuthStore.getState().deleteAccount(doomed.id)).toBe(true);

    expect(usersNamed(doomed.id)).toBe("0");
    expect(shownPlayer()).toBeNull();
    expect(await sdkPlayer(client)).toBeNull();
    expect(await storedPlayer()).toBeNull();

    // The audit's cold hydration adopted the erased UUID. Now it creates a new player.
    const relaunched = device();
    await launchOn(relaunched);
    expect(shownPlayer()).not.toBe(doomed.id);
    expect(await sdkPlayer(relaunched)).not.toBe(doomed.id);
  });

  it("account deletion is refused before the server is asked when the keychain cannot change: the account and its player remain", async () => {
    const kept = await createSecured("kept", password);
    const client = await signedInDevice(kept.email, password);

    native.deletion = "throws";
    native.writes = "throws";
    expect(await useAuthStore.getState().deleteAccount(kept.id)).toBe(false);

    expect(useAuthStore.getState().form.status).toMatchObject({ kind: "failed", failure: { code: "CREDENTIAL_NOT_REMOVED" } });
    expect(usersNamed(kept.id)).toBe("1");
    expect(shownPlayer()).toBe(kept.id);
    expect(await sdkPlayer(client)).toBe(kept.id);
    expect(await storedPlayer()).toBe(kept.id);

    // The positive control: with a working keychain the same deletion completes.
    native.deletion = "works";
    native.writes = "works";
    expect(await useAuthStore.getState().deleteAccount(kept.id)).toBe(true);
    expect(usersNamed(kept.id)).toBe("0");
    expect(shownPlayer()).toBeNull();
    expect(await sdkPlayer(device())).toBeNull();
    expect(native.entries.has(SESSION_KEY)).toBe(false);
  });
});
