/**
 * A SYSTEMATIC BOLA SWEEP: every id a client may name, named by somebody else.
 *
 * THE GAP THIS FILLS. `rls-idor.integration.test.ts` sweeps what a second
 * account can READ through PostgREST. Nothing swept what a second account can
 * DO through the Edge Functions and the RPCs by putting a real, live,
 * *someone-else's* id in the field where their own would go — and that is a
 * different question, because these endpoints do not run under RLS at all. They
 * run as `postgres`, or as `SECURITY DEFINER`, and every one of them is
 * responsible for its own ownership check.
 *
 * The existing coverage is per-feature and it is good: `sprint-tournament`
 * refuses a stranger's command at a tournament table, `private-rooms` and
 * `public-table` cover their own guards, `rejection-contract` covers ids that do
 * not exist. What none of them does is enumerate the WIRE SURFACE and put a
 * foreign id in every slot — which is how the "one live seat" family of defects
 * kept being found in a mode nobody had checked, phase after phase.
 *
 * TWO THINGS EVERY CASE ASSERTS.
 *
 *   1. **A refusal, 4xx.** Not a 500, which would mean the endpoint got as far
 *      as something that assumed ownership.
 *   2. **The victim's state is UNCHANGED afterwards**, read back rather than
 *      inferred from the refusal. A refusal that still moved a chip is the
 *      shape this project has shipped before.
 *
 * And one case asserts the opposite on purpose: the owner CAN do the thing the
 * stranger could not, so nothing here is passing because the endpoint refuses
 * everybody.
 *
 *   supabase start
 *   supabase functions serve --no-verify-jwt
 */

import crypto from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";

import { CAREER_NODES } from "../../shared/career/index.js";
import { callFunction as call } from "./call-function.js";
import { stackUp } from "./stack-guard.js";

const REST = "http://127.0.0.1:54321/rest/v1";
const AUTH_ADMIN = "http://127.0.0.1:54321/auth/v1/admin/users";

const LOCAL_JWT_SECRET = "super-secret-jwt-token-with-at-least-32-characters-long";
const LOCAL_SERVICE_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU";

const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");

/** No `iat` — see the note in `rejection-contract.integration.test.ts`. */
function signToken(sub: string): string {
  const header = b64({ alg: "HS256", typ: "JWT" });
  const payload = b64({
    sub,
    role: "authenticated",
    aud: "authenticated",
    exp: Math.floor(Date.now() / 1000) + 3600,
  });
  const signature = crypto
    .createHmac("sha256", LOCAL_JWT_SECRET)
    .update(`${header}.${payload}`)
    .digest("base64url");
  return `${header}.${payload}.${signature}`;
}

async function createUser(prefix: string): Promise<string> {
  const response = await fetch(AUTH_ADMIN, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: LOCAL_SERVICE_KEY,
      Authorization: `Bearer ${LOCAL_SERVICE_KEY}`,
    },
    body: JSON.stringify({
      email: `${prefix}-${crypto.randomUUID()}@arc21.test`,
      password: crypto.randomUUID(),
      email_confirm: true,
    }),
  });
  const json = (await response.json()) as { id?: string };
  if (!json.id) throw new Error(`could not create a test user: ${response.status}`);
  return json.id;
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
  let parsed: unknown = raw;
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = raw;
  }
  return { status: response.status, raw, body: parsed };
}

/** A wallet balance, or a THROW. A helper that reads must never return a sentinel. */
async function walletOf(token: string): Promise<number> {
  const response = await fetch(`${REST}/wallets?select=balance`, {
    headers: { apikey: LOCAL_SERVICE_KEY, Authorization: `Bearer ${token}` },
  });
  const rows = (await response.json()) as { balance?: number }[];
  const balance = rows[0]?.balance;
  if (typeof balance !== "number") throw new Error(`could not read a wallet: ${JSON.stringify(rows)}`);
  return balance;
}

const iso = () => new Date().toISOString();
const suite = stackUp ? describe : describe.skip;

suite("naming somebody else's object", () => {
  /** The victim. Holds a solo table, a private room and a career attempt. */
  let ownerId = "";
  let owner = "";
  /** The attacker. A real, signed-in account with no relationship to the owner. */
  let stranger = "";
  /**
   * A SECOND victim, holding the career attempt.
   *
   * It cannot be the owner above: `assertNoOtherLiveSeat` correctly refuses a
   * career node to an account already sitting at a solo table, so trying to give
   * one account both objects fails the FIXTURE rather than the guard — which is
   * the fixture proving the one-live-seat rule while looking like a broken test.
   */
  let attemptOwner = "";

  let gameId = "";
  let seatId = "";
  let roomId = "";
  let attemptId = "";
  let ownerStackBefore = 0;
  let ownerWalletBefore = 0;

  beforeAll(async () => {
    if (!stackUp) return;
    ownerId = await createUser("bola-owner");
    owner = signToken(ownerId);
    stranger = signToken(await createUser("bola-stranger"));

    const opened = await call("create-session", owner, {
      action: "OPEN",
      clientRequestId: crypto.randomUUID(),
      tier: "casual",
      clientSentAt: iso(),
    });
    if (opened.status !== 200) throw new Error(`could not open a table: ${opened.status} ${opened.raw}`);
    gameId = String(opened.body.gameId);
    seatId = String(opened.body.seatId);
    ownerWalletBefore = Number(opened.body.walletBalance);

    const room = await rpc(owner, "create_private_room", { p_max_seats: 2 });
    if (room.status >= 400) throw new Error(`create_private_room: ${room.status} ${room.raw}`);
    roomId = (room.body as { id: string }).id;

    // A career attempt: the one object id the wire contract lets a client name
    // that is neither a game nor a room. Opened by its own account, for the
    // reason given where `attemptOwner` is declared.
    attemptOwner = signToken(await createUser("bola-attempt-owner"));
    const attempt = await call("create-session", attemptOwner, {
      action: "START_CAREER_NODE",
      clientRequestId: crypto.randomUUID(),
      nodeSlug: CAREER_NODES[0]!.slug,
      clientSentAt: iso(),
    });
    if (attempt.status !== 200) {
      throw new Error(`could not start a career node: ${attempt.status} ${attempt.raw}`);
    }
    attemptId = String(attempt.body.attemptId);

    const seats = (await (
      await fetch(`${REST}/game_session_seats?select=stack&id=eq.${seatId}`, {
        headers: { apikey: LOCAL_SERVICE_KEY, Authorization: `Bearer ${owner}` },
      })
    ).json()) as { stack: number }[];
    const stack = seats[0]?.stack;
    if (typeof stack !== "number") throw new Error("could not read the owner's stack");
    ownerStackBefore = stack;
  }, 180_000);

  /** A sweep over an absent fixture proves nothing, so the fixture is asserted. */
  it("has a live table, a room and an attempt to attack", () => {
    expect(gameId, "no game id").not.toBe("");
    expect(roomId, "no room id").not.toBe("");
    expect(attemptId, "no career attempt id").not.toBe("");
    expect(ownerStackBefore).toBeGreaterThan(0);
  });

  /**
   * Every session action that names an id, with the OWNER's id in it.
   *
   * `RESET_PRIVATE_STACK` is expected to refuse for a different reason than the
   * others — the mode is wrong before the seat is — and that is fine: what must
   * not happen is that it works. The assertion is on the class of answer.
   */
  it("refuses every session command that names the owner's game or room", async () => {
    const attempts: { name: string; body: Record<string, unknown> }[] = [
      { name: "CASH_OUT of the owner's table", body: { action: "CASH_OUT", gameId } },
      { name: "RESET_PRIVATE_STACK on the owner's table", body: { action: "RESET_PRIVATE_STACK", gameId } },
      { name: "START_PRIVATE_TABLE on the owner's room", body: { action: "START_PRIVATE_TABLE", roomId } },
      { name: "JOIN_PUBLIC_TABLE on the owner's room", body: { action: "JOIN_PUBLIC_TABLE", roomId } },
      {
        name: "SUBMIT_CAREER_DRILL against the owner's attempt",
        body: { action: "SUBMIT_CAREER_DRILL", attemptId, answers: ["HIT"] },
      },
    ];

    for (const attempt of attempts) {
      const answer = await call("create-session", stranger, {
        ...attempt.body,
        clientRequestId: crypto.randomUUID(),
        clientSentAt: iso(),
      });
      expect(answer.status, `${attempt.name}: HTTP ${answer.status} ${answer.raw}`).toBeGreaterThanOrEqual(400);
      expect(answer.status, `${attempt.name}: ${answer.raw}`).toBeLessThan(500);
      expect(answer.body.status, attempt.name).toBe("rejected");
    }
  }, 180_000);

  it("refuses every game command against the owner's table", async () => {
    for (const type of ["PLACE_BET", "LOCK_BET", "HIT", "STAND", "DOUBLE", "SPLIT", "SURRENDER", "INSURANCE", "DECLINE_INSURANCE", "NEXT_HAND", "RESOLVE_TIMEOUT", "LEAVE"]) {
      const answer = await call("game-command", stranger, {
        gameId,
        clientActionId: crypto.randomUUID(),
        type,
        ...(type === "PLACE_BET" ? { payload: { amount: 100 } } : {}),
        expectedVersion: 0,
        clientSentAt: iso(),
      });
      expect(answer.status, `${type}: HTTP ${answer.status} ${answer.raw}`).toBe(403);
      expect(answer.body.code, type).toBe("NOT_A_PARTICIPANT");
    }
  }, 180_000);

  it("refuses every room RPC that names the owner's room", async () => {
    const attempts: { name: string; fn: string; args: Record<string, unknown> }[] = [
      { name: "get_room_state", fn: "get_room_state", args: { p_room_id: roomId } },
      { name: "set_room_ready", fn: "set_room_ready", args: { p_room_id: roomId, p_ready: true } },
      { name: "remove_room_member", fn: "remove_room_member", args: { p_room_id: roomId, p_user_id: ownerId } },
      { name: "invite_friend_to_room", fn: "invite_friend_to_room", args: { p_room_id: roomId, p_friend: ownerId } },
      { name: "leave_room", fn: "leave_room", args: { p_room_id: roomId } },
    ];

    for (const attempt of attempts) {
      const answer = await rpc(stranger, attempt.fn, attempt.args);
      // Two shapes are correct here and both are refusals: a raised `PT404`
      // ("you are not at that table"), or an empty answer from a function that
      // must NOT raise because its rate limit has to survive the transaction.
      const refused =
        answer.status >= 400 ||
        answer.raw === "" ||
        answer.raw === "null" ||
        answer.raw === "[]" ||
        answer.raw === "false";
      expect(refused, `${attempt.name} answered ${answer.status} ${answer.raw.slice(0, 160)}`).toBe(true);
      expect(answer.status, `${attempt.name} raised a server fault`).toBeLessThan(500);
    }

    // And the room is intact, read back rather than inferred from the refusals.
    const members = (await (
      await fetch(`${REST}/room_members?select=user_id,status&room_id=eq.${roomId}`, {
        headers: { apikey: LOCAL_SERVICE_KEY, Authorization: `Bearer ${owner}` },
      })
    ).json()) as { user_id: string; status: string }[];
    expect(members.filter((m) => m.status === "joined").map((m) => m.user_id)).toEqual([ownerId]);
  }, 180_000);

  it("leaves the owner's chips and seat exactly where they were", async () => {
    const seats = (await (
      await fetch(`${REST}/game_session_seats?select=stack,status&id=eq.${seatId}`, {
        headers: { apikey: LOCAL_SERVICE_KEY, Authorization: `Bearer ${owner}` },
      })
    ).json()) as { stack: number; status: string }[];
    expect(seats[0]?.stack, "the stranger moved the owner's stack").toBe(ownerStackBefore);
    expect(seats[0]?.status, "the stranger closed the owner's seat").toBe("active");
    expect(await walletOf(owner), "the stranger moved the owner's wallet").toBe(ownerWalletBefore);
  }, 60_000);

  /**
   * THE CONTROL. Every refusal above is worthless if the endpoints refuse
   * everybody, so the owner does one of the same things and it works.
   */
  it("still lets the OWNER act on their own table and room", async () => {
    const state = await rpc(owner, "get_room_state", { p_room_id: roomId });
    expect(state.status).toBe(200);
    expect(state.raw).not.toBe("null");

    const bet = await call("game-command", owner, {
      gameId,
      clientActionId: crypto.randomUUID(),
      type: "PLACE_BET",
      payload: { amount: 100 },
      // The version the stranger's refused commands could not learn.
      expectedVersion: 1,
      clientSentAt: iso(),
    });
    // Accepted, or `stale` with the authoritative snapshot — both mean the seat
    // is the caller's. `NOT_A_PARTICIPANT` would mean it is not.
    expect([200], `owner's own bet: ${bet.status} ${bet.raw}`).toContain(bet.status);
    expect(["accepted", "stale"]).toContain(String(bet.body.status));
  }, 120_000);
});
