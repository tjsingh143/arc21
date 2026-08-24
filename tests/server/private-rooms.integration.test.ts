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
    // P0002 → PostgREST 404. The point is that it is refused, not the number.
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
