/**
 * B-F1 and B-F3 — a privacy choice reaches `profiles.privacy` in the order it
 * was made, for the player who made it. Against real GoTrue, PostgREST and
 * Postgres.
 *
 * The final Refresh-B audit (September 30, 2026) reproduced both against this
 * stack:
 *
 *  - B-F1: one player starts "public"; its authenticated PATCH is held before
 *    delivery past the sync's 8-second timeout; "private" is then written and
 *    acknowledged; the old PATCH is released — and the column reads "public".
 *  - B-F3: the actual Settings callback awaited its local save before calling
 *    the sync. A's save was held across a real sign-in to B and B's own
 *    "private"; released, it wrote A's "public" onto B. With no switch at all,
 *    the held older save sent "public" after the newer "private".
 *
 * These are those reproductions, kept and inverted, through production code: a
 * real supabase-js client with `client.ts`'s PKCE and `processLock`, the
 * production Auth store hydrated by its own `hydrate()` and switched by its own
 * sign-in, `resetPlayerState()` at the identity boundary (what `usePlayerState`
 * calls), the production settings store, and the CURRENT `changeVisibility`
 * read out of `app/settings/index.tsx` itself. The root reconciliation is
 * driven as React drives `useProfilePrivacySync`'s effect: after any change to
 * the signed-in player, the loaded flag or the stored visibility, with that
 * effect's body (`reconcileProfilePrivacy`: nothing without a player and a
 * loaded preference, otherwise the sync). Only the disk under the settings
 * store and the audio/haptics adapters are doubled. Every verdict is a
 * DATABASE readback, including the row version, so a late write cannot hide
 * behind an ignored reply.
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
import { setSupabaseAvailabilityForTests, type ArcSupabaseClient } from "../../src/lib/supabase/client.js";

// The settings store reaches the audio and haptics adapters, which import React Native.
vi.mock("../../src/lib/audio/audio.js", () => ({ setSoundEnabled: () => undefined }));
vi.mock("../../src/lib/haptics/haptics.js", () => ({ setHapticsEnabled: () => undefined }));

const { useSettingsStore, setSettingsPersistence } = await import("../../src/features/settings/use-settings.js");
const { SettingsPersistence, DEFAULT_SETTINGS } = await import("../../src/features/settings/settings.js");
const { syncProfilePrivacy } = await import("../../src/features/settings/profile-privacy.js");

type Visibility = "public" | "friends" | "private";

const URL = "http://127.0.0.1:54321";
// Published local-only test keys, identical to the existing integration suites.
const ANON = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0";
const ADMIN_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU";

const admin = createClient(URL, ADMIN_KEY, { auth: { persistSession: false, autoRefreshToken: false } });

/** Every PATCH the device sent to `profiles`, in order. */
const patches: { readonly body: string | null; readonly path: string }[] = [];

/** One held PATCH: the audit's injection, at the native transport. */
let heldPatch: {
  readonly matches: (body: string) => boolean;
  readonly reach: () => void;
  readonly gate: Promise<void>;
  readonly answered: (body: unknown) => void;
} | null = null;

/** `client.ts`'s auth options over an in-memory store; no timer outlives the file. */
function device(): ArcSupabaseClient {
  const storage = new Map<string, string>();
  return createClient(URL, ANON, {
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
        const url = new globalThis.URL(String(input instanceof Request ? input.url : input));
        const body = typeof init?.body === "string" ? init.body : null;
        const isWrite = url.pathname === "/rest/v1/profiles" && init?.method === "PATCH";
        if (isWrite) patches.push({ body, path: `${url.pathname}${url.search}` });
        const hold = heldPatch;
        if (isWrite && hold !== null && hold.matches(body ?? "")) {
          heldPatch = null;
          hold.reach();
          await hold.gate;
          const response = await fetch(input, init);
          hold.answered(await response.clone().json().catch(() => null));
          return response;
        }
        return fetch(input, init);
      },
    },
  }) as ArcSupabaseClient;
}

/** Holds the next PATCH whose body matches, before it is delivered. */
function holdPatch(matches: (body: string) => boolean) {
  let release!: () => void;
  let reach!: () => void;
  let answer!: (body: unknown) => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const reached = new Promise<void>((resolve) => { reach = resolve; });
  const answered = new Promise<unknown>((resolve) => { answer = resolve; });
  heldPatch = { matches, reach, gate, answered: answer };
  return { reached, release, answered };
}

/** The disk under the settings store; its next write can be held open. */
function heldDisk() {
  const entries = new Map<string, string>();
  let hold = false;
  let release: () => void = () => undefined;
  let reach: () => void = () => undefined;
  let reached: Promise<void> = Promise.resolve();
  return {
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

/** Readbacks straight from the database; THROWS when it cannot run. */
function database(sql: string): string {
  return execFileSync(
    "docker",
    ["exec", "supabase_db_arc21", "psql", "-U", "postgres", "-d", "postgres", "-X", "-v", "ON_ERROR_STOP=1", "-Atc", sql],
    { encoding: "utf8" },
  ).trim();
}

const privacyOf = (player: string): string => database(`select privacy::text from public.profiles where id = '${player}'::uuid`);
const versionOf = (player: string): string => database(`select updated_at::text from public.profiles where id = '${player}'::uuid`);

/** The CURRENT Settings handler, compiled from the screen's own source. */
function settingsHandler(): (visibility: Visibility) => unknown {
  const source = readFileSync(new globalThis.URL("../../app/settings/index.tsx", import.meta.url), "utf8");
  const file = ts.createSourceFile("index.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let handler = "";
  const visit = (node: ts.Node): void => {
    if (ts.isFunctionDeclaration(node) && node.name?.text === "changeVisibility") handler = node.getText(file);
    ts.forEachChild(node, visit);
  };
  visit(file);
  expect(handler.length).toBeGreaterThan(20);
  const js = ts.transpileModule(handler, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  // Its own context holds nothing but the handler's free variables: the
  // production store's `update` and the production sync. The text is this
  // repository's screen source, never input.
  const context = vm.createContext({
    update: (patch: { statsVisibility: Visibility }) => useSettingsStore.getState().update(patch),
    syncProfilePrivacy,
  });
  new vm.Script(js).runInContext(context);
  return context.changeVisibility as (visibility: Visibility) => unknown;
}

/**
 * `useProfilePrivacySync`, as React runs it: after a commit in which the player,
 * the loaded flag or the visibility changed, with that effect's body. Deferred
 * to a macrotask, as an effect runs after the change that scheduled it.
 */
function mountRootReconciliation(): { settle(): Promise<void>; stop(): void } {
  let last = "";
  let scheduled = false;
  const pending: Promise<unknown>[] = [];
  const run = (): void => {
    scheduled = false;
    const userId = useAuthStore.getState().session?.account.userId ?? null;
    const { ready, settings } = useSettingsStore.getState();
    const key = `${userId}|${ready}|${settings.statsVisibility}`;
    if (key === last) return;
    last = key;
    if (userId === null || !ready) return;
    pending.push(syncProfilePrivacy(settings.statsVisibility));
  };
  const schedule = (): void => {
    if (scheduled) return;
    scheduled = true;
    setTimeout(run, 0);
  };
  const stops = [useAuthStore.subscribe(schedule), useSettingsStore.subscribe(schedule)];
  schedule();
  return {
    /** Lets every scheduled effect run, then waits for each write it started. */
    async settle() {
      for (let round = 0; round < 50; round += 1) {
        await new Promise((resolve) => setTimeout(resolve, 10));
        const batch = pending.splice(0);
        if (batch.length === 0 && !scheduled) return;
        await Promise.all(batch);
      }
      throw new Error("the root reconciliation never settled");
    },
    stop() {
      for (const stop of stops) stop();
    },
  };
}

const created: string[] = [];
const password = `Privacy-${randomUUID()}-Aa1!`;
const emailA = `b-f-privacy-a-${randomUUID()}@arc21.test`;
const emailB = `b-f-privacy-b-${randomUUID()}@arc21.test`;
let playerA = "";
let playerB = "";
let disk = heldDisk();
let root: ReturnType<typeof mountRootReconciliation> | null = null;
let stopIdentity: (() => void) | null = null;
const client = device();

async function createSecured(email: string): Promise<string> {
  const result = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  expect(result.error).toBeNull();
  created.push(result.data.user!.id);
  return result.data.user!.id;
}

const shownPlayer = (): string | null => useAuthStore.getState().session?.account.userId ?? null;
const localChoice = (): string => useSettingsStore.getState().settings.statsVisibility;
const diskChoice = async (): Promise<string> => (await new SettingsPersistence(disk.store).load()).settings.statsVisibility;

const suite = stackUp ? describe : describe.skip;

suite("B-F1 and B-F3: the newest privacy choice is the one the server keeps, for the player who made it", () => {
  beforeAll(async () => {
    playerA = await createSecured(emailA);
    playerB = await createSecured(emailB);

    setSettingsPersistence(new SettingsPersistence(disk.store));
    useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS }, ready: true, failure: null });

    // `usePlayerState`'s identity-change body; the hook itself needs React Native.
    stopIdentity = useAuthStore.subscribe((next, previous) => {
      if ((next.session?.account.userId ?? null) !== (previous.session?.account.userId ?? null)) resetPlayerState();
    });

    expect((await client.auth.signInWithPassword({ email: emailA, password })).error).toBeNull();
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
    expect(shownPlayer()).toBe(playerA);

    root = mountRootReconciliation();
    await root.settle();
    // The local default reached A's row the moment A existed: the reason the root owns this.
    expect(privacyOf(playerA)).toBe("private");
  });

  afterAll(async () => {
    root?.stop();
    stopIdentity?.();
    disposeAuthSubscription();
    resetPlayerState();
    useAuthStore.setState({ session: null, mode: "guest" });
    setGuestIdentityStore(null);
    setSupabaseAvailabilityForTests(null);
    setSettingsPersistence(null);
    for (const id of created) {
      const result = await admin.auth.admin.deleteUser(id);
      expect(result.error).toBeNull();
    }
  });

  it("an uninterrupted Settings choice reaches the server, the store and the disk (positive control)", async () => {
    const handler = settingsHandler();
    await Promise.resolve(handler("friends"));
    await root!.settle();

    expect(privacyOf(playerA)).toBe("friends");
    expect(localChoice()).toBe("friends");
    expect(await diskChoice()).toBe("friends");

    await Promise.resolve(handler("private"));
    await root!.settle();
    expect(privacyOf(playerA)).toBe("private");
  });

  it("B-F1: an older write released after its timeout cannot overwrite the newer acknowledged choice", async () => {
    const handler = settingsHandler();
    const held = holdPatch((body) => body.includes('"public"'));

    await Promise.resolve(handler("public"));
    await held.reached;
    // The old PATCH is in flight, undelivered. The newer choice is made now.
    await Promise.resolve(handler("private"));
    // The queue holds "private" until the old write's 8-second wait expires;
    // then "private" is read, written and acknowledged.
    await root!.settle();

    expect(privacyOf(playerA)).toBe("private");
    const acknowledged = versionOf(playerA);

    held.release();
    const answer = await held.answered;
    // THE AUDIT'S MEASUREMENT: it read "public" here. The old request has now
    // reached the server and been answered: it matched no row, and the row's
    // version did not move — a late commit would have moved it.
    expect(privacyOf(playerA)).toBe("private");
    expect(versionOf(playerA)).toBe(acknowledged);
    expect(answer).toEqual([]);
    expect(localChoice()).toBe("private");
    expect(await diskChoice()).toBe("private");
  }, 60_000);

  it("B-F3, one player: a local save held open does not send its older choice after the newer one", async () => {
    const handler = settingsHandler();
    disk.arm();
    const older = handler("public");
    await disk.reached;
    await root!.settle();
    expect(privacyOf(playerA)).toBe("public");

    await Promise.resolve(handler("private"));
    await root!.settle();
    expect(privacyOf(playerA)).toBe("private");
    const acknowledged = versionOf(playerA);
    const sent = patches.length;

    disk.release();
    await Promise.resolve(older);
    await root!.settle();

    // Before the repair the released save went on to sync "public".
    expect(privacyOf(playerA)).toBe("private");
    expect(versionOf(playerA)).toBe(acknowledged);
    expect(patches.length).toBe(sent);
    expect(localChoice()).toBe("private");
    // And it did not leave "public" on disk for the next launch to sync.
    expect(await diskChoice()).toBe("private");
  }, 60_000);

  it("B-F3, across players: A's Settings change never becomes a write for B", async () => {
    const handler = settingsHandler();
    disk.arm();
    const older = handler("public");
    await disk.reached;
    await root!.settle();
    expect(privacyOf(playerA)).toBe("public");

    // A real sign-in to B through the production store, replacing A.
    useAuthStore.getState().dispatch({ type: "EDIT_EMAIL", value: emailB });
    await useAuthStore.getState().signIn(password, playerA);
    expect(useAuthStore.getState().form.status.kind).toBe("signedIn");
    expect(shownPlayer()).toBe(playerB);
    await root!.settle();

    // B's own choice, through the same screen.
    await Promise.resolve(handler("private"));
    await root!.settle();
    expect(privacyOf(playerB)).toBe("private");
    const acknowledged = versionOf(playerB);
    const sent = patches.length;

    disk.release();
    await Promise.resolve(older);
    await root!.settle();

    // THE AUDIT'S MEASUREMENT: B read "public" here, written by A's callback.
    expect(privacyOf(playerB)).toBe("private");
    expect(versionOf(playerB)).toBe(acknowledged);
    expect(patches.length).toBe(sent);
    // A's choice stayed A's.
    expect(privacyOf(playerA)).toBe("public");
    // Nothing of A's leaked into what the device now holds.
    expect(shownPlayer()).toBe(playerB);
    expect(localChoice()).toBe("private");
    expect(await diskChoice()).toBe("private");
  }, 60_000);
});
