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
import { execFileSync } from "node:child_process";
import http from "node:http";
import { beforeAll, describe, expect, it } from "vitest";

import { callFunction as call, callFunctionAt, type CallResult } from "./call-function.js";
import { matchIntoAPublicRoom } from "./public-seat.js";
import { stackUp } from "./stack-guard.js";

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

/**
 * The test tokens carry NO `iat`, deliberately.
 *
 * PostgREST validates `iat` against its own clock and answers
 * `PGRST303 "JWT issued at future"` when it is ahead — and the failure does not
 * look like a clock problem. It looks like a wallet that reads as -1, a profile
 * column that reads as null, or a career reward that was never paid.
 *
 * Backdating by a minute was the first fix and it was not enough: the Docker VM
 * clock jumps rather than drifts, so any constant is a guess about how far.
 * `iat` is an OPTIONAL claim that PostgREST validates only when present, and
 * nothing in this app reads it, so omitting it removes the failure mode instead
 * of narrowing it. `exp` still bounds the token, and an `exp` an hour out is
 * safe against skew in the direction that matters.
 *
 * Test-only: Supabase issues real tokens server-side, where there is one clock.
 */
function signToken(sub: string, overrides: Record<string, unknown> = {}): string {
  const header = b64({ alg: "HS256", typ: "JWT" });
  const now = Math.floor(Date.now() / 1000);
  const payload = b64({
    sub,
    role: "authenticated",
    aud: "authenticated",
        exp: now + 3600,
    ...overrides,
  });
  const signature = crypto
    .createHmac("sha256", LOCAL_JWT_SECRET)
    .update(`${header}.${payload}`)
    .digest("base64url");
  return `${header}.${payload}.${signature}`;
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

  /*
   * A LONGER ALLOWANCE, because this pair of calls is where a constrained host
   * pays for a cold Edge worker.
   *
   * It timed out at the suite's 30 s default on the first CI run this project
   * ever had, while the same file's other 300-odd assertions passed. Nothing is
   * slow about the assertion — two refused tokens — but `call-function.ts`
   * replays a reply it could not read, and the Edge runtime RETIRES WORKERS on
   * a memory limit, so each replay can pay a fresh boot. `supabase functions
   * serve` accumulates those, which CLAUDE.md already records as the cause of
   * two phase-3 failures that were not the product.
   *
   * Raised here rather than in `vitest.config.mts` deliberately: a global bump
   * would also slow down every real hang, and this file already gives a longer
   * timeout to the tests that have earned one.
   */
  it("rejects a wrong audience and a non-uuid subject", async () => {
    expect((await call("game-command", signToken(userId, { aud: "service_role" }), {})).status).toBe(401);
    expect((await call("game-command", signToken("not-a-uuid"), {})).status).toBe(401);
  }, 90_000);

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

  /**
   * A seat at a public table, which now takes two accounts.
   *
   * `poll_matchmaking` opens a table only when another player is already
   * waiting at the same stakes — a lone caller is told to wait, which is what
   * makes the twenty-second Keep Waiting / Play Solo / Cancel offer reachable
   * and what stops two people who both chose Casual from being sent to two
   * different tables. The partner never buys in.
   */
  async function seatedAt(token: string): Promise<string> {
    const partner = signToken(await createUser());
    return await matchIntoAPublicRoom(rpc, [token, partner], "casual", async () =>
      signToken(await createUser()),
    );
  }

  /**
   * A seat at a public table, actually TAKEN.
   *
   * `seatedAt` gets a room; sitting down in it can still be refused, because
   * allocation is global and this pool is shared with whatever file is running
   * beside this one — the room can fill up or close between the match and the
   * buy-in. CI answered `expected undefined to be 23000`, which is a field read
   * off a REFUSAL body by a test that had not looked at the status first.
   *
   * So the staging is retried and the answer comes back with its status already
   * checked, and every caller below is then asserting about a seat it holds.
   */
  async function takeAPublicSeat(
    token: string,
  ): Promise<{ roomId: string; take: Awaited<ReturnType<typeof call>> }> {
    let last = "no attempt was made";
    for (let attempt = 0; attempt < 6; attempt += 1) {
      const roomId = await seatedAt(token);
      const take = await call("create-session", token, {
        action: "JOIN_PUBLIC_TABLE",
        clientRequestId: crypto.randomUUID(),
        roomId,
        clientSentAt: iso(),
      });
      if (take.status === 200) return { roomId, take };
      last = `${take.status} ${take.raw.slice(0, 200)}`;
    }
    throw new Error(`six matched public rooms and none could be sat at: ${last}`);
  }

  it("debits the buy-in once and conserves every chip", async () => {
    const userId = await createUser();
    const token = signToken(userId);

    const { take } = await takeAPublicSeat(token);

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
    const { roomId, take: first } = await takeAPublicSeat(token);

    // A DIFFERENT client id, which is what a retry after a dropped response
    // looks like. The idempotency key is derived from the game and the player,
    // never from this, so it must still charge only once.
    const retry = await call("create-session", token, {
      action: "JOIN_PUBLIC_TABLE",
      roomId,
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
    const { take } = await takeAPublicSeat(token);
    expect(take.status, take.raw).toBe(200);
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

    // Kept so a caller can replay the LAST command exactly as it was sent —
    // which is the only honest way to test what a lost reply does.
    let lastCommand: Record<string, unknown> = {};
    let lastResponse: Record<string, unknown> = {};

    const send = async (type: string, payload?: Record<string, unknown>) => {
      lastCommand = {
        gameId,
        clientActionId: crypto.randomUUID(),
        type,
        ...(payload ? { payload } : {}),
        expectedVersion: state.version,
        clientSentAt: iso(),
      };
      const result = await call("game-command", token, lastCommand);
      lastResponse = result.body;
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

  /**
   * SQL against the local database container.
   *
   * Test fixture only, and used for exactly two things: constructing a standing
   * a fair shoe will not produce to order, and READING the authoritative shoe
   * order — which no client may see, and which is the only way to compare what
   * two entrants were actually dealt. Nothing here decides an outcome.
   */
  function sql(statement: string): string {
    return execFileSync(
      "docker",
      ["exec", "supabase_db_arc21", "psql", "-U", "postgres", "-d", "postgres", "-tAc", statement],
      { encoding: "utf8" },
    ).trim();
  }

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
    return { status: response.status, body: parsed as unknown[] };
  }

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

  /**
   * Plays the whole attempt, returning the cards dealt in each hand.
   *
   * EVERY COMMAND IS CHECKED, and this is the whole point of the helper.
   *
   * It did not used to be. `send` returned the result and the loop ignored it,
   * so a refused PLACE_BET or a 500 under load left `state` on the previous
   * snapshot, the inner loop fell straight out, the stale snapshot was pushed
   * as if it were a hand, and the next NEXT_HAND carried a stale
   * `expectedVersion` and stopped the loop. The whole run then failed as
   *
   *     expected [ 18 items ] to deeply equal [ 20 items ]
   *
   * with every visible card agreeing — a card-mismatch message for something
   * that was not a card mismatch at all. That failure was seen once in a full
   * `npm test`, was recorded as an unexplained intermittent, and could not be
   * diagnosed from its own output because the cause had already been discarded
   * by the time the assertion ran.
   *
   * A helper that cannot do what it was asked THROWS, naming the command, the
   * status and the body. The same rule the wallet reader learned when returning
   * -1 turned a harness failure into "expected 25200 to be 199".
   */
  async function playOut(
    token: string,
    gameId: string,
    seatId: string,
    opening: PublicSnapshot,
    /**
     * How the attempt talks to the server.
     *
     * Defaults to the real caller. `callFunctionAt` against a fault-injecting
     * proxy is what lets the lost-reply case below be reproduced ON PURPOSE
     * rather than waited for.
     */
    send1: (body: Record<string, unknown>) => Promise<CallResult> = (body) =>
      call("game-command", token, body),
  ) {
    let state = opening;
    const dealt: string[] = [];

    // Kept so a caller can replay the LAST command exactly as it was sent —
    // which is the only honest way to test what a lost reply does.
    let lastCommand: Record<string, unknown> = {};
    let lastResponse: Record<string, unknown> = {};

    const send = async (type: string, payload?: Record<string, unknown>) => {
      lastCommand = {
        gameId,
        clientActionId: crypto.randomUUID(),
        type,
        ...(payload ? { payload } : {}),
        expectedVersion: state.version,
        clientSentAt: iso(),
      };
      const result = await send1(lastCommand);
      lastResponse = result.body;
      if (result.body.publicState) state = result.body.publicState as PublicSnapshot;
      return result;
    };

    /**
     * Every command in an attempt must be accepted, and there is no exception.
     *
     * A `stale` verdict counts as a refusal here even though it is HTTP 200.
     * One seat playing strictly sequentially cannot legitimately race itself:
     * the only way this attempt's `expectedVersion` can fall behind is a reply
     * that never arrived, which is precisely the condition being hunted.
     */
    const mustSend = async (type: string, payload?: Record<string, unknown>) => {
      // Read before `send`, which resynchronises `state` from any snapshot in
      // the reply — including the one a `stale` verdict carries.
      const sentVersion = state.version;
      const result = await send(type, payload);
      if (result.status !== 200) {
        throw new Error(
          `${type} was refused on hand ${dealt.length + 1} of the attempt: ` +
            `HTTP ${result.status} ${result.raw}`,
        );
      }
      if (result.body.status === "stale") {
        throw new Error(
          `${type} came back stale on hand ${dealt.length + 1}: the attempt sent ` +
            `expectedVersion ${sentVersion}, the server was at ${state.version} — ` +
            `a reply was lost, not a race`,
        );
      }
      return result;
    };

    const phaseNow = (): string => state.phase;

    for (let hand = 1; hand <= 25; hand += 1) {
      if (phaseNow() !== "BETTING_OPEN") break;
      await mustSend("PLACE_BET", { amount: 100 });
      await mustSend("LOCK_BET");
      for (let step = 0; step < 40 && phaseNow() !== "HAND_COMPLETE"; step += 1) {
        if (phaseNow() === "INSURANCE_OFFER" && state.legalActions[seatId]?.canDeclineInsurance) {
          await mustSend("DECLINE_INSURANCE");
          continue;
        }
        if (phaseNow() === "PLAYER_TURNS" && state.activeSeatId === seatId) {
          await mustSend("STAND");
          continue;
        }
        break;
      }
      // The hand must actually have finished. Falling out of the loop above on
      // an unexpected phase and recording the previous snapshot as this hand's
      // cards is exactly how a stale reading became a card comparison.
      if (phaseNow() !== "HAND_COMPLETE") {
        throw new Error(
          `hand ${dealt.length + 1} stopped in ${phaseNow()} rather than HAND_COMPLETE ` +
            `(active seat ${String(state.activeSeatId)})`,
        );
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
      // NEXT_HAND is not special. It ends the attempt by ANSWERING 200 with a
      // SESSION_COMPLETE snapshot — `closeCompetition` records that response
      // against the idempotency key like any other — so a refusal here is a
      // refusal, and the loop above exits on the phase rather than on a status.
      await mustSend("NEXT_HAND");
    }

    /*
     * THE ATTEMPT MUST HAVE FINISHED, and this line is the whole guard.
     *
     * Every way this loop can stop early — a lost response, a `stale` verdict
     * that resynchronised onto HAND_COMPLETE, a hand cap reached — leaves a
     * SHORT `dealt` array and nothing else wrong with it. Returning that array
     * is how a truncated run reached `expect(playedA.dealt).toEqual(playedB.dealt)`
     * and was reported as a card mismatch: the caller's own
     * `expect(state.phase).toBe("SESSION_COMPLETE")` sat on the line AFTER the
     * comparison and never ran.
     *
     * Asserting it here, before the array is handed back, means the failure
     * names itself wherever the truncation came from.
     */
    if (state.phase !== "SESSION_COMPLETE") {
      throw new Error(
        `the attempt stopped after ${dealt.length} hand(s) in phase ${state.phase} ` +
          `(version ${state.version}) rather than completing`,
      );
    }
    return { state, dealt, lastCommand, lastResponse };
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
   * THE REGRESSION FOR THE 18-vs-20 INTERMITTENT, on the server side.
   *
   * The local Edge runtime retires a user worker on its CPU soft limit and
   * answers a request already in flight with HTTP 500 — after that command has
   * COMMITTED. `tests/server/call-function.ts` carries the log evidence; the
   * caller now replays the identical body, exactly as
   * `online-table-gateway.ts` does for a real player, and the whole safety of
   * that rests on one property of the server.
   *
   * The property is asserted here for the command that actually lost its reply:
   * the LAST `NEXT_HAND` of a Daily Challenge. That one is not an ordinary
   * command. It does not reach `applyCommand` at all — `resolveHandBoundary`
   * reports the attempt finished and `closeCompetition` writes the completion,
   * marks the seat `left`, marks the session `completed` and PAYS THE REWARD.
   * Its idempotency record is written on a different code path from every other
   * command's, and its replay has to survive both of the closures it just made,
   * which is why `findAppliedCommand` runs ahead of the session-closed check.
   *
   * If any of that were wrong, the retry would turn a lost reply into a second
   * reward, a `SESSION_CLOSED` refusal, or a twenty-first hand of a twenty-hand
   * challenge. So: same body, same answer, same wallet, one entry row.
   */
  it("replays the attempt's final command instead of paying a second reward", async () => {
    const token = signToken(await createUser());
    const before = await walletOf(token);
    const opened = await start(token);

    const played = await playOut(
      token,
      opened.body.gameId as string,
      opened.body.seatId as string,
      opened.body.publicState as PublicSnapshot,
    );
    expect(played.state.phase).toBe("SESSION_COMPLETE");
    expect(played.lastCommand.type).toBe("NEXT_HAND");
    const paid = await walletOf(token);
    expect(paid).toBe(before + 1_000);

    // Byte-identical, exactly as `callFunction` replays it after a 5xx.
    const replay = await call("game-command", token, played.lastCommand);

    expect(replay.status).toBe(200);
    expect(replay.body.status).toBe("accepted");
    // The FIRST committed result, not a recomputation: same snapshot, same
    // version, same twenty hands.
    expect(replay.body).toEqual(played.lastResponse);
    expect((replay.body.publicState as PublicSnapshot).phase).toBe("SESSION_COMPLETE");
    expect((replay.body.publicState as PublicSnapshot).handNumber).toBe(20);

    // No second reward, and no second entry.
    expect(await walletOf(token)).toBe(paid);
    const entries = await fetch(`${REST}/daily_entries?select=status,score`, {
      headers: { apikey: LOCAL_SERVICE_KEY, Authorization: `Bearer ${token}` },
    });
    expect((await entries.json()) as unknown[]).toHaveLength(1);

    // And a DIFFERENT action id on the same finished session is refused rather
    // than quietly accepted — the replay above is a replay, not an open door.
    const impostor = await call("game-command", token, {
      ...played.lastCommand,
      clientActionId: crypto.randomUUID(),
    });
    expect(impostor.status).toBeGreaterThanOrEqual(400);
    expect(await walletOf(token)).toBe(paid);
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

  /**
   * A NEW ATTEMPT IS A NEW SEAT.
   *
   * Every other mode that opens one asks whether the caller already holds a
   * table — `open`, `joinPublicTable`, `startCareerNode`, `registerSprint` — and
   * this one did not. Measured against the running stack before the guard
   * existed: an account with a solo table and 5,000 chips in escrow started the
   * challenge, was answered 200, and held TWO active seats. `my_active_session()`
   * orders by start time, so it then named only the challenge and the solo
   * buy-in was unaddressable from every screen — which is the precise failure
   * that function was written to close, and the one phase 8 closed for a Sprint
   * entry.
   *
   * The refusal has to name something the player can do, which is why the second
   * half of this test matters as much as the first.
   */
  it("refuses to open a second live seat while a table is held", async () => {
    const token = signToken(await createUser());

    const solo = await call("create-session", token, {
      action: "OPEN",
      tier: "standard",
      clientRequestId: crypto.randomUUID(),
      clientSentAt: iso(),
    });
    expect(solo.status).toBe(200);
    expect(solo.body.status).toBe("opened");

    const refused = await start(token);
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe("SESSION_ALREADY_ACTIVE");

    // One seat, and it is the one holding the chips.
    const seats = await fetch(
      `${REST}/game_session_seats?select=game_session_id,status&user_id=eq.${
        JSON.parse(Buffer.from((token.split(".")[1] as string), "base64url").toString()).sub
      }&status=neq.left`,
      { headers: { apikey: LOCAL_SERVICE_KEY, Authorization: `Bearer ${token}` } },
    );
    expect((await seats.json()) as unknown[]).toHaveLength(1);

    const where = await rpc(token, "my_active_session");
    expect(where.body).toHaveLength(1);
    expect((where.body[0] as { game_session_id: string }).game_session_id).toBe(solo.body.gameId);

    // And no entry was written for a challenge that never opened.
    const entries = await fetch(`${REST}/daily_entries?select=status`, {
      headers: { apikey: LOCAL_SERVICE_KEY, Authorization: `Bearer ${token}` },
    });
    expect((await entries.json()) as unknown[]).toHaveLength(0);
  }, 120_000);

  /**
   * AN ATTEMPT THAT RUNS OUT OF CHIPS IS OVER.
   *
   * 5,000 challenge chips with a 1,000 ceiling is five losing hands at the
   * maximum, and below the 100-chip minimum there is no legal bet left to place:
   * `getLegalActions` answers with no actions, no bounds and no
   * `canStartNextHand`. The Daily Challenge deliberately carries NO CLOCKS, so
   * nothing can move a table left there either — measured before the fix, the
   * server dealt hand 2, opened betting, and offered the seat nothing at all,
   * with the entry still `in_progress` at `final_chips = 5000` and the session
   * still `active`. Because `startDailyChallenge` RESUMES an in-progress
   * attempt, that account's one ranked run for the day was permanently
   * unfinishable.
   *
   * The standing is constructed rather than played for: a fair shoe will not
   * bankrupt a flat 100-chip bettor on demand, and retrying until it does is a
   * flake by construction. Every decision after it is the server's.
   */
  it("ends an attempt whose stack cannot cover the table minimum", async () => {
    const token = signToken(await createUser());
    const opened = await start(token);
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
      if (result.status !== 200) throw new Error(`${type} -> ${result.status} ${result.raw}`);
      return result;
    };

    await send("PLACE_BET", { amount: 100 });
    await send("LOCK_BET");
    for (let step = 0; step < 40 && state.phase !== "HAND_COMPLETE"; step += 1) {
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

    // 50 chips, against a 100-chip table minimum.
    sql(
      `update private.game_state_private
       set engine_state = jsonb_set(engine_state, '{seats,0,stack}', '50'::jsonb)
       where game_session_id = '${gameId}'`,
    );

    await send("NEXT_HAND");

    // Over, rather than parked at a betting round with nothing to press.
    expect(state.phase).toBe("SESSION_COMPLETE");
    expect(state.handNumber).toBe(1);

    const entries = await fetch(
      `${REST}/daily_entries?select=status,hands_played,final_chips,score`,
      { headers: { apikey: LOCAL_SERVICE_KEY, Authorization: `Bearer ${token}` } },
    );
    const rows = (await entries.json()) as Array<{
      status: string;
      hands_played: number;
      final_chips: number;
      score: number;
    }>;
    expect(rows[0]?.status).toBe("completed");
    expect(rows[0]?.hands_played).toBe(1);
    // Scored honestly at what was left, which is what the specification's
    // "ending challenge bankroll" says.
    expect(rows[0]?.final_chips).toBe(50);
    expect(rows[0]?.score).toBe(50);
  }, 120_000);

  /**
   * THE SHOE AFTER THE CUT CARD IS STILL THE CHALLENGE'S SHOE.
   *
   * Randomness reaches the engine at two points and only two: `createShoe` when
   * the session opens, and `reshuffle` inside `openBetting`. The first came from
   * the challenge's secret seed; the second came from `serverRandom()`, because
   * `game-command` handed every command the CSPRNG — so the moment an attempt
   * crossed the cut card it stopped facing the same cards as everybody else,
   * with nothing failing anywhere. Both attempts still play their twenty hands.
   * They simply stop being the same challenge.
   *
   * Latent rather than live at the shipped twenty hands — measured over 400
   * attempts of the most card-hungry legal play there is, the worst reached
   * index 160 of the 234-card cut and none reshuffled — but `hand_count` is the
   * challenge ROW's, constrained only to 1..100 and honoured as authored, and at
   * forty hands 385 of 400 attempts reshuffled. A guarantee that holds because
   * of a number nobody is checking is not a guarantee.
   *
   * Both attempts' shoes are wound to the cut card so the reshuffle happens on
   * the next command for both. Nothing here chooses a card: the server decides
   * what to shuffle with, and the two orders are then compared.
   */
  it("reshuffles from the challenge's own stream, not from the CSPRNG", async () => {
    const first = signToken(await createUser());
    const second = signToken(await createUser());

    const a = await start(first);
    const b = await start(second);
    expect(a.body.challengeId).toBe(b.body.challengeId);

    const settleFirstHand = async (token: string, opened: CallResult) => {
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
        if (result.status !== 200) throw new Error(`${type} -> ${result.status} ${result.raw}`);
        return result;
      };
      await send("PLACE_BET", { amount: 100 });
      await send("LOCK_BET");
      for (let step = 0; step < 40 && state.phase !== "HAND_COMPLETE"; step += 1) {
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
      return { gameId, state, send };
    };

    const playerA = await settleFirstHand(first, a);
    const playerB = await settleFirstHand(second, b);

    // The opening shoe is shared, which is the claim this whole mode rests on.
    const orderOf = (gameId: string): { shuffleNumber: number; cards: string } =>
      JSON.parse(
        sql(
          `select json_build_object(
             'shuffleNumber', (engine_state -> 'shoe' ->> 'shuffleNumber')::int,
             'cards', (select string_agg(c ->> 'id', ',')
                       from jsonb_array_elements(engine_state -> 'shoe' -> 'cards') c))
           from private.game_state_private where game_session_id = '${gameId}'`,
        ),
      );
    const openingShoe = orderOf(playerA.gameId).cards;
    expect(openingShoe).toBe(orderOf(playerB.gameId).cards);

    // Wind both shoes to the cut card. `cutIndex` is the engine's own figure,
    // read from the state rather than recomputed here.
    for (const gameId of [playerA.gameId, playerB.gameId]) {
      sql(
        `update private.game_state_private
         set engine_state = jsonb_set(
               engine_state, '{shoe,nextIndex}',
               to_jsonb((engine_state -> 'shoe' ->> 'cutIndex')::int))
         where game_session_id = '${gameId}'`,
      );
    }

    await playerA.send("NEXT_HAND");
    await playerB.send("NEXT_HAND");

    const afterA = orderOf(playerA.gameId);
    const afterB = orderOf(playerB.gameId);

    // It really did reshuffle...
    expect(afterA.shuffleNumber).toBe(2);
    expect(afterB.shuffleNumber).toBe(2);
    // ...both entrants got the SAME second shoe...
    expect(afterA.cards).toBe(afterB.cards);
    // ...and it is a NEW shoe, not the opening one dealt over again, which is
    // what a stream keyed only on the seed would have produced.
    expect(afterA.cards).not.toBe(openingShoe);
  }, 180_000);

  /**
   * THE OTHER HALF OF THE COMMITMENT SCHEME.
   *
   * `daily_challenges.revealed_seed` has existed since the table did. A trigger
   * refuses a reveal before `closes_at` and refuses one that does not match the
   * secret; the client projection carries the column, `daily.ts` parses it and
   * the Daily screen renders it. **Nothing in the product ever wrote it.**
   * Outside pgTAP, no code path set `revealed_seed` — so the seed was never
   * published, the render branch was dead, and the sentence on screen promising
   * the player they could check the hash could not be kept by anybody.
   *
   * The specification: "After challenge closes, the seed may become publicly
   * viewable in an audit/fairness view."
   *
   * Note what is asserted about TODAY: nothing was published for it. The reveal
   * runs on every load, so if its predicate were wrong this is where a live
   * shoe would escape.
   */
  it("publishes a closed challenge's seed, and never a live one", async () => {
    const token = signToken(await createUser());

    // A challenge whose window has closed, on a date this test owns. Far enough
    // back that it cannot collide with a real one, and carrying no entries, so
    // nobody's daily streak changes.
    const closedDate = "2019-07-04";
    sql(
      `insert into public.daily_challenges
         (challenge_date, ruleset_id, seed_secret, seed_commitment,
          hand_count, starting_chips, tier, reward_chips, reward_xp, opens_at, closes_at)
       select '${closedDate}'::date, r.id, s.secret,
              encode(extensions.digest(s.secret, 'sha256'), 'hex'),
              20, 5000, 'standard', 1000, 150,
              '${closedDate}'::timestamptz, '${closedDate}'::timestamptz + interval '1 day'
       from public.rulesets r,
            (select 'arc21:daily:${closedDate}:' || repeat('e', 64) as secret) s
       where r.is_active
       limit 1
       on conflict (challenge_date) do nothing`,
    );

    try {
      // Nothing is published until somebody opens the screen. This is the call
      // the store makes.
      const today = await rpc(token, "ensure_todays_daily_challenge");
      expect(today.status).toBe(200);

      /*
       * THE FIXTURE'S OWN ROW IS REVEALED. This is what the insert above is
       * for, and it is true no matter what else the database holds.
       *
       * It used to assert that this row was the one
       * `latest_verifiable_daily_challenge()` returned — which is a claim about
       * every OTHER row in the table, not about this one. That function answers
       * with the most recent revealed challenge, so the assertion held only
       * while nothing later existed. `scripts/e2e-account.ts` creates
       * yesterday's challenge (deliberately: the reveal needs something to
       * publish), and the moment it had been run before this suite a correct
       * answer failed a correct-looking test — `expected '2026-09-02' to be
       * '2019-07-04'`. The same mistake as the pgTAP file that counted global
       * rows and the leaderboard test that asserted a place: assert the
       * relationship you own, never the global superlative.
       */
      expect(
        sql(
          `select coalesce(revealed_seed, 'NOT-REVEALED')
           from public.daily_challenges where challenge_date = '${closedDate}'`,
        ),
      ).not.toBe("NOT-REVEALED");

      const verifiable = await rpc(token, "latest_verifiable_daily_challenge");
      expect(verifiable.status).toBe(200);
      const row = (Array.isArray(verifiable.body) ? verifiable.body[0] : verifiable.body) as
        | { challenge_date: string; seed_commitment: string; revealed_seed: string }
        | undefined;
      expect(row, "nothing is publishable, so the fairness view has nothing to show").toBeDefined();

      /*
       * WHATEVER row it is, it must be a CLOSED one. This is the safety
       * property the function exists to hold, and asserting it about the row
       * actually returned is stronger than asserting an identity — it is
       * checked against whichever challenge the database really considers
       * latest, including a real one created by another test or by the e2e
       * account script.
       */
      const todayUtc = sql(`select (now() at time zone 'utc')::date::text`);
      expect(row!.challenge_date < todayUtc, `${row!.challenge_date} is not before ${todayUtc}`).toBe(
        true,
      );

      // THE CHECK A PLAYER'S DEVICE MAKES, made here in Node against the same
      // two published strings. If this ever fails, the shoe was not the one
      // committed to before play.
      const digest = crypto.createHash("sha256").update(row!.revealed_seed).digest("hex");
      expect(digest).toBe(row!.seed_commitment);

      // TODAY's seed is still secret. The reveal ran a moment ago and left it
      // alone, which is the property the whole mode depends on.
      expect(
        sql(
          `select coalesce(revealed_seed, 'NOT-REVEALED')
           from public.daily_challenges
           where challenge_date = (now() at time zone 'utc')::date`,
        ),
      ).toBe("NOT-REVEALED");

      // And the seed itself is not reachable through the client's own grants,
      // however it is asked for.
      const direct = await fetch(
        `${REST}/daily_challenges?select=seed_secret&challenge_date=eq.${closedDate}`,
        { headers: { apikey: LOCAL_SERVICE_KEY, Authorization: `Bearer ${token}` } },
      );
      expect(direct.status).toBeGreaterThanOrEqual(400);
    } finally {
      sql(`delete from public.daily_challenges where challenge_date = '${closedDate}'`);
    }
  }, 120_000);

  /**
   * THE "18 ITEMS versus 20 ITEMS" INTERMITTENT, REPRODUCED ON PURPOSE.
   *
   * ------------------------------------------------------------------------
   * WHAT WAS OBSERVED
   * ------------------------------------------------------------------------
   * `deals two different accounts the identical shoe` failed occasionally with
   *
   *     expected [ 18 items ] to deeply equal [ 20 items ]
   *
   * — a hand-COUNT mismatch with every card that WAS recorded agreeing. It reads
   * as a defect in the deterministic shoe, which is the most important claim
   * this mode makes. It is not a card defect at all.
   *
   * ------------------------------------------------------------------------
   * THE MECHANISM
   * ------------------------------------------------------------------------
   * From `docker logs supabase_edge_runtime_arc21`, in this order: a CPU soft
   * limit, then `{"message":"command handled", …,"outcome":"accepted"}`, then
   * `WorkerAlreadyRetired`. **The command committed and only the reply was
   * lost.** The caller then saw a 5xx for a command the server had applied.
   *
   * That is not something a test can wait for — the retirement is the runtime's
   * decision — so it is INJECTED here instead: a proxy that forwards each
   * request to the real function, waits for the real reply, and then throws that
   * reply away and answers the runtime's own
   * `{"code":"WORKER_LIMIT", …}` at HTTP 546. Same failure, same order, on
   * demand.
   *
   * ------------------------------------------------------------------------
   * WHAT THIS FILE THEN ASSERTS
   * ------------------------------------------------------------------------
   *   1. The pre-fix CALLER — the one that stopped the loop on a non-200 —
   *      reproduces the reported symptom exactly: 18 hands against a reference
   *      attempt's 20, with all 18 identical. Not "a plausible cause": the
   *      message itself.
   *   2. The current caller replays the identical body and the attempt
   *      COMPLETES, with the same twenty hands as an attempt that lost nothing.
   *   3. Nothing was applied twice: one entry row, one reward, twenty hands —
   *      which is the property the whole retry rests on, asserted against the
   *      real server rather than a stub.
   *
   * The faults deliberately include the LAST `NEXT_HAND`. That command never
   * reaches `applyCommand`: it closes the session, marks the seat left and pays
   * the reward, and its idempotency record is written on a different code path
   * from every other command's.
   */
  it("reproduces the lost-reply truncation, and survives it", async () => {
    /** How many replies the proxy has thrown away, per command type. */
    let discarded = 0;
    const seen = new Map<string, number>();

    /**
     * Forwards to the real function, waits for the real answer, and then loses
     * it — the runtime's behaviour, in the runtime's own words.
     */
    const start546 = async (lose: (type: string, occurrence: number) => boolean) => {
      const server = http.createServer((request, response) => {
        const chunks: Buffer[] = [];
        request.on("data", (chunk: Buffer) => chunks.push(chunk));
        request.on("end", () => {
          const body = Buffer.concat(chunks);
          void (async () => {
            const upstream = await fetch(`http://127.0.0.1:54321${request.url ?? ""}`, {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                ...(request.headers.authorization
                  ? { Authorization: request.headers.authorization }
                  : {}),
              },
              body,
            });
            const raw = await upstream.text();

            let type = "";
            try {
              type = String((JSON.parse(body.toString()) as { type?: unknown }).type ?? "");
            } catch {
              type = "";
            }
            const occurrence = (seen.get(type) ?? 0) + 1;
            seen.set(type, occurrence);

            if (lose(type, occurrence)) {
              discarded += 1;
              response.writeHead(546, { "Content-Type": "application/json" });
              response.end(
                JSON.stringify({
                  code: "WORKER_LIMIT",
                  message: "request cannot be handled because the worker has already retired",
                }),
              );
              return;
            }
            response.writeHead(upstream.status, { "Content-Type": "application/json" });
            response.end(raw);
          })();
        });
      });
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const port = (server.address() as { port: number }).port;
      return { server, base: `http://127.0.0.1:${port}/functions/v1` };
    };

    // ---- The reference attempt, which loses nothing ------------------------
    const referenceToken = signToken(await createUser());
    const reference = await start(referenceToken);
    const played = await playOut(
      referenceToken,
      reference.body.gameId as string,
      reference.body.seatId as string,
      reference.body.publicState as PublicSnapshot,
    );
    expect(played.dealt).toHaveLength(20);

    // ---- 1. The pre-fix caller, and the exact reported symptom -------------
    seen.clear();
    discarded = 0;
    const truncated = await start546((type, occurrence) => type === "NEXT_HAND" && occurrence === 18);
    const oldToken = signToken(await createUser());
    const oldOpened = await start(oldToken);
    try {
      const gameId = oldOpened.body.gameId as string;
      const seatId = oldOpened.body.seatId as string;
      let state = oldOpened.body.publicState as PublicSnapshot;
      const dealt: string[] = [];

      /*
       * `playOut` AS IT WAS: `if (next.status !== 200) break`, and the array
       * handed back however short it is. Written out rather than imported,
       * because the point is to show what the old shape DID with this fault.
       */
      const send = async (type: string, payload?: Record<string, unknown>) => {
        // A PLAIN fetch. `callFunctionAt` would replay the body — that IS the
        // fix — so using it here would prove nothing about what the old caller
        // did with a lost reply.
        const response = await fetch(`${truncated.base}/game-command`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${oldToken}` },
          body: JSON.stringify({
            gameId,
            clientActionId: crypto.randomUUID(),
            type,
            ...(payload ? { payload } : {}),
            expectedVersion: state.version,
            clientSentAt: iso(),
          }),
        });
        const raw = await response.text();
        let body: Record<string, unknown> = {};
        try {
          body = JSON.parse(raw) as Record<string, unknown>;
        } catch {
          body = {};
        }
        if (body.publicState) state = body.publicState as PublicSnapshot;
        return { status: response.status, body, raw };
      };

      // `state` is reassigned inside `send`, which the narrowing cannot see.
      const phaseNow = (): string => state.phase;

      outer: for (let hand = 1; hand <= 25; hand += 1) {
        if (phaseNow() !== "BETTING_OPEN") break;
        if ((await send("PLACE_BET", { amount: 100 })).status !== 200) break;
        if ((await send("LOCK_BET")).status !== 200) break;
        for (let step = 0; step < 40 && phaseNow() !== "HAND_COMPLETE"; step += 1) {
          if (phaseNow() === "INSURANCE_OFFER" && state.legalActions[seatId]?.canDeclineInsurance) {
            if ((await send("DECLINE_INSURANCE")).status !== 200) break outer;
            continue;
          }
          if (phaseNow() === "PLAYER_TURNS" && state.activeSeatId === seatId) {
            if ((await send("STAND")).status !== 200) break outer;
            continue;
          }
          break;
        }
        if (phaseNow() !== "HAND_COMPLETE") break;
        const snapshot = state as unknown as {
          seats: Array<{ hands: Array<{ cards: Array<{ id: string }> }> }>;
          dealer: { cards: Array<{ id?: string }> };
        };
        dealt.push(
          snapshot.seats[0]!.hands.flatMap((h) => h.cards.map((c) => c.id)).join(",") +
            "|" +
            snapshot.dealer.cards.map((c) => c.id ?? "hidden").join(","),
        );
        if ((await send("NEXT_HAND")).status !== 200) break;
      }

      // The reported failure, reproduced: a SHORT array whose every entry
      // agrees. `toEqual` on these two is where "18 items versus 20 items" came
      // from, and it never mentioned the reply that was lost.
      expect(discarded).toBe(1);
      expect(dealt).toHaveLength(18);
      expect(played.dealt).toHaveLength(20);
      expect(dealt).toEqual(played.dealt.slice(0, 18));

      /*
       * And the comparison the old helper made: two arrays of CARDS that differ
       * only in length. That is the whole of the reported intermittent — a
       * card-mismatch message for something that was never a card mismatch.
       *
       * The message TEXT is deliberately not asserted, and the first attempt to
       * assert it failed on the fourth run for a reason worth recording: Vitest
       * renders `[ …(18) ]` when the leading elements differ and
       * `[ 'd5-4H,d0-6S|d5-QC,d0-9D', …(17) ]` when they agree, so the numbers
       * in the sentence depend on the shoe. (The version in use when this was
       * first seen rendered `expected [ 18 items ] to deeply equal
       * [ 20 items ]`.) The stable claim is the one asserted three lines up:
       * eighteen hands against twenty, every one of the eighteen identical.
       */
      expect(() => {
        expect(dealt).toEqual(played.dealt);
      }).toThrow();
    } finally {
      await new Promise<void>((resolve) => truncated.server.close(() => resolve()));
    }

    // ---- 2 and 3. The current caller, through the same faults --------------
    seen.clear();
    discarded = 0;
    const retries: string[] = [];
    // Four losses, spread across the commands that can each end a hand in a
    // different way — including the final NEXT_HAND, which closes the session
    // and pays the reward without ever reaching `applyCommand`.
    const faulted = await start546(
      (type, occurrence) =>
        (type === "LOCK_BET" && occurrence === 3) ||
        (type === "NEXT_HAND" && (occurrence === 5 || occurrence === 12 || occurrence === 20)),
    );
    try {
      const token = signToken(await createUser());
      const before = await walletOf(token);
      const opened = await start(token);

      const survived = await playOut(
        token,
        opened.body.gameId as string,
        opened.body.seatId as string,
        opened.body.publicState as PublicSnapshot,
        (body) =>
          callFunctionAt(faulted.base, "game-command", token, body, (message) =>
            retries.push(message),
          ),
      );

      // The faults fired, and each was absorbed by a replay of the identical
      // body. Without this assertion the rest of the test could pass by the
      // proxy having done nothing at all.
      expect(discarded).toBe(4);
      expect(retries).toHaveLength(4);
      for (const message of retries) expect(message).toContain("HTTP 546");

      // The attempt COMPLETED, and it is the same attempt everybody else played.
      expect(survived.state.phase).toBe("SESSION_COMPLETE");
      expect(survived.state.handNumber).toBe(20);
      expect(survived.dealt).toEqual(played.dealt);

      // Nothing was applied twice: twenty hands, one entry, one reward.
      expect(await walletOf(token)).toBe(before + 1_000);
      const entries = await fetch(
        `${REST}/daily_entries?select=status,hands_played,score`,
        { headers: { apikey: LOCAL_SERVICE_KEY, Authorization: `Bearer ${token}` } },
      );
      const rows = (await entries.json()) as Array<{
        status: string;
        hands_played: number;
        score: number;
      }>;
      expect(rows).toHaveLength(1);
      expect(rows[0]?.status).toBe("completed");
      expect(rows[0]?.hands_played).toBe(20);
    } finally {
      await new Promise<void>((resolve) => faulted.server.close(() => resolve()));
    }
  }, 240_000);
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

/*
 * THE SPRINT TOURNAMENT MOVED, it was not deleted.
 *
 * `tests/server/sprint-tournament.integration.test.ts` is the whole of it and
 * more: the same unabridged twelve-hand run through the real functions, plus the
 * cases phase 8 had to add — sequential betting refusing an out-of-turn bet, the
 * competition boundary running when the settlement window lapses rather than
 * only on NEXT_HAND, the withdrawal that refunds an entry whose field never
 * filled, and the elimination tie, bankruptcy and final tie a fair shoe will not
 * produce to order.
 *
 * Two copies of a twenty-second tournament run is one implementation too many,
 * and the drain helper both of them needed now lives in `sprint-table.ts` so
 * there is exactly one of that too.
 */

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

    // Kept so a caller can replay the LAST command exactly as it was sent —
    // which is the only honest way to test what a lost reply does.
    let lastCommand: Record<string, unknown> = {};
    let lastResponse: Record<string, unknown> = {};

    const send = async (type: string, payload?: Record<string, unknown>) => {
      lastCommand = {
        gameId,
        clientActionId: crypto.randomUUID(),
        type,
        ...(payload ? { payload } : {}),
        expectedVersion: state.version,
        clientSentAt: iso(),
      };
      const result = await call("game-command", token, lastCommand);
      lastResponse = result.body;
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

  /**
   * PAGING, asserted as a relationship for the same reason the test above is.
   *
   * A board is global and this database has whoever else has played, so a test
   * naming "the second row" reports somebody else's account. What paging
   * promises is narrower and does hold: the pages concatenate back into the
   * board, in order, with nothing repeated and nothing missed. That is the
   * property `row_number()` was added for — `rank` alone is not a total order,
   * and a tie can otherwise put one player on two pages and another on none.
   */
  it("pages the weekly XP board without repeating or losing a row", async () => {
    const token = signToken(await createUser());
    await playSolo(token, 3);

    const key = (row: Record<string, unknown>) =>
      `${String(row.rank)}|${String(row.display_name)}|${String(row.value)}`;

    const whole = ((await rpc(token, "leaderboard_weekly_xp", { p_limit: 6, p_offset: 0 }))
      .body as Array<Record<string, unknown>>).map(key);
    // Needs at least a few ranked players to be a meaningful comparison; this
    // suite has created plenty by the time it runs, and `playSolo` above adds
    // one more.
    expect(whole.length).toBeGreaterThan(3);

    const first = ((await rpc(token, "leaderboard_weekly_xp", { p_limit: 3, p_offset: 0 }))
      .body as Array<Record<string, unknown>>).map(key);
    const second = ((await rpc(token, "leaderboard_weekly_xp", { p_limit: 3, p_offset: 3 }))
      .body as Array<Record<string, unknown>>).map(key);

    expect(first).toHaveLength(3);
    expect([...first, ...second]).toEqual(whole);

    // An offset past the end is an empty page, not an error and not a wrap.
    const beyond = await rpc(token, "leaderboard_weekly_xp", { p_limit: 25, p_offset: 1_000_000 });
    expect(beyond.status).toBe(200);
    expect(beyond.body).toHaveLength(0);

    // Every board takes the same pair, so the client's one paging path works for
    // all four rather than three of them.
    for (const board of [
      "leaderboard_tournament_wins",
      "leaderboard_strategy_accuracy",
    ]) {
      const page = await rpc(token, board, { p_limit: 5, p_offset: 0 });
      expect(page.status).toBe(200);
    }
    const daily = await rpc(token, "leaderboard_daily_challenge", {
      p_date: null,
      p_limit: 5,
      p_offset: 0,
    });
    expect(daily.status).toBe(200);
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

/**
 * WHO MOVES AN EXPIRED DEADLINE.
 *
 * Arc 21 runs no long-lived game process. A deadline is a stored `deadline_at`,
 * and the specification's mechanism for reaching it is that "when a deadline is
 * visually reached, any connected client may request RESOLVE_TIMEOUT", which the
 * server honours only if its own clock agrees. So a CONNECTED CLIENT ASKING is
 * the only thing in the entire system that moves a lapsed timer.
 *
 * Nothing asked. `deadlineAt` has been on every snapshot since the wire contract
 * was written, under the comment "Clients render countdowns against server
 * time", and no client code read it — while the app's single `RESOLVE_TIMEOUT`
 * call site was `TableGateway.snapshot()`, deliberately pinned to
 * `expectedVersion: 0` so that it can never apply. It is a read wearing a
 * command's clothes. An absent player therefore froze a shared table for
 * everybody, indefinitely, with the fifteen-second timer that exists to prevent
 * exactly that already long expired.
 *
 * This asserts the DIFFERENCE, at the wire, in one run: the poll's command
 * leaves the phase where it was, and the store's command advances it. The
 * existing `your_turn` test sends the second one already — but it sends it as
 * the server suite, not as the app, so it could never have caught that the app
 * sent the first one and nothing else.
 */
suite("an expired deadline is resolved by a client asking", () => {
  async function rpc(token: string, name: string, args: Record<string, unknown> = {}) {
    const response = await fetch(`http://127.0.0.1:54321/rest/v1/rpc/${name}`, {
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

  it("ignores the poll's version-0 command and applies the real one", async () => {
    const host = signToken(await createUser());
    const guest = signToken(await createUser());

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
      clientSentAt: new Date().toISOString(),
    });
    expect(started.status).toBe(200);
    const table = started.body.publicState as { version: number; deadlineAt: string | null };
    const gameId = started.body.gameId as string;

    // A shared table states its clock. A solo table deliberately does not — see
    // `PRIVATE_TIMING` in `create-session` — and this is what the client renders
    // the countdown from.
    expect(table.deadlineAt).not.toBeNull();
    expect(Date.parse(table.deadlineAt as string)).toBeGreaterThan(Date.now());

    // Fifteen seconds of real betting window, plus a second for the crossing.
    await new Promise((resolve) => setTimeout(resolve, 16_000));

    // EXACTLY what `TableGateway.snapshot()` sends, three times a second.
    const poll = await call("game-command", host, {
      gameId,
      clientActionId: crypto.randomUUID(),
      expectedVersion: 0,
      type: "RESOLVE_TIMEOUT",
      payload: {},
      clientSentAt: new Date().toISOString(),
    });
    expect(poll.status).toBe(200);
    expect(poll.body.status).toBe("stale");
    const stalled = poll.body.publicState as { phase: string; version: number };
    expect(stalled.phase).toBe("BETTING_OPEN");
    expect(stalled.version).toBe(table.version);

    // What `useOnlineTableStore.resolveTimeout()` sends: the CURRENT version.
    const asked = await call("game-command", host, {
      gameId,
      clientActionId: crypto.randomUUID(),
      expectedVersion: stalled.version,
      type: "RESOLVE_TIMEOUT",
      payload: {},
      clientSentAt: new Date().toISOString(),
    });
    expect(asked.status).toBe(200);
    expect(asked.body.status).toBe("accepted");
    const moved = asked.body.publicState as { phase: string; version: number };
    /*
     * PAST BETTING_OPEN — and not necessarily at PLAYER_TURNS.
     *
     * Resolving the betting deadline stakes the minimum for both seats and the
     * cascade then DEALS, so where it stops depends on the cards: an ordinary
     * hand reaches PLAYER_TURNS, a dealer ACE parks at INSURANCE_OFFER because
     * only a player can answer that, and a dealer natural under the peek settles
     * to HAND_COMPLETE. Asserting PLAYER_TURNS alone passed about twelve runs in
     * thirteen and failed the rest — reproduced in the phase 6 verification pass
     * with `expected 'INSURANCE_OFFER' to be 'PLAYER_TURNS'`, from an ace
     * upcard, in a full `test:server` run whose other 198 tests passed.
     *
     * The subject here is that the version-0 poll applied NOTHING and the real
     * command applied the timeout, so the assertion is that the table moved and
     * moved somewhere the deal can legitimately reach. CLAUDE.md already
     * carries this lesson for `LOCK_BET`; it is the same cascade.
     */
    expect(["PLAYER_TURNS", "INSURANCE_OFFER", "HAND_COMPLETE"]).toContain(moved.phase);
    expect(moved.version).toBeGreaterThan(stalled.version);

    // The defaults are stated and dull, and the engine names each one it applied
    // — never basic strategy played on an absent player's behalf.
    const applied = (asked.body.events as Array<{ event: { type: string; appliedAction?: string } }>)
      .filter((published) => published.event.type === "TIMEOUT_RESOLVED")
      .map((published) => published.event.appliedAction);
    expect(applied).toHaveLength(2);
    for (const action of applied) expect(action).toMatch(/^BET_\d+$/);
  }, 120_000);

  it("refuses a client whose clock is ahead of the server's", async () => {
    const host = signToken(await createUser());
    const guest = signToken(await createUser());

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
      clientSentAt: new Date().toISOString(),
    });
    const table = started.body.publicState as { version: number };

    // Asked immediately. The server checks ITS OWN clock — `clientSentAt` is
    // never forwarded into the engine — so a device running fast can do no more
    // than waste one round trip, which is why the store swallows this code
    // rather than showing it.
    const early = await call("game-command", host, {
      gameId: started.body.gameId,
      clientActionId: crypto.randomUUID(),
      expectedVersion: table.version,
      type: "RESOLVE_TIMEOUT",
      payload: {},
      clientSentAt: new Date(Date.now() + 60_000).toISOString(),
    });
    expect(early.status).toBe(422);
    expect(early.body.code).toBe("DEADLINE_NOT_REACHED");
  }, 60_000);
});
