/**
 * B-F1 and B-F3 — a privacy choice reaches the server in the order it was made,
 * for the player who made it, and nothing older can land after it.
 *
 * The final Refresh-B audit (September 30, 2026) found the two halves of one
 * problem:
 *
 *  - B-F1: the sync's per-player queue waited only as long as a caller would.
 *    The audit held player A's "public" PATCH past its 8-second timeout, let
 *    the next choice, "private", be written and acknowledged, then released
 *    the old request — and the column read "public".
 *  - B-F3: the Settings screen awaited its LOCAL save before calling the sync,
 *    so the write was bound to whoever was signed in when the save finished,
 *    and ordered by when it finished. A's held save, released after a sign-in
 *    to B and B's own "private", wrote "public" onto B. Without any switch, an
 *    older save finishing late sent its "public" after the newer "private".
 *
 * Proved here, without a server: the settings store's saves finish in order
 * and leave the latest record on disk; the root reconciliation is the one
 * caller of the sync, and the actual Settings handler — read out of the screen
 * itself, not retyped — makes no write of its own; and the sync's write is
 * conditional on the row version it read, so a request delivered after a newer
 * one matches nothing. `tests/server/privacy-ordering.integration.test.ts`
 * proves the same against real GoTrue, PostgREST and Postgres.
 */

import { readFileSync } from "node:fs";
import vm from "node:vm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ts from "typescript";
import { createClient } from "@supabase/supabase-js";

import { capturePlayerScope, invalidatePlayerScope } from "../../src/features/player/player-scope.js";
import { setSupabaseAvailabilityForTests, type ArcSupabaseClient } from "../../src/lib/supabase/client.js";

// The settings store reaches the audio and haptics adapters, which import React Native.
vi.mock("../../src/lib/audio/audio.js", () => ({ setSoundEnabled: () => undefined }));
vi.mock("../../src/lib/haptics/haptics.js", () => ({ setHapticsEnabled: () => undefined }));

const { useSettingsStore, setSettingsPersistence } = await import("../../src/features/settings/use-settings.js");
const { SettingsPersistence, DEFAULT_SETTINGS } = await import("../../src/features/settings/settings.js");
const { syncProfilePrivacy } = await import("../../src/features/settings/profile-privacy.js");
const { reconcileProfilePrivacy } = await import("../../src/features/settings/use-profile-privacy-sync.js");

type Visibility = "public" | "friends" | "private";

/** A key-value store whose next write can be held open. */
function heldDisk() {
  const entries = new Map<string, string>();
  let hold = false;
  let release: () => void = () => undefined;
  let reach: () => void = () => undefined;
  let reached: Promise<void> = Promise.resolve();
  return {
    entries,
    /** The next `set` blocks until `release()`. */
    arm(): void {
      hold = true;
      reached = new Promise<void>((resolve) => { reach = resolve; });
    },
    get reached(): Promise<void> {
      return reached;
    },
    release: () => release(),
    store: {
      get: async (key: string) => entries.get(key) ?? null,
      set: async (key: string, value: string) => {
        if (hold) {
          hold = false;
          const gate = new Promise<void>((resolve) => { release = resolve; });
          reach();
          await gate;
        }
        entries.set(key, value);
      },
      remove: async (key: string) => { entries.delete(key); },
    },
  };
}

/** What a relaunch would load. */
async function onDisk(disk: ReturnType<typeof heldDisk>): Promise<Visibility> {
  return (await new SettingsPersistence(disk.store).load()).settings.statsVisibility as Visibility;
}

/**
 * The CURRENT `changeVisibility` from `app/settings/index.tsx`, compiled from
 * the screen's own source — the audit's method, so the caller under test is the
 * one that ships, not a restatement of it. Its free variables are supplied.
 */
function settingsHandler(
  update: (patch: { statsVisibility: Visibility }) => Promise<void>,
  sync: (visibility: Visibility) => Promise<unknown>,
): (visibility: Visibility) => unknown {
  const source = readFileSync(new URL("../../app/settings/index.tsx", import.meta.url), "utf8");
  const file = ts.createSourceFile("index.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let handler = "";
  const visit = (node: ts.Node): void => {
    if (ts.isFunctionDeclaration(node) && node.name?.text === "changeVisibility") handler = node.getText(file);
    ts.forEachChild(node, visit);
  };
  visit(file);
  expect(handler.length).toBeGreaterThan(20);
  const js = ts.transpileModule(handler, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  // Evaluated in its own context, which holds nothing but the handler's free
  // variables. The text is this repository's screen source, never input.
  const context = vm.createContext({ update, syncProfilePrivacy: sync });
  new vm.Script(js).runInContext(context);
  return context.changeVisibility as (visibility: Visibility) => unknown;
}

let disk = heldDisk();

beforeEach(() => {
  disk = heldDisk();
  setSettingsPersistence(new SettingsPersistence(disk.store));
  useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS }, ready: true, failure: null });
});

afterEach(() => {
  vi.useRealTimers();
  setSettingsPersistence(null);
  setSupabaseAvailabilityForTests(null);
  invalidatePlayerScope();
});

describe("B-F3 locally: the newest choice is the one on disk", () => {
  it("finishes saves in order, so a save held open cannot leave the older choice behind", async () => {
    disk.arm();
    const older = useSettingsStore.getState().update({ statsVisibility: "public" });
    await disk.reached;
    const newer = useSettingsStore.getState().update({ statsVisibility: "private" });
    expect(useSettingsStore.getState().settings.statsVisibility).toBe("private");

    disk.release();
    await Promise.all([older, newer]);

    // Unordered, the held "public" finished last and was what a relaunch loaded.
    expect(await onDisk(disk)).toBe("private");
    expect(useSettingsStore.getState().settings.statsVisibility).toBe("private");
  });

  it("a reset queued behind a held save still ends with the defaults on disk", async () => {
    disk.arm();
    const older = useSettingsStore.getState().update({ statsVisibility: "public" });
    await disk.reached;
    const reset = useSettingsStore.getState().reset();
    disk.release();
    await Promise.all([older, reset]);
    expect(await onDisk(disk)).toBe(DEFAULT_SETTINGS.statsVisibility);
  });
});

describe("B-F3: one owner for the profile write", () => {
  it("the actual Settings handler records the choice and writes nothing to the server itself", async () => {
    const synced: Visibility[] = [];
    const handler = settingsHandler(
      (patch) => useSettingsStore.getState().update(patch),
      async (visibility) => { synced.push(visibility); },
    );
    disk.arm();
    const call = handler("public");
    // The in-memory choice moved immediately, before any save finished — which
    // is what the root reconciliation sees, under the player current then.
    expect(useSettingsStore.getState().settings.statsVisibility).toBe("public");
    await disk.reached;
    disk.release();
    await Promise.resolve(call);
    await new Promise((resolve) => setTimeout(resolve, 10));
    // Before the repair the screen synced too, after its save, bound to whoever
    // was current by then. Now the root is the only caller.
    expect(synced).toEqual([]);
    expect(await onDisk(disk)).toBe("public");
  });

  it("the root reconciliation writes only for a player whose preference has been loaded", async () => {
    expect(reconcileProfilePrivacy(null, true, "private")).toBeNull();
    expect(reconcileProfilePrivacy("11111111-1111-4111-8111-111111111111", false, "private")).toBeNull();
    // With no server configured the call is made and skips, rather than failing.
    await expect(reconcileProfilePrivacy("11111111-1111-4111-8111-111111111111", true, "private")).resolves.toEqual({
      status: "skipped",
      reason: "not-configured",
    });
  });
});

/**
 * PostgREST over one `profiles` row, with the semantics the sync relies on:
 * every accepted update moves `updated_at` (the `profiles_set_updated_at`
 * trigger), and a filter on it matches only that exact version. Requests can be
 * held before they are delivered; a held one is applied when it is RELEASED,
 * which is what a slow network does to a request the client has given up on.
 */
function profileServer(owner: string) {
  let tick = 0;
  const row = { id: owner, privacy: "private" as Visibility, updated_at: version(0) };
  function version(n: number): string {
    return `2026-09-30T00:00:00.${String(n).padStart(6, "0")}+00:00`;
  }
  const holds: { match: (method: string, body: string | null) => boolean; reached: () => void; gate: Promise<void> }[] = [];
  const log: { method: string; body: string | null; matched: number }[] = [];
  let interfere: (() => void) | null = null;
  const server = {
    row,
    log,
    /** Holds the next request `match` accepts. */
    hold(match: (method: string, body: string | null) => boolean) {
      let release!: () => void;
      let reached!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      const reach = new Promise<void>((resolve) => { reached = resolve; });
      holds.push({ match, reached, gate });
      return { release, reached: reach };
    },
    /** Another writer (another device, the server) moves the row before the next PATCH lands. */
    interfereOnce(times = 1) {
      let left = times;
      interfere = () => {
        if (left <= 0) return;
        left -= 1;
        tick += 1;
        row.updated_at = version(tick);
      };
    },
    fetch: async (input: RequestInfo | globalThis.URL, init?: RequestInit): Promise<Response> => {
      const url = new globalThis.URL(String(input instanceof Request ? input.url : input));
      const method = init?.method ?? "GET";
      const body = typeof init?.body === "string" ? init.body : null;
      const held = holds.findIndex((entry) => entry.match(method, body));
      if (held >= 0) {
        const [entry] = holds.splice(held, 1);
        entry!.reached();
        await entry!.gate;
      }
      const json = (value: unknown) =>
        new Response(JSON.stringify(value), { status: 200, headers: { "content-type": "application/json" } });
      if (!url.pathname.endsWith("/rest/v1/profiles")) return json(null);
      const id = url.searchParams.get("id");
      if (id !== `eq.${owner}`) return json([]);
      if (method === "GET") return json([{ updated_at: row.updated_at }]);
      if (method === "PATCH") {
        interfere?.();
        // No version filter is an unconditional write, which PostgREST applies.
        const expected = url.searchParams.get("updated_at");
        const matched = expected === null || expected === `eq.${row.updated_at}` ? 1 : 0;
        log.push({ method, body, matched });
        if (matched === 0) return json([]);
        row.privacy = (JSON.parse(body ?? "{}") as { privacy: Visibility }).privacy;
        tick += 1;
        row.updated_at = version(tick);
        return json([{ updated_at: row.updated_at }]);
      }
      return json(null);
    },
  };
  return server;
}

/** A real supabase-js client signed in as `owner`, over the fake server. */
function clientFor(owner: string, server: ReturnType<typeof profileServer>): ArcSupabaseClient {
  const session = JSON.stringify({
    access_token: "token-owner",
    token_type: "bearer",
    refresh_token: "refresh-owner",
    expires_in: 3600,
    expires_at: Math.floor(Date.now() / 1000) + 3600,
    user: { id: owner, aud: "authenticated", role: "authenticated", app_metadata: {}, user_metadata: {}, created_at: "2026-09-30T00:00:00.000Z" },
  });
  const storage = new Map<string, string>([["arc21-privacy-ordering", session]]);
  return createClient("http://127.0.0.1:54321", "test-anon-key", {
    auth: {
      storageKey: "arc21-privacy-ordering",
      autoRefreshToken: false,
      detectSessionInUrl: false,
      storage: {
        getItem: (key) => storage.get(key) ?? null,
        setItem: (key, value) => { storage.set(key, value); },
        removeItem: (key) => { storage.delete(key); },
      },
    },
    global: { fetch: server.fetch },
  }) as ArcSupabaseClient;
}

const OWNER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

describe("B-F1 on the wire: a write delivered after a newer one matches nothing", () => {
  it("THE AUDIT'S SHAPE: the old 'public' times out, 'private' is written, and the released 'public' changes nothing", async () => {
    const server = profileServer(OWNER);
    setSupabaseAvailabilityForTests({ status: "ready", client: clientFor(OWNER, server) });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });

    const held = server.hold((method, body) => method === "PATCH" && (body ?? "").includes("public"));
    const old = syncProfilePrivacy("public");
    await held.reached;
    const latest = syncProfilePrivacy("private");
    // The queue holds "private" until the old write's wait expires.
    await vi.advanceTimersByTimeAsync(8_001);
    expect(await old).toMatchObject({ status: "failed", reason: "unreachable" });
    expect(await latest).toEqual({ status: "written", privacy: "private" });
    expect(server.row.privacy).toBe("private");
    const acknowledged = server.row.updated_at;

    // The request the caller gave up on is delivered now.
    held.release();
    await vi.waitFor(() => expect(server.log.length).toBe(2));
    expect(server.log.map(({ body, matched }) => ({ body, matched }))).toEqual([
      { body: JSON.stringify({ privacy: "private" }), matched: 1 },
      { body: JSON.stringify({ privacy: "public" }), matched: 0 },
    ]);
    // Not merely an ignored reply: the row did not change at all.
    expect(server.row.privacy).toBe("private");
    expect(server.row.updated_at).toBe(acknowledged);
  });

  it("re-reads and wins when another writer moves the row between its read and its write", async () => {
    const server = profileServer(OWNER);
    setSupabaseAvailabilityForTests({ status: "ready", client: clientFor(OWNER, server) });
    server.interfereOnce(1);

    expect(await syncProfilePrivacy("friends")).toEqual({ status: "written", privacy: "friends" });
    expect(server.log.map(({ matched }) => matched)).toEqual([0, 1]);
    expect(server.row.privacy).toBe("friends");
  });

  it("gives up, without writing over a version it never saw, when the row keeps moving", async () => {
    const server = profileServer(OWNER);
    setSupabaseAvailabilityForTests({ status: "ready", client: clientFor(OWNER, server) });
    server.interfereOnce(10);

    expect(await syncProfilePrivacy("public")).toMatchObject({ status: "failed", reason: "contended" });
    expect(server.log.map(({ matched }) => matched)).toEqual([0, 0, 0]);
    expect(server.row.privacy).toBe("private");
  });

  it("an uninterrupted sequence lands in order (positive control)", async () => {
    const server = profileServer(OWNER);
    setSupabaseAvailabilityForTests({ status: "ready", client: clientFor(OWNER, server) });

    const first = syncProfilePrivacy("public");
    const second = syncProfilePrivacy("private");
    expect(await first).toEqual({ status: "written", privacy: "public" });
    expect(await second).toEqual({ status: "written", privacy: "private" });
    expect(server.row.privacy).toBe("private");
  });

  it("a write asked for under a player who is no longer current is never sent", async () => {
    const server = profileServer(OWNER);
    setSupabaseAvailabilityForTests({ status: "ready", client: clientFor(OWNER, server) });
    const held = server.hold((method) => method === "GET");
    const stale = syncProfilePrivacy("public");
    await Promise.race([
      held.reached,
      new Promise((_, reject) => setTimeout(() => reject(new Error("the write never read the row version it replaces")), 2_000)),
    ]);
    const scope = capturePlayerScope();
    invalidatePlayerScope();
    expect(scope()).toBe(false);
    held.release();

    expect(await stale).toEqual({ status: "skipped", reason: "identity-changed" });
    expect(server.log).toEqual([]);
    expect(server.row.privacy).toBe("private");
  });
});
