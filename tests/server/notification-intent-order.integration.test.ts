/**
 * B-H2 and B-H4 against the real PostgREST and Postgres: the newest
 * notification intent is what the database keeps, and nothing a notification
 * flow does can restore an unrelated Setting.
 *
 * The final independent Refresh-B re-audit (October 4, 2026):
 *
 *  - B-H4: with a device registered, "Your turn" ON was sent through a proxy
 *    that accepted the whole request, kept its work queued and dropped the
 *    client connection. The app reported "Could not register this device", its
 *    device lane moved on, "Your turn" OFF was written and acknowledged — and
 *    the queued ON, released, got 204 from PostgREST. Memory OFF, disk OFF,
 *    database ON. Ordering writes on the device cannot order work that has
 *    already left it.
 *  - B-H2: a friend-acceptance notification offer held at its OS permission
 *    read, while the player enabled notifications, turned Friends ON then OFF
 *    and chose "Only me"; released, the old offer registered its own snapshot
 *    (server Friends ON) and the caller saved the WHOLE returned snapshot —
 *    Friends ON everywhere, and `profiles.privacy` private → PUBLIC.
 *
 * Here: those reproductions inverted, and the other orderings the repair must
 * hold. The ACTUAL `setKind` and `setMaster` handlers are compiled from
 * `app/settings/index.tsx` and the actual offer caller from
 * `app/(tabs)/social.tsx` (the audit's method); the production Auth, Settings
 * and push-registration stores, `push.ts`, real supabase-js and the real RPCs
 * run underneath. Only the native boundary is doubled — the OS permission, a
 * non-deliverable Expo token and the EAS project id. The proxy models accepted
 * server work outliving its client; it never invents a database answer. Every
 * verdict is read out of Postgres. No push is sent.
 *
 * A SKIP IS NOT A PASS. `npm run test:server` sets ARC21_REQUIRE_SERVER_STACK.
 */

import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createClient, processLock } from "@supabase/supabase-js";

const native = vi.hoisted(() => ({
  token: "",
  permission: "granted" as "granted" | "undetermined",
  /** Holds ONE permission-status read and answers it with what the OS said at the time it was asked. */
  permissionHold: null as null | { reach: () => void; gate: Promise<void>; answer: { granted: boolean; canAskAgain: boolean } },
}));

vi.mock("expo-notifications", () => ({
  getExpoPushTokenAsync: async () => ({ data: native.token }),
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
  default: { expoConfig: { extra: { eas: { projectId: "notification-intent-order-fixture" } } }, sessionId: "notification-intent-order-device" },
}));
// The Settings store pushes sound and haptics into their native adapters.
vi.mock("../../src/lib/audio/audio.js", () => ({ setSoundEnabled: () => undefined }));
vi.mock("../../src/lib/haptics/haptics.js", () => ({ setHapticsEnabled: () => undefined }));

const { stackUp } = await import("./stack-guard.js");
const { registerDevice, setPushRevisionStore } = await import("../../src/lib/notifications/push.js");
const { usePushRegistration } = await import("../../src/features/notifications/use-push-registration.js");
const { useSettingsStore, setSettingsPersistence } = await import("../../src/features/settings/use-settings.js");
const { SettingsPersistence, DEFAULT_SETTINGS } = await import("../../src/features/settings/settings.js");
const { reconcileProfilePrivacy } = await import("../../src/features/settings/use-profile-privacy-sync.js");
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
const PUSH_RPCS = new Set(["/rest/v1/rpc/register_push_token", "/rest/v1/rpc/retire_push_token"]);

const admin = createClient(URL, ADMIN_KEY, { auth: { persistSession: false, autoRefreshToken: false } });

// ---------------------------------------------------------------------------
// The proxy: what the server's side of a connection can do that the client
// never learns about. It never answers for the database.
// ---------------------------------------------------------------------------

/** One request exactly as it left the device: enough to send it again, byte for byte. */
interface RawRequest {
  readonly path: string;
  readonly method: string;
  readonly headers: Headers;
  readonly body: string;
}

type ProxyMode =
  /** Forward and answer. */
  | "forward"
  /** Accept the whole request, queue its work, drop the client connection: B-H4's shape. */
  | "accept-then-drop"
  /** Forward (the server commits), then drop the client connection instead of answering: a lost reply. */
  | "commit-then-drop";

const proxy = {
  port: 0,
  server: null as Server | null,
  /** The mode for the NEXT push request only; then back to forwarding. */
  next: "forward" as ProxyMode,
  queued: [] as RawRequest[],
  seen: [] as RawRequest[],
};

const send = (raw: RawRequest): Promise<Response> =>
  fetch(`${URL}${raw.path}`, { method: raw.method, headers: raw.headers, body: raw.body });

async function readRaw(request: IncomingMessage): Promise<RawRequest> {
  let body = "";
  for await (const chunk of request) body += String(chunk);
  const headers = new Headers();
  for (const [name, value] of Object.entries(request.headers)) {
    if (value !== undefined && !["host", "connection", "content-length"].includes(name)) {
      headers.set(name, Array.isArray(value) ? value.join(",") : value);
    }
  }
  return { path: request.url ?? "/", method: request.method ?? "POST", headers, body };
}

async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const raw = await readRaw(request);
  proxy.seen.push(raw);
  const mode = proxy.next;
  proxy.next = "forward";
  if (mode === "accept-then-drop") {
    proxy.queued.push(raw);
    request.socket.destroy();
    return;
  }
  const answer = await send(raw);
  if (mode === "commit-then-drop") {
    request.socket.destroy();
    return;
  }
  response.writeHead(answer.status, Object.fromEntries(answer.headers));
  response.end(Buffer.from(await answer.arrayBuffer()));
}

// ---------------------------------------------------------------------------
// The device
// ---------------------------------------------------------------------------

const storage = new Map<string, string>();
const device = createClient(URL, ANON, {
  global: {
    fetch: (input, init) => {
      const path = new globalThis.URL(String(input)).pathname;
      return fetch(proxy.port && PUSH_RPCS.has(path) ? `http://127.0.0.1:${proxy.port}${path}` : input, init);
    },
  },
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

const disk = new MemoryKeyValueStore();
const persisted = new SettingsPersistence(disk);

/** Readbacks straight from the database; THROWS when it cannot run. */
function database(sql: string): string {
  return execFileSync(
    "docker",
    ["exec", "supabase_db_arc21", "psql", "-U", "postgres", "-d", "postgres", "-X", "-v", "ON_ERROR_STOP=1", "-Atc", sql],
    { encoding: "utf8" },
  ).trim();
}

/** The device's row: allowlist, active flag and the revision it holds. */
function row(): { kinds: string[]; active: boolean; revision: number } {
  const value = database(
    `select json_build_object('kinds', to_json(allowed_kinds), 'active', is_active, 'revision', intent_revision)::text
     from public.push_tokens where token = '${native.token}'`,
  );
  return JSON.parse(value) as { kinds: string[]; active: boolean; revision: number };
}

/**
 * A handler compiled from a screen's source, its free names bound to the
 * production stores — the audit's method, so the test runs the code the screen
 * runs. `useCallback(fn, deps)` is unwrapped to `fn`.
 */
function handlerFromScreen<T>(file: string, name: string, bindings: Record<string, unknown>): T {
  const source = readFileSync(new globalThis.URL(`../../${file}`, import.meta.url), "utf8");
  const parsed = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let handler = "";
  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && node.name.getText(parsed) === name && node.initializer) {
      const init = node.initializer;
      const body = ts.isCallExpression(init) && init.expression.getText(parsed) === "useCallback" ? init.arguments[0]! : init;
      handler = `const ${name} = ${body.getText(parsed)};`;
    }
    ts.forEachChild(node, visit);
  };
  visit(parsed);
  expect(handler, `${name} in ${file}`).not.toBe("");
  const js = ts.transpileModule(`${handler}\nglobalThis.handler = ${name};`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  const context = vm.createContext({ ...bindings });
  new vm.Script(js).runInContext(context);
  return context.handler as T;
}

const settingsBindings = (): Record<string, unknown> => ({
  capturePlayerScope,
  useSettingsStore,
  settings: useSettingsStore.getState().settings,
  update: (patch: Partial<AppSettings>) => useSettingsStore.getState().update(patch),
  enable: (...args: unknown[]) => (usePushRegistration.getState().enable as (...a: unknown[]) => Promise<boolean>)(...args),
  disable: () => usePushRegistration.getState().disable(),
  sync: () => usePushRegistration.getState().sync(),
  applyDailyReminderPreference: async () => undefined,
});
const setKind = (patch: Partial<AppSettings>): Promise<void> =>
  handlerFromScreen<(p: Partial<AppSettings>) => Promise<void>>("app/settings/index.tsx", "setKind", settingsBindings())(patch);
const setMaster = (next: boolean): Promise<void> =>
  handlerFromScreen<(n: boolean) => Promise<void>>("app/settings/index.tsx", "setMaster", settingsBindings())(next);
/**
 * The Social screen's own acceptance handler: accept, then the notification
 * offer. `settings` (the screen's snapshot when the handler ran) and
 * `updateSettings` stay bound so the AUDITED handler, which offered that
 * snapshot and saved whatever came back, compiles and runs the same way.
 */
const acceptFromSocial = (playerId: string): Promise<void> =>
  handlerFromScreen<(id: string) => Promise<void>>("app/(tabs)/social.tsx", "onAccept", {
    acceptRequest: async () => true,
    offerPush: (...args: unknown[]) => (usePushRegistration.getState().offer as (...a: unknown[]) => Promise<unknown>)(...args),
    settings: useSettingsStore.getState().settings,
    updateSettings: (patch: Partial<AppSettings>) => useSettingsStore.getState().update(patch),
  })(playerId);

async function views(kind: "notifyYourTurn" | "notifyFriendRequests"): Promise<{ memory: boolean; disk: boolean; server: boolean }> {
  const serverKind = kind === "notifyYourTurn" ? "your_turn" : "friend_request";
  return {
    memory: useSettingsStore.getState().settings[kind],
    disk: (await persisted.load()).settings[kind],
    server: row().kinds.includes(serverKind),
  };
}

/** Notifications on and this device registered, with the given choices — the audits' starting point. */
async function registered(choices: Partial<AppSettings>): Promise<void> {
  native.token = `ExponentPushToken[intent-order-${randomUUID()}]`;
  tokens.push(native.token);
  const settings: AppSettings = { ...DEFAULT_SETTINGS, notificationsEnabled: true, ...choices };
  await persisted.save(settings);
  useSettingsStore.setState({ ready: true, settings, failure: null });
  expect(await registerDevice(settings)).toEqual({ kind: "registered" });
  usePushRegistration.setState({ registered: true, busy: false, unavailable: null });
}

const created: string[] = [];
const tokens: string[] = [];
const email = `b-h4-${randomUUID()}@arc21.test`;
const password = `Intent-${randomUUID()}-Aa1!`;
let player = "";

const privacy = (): string => database(`select privacy::text from public.profiles where id = '${player}'`);

const suite = stackUp ? describe : describe.skip;

suite("B-H2 / B-H4: the database keeps the newest notification intent, and offers touch nothing else", () => {
  beforeAll(async () => {
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
    setPushRevisionStore(new MemoryKeyValueStore());

    proxy.server = createServer((request, response) => { void handle(request, response); });
    await new Promise<void>((resolve) => proxy.server!.listen(0, "127.0.0.1", resolve));
    proxy.port = (proxy.server.address() as { port: number }).port;
  });

  beforeEach(() => {
    native.permission = "granted";
    native.permissionHold = null;
    proxy.next = "forward";
    proxy.queued = [];
    proxy.seen = [];
  });

  afterAll(async () => {
    proxy.port = 0;
    proxy.server?.closeAllConnections();
    await new Promise<void>((resolve) => (proxy.server ? proxy.server.close(() => resolve()) : resolve()));
    setPushRevisionStore(null);
    setSettingsPersistence(null);
    disposeAuthSubscription();
    useAuthStore.setState({ session: null, mode: "guest" });
    setGuestIdentityStore(null);
    setSupabaseAvailabilityForTests(null);
    usePushRegistration.setState({ registered: false, busy: false, unavailable: null });
    await device.realtime.disconnect();
    if (tokens.length > 0) database(`delete from public.push_tokens where token in (${tokens.map((t) => `'${t}'`).join(",")})`);
    for (const id of created) expect((await admin.auth.admin.deleteUser(id)).error).toBeNull();
    expect(database(`select count(*) from public.push_tokens where token in (${tokens.map((t) => `'${t}'`).join(",") || "''"})`)).toBe("0");
  });

  it("CASE 1 — THE AUDIT'S B-H4 REPRODUCTION, inverted: an accepted ON that outlives its connection cannot undo a newer OFF", async () => {
    await registered({ notifyYourTurn: false });

    proxy.next = "accept-then-drop";
    await setKind({ notifyYourTurn: true });
    expect(usePushRegistration.getState().unavailable).toBe("Could not register this device.");
    expect(proxy.queued).toHaveLength(1);
    await setKind({ notifyYourTurn: false });
    expect(await views("notifyYourTurn")).toEqual({ memory: false, disk: false, server: false });
    const newest = row().revision;

    // The accepted ON reaches PostgREST now, after the newer OFF committed.
    const late = await send(proxy.queued[0]!);
    // THE DATABASE FIRST: the audit read `server: true` here (after a 204).
    expect(await views("notifyYourTurn")).toEqual({ memory: false, disk: false, server: false });
    expect(row()).toMatchObject({ active: true, revision: newest });
    expect(late.status).toBe(200);
    expect(await late.json()).toEqual({ applied: false, revision: newest });
  });

  it("CASE 2 — the mirror image: an accepted OFF that outlives its connection cannot undo a newer ON", async () => {
    await registered({ notifyYourTurn: true });

    proxy.next = "accept-then-drop";
    await setKind({ notifyYourTurn: false });
    await setKind({ notifyYourTurn: true });
    expect(await views("notifyYourTurn")).toEqual({ memory: true, disk: true, server: true });
    const newest = row().revision;

    const late = await send(proxy.queued[0]!);
    expect(await views("notifyYourTurn")).toEqual({ memory: true, disk: true, server: true });
    expect(await late.json()).toEqual({ applied: false, revision: newest });
  });

  it("CASE 3 — THE AUDIT'S B-H2 REPRODUCTION, inverted: a delayed offer overtaken by newer choices registers nothing and restores neither Friends nor privacy", async () => {
    native.token = `ExponentPushToken[intent-order-${randomUUID()}]`;
    tokens.push(native.token);
    const initial: AppSettings = { ...DEFAULT_SETTINGS, statsVisibility: "public" };
    await persisted.save(initial);
    useSettingsStore.setState({ ready: true, settings: initial, failure: null });
    await reconcileProfilePrivacy(player, true, "public");
    expect(privacy()).toBe("public");
    usePushRegistration.setState({ registered: false, busy: false, unavailable: null });

    // The offer's OS permission-status read is held, answering what the OS said
    // when it was asked: never asked yet.
    native.permission = "undetermined";
    let release!: () => void;
    let reached!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const at = new Promise<void>((resolve) => { reached = resolve; });
    native.permissionHold = { reach: reached, gate, answer: { granted: false, canAskAgain: true } };
    const accepting = acceptFromSocial("friend-1");
    await at;
    expect(usePushRegistration.getState().busy).toBe(false);

    // Meanwhile, in Settings: notifications on (the OS asked and granted),
    // Friends ON, then explicitly OFF, then statistics "Only me".
    await setMaster(true);
    expect(useSettingsStore.getState().settings.notificationsEnabled).toBe(true);
    await setKind({ notifyFriendRequests: true });
    await setKind({ notifyFriendRequests: false });
    await useSettingsStore.getState().update({ statsVisibility: "private" });
    await reconcileProfilePrivacy(player, true, useSettingsStore.getState().settings.statsVisibility);
    expect(privacy()).toBe("private");
    expect(await views("notifyFriendRequests")).toEqual({ memory: false, disk: false, server: false });
    const before = row();

    release();
    await accepting;
    // The root's privacy effect runs for whatever Settings now say.
    await reconcileProfilePrivacy(player, true, useSettingsStore.getState().settings.statsVisibility);

    // The audit read Friends ON in all three, and privacy PUBLIC in all three.
    expect(await views("notifyFriendRequests")).toEqual({ memory: false, disk: false, server: false });
    expect({
      memory: useSettingsStore.getState().settings.statsVisibility,
      disk: (await persisted.load()).settings.statsVisibility,
      server: privacy(),
    }).toEqual({ memory: "private", disk: "private", server: "private" });
    // The obsolete offer wrote nothing at all.
    expect(row()).toEqual(before);
  });

  it("CASE 3 — an offer still current when granted records ONLY its own keys, into Settings as they stand: privacy chosen meanwhile stays", async () => {
    native.token = `ExponentPushToken[intent-order-${randomUUID()}]`;
    tokens.push(native.token);
    const initial: AppSettings = { ...DEFAULT_SETTINGS, statsVisibility: "public" };
    await persisted.save(initial);
    useSettingsStore.setState({ ready: true, settings: initial, failure: null });
    await reconcileProfilePrivacy(player, true, "public");
    usePushRegistration.setState({ registered: false, busy: false, unavailable: null });

    native.permission = "undetermined";
    let release!: () => void;
    let reached!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const at = new Promise<void>((resolve) => { reached = resolve; });
    native.permissionHold = { reach: reached, gate, answer: { granted: false, canAskAgain: true } };
    const accepting = acceptFromSocial("friend-2");
    await at;

    // Only an unrelated choice is made meanwhile.
    await useSettingsStore.getState().update({ statsVisibility: "private" });
    await reconcileProfilePrivacy(player, true, "private");

    release();
    await accepting;
    await reconcileProfilePrivacy(player, true, useSettingsStore.getState().settings.statsVisibility);

    // The grant is recorded — notifications and Friends, nothing else.
    expect(useSettingsStore.getState().settings).toMatchObject({ notificationsEnabled: true, notifyFriendRequests: true, statsVisibility: "private" });
    expect(await views("notifyFriendRequests")).toEqual({ memory: true, disk: true, server: true });
    expect({ disk: (await persisted.load()).settings.statsVisibility, server: privacy() }).toEqual({ disk: "private", server: "private" });
  });

  it("CASE 4 — rapid same-device toggles: the latest intent wins, in memory, on disk and in Postgres", async () => {
    await registered({ notifyYourTurn: false });

    await Promise.all([
      setKind({ notifyYourTurn: true }),
      setKind({ notifyYourTurn: false }),
      setKind({ notifyYourTurn: true }),
      setKind({ notifyYourTurn: false }),
    ]);

    expect(await views("notifyYourTurn")).toEqual({ memory: false, disk: false, server: false });
  });

  it("CASE 5 — an old intent retried after a newer one exists is refused, and changes nothing", async () => {
    await registered({ notifyYourTurn: false });

    await setKind({ notifyYourTurn: true });
    const older = proxy.seen.at(-1)!;
    await setKind({ notifyYourTurn: false });
    const newest = row();
    expect(newest.kinds).not.toContain("your_turn");

    const retried = await send(older);
    expect(await views("notifyYourTurn")).toEqual({ memory: false, disk: false, server: false });
    expect(row()).toEqual(newest);
    expect(await retried.json()).toEqual({ applied: false, revision: newest.revision });
  });

  it("CASE 6 — the newest intent's reply is lost: retrying that SAME intent is idempotent", async () => {
    await registered({ notifyYourTurn: false });

    proxy.next = "commit-then-drop";
    await setKind({ notifyYourTurn: true });
    // The server committed it; the device only saw the connection fail.
    expect(usePushRegistration.getState().unavailable).toBe("Could not register this device.");
    const committed = row();
    expect(committed.kinds).toContain("your_turn");

    const again = await send(proxy.seen.at(-1)!);
    const twice = await send(proxy.seen.at(-1)!);
    expect(row()).toEqual(committed);
    expect(await again.json()).toEqual({ applied: false, revision: committed.revision });
    expect(await twice.json()).toEqual({ applied: false, revision: committed.revision });
  });

  it("a registration that outlives its connection cannot switch the device back on after notifications were turned off", async () => {
    await registered({ notifyYourTurn: true });

    proxy.next = "accept-then-drop";
    await setKind({ notifyYourTurn: false });
    await setMaster(false);
    expect(row()).toMatchObject({ active: false, kinds: [] });
    const retired = row().revision;

    const late = await send(proxy.queued[0]!);
    expect(row()).toMatchObject({ active: false, kinds: [], revision: retired });
    expect(await late.json()).toEqual({ applied: false, revision: retired });
  });

  it("POSITIVE CONTROL: uninterrupted choices each reach Postgres in turn, each with a newer revision", async () => {
    await registered({ notifyYourTurn: false });
    const revisions = [row().revision];

    await setKind({ notifyYourTurn: true });
    expect(await views("notifyYourTurn")).toEqual({ memory: true, disk: true, server: true });
    revisions.push(row().revision);
    await setKind({ notifyFriendRequests: true });
    expect(await views("notifyFriendRequests")).toEqual({ memory: true, disk: true, server: true });
    revisions.push(row().revision);
    await setKind({ notifyYourTurn: false });
    expect(await views("notifyYourTurn")).toEqual({ memory: false, disk: false, server: false });
    revisions.push(row().revision);

    expect([...revisions].sort((a, b) => a - b)).toEqual(revisions);
    expect(new Set(revisions).size).toBe(revisions.length);
    expect(usePushRegistration.getState().unavailable).toBeNull();
  });
});
