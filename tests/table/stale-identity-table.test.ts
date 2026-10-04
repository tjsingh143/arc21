/**
 * A TABLE operation belongs to the player who asked for it — Refresh B blocker.
 *
 * `tests/auth/stale-identity-mutation.test.ts` proves this for the social, room
 * and wallet RPCs. The repair that produced it deliberately EXEMPTED
 * `online-table-gateway.ts`, on the argument that a table command names a
 * `gameId` and the server refuses a caller with no seat there — so a replacement
 * player could not mutate anything through it.
 *
 * The independent Astra re-audit reproduced the hole in that argument against the
 * real backend: **a multiplayer table has more than one participant.** Player A
 * and player B both held active 5,000-chip seats in one private game. A's Leave
 * was held at its session read, a real password sign-in switched the app to B,
 * and releasing A's work cashed out **B** — B's seat `left`, B's stack 0, A still
 * `active`. The store then discarded the reply, which is exactly why nothing on
 * screen was wrong. `NOT_A_PARTICIPANT` never fired because B *was* a
 * participant, and the `gameId:seatId` idempotency key the server derived was
 * B's, so it protected nothing of A's.
 *
 * So these tests are written the same way as the social ones and for the same
 * reason: NOT against a fake gateway. A fake gateway cannot have this defect,
 * because the bug is in which credential the real SDK attaches to a real
 * request. Each case drives
 *
 *   the production online-table store → the production table gateway →
 *   a real `@supabase/supabase-js` client → a transport that records every request
 *
 * and asserts on the WIRE: which requests left, and with whose token. A test that
 * asserted the store's return value would have passed against the defect — the
 * store returned `false` in the audit's own reproduction.
 *
 * Two things are fixtures rather than production code, and both are stated
 * plainly. The store is seated by `setState` rather than by `enter()`, because
 * `enter()` also opens a Realtime socket and a unit test that talks to a live
 * websocket is a load-dependent test. And the backoff policy is shortened
 * through the gateway's own `policy` option, so the retry cases do not sleep.
 * `tests/server/stale-identity-table.integration.test.ts` is the same proof with
 * neither fixture: real GoTrue, real Postgres, real seats in one real game, and
 * `enter()`/`leaveTable()` end to end.
 */

import { afterEach, describe, expect, it } from "vitest";
import { createClient } from "@supabase/supabase-js";

import { resetPlayerState } from "../../src/features/player/reset-player-state.js";
import {
  createSupabaseTableGateway,
  setTableGateway,
  useOnlineTableStore,
} from "../../src/features/table/index.js";
import { setWalletGateway, useWalletStore } from "../../src/features/wallet/wallet-store.js";
import {
  setSupabaseAvailabilityForTests,
  type ArcSupabaseClient,
} from "../../src/lib/supabase/client.js";
import type { PublicGameState } from "../../shared/blackjack/index.js";

const URL = "http://127.0.0.1:54321";
const STORAGE_KEY = "arc21-stale-identity-table-test";

const PLAYER_A = "11111111-1111-4111-8111-111111111111";
const PLAYER_B = "22222222-2222-4222-8222-222222222222";
const GAME = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
/** A's seat. */
const SEAT_A = "seat-a";
/** B's seat AT THE SAME TABLE — the whole point of the reproduction. */
const SEAT_B = "seat-b";

/** Fast enough that a retry case costs a millisecond, using the gateway's own knob. */
const FAST_BACKOFF = { attempts: 3, baseDelayMs: 1, maxDelayMs: 1 } as const;

interface Sent {
  readonly url: string;
  readonly authorization: string | null;
  readonly body: Record<string, unknown> | null;
}

/** A session the SDK will hand out from storage without asking anybody. */
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

/**
 * A table with BOTH players seated, which is the state the audit needed.
 *
 * `legalActions` gives A everything it needs to act, so the store's own
 * affordance checks do not stop a command before the gateway is reached — a test
 * whose command never leaves the store would assert nothing about credentials.
 */
function seatedTable(overrides: Partial<PublicGameState> = {}): PublicGameState {
  const legal = {
    actions: ["HIT", "STAND"],
    chipCost: {},
    canPlaceBet: true,
    canLockBet: false,
    betBounds: { min: 20, max: 500, increment: 10 },
    canTakeInsurance: false,
    canDeclineInsurance: false,
    insuranceStake: null,
    insuranceIsEvenMoney: false,
    canStartNextHand: true,
  };
  return {
    gameId: GAME,
    version: 7,
    phase: "BETTING_OPEN",
    rulesSummary: {
      deckCount: 6,
      dealerHitsSoft17: false,
      blackjackPayout: "3:2",
      surrenderAllowed: true,
      doubleAfterSplit: true,
    },
    handNumber: 1,
    seats: [
      {
        seatId: SEAT_A,
        userId: PLAYER_A,
        displayName: "A",
        stack: 5_000,
        originalBet: 0,
        insuranceBet: 0,
        hands: [],
        connected: true,
        sittingOut: false,
        betLocked: false,
      },
      {
        seatId: SEAT_B,
        userId: PLAYER_B,
        displayName: "B",
        stack: 5_000,
        originalBet: 0,
        insuranceBet: 0,
        hands: [],
        connected: true,
        sittingOut: false,
        betLocked: false,
      },
    ],
    dealer: { cards: [], displayedTotal: null, holeCardRevealed: false },
    activeSeatId: null,
    activeHandId: null,
    deadlineAt: null,
    shoe: { shuffleNumber: 1, approximateRemainingDecks: 6 },
    legalActions: { [SEAT_A]: legal, [SEAT_B]: legal },
    ...overrides,
  } as PublicGameState;
}

interface Harness {
  readonly client: ArcSupabaseClient;
  /** Every request the SDK actually issued, in order. */
  readonly sent: Sent[];
  /** Replace the stored session, as a sign-in on the shared client does. */
  signInAs(userId: string, token: string): void;
  /** The account switch exactly as the app performs it. */
  switchToB(): void;
  /** Resolves when the held `getSession()` has been reached. */
  readonly reached: Promise<void>;
  /** Lets the held `getSession()` return. */
  release(): void;
}

/**
 * The recording transport.
 *
 * `onRequest` is the seam the retry cases use: it runs with the request already
 * recorded and can switch the account and/or make the attempt fail, which is how
 * an identity change lands *between* two attempts of one intent without any
 * timing at all.
 */
function harness(options: {
  readonly onRequest?: (request: Sent, fixture: Harness) => "fail" | void;
} = {}): Harness {
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
        const url = String(input instanceof Request ? input.url : input);
        let body: Record<string, unknown> | null = null;
        if (typeof init?.body === "string") {
          try { body = JSON.parse(init.body) as Record<string, unknown>; } catch { body = null; }
        }
        const request: Sent = {
          url,
          authorization: new Headers(init?.headers).get("Authorization"),
          body,
        };
        sent.push(request);
        if (options.onRequest?.(request, fixture) === "fail") {
          // Exactly what a dropped connection looks like to the SDK: no verdict,
          // so the gateway's retry predicate says "ask again".
          throw new TypeError("network request failed");
        }
        return new Response(JSON.stringify(answerFor(body)), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    },
  }) as ArcSupabaseClient;

  // THE ONLY TIMING FAULT INJECTED, and it is the audit's: one `getSession()`
  // completion held open across the account switch. Everything else — the store,
  // the gateway, the SDK, the credential choice — is production code.
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

  const fixture: Harness = {
    client,
    sent,
    signInAs: (userId, token) => { storage.set(STORAGE_KEY, storedSession(userId, token)); },
    switchToB: () => {
      // The order the app uses: the shared client holds B, and the identity
      // boundary (`usePlayerState` → `resetPlayerState`) invalidates A's scope.
      storage.set(STORAGE_KEY, storedSession(PLAYER_B, "token-b"));
      resetPlayerState();
    },
    reached,
    release,
  };
  return fixture;
}

/** What the server would answer, keyed on what was asked. */
function answerFor(body: Record<string, unknown> | null): unknown {
  if (body?.action === "CASH_OUT") {
    return { status: "cashed_out", gameId: GAME, returned: 5_000, walletBalance: 30_000 };
  }
  if (body?.action === "RESET_PRIVATE_STACK") {
    return { status: "stack_reset", publicState: seatedTable({ version: 8 }), events: [] };
  }
  return { status: "accepted", publicState: seatedTable({ version: 8 }), events: [] };
}

/** Who each call to one Edge Function was sent as. */
const sentAsFor = (sent: readonly Sent[], fn: string): readonly (string | null)[] =>
  sent
    .filter((request) => request.url.includes(`/functions/v1/${fn}`))
    .map((request) => request.authorization);

/** The subset of one function's calls that named a given session action. */
const sentAsForAction = (sent: readonly Sent[], action: string): readonly (string | null)[] =>
  sent
    .filter((request) => request.body?.action === action)
    .map((request) => request.authorization);

const sentAsForCommand = (sent: readonly Sent[], type: string): readonly (string | null)[] =>
  sent
    .filter((request) => request.body?.type === type)
    .map((request) => request.authorization);

/** Seats the store at the shared table, as A. See the header on why not `enter()`. */
function seatStoreAsA(): void {
  useOnlineTableStore.setState({
    status: { kind: "at-table", state: seatedTable(), seatId: SEAT_A },
    connection: { kind: "live" },
    pending: false,
    stagedBet: 0,
    lastBet: 0,
    notice: null,
    lastAppliedSeq: 0,
    timeoutAskedForVersion: null,
    timeoutAskedAt: null,
    leavingWhenSafe: false,
  });
}

function install(fixture: Harness, policy?: typeof FAST_BACKOFF): void {
  setSupabaseAvailabilityForTests({ status: "ready", client: fixture.client });
  // The PRODUCTION gateway. `policy` is its own option, and only the retry cases
  // pass one — see the header.
  setTableGateway(
    createSupabaseTableGateway(fixture.client, policy ? { policy } : {}),
  );
  seatStoreAsA();
}

afterEach(() => {
  resetPlayerState();
  setTableGateway(null);
  setWalletGateway(null);
  setSupabaseAvailabilityForTests(null);
});

describe("a table operation is bound to the player who dispatched it", () => {
  it("never cashes out the replacement player who shares the table", async () => {
    const fixture = harness();
    install(fixture);

    const leaving = useOnlineTableStore.getState().leaveTable();
    await fixture.reached;
    expect(useOnlineTableStore.getState().pending).toBe(true);

    fixture.switchToB();
    fixture.release();
    // The store's own post-response guard. It was already correct, and it was
    // never the protection: it discards a reply, and a reply is not a row.
    expect(await leaving).toBe(false);

    // THE ASSERTION THAT MATTERS. Before the repair this was one request
    // carrying `Bearer token-b`, and the server closed B's seat.
    expect(sentAsForAction(fixture.sent, "CASH_OUT")).toEqual([]);
    expect(sentAsFor(fixture.sent, "create-session")).toEqual([]);
    // Nothing at all left as B — including the wallet refresh a successful
    // cash-out would have triggered.
    expect(fixture.sent.filter((request) => request.authorization === "Bearer token-b")).toEqual([]);
    // And no stale table state survived into the new player's app.
    expect(useOnlineTableStore.getState().status).toEqual({ kind: "idle" });
    expect(useOnlineTableStore.getState().notice).toBeNull();
    expect(useOnlineTableStore.getState().pending).toBe(false);
    expect(useWalletStore.getState()).toEqual(useWalletStore.getInitialState());
  });

  it("cashes an uninterrupted leave out with the dispatching player's own pinned token", async () => {
    const fixture = harness();
    install(fixture);

    const leaving = useOnlineTableStore.getState().leaveTable();
    await fixture.reached;
    /*
     * A token rotation the app has NOT been told about — a refresh, or a sign-in
     * whose auth event has not been delivered yet. The PLAYER has not changed, so
     * the cash-out must still go, and it must go as the player who asked for it:
     * the pinned header is what stops the SDK reading the newer token out of
     * storage as the request leaves. This is the case that proves the pin rather
     * than just the gate.
     */
    fixture.signInAs(PLAYER_A, "token-a-rotated");
    fixture.release();
    expect(await leaving).toBe(true);

    expect(sentAsForAction(fixture.sent, "CASH_OUT")).toEqual(["Bearer token-a"]);
  });

  it("never sends a game command as the replacement player", async () => {
    const fixture = harness();
    install(fixture);

    const acting = useOnlineTableStore.getState().nextHand();
    await fixture.reached;
    fixture.switchToB();
    fixture.release();
    await acting;

    // `game-command` takes a gameId and no player. B is seated here, so the
    // server would have found B's seat and acted on B's hand.
    expect(sentAsFor(fixture.sent, "game-command")).toEqual([]);
    expect(useOnlineTableStore.getState().status).toEqual({ kind: "idle" });
  });

  it("never resets the replacement player's private stack", async () => {
    const fixture = harness();
    install(fixture);

    const resetting = useOnlineTableStore.getState().resetStack();
    await fixture.reached;
    fixture.switchToB();
    fixture.release();
    await resetting;

    // `RESET_PRIVATE_STACK` names only the game. Sent as B it would refill B's
    // seat to the ruleset figure and spend B's one free reset.
    expect(sentAsForAction(fixture.sent, "RESET_PRIVATE_STACK")).toEqual([]);
    expect(useOnlineTableStore.getState().status).toEqual({ kind: "idle" });
  });
});

describe("a retry stays bound to the player who started the intent", () => {
  it("abandons a retried game command rather than repeating it as the replacement player", async () => {
    let switched = false;
    const fixture: Harness = harness({
      onRequest: (request, self) => {
        if (request.body?.type !== "NEXT_HAND" || switched) return;
        switched = true;
        // The account switch lands BETWEEN the two attempts of one intent — the
        // window a check made once before the loop would not have seen.
        self.switchToB();
        return "fail";
      },
    });
    install(fixture, FAST_BACKOFF);

    // The first attempt is the one held and released; nothing needs the gate.
    fixture.release();
    await useOnlineTableStore.getState().nextHand();

    // Exactly ONE request, carrying the player who asked. The retry refused
    // locally instead of presenting A's `clientActionId` under B's JWT.
    expect(sentAsForCommand(fixture.sent, "NEXT_HAND")).toEqual(["Bearer token-a"]);
    expect(fixture.sent.filter((request) => request.authorization === "Bearer token-b")).toEqual([]);
  });

  it("abandons a retried stack reset rather than repeating it as the replacement player", async () => {
    let switched = false;
    const fixture: Harness = harness({
      onRequest: (request, self) => {
        if (request.body?.action !== "RESET_PRIVATE_STACK" || switched) return;
        switched = true;
        self.switchToB();
        return "fail";
      },
    });
    install(fixture, FAST_BACKOFF);

    fixture.release();
    await useOnlineTableStore.getState().resetStack();

    expect(sentAsForAction(fixture.sent, "RESET_PRIVATE_STACK")).toEqual(["Bearer token-a"]);
    expect(fixture.sent.filter((request) => request.authorization === "Bearer token-b")).toEqual([]);
  });

  it("keeps a retried command on the SAME player and the SAME action id when nobody switches", async () => {
    let failed = false;
    const fixture = harness({
      onRequest: (request) => {
        if (request.body?.type !== "NEXT_HAND" || failed) return;
        failed = true;
        // A token rotation with no player change, exactly as above: the retry
        // must still go, and still as A.
        fixture.signInAs(PLAYER_A, "token-a-rotated");
        return "fail";
      },
    });
    install(fixture, FAST_BACKOFF);

    fixture.release();
    await useOnlineTableStore.getState().nextHand();

    const attempts = fixture.sent.filter((request) => request.body?.type === "NEXT_HAND");
    expect(attempts.map((request) => request.authorization)).toEqual([
      "Bearer token-a",
      "Bearer token-a",
    ]);
    // A retry is the SAME request. A fresh id here is how a retried bet becomes
    // two bets, and a fresh credential is how it becomes somebody else's.
    expect(attempts[0]?.body?.clientActionId).toBe(attempts[1]?.body?.clientActionId);
  });
});
