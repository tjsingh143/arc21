/**
 * B-H1 — account-owned server work waits for the server to confirm the player.
 *
 * The final independent Refresh-B re-audit (October 4, 2026) cold-launched over
 * a valid player's credential with only that device's `/auth/v1/user` failing.
 * The Auth store correctly showed nobody (`bootstrap: unavailable`, `NETWORK`)
 * — and Inventory's `load()` granted four cosmetics, Daily's `load()` became
 * `ready`, and Daily's start action opened a RANKED game, every request sent as
 * the restored player nobody had confirmed. Each store had asked the SDK, not
 * the app, whether somebody was signed in, and the SDK serves a restored
 * credential before anybody has asked the server about it.
 *
 * Here: the production Auth store and adapter over a real
 * `@supabase/supabase-js` client and the PRODUCTION storage factory, with the
 * native keychain doubled and GoTrue, PostgREST and the Edge Functions answered
 * by a recording fake. The question each test asks is about the WIRE: was
 * anything account-owned sent as the restored player before the server
 * confirmed it? `tests/server/confirmation-gate.integration.test.ts` asks the
 * same of the real backend and reads the answer out of Postgres.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createClient, processLock } from "@supabase/supabase-js";

import { disposeAuthSubscription, setGuestIdentityStore, useAuthStore } from "../../src/features/auth/auth-store.js";
import { initialAuthFormState } from "../../src/features/auth/auth-machine.js";
import { GuestIdentityStore } from "../../src/features/auth/guest.js";
import { useAccountProfileStore } from "../../src/features/auth/account-profile-store.js";
import { useCareerServerStore } from "../../src/features/career/career-server-store.js";
import { useCosmeticsStore } from "../../src/features/cosmetics/cosmetics-store.js";
import { useLoadoutStore } from "../../src/features/cosmetics/loadout-store.js";
import { useDailyStore } from "../../src/features/daily/daily-store.js";
import { useFriendsStore } from "../../src/features/friends/friends-store.js";
import { useLeaderboardStore } from "../../src/features/leaderboards/leaderboards-store.js";
import { useMatchmakingStore } from "../../src/features/matchmaking/matchmaking-store.js";
import { useNotificationsStore } from "../../src/features/notifications/notifications-store.js";
import { resetPlayerState } from "../../src/features/player/reset-player-state.js";
import { usePresenceStore } from "../../src/features/presence/presence-store.js";
import { setQuickPlayStorage, useQuickPlayStore } from "../../src/features/quick-play/quick-play-store.js";
import { useRoomsStore } from "../../src/features/rooms/rooms-store.js";
import { syncProfilePrivacy } from "../../src/features/settings/profile-privacy.js";
import { useCompetitionStore } from "../../src/features/stats/competition-store.js";
import { useLevelStore } from "../../src/features/stats/level-store.js";
import { useActiveSessionStore } from "../../src/features/table/active-session-store.js";
import { useTournamentStore } from "../../src/features/tournament/tournament-store.js";
import { useWalletStore } from "../../src/features/wallet/wallet-store.js";
import { MemoryKeyValueStore } from "../../src/lib/persistence/key-value-store.js";
import { publishAdoptedPlayer, UnadoptedCredentialError } from "../../src/lib/supabase/adopted-player.js";
import {
  buildAvailability,
  setSupabaseAvailabilityForTests,
  type ArcSupabaseClient,
} from "../../src/lib/supabase/client.js";
import {
  ChunkedSecureSessionStorage,
  createSecureSessionStorage,
  type SecureStoreLike,
} from "../../src/lib/supabase/secure-session-storage.js";

const native = vi.hoisted(() => ({ entries: new Map<string, string>() }));

vi.mock("expo-secure-store", () => ({
  WHEN_UNLOCKED_THIS_DEVICE_ONLY: "WHEN_UNLOCKED_THIS_DEVICE_ONLY",
  getItemAsync: async (key: string) => native.entries.get(key) ?? null,
  setItemAsync: async (key: string, value: string) => { native.entries.set(key, value); },
  deleteItemAsync: async (key: string) => { native.entries.delete(key); },
}));

const URL = "http://127.0.0.1:54321";
const KEY = "test-anon-key";
const SESSION_KEY = "sb-127-auth-token";
const PLAYER_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const PLAYER_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const STRANGER = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";

/** An unsigned token in a real JWT's shape: the dispatch floor reads `sub` out of it. */
function jwtFor(userId: string): string {
  const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${part({ alg: "HS256", typ: "JWT" })}.${part({ sub: userId, role: "authenticated", exp: 4_102_444_800 })}.signature`;
}
const TOKEN_A = jwtFor(PLAYER_A);
const subjectOf = (authorization: string | null): string | null => {
  const payload = authorization?.replace(/^Bearer /, "").split(".")[1];
  if (payload === undefined) return null;
  try {
    return (JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { sub?: string }).sub ?? null;
  } catch {
    return null;
  }
};

function sessionFor(userId: string): Record<string, unknown> {
  return {
    access_token: jwtFor(userId),
    token_type: "bearer",
    refresh_token: `refresh-${userId}`,
    expires_in: 3600,
    expires_at: Math.floor(Date.now() / 1000) + 3600,
    user: { id: userId, aud: "authenticated", role: "authenticated", is_anonymous: true, app_metadata: {}, user_metadata: {}, created_at: "2026-10-04T00:00:00.000Z" },
  };
}

interface Sent {
  readonly method: string;
  readonly path: string;
  readonly as: string | null;
}

const server = {
  verify: "answers" as "answers" | "offline" | "held",
  held: null as Promise<void> | null,
};

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "x-supabase-api-version": "2024-01-01" } });

const TODAY = new Date().toISOString().slice(0, 10);
const CHALLENGE = {
  id: "11111111-1111-4111-8111-111111111111",
  challenge_date: TODAY,
  seed_commitment: "a".repeat(64),
  revealed_seed: null,
  hand_count: 20,
  starting_chips: 5000,
  reward_chips: 500,
  reward_xp: 50,
  closes_at: `${TODAY}T23:59:59Z`,
};

/** What the backend answers, by path: enough for every store to reach `ready`. */
async function answer(path: string, init: RequestInit | undefined, as: string | null): Promise<Response> {
  if (path === "/auth/v1/user") {
    if (server.verify === "offline") throw new TypeError("Network request failed");
    if (server.verify === "held") await server.held;
    return as === null ? json({ code: "bad_jwt", message: "invalid" }, 403) : json((sessionFor(as) as { user: unknown }).user);
  }
  if (path.startsWith("/auth/v1/")) return new Response(null, { status: 204 });
  switch (path) {
    case "/rest/v1/rpc/grant_earned_cosmetics": return json(4);
    case "/rest/v1/rpc/ensure_todays_daily_challenge": return json(CHALLENGE);
    case "/rest/v1/rpc/my_daily_entry": return json([]);
    case "/rest/v1/rpc/latest_verifiable_daily_challenge": return json(null);
    case "/functions/v1/create-session": {
      const body = JSON.parse(String(init?.body ?? "{}")) as { action?: string };
      return body.action === "START_DAILY_CHALLENGE"
        ? json({ gameId: "22222222-2222-4222-8222-222222222222", seatId: "33333333-3333-4333-8333-333333333333", ranked: true })
        : json({ status: "rejected", code: "INVALID_COMMAND", message: "Not in this test." }, 400);
    }
    default: return json([]);
  }
}

function transport(sent: Sent[]) {
  return async (input: RequestInfo | globalThis.URL, init?: RequestInit): Promise<Response> => {
    const url = new globalThis.URL(String(input instanceof Request ? input.url : input));
    const as = subjectOf(new Headers(init?.headers).get("Authorization"));
    sent.push({ method: init?.method ?? "GET", path: url.pathname, as });
    return answer(url.pathname, init, as);
  };
}

function device(sent: Sent[]): ArcSupabaseClient {
  return createClient(URL, KEY, {
    auth: { storage: createSecureSessionStorage(), persistSession: true, autoRefreshToken: false, detectSessionInUrl: false, flowType: "pkce", lock: processLock },
    global: { fetch: transport(sent) },
  }) as ArcSupabaseClient;
}

async function store(player: string): Promise<void> {
  const keychain = (await import("expo-secure-store")) as unknown as SecureStoreLike;
  await new ChunkedSecureSessionStorage(keychain, { keychainAccessible: "WHEN_UNLOCKED_THIS_DEVICE_ONLY" })
    .setItem(SESSION_KEY, JSON.stringify(sessionFor(player)));
}

async function launchOn(client: ArcSupabaseClient): Promise<void> {
  disposeAuthSubscription();
  setSupabaseAvailabilityForTests({ status: "ready", client });
  setGuestIdentityStore(new GuestIdentityStore(new MemoryKeyValueStore()));
  useAuthStore.setState({
    hydrated: false, session: null, mode: "unknown", guest: null, form: initialAuthFormState("signIn"),
    bootstrapStatus: "idle", bootstrapFailure: null, automaticBootstrap: true,
  });
  await useAuthStore.getState().hydrate();
}

const shownPlayer = (): string | null => useAuthStore.getState().session?.account.userId ?? null;
/** Everything sent as `player` that is not the auth server's own business. */
const accountWork = (sent: readonly Sent[], player: string): Sent[] =>
  sent.filter((request) => request.as === player && !request.path.startsWith("/auth/v1/"));

/** Every startup-reachable account-owned load AND the screens' own first actions. */
async function everyAccountOwnedOperation(): Promise<void> {
  await useCosmeticsStore.getState().load();
  await useCosmeticsStore.getState().equip("default-avatar");
  await useLoadoutStore.getState().load();
  await useDailyStore.getState().load();
  await useDailyStore.getState().start();
  await useLevelStore.getState().load();
  await useCompetitionStore.getState().load();
  await useAccountProfileStore.getState().load();
  await useNotificationsStore.getState().load();
  await useNotificationsStore.getState().markAllRead();
  await useLeaderboardStore.getState().select("weekly_xp");
  await useTournamentStore.getState().load();
  await useTournamentStore.getState().register();
  await useCareerServerStore.getState().refresh();
  await useCareerServerStore.getState().start("first-deal");
  await useActiveSessionStore.getState().refresh();
  await useQuickPlayStore.getState().open({ tier: "casual", assistance: "play" });
  await useWalletStore.getState().refresh();
  await useWalletStore.getState().claim();
  await useFriendsStore.getState().refresh();
  useFriendsStore.getState().setQuery("ab");
  await useFriendsStore.getState().search();
  await useFriendsStore.getState().sendRequest(STRANGER);
  await useMatchmakingStore.getState().queue("casual");
  await useRoomsStore.getState().createRoom(2);
  await syncProfilePrivacy("private");
  usePresenceStore.getState().join(PLAYER_A, "available");
  usePresenceStore.getState().setOwnState("in_game");
  // Let any fire-and-forget request (the presence heartbeat) reach the wire.
  await new Promise((resolve) => setTimeout(resolve, 20));
}

beforeEach(() => {
  native.entries.clear();
  server.verify = "answers";
  server.held = null;
  setQuickPlayStorage(new MemoryKeyValueStore());
  resetPlayerState();
});

afterEach(() => {
  usePresenceStore.getState().leave();
  disposeAuthSubscription();
  resetPlayerState();
  useAuthStore.setState({ session: null, mode: "guest" });
  setGuestIdentityStore(null);
  setSupabaseAvailabilityForTests(null);
  setQuickPlayStorage(null);
  vi.unstubAllGlobals();
});

describe("B-H1: nothing account-owned is sent as a player the server has not confirmed", () => {
  it("THE AUDIT'S REPRODUCTION, inverted: /user unreachable — Inventory and Daily send nothing as the restored player and are never ready", async () => {
    await store(PLAYER_A);
    server.verify = "offline";
    const sent: Sent[] = [];
    await launchOn(device(sent));
    expect(shownPlayer()).toBeNull();
    expect(useAuthStore.getState().bootstrapFailure?.code).toBe("NETWORK");

    await useCosmeticsStore.getState().load();
    await useDailyStore.getState().load();
    const opened = await useDailyStore.getState().start();

    // The audit: Inventory `ready` with 4 granted, Daily `ready`, a ranked game opened.
    expect(useCosmeticsStore.getState().status.kind).not.toBe("ready");
    expect(useCosmeticsStore.getState().newlyGranted).toBe(0);
    expect(useDailyStore.getState().status.kind).not.toBe("ready");
    expect(opened).toBeNull();
    expect(accountWork(sent, PLAYER_A)).toEqual([]);

    // Confirmation succeeds: the same production operations now work, as A.
    server.verify = "answers";
    await useAuthStore.getState().ensurePlayer();
    expect(shownPlayer()).toBe(PLAYER_A);
    await useCosmeticsStore.getState().load();
    await useDailyStore.getState().load();
    const ranked = await useDailyStore.getState().start();
    expect(useCosmeticsStore.getState()).toMatchObject({ status: { kind: "ready" }, newlyGranted: 4 });
    expect(useDailyStore.getState().status.kind).toBe("ready");
    expect(ranked).toMatchObject({ ranked: true });
    expect(accountWork(sent, PLAYER_A).map((request) => request.path)).toEqual(expect.arrayContaining([
      "/rest/v1/rpc/grant_earned_cosmetics",
      "/rest/v1/rpc/ensure_todays_daily_challenge",
      "/functions/v1/create-session",
    ]));
  });

  it("while verification is still IN FLIGHT, no store a startup screen can reach — load or action — sends anything as the restored player", async () => {
    await store(PLAYER_A);
    let answerNow!: () => void;
    server.verify = "held";
    server.held = new Promise<void>((resolve) => { answerNow = resolve; });
    const sent: Sent[] = [];
    const launch = launchOn(device(sent));
    await vi.waitFor(() => expect(sent.some((request) => request.path === "/auth/v1/user")).toBe(true));
    expect(shownPlayer()).toBeNull();

    await everyAccountOwnedOperation();

    expect(accountWork(sent, PLAYER_A)).toEqual([]);
    expect(useCosmeticsStore.getState().status.kind).not.toBe("ready");
    expect(useDailyStore.getState().status.kind).not.toBe("ready");
    expect(useWalletStore.getState().status.kind).not.toBe("ready");

    answerNow();
    await launch;
    expect(shownPlayer()).toBe(PLAYER_A);
    // Positive control: confirmed, the same sweep reaches the server as A.
    await everyAccountOwnedOperation();
    expect(accountWork(sent, PLAYER_A).length).toBeGreaterThan(10);
  });
});

describe("B-H1: the production client's dispatch floor", () => {
  async function productionClient(sent: Sent[]): Promise<ArcSupabaseClient> {
    vi.stubGlobal("fetch", transport(sent));
    const availability = buildAvailability({ status: "configured", url: URL, publishableKey: KEY });
    if (availability.status !== "ready") throw new Error("the production client was not built");
    return availability.client;
  }

  it("refuses to send account-owned work as a credential nobody adopted, and lets the auth server's own endpoints through", async () => {
    await store(PLAYER_A);
    const sent: Sent[] = [];
    const client = await productionClient(sent);
    publishAdoptedPlayer(client, null);

    const refused = await client.rpc("grant_earned_cosmetics");
    expect(refused.error?.message).toContain(new UnadoptedCredentialError().name);
    const opened = await client.functions.invoke("create-session", { body: { action: "START_DAILY_CHALLENGE" } });
    expect(opened.error).not.toBeNull();
    expect(accountWork(sent, PLAYER_A)).toEqual([]);

    // The auth server is where confirmation happens: never blocked.
    await client.auth.getUser(TOKEN_A);
    expect(sent.filter((request) => request.path === "/auth/v1/user")).toHaveLength(1);
  });

  it("sends as the adopted player; still lets a departing player's bound request finish; never a player nobody adopted", async () => {
    await store(PLAYER_A);
    const sent: Sent[] = [];
    const client = await productionClient(sent);

    publishAdoptedPlayer(client, PLAYER_A);
    expect((await client.rpc("grant_earned_cosmetics")).error).toBeNull();
    expect(accountWork(sent, PLAYER_A).map((request) => request.path)).toEqual(["/rest/v1/rpc/grant_earned_cosmetics"]);

    // B is adopted next; A's retirement, already bound to A, must still finish.
    publishAdoptedPlayer(client, PLAYER_B);
    const departing = await client.rpc("retire_push_token", { p_token: "ExponentPushToken[x]", p_revision: 1 }).setHeader("Authorization", `Bearer ${TOKEN_A}`);
    expect(departing.error).toBeNull();
    // A credential nobody adopted on this client never leaves.
    const stranger = await client.rpc("grant_earned_cosmetics").setHeader("Authorization", `Bearer ${jwtFor(STRANGER)}`);
    expect(stranger.error?.message).toContain("UnadoptedCredentialError");
    const malformed = await client.rpc("grant_earned_cosmetics").setHeader("Authorization", "Bearer not-a-jwt");
    expect(malformed.error?.message).toContain("UnadoptedCredentialError");
    expect(sent.filter((request) => request.as === STRANGER)).toEqual([]);
    publishAdoptedPlayer(client, null);
  });

  it("a request carrying only the publishable key is not account-owned and is sent", async () => {
    const sent: Sent[] = [];
    const client = await productionClient(sent);
    publishAdoptedPlayer(client, null);
    expect((await client.rpc("sprint_format")).error).toBeNull();
    expect(sent.map((request) => request.path)).toContain("/rest/v1/rpc/sprint_format");
  });
});
