/**
 * The private-table LOBBY, against the real database.
 *
 * `14_rooms.test.sql` asserts the room functions from inside Postgres with
 * `set local role`. This file asserts the same rules the way a CLIENT reaches
 * them — PostgREST, an ordinary user's JWT, the exact RPC names the gateway
 * calls — because that is the layer the lobby UI is now wired to and the layer
 * a modified client would attack.
 *
 * THE DEFECT THIS FILE WAS WRITTEN FOR. `remove_room_member` shipped in
 * `20260823170000` with six pgTAP assertions, all of which passed, and it did
 * not work: `join_private_room` upserts `on conflict (room_id, user_id) do
 * update set status = 'joined'`, so a removed player typed the same six
 * characters again and was back at the table. The pgTAP file proved the row
 * said `kicked`; nothing proved the row STAYED that way, which is the only
 * thing a host removing somebody is asking for.
 *
 *   supabase start
 *   supabase functions serve --no-verify-jwt
 */

import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";

import { callFunction } from "./call-function.js";
import { stackUp } from "./stack-guard.js";
import { OPEN_ROOM_FILTER } from "../../src/features/rooms/rooms-gateway.js";

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

/**
 * No `iat`, deliberately — see the note in `economy-guards.integration.test.ts`.
 * PostgREST validates it against the container clock, which jumps rather than
 * drifts, and the failure reads as a wallet or profile defect rather than skew.
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
      email: `room-${crypto.randomUUID()}@arc21.test`,
      password: crypto.randomUUID(),
      email_confirm: true,
    }),
  });
  const json = (await response.json()) as { id?: string };
  // A helper that reads something THROWS when it cannot. Returning a sentinel
  // turns a harness failure into an assertion failure about the wrong subject.
  if (!json.id) throw new Error(`could not create a test user: ${response.status}`);
  return { id: json.id, token: signToken(json.id) };
}

interface RpcResult {
  readonly status: number;
  readonly body: unknown;
}

/** Exactly what the client gateway does: an RPC as the signed-in player. */
async function rpc(player: Player, name: string, args: unknown = {}): Promise<RpcResult> {
  const response = await fetch(`${REST}/rpc/${name}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: LOCAL_ANON_KEY,
      Authorization: `Bearer ${player.token}`,
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

interface RoomRow {
  readonly id: string;
  readonly code: string;
  readonly host_user_id: string;
  readonly max_seats: number;
  readonly status: string;
  readonly game_session_id: string | null;
}

/**
 * What a refusal looks like on the wire, and why it is not a bare `null`.
 *
 * `join_private_room` returns `public.rooms`, so a NULL record renders as a row
 * of null COLUMNS. The client's `toRoom` parses that with zod and gets nothing,
 * which is how one fixed sentence reaches the player whatever the cause. Keyed
 * on `id` because that is what the parse keys on.
 */
function refusedJoin(result: RpcResult): boolean {
  if (result.status >= 300) return false;
  const candidate = Array.isArray(result.body) ? result.body[0] : result.body;
  return (candidate as { id?: unknown } | null)?.id == null;
}

function asRoom(result: RpcResult): RoomRow {
  const candidate = Array.isArray(result.body) ? result.body[0] : result.body;
  const room = candidate as RoomRow | null;
  if (!room || typeof room.id !== "string") {
    throw new Error(`expected a room row, got ${result.status} ${JSON.stringify(result.body)}`);
  }
  return room;
}

interface MemberRow {
  readonly member_user_id: string;
  readonly member_seat_index: number;
  readonly member_is_ready: boolean;
  readonly member_is_host: boolean;
}

async function readRoom(player: Player, roomId: string): Promise<MemberRow[]> {
  const result = await rpc(player, "get_room_state", { p_room_id: roomId });
  if (!Array.isArray(result.body)) {
    throw new Error(`get_room_state failed: ${result.status} ${JSON.stringify(result.body)}`);
  }
  return result.body as MemberRow[];
}

async function openRoomWithGuest(seats = 3): Promise<{
  host: Player;
  guest: Player;
  room: RoomRow;
}> {
  const host = await createPlayer();
  const guest = await createPlayer();
  const room = asRoom(await rpc(host, "create_private_room", { p_max_seats: seats }));
  const joined = asRoom(await rpc(guest, "join_private_room", { p_code: room.code }));
  expect(joined.id).toBe(room.id);
  return { host, guest, room };
}

/** A plain REST read as the player, which is what `findOpenRoom` performs. */
async function restQuery(player: Player, path: string): Promise<{ status: number; rows: unknown[] }> {
  const response = await fetch(`${REST}/${path}`, {
    headers: { apikey: LOCAL_ANON_KEY, Authorization: `Bearer ${player.token}` },
  });
  const body = (await response.json()) as unknown;
  if (!Array.isArray(body)) {
    throw new Error(`expected rows, got ${response.status} ${JSON.stringify(body)}`);
  }
  return { status: response.status, rows: body };
}

/** The gateway's own filter, URL-encoded exactly as PostgREST expects it. */
function openRoomPath(): string {
  return `rooms?select=id,code,status&or=(${encodeURIComponent(OPEN_ROOM_FILTER)})&order=created_at.desc&limit=1`;
}

/**
 * Reaching past every client role, on purpose, to age a row.
 *
 * `public.rooms` carries no grant to `service_role` — chip-adjacent tables
 * deliberately do not — and `expires_at` is writable by nobody through
 * PostgREST at all. Ageing a lobby is not something the product does; it is
 * something TIME does, and a test that waited thirty minutes for it would not
 * be a test. So this reaches the database directly, and only ever to arrange
 * the fixture: every assertion around it goes through the client's own path.
 *
 * It THROWS when it cannot run rather than skipping. A helper that swallows a
 * failure turns "the fixture was never created" into "the assertion passed".
 */
function inDatabase(sql: string): void {
  const container = execFileSync(
    "docker",
    ["ps", "--filter", "name=supabase_db_", "--format", "{{.Names}}"],
    { encoding: "utf8" },
  )
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)[0];
  if (!container) {
    throw new Error("no supabase_db_* container is running, so the fixture cannot be arranged");
  }
  execFileSync("docker", ["exec", container, "psql", "-U", "postgres", "-d", "postgres", "-c", sql], {
    encoding: "utf8",
  });
}

const suite = stackUp ? describe : describe.skip;

/**
 * Ready states — the lobby's own control, not a gate on dealing.
 *
 * The specification's start rule is "minimum 2 human players", so readiness
 * informs the host and does not block the button. What it must do is round-trip:
 * the flag a player sets has to be the flag every other client reads.
 */
suite("ready states round-trip through the RPCs the lobby calls", () => {
  it("shows the host ready on creation and a joiner not ready", async () => {
    const { host, guest, room } = await openRoomWithGuest();

    const members = await readRoom(host, room.id);
    const hostRow = members.find((row) => row.member_user_id === host.id);
    const guestRow = members.find((row) => row.member_user_id === guest.id);

    expect(hostRow?.member_is_ready).toBe(true);
    expect(guestRow?.member_is_ready).toBe(false);
  }, 30_000);

  it("carries a guest's readiness to the host's reading of the room", async () => {
    const { host, guest, room } = await openRoomWithGuest();

    const set = await rpc(guest, "set_room_ready", { p_room_id: room.id, p_ready: true });
    expect(set.status).toBeLessThan(300);

    const seenByHost = await readRoom(host, room.id);
    expect(seenByHost.find((row) => row.member_user_id === guest.id)?.member_is_ready).toBe(true);

    await rpc(guest, "set_room_ready", { p_room_id: room.id, p_ready: false });
    const again = await readRoom(host, room.id);
    expect(again.find((row) => row.member_user_id === guest.id)?.member_is_ready).toBe(false);
  }, 30_000);

  it("refuses readiness from somebody who is not at the table", async () => {
    const { room } = await openRoomWithGuest();
    const stranger = await createPlayer();

    const set = await rpc(stranger, "set_room_ready", { p_room_id: room.id, p_ready: true });
    // PT404 → PostgREST 404. The point is that it is refused, not the number.
    expect(set.status).toBeGreaterThanOrEqual(400);
  }, 30_000);
});

/**
 * Host removal. "Host can remove a member only while in lobby."
 */
suite("a host removing a member from the lobby", () => {
  it("removes them from the seat list", async () => {
    const { host, guest, room } = await openRoomWithGuest();

    const removed = await rpc(host, "remove_room_member", {
      p_room_id: room.id,
      p_user_id: guest.id,
    });
    expect(removed.body).toBe(true);

    const members = await readRoom(host, room.id);
    expect(members.map((row) => row.member_user_id)).toEqual([host.id]);
  }, 30_000);

  it("KEEPS them out — a removed player cannot rejoin with the same code", async () => {
    const { host, guest, room } = await openRoomWithGuest();

    await rpc(host, "remove_room_member", { p_room_id: room.id, p_user_id: guest.id });

    // The whole point of removing somebody. Before this was fixed the upsert in
    // `join_private_room` set `status = 'joined'` again and they walked back in.
    const rejoin = await rpc(guest, "join_private_room", { p_code: room.code });
    expect(refusedJoin(rejoin)).toBe(true);

    const members = await readRoom(host, room.id);
    expect(members.map((row) => row.member_user_id)).toEqual([host.id]);
  }, 30_000);

  it("refuses the removed player in the same words as a code that never existed", async () => {
    const { host, guest, room } = await openRoomWithGuest();
    await rpc(host, "remove_room_member", { p_room_id: room.id, p_user_id: guest.id });

    const kicked = await rpc(guest, "join_private_room", { p_code: room.code });
    const unknown = await rpc(guest, "join_private_room", { p_code: "ZZZZZZ" });

    // Byte-identical, not merely both-refused: a removed player's code going
    // quiet is the one refusal that would otherwise be distinguishable, and it
    // would tell a code-guesser their six characters had hit a live room.
    expect(kicked.status).toBe(unknown.status);
    expect(JSON.stringify(kicked.body)).toBe(JSON.stringify(unknown.body));
    expect(refusedJoin(kicked)).toBe(true);
  }, 30_000);

  it("tells the removed player nothing beyond that they are not at the table", async () => {
    const { host, guest, room } = await openRoomWithGuest();
    await rpc(host, "remove_room_member", { p_room_id: room.id, p_user_id: guest.id });

    const state = await rpc(guest, "get_room_state", { p_room_id: room.id });
    expect(state.status).toBeGreaterThanOrEqual(400);
  }, 30_000);

  it("refuses a non-host, and refuses without saying whether the room exists", async () => {
    const { host, guest, room } = await openRoomWithGuest();

    const byGuest = await rpc(guest, "remove_room_member", {
      p_room_id: room.id,
      p_user_id: host.id,
    });
    expect(byGuest.body).toBe(false);

    const stranger = await createPlayer();
    const byStranger = await rpc(stranger, "remove_room_member", {
      p_room_id: room.id,
      p_user_id: guest.id,
    });
    expect(byStranger.body).toBe(false);

    // Indistinguishable from the answer for a room that never existed.
    const invented = await rpc(stranger, "remove_room_member", {
      p_room_id: crypto.randomUUID(),
      p_user_id: guest.id,
    });
    expect(invented.body).toBe(false);

    const members = await readRoom(host, room.id);
    expect(members.map((row) => row.member_user_id).sort()).toEqual([host.id, guest.id].sort());
  }, 30_000);

  it("refuses to remove the host themselves — that is `leave_room`", async () => {
    const { host, room } = await openRoomWithGuest();

    const removed = await rpc(host, "remove_room_member", {
      p_room_id: room.id,
      p_user_id: host.id,
    });
    expect(removed.body).toBe(false);
  }, 30_000);
});

/**
 * Seats, when people come and go.
 *
 * `leave_room` and `remove_room_member` both KEEP the member row — one so a
 * player can come back, the other so the removal is remembered — and both keep
 * its `seat_index`. `join_private_room` allocates "the lowest seat no JOINED
 * member holds", which is the right rule and was contradicted by a
 * `unique (room_id, seat_index)` covering every row whatever its status.
 *
 * So the ordinary sequence — somebody leaves, somebody else takes the free
 * seat — raised 23505 and the join failed at a table with a seat free. Nothing
 * covered it: every room test until now filled a room and stopped.
 */
suite("a seat that somebody has vacated", () => {
  it("can be taken by the next player to join", async () => {
    const { host, guest, room } = await openRoomWithGuest(3);

    await rpc(guest, "leave_room", { p_room_id: room.id });

    const next = await createPlayer();
    const joined = await rpc(next, "join_private_room", { p_code: room.code });
    expect(refusedJoin(joined)).toBe(false);

    const members = await readRoom(host, room.id);
    expect(members.map((row) => row.member_user_id).sort()).toEqual([host.id, next.id].sort());
    // Two people at a table sit in two different places.
    expect(new Set(members.map((row) => row.member_seat_index)).size).toBe(members.length);
  }, 30_000);

  it("can be taken after the host removed the player who held it", async () => {
    const { host, guest, room } = await openRoomWithGuest(3);

    await rpc(host, "remove_room_member", { p_room_id: room.id, p_user_id: guest.id });

    const next = await createPlayer();
    const joined = await rpc(next, "join_private_room", { p_code: room.code });
    expect(refusedJoin(joined)).toBe(false);

    const members = await readRoom(host, room.id);
    expect(members.map((row) => row.member_user_id).sort()).toEqual([host.id, next.id].sort());
  }, 30_000);

  it("is given back to the player who left, when they come back to a table that kept it", async () => {
    const { host, guest, room } = await openRoomWithGuest(3);

    await rpc(guest, "leave_room", { p_room_id: room.id });
    const back = await rpc(guest, "join_private_room", { p_code: room.code });
    expect(refusedJoin(back)).toBe(false);

    const members = await readRoom(host, room.id);
    expect(members.map((row) => row.member_user_id).sort()).toEqual([host.id, guest.id].sort());
    expect(new Set(members.map((row) => row.member_seat_index)).size).toBe(2);
  }, 30_000);

  it("does not collide when the returning player's old seat was taken meanwhile", async () => {
    const { host, guest, room } = await openRoomWithGuest(3);

    await rpc(guest, "leave_room", { p_room_id: room.id });

    // Somebody else takes the seat the guest used to hold.
    const next = await createPlayer();
    expect(refusedJoin(await rpc(next, "join_private_room", { p_code: room.code }))).toBe(false);

    // The guest comes back to a table with one seat left, and it is not theirs.
    const back = await rpc(guest, "join_private_room", { p_code: room.code });
    expect(refusedJoin(back)).toBe(false);

    const members = await readRoom(host, room.id);
    expect(members).toHaveLength(3);
    expect(new Set(members.map((row) => row.member_seat_index)).size).toBe(3);
  }, 30_000);
});

/**
 * Reconnect — "Loading/reconnect must preserve room code".
 *
 * This is the query `findOpenRoom` sends, imported from the gateway rather than
 * rewritten here, so a change to the app's filter changes this test's subject
 * too. Two properties are proved, and the second is the one a device clock
 * could not give: `now()` is evaluated by POSTGRES, so an expired lobby stops
 * being restorable on the server's clock and not the phone's.
 */
suite("finding the table a player is already at", () => {
  it("finds the room the caller is seated at, and only that one", async () => {
    const { host, guest, room } = await openRoomWithGuest();

    for (const player of [host, guest]) {
      const found = await restQuery(player, openRoomPath());
      expect(found.rows).toHaveLength(1);
      expect((found.rows[0] as { code: string }).code).toBe(room.code);
    }

    // Somebody with no table open gets nothing — the RLS policy is the filter.
    const stranger = await createPlayer();
    expect((await restQuery(stranger, openRoomPath())).rows).toHaveLength(0);
  }, 30_000);

  it("stops offering a lobby whose thirty minutes have passed", async () => {
    const { host, room } = await openRoomWithGuest();
    expect((await restQuery(host, openRoomPath())).rows).toHaveLength(1);

    // `now() - interval` rather than a timestamp computed here: the comparison
    // under test is made on the DATABASE's clock, so the fixture is written on
    // it too. A host clock a few seconds ahead is exactly the skew that has
    // made three other tests in this repository look like product defects.
    inDatabase(
      `update public.rooms set expires_at = now() - interval '1 minute' where id = '${room.id}'`,
    );

    expect((await restQuery(host, openRoomPath())).rows).toHaveLength(0);
  }, 30_000);

  it("keeps offering a table that is PLAYING, whatever its lobby timeout said", async () => {
    // `expires_at` is the LOBBY's thirty minutes, not the table's. A game that
    // outlives it is every real game, and filtering an active room on that
    // column would strand everybody at it.
    const { host, room } = await openRoomWithGuest();

    inDatabase(
      `update public.rooms set status = 'active', ` +
        `expires_at = now() - interval '1 minute' where id = '${room.id}'`,
    );

    const found = await restQuery(host, openRoomPath());
    expect(found.rows).toHaveLength(1);
    expect((found.rows[0] as { status: string }).status).toBe("active");
  }, 30_000);
});

/**
 * A ROOM ENDS WHEN ITS GAME DOES.
 *
 * THE DEFECT, measured against this stack before the fix existed: `leave_room`
 * is the only thing in the whole schema that had ever written
 * `rooms.status = 'closed'`, and it is reachable from the LOBBY only. The moment
 * the host deals, every client is on `/table/[gameId]`, and leaving there sends
 * `CASH_OUT` to `create-session` — which settled the seat, ended the session and
 * never touched the room. `expire_stale_rooms()` could not help either: it only
 * looked at `status = 'lobby'`.
 *
 *     start                200 private_table_started
 *     both players CASH_OUT 200 cashed_out   (game_sessions.status = completed)
 *     rooms row            status = active, code still held
 *     create_private_room  400 P0001 "you already have a table open"
 *
 * That last line was PERMANENT: one private table per account, for the lifetime
 * of the account, and the six-character code never came back.
 *
 * The third case below is the one that keeps the fix honest. A SEAT closing and
 * a TABLE closing are different events — the same distinction `settleTableClosure`
 * already draws — so one player leaving a three-seat table must leave the room
 * exactly where it was for the two still playing.
 */
suite("a room's life ends with its game", () => {
  const iso = () => new Date().toISOString();

  async function dealtTable(seats = 2): Promise<{
    host: Player;
    guest: Player;
    room: RoomRow;
    gameId: string;
  }> {
    const { host, guest, room } = await openRoomWithGuest(seats);
    const started = await callFunction("create-session", host.token, {
      action: "START_PRIVATE_TABLE",
      clientRequestId: crypto.randomUUID(),
      roomId: room.id,
      clientSentAt: iso(),
    });
    expect(started.status).toBe(200);
    const gameId = started.body.gameId;
    if (typeof gameId !== "string") throw new Error(`no gameId: ${started.raw}`);
    return { host, guest, room, gameId };
  }

  async function cashOut(player: Player, gameId: string): Promise<void> {
    const out = await callFunction("create-session", player.token, {
      action: "CASH_OUT",
      clientRequestId: crypto.randomUUID(),
      gameId,
      clientSentAt: iso(),
    });
    expect(out.status).toBe(200);
    expect(out.body.status).toBe("cashed_out");
  }

  /**
   * `public.rooms` grants nothing to `service_role` — chip-adjacent tables
   * deliberately do not — and the host stops being able to read the row through
   * PostgREST the moment it closes, because `rooms_select_member` is scoped to
   * the room and the SELECT still works but the app has moved on. Reading it
   * straight from the database is the only way to assert on a row whose whole
   * point is that no client should be looking at it any more.
   */
  function roomStatus(roomId: string): string {
    const container = execFileSync(
      "docker",
      ["ps", "--filter", "name=supabase_db_", "--format", "{{.Names}}"],
      { encoding: "utf8" },
    )
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)[0];
    if (!container) throw new Error("no supabase_db_* container is running");
    return execFileSync(
      "docker",
      [
        "exec",
        container,
        "psql",
        "-U",
        "postgres",
        "-d",
        "postgres",
        "-tAc",
        `select status from public.rooms where id = '${roomId}'`,
      ],
      { encoding: "utf8" },
    ).trim();
  }

  it("retires the room when the last player cashes out", async () => {
    const { host, guest, room, gameId } = await dealtTable();
    expect(roomStatus(room.id)).toBe("active");

    await cashOut(host, gameId);
    await cashOut(guest, gameId);

    expect(roomStatus(room.id)).toBe("closed");
  }, 60_000);

  it("lets the host open another table afterwards, which it never did", async () => {
    const { host, guest, gameId } = await dealtTable();
    await cashOut(host, gameId);
    await cashOut(guest, gameId);

    const again = await rpc(host, "create_private_room", { p_max_seats: 5 });
    // Was `400 P0001 "you already have a table open"` — for ever.
    expect(again.status).toBe(200);
    expect(asRoom(again).code).toMatch(/^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{6}$/);
  }, 60_000);

  it("keeps the room open while other seats are still playing", async () => {
    const { host, guest, room, gameId } = await dealtTable(3);
    const third = await createPlayer();
    // The third player joins the LOBBY before the deal in `dealtTable`? No — the
    // table has already dealt, so this proves the other half at the same time:
    // a newcomer is refused, and the room is unaffected by the refusal.
    expect(refusedJoin(await rpc(third, "join_private_room", { p_code: room.code }))).toBe(true);

    await cashOut(guest, gameId);

    // One seat left. The table did not.
    expect(roomStatus(room.id)).toBe("active");

    await cashOut(host, gameId);
    expect(roomStatus(room.id)).toBe("closed");
  }, 60_000);
});

/**
 * ONCE THE TABLE HAS DEALT, THE SERVER OWNS THE GAME.
 *
 * `join_private_room` admits `status in ('lobby', 'active')`, which is right for
 * the case it was written for — rejoining IS how reconnection works. It did not
 * distinguish a returning player from a stranger, and seats are fixed when the
 * host deals. Measured before the fix: a third player joined a playing room with
 * HTTP 200, `get_room_state` listed them as a member, and their
 * `game_session_seats` query returned `[]` — so the lobby, which resolves its own
 * seat from that table, polled for one for ever with nothing on screen to say
 * why, while the other two played.
 */
suite("joining a table that has already dealt", () => {
  const iso = () => new Date().toISOString();

  it("refuses a newcomer, in the same words as every other refusal", async () => {
    const { host, room } = await openRoomWithGuest(5);
    await callFunction("create-session", host.token, {
      action: "START_PRIVATE_TABLE",
      clientRequestId: crypto.randomUUID(),
      roomId: room.id,
      clientSentAt: iso(),
    });

    const stranger = await createPlayer();
    const attempt = await rpc(stranger, "join_private_room", { p_code: room.code });

    // No row: the same answer an unknown code, an expired table, a block and a
    // full table all give, so a code-guesser learns nothing from the difference.
    expect(refusedJoin(attempt)).toBe(true);
    // And nothing was written. A member row with no seat is the stranding.
    const seen = await rpc(stranger, "get_room_state", { p_room_id: room.id });
    expect(seen.status).toBe(404);
  }, 60_000);

  it("still lets a player already at the table rejoin, which is reconnection", async () => {
    const { host, guest, room } = await openRoomWithGuest(5);
    await callFunction("create-session", host.token, {
      action: "START_PRIVATE_TABLE",
      clientRequestId: crypto.randomUUID(),
      roomId: room.id,
      clientSentAt: iso(),
    });

    const back = await rpc(guest, "join_private_room", { p_code: room.code });
    expect(asRoom(back).id).toBe(room.id);
  }, 60_000);
});

/**
 * A REFUSAL IS NOT A SERVER FAULT.
 *
 * `CLAUDE.md` already carries this lesson — "PostgREST maps SQLSTATE `PTnnn` to
 * HTTP nnn… the username limit raised `55000`, which PostgREST renders as HTTP
 * 500" — and every deliberate refusal in the friend graph and the lobby raised
 * `P0002`, which PostgREST has no mapping for either. Measured on this stack:
 * four refusals answering 500 beside two `P0001` refusals answering 400.
 *
 * The client already keyed on the SQLSTATE in the body rather than the status,
 * which is exactly why it survived: the wording a player saw was right. What it
 * broke is everything that reads a status — a 5xx rate is the standard signal
 * that a service is unhealthy, and ordinary play emitted server errors.
 */
suite("refusals answer with a client-error status", () => {
  it("answers 404, not 500, for every deliberate refusal", async () => {
    const player = await createPlayer();
    const other = await createPlayer();

    const cases: Array<[string, RpcResult]> = [
      ["send_friend_request to nobody", await rpc(player, "send_friend_request", { p_to: crypto.randomUUID() })],
      ["accept nothing pending", await rpc(player, "accept_friend_request", { p_from: other.id })],
      ["get_room_state elsewhere", await rpc(player, "get_room_state", { p_room_id: crypto.randomUUID() })],
      ["set_room_ready elsewhere", await rpc(player, "set_room_ready", { p_room_id: crypto.randomUUID(), p_ready: true })],
      ["invite a stranger", await rpc(player, "invite_friend_to_room", { p_room_id: crypto.randomUUID(), p_friend: other.id })],
    ];

    for (const [label, result] of cases) {
      expect(`${label}: ${result.status}`).toBe(`${label}: 404`);
      expect((result.body as { code?: string }).code).toBe("PT404");
    }
  }, 30_000);

  it("still answers 400 for the refusals that were already right", async () => {
    const player = await createPlayer();
    const mine = await rpc(player, "send_friend_request", { p_to: player.id });
    expect(mine.status).toBe(400);
    const seats = await rpc(player, "create_private_room", { p_max_seats: 9 });
    expect(seats.status).toBe(400);
  }, 30_000);
});

/**
 * "Last seen" is a time somebody was seen.
 *
 * The specification asks for ephemeral Realtime presence and to "persist only
 * last_seen_at for fallback". The column exists, `list_friends()` returns it,
 * `player_public_profile()` returns it, and the app renders it through
 * `describeLastSeen` — whose own doc comment says the value is "written at some
 * unstated moment in the past". It was written at exactly one moment, the
 * INSERT in `handle_new_user`, and never again. So the fallback beneath presence
 * was the account's creation date presented as a fact about when somebody was
 * last around.
 */
suite("last seen", () => {
  it("moves when the caller publishes presence, and names nobody else", async () => {
    const player = await createPlayer();
    const friend = await createPlayer();

    const before = await rpc(player, "touch_last_seen");
    expect(before.status).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    const after = await rpc(player, "touch_last_seen");
    expect(after.status).toBe(200);
    expect(Date.parse(after.body as string)).toBeGreaterThan(Date.parse(before.body as string));

    // No argument names whose row to stamp, so a modified client cannot date a
    // stranger's presence. PostgREST rejects the unknown parameter outright.
    const forged = await rpc(player, "touch_last_seen", { p_user_id: friend.id });
    expect(forged.status).toBeGreaterThanOrEqual(400);
  }, 30_000);
});

/**
 * LEAVING A TABLE THAT HAS DEALT IS ALSO LEAVING THE ROOM.
 *
 * `leave_room` derives its caller from `auth.uid()` and is the only thing that
 * ends a membership or migrates the host role — and it is reachable from the
 * LOBBY only. Once the host deals, "Leave table" sends `CASH_OUT`, which settled
 * the seat, returned the stack, and never touched `room_members`.
 *
 * Measured before the fix, with a host leaving a three-seat table the other two
 * kept playing:
 *
 *     rooms.host_user_id = the departed host   t
 *     room_members.status for them             joined
 *     the app's own restore() query            returned the room
 *     create_private_room                      400 "you already have a table open"
 *
 * So the departed player was put back into the lobby of a table they had cashed
 * out of — and from there the lobby resolves their now-`left` seat and walks
 * them to a table where every command answers SESSION_CLOSED — could not open
 * another private table until strangers finished playing, and the host role
 * never migrated at all. The specification's "if host leaves, transfer the
 * social host role to the longest-connected eligible user" held only in the
 * lobby, which is the one place a host leaving matters least.
 */
suite("a host who leaves a running table", () => {
  const iso = () => new Date().toISOString();

  it("hands the room over, keeps the game running, and is free to open another", async () => {
    const { host, guest, room } = await openRoomWithGuest(3);
    const third = await createPlayer();
    expect(asRoom(await rpc(third, "join_private_room", { p_code: room.code })).id).toBe(room.id);

    const started = await callFunction("create-session", host.token, {
      action: "START_PRIVATE_TABLE",
      clientRequestId: crypto.randomUUID(),
      roomId: room.id,
      clientSentAt: iso(),
    });
    expect(started.status).toBe(200);
    const gameId = started.body.gameId as string;
    expect((started.body.publicState as { seats: unknown[] }).seats).toHaveLength(3);

    const left = await callFunction("create-session", host.token, {
      action: "CASH_OUT",
      clientRequestId: crypto.randomUUID(),
      gameId,
      clientSentAt: iso(),
    });
    expect(left.status).toBe(200);

    // THE SHOE IS NOT DESTROYED. Two players are still at the table and the
    // session is untouched — the host owns the invite and the lobby, never the
    // dealer. `get_room_state` is readable by a remaining member, and reading it
    // as one of THEM is the only way to see the room after the host has left it.
    const seen = await readRoom(guest, room.id);
    expect(seen).toHaveLength(2);
    expect(seen.map((member) => member.member_user_id).sort()).toEqual(
      [guest.id, third.id].sort(),
    );

    // The longest-connected remaining member inherits, which is the guest.
    const nowHost = seen.find((member) => member.member_is_host);
    expect(nowHost?.member_user_id).toBe(guest.id);

    // The departed host is off the room entirely, so the app's restore query —
    // the one that decides whether to put somebody back in a lobby — is empty
    // for them. It used to return this very room.
    expect((await restQuery(host, openRoomPath())).rows).toHaveLength(0);
    const refusedRead = await rpc(host, "get_room_state", { p_room_id: room.id });
    expect(refusedRead.status).toBe(404);

    // And they may open another table immediately, rather than waiting for
    // strangers to finish.
    expect(asRoom(await rpc(host, "create_private_room", { p_max_seats: 2 })).id).not.toBe(room.id);
  }, 90_000);

  it("cannot walk back in with the same code once they have cashed out", async () => {
    const { host, room } = await openRoomWithGuest(3);
    const started = await callFunction("create-session", host.token, {
      action: "START_PRIVATE_TABLE",
      clientRequestId: crypto.randomUUID(),
      roomId: room.id,
      clientSentAt: iso(),
    });
    const gameId = started.body.gameId as string;

    await callFunction("create-session", host.token, {
      action: "CASH_OUT",
      clientRequestId: crypto.randomUUID(),
      gameId,
      clientSentAt: iso(),
    });

    // A SETTLED seat is not a reconnection. The rejoin bypass exists for a
    // player whose seat is still live; letting a cashed-out player back in as a
    // room member with no live game seat is the same stranding as a newcomer's.
    expect(refusedJoin(await rpc(host, "join_private_room", { p_code: room.code }))).toBe(true);
  }, 90_000);
});

/**
 * TWO PEOPLE TAKING THE LAST SEAT.
 *
 * `join_private_room` takes `for update` on the room before it counts the seats,
 * which is what makes "is there room" and "sit down" one decision rather than
 * two. Without the lock both callers read the same count under READ COMMITTED
 * and both insert — and the partial unique index on `(room_id, seat_index)`
 * would then turn the loser's join into a 409 naming a constraint, which is a
 * refusal that leaks and reads as a bug.
 *
 * Asserted by racing four strangers at one free seat, not by reading the lock.
 */
suite("the last seat", () => {
  it("is taken by exactly one of four simultaneous joins", async () => {
    const host = await createPlayer();
    const room = asRoom(await rpc(host, "create_private_room", { p_max_seats: 2 }));

    const contenders = await Promise.all([
      createPlayer(),
      createPlayer(),
      createPlayer(),
      createPlayer(),
    ]);
    const results = await Promise.all(
      contenders.map((player) => rpc(player, "join_private_room", { p_code: room.code })),
    );

    const seated = results.filter((result) => !refusedJoin(result));
    expect(seated).toHaveLength(1);

    // The three who missed out got the ordinary silent refusal, not an error
    // and certainly not a constraint name.
    for (const result of results) {
      expect(result.status).toBe(200);
      expect(JSON.stringify(result.body)).not.toMatch(/23505|constraint|duplicate/i);
    }

    // And the room really does hold two people, not three.
    const members = await readRoom(host, room.id);
    expect(members).toHaveLength(2);
    expect(new Set(members.map((member) => member.member_seat_index)).size).toBe(2);
  }, 60_000);
});

/**
 * THE FREE RESET A BROKE PRIVATE PLAYER IS OWED.
 *
 * The specification's rule is one sentence: *"if a private player reaches zero
 * session chips, permit a free reset to 5,000 between hands; private mode is
 * unranked."* `RESET_PRIVATE_STACK` implemented it, correctly, and **no client
 * had ever sent it** — it was the only action of the nine in the session
 * contract with no caller in `src`, `app` or `scripts`. The cost was silent: a
 * seat that cannot cover the 20-chip minimum is sat out by `openBetting`,
 * `getLegalActions` answers NO_ACTIONS for a seat that is sitting out, and the
 * table screen falls through to "Waiting for the next hand." — hand after hand,
 * for the life of the table.
 *
 * The stack is arranged in the database rather than lost at the table. Playing
 * 5,000 chips away 500 at a time against a fair dealer is a random walk with no
 * bound on how long it takes, and the thing under test is what happens ONCE a
 * seat is broke. Everything either side of the fixture goes through the real
 * HTTP boundary as the real player.
 */
suite("a private seat with nothing left", () => {
  const iso = () => new Date().toISOString();

  /** A single scalar out of the database, for a row no client may read. */
  function readDatabase(sql: string): string {
    const container = execFileSync(
      "docker",
      ["ps", "--filter", "name=supabase_db_", "--format", "{{.Names}}"],
      { encoding: "utf8" },
    )
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)[0];
    if (!container) throw new Error("no supabase_db_* container is running");
    return execFileSync(
      "docker",
      ["exec", container, "psql", "-U", "postgres", "-d", "postgres", "-tAc", sql],
      { encoding: "utf8" },
    ).trim();
  }

  async function dealtPrivateTable(): Promise<{
    host: Player;
    guest: Player;
    gameId: string;
    seatId: string;
  }> {
    const { host, guest, room } = await openRoomWithGuest(2);
    const started = await callFunction("create-session", host.token, {
      action: "START_PRIVATE_TABLE",
      clientRequestId: crypto.randomUUID(),
      roomId: room.id,
      clientSentAt: iso(),
    });
    expect(started.status).toBe(200);
    const gameId = started.body.gameId;
    const seatId = started.body.seatId;
    if (typeof gameId !== "string" || typeof seatId !== "string") {
      throw new Error(`no table: ${started.raw}`);
    }
    return { host, guest, gameId, seatId };
  }

  /**
   * Leave the seat exactly as a lost last hand leaves it: a stack below the
   * table minimum, and `sittingOut` set — which is what `openBetting` does at
   * the top of the next hand and is the state the player is actually stuck in.
   */
  function bustSeat(gameId: string, seatId: string): void {
    inDatabase(`
      update private.game_state_private g
      set engine_state = jsonb_set(
        jsonb_set(g.engine_state, array['seats', idx.n::text, 'stack'], to_jsonb(10)),
        array['seats', idx.n::text, 'sittingOut'], to_jsonb(true))
      from (
        select (s.ord - 1) as n
        from private.game_state_private inner_state,
             jsonb_array_elements(inner_state.engine_state->'seats')
               with ordinality as s(seat, ord)
        where inner_state.game_session_id = '${gameId}'
          and s.seat->>'seatId' = '${seatId}'
      ) idx
      where g.game_session_id = '${gameId}';
      update public.game_session_seats set stack = 10 where id = '${seatId}';
    `);
    // The fixture must actually have taken. A silent no-op here would turn
    // "the reset refused, correctly, because the seat was never broke" into a
    // passing test about nothing.
    expect(readDatabase(`select stack from public.game_session_seats where id = '${seatId}'`)).toBe(
      "10",
    );
  }

  async function reset(player: Player, gameId: string) {
    return await callFunction("create-session", player.token, {
      action: "RESET_PRIVATE_STACK",
      clientRequestId: crypto.randomUUID(),
      gameId,
      clientSentAt: iso(),
    });
  }

  async function walletBalance(player: Player): Promise<number> {
    // `user_id=eq.` on purpose. A read through RLS is scoped to what the POLICY
    // permits, not to "your own rows" — CLAUDE.md carries two instances of that
    // mistake, and one of them read another player's number as this one's.
    const { rows } = await restQuery(player, `wallets?select=balance&user_id=eq.${player.id}`);
    const row = rows[0] as { balance?: number } | undefined;
    if (typeof row?.balance !== "number") {
      throw new Error(`no wallet row for ${player.id}: ${JSON.stringify(rows)}`);
    }
    return row.balance;
  }

  it("puts the seat back on the table's fixed stack, and back in the game", async () => {
    const { host, gameId, seatId } = await dealtPrivateTable();
    bustSeat(gameId, seatId);

    const done = await reset(host, gameId);

    expect(done.status).toBe(200);
    expect(done.body.status).toBe("private_stack_reset");
    expect(done.body.stack).toBe(5_000);

    const state = done.body.publicState as {
      seats: Array<{ seatId: string; stack: number; sittingOut: boolean }>;
    };
    const seat = state.seats.find((candidate) => candidate.seatId === seatId);
    expect(seat?.stack).toBe(5_000);
    /*
     * REINSTATED, not merely refilled. `openBetting` clears `sittingOut` only at
     * the START of a hand, so a reset that moved chips alone would have answered
     * the player with the same "waiting" they were already looking at — the
     * chips would have been unusable until the next hand opened.
     */
    expect(seat?.sittingOut).toBe(false);

    // The public mirror agrees, which is what every other client reads.
    expect(readDatabase(`select stack from public.game_session_seats where id = '${seatId}'`)).toBe(
      "5000",
    );
  }, 60_000);

  it("takes nothing from the wallet and writes no ledger row", async () => {
    const { host, gameId, seatId } = await dealtPrivateTable();
    const before = await walletBalance(host);
    bustSeat(gameId, seatId);

    expect((await reset(host, gameId)).status).toBe(200);

    // The anti-collusion rule, from the other direction: 5,000 chips appeared
    // at the table and no wallet anywhere moved. They are the TABLE's.
    expect(await walletBalance(host)).toBe(before);
    expect(
      readDatabase(
        `select count(*) from public.wallet_ledger where user_id = '${host.id}' and reason <> 'initial_grant'`,
      ),
    ).toBe("0");
  }, 60_000);

  it("refuses a seat that can still cover the minimum", async () => {
    const { host, gameId, seatId } = await dealtPrivateTable();

    const refused = await reset(host, gameId);

    // Otherwise this is a "refill to full" button that erases every loss.
    expect(refused.status).toBe(422);
    expect(refused.body.code).toBe("ILLEGAL_ACTION");
    /*
     * Asserted on the EFFECT rather than the prose. The wire carries the public
     * wording for the CODE — "That action is not legal for this hand." — and the
     * sentence naming the minimum stays in the server's log, which is the right
     * split and means a message assertion here would be testing the code table.
     */
    expect(readDatabase(`select stack from public.game_session_seats where id = '${seatId}'`)).toBe(
      "5000",
    );
  }, 60_000);

  it("refuses a WALLET-BACKED table, where it would mint chips", async () => {
    const player = await createPlayer();
    const opened = await callFunction("create-session", player.token, {
      action: "OPEN",
      clientRequestId: crypto.randomUUID(),
      tier: "casual",
      clientSentAt: iso(),
    });
    expect(opened.status).toBe(200);
    const gameId = opened.body.gameId;
    const seatId = opened.body.seatId;
    if (typeof gameId !== "string" || typeof seatId !== "string") {
      throw new Error(`no solo table: ${opened.raw}`);
    }
    // Broke in exactly the same way, so the ONLY thing separating this case from
    // the passing one above is the session's mode.
    bustSeat(gameId, seatId);

    const refused = await reset(player, gameId);

    expect(refused.status).toBe(422);
    expect(refused.body.code).toBe("ILLEGAL_ACTION");
    // Refused on the SESSION'S OWN MODE, read from the row rather than taken
    // from the request: the seat is just as broke as the private one above and
    // the only difference is where its chips came from.
    expect(readDatabase(`select stack from public.game_session_seats where id = '${seatId}'`)).toBe(
      "10",
    );
  }, 60_000);

  it("refuses a player who is not at the table", async () => {
    const { gameId, seatId } = await dealtPrivateTable();
    bustSeat(gameId, seatId);
    const stranger = await createPlayer();

    const refused = await reset(stranger, gameId);

    expect(refused.status).toBe(403);
    expect(refused.body.code).toBe("NOT_A_PARTICIPANT");
  }, 60_000);
});
