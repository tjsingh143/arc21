/**
 * Refresh-B blockers B-R1 to B-R4, on the wire: player A's work never leaves
 * the device as player B.
 *
 * The final Astra audit (September 29, 2026) found four stores whose requests
 * were not bound to the player who asked: matchmaking (queue, poll, cancel),
 * "Mark all read", cosmetic equip and the privacy sync. None of their RPCs name
 * a player, so the actor is whoever's JWT the SDK attaches as the request
 * leaves — and the audit held ONE `getSession()` BEFORE it read storage, signed
 * in as B, and released it: the SDK then read B's credential and B's queue
 * entry was cancelled, B's inbox marked read, B's loadout changed and B's
 * profile made public.
 *
 * Each case drives the PRODUCTION store through a real `@supabase/supabase-js`
 * client whose transport records every request, with the audit's injection:
 * one `getSession()` held before storage is read, the stored session swapped as
 * a sign-in swaps it, and the production `resetPlayerState()` at the identity
 * boundary (what `usePlayerState` calls). The assertion is on the WIRE — what
 * was sent, and with whose token. Each finding also has a positive control, and
 * the privacy sync has one for ordering: a player's own later choice must not be
 * overwritten by their own earlier one.
 *
 * `tests/server/stale-identity-player-state.integration.test.ts` proves the same
 * against real GoTrue and Postgres, with database readbacks for both players.
 */

import { afterEach, describe, expect, it } from "vitest";
import { createClient } from "@supabase/supabase-js";

import { resetPlayerState } from "../../src/features/player/reset-player-state.js";
import { useMatchmakingStore } from "../../src/features/matchmaking/matchmaking-store.js";
import { useNotificationsStore } from "../../src/features/notifications/notifications-store.js";
import { useCosmeticsStore } from "../../src/features/cosmetics/cosmetics-store.js";
import { syncProfilePrivacy } from "../../src/features/settings/profile-privacy.js";
import {
  setSupabaseAvailabilityForTests,
  type ArcSupabaseClient,
} from "../../src/lib/supabase/client.js";

const URL = "http://127.0.0.1:54321";
const STORAGE_KEY = "arc21-stale-player-state-test";
const PLAYER_A = "11111111-1111-4111-8111-111111111111";
const PLAYER_B = "22222222-2222-4222-8222-222222222222";
const COSMETIC = "55555555-5555-4555-8555-555555555555";

interface Sent {
  readonly method: string;
  readonly path: string;
  readonly authorization: string | null;
  readonly body: string | null;
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

/**
 * `before-read` is the audit's injection: the held lookup has not read storage
 * yet, so on release it reads whatever a sign-in left there. `after-read` holds
 * a lookup that already read player A — the shape the §12 repair was proved
 * against — and is used by the positive controls to show the credential is
 * pinned rather than re-read as the request leaves. `dispatch` holds the
 * SECOND lookup, before it reads storage: the one the SDK makes for the request
 * itself, after a store's own session check has already passed — the boundary
 * `queue()` had before the repair.
 */
type Hold = "before-read" | "after-read" | "dispatch";

interface Harness {
  readonly client: ArcSupabaseClient;
  readonly sent: Sent[];
  signInAs(userId: string, token: string): void;
  readonly reached: Promise<void>;
  release(): void;
}

function harness(hold: Hold, body: unknown = null): Harness {
  const storage = new Map<string, string>([[STORAGE_KEY, storedSession(PLAYER_A, "token-a")]]);
  const sent: Sent[] = [];
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
        const url = new globalThis.URL(String(input instanceof Request ? input.url : input));
        sent.push({
          method: init?.method ?? "GET",
          path: `${url.pathname}${url.search}`,
          authorization: new Headers(init?.headers).get("Authorization"),
          body: typeof init?.body === "string" ? init.body : null,
        });
        return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
      },
    },
  }) as ArcSupabaseClient;

  let release!: () => void;
  let reach!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const reached = new Promise<void>((resolve) => { reach = resolve; });
  const original = client.auth.getSession.bind(client.auth);
  let holdOnce = true;
  let lookups = 0;
  client.auth.getSession = async () => {
    lookups += 1;
    if (holdOnce && (hold === "before-read" || (hold === "dispatch" && lookups === 2))) {
      holdOnce = false;
      reach();
      await gate;
      return original();
    }
    const result = await original();
    if (holdOnce && hold === "after-read") {
      holdOnce = false;
      reach();
      await gate;
    }
    return result;
  };

  return {
    client,
    sent,
    signInAs: (userId, token) => { storage.set(STORAGE_KEY, storedSession(userId, token)); },
    reached,
    release,
  };
}

/** The account switch, in the order the app performs it. */
function switchTo(fixture: Harness, userId: string, token: string): void {
  fixture.signInAs(userId, token);
  resetPlayerState();
}

/** Who each call to one RPC was sent as. */
const rpcSentAs = (sent: readonly Sent[], name: string): readonly (string | null)[] =>
  sent.filter((request) => request.path.startsWith(`/rest/v1/rpc/${name}`)).map((request) => request.authorization);

/** Every write to `profiles`, with its target and its value, in order. */
const profileWrites = (sent: readonly Sent[]) =>
  sent
    .filter((request) => request.method === "PATCH" && request.path.startsWith("/rest/v1/profiles"))
    .map((request) => ({ path: request.path, authorization: request.authorization, body: request.body }));

afterEach(() => {
  resetPlayerState();
  setSupabaseAvailabilityForTests(null);
});

describe("B-R1: matchmaking is sent only as the player who asked", () => {
  it("never cancels the replacement player's search", async () => {
    const fixture = harness("before-read");
    setSupabaseAvailabilityForTests({ status: "ready", client: fixture.client });

    const cancelling = useMatchmakingStore.getState().cancel();
    await fixture.reached;
    switchTo(fixture, PLAYER_B, "token-b");
    fixture.release();
    await cancelling;

    // Before the repair: one `leave_matchmaking` carrying `Bearer token-b`.
    expect(rpcSentAs(fixture.sent, "leave_matchmaking")).toEqual([]);
    expect(useMatchmakingStore.getState().status).toEqual({ kind: "idle" });
  });

  it("never enrols the replacement player when the switch lands before the session is read", async () => {
    const fixture = harness("before-read", []);
    setSupabaseAvailabilityForTests({ status: "ready", client: fixture.client });

    const queueing = useMatchmakingStore.getState().queue("standard");
    await fixture.reached;
    switchTo(fixture, PLAYER_B, "token-b");
    fixture.release();
    await queueing;

    expect(rpcSentAs(fixture.sent, "join_matchmaking")).toEqual([]);
    expect(rpcSentAs(fixture.sent, "poll_matchmaking")).toEqual([]);
  });

  it("never enrols the replacement player when the switch lands as the request itself leaves", async () => {
    // Before the repair `queue()` checked the player after ITS OWN session read
    // and then let the SDK look the credential up again for the request — this
    // is that second lookup, held across the switch. It read B.
    const fixture = harness("dispatch", []);
    setSupabaseAvailabilityForTests({ status: "ready", client: fixture.client });

    const queueing = useMatchmakingStore.getState().queue("standard");
    await fixture.reached;
    switchTo(fixture, PLAYER_B, "token-b");
    fixture.release();
    await queueing;

    // Already dispatched as A, it stays A's: the pinned header is the one sent.
    expect(rpcSentAs(fixture.sent, "join_matchmaking")).toEqual(["Bearer token-a"]);
    // And the follow-up poll, for a player no longer on screen, never goes.
    expect(rpcSentAs(fixture.sent, "poll_matchmaking")).toEqual([]);
  });

  it("never polls — which can allocate a room — as the replacement player", async () => {
    const fixture = harness("before-read", []);
    setSupabaseAvailabilityForTests({ status: "ready", client: fixture.client });

    const polling = useMatchmakingStore.getState().poll();
    await fixture.reached;
    switchTo(fixture, PLAYER_B, "token-b");
    fixture.release();
    await polling;

    expect(rpcSentAs(fixture.sent, "poll_matchmaking")).toEqual([]);
  });

  it("queues, reads back and cancels as the dispatching player, with that player's own pinned token", async () => {
    const fixture = harness("after-read", []);
    setSupabaseAvailabilityForTests({ status: "ready", client: fixture.client });

    const queueing = useMatchmakingStore.getState().queue("standard");
    await fixture.reached;
    // A rotation the app has not been told about: same player, newer token.
    fixture.signInAs(PLAYER_A, "token-a-rotated");
    fixture.release();
    await queueing;
    await useMatchmakingStore.getState().cancel();

    expect(rpcSentAs(fixture.sent, "join_matchmaking")).toEqual(["Bearer token-a"]);
    // The follow-up poll rides on the SAME binding as the enrolment.
    expect(rpcSentAs(fixture.sent, "poll_matchmaking")).toEqual(["Bearer token-a"]);
    expect(rpcSentAs(fixture.sent, "leave_matchmaking")).toEqual(["Bearer token-a-rotated"]);
  });
});

describe("B-R2: Mark all read is sent only as the player who tapped it", () => {
  it("never marks the replacement player's inbox read, and reloads nothing for them", async () => {
    const fixture = harness("before-read", 1);
    setSupabaseAvailabilityForTests({ status: "ready", client: fixture.client });

    const marking = useNotificationsStore.getState().markAllRead();
    await fixture.reached;
    switchTo(fixture, PLAYER_B, "token-b");
    fixture.release();
    await marking;

    // Before the repair: `p_ids: null` sent as B — every unread row of B's.
    expect(rpcSentAs(fixture.sent, "mark_notifications_read")).toEqual([]);
    expect(rpcSentAs(fixture.sent, "my_notifications")).toEqual([]);
    expect(useNotificationsStore.getState().busy).toBe(false);
  });

  it("marks the dispatching player's own inbox, then reloads it, as that player", async () => {
    const fixture = harness("after-read", []);
    setSupabaseAvailabilityForTests({ status: "ready", client: fixture.client });

    const marking = useNotificationsStore.getState().markAllRead();
    await fixture.reached;
    fixture.signInAs(PLAYER_A, "token-a-rotated");
    fixture.release();
    await marking;

    expect(rpcSentAs(fixture.sent, "mark_notifications_read")).toEqual(["Bearer token-a"]);
    const marked = fixture.sent.find((request) => request.path.startsWith("/rest/v1/rpc/mark_notifications_read"));
    expect(JSON.parse(marked!.body!)).toEqual({ p_ids: null });
    expect(rpcSentAs(fixture.sent, "my_notifications")).toEqual(["Bearer token-a-rotated"]);
  });
});

describe("B-R3: a cosmetic is equipped only on the player who chose it", () => {
  it("never equips the replacement player, and refreshes nothing for them", async () => {
    const fixture = harness("before-read", null);
    setSupabaseAvailabilityForTests({ status: "ready", client: fixture.client });

    const equipping = useCosmeticsStore.getState().equip(COSMETIC);
    await fixture.reached;
    switchTo(fixture, PLAYER_B, "token-b");
    fixture.release();
    await equipping;

    // Ownership is not identity: B owning the same default item is exactly why
    // the server accepted it before the repair.
    expect(rpcSentAs(fixture.sent, "equip_cosmetic")).toEqual([]);
    expect(rpcSentAs(fixture.sent, "my_inventory")).toEqual([]);
    expect(rpcSentAs(fixture.sent, "my_loadout")).toEqual([]);
    expect(useCosmeticsStore.getState()).toMatchObject({ busy: false, notice: null });
  });

  it("equips the dispatching player's own choice with that player's pinned token", async () => {
    const fixture = harness("after-read", null);
    setSupabaseAvailabilityForTests({ status: "ready", client: fixture.client });

    const equipping = useCosmeticsStore.getState().equip(COSMETIC);
    await fixture.reached;
    fixture.signInAs(PLAYER_A, "token-a-rotated");
    fixture.release();
    await equipping;

    expect(rpcSentAs(fixture.sent, "equip_cosmetic")).toEqual(["Bearer token-a"]);
    // The follow-up reloads are the same player's.
    expect(rpcSentAs(fixture.sent, "my_inventory").length).toBe(1);
    expect(rpcSentAs(fixture.sent, "my_loadout").length).toBe(1);
  });
});

/**
 * The row version the privacy write replaces. The sync reads it, then writes
 * only while the row is still that version (Refresh-B B-F1), so the fake server
 * answers both the read and the returned representation with one row.
 */
const VERSION = "2026-09-30T00:00:00.000001+00:00";
const PROFILE_ROW = [{ updated_at: VERSION }];

/** A conditional write's exact target: the player's own row, at the version read. */
const conditionalWrite = (player: string): string =>
  `/rest/v1/profiles?${new URLSearchParams([["id", `eq.${player}`], ["updated_at", `eq.${VERSION}`], ["select", "updated_at"]])}`;

describe("B-R4: a privacy choice is written only to the player who made it", () => {
  it("never writes the previous player's choice onto the replacement player's profile", async () => {
    const fixture = harness("before-read", PROFILE_ROW);
    setSupabaseAvailabilityForTests({ status: "ready", client: fixture.client });

    const stale = syncProfilePrivacy("public");
    await fixture.reached;
    switchTo(fixture, PLAYER_B, "token-b");
    // B's own current choice lands first, exactly as the root hook would send it.
    expect(await syncProfilePrivacy("private")).toEqual({ status: "written", privacy: "private" });
    fixture.release();

    expect(await stale).toEqual({ status: "skipped", reason: "identity-changed" });
    // Before the repair A's "public" followed, on B's row, as B.
    expect(profileWrites(fixture.sent)).toEqual([
      { path: conditionalWrite(PLAYER_B), authorization: "Bearer token-b", body: JSON.stringify({ privacy: "private" }) },
    ]);
  });

  it("writes one player's choices in the order they were made, each to that player's own row", async () => {
    const fixture = harness("before-read", PROFILE_ROW);
    setSupabaseAvailabilityForTests({ status: "ready", client: fixture.client });

    // The earlier choice's session read is slow; the later one is not.
    const earlier = syncProfilePrivacy("public");
    await fixture.reached;
    const later = syncProfilePrivacy("private");
    // Unordered, "private" would be written now and then overwritten.
    expect(profileWrites(fixture.sent)).toEqual([]);
    fixture.release();

    expect(await earlier).toEqual({ status: "written", privacy: "public" });
    expect(await later).toEqual({ status: "written", privacy: "private" });
    expect(profileWrites(fixture.sent)).toEqual([
      { path: conditionalWrite(PLAYER_A), authorization: "Bearer token-a", body: JSON.stringify({ privacy: "public" }) },
      { path: conditionalWrite(PLAYER_A), authorization: "Bearer token-a", body: JSON.stringify({ privacy: "private" }) },
    ]);
  });
});
