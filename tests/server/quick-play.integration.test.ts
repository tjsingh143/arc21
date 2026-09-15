/**
 * Quick Play, against the REAL Edge Functions and the REAL database.
 *
 * `create-session`'s `OPEN` has been the most heavily covered path in
 * `tests/server` since the economy shipped, and **no client had ever sent it**:
 * `grep -rn '"OPEN"' app src shared` returned a comment and the contract
 * literal, nothing else. The Play screen's card was grey with an honest note
 * saying the screen did not exist. That is the "built but never connected"
 * pattern this repository keeps finding, and the eleventh instance of it.
 *
 * What is new here and needs proving is the ASSISTANCE mode, because it is the
 * one client-supplied value that changes what the server does:
 *
 *   * it decides whether the server SENDS the recommendation with the
 *     snapshot, and
 *   * it decides whether the session's decisions count towards the qualified
 *     strategy-accuracy board — the specification excludes "modes where answer
 *     was shown before choice", and Learn is exactly that.
 *
 * Both are properties of the SESSION ROW, not of a request field the client can
 * revise per decision. A client that could name its assistance per action could
 * opt a mistake out of its own accuracy and opt a good decision in.
 *
 *   supabase start
 *   supabase functions serve --no-verify-jwt
 */

import crypto from "node:crypto";
import { describe, expect, it } from "vitest";

import { callFunction as call } from "./call-function.js";
import { stackUp } from "./stack-guard.js";

const REST = "http://127.0.0.1:54321/rest/v1";
const AUTH_ADMIN = "http://127.0.0.1:54321/auth/v1/admin/users";

const LOCAL_JWT_SECRET = "super-secret-jwt-token-with-at-least-32-characters-long";
const LOCAL_SERVICE_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU";
const LOCAL_ANON_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0";

const CASUAL_BUY_IN = 2000;

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
function signToken(sub: string): string {
  const header = b64({ alg: "HS256", typ: "JWT" });
  const now = Math.floor(Date.now() / 1000);
  const payload = b64({ sub, role: "authenticated", aud: "authenticated", exp: now + 3600 });
  const signature = crypto
    .createHmac("sha256", LOCAL_JWT_SECRET)
    .update(`${header}.${payload}`)
    .digest("base64url");
  return `${header}.${payload}.${signature}`;
}


async function readAs(token: string, path: string): Promise<unknown> {
  const response = await fetch(`${REST}/${path}`, {
    headers: { apikey: LOCAL_ANON_KEY, Authorization: `Bearer ${token}` },
  });
  return (await response.json()) as unknown;
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
      email: `quick-${crypto.randomUUID()}@arc21.test`,
      password: crypto.randomUUID(),
      email_confirm: true,
    }),
  });
  const json = (await response.json()) as { id?: string };
  if (!json.id) throw new Error(`could not create a test user: ${response.status}`);
  return json.id;
}

async function balanceOf(token: string): Promise<number> {
  const rows = (await readAs(token, "wallets?select=balance")) as { balance: number }[];
  if (!Array.isArray(rows) || rows.length !== 1) {
    throw new Error(`could not read own wallet: ${JSON.stringify(rows)}`);
  }
  return Number(rows[0]?.balance);
}

/** This week's graded-decision counters, scoped to the caller's own row. */
async function decisionsThisWeek(token: string, userId: string): Promise<number> {
  const rows = (await readAs(
    token,
    `player_decision_periods?user_id=eq.${userId}&select=decisions_total`,
  )) as { decisions_total: number }[];
  if (!Array.isArray(rows) || rows.length === 0) return 0;
  return rows.reduce((total, row) => total + Number(row.decisions_total), 0);
}

interface Snapshot {
  version: number;
  phase: string;
  activeSeatId: string | null;
  legalActions: Record<
    string,
    { canDeclineInsurance?: boolean; betBounds?: { min: number } | null; actions?: string[] }
  >;
  advice?: { seatId: string; recommended: string; explanation: string; actionEvMicros: Record<string, number> | null } | null;
}

const iso = () => new Date().toISOString();

/** Opens a table and plays until it is this seat's turn, returning the snapshot. */
async function openAndReachTurn(
  token: string,
  assistance: string | undefined,
): Promise<{ gameId: string; seatId: string; state: Snapshot; send: (type: string, payload?: Record<string, unknown>) => Promise<{ status: number; body: Record<string, unknown> }> }> {
  const opened = await call("create-session", token, {
    action: "OPEN",
    clientRequestId: crypto.randomUUID(),
    tier: "casual",
    ...(assistance ? { assistance } : {}),
    clientSentAt: iso(),
  });
  if (opened.status !== 200) throw new Error(`OPEN failed: ${opened.status} ${opened.raw}`);

  const gameId = opened.body.gameId as string;
  const seatId = opened.body.seatId as string;
  let state = opened.body.publicState as Snapshot;

  const send = async (type: string, payload?: Record<string, unknown>) => {
    const result = await call("game-command", token, {
      gameId,
      clientActionId: crypto.randomUUID(),
      type,
      ...(payload ? { payload } : {}),
      expectedVersion: state.version,
      clientSentAt: iso(),
    });
    if (result.body.publicState) state = result.body.publicState as Snapshot;
    return result;
  };

  // Deal until this seat is asked to act. A natural settles the hand without a
  // decision, so keep dealing rather than asserting the first hand offers one.
  for (let guard = 0; guard < 30; guard += 1) {
    if (state.phase === "PLAYER_TURNS" && state.activeSeatId === seatId) break;
    if (state.phase === "BETTING_OPEN") {
      await send("PLACE_BET", { amount: state.legalActions[seatId]?.betBounds?.min ?? 20 });
      await send("LOCK_BET");
      continue;
    }
    if (state.phase === "INSURANCE_OFFER" && state.legalActions[seatId]?.canDeclineInsurance) {
      await send("DECLINE_INSURANCE");
      continue;
    }
    if (state.phase === "HAND_COMPLETE") {
      await send("NEXT_HAND");
      continue;
    }
    break;
  }

  return { gameId, seatId, state, send };
}

const suite = stackUp ? describe : describe.skip;

suite("Quick Play", () => {
  it("opens a solo table, debits once, and sends no advice unasked", async () => {
    const token = signToken(await createUser());
    const opening = await balanceOf(token);

    const { state, seatId } = await openAndReachTurn(token, undefined);
    expect(await balanceOf(token)).toBe(opening - CASUAL_BUY_IN);

    expect(state.phase).toBe("PLAYER_TURNS");
    expect(state.activeSeatId).toBe(seatId);
    // The DEFAULT is unassisted, and an unassisted table must not carry advice.
    // Sending it "just in case" would put the answer on screen for a session
    // whose decisions are being counted.
    expect(state.advice ?? null).toBeNull();
  }, 120_000);

  it("sends the recommendation on a Learn table, and only to that seat's turn", async () => {
    const token = signToken(await createUser());
    const { state, seatId } = await openAndReachTurn(token, "learn");

    expect(state.advice).toBeTruthy();
    expect(state.advice?.seatId).toBe(seatId);
    expect(state.legalActions[seatId]?.actions ?? []).toContain(state.advice?.recommended);
    expect(state.advice?.explanation).toMatch(/against/);
    // Learn gets the recommendation and no numbers. Analysis is the one that
    // prices every action.
    expect(state.advice?.actionEvMicros ?? null).toBeNull();
  }, 120_000);

  it("prices every legal action on an Analysis table, in integers", async () => {
    const token = signToken(await createUser());
    const { state, seatId } = await openAndReachTurn(token, "analysis");

    expect(state.advice).toBeTruthy();
    const evs = state.advice?.actionEvMicros ?? {};
    expect(Object.keys(evs).length).toBeGreaterThan(0);
    for (const [action, micros] of Object.entries(evs)) {
      expect(state.legalActions[seatId]?.actions ?? []).toContain(action);
      // Millionths as integers. No float decides anything a player is scored on.
      expect(Number.isInteger(micros)).toBe(true);
    }
    // The recommendation is the best-priced action the chart allows.
    expect(Object.keys(evs)).toContain(state.advice?.recommended);
  }, 120_000);

  it("keeps a Learn table's decisions off the strategy leaderboard", async () => {
    const userId = await createUser();
    const token = signToken(userId);
    const before = await decisionsThisWeek(token, userId);

    const { state, seatId, send } = await openAndReachTurn(token, "learn");
    expect(state.phase).toBe("PLAYER_TURNS");
    expect(state.activeSeatId).toBe(seatId);
    const acted = await send("STAND");
    expect(acted.status).toBe(200);

    // The specification excludes "modes where answer was shown before choice".
    // The server sent the answer, so the server knows not to count it — the
    // client is not asked and could not be believed if it were.
    expect(await decisionsThisWeek(token, userId)).toBe(before);
  }, 120_000);

  it("counts an unassisted table's decisions, so the exclusion is not blanket", async () => {
    const userId = await createUser();
    const token = signToken(userId);
    const before = await decisionsThisWeek(token, userId);

    const { state, seatId, send } = await openAndReachTurn(token, "play");
    expect(state.phase).toBe("PLAYER_TURNS");
    expect(state.activeSeatId).toBe(seatId);
    expect(await send("STAND")).toMatchObject({ status: 200 });

    expect(await decisionsThisWeek(token, userId)).toBe(before + 1);
  }, 120_000);

  it("refuses an assistance mode that is not one of the four", async () => {
    const token = signToken(await createUser());
    const refused = await call("create-session", token, {
      action: "OPEN",
      clientRequestId: crypto.randomUUID(),
      tier: "casual",
      assistance: "godmode",
      clientSentAt: iso(),
    });
    expect(refused.status).toBe(400);
    expect(refused.body.code).toBe("INVALID_REQUEST");
  }, 60_000);
});
