/**
 * Refresh-B blocker B-R5, on the wire: a departing player's retirement never
 * switches off the device registration of the player who replaced them.
 *
 * The push token belongs to the DEVICE, so after a switch the same token row is
 * the new player's, and `retire_push_token`'s `user_id = auth.uid()` check
 * cannot tell a stale retirement from a real one once it carries the new
 * player's credential. The final Astra audit held player A's retirement at its
 * session read (before storage was read), signed in as B, let B's normal
 * `registerDevice()` restore the device, then released A's retirement — and B's
 * row went `is_active: true → false`.
 *
 * Production `push.ts` through a real `@supabase/supabase-js` client and a
 * recording transport. Only the native boundary is doubled — OS permission, the
 * Expo token and the EAS project — exactly as in the audit's reproduction.
 * `tests/server/stale-identity-push.integration.test.ts` proves the same against
 * the real database.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { createClient } from "@supabase/supabase-js";

vi.mock("expo-notifications", () => ({
  getExpoPushTokenAsync: async () => ({ data: "ExponentPushToken[stale-retirement]" }),
  getPermissionsAsync: async () => ({ granted: true, canAskAgain: true }),
  requestPermissionsAsync: async () => ({ granted: true }),
  setNotificationChannelAsync: async () => undefined,
  setNotificationHandler: () => undefined,
  AndroidImportance: { HIGH: 4, DEFAULT: 3 },
}));
vi.mock("react-native", () => ({ Platform: { OS: "ios" } }));
vi.mock("expo-constants", () => ({
  default: { expoConfig: { extra: { eas: { projectId: "stale-retirement-test" } } }, sessionId: "test-device" },
}));

const { registerDevice, retireDevice } = await import("../../src/lib/notifications/push.js");
const { resetPlayerState } = await import("../../src/features/player/reset-player-state.js");
const { setSupabaseAvailabilityForTests } = await import("../../src/lib/supabase/client.js");
type ArcSupabaseClient = import("../../src/lib/supabase/client.js").ArcSupabaseClient;

const URL = "http://127.0.0.1:54321";
const STORAGE_KEY = "arc21-stale-push-test";
const PLAYER_A = "11111111-1111-4111-8111-111111111111";
const PLAYER_B = "22222222-2222-4222-8222-222222222222";
const PREFERENCES = {
  notificationsEnabled: true,
  friendRequests: true,
  privateTableInvites: true,
  yourTurn: true,
  tournamentResults: true,
  dailyChallengeReminder: true,
};

interface Sent {
  readonly rpc: string;
  readonly authorization: string | null;
}

function storedSession(userId: string, token: string): string {
  return JSON.stringify({
    access_token: token,
    token_type: "bearer",
    refresh_token: `refresh-${userId}`,
    expires_in: 3600,
    expires_at: Math.floor(Date.now() / 1000) + 3600,
    user: { id: userId, aud: "authenticated", role: "authenticated", app_metadata: {}, user_metadata: {}, created_at: "2026-01-01T00:00:00.000Z" },
  });
}

interface Harness {
  readonly sent: Sent[];
  signInAs(userId: string, token: string): void;
  /** Hold the next `getSession()` before it reads storage — the audit's injection. */
  holdNextSessionRead(): { reached: Promise<void>; release: () => void };
  /** Hold the next response to one RPC until released. */
  holdNextResponse(rpc: string): { reached: Promise<void>; release: () => void };
}

function harness(): Harness {
  const storage = new Map<string, string>([[STORAGE_KEY, storedSession(PLAYER_A, "token-a")]]);
  const sent: Sent[] = [];
  let responseHold: { rpc: string; reach: () => void; gate: Promise<void> } | null = null;
  const client = createClient(URL, "test-anon-key", {
    auth: {
      storageKey: STORAGE_KEY,
      flowType: "pkce",
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
        const path = new globalThis.URL(String(input instanceof Request ? input.url : input)).pathname;
        const rpc = path.replace("/rest/v1/rpc/", "");
        sent.push({ rpc, authorization: new Headers(init?.headers).get("Authorization") });
        if (responseHold?.rpc === rpc) {
          const held = responseHold;
          responseHold = null;
          held.reach();
          await held.gate;
        }
        return new Response("null", { status: 200, headers: { "content-type": "application/json" } });
      },
    },
  }) as ArcSupabaseClient;
  setSupabaseAvailabilityForTests({ status: "ready", client });

  const original = client.auth.getSession.bind(client.auth);
  let sessionHold: { reach: () => void; gate: Promise<void> } | null = null;
  client.auth.getSession = async () => {
    if (sessionHold) {
      const held = sessionHold;
      sessionHold = null;
      held.reach();
      await held.gate;
    }
    return original();
  };

  const gate = () => {
    let release!: () => void;
    let reach!: () => void;
    const released = new Promise<void>((resolve) => { release = resolve; });
    const reached = new Promise<void>((resolve) => { reach = resolve; });
    return { released, reached, release, reach };
  };

  return {
    sent,
    signInAs: (userId, token) => { storage.set(STORAGE_KEY, storedSession(userId, token)); },
    holdNextSessionRead: () => {
      const hold = gate();
      sessionHold = { reach: hold.reach, gate: hold.released };
      return { reached: hold.reached, release: hold.release };
    },
    holdNextResponse: (rpc) => {
      const hold = gate();
      responseHold = { rpc, reach: hold.reach, gate: hold.released };
      return { reached: hold.reached, release: hold.release };
    },
  };
}

const calls = (sent: readonly Sent[], rpc: string) =>
  sent.filter((request) => request.rpc === rpc).map((request) => request.authorization);

afterEach(() => {
  resetPlayerState();
  setSupabaseAvailabilityForTests(null);
});

describe("B-R5: a retirement is sent only as the departing player", () => {
  it("never retires the device the replacement player has just restored", async () => {
    const fixture = harness();
    expect(await registerDevice(PREFERENCES as never)).toEqual({ kind: "registered" });

    const hold = fixture.holdNextSessionRead();
    const stale = retireDevice();
    await hold.reached;

    // The switch, then B's ordinary restoration — both complete first.
    fixture.signInAs(PLAYER_B, "token-b");
    resetPlayerState();
    expect(await registerDevice(PREFERENCES as never)).toEqual({ kind: "registered" });

    hold.release();
    await stale;

    // Before the repair: `retire_push_token` carrying `Bearer token-b`.
    expect(calls(fixture.sent, "retire_push_token")).toEqual([]);
    expect(calls(fixture.sent, "register_push_token")).toEqual(["Bearer token-a", "Bearer token-b"]);
  });

  it("completes a retirement already bound to the departing player as that player, even behind another device write", async () => {
    const fixture = harness();
    // A's registration is on the wire; A's retirement binds and queues behind it.
    const inFlight = fixture.holdNextResponse("register_push_token");
    const registering = registerDevice(PREFERENCES as never);
    await inFlight.reached;
    const retiring = retireDevice();
    // Let the retirement bind as A and reach the device queue.
    await new Promise((resolve) => setTimeout(resolve, 20));

    fixture.signInAs(PLAYER_B, "token-b");
    resetPlayerState();
    const restoring = registerDevice(PREFERENCES as never);
    inFlight.release();
    await Promise.all([registering, retiring, restoring]);

    /*
     * The departure completes, as A: the server confines it to A's own row, so
     * it cannot switch off B's — and B's restoration, queued behind it, runs
     * last. Refusing it here would leave A's registration active on a device B
     * now holds, because A's in-flight registration had already landed.
     */
    expect(fixture.sent.map((request) => `${request.rpc} ${request.authorization}`)).toEqual([
      "register_push_token Bearer token-a",
      "retire_push_token Bearer token-a",
      "register_push_token Bearer token-b",
    ]);
  });

  it("retires the departing player's own device, in order, before the next player registers it", async () => {
    // The positive control, and the normal departure: `preparePlayerDeparture`
    // retires as A and only then does the sign-in hand the device to B.
    const fixture = harness();
    expect(await registerDevice(PREFERENCES as never)).toEqual({ kind: "registered" });
    await retireDevice();

    fixture.signInAs(PLAYER_B, "token-b");
    resetPlayerState();
    expect(await registerDevice(PREFERENCES as never)).toEqual({ kind: "registered" });

    expect(fixture.sent.map((request) => `${request.rpc} ${request.authorization}`)).toEqual([
      "register_push_token Bearer token-a",
      "retire_push_token Bearer token-a",
      "register_push_token Bearer token-b",
    ]);
  });
});
