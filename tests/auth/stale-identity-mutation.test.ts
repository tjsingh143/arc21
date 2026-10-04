/**
 * A mutation belongs to the player who asked for it — Refresh B blocker.
 *
 * The independent Astra audit reproduced this against the real backend: player A
 * started a friend request, the gateway's `getSession()` was held across a real
 * sign-in to player B, and the row arrived in the database with **B as the
 * sender**. The store noticed the player had changed and threw the *reply* away,
 * so nothing on screen was wrong and the database was. Discarding a result
 * cannot undo a row.
 *
 * So these tests are deliberately NOT written against a fake gateway. That is
 * what the superseded test did, and a fake gateway cannot have the defect: the
 * bug lives in which credential the real SDK attaches to a real request. Each
 * case here drives
 *
 *   the production store → the production gateway → a real `@supabase/supabase-js`
 *   client → a transport that records every request,
 *
 * with the SDK's own stored session swapped mid-flight exactly as a sign-in
 * swaps it, and the production `resetPlayerState()` at the identity boundary —
 * which is what `usePlayerState` calls when the auth store's user id changes.
 * The assertion is on the WIRE: what was sent, and with whose token. A test that
 * asserted the store's return value would have passed against the defect, which
 * is how it survived.
 *
 * `tests/server/stale-identity-social.integration.test.ts` is the same proof
 * against real GoTrue and real Postgres, including the readback that shows no
 * row was written for either player.
 *
 * The recovery grant is here as well as the social writes. It was found by asking
 * which OTHER calls have the audited shape — a held session read, then an RPC
 * that names no player — and it is the one that moves chips, so the consequence
 * of getting it wrong is a wallet credit nobody earned.
 */

import { afterEach, describe, expect, it } from "vitest";
import { createClient } from "@supabase/supabase-js";

import { resetPlayerState } from "../../src/features/player/reset-player-state.js";
import { setFriendsGateway, useFriendsStore } from "../../src/features/friends/friends-store.js";
import { setWalletGateway, useWalletStore } from "../../src/features/wallet/wallet-store.js";
import { setRoomsGateway, useRoomsStore } from "../../src/features/rooms/rooms-store.js";
import { useRoomInvites } from "../../src/features/rooms/use-room-invites.js";
import {
  setSupabaseAvailabilityForTests,
  type ArcSupabaseClient,
} from "../../src/lib/supabase/client.js";

const URL = "http://127.0.0.1:54321";
const STORAGE_KEY = "arc21-stale-identity-test";

const PLAYER_A = "11111111-1111-4111-8111-111111111111";
const PLAYER_B = "22222222-2222-4222-8222-222222222222";
const TARGET_C = "33333333-3333-4333-8333-333333333333";
const ROOM = "44444444-4444-4444-8444-444444444444";

interface Sent {
  readonly url: string;
  readonly authorization: string | null;
}

/**
 * A session the SDK will hand out without asking anybody.
 *
 * `getSession()` reads storage and returns what it finds while the expiry is in
 * the future, so no GoTrue is involved and the only network this harness sees is
 * the request under test. The token string is a label, not a credential: nothing
 * here verifies it, and the server tier is where a real JWT is proved.
 */
function storedSession(userId: string, token: string): string {
  return JSON.stringify({
    access_token: token,
    token_type: "bearer",
    refresh_token: `refresh-${userId}`,
    expires_in: 3600,
    expires_at: Math.floor(Date.now() / 1000) + 3600,
    user: {
      id: userId,
      aud: "authenticated",
      role: "authenticated",
      app_metadata: {},
      user_metadata: {},
      created_at: "2026-01-01T00:00:00.000Z",
    },
  });
}

interface Harness {
  readonly client: ArcSupabaseClient;
  /** Every request the SDK actually issued, in order. */
  readonly sent: Sent[];
  /** Replace the stored session, as a sign-in on the shared client does. */
  signInAs(userId: string, token: string): void;
  /** Resolves when the held `getSession()` has been reached. */
  readonly reached: Promise<void>;
  /** Lets the held `getSession()` return. */
  release(): void;
}

function harness(body: unknown = null): Harness {
  const storage = new Map<string, string>();
  const sent: Sent[] = [];
  storage.set(STORAGE_KEY, storedSession(PLAYER_A, "token-a"));

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
      fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
        sent.push({
          url: String(input instanceof Request ? input.url : input),
          authorization: new Headers(init?.headers).get("Authorization"),
        });
        return new Response(JSON.stringify(body), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    },
  }) as ArcSupabaseClient;

  // THE ONLY FAULT INJECTED, and it is the audit's: one `getSession()`
  // completion is held open across the account switch. Everything else — the
  // store, the gateway, the SDK, the credential choice — is production code.
  let release!: () => void;
  let reach!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const reached = new Promise<void>((resolve) => { reach = resolve; });
  const original = client.auth.getSession.bind(client.auth);
  let holdOnce = true;
  client.auth.getSession = async () => {
    const result = await original();
    if (holdOnce) {
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

/**
 * Who each call to one RPC was sent as.
 *
 * The tokens rather than the request objects, so a failure NAMES the sender:
 * `[ 'Bearer token-b' ]` against `[]` is the defect in one line, where a
 * collapsed object would only have said a request went out.
 */
const sentAsFor = (sent: readonly Sent[], name: string): readonly (string | null)[] =>
  sent
    .filter((request) => request.url.endsWith(`/rest/v1/rpc/${name}`))
    .map((request) => request.authorization);

afterEach(() => {
  resetPlayerState();
  setFriendsGateway(null);
  setRoomsGateway(null);
  setWalletGateway(null);
  useRoomInvites.getState().reset();
  setSupabaseAvailabilityForTests(null);
});

describe("a player-scoped mutation is bound to the player who dispatched it", () => {
  it("never sends player A's friend request as replacement player B", async () => {
    const fixture = harness("outgoing_pending");
    setSupabaseAvailabilityForTests({ status: "ready", client: fixture.client });

    const action = useFriendsStore.getState().sendRequest(TARGET_C);
    await fixture.reached;
    expect(useFriendsStore.getState().pending).toBe(TARGET_C);

    // The account switch, in the order the app performs it: the shared client
    // now holds B, and the identity boundary has invalidated A's player scope.
    fixture.signInAs(PLAYER_B, "token-b");
    resetPlayerState();

    fixture.release();
    expect(await action).toBe(false);

    // THE ASSERTION THAT MATTERS. Before the repair this was one request
    // carrying `Bearer token-b`, and the database held a request from B.
    expect(sentAsFor(fixture.sent, "send_friend_request")).toEqual([]);
    // And no reload was attributed to either player either.
    expect(sentAsFor(fixture.sent, "list_friends")).toEqual([]);
    // Nothing of A's survives on the new player's screen.
    expect(useFriendsStore.getState()).toMatchObject({
      pending: null,
      actionError: null,
      status: { kind: "idle" },
    });
  });

  it("sends an uninterrupted friend request with the dispatching player's own pinned token", async () => {
    const fixture = harness("outgoing_pending");
    setSupabaseAvailabilityForTests({ status: "ready", client: fixture.client });

    const action = useFriendsStore.getState().sendRequest(TARGET_C);
    await fixture.reached;
    /*
     * A token rotation the app has NOT been told about — a refresh, or a sign-in
     * whose auth event has not been delivered yet. The player has not changed, so
     * the request must still go, and it must go as the player who asked: the
     * pinned header is what stops the SDK reading the newer token out of storage
     * as the request leaves.
     */
    fixture.signInAs(PLAYER_A, "token-a-rotated");
    fixture.release();
    expect(await action).toBe(true);

    expect(sentAsFor(fixture.sent, "send_friend_request")).toEqual(["Bearer token-a"]);
  });

  it("never joins or opens a private table as the replacement player", async () => {
    const fixture = harness({ id: ROOM, code: "ABCD23", host_user_id: PLAYER_A, max_seats: 2, status: "lobby", game_session_id: null });
    setSupabaseAvailabilityForTests({ status: "ready", client: fixture.client });

    useRoomsStore.getState().setCodeInput("ABCD23");
    const joining = useRoomsStore.getState().joinRoom();
    await fixture.reached;
    fixture.signInAs(PLAYER_B, "token-b");
    resetPlayerState();
    fixture.release();
    await joining;

    // `join_private_room` names no player at all, so an unbound one would have
    // seated B at a code B never typed.
    expect(sentAsFor(fixture.sent, "join_private_room")).toEqual([]);
    expect(useRoomsStore.getState().status).toEqual({ kind: "idle" });
    expect(useRoomsStore.getState().codeInput).toBe("");
  });

  it("never claims a recovery grant into the replacement player's wallet", async () => {
    const fixture = harness({ balance_after: 25_000 });
    setSupabaseAvailabilityForTests({ status: "ready", client: fixture.client });

    const claiming = useWalletStore.getState().claim();
    await fixture.reached;
    fixture.signInAs(PLAYER_B, "token-b");
    resetPlayerState();
    fixture.release();
    expect(await claiming).toBe(false);

    // `claim_recovery_grant()` names no player and MOVES CHIPS. Sent as B it
    // would credit a wallet nobody earned and spend B's cooldown.
    expect(sentAsFor(fixture.sent, "claim_recovery_grant")).toEqual([]);
    expect(useWalletStore.getState().grantNotice).toBeNull();
  });

  it("never sends a room invitation as the replacement player", async () => {
    const fixture = harness(null);
    setSupabaseAvailabilityForTests({ status: "ready", client: fixture.client });

    const inviting = useRoomInvites.getState().invite(ROOM, TARGET_C);
    await fixture.reached;
    fixture.signInAs(PLAYER_B, "token-b");
    resetPlayerState();
    fixture.release();
    await inviting;

    // An invite writes a notification into somebody else's inbox.
    expect(sentAsFor(fixture.sent, "invite_friend_to_room")).toEqual([]);
    expect(useRoomInvites.getState().invited).toEqual([]);
  });
});
