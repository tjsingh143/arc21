/**
 * The wallet guards, against the REAL Edge Functions and the REAL database.
 *
 * `game-command.integration.test.ts` proves a command cannot be replayed into a
 * second charge. This file proves the other half: a player cannot be charged a
 * second buy-in by taking a second SEAT.
 *
 * The defect it was written for was reproduced against this stack before a line
 * of the fix existed. A player already seated at public table A re-queued,
 * `poll_matchmaking` allocated them a DIFFERENT room B, and `JOIN_PUBLIC_TABLE`
 * bought them in again out of the same wallet:
 *
 *   JOIN A: 200 {"wallet":23000,"buyIn":2000}
 *   join_matchmaking again: 200 {"status":"waiting"}   ← already seated
 *   poll: 200 [{"status":"matched","room_id":"…"}]     ← a different room
 *   JOIN B: 200 {"wallet":21000}                       ← charged twice
 *
 * `docs/RELEASE.md` carried this as needing a force-quit. It does not: the
 * ordinary matchmaking path is enough, which is why it is a blocker and not a
 * deferred edge case.
 *
 * Two enforcement points, and the distinction matters. `join_matchmaking`
 * refusing is a COURTESY, like its level check — it keeps a client out of a
 * queue it cannot use. `joinPublicTable` refusing is the CONTROL, because it is
 * the one standing next to the money. Both are asserted here, separately, so a
 * regression in either is named rather than masked by the other.
 *
 *   supabase start
 *   supabase functions serve --no-verify-jwt
 */

import crypto from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";

import { stackUp } from "./stack-guard.js";

const FUNCTIONS = "http://127.0.0.1:54321/functions/v1";
const REST = "http://127.0.0.1:54321/rest/v1";
const AUTH_ADMIN = "http://127.0.0.1:54321/auth/v1/admin/users";

/** Published local-development keys. Identical on every machine, useless elsewhere. */
const LOCAL_JWT_SECRET = "super-secret-jwt-token-with-at-least-32-characters-long";
const LOCAL_SERVICE_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU";
const LOCAL_ANON_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0";

const CASUAL_BUY_IN = 2000;

const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");

/**
 * Tokens are backdated by a minute, and that is not cosmetic.
 *
 * PostgREST validates `iat` against the DATABASE CONTAINER's clock and answers
 * `PGRST303 "JWT issued at future"` when it is even slightly ahead. The host
 * and the container drift by a second or two under load, so an `iat` of exactly
 * "now" is a coin flip — and the failure does not look like a clock problem. It
 * looks like a wallet that reads as -1, a profile column that reads as null, or
 * a career reward that was never paid.
 *
 * Sixty seconds is the same allowance the FUNCTION's own verifier makes, and it
 * is test-only: Supabase issues real tokens server-side, where there is one
 * clock.
 */
const CLOCK_SKEW_ALLOWANCE_SECONDS = 60;

function signToken(sub: string): string {
  const header = b64({ alg: "HS256", typ: "JWT" });
  const now = Math.floor(Date.now() / 1000);
  const payload = b64({ sub, role: "authenticated", aud: "authenticated", iat: now - CLOCK_SKEW_ALLOWANCE_SECONDS, exp: now + 3600 });
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

async function call(fn: string, token: string, body: unknown): Promise<CallResult> {
  const response = await fetch(`${FUNCTIONS}/${fn}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
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

/** Calls an RPC as a signed-in player — never as the service role. */
async function rpc(token: string, name: string, args: unknown = {}): Promise<{ status: number; body: unknown }> {
  const response = await fetch(`${REST}/rpc/${name}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: LOCAL_ANON_KEY,
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(args),
  });
  const raw = await response.text();
  let body: unknown = null;
  try {
    body = JSON.parse(raw) as unknown;
  } catch {
    body = raw;
  }
  return { status: response.status, body };
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
      email: `guard-${crypto.randomUUID()}@arc21.test`,
      password: crypto.randomUUID(),
      email_confirm: true,
    }),
  });
  const json = (await response.json()) as { id?: string };
  if (!json.id) throw new Error(`could not create a test user: ${response.status}`);
  return json.id;
}

/**
 * Read as the PLAYER, never as the service role.
 *
 * Not a stylistic choice: `public.wallets` and `public.game_session_seats` carry
 * no grant to `service_role` at all — REST answers 42501 for it — because chip
 * writes are server-only and the only client that may read a wallet is its
 * owner. So the assertions go through the same RLS the app does, which makes
 * them evidence about the shipped policy as well as about the balance.
 */
async function readAs(token: string, path: string): Promise<unknown> {
  const response = await fetch(`${REST}/${path}`, {
    headers: { apikey: LOCAL_ANON_KEY, Authorization: `Bearer ${token}` },
  });
  return (await response.json()) as unknown;
}

async function balanceOf(token: string): Promise<number> {
  const rows = (await readAs(token, "wallets?select=balance")) as { balance: number }[];
  if (!Array.isArray(rows) || rows.length !== 1) {
    throw new Error(`could not read the player's own wallet: ${JSON.stringify(rows)}`);
  }
  return Number(rows[0]?.balance);
}

/**
 * Every live seat THIS player holds. The invariant under test is at most one.
 *
 * `user_id=eq.` is load-bearing, not decoration. `game_session_seats_select_participant`
 * shows a participant EVERY seat at a table they are sitting at — correctly, because a
 * player has to see the other stacks — so the unfiltered query returns the whole
 * table. It reported two seats for one player the first time a second account
 * happened to be matched into the same public room, which reads exactly like the
 * defect this file exists to catch. Reproduced deliberately under load before it
 * was believed: two rows, same `game_session_id`, seat indexes 0 and 1.
 *
 * A read through RLS is scoped to what the POLICY permits, which is not the same
 * as "your own rows".
 */
async function liveSeats(token: string, userId: string): Promise<{ game_session_id: string }[]> {
  const rows = (await readAs(
    token,
    `game_session_seats?user_id=eq.${userId}&status=neq.left` +
      "&select=game_session_id,status,game_sessions!inner(status)" +
      "&game_sessions.status=in.(lobby,active)",
  )) as { game_session_id: string }[];
  if (!Array.isArray(rows)) throw new Error(`could not read seats: ${JSON.stringify(rows)}`);
  return rows;
}

const iso = () => new Date().toISOString();

/** Queue, poll, and return the room the player was allocated. */
async function matchIntoARoom(token: string): Promise<string | null> {
  await rpc(token, "join_matchmaking", { p_tier: "casual" });
  const polled = await rpc(token, "poll_matchmaking");
  const rows = polled.body as { status?: string; room_id?: string }[] | null;
  const matched = Array.isArray(rows) ? rows.find((row) => row.status === "matched") : undefined;
  return matched?.room_id ?? null;
}

const suite = stackUp ? describe : describe.skip;

suite("one live seat per player", () => {
  /**
   * THE CONTROL, on a path that is open today through client calls only.
   *
   * Being MATCHED is not being seated: `poll_matchmaking` makes a player a
   * member of a lobby and charges nothing. So a player can hold a matched room
   * and, before taking that seat, open a solo table — which the solo path
   * allows, because at that moment they hold no seat. Taking the public seat
   * afterwards is where the second escrow is created, and `joinPublicTable` is
   * the only thing standing there.
   *
   * This needs no force-quit, no race and no service-role fixture.
   */
  it("refuses a public buy-in while the player holds a live solo seat", async () => {
    const userId = await createUser();
    const token = signToken(userId);

    const opening = await balanceOf(token);
    expect(opening).toBeGreaterThan(CASUAL_BUY_IN * 2);

    const room = await matchIntoARoom(token);
    expect(room).toBeTruthy();

    const solo = await call("create-session", token, {
      action: "OPEN",
      clientRequestId: crypto.randomUUID(),
      tier: "casual",
      clientSentAt: iso(),
    });
    expect(solo.status).toBe(200);
    expect(await balanceOf(token)).toBe(opening - CASUAL_BUY_IN);

    const joined = await call("create-session", token, {
      action: "JOIN_PUBLIC_TABLE",
      clientRequestId: crypto.randomUUID(),
      roomId: room,
      clientSentAt: iso(),
    });
    expect(joined.status).toBe(409);
    expect(joined.body.code).toBe("SESSION_ALREADY_ACTIVE");

    expect(await balanceOf(token)).toBe(opening - CASUAL_BUY_IN);
    expect(await liveSeats(token, userId)).toHaveLength(1);
  }, 60_000);

  /**
   * THE COURTESY, and the exact sequence that was reproduced against this stack.
   *
   * `join_matchmaking` looks for a `waiting` entry to reuse. A player who has
   * been matched holds a `matched` one, so the lookup missed and a second
   * enrolment was created — which `poll_matchmaking` then allocated to a
   * different room, because the first had left `lobby` when it opened.
   */
  it("refuses to queue a player who already holds a live seat", async () => {
    const userId = await createUser();
    const token = signToken(userId);

    const opening = await balanceOf(token);
    const roomA = await matchIntoARoom(token);
    expect(roomA).toBeTruthy();

    const joinA = await call("create-session", token, {
      action: "JOIN_PUBLIC_TABLE",
      clientRequestId: crypto.randomUUID(),
      roomId: roomA,
      clientSentAt: iso(),
    });
    expect(joinA.status).toBe(200);
    expect(await balanceOf(token)).toBe(opening - CASUAL_BUY_IN);

    const requeue = await rpc(token, "join_matchmaking", { p_tier: "casual" });
    expect(requeue.status).toBeGreaterThanOrEqual(400);

    // And nothing downstream of the refusal allocated a second room either.
    const polled = await rpc(token, "poll_matchmaking");
    const rows = (polled.body ?? []) as { room_id?: string }[];
    for (const row of Array.isArray(rows) ? rows : []) {
      expect(row.room_id).toBe(roomA);
    }

    expect(await balanceOf(token)).toBe(opening - CASUAL_BUY_IN);
    expect(await liveSeats(token, userId)).toHaveLength(1);
  }, 60_000);

  /**
   * The guard keys on a DIFFERENT session, not on holding a seat at all — so a
   * reconnect to the table the player is already at stays idempotent. Getting
   * this wrong would lock a player out of their own chips, which is worse than
   * the defect being fixed.
   */
  it("still lets a player re-join the table they are already sitting at", async () => {
    const userId = await createUser();
    const token = signToken(userId);

    const opening = await balanceOf(token);
    const room = await matchIntoARoom(token);
    expect(room).toBeTruthy();

    const first = await call("create-session", token, {
      action: "JOIN_PUBLIC_TABLE",
      clientRequestId: crypto.randomUUID(),
      roomId: room,
      clientSentAt: iso(),
    });
    expect(first.status).toBe(200);
    const after = await balanceOf(token);
    expect(after).toBe(opening - CASUAL_BUY_IN);

    const again = await call("create-session", token, {
      action: "JOIN_PUBLIC_TABLE",
      clientRequestId: crypto.randomUUID(),
      roomId: room,
      clientSentAt: iso(),
    });
    expect(again.status).toBe(200);
    expect(again.body.gameId).toBe(first.body.gameId);
    expect(await balanceOf(token)).toBe(after);
    expect(await liveSeats(token, userId)).toHaveLength(1);
  }, 60_000);
});
