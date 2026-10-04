/**
 * B-H2 and B-H4 at the wire — the newest notification intent is the only one
 * that can take effect, and nothing a notification flow does can restore an
 * unrelated Setting.
 *
 * The final independent Refresh-B re-audit (October 4, 2026) found:
 *
 *  - B-H2: an offer captured the whole Settings record, awaited the OS
 *    permission read, registered its own snapshot, and returned that snapshot
 *    for its caller to save. Overtaken meanwhile by "Friends: off" and "Only
 *    me", it put both back — Friends ON, privacy PUBLIC — on disk and on the
 *    server.
 *  - B-H4: the device lane orders writes on the device, and a write the server
 *    accepted can still commit after a newer one if its connection fails.
 *
 * Here: the production Settings store (ordered saves over an in-memory store),
 * the production push-registration store and `push.ts`, a real
 * `@supabase/supabase-js` client, and a PostgREST double that applies the SAME
 * rule `register_push_token` / `retire_push_token` now apply in Postgres — a
 * write is applied only if its revision is newer than the row's. Only the
 * native boundary is doubled. `tests/server/notification-intent-order.integration.test.ts`
 * runs the real database and a real lost connection.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createClient } from "@supabase/supabase-js";

const native = vi.hoisted(() => ({
  permission: "granted" as "granted" | "undetermined",
  permissionHold: null as null | { reach: () => void; gate: Promise<void>; answer: { granted: boolean; canAskAgain: boolean } },
}));

vi.mock("expo-notifications", () => ({
  getExpoPushTokenAsync: async () => ({ data: "ExponentPushToken[notification-intent]" }),
  getPermissionsAsync: async () => {
    if (native.permissionHold) {
      const held = native.permissionHold;
      native.permissionHold = null;
      held.reach();
      await held.gate;
      return held.answer;
    }
    return { granted: native.permission === "granted", canAskAgain: true };
  },
  requestPermissionsAsync: async () => {
    native.permission = "granted";
    return { granted: true };
  },
  setNotificationChannelAsync: async () => undefined,
  setNotificationHandler: () => undefined,
  AndroidImportance: { HIGH: 4, DEFAULT: 3 },
}));
vi.mock("react-native", () => ({ Platform: { OS: "ios" } }));
vi.mock("expo-constants", () => ({
  default: { expoConfig: { extra: { eas: { projectId: "notification-intent-test" } } }, sessionId: "test-device" },
}));
vi.mock("../../src/lib/audio/audio.js", () => ({ setSoundEnabled: () => undefined }));
vi.mock("../../src/lib/haptics/haptics.js", () => ({ setHapticsEnabled: () => undefined }));

const { registerDevice, setPushRevisionStore } = await import("../../src/lib/notifications/push.js");
const { usePushRegistration } = await import("../../src/features/notifications/use-push-registration.js");
const { useSettingsStore, setSettingsPersistence } = await import("../../src/features/settings/use-settings.js");
const { SettingsPersistence, DEFAULT_SETTINGS } = await import("../../src/features/settings/settings.js");
const { setSupabaseAvailabilityForTests } = await import("../../src/lib/supabase/client.js");
const { MemoryKeyValueStore } = await import("../../src/lib/persistence/key-value-store.js");
type ArcSupabaseClient = import("../../src/lib/supabase/client.js").ArcSupabaseClient;
type AppSettings = import("../../src/features/settings/settings.js").AppSettings;

const URL = "http://127.0.0.1:54321";
const STORAGE_KEY = "arc21-notification-intent-test";
const PLAYER = "44444444-4444-4444-8444-444444444444";
const REVISION_KEY = "push:intent-revision:v1";

/** The device's row as Postgres keeps it, under the new ordering rule. */
const row = {
  kinds: null as string[] | null,
  active: false,
  revision: 0,
  /** Every request that reached the server, with its revision and whether it was applied. */
  requests: [] as { rpc: string; revision: number; applied: boolean; kinds?: string[] }[],
  /** Holds the NEXT write before it is applied, the way a slow server would. */
  hold: null as null | { reach: () => void; gate: Promise<void> },
  /** The persisted revision at the moment each request arrived. */
  persistedAtArrival: [] as (string | null)[],
  /** The next write's own revision is already applied — its earlier delivery committed and the reply was lost. */
  alreadyApplied: false,
};
const revisions = new MemoryKeyValueStore();

function client(): ArcSupabaseClient {
  const storage = new Map<string, string>([[STORAGE_KEY, JSON.stringify({
    access_token: "token-player",
    token_type: "bearer",
    refresh_token: "refresh-player",
    expires_in: 3600,
    expires_at: Math.floor(Date.now() / 1000) + 3600,
    user: { id: PLAYER, aud: "authenticated", role: "authenticated", app_metadata: {}, user_metadata: {}, created_at: "2026-01-01T00:00:00.000Z" },
  })]]);
  return createClient(URL, "test-anon-key", {
    auth: {
      storageKey: STORAGE_KEY,
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
        const url = new globalThis.URL(String(input instanceof Request ? input.url : input));
        const rpc = url.pathname.replace("/rest/v1/rpc/", "");
        if (rpc === "register_push_token" || rpc === "retire_push_token") {
          const body = JSON.parse(String(init?.body)) as { p_kinds?: string[]; p_revision: number };
          row.persistedAtArrival.push(await revisions.get(REVISION_KEY));
          if (row.hold) {
            const held = row.hold;
            row.hold = null;
            held.reach();
            await held.gate;
          }
          if (row.alreadyApplied) {
            row.alreadyApplied = false;
            row.revision = body.p_revision;
          }
          const applied = body.p_revision > row.revision;
          row.requests.push({ rpc, revision: body.p_revision, applied, ...(body.p_kinds ? { kinds: body.p_kinds } : {}) });
          if (applied) {
            row.revision = body.p_revision;
            row.kinds = rpc === "register_push_token" ? body.p_kinds ?? [] : [];
            row.active = rpc === "register_push_token";
          }
          return new Response(JSON.stringify({ applied, revision: row.revision }), { status: 200, headers: { "content-type": "application/json" } });
        }
        return new Response(JSON.stringify(null), { status: 200, headers: { "content-type": "application/json" } });
      },
    },
  }) as ArcSupabaseClient;
}

const disk = new MemoryKeyValueStore();
const persisted = new SettingsPersistence(disk);

function hold<T extends { reach: () => void; gate: Promise<void> }>(extra: Omit<T, "reach" | "gate"> = {} as Omit<T, "reach" | "gate">): { slot: T; reached: Promise<void>; release: () => void } {
  let reach!: () => void;
  let release!: () => void;
  const reached = new Promise<void>((resolve) => { reach = resolve; });
  const gate = new Promise<void>((resolve) => { release = resolve; });
  return { slot: { ...extra, reach, gate } as T, reached, release };
}

async function startWith(settings: AppSettings, registered: boolean): Promise<void> {
  await persisted.save(settings);
  useSettingsStore.setState({ ready: true, settings, failure: null });
  usePushRegistration.setState({ registered, busy: false, unavailable: null });
}

beforeEach(() => {
  native.permission = "granted";
  native.permissionHold = null;
  Object.assign(row, { kinds: null, active: false, revision: 0, requests: [], hold: null, persistedAtArrival: [], alreadyApplied: false });
  setSupabaseAvailabilityForTests({ status: "ready", client: client() });
  setSettingsPersistence(persisted);
  setPushRevisionStore(revisions);
});

afterEach(() => {
  native.permissionHold = null;
  row.hold = null;
  setSettingsPersistence(null);
  setSupabaseAvailabilityForTests(null);
  setPushRevisionStore(null);
  usePushRegistration.setState({ registered: false, busy: false, unavailable: null });
});

describe("B-H2: an offer carries a patch and an intent, never a Settings snapshot", () => {
  it("THE AUDIT'S REPRODUCTION, inverted: an offer overtaken by newer choices writes nothing and restores neither Friends nor privacy", async () => {
    await startWith({ ...DEFAULT_SETTINGS, statsVisibility: "public" }, false);
    native.permission = "undetermined";
    const held = hold<{ reach: () => void; gate: Promise<void>; answer: { granted: boolean; canAskAgain: boolean } }>({ answer: { granted: false, canAskAgain: true } });
    native.permissionHold = held.slot;
    const offering = usePushRegistration.getState().offer("accepted-friend-request");
    await held.reached;

    // Settings, meanwhile: notifications on, Friends ON then OFF, "Only me".
    expect(await usePushRegistration.getState().enable("settings-toggle", { notificationsEnabled: true })).toBe(true);
    await useSettingsStore.getState().update({ notificationsEnabled: true });
    await useSettingsStore.getState().update({ notifyFriendRequests: true });
    await usePushRegistration.getState().sync();
    await useSettingsStore.getState().update({ notifyFriendRequests: false });
    await usePushRegistration.getState().sync();
    await useSettingsStore.getState().update({ statsVisibility: "private" });
    const writesBefore = row.requests.length;

    held.release();
    expect(await offering).toBe(false);

    expect(row.requests).toHaveLength(writesBefore);
    expect(row.kinds).not.toContain("friend_request");
    expect(useSettingsStore.getState().settings).toMatchObject({ notifyFriendRequests: false, statsVisibility: "private" });
    expect((await persisted.load()).settings).toMatchObject({ notifyFriendRequests: false, statsVisibility: "private" });
  });

  it("a current offer records ONLY its own keys, into Settings as they stand: a privacy choice made meanwhile survives", async () => {
    await startWith({ ...DEFAULT_SETTINGS, statsVisibility: "public" }, false);
    native.permission = "undetermined";
    const held = hold<{ reach: () => void; gate: Promise<void>; answer: { granted: boolean; canAskAgain: boolean } }>({ answer: { granted: false, canAskAgain: true } });
    native.permissionHold = held.slot;
    const offering = usePushRegistration.getState().offer("accepted-friend-request");
    await held.reached;
    await useSettingsStore.getState().update({ statsVisibility: "private" });

    held.release();
    expect(await offering).toBe(true);

    expect(useSettingsStore.getState().settings).toMatchObject({ notificationsEnabled: true, notifyFriendRequests: true, statsVisibility: "private" });
    expect((await persisted.load()).settings).toMatchObject({ notificationsEnabled: true, notifyFriendRequests: true, statsVisibility: "private" });
    expect(row.kinds).toContain("friend_request");
  });

  it("an offer whose write is in flight when notifications are turned off ends with the device retired, not registered", async () => {
    await startWith({ ...DEFAULT_SETTINGS }, false);
    native.permission = "undetermined";
    const held = hold();
    row.hold = held.slot;
    const offering = usePushRegistration.getState().offer("entered-tournament");
    await held.reached;
    // A newer explicit choice while the offer's registration is on the wire.
    await useSettingsStore.getState().update({ notificationsEnabled: false });

    held.release();
    expect(await offering).toBe(false);

    expect(useSettingsStore.getState().settings.notificationsEnabled).toBe(false);
    expect(row).toMatchObject({ active: false, kinds: [] });
    expect(row.requests.map((request) => request.rpc)).toEqual(["register_push_token", "retire_push_token"]);
  });

  it("an offer does nothing before Settings have been read off disk", async () => {
    useSettingsStore.setState({ ready: false, settings: { ...DEFAULT_SETTINGS }, failure: null });
    native.permission = "undetermined";
    expect(await usePushRegistration.getState().offer("accepted-friend-request")).toBe(false);
    expect(row.requests).toEqual([]);
  });

  it("enable registers only notification keys of whatever it is handed, and leaves recording to its caller", async () => {
    await startWith({ ...DEFAULT_SETTINGS, statsVisibility: "private" }, false);
    const stale: AppSettings = { ...DEFAULT_SETTINGS, statsVisibility: "public", notificationsEnabled: true, notifyYourTurn: true };
    expect(await usePushRegistration.getState().enable("settings-toggle", stale)).toBe(true);
    expect(row.kinds).toContain("your_turn");
    expect(useSettingsStore.getState().settings).toMatchObject({ notificationsEnabled: false, statsVisibility: "private" });
  });
});

describe("B-H4: every device write carries a newer revision than the last, persisted before it is sent", () => {
  it("revisions strictly increase across registrations and retirements, and each is on disk before its request arrives", async () => {
    const settings: AppSettings = { ...DEFAULT_SETTINGS, notificationsEnabled: true, notifyYourTurn: true };
    await startWith(settings, true);
    expect(await registerDevice(settings)).toEqual({ kind: "registered" });
    await usePushRegistration.getState().sync();
    await usePushRegistration.getState().disable();
    expect(await registerDevice(settings)).toEqual({ kind: "registered" });

    const sent = row.requests.map((request) => request.revision);
    expect(sent).toHaveLength(4);
    expect(sent.every((revision, index) => index === 0 || revision > sent[index - 1]!)).toBe(true);
    expect(row.persistedAtArrival).toEqual(sent.map(String));
    expect(row.requests.every((request) => request.applied)).toBe(true);
  });

  it("a restarted process continues ABOVE the revision it persisted, even with the clock set back", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(new Date("2026-10-04T12:00:00Z"));
      const ahead = Date.now() + 10_000_000;
      await revisions.set(REVISION_KEY, String(ahead));
      setPushRevisionStore(revisions);
      const settings: AppSettings = { ...DEFAULT_SETTINGS, notificationsEnabled: true };
      await startWith(settings, true);
      expect(await registerDevice(settings)).toEqual({ kind: "registered" });
      expect(row.requests[0]!.revision).toBe(ahead + 1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a row already holding a NEWER revision (a reinstall): the newest intent is re-sent once above it and applied", async () => {
    const settings: AppSettings = { ...DEFAULT_SETTINGS, notificationsEnabled: true, notifyFriendRequests: true };
    await startWith(settings, true);
    row.revision = Date.now() + 50_000_000;
    expect(await registerDevice(settings)).toEqual({ kind: "registered" });

    expect(row.requests).toHaveLength(2);
    expect(row.requests[0]).toMatchObject({ applied: false });
    expect(row.requests[1]).toMatchObject({ applied: true });
    expect(row.requests[1]!.revision).toBeGreaterThan(row.requests[0]!.revision);
    expect(row.kinds).toContain("friend_request");
  });

  it("the same revision answered as already applied (a replay) is success, and is not sent again", async () => {
    const settings: AppSettings = { ...DEFAULT_SETTINGS, notificationsEnabled: true };
    await startWith(settings, true);
    row.alreadyApplied = true;
    expect(await registerDevice(settings)).toEqual({ kind: "registered" });
    expect(row.requests).toHaveLength(1);
    expect(row.requests[0]).toMatchObject({ applied: false, revision: row.revision });
  });
});
