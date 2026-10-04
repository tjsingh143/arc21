/**
 * B-G2 — the newest notification choice is the one the server keeps.
 *
 * The final independent Refresh-B re-audit (October 3, 2026) ran the ACTUAL
 * `setKind` handler from `app/settings/index.tsx` with notifications on and the
 * device registered, turned "Your turn" ON and held that registration's native
 * Expo token request, turned it OFF and let that registration be written and
 * acknowledged, then released the first. Memory and disk both said OFF; the
 * server's `push_tokens.allowed_kinds` said ON again. The registration captured
 * its preferences before several awaits, and the device lane orders WRITES, so
 * the older snapshot entered the lane last and committed last.
 *
 * Here: the same extracted handler, the production Settings store (with its
 * ordered disk saves over an in-memory key-value store), the production push
 * registration store and `push.ts`, and a real `@supabase/supabase-js` client
 * whose PostgREST is a recording model of `register_push_token` — an upsert
 * whose last write wins, as the real one is. Only the native boundary is
 * doubled: the OS permission, the Expo token and the EAS project id.
 * `tests/server/notification-ordering.integration.test.ts` reads the final
 * allowlist out of the real database.
 */

import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createClient } from "@supabase/supabase-js";

/** One native call can be held at a time: the registration's permission read or its token request. */
const native = vi.hoisted(() => ({
  hold: null as null | { at: "permission" | "token"; reach: () => void; gate: Promise<void> },
}));

async function heldAt(at: "permission" | "token"): Promise<void> {
  if (native.hold?.at !== at) return;
  const held = native.hold;
  native.hold = null;
  held.reach();
  await held.gate;
}

vi.mock("expo-notifications", () => ({
  getExpoPushTokenAsync: async () => {
    await heldAt("token");
    return { data: "ExponentPushToken[registration-ordering]" };
  },
  getPermissionsAsync: async () => {
    await heldAt("permission");
    return { granted: true, canAskAgain: true };
  },
  requestPermissionsAsync: async () => ({ granted: true }),
  setNotificationChannelAsync: async () => undefined,
  setNotificationHandler: () => undefined,
  AndroidImportance: { HIGH: 4, DEFAULT: 3 },
}));
vi.mock("react-native", () => ({ Platform: { OS: "ios" } }));
vi.mock("expo-constants", () => ({
  default: { expoConfig: { extra: { eas: { projectId: "registration-ordering-test" } } }, sessionId: "test-device" },
}));
// The Settings store pushes sound and haptics into their native adapters.
vi.mock("../../src/lib/audio/audio.js", () => ({ setSoundEnabled: () => undefined }));
vi.mock("../../src/lib/haptics/haptics.js", () => ({ setHapticsEnabled: () => undefined }));

const { registerDevice } = await import("../../src/lib/notifications/push.js");
const { usePushRegistration } = await import("../../src/features/notifications/use-push-registration.js");
const { allowedKinds } = await import("../../src/features/notifications/notifications.js");
const { useSettingsStore, setSettingsPersistence } = await import("../../src/features/settings/use-settings.js");
const { SettingsPersistence, DEFAULT_SETTINGS } = await import("../../src/features/settings/settings.js");
const { capturePlayerScope } = await import("../../src/features/player/player-scope.js");
const { setSupabaseAvailabilityForTests } = await import("../../src/lib/supabase/client.js");
const { MemoryKeyValueStore } = await import("../../src/lib/persistence/key-value-store.js");
type ArcSupabaseClient = import("../../src/lib/supabase/client.js").ArcSupabaseClient;
type AppSettings = import("../../src/features/settings/settings.js").AppSettings;

const URL = "http://127.0.0.1:54321";
const STORAGE_KEY = "arc21-registration-ordering-test";
const PLAYER = "33333333-3333-4333-8333-333333333333";

/** The server's view of this device: the allowlist each write left, in arrival order. */
const database = { allowlist: null as string[] | null, writes: [] as string[][] };

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
        if (url.pathname === "/rest/v1/rpc/register_push_token") {
          // `insert … on conflict (token) do update set allowed_kinds = excluded.allowed_kinds`.
          const kinds = (JSON.parse(String(init?.body)) as { p_kinds: string[] }).p_kinds;
          database.allowlist = kinds;
          database.writes.push(kinds);
          return new Response(null, { status: 204 });
        }
        return new Response(JSON.stringify(null), { status: 200, headers: { "content-type": "application/json" } });
      },
    },
  }) as ArcSupabaseClient;
}

const disk = new MemoryKeyValueStore();
const persisted = new SettingsPersistence(disk);

/**
 * `setKind` exactly as the Settings screen defines it, compiled from the screen
 * source (the audit's method), with its free names bound to the production
 * stores. `useSettingsStore` stays bound so an earlier version of the handler,
 * which read it, compiles the same way.
 */
function setKindFromScreen(): (patch: Partial<AppSettings>) => Promise<void> {
  const source = readFileSync(new globalThis.URL("../../app/settings/index.tsx", import.meta.url), "utf8");
  const file = ts.createSourceFile("index.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let handler = "";
  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && node.name.getText(file) === "setKind") handler = `const ${node.getText(file)};`;
    ts.forEachChild(node, visit);
  };
  visit(file);
  expect(handler).not.toBe("");
  const js = ts.transpileModule(`${handler}\nglobalThis.handler = setKind;`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  const context = vm.createContext({
    capturePlayerScope,
    useSettingsStore,
    update: (patch: Partial<AppSettings>) => useSettingsStore.getState().update(patch),
    sync: (...args: unknown[]) => (usePushRegistration.getState().sync as (...a: unknown[]) => Promise<void>)(...args),
    applyDailyReminderPreference: async () => undefined,
  });
  new vm.Script(js).runInContext(context);
  return context.handler as (patch: Partial<AppSettings>) => Promise<void>;
}

function hold(at: "permission" | "token"): { reached: Promise<void>; release: () => void } {
  let reach!: () => void;
  let release!: () => void;
  const reached = new Promise<void>((resolve) => { reach = resolve; });
  const gate = new Promise<void>((resolve) => { release = resolve; });
  native.hold = { at, reach, gate };
  return { reached, release };
}

/** Memory, disk, and the server's allowlist: the three views that must agree once everything has settled. */
async function views(): Promise<{ memory: boolean; disk: boolean; server: boolean }> {
  return {
    memory: useSettingsStore.getState().settings.notifyYourTurn,
    disk: (await persisted.load()).settings.notifyYourTurn,
    server: database.allowlist?.includes("your_turn") ?? false,
  };
}

/** A device with notifications on and registered, "Your turn" as given — the audit's starting point. */
async function registeredDevice(yourTurn: boolean): Promise<void> {
  const settings: AppSettings = { ...DEFAULT_SETTINGS, notificationsEnabled: true, notifyYourTurn: yourTurn };
  await persisted.save(settings);
  useSettingsStore.setState({ ready: true, settings, failure: null });
  expect(await registerDevice(settings)).toEqual({ kind: "registered" });
  usePushRegistration.setState({ registered: true, busy: false, unavailable: null });
  expect(await views()).toEqual({ memory: yourTurn, disk: yourTurn, server: yourTurn });
  database.writes = [];
}

beforeEach(() => {
  database.allowlist = null;
  database.writes = [];
  native.hold = null;
  setSupabaseAvailabilityForTests({ status: "ready", client: client() });
  setSettingsPersistence(persisted);
});

afterEach(() => {
  native.hold = null;
  setSettingsPersistence(null);
  setSupabaseAvailabilityForTests(null);
  usePushRegistration.setState({ registered: false, busy: false, unavailable: null });
});

describe("B-G2: the server keeps the newest choice, whichever registration arrives last", () => {
  it.each(["token", "permission"] as const)(
    "THE AUDIT'S REPRODUCTION: ON held at the %s, OFF acknowledged, ON released — memory, disk and server all OFF",
    async (at) => {
      await registeredDevice(false);
      const setKind = setKindFromScreen();

      const held = hold(at);
      const older = setKind({ notifyYourTurn: true });
      await held.reached;
      await setKind({ notifyYourTurn: false });
      // The audit's `beforeRelease`: the newer choice is on the server.
      expect(await views()).toEqual({ memory: false, disk: false, server: false });

      held.release();
      await older;

      // The audit's `afterRelease` read `server: true` here.
      expect(await views()).toEqual({ memory: false, disk: false, server: false });
      expect(database.allowlist).toEqual(allowedKinds(useSettingsStore.getState().settings));
      // The released registration still wrote — it was not silently dropped —
      // and what it wrote was the newest choice, not its own tap's.
      expect(database.writes.at(-1)).not.toContain("your_turn");
      expect(database.writes.length).toBeGreaterThanOrEqual(2);
    },
  );

  it.each(["token", "permission"] as const)(
    "the mirror image: OFF held at the %s, ON acknowledged, OFF released — memory, disk and server all ON",
    async (at) => {
      await registeredDevice(true);
      const setKind = setKindFromScreen();

      const held = hold(at);
      const older = setKind({ notifyYourTurn: false });
      await held.reached;
      await setKind({ notifyYourTurn: true });
      expect(await views()).toEqual({ memory: true, disk: true, server: true });

      held.release();
      await older;

      expect(await views()).toEqual({ memory: true, disk: true, server: true });
      expect(database.allowlist).toEqual(allowedKinds(useSettingsStore.getState().settings));
    },
  );

  it("a restore handed the preferences of its moment, then delayed, does not write them over a newer choice", async () => {
    await registeredDevice(true);
    const setKind = setKindFromScreen();
    const momentOfRestore = useSettingsStore.getState().settings;

    const held = hold("token");
    // An identity change restores the registration; callers once passed a copy.
    const restoring = (usePushRegistration.getState().restore as (preferences?: AppSettings) => Promise<void>)(momentOfRestore);
    await held.reached;
    await setKind({ notifyYourTurn: false });
    held.release();
    await restoring;

    expect(await views()).toEqual({ memory: false, disk: false, server: false });
  });

  it("POSITIVE CONTROL: uninterrupted choices each reach the server in turn", async () => {
    await registeredDevice(false);
    const setKind = setKindFromScreen();

    await setKind({ notifyYourTurn: true });
    expect(await views()).toEqual({ memory: true, disk: true, server: true });
    await setKind({ notifyYourTurn: false });
    expect(await views()).toEqual({ memory: false, disk: false, server: false });
    await setKind({ notifyFriendRequests: true });
    expect(database.allowlist).toEqual(allowedKinds(useSettingsStore.getState().settings));
    expect(database.writes).toHaveLength(3);
  });

  it("POSITIVE CONTROL: turning push on registers the kinds being switched on, before Settings records them", async () => {
    const settings: AppSettings = { ...DEFAULT_SETTINGS, notificationsEnabled: false, notifyYourTurn: true };
    useSettingsStore.setState({ ready: true, settings, failure: null });
    usePushRegistration.setState({ registered: false, busy: false, unavailable: null });

    // The master switch's own path: `enable` names the preferences it registers,
    // because Settings records `notificationsEnabled` only once this succeeds.
    expect(await usePushRegistration.getState().enable("settings-toggle", { ...settings, notificationsEnabled: true })).toBe(true);
    expect(useSettingsStore.getState().settings.notificationsEnabled).toBe(false);
    expect(database.allowlist).toEqual(allowedKinds({ ...settings, notificationsEnabled: true }));
    expect(database.allowlist).toContain("your_turn");
  });
});
