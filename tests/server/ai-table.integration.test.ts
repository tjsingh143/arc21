/**
 * AI Tables, against the REAL Edge Functions and the REAL database (Astra Refresh C).
 *
 * The unit suites prove the policy and the driver over engine states. What only
 * the running stack can prove is that the pieces are CONNECTED: that
 * `create-session` seats a person between two account-less computer seats, that
 * `game-command` makes the computer players act inside the person's own
 * transaction, that a retried command replays rather than replaying the
 * computer players too, that nothing a person wins at an AI table can reach the
 * wallet, that nothing about it reaches a statistic, XP or a leaderboard, and
 * that a killed app can find its AI table again.
 *
 *   supabase start
 *   supabase functions serve --no-verify-jwt
 *
 * SQL is used for two things only, both fixture work in the manner of
 * `game-command.integration.test.ts`: READING authoritative rows no client may
 * read (the engine state, to prove nothing is pending on a computer seat), and
 * standing a person on an empty stack, which fair cards will not produce to
 * order, to reach the free reset. Nothing here decides a card or an outcome.
 */

import crypto from "node:crypto";
import { execFileSync, spawn } from "node:child_process";

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

const OPENING_GRANT = 25_000;
const AI_TABLE_STACK = 5_000;
const AI_TABLE_MIN_BET = 20;

const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
const iso = () => new Date().toISOString();

/** No `iat`: PostgREST rejects one its own clock thinks is in the future. */
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

interface Player {
  readonly id: string;
  readonly token: string;
}

async function createPlayer(): Promise<Player> {
  const response = await fetch(AUTH_ADMIN, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: LOCAL_SERVICE_KEY,
      Authorization: `Bearer ${LOCAL_SERVICE_KEY}`,
    },
    body: JSON.stringify({
      email: `ai-table-${crypto.randomUUID()}@arc21.test`,
      password: crypto.randomUUID(),
      email_confirm: true,
    }),
  });
  const json = (await response.json()) as { id?: string };
  if (!json.id) throw new Error(`could not create a test user: ${response.status}`);
  return { id: json.id, token: signToken(json.id) };
}

/** A REST read made as the player. THROWS when it cannot read — never a sentinel. */
async function readAs<T>(player: Player, path: string): Promise<T> {
  const response = await fetch(`${REST}/${path}`, {
    headers: { apikey: LOCAL_ANON_KEY, Authorization: `Bearer ${player.token}` },
  });
  const body = (await response.json()) as unknown;
  if (!response.ok) throw new Error(`could not read ${path}: ${response.status} ${JSON.stringify(body)}`);
  return body as T;
}

async function rpcAs<T>(player: Player, name: string): Promise<T> {
  const response = await fetch(`${REST}/rpc/${name}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: LOCAL_ANON_KEY,
      Authorization: `Bearer ${player.token}`,
    },
    body: "{}",
  });
  const body = (await response.json()) as unknown;
  if (!response.ok) throw new Error(`could not call ${name}: ${response.status} ${JSON.stringify(body)}`);
  return body as T;
}

async function balanceOf(player: Player): Promise<number> {
  const rows = await readAs<{ balance: number }[]>(player, `wallets?select=balance&user_id=eq.${player.id}`);
  if (rows.length !== 1) throw new Error(`could not read own wallet: ${JSON.stringify(rows)}`);
  return Number(rows[0]!.balance);
}

async function ledgerOf(player: Player): Promise<{ delta: number; reason: string; idempotency_key: string }[]> {
  return await readAs(
    player,
    `wallet_ledger?select=delta,reason,idempotency_key&user_id=eq.${player.id}&order=created_at.asc`,
  );
}

/** Fixture SQL against the local container. THROWS when it cannot run. */
function sql(statement: string): string {
  return execFileSync(
    "docker",
    ["exec", "supabase_db_arc21", "psql", "-U", "postgres", "-d", "postgres", "-X", "-v", "ON_ERROR_STOP=1", "-tAc", statement],
    { encoding: "utf8" },
  ).trim();
}

interface PublicHand {
  cards: unknown[];
  wager: number;
  status: string;
  total: number | null;
  outcome?: { kind: string; net: number };
}
interface PublicSeat {
  seatId: string;
  userId: string | null;
  displayName: string;
  stack: number;
  betLocked: boolean;
  connected: boolean;
  sittingOut: boolean;
  isAi?: true;
  hands: PublicHand[];
}
interface LegalSet {
  actions: string[];
  canPlaceBet: boolean;
  canLockBet: boolean;
  canDeclineInsurance: boolean;
  canStartNextHand: boolean;
  betBounds: { min: number; max: number } | null;
}
interface Snapshot {
  gameId: string;
  version: number;
  phase: string;
  deadlineAt: string | null;
  activeSeatId: string | null;
  seats: PublicSeat[];
  legalActions: Record<string, LegalSet>;
}

interface Table {
  readonly player: Player;
  readonly gameId: string;
  readonly seatId: string;
  state: Snapshot;
}

async function openAiTable(player: Player, clientRequestId: string = crypto.randomUUID()) {
  return await call("create-session", player.token, {
    action: "OPEN_AI_TABLE",
    clientRequestId,
    clientSentAt: iso(),
  });
}

async function sitDown(player: Player): Promise<Table> {
  const opened = await openAiTable(player);
  if (opened.status !== 200) throw new Error(`OPEN_AI_TABLE failed: ${opened.status} ${opened.raw}`);
  return {
    player,
    gameId: opened.body.gameId as string,
    seatId: opened.body.seatId as string,
    state: opened.body.publicState as Snapshot,
  };
}

/** One command at the table's current version; adopts whatever comes back. */
async function send(table: Table, type: string, payload?: Record<string, unknown>, clientActionId = crypto.randomUUID()) {
  const body = {
    gameId: table.gameId,
    clientActionId,
    type,
    ...(payload ? { payload } : {}),
    expectedVersion: table.state.version,
    clientSentAt: iso(),
  };
  const response = await call("game-command", table.player.token, body);
  if (response.body.publicState) table.state = response.body.publicState as Snapshot;
  return { response, body };
}

const mySeat = (table: Table): PublicSeat => table.state.seats.find((seat) => seat.seatId === table.seatId)!;
const aiSeats = (state: Snapshot): PublicSeat[] => state.seats.filter((seat) => seat.isAi === true);

/**
 * What every snapshot handed back to the person must look like: the table is
 * waiting on THEM, resting, or over — never on a computer player, which nothing
 * but the person's next command could ever move.
 */
function expectWaitingOnThePerson(table: Table): void {
  const { state } = table;
  switch (state.phase) {
    case "BETTING_OPEN":
      // Computer players stake only once the person has locked.
      expect(mySeat(table).betLocked).toBe(false);
      for (const seat of aiSeats(state)) expect(seat.betLocked).toBe(false);
      break;
    case "INSURANCE_OFFER":
      expect(state.legalActions[table.seatId]?.canDeclineInsurance).toBe(true);
      for (const seat of aiSeats(state)) {
        expect(state.legalActions[seat.seatId]?.canDeclineInsurance).toBe(false);
      }
      break;
    case "PLAYER_TURNS":
      expect(state.activeSeatId).toBe(table.seatId);
      break;
    case "HAND_COMPLETE":
    case "SESSION_COMPLETE":
      break;
    default:
      throw new Error(`the table was handed back in ${state.phase}`);
  }
}

/** The person's own play: deterministic, and enough to finish any hand. */
async function personMoves(table: Table, bet = 100): Promise<void> {
  const legal = table.state.legalActions[table.seatId];
  switch (table.state.phase) {
    case "BETTING_OPEN": {
      const placed = await send(table, "PLACE_BET", { amount: bet });
      expect(placed.response.status).toBe(200);
      expectWaitingOnThePerson(table);
      const locked = await send(table, "LOCK_BET");
      expect(locked.response.status).toBe(200);
      return;
    }
    case "INSURANCE_OFFER":
      expect((await send(table, "DECLINE_INSURANCE")).response.status).toBe(200);
      return;
    case "PLAYER_TURNS": {
      const hand = mySeat(table).hands.find((candidate) => candidate.status === "ACTIVE");
      const action = (hand?.total ?? 21) < 12 && legal?.actions.includes("HIT") ? "HIT" : "STAND";
      expect((await send(table, action)).response.status).toBe(200);
      return;
    }
    case "HAND_COMPLETE":
      expect((await send(table, "NEXT_HAND")).response.status).toBe(200);
      return;
    default:
      throw new Error(`nothing for the person to do in ${table.state.phase}`);
  }
}

/** The authoritative engine row — readable by no client, read here to prove a negative. */
function engineRow(gameId: string): { version: number; phase: string; seats: { seatId: string; isAi?: boolean; betLocked: boolean; insuranceDecision: string }[]; activeSeatIndex: number | null } {
  return JSON.parse(
    sql(`select engine_state::text from private.game_state_private where game_session_id = '${gameId}'::uuid`),
  ) as never;
}

const suite = stackUp ? describe : describe.skip;

suite("AI tables", () => {
  it("seats the person between two computer players, and takes nothing from the wallet", async () => {
    const player = await createPlayer();
    const before = await balanceOf(player);
    expect(before).toBe(OPENING_GRANT);

    const opened = await openAiTable(player);
    expect(opened.status).toBe(200);
    expect(opened.body.status).toBe("ai_table_opened");
    expect(opened.body.resumed).toBe(false);
    expect(opened.body.tableStack).toBe(AI_TABLE_STACK);
    // A closed economy's answer: nothing about a wallet in it at all.
    expect(opened.body).not.toHaveProperty("walletBalance");
    expect(opened.body).not.toHaveProperty("buyIn");

    const state = opened.body.publicState as Snapshot;
    expect(state.phase).toBe("BETTING_OPEN");
    expect(state.seats.map((seat) => seat.isAi === true)).toEqual([true, false, true]);
    expect(state.seats[1]!.seatId).toBe(opened.body.seatId);
    expect(state.seats[1]!.userId).toBe(player.id);
    expect(state.seats.map((seat) => seat.stack)).toEqual([AI_TABLE_STACK, AI_TABLE_STACK, AI_TABLE_STACK]);
    for (const seat of aiSeats(state)) {
      // A computer player is never an account.
      expect(seat.userId).toBeNull();
      expect(seat.displayName).toMatch(/^AI Player \d$/);
    }

    expect(await balanceOf(player)).toBe(before);
    expect((await ledgerOf(player)).map((row) => row.reason)).toEqual(["initial_grant"]);

    // The rows a client CAN read say the same thing.
    const gameId = opened.body.gameId as string;
    const sessions = await readAs<{ mode: string; escrow_chips: number; max_seats: number; tier: string | null }[]>(
      player,
      `game_sessions?select=mode,escrow_chips,max_seats,tier&id=eq.${gameId}`,
    );
    expect(sessions).toEqual([{ mode: "ai_table", escrow_chips: 0, max_seats: 3, tier: null }]);
    const seats = await readAs<{ seat_index: number; is_ai: boolean; user_id: string | null; buy_in: number }[]>(
      player,
      `game_session_seats?select=seat_index,is_ai,user_id,buy_in&game_session_id=eq.${gameId}&order=seat_index`,
    );
    expect(seats).toEqual([
      { seat_index: 0, is_ai: true, user_id: null, buy_in: 0 },
      { seat_index: 1, is_ai: false, user_id: player.id, buy_in: 0 },
      { seat_index: 2, is_ai: true, user_id: null, buy_in: 0 },
    ]);

    // And a killed app finds it again.
    const active = await rpcAs<{ game_session_id: string; seat_id: string; mode: string }[]>(player, "my_active_session");
    expect(active).toEqual([
      expect.objectContaining({ game_session_id: gameId, seat_id: opened.body.seatId, mode: "ai_table" }),
    ]);
  }, 120_000);

  it("lets nobody else see it", async () => {
    const table = await sitDown(await createPlayer());
    const stranger = await createPlayer();
    expect(await readAs<unknown[]>(stranger, `game_sessions?id=eq.${table.gameId}`)).toEqual([]);
    expect(await readAs<unknown[]>(stranger, `game_session_seats?game_session_id=eq.${table.gameId}`)).toEqual([]);
    expect(await readAs<unknown[]>(stranger, `game_events?game_session_id=eq.${table.gameId}`)).toEqual([]);
    const refused = await call("game-command", stranger.token, {
      gameId: table.gameId,
      clientActionId: crypto.randomUUID(),
      type: "NEXT_HAND",
      expectedVersion: table.state.version,
      clientSentAt: iso(),
    });
    expect(refused.status).toBe(403);
    expect(refused.body.code).toBe("NOT_A_PARTICIPANT");
  }, 120_000);

  it("makes the computer players act on the server, inside the person's own command", async () => {
    const table = await sitDown(await createPlayer());
    expectWaitingOnThePerson(table);

    await send(table, "PLACE_BET", { amount: 100 });
    // Still choosing: no computer player has staked.
    for (const seat of aiSeats(table.state)) expect(seat.betLocked).toBe(false);

    const versionBefore = table.state.version;
    const { response } = await send(table, "LOCK_BET");
    expect(response.status).toBe(200);
    expectWaitingOnThePerson(table);

    // Both computer players staked the minimum in the same command — and the
    // version moved once per decision, the person's lock included.
    const events = response.body.events as { seq: number; event: { type: string; seatId?: string; amount?: number } }[];
    const aiLocks = events.filter(
      (entry) => entry.event.type === "BET_LOCKED" && entry.event.seatId !== table.seatId,
    );
    expect(aiLocks.map((entry) => entry.event.amount)).toEqual([AI_TABLE_MIN_BET, AI_TABLE_MIN_BET]);
    expect(table.state.version).toBeGreaterThanOrEqual(versionBefore + 5);
    // Both were dealt in. (Not their wagers: a computer player that doubles or
    // splits has, correctly, more than the minimum on the felt by now.)
    for (const seat of aiSeats(table.state)) expect(seat.hands.length).toBeGreaterThan(0);

    // One batch, in order, with no gap.
    const seqs = events.map((entry) => entry.seq);
    expect(seqs).toEqual(seqs.map((_, index) => seqs[0]! + index));

    // And the authoritative row agrees: nothing is waiting on a computer seat.
    const engine = engineRow(table.gameId);
    expect(engine.version).toBe(table.state.version);
    for (const seat of engine.seats) {
      if (seat.isAi === true) {
        expect(seat.betLocked).toBe(true);
        expect(seat.insuranceDecision).not.toBe("PENDING");
      }
    }
    if (engine.activeSeatIndex !== null) {
      expect(engine.seats[engine.activeSeatIndex]!.isAi ?? false).toBe(false);
    }
  }, 120_000);

  it("plays hand after hand, always handing the table back to the person", async () => {
    const player = await createPlayer();
    const table = await sitDown(player);
    let hands = 0;
    let aiDecisionsSeen = 0;

    for (let step = 0; step < 120 && hands < 8; step += 1) {
      if (table.state.phase === "HAND_COMPLETE") hands += 1;
      const before = table.state.version;
      await personMoves(table);
      expectWaitingOnThePerson(table);
      expect(table.state.version).toBeGreaterThan(before);
      // No clock, ever: nothing at this table waits on anybody but the person.
      expect(table.state.deadlineAt).toBeNull();
      aiDecisionsSeen += table.state.version - before - 1;
    }

    expect(hands).toBeGreaterThanOrEqual(8);
    expect(aiDecisionsSeen).toBeGreaterThan(8 * 4);

    // The event log a participant reads is one unbroken sequence.
    const log = await readAs<{ seq: number }[]>(player, `game_events?select=seq&game_session_id=eq.${table.gameId}&order=seq`);
    expect(log.map((row) => row.seq)).toEqual(log.map((_, index) => index + 1));
  }, 240_000);

  it("records nothing: no statistics, no XP, no decisions — for the person or anybody", async () => {
    const player = await createPlayer();
    const table = await sitDown(player);
    for (let step = 0; step < 80; step += 1) {
      await personMoves(table);
      if (table.state.phase === "HAND_COMPLETE" && step > 30) break;
    }

    const stats = await readAs<{ hands_played: number; chips_wagered: number }[]>(
      player,
      `player_stats?select=hands_played,chips_wagered&user_id=eq.${player.id}`,
    );
    expect(stats).toEqual([{ hands_played: 0, chips_wagered: 0 }]);
    expect(await readAs<unknown[]>(player, `player_daily_xp?user_id=eq.${player.id}`)).toEqual([]);
    expect(await readAs<unknown[]>(player, `player_decision_periods?user_id=eq.${player.id}`)).toEqual([]);
    const profile = await readAs<{ xp: number }[]>(player, `profiles?select=xp&id=eq.${player.id}`);
    expect(profile).toEqual([{ xp: 0 }]);
  }, 240_000);

  it("carries no clock, so a timeout can never move it", async () => {
    const table = await sitDown(await createPlayer());
    expect(table.state.deadlineAt).toBeNull();
    await send(table, "PLACE_BET", { amount: 100 });
    await send(table, "LOCK_BET");
    expect(table.state.deadlineAt).toBeNull();

    // At the CURRENT version, so it is a real request rather than a snapshot read.
    const version = table.state.version;
    const timeout = await call("game-command", table.player.token, {
      gameId: table.gameId,
      clientActionId: crypto.randomUUID(),
      type: "RESOLVE_TIMEOUT",
      expectedVersion: version,
      clientSentAt: iso(),
    });
    expect(timeout.status).toBe(422);
    expect(timeout.body.code).toBe("DEADLINE_NOT_REACHED");
    expect(engineRow(table.gameId).version).toBe(version);
  }, 120_000);

  it("replays a retried command without the computer players acting twice", async () => {
    const table = await sitDown(await createPlayer());
    await send(table, "PLACE_BET", { amount: 100 });

    const actionId = crypto.randomUUID();
    const first = await send(table, "LOCK_BET", undefined, actionId);
    expect(first.response.status).toBe(200);
    const eventsAfterFirst = sql(`select count(*) from public.game_events where game_session_id = '${table.gameId}'::uuid`);
    const versionAfterFirst = engineRow(table.gameId).version;

    // The SAME request, byte for byte — a lost reply, retried.
    const replay = await call("game-command", table.player.token, first.body);
    expect(replay.status).toBe(200);
    // The first committed result, not a second application.
    expect(replay.body).toEqual(first.response.body);
    expect(engineRow(table.gameId).version).toBe(versionAfterFirst);
    expect(sql(`select count(*) from public.game_events where game_session_id = '${table.gameId}'::uuid`)).toBe(
      eventsAfterFirst,
    );
  }, 120_000);

  it("applies nothing on a stale version — the computer players included", async () => {
    const table = await sitDown(await createPlayer());
    await send(table, "PLACE_BET", { amount: 100 });
    const current = table.state.version;
    const stale = await call("game-command", table.player.token, {
      gameId: table.gameId,
      clientActionId: crypto.randomUUID(),
      type: "LOCK_BET",
      expectedVersion: current - 1,
      clientSentAt: iso(),
    });
    expect(stale.status).toBe(200);
    expect(stale.body.status).toBe("stale");
    expect((stale.body.publicState as Snapshot).version).toBe(current);
    expect(engineRow(table.gameId).version).toBe(current);
    for (const seat of aiSeats(stale.body.publicState as Snapshot)) expect(seat.betLocked).toBe(false);
  }, 120_000);

  it("cannot put a chip the person won into the wallet: leaving returns nothing", async () => {
    const player = await createPlayer();
    const table = await sitDown(player);
    const balanceBefore = await balanceOf(player);
    const ledgerBefore = await ledgerOf(player);

    // Real hands first, at the table maximum, so the table has genuinely been
    // played: three settled rounds against the dealer, computer players and all.
    let settled = 0;
    for (let step = 0; step < 60 && settled < 3; step += 1) {
      if (table.state.phase === "HAND_COMPLETE") settled += 1;
      const bounds = table.state.legalActions[table.seatId]?.betBounds;
      await personMoves(table, Math.min(500, bounds?.max ?? 500));
    }
    expect(settled).toBe(3);
    if (table.state.phase === "HAND_COMPLETE") await send(table, "NEXT_HAND");
    expect(table.state.phase).toBe("BETTING_OPEN");

    /*
     * THE REGRESSION. FIXTURE: the person far AHEAD at the table — 50,000 table
     * chips against the 5,000 everybody started on, as if they had beaten the
     * dealer for an evening. Every one of those chips was created by the table,
     * which is the whole point: if an AI table's stack could ever reach a
     * wallet, this cash-out would credit 50,000. `ai_table` added to
     * `WALLET_BACKED_MODES` makes exactly this assertion fail.
     */
    sql(
      `update private.game_state_private
       set engine_state = jsonb_set(engine_state, '{seats,1,stack}', '50000'::jsonb)
       where game_session_id = '${table.gameId}'::uuid`,
    );

    const cashed = await call("create-session", player.token, {
      action: "CASH_OUT",
      clientRequestId: crypto.randomUUID(),
      gameId: table.gameId,
      clientSentAt: iso(),
    });
    expect(cashed.status).toBe(200);
    expect(cashed.body.status).toBe("cashed_out");
    expect(cashed.body.returned).toBe(0);
    expect(cashed.body.walletBalance).toBe(balanceBefore);

    expect(await balanceOf(player)).toBe(balanceBefore);
    // Not one ledger row, before or after: nothing entered and nothing left.
    expect(await ledgerOf(player)).toEqual(ledgerBefore);
    expect(
      sql(`select count(*) from public.wallet_ledger where reference_id = '${table.gameId}'::uuid`),
    ).toBe("0");

    // The table ends with its person: no computer player keeps it running.
    const sessions = await readAs<{ status: string; escrow_chips: number }[]>(
      player,
      `game_sessions?select=status,escrow_chips&id=eq.${table.gameId}`,
    );
    expect(sessions).toEqual([{ status: "completed", escrow_chips: 0 }]);
    expect(await rpcAs<unknown[]>(player, "my_active_session")).toEqual([]);

    // A second cash-out is the first one's answer: still nothing.
    const again = await call("create-session", player.token, {
      action: "CASH_OUT",
      clientRequestId: crypto.randomUUID(),
      gameId: table.gameId,
      clientSentAt: iso(),
    });
    expect(again.body.returned).toBe(0);
    expect(await balanceOf(player)).toBe(balanceBefore);
  }, 300_000);

  it("ends when its person leaves through game-command too, and refuses a leave mid-hand", async () => {
    const player = await createPlayer();
    const table = await sitDown(player);
    await send(table, "PLACE_BET", { amount: 100 });
    await send(table, "LOCK_BET");

    if (table.state.phase === "PLAYER_TURNS" || table.state.phase === "INSURANCE_OFFER") {
      const busy = await call("create-session", player.token, {
        action: "CASH_OUT",
        clientRequestId: crypto.randomUUID(),
        gameId: table.gameId,
        clientSentAt: iso(),
      });
      expect(busy.status).toBe(409);
      expect(busy.body.code).toBe("SESSION_BUSY");
    }

    for (let step = 0; step < 20 && table.state.phase !== "HAND_COMPLETE"; step += 1) {
      await personMoves(table);
    }
    expect(table.state.phase).toBe("HAND_COMPLETE");

    const left = await send(table, "LEAVE");
    expect(left.response.status).toBe(200);
    expect(table.state.phase).toBe("SESSION_COMPLETE");
    const sessions = await readAs<{ status: string }[]>(player, `game_sessions?select=status&id=eq.${table.gameId}`);
    expect(sessions).toEqual([{ status: "completed" }]);

    const after = await send(table, "NEXT_HAND");
    expect(after.response.body.code).toBe("SESSION_CLOSED");
  }, 240_000);

  it("returns the person to the AI table they hold, and refuses a second seat anywhere", async () => {
    const player = await createPlayer();
    const table = await sitDown(player);
    await send(table, "PLACE_BET", { amount: 60 });

    const again = await openAiTable(player);
    expect(again.status).toBe(200);
    expect(again.body.resumed).toBe(true);
    expect(again.body.gameId).toBe(table.gameId);
    expect(again.body.seatId).toBe(table.seatId);
    expect((again.body.publicState as Snapshot).version).toBe(table.state.version);

    // One live seat per player: Quick Play is refused while the AI table is held.
    const quick = await call("create-session", player.token, {
      action: "OPEN",
      clientRequestId: crypto.randomUUID(),
      tier: "casual",
      clientSentAt: iso(),
    });
    expect(quick.status).toBe(409);
    expect(quick.body.code).toBe("SESSION_ALREADY_ACTIVE");
    expect(await balanceOf(player)).toBe(OPENING_GRANT);
  }, 120_000);

  it("refuses an AI table to a player seated at another table", async () => {
    const player = await createPlayer();
    const quick = await call("create-session", player.token, {
      action: "OPEN",
      clientRequestId: crypto.randomUUID(),
      tier: "casual",
      clientSentAt: iso(),
    });
    expect(quick.status).toBe(200);

    const refused = await openAiTable(player);
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe("SESSION_ALREADY_ACTIVE");
    const live = await readAs<{ game_session_id: string }[]>(
      player,
      `game_session_seats?select=game_session_id&user_id=eq.${player.id}&status=neq.left`,
    );
    expect(live).toEqual([{ game_session_id: quick.body.gameId }]);
  }, 120_000);

  it("seats a player once however many opens race each other", async () => {
    const player = await createPlayer();
    const answers = await Promise.all(
      Array.from({ length: 6 }, () => openAiTable(player)),
    );
    for (const answer of answers) expect(answer.status).toBe(200);
    const games = new Set(answers.map((answer) => answer.body.gameId as string));
    expect(games.size).toBe(1);
    expect(answers.filter((answer) => answer.body.resumed === false)).toHaveLength(1);

    const live = await readAs<{ game_session_id: string }[]>(
      player,
      `game_session_seats?select=game_session_id&user_id=eq.${player.id}&status=neq.left`,
    );
    expect(live).toHaveLength(1);
    expect(sql(`select count(*) from public.game_sessions where host_user_id = '${player.id}'::uuid and mode = 'ai_table'`)).toBe("1");
  }, 120_000);

  it("opens a NEW table after the person has left the last one", async () => {
    const player = await createPlayer();
    const first = await sitDown(player);
    const cashed = await call("create-session", player.token, {
      action: "CASH_OUT",
      clientRequestId: crypto.randomUUID(),
      gameId: first.gameId,
      clientSentAt: iso(),
    });
    expect(cashed.status).toBe(200);

    const second = await openAiTable(player);
    expect(second.status).toBe(200);
    expect(second.body.resumed).toBe(false);
    expect(second.body.gameId).not.toBe(first.gameId);
  }, 120_000);

  it("lets a person who has run out of chips start again from the table's stack, and only then", async () => {
    const player = await createPlayer();
    const table = await sitDown(player);

    // Not broke: refused.
    const tooEarly = await call("create-session", player.token, {
      action: "RESET_PRIVATE_STACK",
      clientRequestId: crypto.randomUUID(),
      gameId: table.gameId,
      clientSentAt: iso(),
    });
    expect(tooEarly.status).toBe(422);
    expect(tooEarly.body.code).toBe("ILLEGAL_ACTION");

    // FIXTURE: the person's stack as it would stand after losing all but ten
    // chips — a standing fair cards will not produce to order.
    sql(
      `update private.game_state_private
       set engine_state = jsonb_set(engine_state, '{seats,1,stack}', '10'::jsonb)
       where game_session_id = '${table.gameId}'::uuid`,
    );
    // A read: a command pinned to version 0 can never apply, so the server
    // answers with the authoritative snapshot.
    const snapshot = await call("game-command", player.token, {
      gameId: table.gameId,
      clientActionId: crypto.randomUUID(),
      type: "RESOLVE_TIMEOUT",
      expectedVersion: 0,
      clientSentAt: iso(),
    });
    table.state = snapshot.body.publicState as Snapshot;
    // Not sat out — an AI table has no clock to do that — and offered no bet.
    expect(mySeat(table).sittingOut).toBe(false);
    expect(table.state.legalActions[table.seatId]?.canPlaceBet).toBe(false);

    const reset = await call("create-session", player.token, {
      action: "RESET_PRIVATE_STACK",
      clientRequestId: crypto.randomUUID(),
      gameId: table.gameId,
      clientSentAt: iso(),
    });
    expect(reset.status).toBe(200);
    expect(reset.body.stack).toBe(AI_TABLE_STACK);
    table.state = reset.body.publicState as Snapshot;
    expect(mySeat(table).stack).toBe(AI_TABLE_STACK);
    expect(table.state.legalActions[table.seatId]?.canPlaceBet).toBe(true);
    // The computer players were not touched, and still wait for the person.
    for (const seat of aiSeats(table.state)) expect(seat.betLocked).toBe(false);
    // And no wallet saw any of it.
    expect(await balanceOf(player)).toBe(OPENING_GRANT);
    expect((await ledgerOf(player)).map((row) => row.reason)).toEqual(["initial_grant"]);

    // The table plays on.
    await personMoves(table);
    expectWaitingOnThePerson(table);
  }, 120_000);
});

// ---------------------------------------------------------------------------
// Refresh C repairs: C-1 (cross-mode admission), C-2 (replay after closure),
// C-4 (a mid-hand leave at a table with no clock)
// ---------------------------------------------------------------------------

/**
 * A DETERMINISTIC interleaving for two admissions by ONE player.
 *
 * A separate connection holds the player's `profiles` row `for update`. Every
 * admission path reads the profile without a lock and then inserts a
 * `game_sessions` row whose `host_user_id` foreign key needs `for key share` on
 * that row — so each request is parked at its first insert, AFTER whatever it
 * checked, until the barrier is released. Nobody else's rows are touched, so
 * the rest of the suite runs on unblocked.
 *
 * `parked()` counts the requests waiting on the barrier directly OR on a
 * backend that is itself waiting on it. Before the C-1 repair both admissions
 * wait on the barrier (both have already passed the one-live-seat check);
 * after it the second waits on the first's admission lock, which is the
 * repair working.
 */
async function holdPlayerAdmissions(player: Player): Promise<{ parked(): number; release(): Promise<void> }> {
  const psql = spawn("docker", [
    "exec", "-i", "supabase_db_arc21", "psql", "-U", "postgres", "-d", "postgres", "-X", "-q", "-tA", "-v", "ON_ERROR_STOP=1",
  ]);
  let out = "";
  psql.stdout.on("data", (chunk: Buffer) => { out += chunk.toString("utf8"); });
  psql.stdin.write(
    `begin;\nselect 'pid=' || pg_backend_pid();\n` +
    `select 'held=' || count(*) from (select 1 from public.profiles where id = '${player.id}'::uuid for update) held;\n`,
  );
  for (let tries = 0; tries < 100 && !/held=1/.test(out); tries += 1) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  const holder = /pid=(\d+)/.exec(out)?.[1];
  if (!holder || !/held=1/.test(out)) throw new Error(`could not hold the barrier: ${out}`);
  let released: Promise<void> | null = null;
  return {
    parked: () =>
      Number(
        sql(
          `with first as (select pid from pg_stat_activity where ${holder} = any(pg_blocking_pids(pid)))
           select (select count(*) from first)
                + (select count(*) from pg_stat_activity a
                   where exists (select 1 from first f where f.pid = any(pg_blocking_pids(a.pid))))`,
        ),
      ),
    release: () =>
      (released ??= new Promise<void>((resolve) => {
        psql.on("close", () => resolve());
        psql.stdin.end("commit;\n");
      })),
  };
}

async function waitUntil(predicate: () => boolean, what: string, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

const liveSeatsOf = (player: Player): string =>
  sql(
    `select count(*) from public.game_session_seats s join public.game_sessions g on g.id = s.game_session_id
     where s.user_id = '${player.id}'::uuid and s.status <> 'left' and g.status in ('lobby', 'active')`,
  );

const quickPlay = (player: Player, clientRequestId: string = crypto.randomUUID()) =>
  call("create-session", player.token, {
    action: "OPEN",
    clientRequestId,
    tier: "casual",
    clientSentAt: iso(),
  });

const cashOutOf = (player: Player, gameId: string) =>
  call("create-session", player.token, {
    action: "CASH_OUT",
    clientRequestId: crypto.randomUUID(),
    gameId,
    clientSentAt: iso(),
  });

/** The wallet and ledger as they must stand when ONLY the named admission happened. */
async function expectWalletAfter(player: Player, admitted: "ai" | "quick" | "none"): Promise<void> {
  const reasons = (await ledgerOf(player)).map((row) => row.reason);
  if (admitted === "quick") {
    expect(reasons).toEqual(["initial_grant", "table_buy_in"]);
    const debit = (await ledgerOf(player))[1]!;
    expect(await balanceOf(player)).toBe(OPENING_GRANT + Number(debit.delta));
  } else {
    expect(reasons).toEqual(["initial_grant"]);
    expect(await balanceOf(player)).toBe(OPENING_GRANT);
  }
}

suite("C-1: one live seat ACROSS modes, however two admissions interleave", () => {
  type Admission = { label: "ai" | "quick" | "daily"; send: (player: Player) => ReturnType<typeof call> };
  const ai: Admission = { label: "ai", send: (player) => openAiTable(player) };
  const quick: Admission = { label: "quick", send: (player) => quickPlay(player) };
  const daily: Admission = {
    label: "daily",
    send: (player) =>
      call("create-session", player.token, {
        action: "START_DAILY_CHALLENGE",
        clientRequestId: crypto.randomUUID(),
        clientSentAt: iso(),
      }),
  };

  /**
   * The audit's reproduction made deterministic: `first` is parked past its
   * check, `second` is sent while it is parked, and only then does either
   * commit. Exactly one may be seated; it must be the one that arrived first.
   */
  async function interleave(first: Admission, second: Admission) {
    const player = await createPlayer();
    const barrier = await holdPlayerAdmissions(player);
    let firstAnswer: Awaited<ReturnType<typeof call>>;
    let secondAnswer: Awaited<ReturnType<typeof call>>;
    try {
      const firstSent = first.send(player);
      await waitUntil(() => barrier.parked() >= 1, `${first.label} to reach the barrier`);
      const secondSent = second.send(player);
      await waitUntil(() => barrier.parked() >= 2, `${second.label} to queue behind it`);
      await barrier.release();
      [firstAnswer, secondAnswer] = await Promise.all([firstSent, secondSent]);
    } finally {
      await barrier.release();
    }
    return { player, firstAnswer, secondAnswer };
  }

  for (const [first, second] of [[ai, quick], [quick, ai], [ai, daily], [daily, ai]] as const) {
    it(`${first.label} then ${second.label}: the first is seated, the second refused, nothing charged twice`, async () => {
      const { player, firstAnswer, secondAnswer } = await interleave(first, second);

      expect(firstAnswer.status).toBe(200);
      expect(secondAnswer.status).toBe(409);
      expect(secondAnswer.body.code).toBe("SESSION_ALREADY_ACTIVE");
      expect(liveSeatsOf(player)).toBe("1");
      // No orphan: the refused admission left no session behind.
      expect(sql(`select count(*) from public.game_sessions where host_user_id = '${player.id}'::uuid`)).toBe("1");
      await expectWalletAfter(player, first.label === "quick" ? "quick" : "none");

      // And the seat that was granted is the one the lookup names.
      const active = await rpcAs<{ game_session_id: string }[]>(player, "my_active_session");
      expect(active.map((row) => row.game_session_id)).toEqual([firstAnswer.body.gameId]);
    }, 120_000);
  }

  it("after the winner closes, the other mode admits normally", async () => {
    const { player, firstAnswer } = await interleave(ai, quick);
    expect((await cashOutOf(player, firstAnswer.body.gameId as string)).status).toBe(200);
    expect(liveSeatsOf(player)).toBe("0");

    const later = await quickPlay(player);
    expect(later.status).toBe(200);
    expect(liveSeatsOf(player)).toBe("1");
    await expectWalletAfter(player, "quick");
  }, 120_000);

  it("free-running races, both orders, five players each: never two live seats", async () => {
    for (let trial = 0; trial < 5; trial += 1) {
      const player = await createPlayer();
      const answers = await Promise.all(trial % 2 === 0 ? [openAiTable(player), quickPlay(player)] : [quickPlay(player), openAiTable(player)]);
      const accepted = answers.filter((answer) => answer.status === 200);
      expect(accepted).toHaveLength(1);
      expect(answers.find((answer) => answer.status !== 200)?.body.code).toBe("SESSION_ALREADY_ACTIVE");
      expect(liveSeatsOf(player)).toBe("1");
      await expectWalletAfter(player, accepted[0]!.body.status === "opened" ? "quick" : "none");
    }
  }, 240_000);
});

suite("C-2: one AI-open request is one table, before and after it closes", () => {
  /** The original request, kept byte for byte so a replay is the SAME request. */
  function originalOpen(): Record<string, unknown> {
    return { action: "OPEN_AI_TABLE", clientRequestId: crypto.randomUUID(), clientSentAt: iso() };
  }
  const aiSessionsOf = (player: Player): string =>
    sql(`select count(*) from public.game_sessions where host_user_id = '${player.id}'::uuid and mode = 'ai_table'`);

  it("THE AUDIT'S REPRODUCTION: replaying the original open after cash-out opens nothing", async () => {
    const player = await createPlayer();
    const request = originalOpen();
    const first = await call("create-session", player.token, request);
    expect(first.status).toBe(200);
    expect(first.body.resumed).toBe(false);

    // Exactly the audit's sequence: no replay while live, which would record
    // the request by the resume path and hide a missing record at creation.
    const cashed = await cashOutOf(player, first.body.gameId as string);
    expect(cashed.status).toBe(200);

    // A delayed duplicate of the ORIGINAL request, after the table closed.
    const replay = await call("create-session", player.token, request);
    expect(replay.status).toBe(200);
    expect(replay.body.status).toBe("ai_table_opened");
    expect(replay.body.gameId).toBe(first.body.gameId);
    expect(replay.body.seatId).toBe(first.body.seatId);
    expect(replay.body.resumed).toBe(true);
    expect((replay.body.publicState as Snapshot).phase).toBe("SESSION_COMPLETE");

    expect(aiSessionsOf(player)).toBe("1");
    expect(liveSeatsOf(player)).toBe("0");
    await expectWalletAfter(player, "none");

    // The replay did not reseat the player, so another mode is open to them.
    expect((await quickPlay(player)).status).toBe(200);
  }, 120_000);

  it("a replay while the table is live is the same table, and so is one after it closes", async () => {
    const player = await createPlayer();
    const request = originalOpen();
    const first = await call("create-session", player.token, request);
    const whileLive = await call("create-session", player.token, request);
    expect(whileLive.status).toBe(200);
    expect(whileLive.body.gameId).toBe(first.body.gameId);
    expect(whileLive.body.seatId).toBe(first.body.seatId);
    expect((await cashOutOf(player, first.body.gameId as string)).status).toBe(200);
    const afterClose = await call("create-session", player.token, request);
    expect(afterClose.body.gameId).toBe(first.body.gameId);
    expect(aiSessionsOf(player)).toBe("1");
  }, 120_000);

  it("a RESUMING request is recorded too: its delayed duplicate opens nothing after closure", async () => {
    const player = await createPlayer();
    const first = await call("create-session", player.token, originalOpen());
    // A second Sit down from a relaunched app: a NEW request, answered with the held table.
    const resume = originalOpen();
    const resumed = await call("create-session", player.token, resume);
    expect(resumed.body.resumed).toBe(true);
    expect(resumed.body.gameId).toBe(first.body.gameId);
    expect((await cashOutOf(player, first.body.gameId as string)).status).toBe(200);
    const late = await call("create-session", player.token, resume);
    expect(late.status).toBe(200);
    expect(late.body.gameId).toBe(first.body.gameId);
    expect(aiSessionsOf(player)).toBe("1");
    expect(liveSeatsOf(player)).toBe("0");
  }, 120_000);

  it("concurrent copies of one request open one table", async () => {
    const player = await createPlayer();
    const request = originalOpen();
    const answers = await Promise.all(Array.from({ length: 6 }, () => call("create-session", player.token, request)));
    for (const answer of answers) expect(answer.status).toBe(200);
    expect(new Set(answers.map((answer) => answer.body.gameId)).size).toBe(1);
    expect(aiSessionsOf(player)).toBe("1");
  }, 120_000);

  it("a NEW request after closure opens a new table", async () => {
    const player = await createPlayer();
    const first = await call("create-session", player.token, originalOpen());
    expect((await cashOutOf(player, first.body.gameId as string)).status).toBe(200);
    const second = await call("create-session", player.token, originalOpen());
    expect(second.status).toBe(200);
    expect(second.body.resumed).toBe(false);
    expect(second.body.gameId).not.toBe(first.body.gameId);
    expect(aiSessionsOf(player)).toBe("2");
  }, 120_000);

  it("is scoped to the player: another account's identical request id is its own request", async () => {
    const [alice, bob] = await Promise.all([createPlayer(), createPlayer()]);
    const request = originalOpen();
    const forAlice = await call("create-session", alice.token, request);
    const forBob = await call("create-session", bob.token, request);
    expect(forAlice.status).toBe(200);
    expect(forBob.status).toBe(200);
    expect(forBob.body.gameId).not.toBe(forAlice.body.gameId);
    expect(forBob.body.resumed).toBe(false);
    const bobsSeat = await readAs<{ user_id: string }[]>(bob, `game_session_seats?select=user_id&game_session_id=eq.${forBob.body.gameId}&is_ai=eq.false`);
    expect(bobsSeat).toEqual([{ user_id: bob.id }]);
  }, 120_000);

  it("refuses a request id already spent on the OTHER open, in both directions, charging nothing", async () => {
    const player = await createPlayer();
    const spentOnQuick = crypto.randomUUID();
    const quickTable = await quickPlay(player, spentOnQuick);
    expect(quickTable.status).toBe(200);
    expect((await cashOutOf(player, quickTable.body.gameId as string)).status).toBe(200);
    const balanceAfterQuick = await balanceOf(player);

    const reusedForAi = await openAiTable(player, spentOnQuick);
    expect(reusedForAi.status).toBe(409);
    expect(reusedForAi.body.code).toBe("IDEMPOTENCY_CONFLICT");
    expect(aiSessionsOf(player)).toBe("0");

    const spentOnAi = crypto.randomUUID();
    const aiTable = await openAiTable(player, spentOnAi);
    expect(aiTable.status).toBe(200);
    expect((await cashOutOf(player, aiTable.body.gameId as string)).status).toBe(200);

    const reusedForQuick = await quickPlay(player, spentOnAi);
    expect(reusedForQuick.status).toBe(409);
    expect(reusedForQuick.body.code).toBe("IDEMPOTENCY_CONFLICT");
    expect(await balanceOf(player)).toBe(balanceAfterQuick);
    expect(liveSeatsOf(player)).toBe("0");
  }, 120_000);
});

suite("C-4: a leave asked mid-hand at a table with no clock waits for the PERSON", () => {
  it("is refused while the hand is live, nothing moves the hand but the person, and then it closes with nothing returned", async () => {
    const player = await createPlayer();
    const table = await sitDown(player);
    // Deal until the person holds a live turn. A natural or a dealer ace can
    // end or pause the cascade at the lock; the fair dealer decides, so deal again.
    // `personMoves` replaces `table.state`, so the phase is re-read each time.
    const phase = (): string => table.state.phase;
    for (let hand = 0; hand < 12 && phase() !== "PLAYER_TURNS"; hand += 1) {
      while (phase() !== "BETTING_OPEN" && phase() !== "PLAYER_TURNS") await personMoves(table);
      if (phase() === "BETTING_OPEN") {
        await personMoves(table);
        if (phase() === "INSURANCE_OFFER") await personMoves(table);
      }
    }
    expect(table.state.phase).toBe("PLAYER_TURNS");
    expect(table.state.activeSeatId).toBe(table.seatId);
    expect(table.state.deadlineAt).toBeNull();
    const heldAt = table.state.version;

    const busy = await cashOutOf(player, table.gameId);
    expect(busy.status).toBe(409);
    expect(busy.body.code).toBe("SESSION_BUSY");

    // What the app's poll sees while it holds the leave: nothing changes.
    for (let poll = 0; poll < 3; poll += 1) {
      const read = await call("game-command", player.token, {
        gameId: table.gameId,
        clientActionId: crypto.randomUUID(),
        type: "RESOLVE_TIMEOUT",
        expectedVersion: 0,
        clientSentAt: iso(),
      });
      expect((read.body.publicState as Snapshot).version).toBe(heldAt);
      expect((read.body.publicState as Snapshot).phase).toBe("PLAYER_TURNS");
    }
    // And no timeout can stand the hand for them.
    const timeout = await call("game-command", player.token, {
      gameId: table.gameId,
      clientActionId: crypto.randomUUID(),
      type: "RESOLVE_TIMEOUT",
      expectedVersion: heldAt,
      clientSentAt: iso(),
    });
    expect(timeout.status).toBe(422);
    expect(timeout.body.code).toBe("DEADLINE_NOT_REACHED");
    expect(engineRow(table.gameId).version).toBe(heldAt);
    expect(sql(`select status from public.game_sessions where id = '${table.gameId}'::uuid`)).toBe("active");

    // The person finishes the hand — the computer players act inside those commands.
    for (let step = 0; step < 20 && table.state.phase === "PLAYER_TURNS"; step += 1) {
      expect((await send(table, "STAND")).response.status).toBe(200);
    }
    expect(table.state.phase).toBe("HAND_COMPLETE");

    // The held leave completes at the boundary, as the app's poll sends it.
    const closed = await cashOutOf(player, table.gameId);
    expect(closed.status).toBe(200);
    expect(closed.body.returned).toBe(0);
    expect(sql(`select status from public.game_sessions where id = '${table.gameId}'::uuid`)).toBe("completed");
    expect(liveSeatsOf(player)).toBe("0");
    await expectWalletAfter(player, "none");
  }, 240_000);
});
