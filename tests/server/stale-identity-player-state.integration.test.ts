/**
 * Refresh-B blockers B-R1 to B-R4, against the real backend.
 *
 * The final Astra audit (September 29, 2026) reproduced four wrong-player
 * writes with the same injection: player A starts an action, ONE SDK credential
 * lookup is held before it reads storage, a real password sign-in switches the
 * device to player B, and the lookup is released. It then read B's credential:
 *
 *   B-R1  A's matchmaking cancel cancelled B's search; A's stayed waiting.
 *   B-R2  A's "Mark all read" marked B's inbox; A's stayed unread.
 *   B-R3  A's cosmetic equip changed B's loadout (both owned the item).
 *   B-R4  A's delayed "public" overwrote B's newer "private".
 *
 * These are those reproductions, kept and inverted: real GoTrue, real Postgres,
 * `@supabase/supabase-js` with `client.ts`'s PKCE and `processLock`, the
 * production Auth store hydrated through its own `hydrate()`, the production
 * adapter's sign-in, the production `resetPlayerState()` at the identity
 * boundary, and the production stores under test. The assertions are DATABASE
 * readbacks for BOTH players, then the client state, then a positive control
 * in which the replacement player's own uninterrupted action still works.
 *
 * A and B are secured players so the device can switch back and forth; which
 * kind of player A is has no bearing on whose credential a request carries, and
 * `credential-replacement.integration.test.ts` keeps the unlinked case.
 *
 * A SKIP IS NOT A PASS. `npm run test:server` sets ARC21_REQUIRE_SERVER_STACK.
 */

import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
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
import { useMatchmakingStore } from "../../src/features/matchmaking/matchmaking-store.js";
import { useNotificationsStore } from "../../src/features/notifications/notifications-store.js";
import { useCosmeticsStore } from "../../src/features/cosmetics/cosmetics-store.js";
import { DEFAULT_LOADOUT, useLoadoutStore } from "../../src/features/cosmetics/loadout-store.js";
import { syncProfilePrivacy } from "../../src/features/settings/profile-privacy.js";
import {
  setSupabaseAvailabilityForTests,
  type ArcSupabaseClient,
} from "../../src/lib/supabase/client.js";

const URL = "http://127.0.0.1:54321";
// Published local-only test keys, identical to the existing integration suites.
const ANON = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0";
const ADMIN_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU";

const admin = createClient(URL, ADMIN_KEY, { auth: { persistSession: false, autoRefreshToken: false } });

/** `client.ts`'s auth options over an in-memory store; no timer outlives the file. */
function sdk(): ArcSupabaseClient {
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
  }) as ArcSupabaseClient;
}

/** Readbacks straight from the database; THROWS when it cannot run. */
function database(sql: string): string {
  return execFileSync(
    "docker",
    ["exec", "supabase_db_arc21", "psql", "-U", "postgres", "-d", "postgres", "-X", "-v", "ON_ERROR_STOP=1", "-Atc", sql],
    { encoding: "utf8" },
  ).trim();
}

/** One value per player, keyed A and B so a failure names whose it was. */
function perPlayer(sql: (player: string) => string): { A: string; B: string } {
  return { A: database(sql(playerA)), B: database(sql(playerB)) };
}

const created: string[] = [];
const device = sdk();
const peerA = sdk();
const peerB = sdk();
const sender = sdk();
let playerA = "";
let playerB = "";
const emailA = `stale-a-${randomUUID()}@arc21.test`;
const emailB = `stale-b-${randomUUID()}@arc21.test`;
const emailS = `stale-sender-${randomUUID()}@arc21.test`;
const password = `Stale-${randomUUID()}!`;
let stopIdentity: (() => void) | null = null;

async function createSecured(email: string): Promise<string> {
  const result = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  expect(result.error).toBeNull();
  created.push(result.data.user!.id);
  return result.data.user!.id;
}

/** A fixture call that must succeed; untyped because fixtures span many RPCs. */
async function rpc(client: ArcSupabaseClient, name: string, args?: Record<string, unknown>): Promise<unknown> {
  const untyped = client as unknown as {
    rpc(fn: string, params?: Record<string, unknown>): PromiseLike<{ data: unknown; error: unknown }>;
  };
  const result = await untyped.rpc(name, args);
  expect(result.error).toBeNull();
  return result.data;
}

const visiblePlayer = (): string | null => useAuthStore.getState().session?.account.userId ?? null;

/** A real password sign-in through the production store, naming who it replaces. */
async function signInOnDevice(email: string, replacing: string): Promise<void> {
  useAuthStore.getState().dispatch({ type: "EDIT_EMAIL", value: email });
  await useAuthStore.getState().signIn(password, replacing);
  expect(useAuthStore.getState().form.status.kind).toBe("signedIn");
}

async function deviceIsA(): Promise<void> {
  if (visiblePlayer() !== playerA) await signInOnDevice(emailA, playerB);
  expect(visiblePlayer()).toBe(playerA);
}

/**
 * THE AUDIT'S ONE INJECTION: hold a single `getSession()` before it reads
 * storage, sign the device in as B, run whatever B does next, then release.
 *
 * `lookup` picks WHICH lookup is held: the first (the audit's), or the second —
 * the one the SDK makes for the request itself, after a store's own session
 * check has passed, which is where `queue()`'s gap was before the repair.
 */
async function acrossSwitchToB<T>(
  start: () => Promise<T>,
  whileB?: () => Promise<void>,
  lookup: 1 | 2 = 1,
): Promise<T> {
  const original = device.auth.getSession.bind(device.auth);
  let release!: () => void;
  let reach!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const reached = new Promise<void>((resolve) => { reach = resolve; });
  let lookups = 0;
  device.auth.getSession = async () => {
    lookups += 1;
    if (lookups === lookup) {
      reach();
      await gate;
    }
    return original();
  };
  try {
    const action = start();
    await reached;
    expect(visiblePlayer()).toBe(playerA);
    await signInOnDevice(emailB, playerA);
    expect(visiblePlayer()).toBe(playerB);
    await whileB?.();
    release();
    return await action;
  } finally {
    device.auth.getSession = original;
  }
}

const suite = stackUp ? describe : describe.skip;

suite("player A's delayed action cannot change replacement player B", () => {
  beforeAll(async () => {
    playerA = await createSecured(emailA);
    playerB = await createSecured(emailB);
    await createSecured(emailS);
    for (const [client, email] of [[peerA, emailA], [peerB, emailB], [sender, emailS], [device, emailA]] as const) {
      expect((await client.auth.signInWithPassword({ email, password })).error).toBeNull();
    }

    // The app starting with A restored, through the production store's own
    // `hydrate()` — which installs the production adapter's auth listener.
    setSupabaseAvailabilityForTests({ status: "ready", client: device });
    setGuestIdentityStore(new GuestIdentityStore(new MemoryKeyValueStore()));
    useAuthStore.setState({ hydrated: false, session: null, mode: "unknown", guest: null, form: initialAuthFormState("signIn") });
    await useAuthStore.getState().hydrate();
    expect(visiblePlayer()).toBe(playerA);
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
    for (const client of [device, peerA, peerB, sender]) await client.realtime.disconnect();
    for (const id of created) {
      const result = await admin.auth.admin.deleteUser(id);
      expect(result.error).toBeNull();
    }
  });

  describe("B-R1 matchmaking", () => {
    /*
     * The `standard` tier, and no poll by either fixture player: a poll can
     * ALLOCATE a room from the shared pool other files use, so a player who
     * never polls stays exactly where this file put them.
     */
    const liveEntries = () =>
      perPlayer((player) =>
        `select coalesce(string_agg(status::text, ',' order by enqueued_at), 'none') from public.matchmaking_queue
         where user_id = '${player}'::uuid and status in ('waiting', 'matched')`);

    it("does not cancel B's search when A's cancel resumes after the switch", async () => {
      await deviceIsA();
      await rpc(peerA, "join_matchmaking", { p_tier: "standard" });
      await rpc(peerB, "join_matchmaking", { p_tier: "standard" });
      expect(liveEntries()).toEqual({ A: "waiting", B: "waiting" });

      await acrossSwitchToB(() => useMatchmakingStore.getState().cancel());

      // The audit read B: cancelled, A: waiting. A's intent was never B's, and
      // by the time it could be sent it was no longer A's dispatch either.
      expect(liveEntries()).toEqual({ A: "waiting", B: "waiting" });
      expect(useMatchmakingStore.getState().status).toEqual({ kind: "idle" });

      // Positive control: B's own cancel, uninterrupted, cancels only B's.
      await useMatchmakingStore.getState().cancel();
      expect(liveEntries()).toEqual({ A: "waiting", B: "none" });
      await rpc(peerA, "leave_matchmaking");
      expect(liveEntries()).toEqual({ A: "none", B: "none" });
    });

    it("does not enrol B when A's queue request resumes after the switch", async () => {
      await deviceIsA();
      await acrossSwitchToB(() => useMatchmakingStore.getState().queue("standard"));

      expect(liveEntries()).toEqual({ A: "none", B: "none" });
      expect(useMatchmakingStore.getState().status).toEqual({ kind: "idle" });
    });

    it("keeps A's already-dispatched enrolment A's when the switch lands as it leaves", async () => {
      await deviceIsA();
      // The SDK's own lookup for the request, held across the switch. Before the
      // repair it read B and enrolled B, who had asked for nothing.
      await acrossSwitchToB(() => useMatchmakingStore.getState().queue("standard"), undefined, 2);

      // Pinned to A, it enrols A — the player who asked — and never B; and the
      // follow-up poll, which could allocate a room, is not sent for anybody.
      expect(liveEntries()).toEqual({ A: "waiting", B: "none" });
      expect(useMatchmakingStore.getState().status).toEqual({ kind: "idle" });
      await rpc(peerA, "leave_matchmaking");
    });
  });

  describe("B-R2 Mark all read", () => {
    const unread = () =>
      perPlayer((player) => `select count(*) from public.notifications where user_id = '${player}'::uuid and read_at is null`);

    it("does not consume B's inbox when A's Mark all read resumes after the switch", async () => {
      await deviceIsA();
      await rpc(sender, "send_friend_request", { p_to: playerA });
      await rpc(sender, "send_friend_request", { p_to: playerB });
      expect(unread()).toEqual({ A: "1", B: "1" });

      await acrossSwitchToB(() => useNotificationsStore.getState().markAllRead());

      // The audit read A unread, B read.
      expect(unread()).toEqual({ A: "1", B: "1" });
      // A's follow-up reload did not run into B's screen.
      expect(useNotificationsStore.getState().status).toEqual({ kind: "loading" });

      // Positive control: B's own Mark all read, then B's own reload.
      await useNotificationsStore.getState().markAllRead();
      expect(unread()).toEqual({ A: "1", B: "0" });
      const inbox = useNotificationsStore.getState();
      expect(inbox.unread).toBe(0);
      expect(inbox.status.kind).toBe("ready");
      if (inbox.status.kind === "ready") expect(inbox.status.rows.length).toBe(1);
    });
  });

  describe("B-R3 cosmetic equip", () => {
    const avatars = () =>
      perPlayer((player) =>
        `select coalesce((select avatar_cosmetic_id::text from public.loadouts where user_id = '${player}'::uuid), 'none')`);

    it("does not change B's loadout when A's equip resumes after the switch, although B owns the item too", async () => {
      await deviceIsA();
      await rpc(peerA, "grant_earned_cosmetics");
      await rpc(peerB, "grant_earned_cosmetics");
      const inventory = (await rpc(peerA, "my_inventory")) as { id?: string; cosmetic_id?: string; kind?: string; owned?: boolean }[];
      const item = inventory.find((row) => row.owned === true && row.kind === "avatar") ?? inventory.find((row) => row.owned === true);
      expect(item).toBeDefined();
      const itemId = (item!.cosmetic_id ?? item!.id)!;
      // Ownership is not identity: B legitimately owns the same item.
      const ownedByB = (await rpc(peerB, "my_inventory")) as { id?: string; cosmetic_id?: string; owned?: boolean }[];
      expect(ownedByB.some((row) => (row.cosmetic_id ?? row.id) === itemId && row.owned === true)).toBe(true);
      const before = avatars();
      expect(before.B).not.toBe(itemId);

      await acrossSwitchToB(() => useCosmeticsStore.getState().equip(itemId));

      // The audit read B's avatar set to the item, A's unchanged.
      expect(avatars()).toEqual(before);
      // A's follow-up reloads did not run into B's screen.
      expect(useCosmeticsStore.getState()).toMatchObject({ status: { kind: "loading" }, busy: false, notice: null });
      expect(useLoadoutStore.getState().loadout).toEqual(DEFAULT_LOADOUT);

      // Positive control: B's own equip changes B's loadout and nothing else.
      await useCosmeticsStore.getState().equip(itemId);
      expect(avatars()).toEqual({ A: before.A, B: itemId });
      expect(useCosmeticsStore.getState().status.kind).toBe("ready");
    });
  });

  describe("B-R4 privacy", () => {
    const privacy = () =>
      perPlayer((player) => `select privacy::text from public.profiles where id = '${player}'::uuid`);

    it("does not overwrite B's newer choice with A's delayed one", async () => {
      await deviceIsA();
      expect((await peerA.from("profiles").update({ privacy: "private" }).eq("id", playerA)).error).toBeNull();
      expect((await peerB.from("profiles").update({ privacy: "private" }).eq("id", playerB)).error).toBeNull();
      expect(privacy()).toEqual({ A: "private", B: "private" });

      const stale = await acrossSwitchToB(
        () => syncProfilePrivacy("public"),
        // B's current choice lands first, as the root hook sends it on sign-in.
        async () => {
          expect(await syncProfilePrivacy("private")).toEqual({ status: "written", privacy: "private" });
        },
      );

      expect(stale).toEqual({ status: "skipped", reason: "identity-changed" });
      // The audit read A private, B PUBLIC — statistics B's choice hides, exposed.
      expect(privacy()).toEqual({ A: "private", B: "private" });
    });

    it("still writes one player's choices in the order they were made, to that player's own row", async () => {
      // Positive control for the same player, B: the earlier choice's session
      // read is slow and the later one's is not; the later choice must win.
      expect(visiblePlayer()).toBe(playerB);
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
        const earlier = syncProfilePrivacy("public");
        await reached;
        const later = syncProfilePrivacy("friends");
        release();
        expect(await earlier).toEqual({ status: "written", privacy: "public" });
        expect(await later).toEqual({ status: "written", privacy: "friends" });
      } finally {
        device.auth.getSession = original;
      }
      expect(privacy()).toEqual({ A: "private", B: "friends" });
    });
  });
});
