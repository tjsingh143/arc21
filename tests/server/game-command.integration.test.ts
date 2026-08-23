/**
 * Integration tests against the REAL Edge Functions and the REAL database.
 *
 * Everything here was first proved by hand against the running stack; this file
 * exists so it stays proved. The defects these cover were live in this
 * repository:
 *
 *   - a `jsonb` double-encoding bug that made EVERY game command return 500,
 *     after `create-session` had already debited a buy-in;
 *   - a `create-session` replay returning 500 instead of the first result.
 *
 * Both were invisible to unit tests, because nothing exercised the function.
 *
 * These SKIP rather than fail when the local stack is not running, so a machine
 * without Docker still gets a green suite — but a skip is not a pass, and the
 * suite prints why. To run them:
 *
 *   supabase start
 *   supabase functions serve --no-verify-jwt
 */

import crypto from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";

import { stackUp } from "./stack-guard.js";

const FUNCTIONS = "http://127.0.0.1:54321/functions/v1";
const AUTH_ADMIN = "http://127.0.0.1:54321/auth/v1/admin/users";

/**
 * The published local-development secret and service key from `supabase start`.
 * They are identical on every machine and grant nothing anywhere else — a real
 * project's keys must never appear in a test file.
 */
const LOCAL_JWT_SECRET = "super-secret-jwt-token-with-at-least-32-characters-long";
const LOCAL_SERVICE_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU";

const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");

function signToken(sub: string, overrides: Record<string, unknown> = {}): string {
  const header = b64({ alg: "HS256", typ: "JWT" });
  const now = Math.floor(Date.now() / 1000);
  const payload = b64({
    sub,
    role: "authenticated",
    aud: "authenticated",
    iat: now,
    exp: now + 3600,
    ...overrides,
  });
  const signature = crypto
    .createHmac("sha256", LOCAL_JWT_SECRET)
    .update(`${header}.${payload}`)
    .digest("base64url");
  return `${header}.${payload}.${signature}`;
}

interface CallResult {
  status: number;
  body: Record<string, unknown>;
  raw: string;
}

async function call(fn: string, token: string | null, body: unknown): Promise<CallResult> {
  const response = await fetch(`${FUNCTIONS}/${fn}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
  const raw = await response.text();
  let parsed: Record<string, unknown> = {};
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    parsed = {};
  }
  return { status: response.status, body: parsed, raw };
}

async function createUser(): Promise<string> {
  const response = await fetch(AUTH_ADMIN, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: LOCAL_SERVICE_KEY,
      Authorization: `Bearer ${LOCAL_SERVICE_KEY}`,
    },
    body: JSON.stringify({
      email: `it-${crypto.randomUUID()}@arc21.test`,
      password: crypto.randomUUID(),
      email_confirm: true,
    }),
  });
  const json = (await response.json()) as { id?: string };
  if (!json.id) throw new Error(`could not create a test user: ${response.status}`);
  return json.id;
}

const suite = stackUp ? describe : describe.skip;

const iso = () => new Date().toISOString();

suite("authentication boundary", () => {
  let userId = "";
  beforeAll(async () => {
    userId = await createUser();
  });

  it("rejects a request with no token", async () => {
    const result = await call("game-command", null, {});
    expect(result.status).toBe(401);
    expect(result.body.code).toBe("UNAUTHENTICATED");
  });

  it("rejects a forged signature", async () => {
    const header = b64({ alg: "HS256", typ: "JWT" });
    const payload = b64({
      sub: userId,
      role: "authenticated",
      aud: "authenticated",
      exp: Math.floor(Date.now() / 1000) + 3600,
    });
    const forged = crypto
      .createHmac("sha256", "not-the-real-secret")
      .update(`${header}.${payload}`)
      .digest("base64url");
    const result = await call("game-command", `${header}.${payload}.${forged}`, {});
    expect(result.status).toBe(401);
  });

  it("rejects an expired token beyond the clock-skew tolerance", async () => {
    // Well past the allowance: a token expired by only a few seconds is
    // deliberately still accepted, so this uses an hour to test the rule
    // rather than the tolerance.
    const result = await call("game-command", signToken(userId, {
      exp: Math.floor(Date.now() / 1000) - 3600,
    }), {});
    expect(result.status).toBe(401);
  });

  it("rejects alg:none", async () => {
    const unsigned = `${b64({ alg: "none", typ: "JWT" })}.${b64({
      sub: userId,
      role: "authenticated",
      aud: "authenticated",
      exp: Math.floor(Date.now() / 1000) + 3600,
    })}.`;
    expect((await call("game-command", unsigned, {})).status).toBe(401);
  });

  it("rejects the anon role", async () => {
    // The publishable key ships inside the app bundle. If a token carrying
    // role "anon" were accepted, that key would be a player credential.
    expect((await call("game-command", signToken(userId, { role: "anon" }), {})).status).toBe(401);
  });

  it("rejects a wrong audience and a non-uuid subject", async () => {
    expect((await call("game-command", signToken(userId, { aud: "service_role" }), {})).status).toBe(401);
    expect((await call("game-command", signToken("not-a-uuid"), {})).status).toBe(401);
  });

  it("never leaks internals in an error", async () => {
    const result = await call("game-command", signToken(userId), { nonsense: true });
    expect(result.status).toBe(400);
    // Generic message plus a correlation ref that matches a server log line.
    expect(result.raw).not.toMatch(/select |insert |relation |pg_|postgres/i);
    expect(result.raw).not.toMatch(/at .*\(.*:\d+:\d+\)/); // stack frame
  });
});

suite("session lifecycle and idempotency", () => {
  let userId = "";
  let token = "";

  beforeAll(async () => {
    userId = await createUser();
    token = signToken(userId);
  });

  it("opens a session, debits the buy-in once, and leaks no hidden state", async () => {
    const opened = await call("create-session", token, {
      action: "OPEN",
      clientRequestId: crypto.randomUUID(),
      tier: "casual",
      clientSentAt: iso(),
    });

    expect(opened.status).toBe(200);
    expect(opened.body.status).toBe("opened");
    expect(opened.body.buyIn).toBe(2_000);
    // The opening grant is 25,000; a casual buy-in takes 2,000 of it.
    expect(opened.body.walletBalance).toBe(23_000);

    // The public snapshot must never carry the shoe's card identities.
    expect(opened.raw).not.toMatch(/"cards":\[\{"id"/);
    const publicState = opened.body.publicState as Record<string, unknown>;
    const shoe = publicState.shoe as Record<string, unknown>;
    expect(Object.keys(shoe)).not.toContain("cards");
    expect(Object.keys(shoe)).not.toContain("nextIndex");
  });

  it("returns the first committed result when a session open is replayed", async () => {
    // A retry after a network blip must not open a second table or debit twice.
    //
    // This needs its OWN user: the server allows one active session per
    // account, so reusing the account from the previous test would be refused
    // with a conflict for an entirely correct reason and prove nothing about
    // idempotency.
    const freshToken = signToken(await createUser());
    const payload = {
      action: "OPEN",
      clientRequestId: crypto.randomUUID(),
      tier: "casual",
      clientSentAt: iso(),
    };

    const first = await call("create-session", freshToken, payload);
    const replay = await call("create-session", freshToken, payload);

    expect(first.status).toBe(200);
    expect(replay.status).toBe(200);
    expect(replay.body.gameId).toBe(first.body.gameId);
    expect(replay.body.seatId).toBe(first.body.seatId);
    expect(replay.body.walletBalance).toBe(first.body.walletBalance);
  });
});

suite("command application", () => {
  let token = "";
  let gameId = "";
  let version = 0;

  beforeAll(async () => {
    const userId = await createUser();
    token = signToken(userId);
    const opened = await call("create-session", token, {
      action: "OPEN",
      clientRequestId: crypto.randomUUID(),
      tier: "casual",
      clientSentAt: iso(),
    });
    gameId = String(opened.body.gameId);
    version = Number((opened.body.publicState as { version: number }).version);
  });

  it("applies a bet and advances the version exactly once", async () => {
    const command = {
      gameId,
      clientActionId: crypto.randomUUID(),
      expectedVersion: version,
      type: "PLACE_BET",
      payload: { amount: 50 },
      clientSentAt: iso(),
    };

    const applied = await call("game-command", token, command);
    expect(applied.status).toBe(200);
    expect(applied.body.status).toBe("accepted");

    const appliedVersion = Number((applied.body.publicState as { version: number }).version);
    expect(appliedVersion).toBe(version + 1);

    // Replaying the same action id returns the first result byte for byte —
    // no second chip movement, no second card, no second version bump.
    const replay = await call("game-command", token, command);
    expect(replay.status).toBe(200);
    expect(replay.body.status).toBe("accepted");
    expect(Number((replay.body.publicState as { version: number }).version)).toBe(appliedVersion);

    version = appliedVersion;
  });

  it("returns the authoritative snapshot for a stale version without applying anything", async () => {
    const stale = await call("game-command", token, {
      gameId,
      clientActionId: crypto.randomUUID(),
      expectedVersion: 0,
      type: "PLACE_BET",
      payload: { amount: 50 },
      clientSentAt: iso(),
    });

    expect(stale.status).toBe(200);
    expect(stale.body.status).toBe("stale");
    // The snapshot is the current truth, so the client can resynchronise.
    expect(Number((stale.body.publicState as { version: number }).version)).toBe(version);
  });

  it("rejects a negative wager before touching state", async () => {
    const result = await call("game-command", token, {
      gameId,
      clientActionId: crypto.randomUUID(),
      expectedVersion: version,
      type: "PLACE_BET",
      payload: { amount: -500 },
      clientSentAt: iso(),
    });
    expect(result.status).toBe(400);
    expect(result.body.code).toBe("INVALID_REQUEST");
  });

  it("rejects a command for a session the caller does not own", async () => {
    const intruder = signToken(await createUser());
    const result = await call("game-command", intruder, {
      gameId,
      clientActionId: crypto.randomUUID(),
      expectedVersion: version,
      type: "PLACE_BET",
      payload: { amount: 50 },
      clientSentAt: iso(),
    });
    expect(result.status).toBeGreaterThanOrEqual(400);
    expect(result.body.status).toBe("rejected");
  });

  it("never returns an undealt card or the hole card", async () => {
    const snapshot = await call("game-command", token, {
      gameId,
      clientActionId: crypto.randomUUID(),
      expectedVersion: 0, // forces a stale response carrying the full snapshot
      type: "STAND",
      clientSentAt: iso(),
    });
    expect(snapshot.raw).not.toMatch(/"cards":\[\{"id"/);
    expect(snapshot.raw).not.toMatch(/nextIndex/);
    expect(snapshot.raw).not.toMatch(/engine_state/);
  });
});

/**
 * Concurrency.
 *
 * Racing commands is the one thing a sequential test can never prove. These
 * fire genuinely simultaneous requests (Promise.all) at a single authoritative
 * version; sequential calls would pass against a server with no locking at all.
 */
suite("racing commands at one version", () => {
  let token = "";
  const open = async () => {
    const userId = await createUser();
    token = signToken(userId);
    const opened = await call("create-session", token, {
      action: "OPEN",
      clientRequestId: crypto.randomUUID(),
      tier: "casual",
      clientSentAt: iso(),
    });
    const state = opened.body.publicState as { version: number };
    return { gameId: opened.body.gameId as string, version: state.version };
  };

  /*
   * Ninety seconds, not the suite's thirty.
   *
   * Twenty commands are issued at once against an Edge Function whose Postgres
   * pool is four connections wide, so sixteen of them queue by design — the
   * queueing is the thing being tested. That fits comfortably in thirty seconds
   * when the file runs alone (measured: the whole file takes ~42s), and did so
   * for a long time.
   *
   * It stopped fitting when this suite gained a second server integration file:
   * under `--coverage`, with every other file running in parallel and the Node
   * process instrumented, issuing the twenty requests is itself slow enough to
   * push the total past the default. Correctness never changed — the assertions
   * below still hold — so the honest fix is a timeout that matches what the test
   * actually does, not a smaller test.
   */
  it("accepts exactly one of twenty simultaneous commands", { timeout: 90_000 }, async () => {
    const { gameId, version } = await open();

    const results = await Promise.all(
      Array.from({ length: 20 }, () =>
        call("game-command", token, {
          gameId,
          clientActionId: crypto.randomUUID(),
          expectedVersion: version,
          type: "PLACE_BET",
          payload: { amount: 50 },
          clientSentAt: iso(),
        }),
      ),
    );

    const accepted = results.filter((r) => r.body.status === "accepted");
    const stale = results.filter((r) => r.body.status === "stale");

    expect(accepted).toHaveLength(1);
    expect(stale).toHaveLength(19);
    // A loser must apply NOTHING — every rejection reports the one true version.
    for (const loser of stale) {
      const snapshot = loser.body.publicState as { version: number };
      expect(snapshot.version).toBe(version + 1);
    }
  });

  it("does not double-deal when two LOCK_BETs race", async () => {
    const { gameId, version } = await open();
    const bet = await call("game-command", token, {
      gameId,
      clientActionId: crypto.randomUUID(),
      expectedVersion: version,
      type: "PLACE_BET",
      payload: { amount: 50 },
      clientSentAt: iso(),
    });
    const afterBet = (bet.body.publicState as { version: number }).version;

    const results = await Promise.all(
      Array.from({ length: 2 }, () =>
        call("game-command", token, {
          gameId,
          clientActionId: crypto.randomUUID(),
          expectedVersion: afterBet,
          type: "LOCK_BET",
          payload: {},
          clientSentAt: iso(),
        }),
      ),
    );

    expect(results.filter((r) => r.body.status === "accepted")).toHaveLength(1);
    expect(results.filter((r) => r.body.status === "stale")).toHaveLength(1);
  });

  it("returns one identical result when the same command is replayed concurrently", async () => {
    const { gameId, version } = await open();
    const body = {
      gameId,
      clientActionId: crypto.randomUUID(),
      expectedVersion: version,
      type: "PLACE_BET",
      payload: { amount: 50 },
      clientSentAt: iso(),
    };

    const results = await Promise.all(
      Array.from({ length: 10 }, () => call("game-command", token, body)),
    );

    // A replay is not a conflict: all ten see the first committed result.
    for (const result of results) {
      expect(result.status).toBe(200);
      expect(result.body.status).toBe("accepted");
    }
    const versions = new Set(
      results.map((r) => (r.body.publicState as { version: number }).version),
    );
    expect(versions.size).toBe(1);
  });
});

/**
 * Private tables.
 *
 * The assertion that matters here is the economic one: a private table must not
 * move a chip into or out of the global wallet. That is not a simplification —
 * if chips could travel, two accounts could transfer a bankroll by agreeing to
 * lose, and every leaderboard downstream would be meaningless.
 */
suite("private tables", () => {
  const REST = "http://127.0.0.1:54321/rest/v1";

  async function rpc(token: string, name: string, args: Record<string, unknown> = {}) {
    const response = await fetch(`${REST}/rpc/${name}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: LOCAL_SERVICE_KEY,
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(args),
    });
    const raw = await response.text();
    let parsed: unknown = null;
    try {
      parsed = JSON.parse(raw);
    } catch {
      parsed = raw;
    }
    return { status: response.status, body: parsed };
  }

  async function walletOf(token: string): Promise<number> {
    const response = await fetch(`${REST}/wallets?select=balance`, {
      headers: { apikey: LOCAL_SERVICE_KEY, Authorization: `Bearer ${token}` },
    });
    const rows = (await response.json()) as Array<{ balance: number }>;
    return rows[0]?.balance ?? -1;
  }

  it("seats two players on session chips without touching either wallet", async () => {
    const hostId = await createUser();
    const guestId = await createUser();
    const host = signToken(hostId);
    const guest = signToken(guestId);

    const walletsBefore = [await walletOf(host), await walletOf(guest)];

    const created = await rpc(host, "create_private_room", { p_max_seats: 3 });
    expect(created.status).toBe(200);
    const room = (Array.isArray(created.body) ? created.body[0] : created.body) as {
      id: string;
      code: string;
    };
    expect(room.code).toMatch(/^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{6}$/);

    // Typed by hand, as a guest reading it off a message would.
    const joined = await rpc(guest, "join_private_room", { p_code: room.code.toLowerCase() });
    expect(joined.status).toBe(200);

    // Only the host deals the first hand.
    const guestStart = await call("create-session", guest, {
      action: "START_PRIVATE_TABLE",
      clientRequestId: crypto.randomUUID(),
      roomId: room.id,
      clientSentAt: iso(),
    });
    expect(guestStart.status).toBe(403);

    const started = await call("create-session", host, {
      action: "START_PRIVATE_TABLE",
      clientRequestId: crypto.randomUUID(),
      roomId: room.id,
      clientSentAt: iso(),
    });
    expect(started.status).toBe(200);
    expect(started.body.status).toBe("private_table_started");
    expect(started.body.sessionStack).toBe(5_000);

    const publicState = started.body.publicState as { seats: unknown[]; phase: string };
    expect(publicState.seats).toHaveLength(2);
    expect(publicState.phase).toBe("BETTING_OPEN");

    // No hidden state, exactly as for a solo table.
    expect(started.raw).not.toMatch(/"cards":\[\{"id"/);
    expect(started.raw).not.toMatch(/nextIndex/);

    // THE INVARIANT. Ten thousand chips now sit on the table and not one of
    // them came out of a wallet.
    expect(await walletOf(host)).toBe(walletsBefore[0]);
    expect(await walletOf(guest)).toBe(walletsBefore[1]);
  });

  it("puts a second caller in the SAME hand rather than a fresh shoe", async () => {
    const hostId = await createUser();
    const guestId = await createUser();
    const host = signToken(hostId);
    const guest = signToken(guestId);

    const created = await rpc(host, "create_private_room", { p_max_seats: 2 });
    const room = (Array.isArray(created.body) ? created.body[0] : created.body) as {
      id: string;
      code: string;
    };
    await rpc(guest, "join_private_room", { p_code: room.code });

    const start = {
      action: "START_PRIVATE_TABLE",
      roomId: room.id,
    };
    const first = await call("create-session", host, {
      ...start,
      clientRequestId: crypto.randomUUID(),
      clientSentAt: iso(),
    });
    const second = await call("create-session", guest, {
      ...start,
      clientRequestId: crypto.randomUUID(),
      clientSentAt: iso(),
    });

    expect(second.status).toBe(200);
    expect(second.body.gameId).toBe(first.body.gameId);
    // Same game, different seat — a shared shoe, not two tables.
    expect(second.body.seatId).not.toBe(first.body.seatId);
  });
});

/**
 * Public tables.
 *
 * The mirror image of the private-table suite. There the assertion was that no
 * chip moves; here it is that exactly the right chips move, exactly once, and
 * come back on the way out.
 */
suite("public tables", () => {
  const REST = "http://127.0.0.1:54321/rest/v1";

  async function rpc(token: string, name: string, args: Record<string, unknown> = {}) {
    const response = await fetch(`${REST}/rpc/${name}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: LOCAL_SERVICE_KEY,
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(args),
    });
    const raw = await response.text();
    let parsed: unknown = null;
    try {
      parsed = JSON.parse(raw);
    } catch {
      parsed = raw;
    }
    return { status: response.status, body: parsed };
  }

  async function seatedAt(token: string) {
    await rpc(token, "join_matchmaking", { p_tier: "casual" });
    const polled = await rpc(token, "poll_matchmaking");
    const row = (Array.isArray(polled.body) ? polled.body[0] : polled.body) as {
      room_id: string;
    };
    return row.room_id;
  }

  it("debits the buy-in once and conserves every chip", async () => {
    const userId = await createUser();
    const token = signToken(userId);

    const roomId = await seatedAt(token);
    const take = await call("create-session", token, {
      action: "JOIN_PUBLIC_TABLE",
      clientRequestId: crypto.randomUUID(),
      roomId,
      clientSentAt: iso(),
    });

    expect(take.status).toBe(200);
    expect(take.body.status).toBe("public_seat_taken");
    expect(take.body.buyIn).toBe(2_000);
    // The opening grant is 25,000; a casual buy-in takes 2,000 of it.
    expect(take.body.walletBalance).toBe(23_000);

    // No hidden state, exactly as everywhere else.
    expect(take.raw).not.toMatch(/"cards":\[\{"id"/);
    expect(take.raw).not.toMatch(/nextIndex/);
  });

  it("does not buy a second seat when the request is retried with a fresh id", async () => {
    const userId = await createUser();
    const token = signToken(userId);
    const roomId = await seatedAt(token);

    const body = { action: "JOIN_PUBLIC_TABLE", roomId };
    const first = await call("create-session", token, {
      ...body,
      clientRequestId: crypto.randomUUID(),
      clientSentAt: iso(),
    });
    // A DIFFERENT client id, which is what a retry after a dropped response
    // looks like. The idempotency key is derived from the game and the player,
    // never from this, so it must still charge only once.
    const retry = await call("create-session", token, {
      ...body,
      clientRequestId: crypto.randomUUID(),
      clientSentAt: iso(),
    });

    expect(retry.status).toBe(200);
    expect(retry.body.walletBalance).toBe(first.body.walletBalance);
    expect(retry.body.gameId).toBe(first.body.gameId);
    expect(retry.body.seatId).toBe(first.body.seatId);
  });

  it("returns the stack when the player leaves", async () => {
    const userId = await createUser();
    const token = signToken(userId);
    const roomId = await seatedAt(token);

    const take = await call("create-session", token, {
      action: "JOIN_PUBLIC_TABLE",
      clientRequestId: crypto.randomUUID(),
      roomId,
      clientSentAt: iso(),
    });
    expect(take.body.walletBalance).toBe(23_000);

    const cashOut = await call("create-session", token, {
      action: "CASH_OUT",
      clientRequestId: crypto.randomUUID(),
      gameId: take.body.gameId,
      clientSentAt: iso(),
    });

    expect(cashOut.status).toBe(200);
    expect(cashOut.body.returned).toBe(2_000);
    // Round trip: nothing was created and nothing was lost.
    expect(cashOut.body.walletBalance).toBe(25_000);
  });
});

/**
 * Closed economies, and multi-hand play.
 *
 * Both of these cover defects that were live in this repository and measured
 * against the running stack, not imagined:
 *
 *   - leaving a PRIVATE table credited its 5,000 session chips to the global
 *     wallet. 25,000 became 30,000, repeatable once per table. `settleTableClosure`
 *     had no session-mode guard, so every non-wallet-backed mode minted chips;
 *   - one seat leaving a shared table set SESSION_COMPLETE for everyone. The
 *     remaining player's next command came back SESSION_CLOSED with their bet
 *     already staged;
 *   - no server-authoritative table could reach hand two at all. The engine parks
 *     at HAND_COMPLETE waiting for the caller to advance, and nothing did.
 */
suite("closed economies and multi-hand play", () => {
  const REST = "http://127.0.0.1:54321/rest/v1";

  async function rpc(token: string, name: string, args: Record<string, unknown> = {}) {
    const response = await fetch(`${REST}/rpc/${name}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: LOCAL_SERVICE_KEY,
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(args),
    });
    const raw = await response.text();
    let parsed: unknown = null;
    try {
      parsed = JSON.parse(raw);
    } catch {
      parsed = raw;
    }
    return { status: response.status, body: parsed };
  }

  async function walletOf(token: string): Promise<number> {
    const response = await fetch(`${REST}/wallets?select=balance`, {
      headers: { apikey: LOCAL_SERVICE_KEY, Authorization: `Bearer ${token}` },
    });
    const rows = (await response.json()) as Array<{ balance: number }>;
    return rows[0]?.balance ?? -1;
  }

  async function openPrivateTable() {
    const hostId = await createUser();
    const guestId = await createUser();
    const host = signToken(hostId);
    const guest = signToken(guestId);

    const created = await rpc(host, "create_private_room", { p_max_seats: 2 });
    const room = (Array.isArray(created.body) ? created.body[0] : created.body) as {
      id: string;
      code: string;
    };
    await rpc(guest, "join_private_room", { p_code: room.code });

    const started = await call("create-session", host, {
      action: "START_PRIVATE_TABLE",
      clientRequestId: crypto.randomUUID(),
      roomId: room.id,
      clientSentAt: iso(),
    });
    expect(started.status).toBe(200);
    return { host, guest, started };
  }

  it("does not credit a private table's chips to the wallet on the way out", async () => {
    const { host, started } = await openPrivateTable();
    const before = await walletOf(host);

    const left = await call("game-command", host, {
      gameId: started.body.gameId,
      clientActionId: crypto.randomUUID(),
      type: "LEAVE",
      expectedVersion: (started.body.publicState as { version: number }).version,
      clientSentAt: iso(),
    });
    expect(left.status).toBe(200);

    // The whole point. Those 5,000 chips came from nowhere and go nowhere.
    expect(await walletOf(host)).toBe(before);
  });

  it("keeps a shared table alive for the players still at it", async () => {
    const { host, guest, started } = await openPrivateTable();
    let version = (started.body.publicState as { version: number }).version;

    const bet = await call("game-command", guest, {
      gameId: started.body.gameId,
      clientActionId: crypto.randomUUID(),
      type: "PLACE_BET",
      payload: { amount: 100 },
      expectedVersion: version,
      clientSentAt: iso(),
    });
    version = (bet.body.publicState as { version: number }).version;

    const left = await call("game-command", host, {
      gameId: started.body.gameId,
      clientActionId: crypto.randomUUID(),
      type: "LEAVE",
      expectedVersion: version,
      clientSentAt: iso(),
    });
    expect(left.status).toBe(200);
    // Not SESSION_COMPLETE: somebody is still sitting there with a bet down.
    expect((left.body.publicState as { phase: string }).phase).toBe("BETTING_OPEN");

    const lock = await call("game-command", guest, {
      gameId: started.body.gameId,
      clientActionId: crypto.randomUUID(),
      type: "LOCK_BET",
      expectedVersion: (left.body.publicState as { version: number }).version,
      clientSentAt: iso(),
    });
    expect(lock.status).toBe(200);
    expect(lock.body.status).toBe("accepted");
  });

  it("plays a second hand, and a third", async () => {
    const userId = await createUser();
    const token = signToken(userId);

    const opened = await call("create-session", token, {
      action: "OPEN",
      clientRequestId: crypto.randomUUID(),
      tier: "casual",
      clientSentAt: iso(),
    });
    const gameId = opened.body.gameId as string;
    const seatId = opened.body.seatId as string;
    let state = opened.body.publicState as PublicSnapshot;

    const send = async (type: string, payload?: Record<string, unknown>) => {
      const result = await call("game-command", token, {
        gameId,
        clientActionId: crypto.randomUUID(),
        type,
        ...(payload ? { payload } : {}),
        expectedVersion: state.version,
        clientSentAt: iso(),
      });
      if (result.body.publicState) state = result.body.publicState as PublicSnapshot;
      return result;
    };

    for (let hand = 1; hand <= 3; hand += 1) {
      await send("PLACE_BET", { amount: 100 });
      await send("LOCK_BET");
      for (let step = 0; step < 25 && state.phase !== "HAND_COMPLETE"; step += 1) {
        if (state.phase === "INSURANCE_OFFER" && state.legalActions[seatId]?.canDeclineInsurance) {
          await send("DECLINE_INSURANCE");
          continue;
        }
        if (state.phase === "PLAYER_TURNS" && state.activeSeatId === seatId) {
          await send("STAND");
          continue;
        }
        break;
      }
      expect(state.phase).toBe("HAND_COMPLETE");
      expect(state.handNumber).toBe(hand);
      expect(state.legalActions[seatId]?.canStartNextHand).toBe(true);

      if (hand < 3) {
        const next = await send("NEXT_HAND");
        expect(next.status).toBe(200);
        expect(state.phase).toBe("BETTING_OPEN");
      }
    }
  });
});

/** The fields these tests read off a snapshot. */
interface PublicSnapshot {
  version: number;
  phase: string;
  handNumber: number;
  activeSeatId: string | null;
  seats: Array<{ seatId: string; stack: number; sittingOut: boolean }>;
  legalActions: Record<
    string,
    {
      canDeclineInsurance?: boolean;
      canStartNextHand?: boolean;
      betBounds?: { min: number; max: number } | null;
    }
  >;
}

/**
 * The Daily Challenge.
 *
 * The claim under test is the one the whole mode rests on: two different accounts
 * are dealt the identical shoe. Everything else here protects it — the seed must
 * not appear in a response, and a second attempt must not be able to score.
 */
suite("the daily challenge", () => {
  const REST = "http://127.0.0.1:54321/rest/v1";

  async function walletOf(token: string): Promise<number> {
    const response = await fetch(`${REST}/wallets?select=balance`, {
      headers: { apikey: LOCAL_SERVICE_KEY, Authorization: `Bearer ${token}` },
    });
    const rows = (await response.json()) as Array<{ balance: number }>;
    return rows[0]?.balance ?? -1;
  }

  async function start(token: string) {
    return await call("create-session", token, {
      action: "START_DAILY_CHALLENGE",
      clientRequestId: crypto.randomUUID(),
      clientSentAt: iso(),
    });
  }

  /** Plays the whole attempt, returning the cards dealt in each hand. */
  async function playOut(token: string, gameId: string, seatId: string, opening: PublicSnapshot) {
    let state = opening;
    const dealt: string[] = [];

    const send = async (type: string, payload?: Record<string, unknown>) => {
      const result = await call("game-command", token, {
        gameId,
        clientActionId: crypto.randomUUID(),
        type,
        ...(payload ? { payload } : {}),
        expectedVersion: state.version,
        clientSentAt: iso(),
      });
      if (result.body.publicState) state = result.body.publicState as PublicSnapshot;
      return result;
    };

    const phaseNow = (): string => state.phase;

    for (let hand = 1; hand <= 25; hand += 1) {
      if (phaseNow() !== "BETTING_OPEN") break;
      await send("PLACE_BET", { amount: 100 });
      await send("LOCK_BET");
      for (let step = 0; step < 40 && phaseNow() !== "HAND_COMPLETE"; step += 1) {
        if (phaseNow() === "INSURANCE_OFFER" && state.legalActions[seatId]?.canDeclineInsurance) {
          await send("DECLINE_INSURANCE");
          continue;
        }
        if (phaseNow() === "PLAYER_TURNS" && state.activeSeatId === seatId) {
          await send("STAND");
          continue;
        }
        break;
      }
      const snapshot = state as unknown as {
        seats: Array<{ hands: Array<{ cards: Array<{ id: string }> }> }>;
        dealer: { cards: Array<{ id?: string }> };
      };
      dealt.push(
        snapshot.seats[0]!.hands.flatMap((h) => h.cards.map((c) => c.id)).join(",") +
          "|" +
          snapshot.dealer.cards.map((c) => c.id ?? "hidden").join(","),
      );
      const next = await send("NEXT_HAND");
      if (next.status !== 200) break;
    }
    return { state, dealt };
  }

  it("deals two different accounts the identical shoe", async () => {
    const first = signToken(await createUser());
    const second = signToken(await createUser());

    const a = await start(first);
    const b = await start(second);

    expect(a.status).toBe(200);
    expect(a.body.status).toBe("daily_challenge_started");
    expect(a.body.ranked).toBe(true);
    expect(a.body.challengeId).toBe(b.body.challengeId);
    expect(a.body.handCount).toBe(20);
    expect(a.body.startingChips).toBe(5_000);

    // The seed is as dangerous as the shoe, so it must not be in the payload.
    expect(a.raw).not.toMatch(/arc21:daily:/);
    expect(a.raw).not.toMatch(/seed_?[sS]ecret/);
    expect(String(a.body.seedCommitment)).toMatch(/^[0-9a-f]{64}$/);

    const playedA = await playOut(
      first,
      a.body.gameId as string,
      a.body.seatId as string,
      a.body.publicState as PublicSnapshot,
    );
    const playedB = await playOut(
      second,
      b.body.gameId as string,
      b.body.seatId as string,
      b.body.publicState as PublicSnapshot,
    );

    expect(playedA.dealt).toEqual(playedB.dealt);
    // Exactly the challenge's hand count, and then it stops.
    expect(playedA.state.handNumber).toBe(20);
    expect(playedA.state.phase).toBe("SESSION_COMPLETE");
  }, 120_000);

  it("pays the reward once and refuses to rank a replay", async () => {
    const token = signToken(await createUser());
    const before = await walletOf(token);

    const opened = await start(token);
    // Starting costs nothing: challenge chips are not bought.
    expect(await walletOf(token)).toBe(before);

    const played = await playOut(
      token,
      opened.body.gameId as string,
      opened.body.seatId as string,
      opened.body.publicState as PublicSnapshot,
    );
    expect(played.state.phase).toBe("SESSION_COMPLETE");

    const afterReward = await walletOf(token);
    expect(afterReward).toBe(before + 1_000);

    const replay = await start(token);
    expect(replay.status).toBe(200);
    // Playable, and honest about scoring nothing.
    expect(replay.body.ranked).toBe(false);
    // No second reward for asking again.
    expect(await walletOf(token)).toBe(afterReward);

    const entries = await fetch(`${REST}/daily_entries?select=status,score`, {
      headers: { apikey: LOCAL_SERVICE_KEY, Authorization: `Bearer ${token}` },
    });
    const rows = (await entries.json()) as Array<{ status: string; score: number }>;
    // One row, still the ranked one. An unranked replay cannot overwrite it
    // because it never writes.
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe("completed");
  }, 120_000);

  /**
   * The daily board's tie-breaks are accuracy and then EV lost, and neither can
   * come from `player_decision_periods` — that bucket mixes in every solo and
   * public-table decision the player made that week. The ATTEMPT has to carry
   * its own figures, and until this phase it carried none: the grading ran, the
   * week bucket was written, and the entry beside it stayed at zero.
   *
   * `playOut` stands on every hand, which is wrong often enough to guarantee a
   * mixture — a run that recorded 100% would prove far less.
   *
   * The ORDERING those numbers drive is asserted in
   * `supabase/tests/21_daily_tiebreak.test.sql`, where each entry's fields can be
   * chosen. Two accounts playing the identical shoe the identical way produce
   * identical accuracy, so a real attempt cannot separate the tie-breaks.
   */
  it("records the attempt's own accuracy and EV lost against its entry", async () => {
    const token = signToken(await createUser());
    const opened = await start(token);

    const played = await playOut(
      token,
      opened.body.gameId as string,
      opened.body.seatId as string,
      opened.body.publicState as PublicSnapshot,
    );
    expect(played.state.phase).toBe("SESSION_COMPLETE");

    const entries = await fetch(
      `${REST}/daily_entries?select=status,decisions_total,decisions_optimal,ev_lost_micros`,
      { headers: { apikey: LOCAL_SERVICE_KEY, Authorization: `Bearer ${token}` } },
    );
    const rows = (await entries.json()) as Array<{
      status: string;
      decisions_total: number;
      decisions_optimal: number;
      ev_lost_micros: number;
    }>;

    const entry = rows[0];
    expect(entry?.status).toBe("completed");

    // Twenty hands of standing produce a decision on most of them. The exact
    // count depends on the shoe — a blackjack needs no decision — so this asserts
    // the relationship rather than a number that would expire with a new seed.
    expect(entry!.decisions_total).toBeGreaterThan(0);
    expect(entry!.decisions_optimal).toBeLessThanOrEqual(entry!.decisions_total);

    // Standing on a stiff hand against a high upcard is a real mistake with a
    // real price, so a run of nothing but STAND cannot cost zero. Zero here would
    // mean the EV term was never computed — which is exactly the state this test
    // exists to stop returning to.
    expect(entry!.ev_lost_micros).toBeGreaterThan(0);

    // An integer, in millionths. No float reaches a column in this schema.
    expect(Number.isInteger(entry!.ev_lost_micros)).toBe(true);
  }, 120_000);
});

/**
 * The sixth action the specification asks to be rate limited: "game commands
 * outside an active game".
 *
 * This is the Edge Function half of the limiter — the other five run in the
 * database and are covered by `supabase/tests/19_rate_limits.test.sql`. It has to
 * be tested here because it cannot be tested there: the charge is applied in a
 * SEPARATE transaction, after the command's own has rolled back, and that
 * two-transaction shape only exists in the function.
 *
 * `RATE_LIMITED` has been in `CommandRejectionCode` since the contract was
 * written, with a message and a 429 mapping, and nothing has ever thrown it.
 */
suite("game commands outside an active game", () => {
  it("refuses a caller who keeps naming a table they hold no seat at", async () => {
    const token = signToken(await createUser());
    const ghost = crypto.randomUUID();

    const send = () =>
      call("game-command", token, {
        gameId: ghost,
        clientActionId: crypto.randomUUID(),
        type: "STAND",
        expectedVersion: 1,
        clientSentAt: iso(),
      });

    const codes: string[] = [];
    for (let attempt = 0; attempt < 31; attempt += 1) {
      const result = await send();
      codes.push(`${result.status}:${result.body.code as string}`);
    }

    // The configured ceiling is thirty a minute. Thirty refusals name the real
    // reason; the thirty-first stops answering the question at all.
    expect(codes.slice(0, 30).every((code) => code === "403:NOT_A_PARTICIPANT")).toBe(true);
    expect(codes[30]).toBe("429:RATE_LIMITED");

    // The refusal describes the caller's own behaviour and nothing about whether
    // that game id names anything. A rate limit that answered differently for a
    // real table would be a better session-id oracle than the one the
    // NOT_A_PARTICIPANT wording exists to avoid.
    const refused = await send();
    expect(refused.body.message).toMatch(/Too many requests/);
    expect(refused.raw).not.toMatch(/game_command_outside_game/);
  }, 120_000);

  it("charges the limit per player, so one caller cannot lock out another", async () => {
    const noisy = signToken(await createUser());
    const quiet = signToken(await createUser());
    const ghost = crypto.randomUUID();

    for (let attempt = 0; attempt < 31; attempt += 1) {
      await call("game-command", noisy, {
        gameId: ghost,
        clientActionId: crypto.randomUUID(),
        type: "STAND",
        expectedVersion: 1,
        clientSentAt: iso(),
      });
    }

    const theirs = await call("game-command", quiet, {
      gameId: ghost,
      clientActionId: crypto.randomUUID(),
      type: "STAND",
      expectedVersion: 1,
      clientSentAt: iso(),
    });

    expect(theirs.status).toBe(403);
    expect(theirs.body.code).toBe("NOT_A_PARTICIPANT");
  }, 120_000);

  /**
   * The happy path must not pay for any of this.
   *
   * The check is deliberately on the REJECTION path only — inside the branch
   * that is about to throw — so a command that lands on a live seat never runs
   * it. An accepted command that charged the limit would eventually refuse a
   * player for playing.
   */
  it("never charges a command that lands on a live seat", async () => {
    const token = signToken(await createUser());
    const opened = await call("create-session", token, {
      action: "OPEN",
      clientRequestId: crypto.randomUUID(),
      tier: "casual",
      clientSentAt: iso(),
    });
    expect(opened.status).toBe(200);

    const gameId = opened.body.gameId as string;
    let version = (opened.body.publicState as PublicSnapshot).version;

    // Comfortably more commands than the thirty-a-minute ceiling.
    for (let hand = 0; hand < 40; hand += 1) {
      const result = await call("game-command", token, {
        gameId,
        clientActionId: crypto.randomUUID(),
        // Legal or not, this reaches the seat — which is the point. An illegal
        // action is refused by the ENGINE, not by the out-of-game limiter.
        type: "PLACE_BET",
        payload: { amount: 20 },
        expectedVersion: version,
        clientSentAt: iso(),
      });
      expect(result.body.code).not.toBe("RATE_LIMITED");
      const state = result.body.publicState as PublicSnapshot | undefined;
      if (state) version = state.version;
    }
  }, 120_000);
});

/**
 * The Sprint Tournament, played out.
 *
 * The specification's acceptance criteria for this phase are "full tournament
 * completes automatically and correctly" and "duplicate prize impossible", so
 * this plays a real four-player tournament through the real functions rather than
 * asserting the format module in isolation — that is covered separately in
 * `tests/tournament/tournament-format.test.ts`.
 */
suite("the sprint tournament", () => {
  const REST = "http://127.0.0.1:54321/rest/v1";

  async function walletOf(token: string): Promise<number> {
    const response = await fetch(`${REST}/wallets?select=balance`, {
      headers: { apikey: LOCAL_SERVICE_KEY, Authorization: `Bearer ${token}` },
    });
    const rows = (await response.json()) as Array<{ balance: number }>;
    return rows[0]?.balance ?? -1;
  }

  async function register(token: string) {
    return await call("create-session", token, {
      action: "REGISTER_SPRINT",
      clientRequestId: crypto.randomUUID(),
      clientSentAt: iso(),
    });
  }

  /**
   * Empties the waiting pool so this test's four players share one table.
   *
   * Registration deliberately fills the oldest tournament still short of players
   * — that is the whole point of it, and the matchmaking lesson applied. But it
   * means a half-filled tournament left behind by an earlier run SPLITS this
   * test's four: two complete the leftover and two open a fresh one that never
   * fills, so no table is dealt. Reproduced deliberately before this existed:
   * seed two leftover entries and the test fails on `expect(gameId).toBeTruthy()`.
   *
   * Draining uses nothing but this suite's own registration responses, which
   * report `entriesFilled`, so it needs no read privilege on the tournament
   * tables. The loop is bounded: three throwaway players finish any one
   * tournament, and a handful of rounds clears a realistically dirty database.
   */
  async function drainWaitingTournaments(): Promise<void> {
    for (let round = 0; round < 12; round += 1) {
      const scout = await register(signToken(await createUser()));
      if (scout.status !== 200) return;

      const filled = scout.body.entriesFilled as number;
      const required = scout.body.seatsRequired as number;

      // This player opened a brand-new tournament, so nothing was waiting. Fill
      // it and stop: leaving it half-open would recreate the exact problem.
      const needed = required - filled;
      for (let seat = 0; seat < needed; seat += 1) {
        await register(signToken(await createUser()));
      }
      if (filled === 1) return;
    }
    throw new Error("could not drain the sprint tournament pool");
  }

  it("seats four players, plays twelve hands and settles once", async () => {
    await drainWaitingTournaments();

    const ids: string[] = [];
    for (let i = 0; i < 4; i += 1) ids.push(await createUser());
    const tokens = ids.map((id) => signToken(id));

    const before: number[] = [];
    for (const token of tokens) before.push(await walletOf(token));

    let last: Awaited<ReturnType<typeof register>> | null = null;
    for (const token of tokens) {
      const result = await register(token);
      expect(result.status).toBe(200);
      expect(result.body.status).toBe("sprint_registered");
      expect(result.body.entryFee).toBe(500);
      last = result;
    }

    const tournamentId = last!.body.tournamentId as string;
    const gameId = last!.body.gameId as string;
    // Four registrants, one tournament — not four tournaments of one. The
    // allocation is serialised by an advisory lock for exactly this reason.
    expect(gameId).toBeTruthy();

    // Each player paid exactly once.
    for (const [index, token] of tokens.entries()) {
      expect(await walletOf(token)).toBe(before[index]! - 500);
    }

    // A retry with a FRESH request id must not charge a second fee: the key is
    // derived from the tournament and the player, never from the request.
    const retry = await register(tokens[0]!);
    expect(retry.status).toBe(200);
    expect(retry.body.entryFee).toBe(0);
    expect(await walletOf(tokens[0]!)).toBe(before[0]! - 500);

    let state = last!.body.publicState as PublicSnapshot;
    expect(state.seats).toHaveLength(4);
    for (const seat of state.seats) expect(seat.stack).toBe(10_000);

    // Seat ids, so each player can act as themselves.
    const seatOf = new Map<number, string>();
    for (const [index, token] of tokens.entries()) {
      const response = await fetch(
        `${REST}/game_session_seats?game_session_id=eq.${gameId}&select=id,user_id`,
        { headers: { apikey: LOCAL_SERVICE_KEY, Authorization: `Bearer ${token}` } },
      );
      const rows = (await response.json()) as Array<{ id: string; user_id: string }>;
      const mine = rows.find((row) => row.user_id === ids[index]);
      expect(mine).toBeTruthy();
      seatOf.set(index, mine!.id);
    }

    const send = async (playerIndex: number, type: string, payload?: Record<string, unknown>) => {
      const result = await call("game-command", tokens[playerIndex]!, {
        gameId,
        clientActionId: crypto.randomUUID(),
        type,
        ...(payload ? { payload } : {}),
        expectedVersion: state.version,
        clientSentAt: iso(),
      });
      if (result.body.publicState) state = result.body.publicState as PublicSnapshot;
      return result;
    };
    const phaseNow = (): string => state.phase;

    const ceilings: number[] = [];
    const buttons: string[] = [];
    // Distinct bets so stacks diverge and the elimination has something to bite on.
    const bets = [100, 200, 400, 800];

    for (let hand = 1; hand <= 18; hand += 1) {
      if (phaseNow() !== "BETTING_OPEN") break;

      buttons.push(state.seats[0]!.seatId);
      const live = state.seats.find((seat) => !seat.sittingOut);
      ceilings.push(state.legalActions[live!.seatId]?.betBounds?.max ?? 0);

      for (const [index] of tokens.entries()) {
        const seatId = seatOf.get(index)!;
        const seat = state.seats.find((candidate) => candidate.seatId === seatId);
        if (!seat || seat.sittingOut) continue;
        const bounds = state.legalActions[seatId]?.betBounds;
        if (!bounds) continue;
        const amount = Math.min(Math.max(bets[index]!, bounds.min), bounds.max);
        await send(index, "PLACE_BET", { amount });
        await send(index, "LOCK_BET");
      }

      for (let step = 0; step < 60 && phaseNow() !== "HAND_COMPLETE"; step += 1) {
        if (phaseNow() === "INSURANCE_OFFER") {
          let acted = false;
          for (const [index] of tokens.entries()) {
            if (state.legalActions[seatOf.get(index)!]?.canDeclineInsurance) {
              await send(index, "DECLINE_INSURANCE");
              acted = true;
            }
          }
          if (!acted) break;
          continue;
        }
        if (phaseNow() === "PLAYER_TURNS" && state.activeSeatId) {
          const actor = [...seatOf.entries()].find(([, id]) => id === state.activeSeatId);
          if (!actor) break;
          await send(actor[0], "STAND");
          continue;
        }
        break;
      }
      expect(phaseNow()).toBe("HAND_COMPLETE");

      let advanced = false;
      for (const [index] of tokens.entries()) {
        const next = await send(index, "NEXT_HAND");
        if (next.status === 200) {
          advanced = true;
          break;
        }
      }
      if (!advanced) break;
    }

    expect(phaseNow()).toBe("SESSION_COMPLETE");

    // The ceiling opens up at the ninth SCHEDULED hand. A sudden-death hand is an
    // extra hand at its boundary, so it carries the boundary's ceiling — which is
    // why this counts distinct values rather than indexes.
    expect(ceilings[0]).toBe(2_000);
    expect(ceilings[ceilings.length - 1]).toBe(5_000);
    expect(new Set(ceilings)).toEqual(new Set([2_000, 5_000]));

    // The button moved every hand. Four seats, so it returns to where it began
    // every fourth hand and never repeats consecutively.
    for (let index = 1; index < buttons.length; index += 1) {
      expect(buttons[index]).not.toBe(buttons[index - 1]);
    }

    const tournamentRow = await fetch(
      `${REST}/tournaments?id=eq.${tournamentId}&select=status,scheduled_hands_played`,
      { headers: { apikey: LOCAL_SERVICE_KEY, Authorization: `Bearer ${tokens[0]!}` } },
    );
    const [row] = (await tournamentRow.json()) as Array<{
      status: string;
      scheduled_hands_played: number;
    }>;
    expect(row?.status).toBe("completed");
    expect(row?.scheduled_hands_played).toBe(12);

    const standings = await fetch(`${REST}/rpc/sprint_standings`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: LOCAL_SERVICE_KEY,
        Authorization: `Bearer ${tokens[0]!}`,
      },
      body: JSON.stringify({ p_tournament_id: tournamentId }),
    });
    const rows = (await standings.json()) as Array<{
      placement: number | null;
      prize_chips: number;
      status: string;
      eliminated_after_hand: number | null;
    }>;

    expect(rows).toHaveLength(4);
    for (const entry of rows) expect(entry.placement).not.toBeNull();
    // Exactly one player went out at the hand-six boundary.
    expect(rows.filter((entry) => entry.status === "eliminated")).toHaveLength(1);
    expect(rows.find((entry) => entry.status === "eliminated")?.eliminated_after_hand).toBe(6);

    // Prizes never exceed the schedule, whatever the ties.
    const paid = rows.reduce((total, entry) => total + entry.prize_chips, 0);
    expect(paid).toBeLessThanOrEqual(3_500);

    // Every chip that moved is accounted for: a 500 fee out per player, and the
    // prize schedule back in. Tournament stacks never reach a wallet.
    let netToWallets = 0;
    for (const [index, token] of tokens.entries()) {
      netToWallets += (await walletOf(token)) - before[index]!;
    }
    expect(netToWallets).toBe(paid - 2_000);

    // Duplicate prize impossible: one ledger row per paid placement, enforced by
    // the unique idempotency key rather than by application logic.
    const ledger = await fetch(
      `${REST}/wallet_ledger?select=reason,delta&reason=eq.tournament_prize`,
      { headers: { apikey: LOCAL_SERVICE_KEY, Authorization: `Bearer ${tokens[0]!}` } },
    );
    const prizeRows = (await ledger.json()) as Array<{ delta: number }>;
    expect(prizeRows.length).toBeLessThanOrEqual(1);
  }, 180_000);
});

/**
 * Server-graded decisions and the leaderboards they feed.
 *
 * The specification's bar for the strategy board is "minimum 100 eligible
 * SERVER-AUTHORITATIVE decisions in period". These prove the first half of that
 * adjective: decisions recorded by the server from authoritative state, and NOT
 * recorded for the modes the specification excludes.
 */
suite("decisions and leaderboards", () => {
  const REST = "http://127.0.0.1:54321/rest/v1";

  async function rpc(token: string, name: string, args: Record<string, unknown> = {}) {
    const response = await fetch(`${REST}/rpc/${name}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: LOCAL_SERVICE_KEY,
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(args),
    });
    const raw = await response.text();
    let parsed: unknown = null;
    try {
      parsed = JSON.parse(raw);
    } catch {
      parsed = raw;
    }
    return { status: response.status, body: parsed };
  }

  async function get(token: string, path: string): Promise<unknown> {
    const response = await fetch(`${REST}/${path}`, {
      headers: { apikey: LOCAL_SERVICE_KEY, Authorization: `Bearer ${token}` },
    });
    return await response.json();
  }

  /** Plays `hands` hands at a solo table, standing every time. */
  async function playSolo(token: string, hands: number): Promise<number> {
    const opened = await call("create-session", token, {
      action: "OPEN",
      clientRequestId: crypto.randomUUID(),
      tier: "casual",
      clientSentAt: iso(),
    });
    const gameId = opened.body.gameId as string;
    const seatId = opened.body.seatId as string;
    let state = opened.body.publicState as PublicSnapshot;
    const phaseNow = (): string => state.phase;

    const send = async (type: string, payload?: Record<string, unknown>) => {
      const result = await call("game-command", token, {
        gameId,
        clientActionId: crypto.randomUUID(),
        type,
        ...(payload ? { payload } : {}),
        expectedVersion: state.version,
        clientSentAt: iso(),
      });
      if (result.body.publicState) state = result.body.publicState as PublicSnapshot;
      return result;
    };

    let decisions = 0;
    for (let hand = 1; hand <= hands; hand += 1) {
      if (phaseNow() !== "BETTING_OPEN") break;
      await send("PLACE_BET", { amount: 100 });
      await send("LOCK_BET");
      for (let step = 0; step < 25 && phaseNow() !== "HAND_COMPLETE"; step += 1) {
        if (phaseNow() === "INSURANCE_OFFER" && state.legalActions[seatId]?.canDeclineInsurance) {
          await send("DECLINE_INSURANCE");
          continue;
        }
        if (phaseNow() === "PLAYER_TURNS" && state.activeSeatId === seatId) {
          await send("STAND");
          decisions += 1;
          continue;
        }
        break;
      }
      if (phaseNow() === "HAND_COMPLETE") await send("NEXT_HAND");
    }
    return decisions;
  }

  it("records a decision for every action taken at a ranked table", async () => {
    const token = signToken(await createUser());
    const decisions = await playSolo(token, 6);
    expect(decisions).toBeGreaterThan(0);

    const periods = (await get(
      token,
      "player_decision_periods?select=decisions_total,decisions_optimal",
    )) as Array<{ decisions_total: number; decisions_optimal: number }>;

    expect(periods).toHaveLength(1);
    expect(periods[0]?.decisions_total).toBe(decisions);
    // Standing every time is not perfect play, so some are graded wrong — which is
    // the point: the figure is the server's judgement, not the client's claim.
    expect(periods[0]?.decisions_optimal).toBeLessThanOrEqual(decisions);

    // And the lifetime totals, which nothing wrote before this phase.
    const stats = (await get(token, "player_stats?select=decisions_total")) as Array<{
      decisions_total: number;
    }>;
    expect(stats[0]?.decisions_total).toBe(decisions);
  }, 120_000);

  it("records nothing for an unranked private table", async () => {
    const hostId = await createUser();
    const guestId = await createUser();
    const host = signToken(hostId);
    const guest = signToken(guestId);

    const created = await rpc(host, "create_private_room", { p_max_seats: 2 });
    const room = (Array.isArray(created.body) ? created.body[0] : created.body) as {
      id: string;
      code: string;
    };
    await rpc(guest, "join_private_room", { p_code: room.code });

    const started = await call("create-session", host, {
      action: "START_PRIVATE_TABLE",
      clientRequestId: crypto.randomUUID(),
      roomId: room.id,
      clientSentAt: iso(),
    });
    let state = started.body.publicState as PublicSnapshot;
    const gameId = started.body.gameId as string;

    const seats = (await get(
      host,
      `game_session_seats?game_session_id=eq.${gameId}&select=id,user_id`,
    )) as Array<{ id: string; user_id: string }>;
    const seatOf = new Map(seats.map((seat) => [seat.user_id, seat.id]));

    const send = async (who: string, type: string, payload?: Record<string, unknown>) => {
      const result = await call("game-command", who, {
        gameId,
        clientActionId: crypto.randomUUID(),
        type,
        ...(payload ? { payload } : {}),
        expectedVersion: state.version,
        clientSentAt: iso(),
      });
      if (result.body.publicState) state = result.body.publicState as PublicSnapshot;
      return result;
    };
    const phaseNow = (): string => state.phase;

    await send(host, "PLACE_BET", { amount: 20 });
    await send(host, "LOCK_BET");
    await send(guest, "PLACE_BET", { amount: 20 });
    await send(guest, "LOCK_BET");

    for (let step = 0; step < 30 && phaseNow() !== "HAND_COMPLETE"; step += 1) {
      if (phaseNow() === "INSURANCE_OFFER") {
        let acted = false;
        for (const [userId, seatId] of seatOf) {
          if (state.legalActions[seatId]?.canDeclineInsurance) {
            await send(userId === hostId ? host : guest, "DECLINE_INSURANCE");
            acted = true;
          }
        }
        if (!acted) break;
        continue;
      }
      if (phaseNow() === "PLAYER_TURNS" && state.activeSeatId) {
        const actor = [...seatOf.entries()].find(([, id]) => id === state.activeSeatId);
        if (!actor) break;
        await send(actor[0] === hostId ? host : guest, "STAND");
        continue;
      }
      break;
    }
    expect(phaseNow()).toBe("HAND_COMPLETE");

    // The private table is unranked, so its decisions are too.
    const periods = (await get(host, "player_decision_periods?select=decisions_total")) as unknown[];
    expect(periods).toHaveLength(0);
  }, 120_000);

  /*
   * Asserted as a RELATIONSHIP, not as a place on a global board.
   *
   * The first version looked for `is_you` among the top hundred, which held
   * right up until the local database had a hundred players with more XP than a
   * fresh account earns in three hands — at which point a correct leaderboard
   * failed a correct test. Exactly the mistake this project already made in
   * pgTAP, made again one layer up.
   *
   * `my_leaderboard_position` is the right instrument: it reports the caller's
   * own standing whether or not they are on the visible page, and it is derived
   * from the same ordering the board uses, so "the two agree" is still what is
   * being checked.
   */
  it("puts a player on the weekly XP board and agrees about their position", async () => {
    const token = signToken(await createUser());
    await playSolo(token, 3);

    const board = await rpc(token, "leaderboard_weekly_xp", { p_limit: 100 });
    expect(board.status).toBe(200);
    const rows = board.body as Array<Record<string, unknown>>;
    expect(rows.length).toBeGreaterThan(0);

    // The projection carries no account identifier, whatever else it carries.
    expect(Object.keys(rows[0] ?? {}).sort()).toEqual([
      "avatar_asset_key",
      "detail",
      "display_name",
      "is_you",
      "rank",
      "value",
    ]);
    expect(JSON.stringify(rows)).not.toMatch(/@arc21\.test/);

    // Ranks are dense and ordered, however many players exist.
    const values = rows.map((row) => Number(row.value));
    expect([...values].sort((a, b) => b - a)).toEqual(values);

    const position = await rpc(token, "my_leaderboard_position", { p_category: "weekly_xp" });
    const own = (Array.isArray(position.body) ? position.body[0] : position.body) as
      | { rank: number; value: number; total_ranked: number }
      | undefined;

    // Three hands of solo play earn XP, so this player IS ranked — the question
    // is only whether they fit on the page.
    expect(own?.rank).toBeGreaterThan(0);
    expect(own?.value).toBeGreaterThan(0);
    expect(own?.rank).toBeLessThanOrEqual(own?.total_ranked ?? 0);

    // And if they did make the page, the two must agree about where.
    const mine = rows.find((row) => row.is_you === true);
    if (mine) {
      expect(own?.rank).toBe(mine.rank);
      expect(own?.value).toBe(mine.value);
    }
  }, 120_000);

  it("grants the default cosmetics and refuses to equip an unowned one", async () => {
    const token = signToken(await createUser());

    const granted = await rpc(token, "grant_earned_cosmetics");
    expect(granted.status).toBe(200);
    expect(granted.body).toBeGreaterThanOrEqual(4);

    // Idempotent: a second call grants nothing.
    const again = await rpc(token, "grant_earned_cosmetics");
    expect(again.body).toBe(0);

    const inventory = (await rpc(token, "my_inventory")).body as Array<{
      cosmetic_id: string;
      owned: boolean;
      requirement: string | null;
    }>;
    expect(inventory.length).toBeGreaterThan(20);

    const locked = inventory.find((item) => !item.owned);
    expect(locked).toBeTruthy();
    // A locked item says what to DO. There is nothing to buy, so no price appears.
    expect(locked?.requirement).toBeTruthy();
    expect(JSON.stringify(inventory)).not.toMatch(/price|cost|purchase|\$/i);

    const refused = await rpc(token, "equip_cosmetic", { p_cosmetic_id: locked?.cosmetic_id });
    expect(refused.status).toBeGreaterThanOrEqual(400);

    const owned = inventory.find((item) => item.owned);
    const accepted = await rpc(token, "equip_cosmetic", { p_cosmetic_id: owned?.cosmetic_id });
    // 204, not 200: the function returns void, so PostgREST answers No Content.
    expect(accepted.status).toBeLessThan(300);

    // And it actually took effect, which the status alone does not prove.
    const after = (await rpc(token, "my_inventory")).body as Array<{
      cosmetic_id: string;
      equipped: boolean;
    }>;
    expect(after.find((item) => item.cosmetic_id === owned?.cosmetic_id)?.equipped).toBe(true);
  }, 120_000);
});
