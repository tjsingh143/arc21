/**
 * B-G2 against the real backend: the newest notification choice is the one the
 * device's server registration keeps.
 *
 * The final independent Refresh-B re-audit (October 3, 2026) ran the ACTUAL
 * `setKind` from `app/settings/index.tsx` with the production Settings and push
 * stores, real supabase-js and the real `register_push_token`: notifications on
 * and registered, "Your turn" ON with that registration's native Expo token
 * response held, "Your turn" OFF written and acknowledged, then the first
 * released. Memory and disk said OFF; `push_tokens.allowed_kinds` contained
 * `your_turn` again. Only the native boundary was doubled — the OS permission,
 * a non-deliverable token and the EAS project id — and the SDK's auth methods
 * were untouched.
 *
 * This is that reproduction, inverted, plus its mirror image and an
 * uninterrupted control. The final allowlist is read out of Postgres. No push
 * is sent: this is registration state, not delivery.
 *
 * A SKIP IS NOT A PASS. `npm run test:server` sets ARC21_REQUIRE_SERVER_STACK.
 */

import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createClient, processLock } from "@supabase/supabase-js";

const native = vi.hoisted(() => ({ token: "", hold: null as null | { reach: () => void; gate: Promise<void> } }));
vi.mock("expo-notifications", () => ({
  getExpoPushTokenAsync: async () => {
    if (native.hold) {
      const held = native.hold;
      native.hold = null;
      held.reach();
      await held.gate;
    }
    return { data: native.token };
  },
  getPermissionsAsync: async () => ({ granted: true, canAskAgain: true }),
  requestPermissionsAsync: async () => ({ granted: true }),
  setNotificationChannelAsync: async () => undefined,
  setNotificationHandler: () => undefined,
  AndroidImportance: { HIGH: 4, DEFAULT: 3 },
}));
vi.mock("react-native", () => ({ Platform: { OS: "ios" } }));
vi.mock("expo-constants", () => ({
  default: { expoConfig: { extra: { eas: { projectId: "notification-ordering-fixture" } } }, sessionId: "notification-ordering-device" },
}));
// The Settings store pushes sound and haptics into their native adapters.
vi.mock("../../src/lib/audio/audio.js", () => ({ setSoundEnabled: () => undefined }));
vi.mock("../../src/lib/haptics/haptics.js", () => ({ setHapticsEnabled: () => undefined }));

const { stackUp } = await import("./stack-guard.js");
const { registerDevice } = await import("../../src/lib/notifications/push.js");
const { usePushRegistration } = await import("../../src/features/notifications/use-push-registration.js");
const { useSettingsStore, setSettingsPersistence } = await import("../../src/features/settings/use-settings.js");
const { SettingsPersistence, DEFAULT_SETTINGS } = await import("../../src/features/settings/settings.js");
const { capturePlayerScope } = await import("../../src/features/player/player-scope.js");
const { disposeAuthSubscription, setGuestIdentityStore, useAuthStore } = await import("../../src/features/auth/auth-store.js");
const { initialAuthFormState } = await import("../../src/features/auth/auth-machine.js");
const { GuestIdentityStore } = await import("../../src/features/auth/guest.js");
const { MemoryKeyValueStore } = await import("../../src/lib/persistence/key-value-store.js");
const { setSupabaseAvailabilityForTests } = await import("../../src/lib/supabase/client.js");
type ArcSupabaseClient = import("../../src/lib/supabase/client.js").ArcSupabaseClient;
type AppSettings = import("../../src/features/settings/settings.js").AppSettings;

const URL = "http://127.0.0.1:54321";
// Published local-only test keys, identical to the existing integration suites.
const ANON = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0";
const ADMIN_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU";

const admin = createClient(URL, ADMIN_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
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
}) as ArcSupabaseClient;

/** Readbacks straight from the database; THROWS when it cannot run. */
function database(sql: string): string {
  return execFileSync(
    "docker",
    ["exec", "supabase_db_arc21", "psql", "-U", "postgres", "-d", "postgres", "-X", "-v", "ON_ERROR_STOP=1", "-Atc", sql],
    { encoding: "utf8" },
  ).trim();
}

/** The device's server allowlist, from `push_tokens` itself. */
function serverKinds(): string[] {
  return JSON.parse(database(`select coalesce(to_json(allowed_kinds), '[]'::json)::text from public.push_tokens where token = '${native.token}'`)) as string[];
}

const disk = new MemoryKeyValueStore();
const persisted = new SettingsPersistence(disk);

/** `setKind` compiled from the Settings screen's source, its free names bound to the production stores. */
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

function holdTokenResponse(): { reached: Promise<void>; release: () => void } {
  let reach!: () => void;
  let release!: () => void;
  const reached = new Promise<void>((resolve) => { reach = resolve; });
  const gate = new Promise<void>((resolve) => { release = resolve; });
  native.hold = { reach, gate };
  return { reached, release };
}

/** Memory, disk, and the server's allowlist. */
async function views(): Promise<{ memory: boolean; disk: boolean; server: boolean }> {
  return {
    memory: useSettingsStore.getState().settings.notifyYourTurn,
    disk: (await persisted.load()).settings.notifyYourTurn,
    server: serverKinds().includes("your_turn"),
  };
}

/** Notifications on and this device registered, "Your turn" as given — the audit's starting point. */
async function registered(yourTurn: boolean): Promise<void> {
  const settings: AppSettings = { ...DEFAULT_SETTINGS, notificationsEnabled: true, notifyYourTurn: yourTurn };
  await persisted.save(settings);
  useSettingsStore.setState({ ready: true, settings, failure: null });
  expect(await registerDevice(settings)).toEqual({ kind: "registered" });
  usePushRegistration.setState({ registered: true, busy: false, unavailable: null });
  expect(await views()).toEqual({ memory: yourTurn, disk: yourTurn, server: yourTurn });
}

const created: string[] = [];
const email = `b-g2-${randomUUID()}@arc21.test`;
const password = `Ordering-${randomUUID()}-Aa1!`;
let player = "";

const suite = stackUp ? describe : describe.skip;

suite("B-G2: the server keeps the newest notification choice, whatever the token request's delay", () => {
  beforeAll(async () => {
    native.token = `ExponentPushToken[notification-ordering-${randomUUID()}]`;
    const result = await admin.auth.admin.createUser({ email, password, email_confirm: true });
    expect(result.error).toBeNull();
    player = result.data.user!.id;
    created.push(player);
    expect((await device.auth.signInWithPassword({ email, password })).error).toBeNull();

    setSupabaseAvailabilityForTests({ status: "ready", client: device });
    setGuestIdentityStore(new GuestIdentityStore(new MemoryKeyValueStore()));
    useAuthStore.setState({ hydrated: false, session: null, mode: "unknown", guest: null, form: initialAuthFormState("signIn") });
    await useAuthStore.getState().hydrate();
    expect(useAuthStore.getState().session?.account.userId).toBe(player);
    setSettingsPersistence(persisted);
  });

  afterAll(async () => {
    native.hold = null;
    setSettingsPersistence(null);
    disposeAuthSubscription();
    useAuthStore.setState({ session: null, mode: "guest" });
    setGuestIdentityStore(null);
    setSupabaseAvailabilityForTests(null);
    usePushRegistration.setState({ registered: false, busy: false, unavailable: null });
    await device.realtime.disconnect();
    database(`delete from public.push_tokens where token = '${native.token}'`);
    for (const id of created) {
      const result = await admin.auth.admin.deleteUser(id);
      expect(result.error).toBeNull();
    }
    expect(database(`select count(*) from public.push_tokens where token = '${native.token}'`)).toBe("0");
  });

  it("THE AUDIT'S REPRODUCTION: ON held, OFF acknowledged, ON released — Postgres, memory and disk all OFF", async () => {
    await registered(false);
    const setKind = setKindFromScreen();
    const held = holdTokenResponse();
    try {
      const older = setKind({ notifyYourTurn: true });
      await held.reached;
      await setKind({ notifyYourTurn: false });
      const beforeRelease = await views();
      held.release();
      await older;
      const afterRelease = await views();

      // The audit read `afterRelease.server: true`, `your_turn` back in `allowed_kinds`.
      expect({ beforeRelease, afterRelease }).toEqual({
        beforeRelease: { memory: false, disk: false, server: false },
        afterRelease: { memory: false, disk: false, server: false },
      });
      expect(database(`select user_id::text || ':' || is_active from public.push_tokens where token = '${native.token}'`)).toBe(`${player}:true`);
    } finally {
      held.release();
      native.hold = null;
    }
  });

  it("the mirror image: OFF held, ON acknowledged, OFF released — Postgres, memory and disk all ON", async () => {
    await registered(true);
    const setKind = setKindFromScreen();
    const held = holdTokenResponse();
    try {
      const older = setKind({ notifyYourTurn: false });
      await held.reached;
      await setKind({ notifyYourTurn: true });
      const beforeRelease = await views();
      held.release();
      await older;
      const afterRelease = await views();

      expect({ beforeRelease, afterRelease }).toEqual({
        beforeRelease: { memory: true, disk: true, server: true },
        afterRelease: { memory: true, disk: true, server: true },
      });
    } finally {
      held.release();
      native.hold = null;
    }
  });

  it("POSITIVE CONTROL: uninterrupted choices each reach Postgres in turn", async () => {
    await registered(false);
    const setKind = setKindFromScreen();

    await setKind({ notifyYourTurn: true });
    expect(await views()).toEqual({ memory: true, disk: true, server: true });
    await setKind({ notifyYourTurn: false });
    expect(await views()).toEqual({ memory: false, disk: false, server: false });
  });
});
