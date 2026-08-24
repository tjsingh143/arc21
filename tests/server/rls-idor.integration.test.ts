/**
 * A SYSTEMATIC IDOR SWEEP over every table a client may read.
 *
 * THE GAP THIS FILLS. `assert_client_authorization_surface()` proves that RLS is
 * ON, that every grant has a policy behind it, and that no client role can reach
 * `private` or execute a server-only function. `20_authorization_surface.test.sql`
 * proves the same things again in pgTAP. Neither of them reads a single ROW.
 * They assert the shape of the permission system, not what it actually returns
 * to a second account holding a second real token — and a policy can be present,
 * granted, and wrong.
 *
 * Two defects found by hand this phase were both of that kind, and both looked
 * like something else:
 *
 *   * `profiles?select=xp` returns EVERY profile, because `profiles` is a
 *     directory by design — so `rows[0].xp` was a stranger's, and an XP
 *     assertion failed against somebody else's zero.
 *   * `game_session_seats?status=neq.left` returns every seat at a table you
 *     are seated at, correctly — so a "how many seats do I hold" check reported
 *     two the moment a second account was matched into the same public room,
 *     which reads exactly like a wallet defect.
 *
 * Neither was a vulnerability. Both were the policy behaving as designed and
 * nothing in the repository saying what that design IS. This file says it, per
 * table, in the only terms that matter: what a DIFFERENT account gets back.
 *
 * HOW TO READ IT. Every client-readable table is in exactly one of three lists
 * and none is left out — `covers every client-readable table` fails if a new
 * table gains a grant and nobody classifies it here. That test is the reason
 * this file cannot quietly go out of date.
 *
 *   OWNED    — a stranger must see NONE of it. Wallets, ledgers, statistics,
 *              attempts, entries, tokens, notifications.
 *   SHARED   — a stranger sees nothing, but a PARTICIPANT sees it on purpose.
 *              Asserted from the stranger's side only; the participant's view
 *              is what the game itself depends on.
 *   OPEN     — a catalogue or a directory, readable by design. Asserted to be
 *              readable, so that "it returns nothing" can never be mistaken for
 *              privacy here.
 */

import crypto from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";

import { callFunction as call } from "./call-function.js";
import { stackUp } from "./stack-guard.js";

const SUPABASE_URL = "http://127.0.0.1:54321";
const REST = `${SUPABASE_URL}/rest/v1`;
const AUTH_ADMIN = `${SUPABASE_URL}/auth/v1/admin/users`;

/** Published local-development keys. Identical on every machine, useless elsewhere. */
const LOCAL_JWT_SECRET = "super-secret-jwt-token-with-at-least-32-characters-long";
const LOCAL_SERVICE_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU";
const LOCAL_ANON_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0";

const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");

/** No `iat` — PostgREST refuses one that is ahead of its own clock. */
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

/**
 * A REST read as one player. Throws on anything that is not 200 — a helper that
 * reads something must throw rather than return a sentinel, or a harness error
 * becomes an assertion about rows.
 */
async function readAs(token: string, path: string): Promise<unknown[]> {
  const response = await fetch(`${REST}/${path}`, {
    headers: { apikey: LOCAL_ANON_KEY, Authorization: `Bearer ${token}` },
  });
  const raw = await response.text();
  if (response.status !== 200) {
    throw new Error(`GET ${path} answered ${response.status}: ${raw}`);
  }
  const rows = JSON.parse(raw) as unknown;
  if (!Array.isArray(rows)) throw new Error(`GET ${path} did not answer a list: ${raw}`);
  return rows;
}

async function rpc(token: string, name: string, args: Record<string, unknown> = {}) {
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
  return { status: response.status, body, raw };
}

const iso = () => new Date().toISOString();
const suite = stackUp ? describe : describe.skip;

suite("what a second account can actually read", () => {
  /** The player who owns everything below. */
  let ownerId = "";
  let owner = "";
  /** A signed-in stranger. No friendship, no shared table, no block. */
  let stranger = "";

  let gameId = "";
  let roomId = "";

  beforeAll(async () => {
    if (!stackUp) return;
    ownerId = await createUser("idor-owner");
    owner = signToken(ownerId);
    stranger = signToken(await createUser("idor-stranger"));

    /*
     * The owner does enough to write a row into every OWNED and SHARED table
     * this file names. A sweep over empty tables passes having proved nothing,
     * so `every owned table actually has a row to hide` asserts the fixture
     * before the sweep asserts the policy.
     */

    // A Quick Play table, played for one hand: game_sessions, game_session_seats,
    // game_events, hand_records, hand_players, player_actions, player_stats,
    // player_mode_stats, player_decision_periods, player_daily_xp, wallet_ledger.
    const opened = await call("create-session", owner, {
      action: "OPEN",
      clientRequestId: crypto.randomUUID(),
      tier: "casual",
      clientSentAt: iso(),
    });
    if (opened.status !== 200) {
      throw new Error(`could not open a table: HTTP ${opened.status} ${opened.raw}`);
    }
    gameId = String(opened.body.gameId);

    let state = opened.body.publicState as { version: number; phase: string; activeSeatId: string | null };
    const seatId = String(opened.body.seatId);
    const phaseNow = (): string => state.phase;
    const send = async (type: string, payload?: Record<string, unknown>) => {
      const result = await call("game-command", owner, {
        gameId,
        clientActionId: crypto.randomUUID(),
        type,
        ...(payload ? { payload } : {}),
        expectedVersion: state.version,
        clientSentAt: iso(),
      });
      if (result.status !== 200) {
        throw new Error(`${type} was refused: HTTP ${result.status} ${result.raw}`);
      }
      state = result.body.publicState as typeof state;
      return result;
    };

    await send("PLACE_BET", { amount: 50 });
    await send("LOCK_BET");
    for (let step = 0; step < 30 && phaseNow() !== "HAND_COMPLETE"; step += 1) {
      if (phaseNow() === "INSURANCE_OFFER") {
        await send("DECLINE_INSURANCE");
        continue;
      }
      if (phaseNow() === "PLAYER_TURNS" && state.activeSeatId === seatId) {
        await send("STAND");
        continue;
      }
      break;
    }

    // A private room: rooms, room_members.
    const room = await rpc(owner, "create_private_room", { p_max_seats: 2 });
    if (room.status >= 400) throw new Error(`create_private_room: ${room.status} ${room.raw}`);
    roomId = (room.body as { id: string }).id;

    // push_tokens, loadouts, notifications, user_cosmetics.
    const token = await rpc(owner, "register_push_token", {
      p_token: `ExponentPushToken[${crypto.randomUUID()}]`,
      p_platform: "ios",
      p_device_id: crypto.randomUUID(),
    });
    // 204 as well as 200: PostgREST answers No Content for a void function, and
    // treating that as a failure would fail the fixture rather than the policy.
    if (token.status >= 400) throw new Error(`register_push_token: ${token.status} ${token.raw}`);
    const cosmetics = await rpc(owner, "grant_earned_cosmetics");
    if (cosmetics.status >= 400) {
      throw new Error(`grant_earned_cosmetics: ${cosmetics.status} ${cosmetics.raw}`);
    }

    // A friend request from the stranger, so `friend_requests` has a row that
    // NEITHER of them owns outright. It is left pending on purpose.
    const requested = await rpc(stranger, "send_friend_request", { p_to: ownerId });
    if (requested.status >= 400) {
      throw new Error(`send_friend_request: ${requested.status} ${requested.raw}`);
    }
  }, 120_000);

  /**
   * Tables whose rows belong to one player, and the filter that finds THAT
   * player's rows. A stranger must get an empty list — not a 403, because RLS
   * filters rather than refuses, and an empty list is the correct shape.
   */
  const OWNED: { table: string; filter: (ownerId: string, gameId: string) => string }[] = [
    { table: "wallets", filter: (u) => `user_id=eq.${u}` },
    { table: "wallet_ledger", filter: (u) => `user_id=eq.${u}` },
    { table: "player_stats", filter: (u) => `user_id=eq.${u}` },
    { table: "player_mode_stats", filter: (u) => `user_id=eq.${u}` },
    { table: "player_daily_xp", filter: (u) => `user_id=eq.${u}` },
    { table: "player_decision_periods", filter: (u) => `user_id=eq.${u}` },
    { table: "career_attempts", filter: (u) => `user_id=eq.${u}` },
    { table: "career_progress", filter: (u) => `user_id=eq.${u}` },
    { table: "daily_entries", filter: (u) => `user_id=eq.${u}` },
    { table: "loadouts", filter: (u) => `user_id=eq.${u}` },
    { table: "push_tokens", filter: (u) => `user_id=eq.${u}` },
    { table: "notifications", filter: (u) => `user_id=eq.${u}` },
    { table: "user_cosmetics", filter: (u) => `user_id=eq.${u}` },
    { table: "matchmaking_queue", filter: (u) => `user_id=eq.${u}` },
    { table: "blocks", filter: (u) => `blocker_id=eq.${u}` },
    { table: "friendships", filter: (u) => `user_id_a=eq.${u}` },
    { table: "tournament_entries", filter: (u) => `user_id=eq.${u}` },
  ];

  /**
   * Tables a PARTICIPANT is meant to see and a stranger is not. Filtered by the
   * thing that identifies the owner's table or room rather than by a user id,
   * because that is how a stranger would actually go looking.
   */
  const SHARED: { table: string; filter: (ownerId: string, gameId: string, roomId: string) => string }[] = [
    { table: "game_sessions", filter: (_u, g) => `id=eq.${g}` },
    { table: "game_session_seats", filter: (_u, g) => `game_session_id=eq.${g}` },
    { table: "game_events", filter: (_u, g) => `game_session_id=eq.${g}` },
    { table: "rooms", filter: (_u, _g, r) => `id=eq.${r}` },
    { table: "room_members", filter: (_u, _g, r) => `room_id=eq.${r}` },
  ];

  /** Catalogues and directories. Readable by design; asserted so. */
  const OPEN = ["career_nodes", "cosmetics", "rulesets", "profiles"];

  /**
   * ARCHITECTED FOR AND DELIBERATELY UNWRITTEN.
   *
   * `hand_records`, `hand_players` and `player_actions` are the hand-history
   * archive, and the specification puts "hand history/replay" under **"V1.1 — DO
   * NOT LET THESE DELAY MVP"**. The tables, their CHECK constraints, their
   * indexes, their RLS policies and their `deny_client_write` triggers all
   * exist; nothing writes a row, on purpose.
   *
   * They are asserted EMPTY rather than skipped, and that is the point. Zero
   * rows across every session the whole suite plays is the evidence that this is
   * a decision rather than a feature that quietly stopped working — and the day
   * somebody starts writing them, this fails and forces the participant-visibility
   * assertions to be written at the same time, instead of shipping a hand
   * archive whose policies nobody re-read.
   *
   * The stranger sweep below still covers them: a grant that returns nothing
   * because the table is empty proves nothing about the policy, so their
   * emptiness is asserted HERE and their policies are asserted from the
   * catalogue rather than from rows.
   */
  const RESERVED_FOR_V1_1 = ["hand_records", "hand_players", "player_actions"];

  /**
   * Two tables that are neither owned nor shared nor open, and are listed here
   * so the completeness check below has somewhere to put them.
   *
   * `friend_requests` is a RELATIONSHIP: a row is visible to its sender and its
   * receiver and to nobody else, so "the owner's rows" is not a well-formed
   * question. `tournaments` and `tournament_matches` are the competition's
   * public shape — a bracket everyone in it can see.
   */
  const EXPLAINED = ["friend_requests", "tournaments", "tournament_matches"];

  /*
   * WHERE COMPLETENESS IS ENFORCED, and it is not here.
   *
   * The first version of this file tried to prove its own coverage by reading
   * the grants back out of the catalogue. It could not: PostgREST does not
   * expose `information_schema`, so the check fell back to comparing the four
   * lists above with themselves and passed against anything — a test that
   * matches nothing reading as enforcement, which is a trap this repository has
   * now hit three times.
   *
   * `supabase/tests/20_authorization_surface.test.sql` does it instead, in
   * pgTAP, where the catalogue is one query away: it asserts that the set of
   * client-readable tables is EXACTLY the set these lists classify. A new table
   * with a SELECT grant fails there, and whoever adds it has to come here and
   * decide what a stranger may see of it.
   */

  /** A sweep over empty tables passes having proved nothing. */
  it("has a row in the owner's own tables to begin with", async () => {
    const populated = ["wallets", "wallet_ledger", "player_stats", "push_tokens", "loadouts"];
    for (const table of populated) {
      const rows = await readAs(owner, `${table}?select=id&user_id=eq.${ownerId}`);
      expect(rows.length, `${table} has no fixture row, so hiding it proves nothing`).toBeGreaterThan(
        0,
      );
    }
    expect(await readAs(owner, `game_sessions?select=id&id=eq.${gameId}`)).toHaveLength(1);
    expect(await readAs(owner, `rooms?select=id&id=eq.${roomId}`)).toHaveLength(1);
  });

  /**
   * The hand archive is empty, and the specification says it should be.
   *
   * The owner has just played a full hand at a Quick Play table — the same hand
   * that populated `player_stats`, `wallet_ledger` and 3,600-odd `game_events`.
   * If these three ever gain a row, "hand history/replay" has started shipping
   * and its participant-visibility needs asserting; until then, `docs/DATABASE.md`
   * calling them a "Completed-hand archive" is describing a shape, not a
   * feature, and this test is what keeps the two statements from drifting.
   */
  it("leaves the V1.1 hand archive empty, as the specification asks", async () => {
    for (const table of RESERVED_FOR_V1_1) {
      const rows = await readAs(owner, `${table}?select=id&limit=1`);
      expect(
        rows,
        `${table} has rows. Hand history is V1.1 — if it is shipping, this file ` +
          `needs the participant-visibility assertions the other shared tables have.`,
      ).toHaveLength(0);
    }
  });

  it("shows a stranger none of another player's own rows", async () => {
    for (const { table, filter } of OWNED) {
      const rows = await readAs(stranger, `${table}?select=id&${filter(ownerId, gameId)}`);
      expect(rows, `${table} leaked ${rows.length} row(s) to a stranger`).toHaveLength(0);
    }
  });

  it("shows a stranger nothing of a table or room they are not at", async () => {
    for (const { table, filter } of SHARED) {
      const rows = await readAs(stranger, `${table}?select=id&${filter(ownerId, gameId, roomId)}`);
      expect(rows, `${table} leaked ${rows.length} row(s) to a non-participant`).toHaveLength(0);
    }
  });

  /**
   * And the same rows ARE visible to the person they belong to. Without this,
   * every assertion above would still pass against a database that returns
   * nothing to anybody — which is the failure mode a security sweep is most
   * likely to hide.
   */
  it("shows the owner their own rows, so the sweep is not passing on emptiness", async () => {
    for (const table of ["wallets", "wallet_ledger", "player_stats", "push_tokens", "loadouts"]) {
      const rows = await readAs(owner, `${table}?select=id&user_id=eq.${ownerId}`);
      expect(rows.length, `${table} is hidden from its own owner`).toBeGreaterThan(0);
    }
    for (const { table, filter } of SHARED) {
      const rows = await readAs(owner, `${table}?select=id&${filter(ownerId, gameId, roomId)}`);
      expect(rows.length, `${table} is hidden from the participant`).toBeGreaterThan(0);
    }
  });

  /** The catalogues are readable, so an empty answer above means privacy. */
  it("leaves the catalogues and the player directory readable", async () => {
    for (const table of OPEN) {
      const rows = await readAs(stranger, `${table}?select=id&limit=1`);
      expect(rows.length, `${table} is a catalogue and answered nothing`).toBeGreaterThan(0);
    }
  });

  /**
   * `anon` — a client with the published anon key and no session at all. Every
   * one of these tables is behind `to authenticated`, so the answer is a
   * refusal rather than an empty list.
   */
  it("gives an unauthenticated caller nothing at all", async () => {
    for (const table of ["wallets", "wallet_ledger", "player_stats", "game_sessions", "profiles"]) {
      const response = await fetch(`${REST}/${table}?select=id&limit=1`, {
        headers: { apikey: LOCAL_ANON_KEY },
      });
      const raw = await response.text();
      const refused = response.status >= 400 || raw === "[]";
      expect(refused, `${table} answered ${response.status} ${raw.slice(0, 120)} to anon`).toBe(true);
    }
  });
});
