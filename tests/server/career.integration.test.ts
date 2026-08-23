/**
 * Career progression, against the REAL Edge Functions and the REAL database.
 *
 * WHAT WAS BROKEN. Nothing anywhere wrote `public.career_progress`. The table
 * existed with its constraints, its RLS and its deny-client-write trigger. The
 * cosmetic gates read it. `shared/career/progress.ts` marked a completed node's
 * reward `rewardOwed` and left `rewardClaimed` false "until a server grants
 * them", and `pendingRewards()` had zero callers. No server granted anything.
 * Three MVP acceptance criteria failed on it — Rewards, Cosmetics earned, and
 * eight of twenty-four cosmetics unobtainable — and so did the Definition of
 * Done's "complete career progression".
 *
 * WHAT THIS PROVES. That a node played through the server's own shoe awards
 * stars, pays its chips and XP exactly once, unlocks the next node, and that a
 * drill is graded against scenarios the SERVER generated rather than against
 * anything the client sent.
 *
 * Written as an integration test rather than a unit test on purpose. Every
 * defect this file is about was invisible to a green unit suite: the pieces all
 * worked, and nothing connected them.
 *
 *   supabase start
 *   supabase functions serve --no-verify-jwt
 */

import crypto from "node:crypto";
import { describe, expect, it } from "vitest";

import { CAREER_NODES } from "../../shared/career/index.js";
import { stackUp } from "./stack-guard.js";

const FUNCTIONS = "http://127.0.0.1:54321/functions/v1";
const REST = "http://127.0.0.1:54321/rest/v1";
const AUTH_ADMIN = "http://127.0.0.1:54321/auth/v1/admin/users";

const LOCAL_JWT_SECRET = "super-secret-jwt-token-with-at-least-32-characters-long";
const LOCAL_SERVICE_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU";
const LOCAL_ANON_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0";

const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");

function signToken(sub: string): string {
  const header = b64({ alg: "HS256", typ: "JWT" });
  const now = Math.floor(Date.now() / 1000);
  const payload = b64({ sub, role: "authenticated", aud: "authenticated", iat: now, exp: now + 3600 });
  const signature = crypto
    .createHmac("sha256", LOCAL_JWT_SECRET)
    .update(`${header}.${payload}`)
    .digest("base64url");
  return `${header}.${payload}.${signature}`;
}

async function call(fn: string, token: string, body: unknown) {
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

async function rpc(token: string, name: string, args: unknown = {}) {
  const response = await fetch(`${REST}/rpc/${name}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: LOCAL_ANON_KEY,
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(args),
  });
  return { status: response.status, body: (await response.json()) as unknown };
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
      email: `career-${crypto.randomUUID()}@arc21.test`,
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
  return Number(rows[0]?.balance ?? -1);
}

/**
 * Scoped to the caller's OWN id, deliberately.
 *
 * `public.profiles` is a directory: an authenticated caller reads every row, so
 * `profiles?select=xp` returns the whole table and `rows[0]` is a stranger.
 * This helper asked for exactly that and asserted against somebody else's zero.
 */
async function xpOf(token: string, userId: string): Promise<number> {
  const rows = (await readAs(token, `profiles?id=eq.${userId}&select=xp`)) as { xp: number }[];
  if (!Array.isArray(rows) || rows.length !== 1) {
    throw new Error(`could not read own profile: ${JSON.stringify(rows)}`);
  }
  return Number(rows[0]?.xp);
}

interface Snapshot {
  version: number;
  phase: string;
  handNumber: number;
  activeSeatId: string | null;
  seats: Array<{ seatId: string; stack: number }>;
  legalActions: Record<
    string,
    { canDeclineInsurance?: boolean; canStartNextHand?: boolean; betBounds?: { min: number; max: number } | null }
  >;
}

const iso = () => new Date().toISOString();

/**
 * Plays a standard career node to its end, standing on everything.
 *
 * Standing every hand is deliberate: it makes the run deterministic in SHAPE
 * (the same number of commands regardless of the cards) without making the
 * CARDS deterministic — the shoe is the server's CSPRNG and nothing here looks
 * at it. It is also a strategy a real player could follow, so the accuracy the
 * server grades is a real accuracy, not a fabricated one.
 */
async function playStandardNode(
  token: string,
  slug: string,
): Promise<{ started: Record<string, unknown>; handsPlayed: number; finalChips: number }> {
  const started = await call("create-session", token, {
    action: "START_CAREER_NODE",
    clientRequestId: crypto.randomUUID(),
    nodeSlug: slug,
    clientSentAt: iso(),
  });
  if (started.status !== 200) {
    throw new Error(`could not start ${slug}: ${started.status} ${started.raw}`);
  }

  const gameId = started.body.gameId as string;
  const seatId = started.body.seatId as string;
  let state = started.body.publicState as Snapshot;

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

  const node = CAREER_NODES.find((candidate) => candidate.slug === slug);
  const target = node?.hands ?? 0;

  // A generous bound: the loop exits on SESSION_COMPLETE, and this only stops a
  // broken server from spinning forever.
  for (let guard = 0; guard < target * 4 + 20; guard += 1) {
    if (state.phase === "SESSION_COMPLETE") break;

    if (state.phase === "BETTING_OPEN") {
      const bounds = state.legalActions[seatId]?.betBounds;
      await send("PLACE_BET", { amount: bounds?.min ?? 20 });
      await send("LOCK_BET");
      continue;
    }
    if (state.phase === "INSURANCE_OFFER" && state.legalActions[seatId]?.canDeclineInsurance) {
      await send("DECLINE_INSURANCE");
      continue;
    }
    if (state.phase === "PLAYER_TURNS" && state.activeSeatId === seatId) {
      await send("STAND");
      continue;
    }
    if (state.phase === "HAND_COMPLETE") {
      await send("NEXT_HAND");
      continue;
    }
    break;
  }

  const seat = state.seats.find((candidate) => candidate.seatId === seatId);
  return { started: started.body, handsPlayed: state.handNumber, finalChips: seat?.stack ?? 0 };
}

const suite = stackUp ? describe : describe.skip;

suite("a career node grants what it promised", () => {
  it("plays the first node through the server's own shoe and pays once", async () => {
    const userId = await createUser();
    const token = signToken(userId);
    const node = CAREER_NODES[0]!;

    const openingChips = await balanceOf(token);
    const openingXp = await xpOf(token, userId);

    const run = await playStandardNode(token, node.slug);
    expect(run.started.format).toBe("standard");
    expect(run.started.startingChips).toBe(node.startingBankroll);
    expect(run.handsPlayed).toBe(node.hands);

    // --- The progress row that nothing used to write ----------------------
    const progress = (await rpc(token, "my_career_progress")).body as {
      node_code: string;
      status: string;
      stars: number;
      attempts: number;
      reward_claimed_at: string | null;
    }[];
    const row = progress.find((candidate) => candidate.node_code === node.slug);
    expect(row).toBeTruthy();
    expect(row?.status).toBe("completed");
    // Completion always awards one, so bad cards can never block progression.
    expect(row?.stars).toBeGreaterThanOrEqual(1);
    expect(row?.reward_claimed_at).toBeTruthy();

    // --- Paid, once -------------------------------------------------------
    expect(await balanceOf(token)).toBe(openingChips + node.reward.chips);
    expect(await xpOf(token, userId)).toBeGreaterThanOrEqual(openingXp + node.reward.xp);

    // The node's stack is a SCORING MEDIUM. It came from nowhere and it goes
    // nowhere: the wallet moved by exactly the reward, never by the stack.
    const ledger = (await readAs(
      token,
      "wallet_ledger?select=reason,delta&order=created_at.desc&limit=10",
    )) as { reason: string; delta: number }[];
    expect(ledger.filter((entry) => entry.reason === "career_reward")).toHaveLength(1);
    expect(ledger.some((entry) => entry.reason === "table_buy_in")).toBe(false);

    // --- And the seat is closed, so the player is not stuck in it ----------
    // `user_id=eq.` matters: the seats policy shows a participant every seat at
    // their own table, so the unfiltered query answers about the whole table.
    const seats = (await readAs(
      token,
      `game_session_seats?user_id=eq.${userId}&status=neq.left` +
        "&select=game_session_id,game_sessions!inner(status)&game_sessions.status=in.(lobby,active)",
    )) as unknown[];
    expect(seats).toHaveLength(0);
  }, 180_000);

  it("pays the reward once however many times the node is replayed", async () => {
    const userId = await createUser();
    const token = signToken(userId);
    const node = CAREER_NODES[0]!;

    await playStandardNode(token, node.slug);
    const afterFirst = await balanceOf(token);

    const replay = await playStandardNode(token, node.slug);
    expect(replay.handsPlayed).toBe(node.hands);

    // Replayable — practising a node you have beaten is useful — and worth
    // nothing. The key is derived from the node and the player, so a second
    // completion lands on the first ledger row.
    expect(await balanceOf(token)).toBe(afterFirst);

    const progress = (await rpc(token, "my_career_progress")).body as
      { node_code: string; attempts: number }[];
    const row = progress.find((candidate) => candidate.node_code === node.slug);
    // Counted, though. An attempt is an attempt whether or not it paid.
    expect(row?.attempts).toBeGreaterThanOrEqual(2);
  }, 300_000);

  it("refuses a node whose predecessor has not been completed", async () => {
    const userId = await createUser();
    const token = signToken(userId);
    const second = CAREER_NODES[1]!;
    expect(second.prerequisiteSlug).toBe(CAREER_NODES[0]!.slug);

    const refused = await call("create-session", token, {
      action: "START_CAREER_NODE",
      clientRequestId: crypto.randomUUID(),
      nodeSlug: second.slug,
      clientSentAt: iso(),
    });
    expect(refused.status).toBe(403);
    expect(refused.body.code).toBe("TABLE_LOCKED");
  }, 60_000);

  it("resumes an attempt already in flight instead of dealing a second shoe", async () => {
    const userId = await createUser();
    const token = signToken(userId);
    const node = CAREER_NODES[0]!;

    const first = await call("create-session", token, {
      action: "START_CAREER_NODE",
      clientRequestId: crypto.randomUUID(),
      nodeSlug: node.slug,
      clientSentAt: iso(),
    });
    expect(first.status).toBe(200);

    const again = await call("create-session", token, {
      action: "START_CAREER_NODE",
      clientRequestId: crypto.randomUUID(),
      nodeSlug: node.slug,
      clientSentAt: iso(),
    });
    expect(again.status).toBe(200);
    // The same table. A second shoe would let a player keep whichever attempt
    // went better, which is the career equivalent of a second ranked daily run.
    expect(again.body.gameId).toBe(first.body.gameId);
    expect(again.body.attemptId).toBe(first.body.attemptId);
  }, 60_000);
});

suite("a drill is graded by the server", () => {
  it("issues scenarios, grades the answers and pays the node", async () => {
    const userId = await createUser();
    const token = signToken(userId);

    // The drills sit behind two standard nodes, so the chain is walked for real
    // rather than by writing progress rows a client could never write.
    const [first, second, drill] = CAREER_NODES;
    expect(drill?.format).toBe("drill");
    await playStandardNode(token, first!.slug);
    await playStandardNode(token, second!.slug);

    const beforeChips = await balanceOf(token);

    const started = await call("create-session", token, {
      action: "START_CAREER_NODE",
      clientRequestId: crypto.randomUUID(),
      nodeSlug: drill!.slug,
      clientSentAt: iso(),
    });
    expect(started.status).toBe(200);
    expect(started.body.format).toBe("drill");
    expect(started.body.gameId).toBeNull();

    const scenarios = started.body.scenarios as {
      index: number;
      playerCards: string[];
      dealerUpCard: string;
      legalActions: string[];
    }[];
    expect(scenarios).toHaveLength(drill!.decisions!);
    // A scenario is the visible situation and nothing else: two player cards, the
    // dealer's UP card, and what is legal. No hole card and no recommendation.
    for (const scenario of scenarios) {
      expect(scenario.playerCards).toHaveLength(2);
      expect(scenario.legalActions.length).toBeGreaterThanOrEqual(2);
      expect(JSON.stringify(scenario)).not.toMatch(/recommend|correct|holeCard/i);
    }

    // Answering the first legal action every time: a real, poor strategy.
    const answers = scenarios.map((scenario) => scenario.legalActions[0]!);
    const graded = await call("create-session", token, {
      action: "SUBMIT_CAREER_DRILL",
      clientRequestId: crypto.randomUUID(),
      attemptId: started.body.attemptId,
      answers,
      clientSentAt: iso(),
    });
    expect(graded.status).toBe(200);
    expect(graded.body.status).toBe("career_drill_graded");
    expect(graded.body.decisions).toBe(scenarios.length);
    // The server's own grade. The client sent actions, never a score.
    expect(graded.body.correct as number).toBeLessThanOrEqual(scenarios.length);
    expect((graded.body.verdicts as unknown[])).toHaveLength(scenarios.length);

    expect(await balanceOf(token)).toBe(beforeChips + drill!.reward.chips);

    // Grading twice must not pay twice, and must not overwrite the record.
    const replay = await call("create-session", token, {
      action: "SUBMIT_CAREER_DRILL",
      clientRequestId: crypto.randomUUID(),
      attemptId: started.body.attemptId,
      answers,
      clientSentAt: iso(),
    });
    expect(replay.status).toBe(409);
    expect(replay.body.code).toBe("SESSION_CLOSED");
    expect(await balanceOf(token)).toBe(beforeChips + drill!.reward.chips);
  }, 300_000);

  it("refuses an answer sheet of the wrong length", async () => {
    const userId = await createUser();
    const token = signToken(userId);
    const [first, second, drill] = CAREER_NODES;
    await playStandardNode(token, first!.slug);
    await playStandardNode(token, second!.slug);

    const started = await call("create-session", token, {
      action: "START_CAREER_NODE",
      clientRequestId: crypto.randomUUID(),
      nodeSlug: drill!.slug,
      clientSentAt: iso(),
    });
    const short = await call("create-session", token, {
      action: "SUBMIT_CAREER_DRILL",
      clientRequestId: crypto.randomUUID(),
      attemptId: started.body.attemptId,
      answers: ["STAND"],
      clientSentAt: iso(),
    });
    expect(short.status).toBe(400);
    expect(short.body.code).toBe("INVALID_REQUEST");
  }, 300_000);
});
