/**
 * Refresh-B blocker B-R5, against the real backend: a departing player's push
 * retirement never switches off the registration of the player who replaced
 * them.
 *
 * The final Astra audit started player A's production `retireDevice()`, held
 * its session lookup before storage was read, signed in as B, let B's normal
 * `registerDevice()` restore the device — the token row became B's — and
 * released the retirement. The row still belonged to B, and its `is_active`
 * went **true → false**: the retirement read B's credential, so the server's
 * `user_id = auth.uid()` check was satisfied by the wrong player.
 *
 * Production `push.ts` and its registration and retirement RPCs, real GoTrue,
 * real Postgres, the production Auth store and adapter. Only the native
 * boundary is doubled — the OS permission, a non-deliverable Expo token and
 * the EAS project id — exactly as in the audit. No push is sent: this is
 * registration state, not delivery.
 *
 * A SKIP IS NOT A PASS. `npm run test:server` sets ARC21_REQUIRE_SERVER_STACK.
 */

import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createClient, processLock } from "@supabase/supabase-js";

const native = vi.hoisted(() => ({ token: "" }));
vi.mock("expo-notifications", () => ({
  getExpoPushTokenAsync: async () => ({ data: native.token }),
  getPermissionsAsync: async () => ({ granted: true, canAskAgain: true }),
  requestPermissionsAsync: async () => ({ granted: true }),
  setNotificationChannelAsync: async () => undefined,
  setNotificationHandler: () => undefined,
  AndroidImportance: { HIGH: 4, DEFAULT: 3 },
}));
vi.mock("react-native", () => ({ Platform: { OS: "ios" } }));
vi.mock("expo-constants", () => ({
  default: { expoConfig: { extra: { eas: { projectId: "stale-push-fixture" } } }, sessionId: "stale-push-device" },
}));

import { stackUp } from "./stack-guard.js";
import { registerDevice, retireDevice } from "../../src/lib/notifications/push.js";
import {
  disposeAuthSubscription,
  setGuestIdentityStore,
  useAuthStore,
} from "../../src/features/auth/auth-store.js";
import { initialAuthFormState } from "../../src/features/auth/auth-machine.js";
import { GuestIdentityStore } from "../../src/features/auth/guest.js";
import { MemoryKeyValueStore } from "../../src/lib/persistence/key-value-store.js";
import { resetPlayerState } from "../../src/features/player/reset-player-state.js";
import {
  setSupabaseAvailabilityForTests,
  type ArcSupabaseClient,
} from "../../src/lib/supabase/client.js";

const URL = "http://127.0.0.1:54321";
// Published local-only test keys, identical to the existing integration suites.
const ANON = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0";
const ADMIN_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU";
const PREFERENCES = {
  notificationsEnabled: true,
  friendRequests: true,
  privateTableInvites: true,
  yourTurn: true,
  tournamentResults: true,
  dailyChallengeReminder: true,
};

const admin = createClient(URL, ADMIN_KEY, { auth: { persistSession: false, autoRefreshToken: false } });

/** Holds the next response to one RPC, so a device write can be left in flight. */
let heldResponse: { rpc: string; reach: () => void; gate: Promise<void> } | null = null;

const storage = new Map<string, string>();
const device = createClient(URL, ANON, {
  auth: {
    flowType: "pkce",
    lock: processLock,
    autoRefreshToken: false,
    detectSessionInUrl: false,
    storage: {
      getItem: (key) => storage.get(key) ?? null,
      setItem: (key, value) => { storage.set(key, value); },
      removeItem: (key) => { storage.delete(key); },
    },
  },
  global: {
    fetch: async (input: RequestInfo | globalThis.URL, init?: RequestInit) => {
      const response = await fetch(input, init);
      const url = String(input instanceof Request ? input.url : input);
      if (heldResponse && url.endsWith(`/rest/v1/rpc/${heldResponse.rpc}`)) {
        const held = heldResponse;
        heldResponse = null;
        held.reach();
        await held.gate;
      }
      return response;
    },
  },
}) as ArcSupabaseClient;

/** Readbacks straight from the database; THROWS when it cannot run. */
function database(sql: string): string {
  return execFileSync(
    "docker",
    ["exec", "supabase_db_arc21", "psql", "-U", "postgres", "-d", "postgres", "-X", "-v", "ON_ERROR_STOP=1", "-Atc", sql],
    { encoding: "utf8" },
  ).trim();
}

/** The device's one token row: whose it is, and whether it is on. */
function tokenRow(): { owner: string; active: boolean } | null {
  const row = database(
    `select coalesce((select json_build_object('owner', user_id::text, 'active', is_active)
                      from public.push_tokens where token = '${native.token}'), 'null'::json)`,
  );
  const parsed = JSON.parse(row) as { owner: string; active: boolean } | null;
  if (parsed === null) return null;
  return { owner: parsed.owner === playerA ? "A" : parsed.owner === playerB ? "B" : parsed.owner, active: parsed.active };
}

const created: string[] = [];
let playerA = "";
let playerB = "";
const emailA = `push-a-${randomUUID()}@arc21.test`;
const emailB = `push-b-${randomUUID()}@arc21.test`;
const password = `Push-${randomUUID()}!`;
let stopIdentity: (() => void) | null = null;

const visiblePlayer = (): string | null => useAuthStore.getState().session?.account.userId ?? null;

async function signInOnDevice(email: string, replacing: string): Promise<void> {
  useAuthStore.getState().dispatch({ type: "EDIT_EMAIL", value: email });
  await useAuthStore.getState().signIn(password, replacing);
  expect(useAuthStore.getState().form.status.kind).toBe("signedIn");
}

async function deviceIsA(): Promise<void> {
  if (visiblePlayer() !== playerA) await signInOnDevice(emailA, playerB);
  expect(visiblePlayer()).toBe(playerA);
}

const suite = stackUp ? describe : describe.skip;

suite("B-R5: a departing player's retirement cannot switch off the replacement's device", () => {
  beforeAll(async () => {
    native.token = `ExponentPushToken[stale-push-${randomUUID()}]`;
    for (const email of [emailA, emailB]) {
      const result = await admin.auth.admin.createUser({ email, password, email_confirm: true });
      expect(result.error).toBeNull();
      created.push(result.data.user!.id);
    }
    playerA = created[0]!;
    playerB = created[1]!;
    expect((await device.auth.signInWithPassword({ email: emailA, password })).error).toBeNull();

    setSupabaseAvailabilityForTests({ status: "ready", client: device });
    setGuestIdentityStore(new GuestIdentityStore(new MemoryKeyValueStore()));
    useAuthStore.setState({ hydrated: false, session: null, mode: "unknown", guest: null, form: initialAuthFormState("signIn") });
    await useAuthStore.getState().hydrate();
    expect(visiblePlayer()).toBe(playerA);
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
    await device.realtime.disconnect();
    for (const id of created) {
      const result = await admin.auth.admin.deleteUser(id);
      expect(result.error).toBeNull();
    }
    database(`delete from public.push_tokens where token = '${native.token}'`);
  });

  it("registers and retires the current player's own device (positive control)", async () => {
    expect(await registerDevice(PREFERENCES as never)).toEqual({ kind: "registered" });
    expect(tokenRow()).toEqual({ owner: "A", active: true });
    await retireDevice();
    expect(tokenRow()).toEqual({ owner: "A", active: false });
  });

  it("leaves B's restored registration on when A's delayed retirement resumes", async () => {
    await deviceIsA();
    expect(await registerDevice(PREFERENCES as never)).toEqual({ kind: "registered" });
    expect(tokenRow()).toEqual({ owner: "A", active: true });

    // THE AUDIT'S INJECTION: one `getSession()` held before it reads storage.
    const original = device.auth.getSession.bind(device.auth);
    let release!: () => void;
    let reach!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const reached = new Promise<void>((resolve) => { reach = resolve; });
    let holdOnce = true;
    device.auth.getSession = async () => {
      if (holdOnce) { holdOnce = false; reach(); await gate; }
      return original();
    };
    try {
      const stale = retireDevice();
      await reached;
      await signInOnDevice(emailB, playerA);
      // B's ordinary restoration finishes before A's older work resumes.
      expect(await registerDevice(PREFERENCES as never)).toEqual({ kind: "registered" });
      expect(tokenRow()).toEqual({ owner: "B", active: true });
      release();
      await stale;
    } finally {
      device.auth.getSession = original;
    }

    // The audit read { owner: B, active: false }.
    expect(tokenRow()).toEqual({ owner: "B", active: true });

    // Positive control: B's own retirement still works.
    await retireDevice();
    expect(tokenRow()).toEqual({ owner: "B", active: false });
  });

  it("completes a retirement already bound to A as A, and B's device stays B's", async () => {
    // A's registration is in flight when A's retirement binds and queues
    // behind it; the switch to B lands before either reaches the server's reply.
    await deviceIsA();
    let releaseResponse!: () => void;
    let reachResponse!: () => void;
    const responseGate = new Promise<void>((resolve) => { releaseResponse = resolve; });
    const responseReached = new Promise<void>((resolve) => { reachResponse = resolve; });
    heldResponse = { rpc: "register_push_token", reach: reachResponse, gate: responseGate };

    const registering = registerDevice(PREFERENCES as never);
    await responseReached;
    const retiring = retireDevice();
    await new Promise((resolve) => setTimeout(resolve, 50));
    await signInOnDevice(emailB, playerA);
    releaseResponse();
    await Promise.all([registering, retiring]);

    // A's registration landed, and A's departure completed after it, as A: A's
    // row is off. Refusing it would have left A's pushes on a device B holds.
    expect(tokenRow()).toEqual({ owner: "A", active: false });

    // B restores the device; A's finished departure cannot reach B's row.
    expect(await registerDevice(PREFERENCES as never)).toEqual({ kind: "registered" });
    expect(tokenRow()).toEqual({ owner: "B", active: true });
  });
});
