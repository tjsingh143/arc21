/**
 * The Refresh-B release blocker, against the real backend.
 *
 * The independent Astra audit reproduced this on September 27, 2026: player A
 * started a friend request, the gateway's session read was held across a real
 * password sign-in to player B, and `friend_requests` ended up holding a row
 * with **B as the sender**. The store's player scope discarded the reply, which
 * is precisely why nothing looked wrong — the screen was right and the database
 * was not.
 *
 * This is that reproduction, kept as a regression and inverted: real GoTrue,
 * real Postgres, real `@supabase/supabase-js`, the production friends store, the
 * production friends gateway and the production Auth adapter and store. The one
 * fault injected is the audit's — a single `getSession()` completion held open
 * across the switch. Nothing about the verdict, the credential or the database
 * result is simulated.
 *
 * It asserts on the DATABASE, because that is where the defect was. A test that
 * checked only the store's return value passed against the bug.
 *
 * The last case is the positive control, and it is not decoration: a harness
 * that can no longer write anything would satisfy every assertion above it while
 * proving nothing at all.
 */

import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createClient } from "@supabase/supabase-js";

import { stackUp } from "./stack-guard.js";
import { activeAuthAdapter, useAuthStore } from "../../src/features/auth/auth-store.js";
import { resetPlayerState } from "../../src/features/player/reset-player-state.js";
import { useFriendsStore } from "../../src/features/friends/friends-store.js";
import {
  setSupabaseAvailabilityForTests,
  type ArcSupabaseClient,
} from "../../src/lib/supabase/client.js";

const URL = "http://127.0.0.1:54321";
// Published local-only test keys, identical to the existing integration suites.
const ANON = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0";
const ADMIN_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU";

/**
 * `flowType: "pkce"` because `src/lib/supabase/client.ts` sets it deliberately.
 * A test client built on the SDK's default would prove a different mechanism
 * while looking like it proved this one.
 */
function sdk(): ArcSupabaseClient {
  const storage = new Map<string, string>();
  return createClient(URL, ANON, {
    auth: {
      flowType: "pkce",
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

const admin = createClient(URL, ADMIN_KEY, { auth: { persistSession: false, autoRefreshToken: false } });

/** The device that switches players: A signs in as B on this one client. */
const device = sdk();
/** The recipient, reading its own inbox with its own authenticated session. */
const recipient = sdk();

const created: string[] = [];
let playerA = "";
let playerB = "";
let target = "";
const email = `b-stale-identity-${randomUUID()}@arc21.test`;
const password = `Stale-${randomUUID()}!`;
let stopAuth: (() => void) | null = null;
let stopIdentity: (() => void) | null = null;

/** Rows in the recipient's inbox, read as the recipient. */
async function inboxOf(receiver: string): Promise<readonly { sender_id: string; status: string }[]> {
  const result = await recipient
    .from("friend_requests")
    .select("sender_id,receiver_id,status")
    .eq("receiver_id", receiver);
  expect(result.error).toBeNull();
  return (result.data ?? []) as readonly { sender_id: string; status: string }[];
}

const suite = stackUp ? describe : describe.skip;

suite("a social mutation cannot be committed as the replacement player", () => {
  beforeAll(async () => {
    const a = await device.auth.signInAnonymously();
    expect(a.error).toBeNull();
    playerA = a.data.user!.id;
    created.push(playerA);

    const c = await recipient.auth.signInAnonymously();
    expect(c.error).toBeNull();
    target = c.data.user!.id;
    created.push(target);

    // A secured player to switch TO. Created through the admin API rather than
    // through the securing flow, which `pseudonymous-identity` already proves:
    // what matters here is that the sign-in is a real GoTrue password sign-in.
    const b = await admin.auth.admin.createUser({ email, password, email_confirm: true });
    expect(b.error).toBeNull();
    playerB = b.data.user!.id;
    created.push(playerB);

    /*
     * The production wiring, as the app installs it. `usePlayerState` is a React
     * hook and cannot run here — it reaches expo-sqlite and the audio adapters
     * through Settings — so its identity-change body is installed directly: the
     * production auth store, the production adapter's own auth subscription, and
     * the production `resetPlayerState()` when the user id changes.
     */
    setSupabaseAvailabilityForTests({ status: "ready", client: device });
    const adapter = activeAuthAdapter();
    const snapshot = await adapter.getSession();
    expect(snapshot).toMatchObject({ ok: true });
    if (!snapshot.ok) throw new Error("the fixture player has no session");
    useAuthStore.setState({ session: snapshot.session, mode: "account", configured: true, hydrated: true });
    stopAuth = adapter.onAuthStateChange((session) => {
      useAuthStore.setState({ session, mode: session ? "account" : "guest" });
    });
    stopIdentity = useAuthStore.subscribe((next, previous) => {
      if ((next.session?.account.userId ?? null) === (previous.session?.account.userId ?? null)) return;
      resetPlayerState();
    });
    expect(useAuthStore.getState().session?.account.userId).toBe(playerA);
  });

  afterAll(async () => {
    stopIdentity?.();
    stopAuth?.();
    resetPlayerState();
    useAuthStore.setState({ session: null, mode: "guest" });
    setSupabaseAvailabilityForTests(null);
    for (const id of created) {
      const result = await admin.auth.admin.deleteUser(id);
      expect(result.error).toBeNull();
    }
  });

  it("writes no friend request at all when the account switches mid-dispatch", async () => {
    expect(await inboxOf(target)).toEqual([]);

    // The audit's one injected fault: hold a single `getSession()` completion.
    const original = device.auth.getSession.bind(device.auth);
    let release!: () => void;
    let reach!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const reached = new Promise<void>((resolve) => { reach = resolve; });
    let holdOnce = true;
    device.auth.getSession = async () => {
      const result = await original();
      if (holdOnce) { holdOnce = false; reach(); await gate; }
      return result;
    };

    const action = useFriendsStore.getState().sendRequest(target);
    await reached;
    expect(useAuthStore.getState().session?.account.userId).toBe(playerA);
    expect(useFriendsStore.getState().pending).toBe(target);

    // A real password sign-in through the production store and adapter, with A
    // named as the player being replaced.
    useAuthStore.getState().dispatch({ type: "EDIT_EMAIL", value: email });
    await useAuthStore.getState().signIn(password, playerA);
    expect(useAuthStore.getState().session?.account.userId).toBe(playerB);
    // The identity boundary has already cleared A's screen.
    expect(useFriendsStore.getState().pending).toBeNull();

    release();
    expect(await action).toBe(false);
    device.auth.getSession = original;

    /*
     * THE ASSERTION THE AUDIT FAILED ON. It read one pending row with B as the
     * sender. Empty is the only correct answer: A's intent was never B's to
     * send, and by the time it could have gone it was no longer A's dispatch
     * either — so neither id may appear.
     */
    expect(await inboxOf(target)).toEqual([]);

    // And the replacement player's own graph is untouched, read as B.
    const asB = await Promise.all([device.rpc("list_friends"), device.rpc("list_friend_requests")]);
    for (const result of asB) expect(result.error).toBeNull();
    expect(asB[0].data).toEqual([]);
    expect(asB[1].data).toEqual([]);

    // No stale UI survived the switch either.
    expect(useFriendsStore.getState()).toMatchObject({
      pending: null,
      actionError: null,
      status: { kind: "idle" },
      searchStatus: { kind: "idle" },
    });
  });

  it("still sends the replacement player's own request, as the replacement player", async () => {
    // The positive control. Same store, same gateway, same client — the only
    // difference is that nobody switched underneath it.
    expect(await useFriendsStore.getState().sendRequest(target)).toBe(true);
    expect(await inboxOf(target)).toEqual([{ sender_id: playerB, receiver_id: target, status: "pending" }]);
  });
});
