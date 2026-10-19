/**
 * ONE LIVE SEAT PER PLAYER, AND A PRIVATE TABLE SEATS PEOPLE WHO DID NOT ASK.
 *
 * The C-1 repair put a per-player `seat_admission` lock in the first line of
 * `assertNoOtherLiveSeat`, so every path that seats THE CALLER is serialised
 * with every other. `START_PRIVATE_TABLE` is different in kind: the host's one
 * command seats EVERY member of the room, and it called neither the lock nor
 * the check for anybody. The Refresh C closure review reproduced it with no race
 * at all — an AI-table player who hosted a private table, or was dealt into one
 * by somebody else, held two live seats, both answered 200, and
 * `my_active_session()` named only the newer one.
 *
 * What this file holds the repair to:
 *
 *   A/B  an existing seat refuses a private deal, whoever the host is;
 *   C/D  a private seat refuses every other mode, and the other modes refuse a
 *        private deal — Quick Play's escrow and the Daily attempt included;
 *   E    the same under controlled interleavings, both orders, and between two
 *        private deals sharing a member;
 *   F    one ineligible member refuses the WHOLE deal — no session, no seat,
 *        no room change, for anybody;
 *   G    once the conflicting seat closes, the same room deals;
 *   H/I  an ordinary private table still deals, resumes, plays a hand, binds
 *        each seat to its member and touches no wallet;
 *   and two siblings found while tracing the same path: a PUBLIC room cannot be
 *   dealt as a private one, and the sprint dealer's seat-from-an-entry
 *   conversion is read in one snapshot.
 *
 *   supabase start
 *   supabase functions serve --no-verify-jwt
 */

import crypto from "node:crypto";
import { describe, expect, it } from "vitest";

import { callFunction as call } from "./call-function.js";
import { stackUp } from "./stack-guard.js";
import { holdAdmissionLock, holdPlayerAdmissions, holdTournamentEntries, sql, waitUntil, type Barrier } from "./admission-barrier.js";

const REST = "http://127.0.0.1:54321/rest/v1";
const AUTH_ADMIN = "http://127.0.0.1:54321/auth/v1/admin/users";
const LOCAL_JWT_SECRET = "super-secret-jwt-token-with-at-least-32-characters-long";
const LOCAL_SERVICE_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU";
const LOCAL_ANON_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0";

const OPENING_GRANT = 25_000;
const PRIVATE_TABLE_STACK = 5_000;

const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
const iso = () => new Date().toISOString();

/** No `iat`: PostgREST rejects one its own clock thinks is in the future. */
function signToken(sub: string): string {
  const header = b64({ alg: "HS256", typ: "JWT" });
  const payload = b64({ sub, role: "authenticated", aud: "authenticated", exp: Math.floor(Date.now() / 1000) + 3600 });
  const signature = crypto.createHmac("sha256", LOCAL_JWT_SECRET).update(`${header}.${payload}`).digest("base64url");
  return `${header}.${payload}.${signature}`;
}

interface Player {
  readonly id: string;
  readonly token: string;
}

async function createPlayer(): Promise<Player> {
  const response = await fetch(AUTH_ADMIN, {
    method: "POST",
    headers: { "Content-Type": "application/json", apikey: LOCAL_SERVICE_KEY, Authorization: `Bearer ${LOCAL_SERVICE_KEY}` },
    body: JSON.stringify({ email: `admission-${crypto.randomUUID()}@arc21.test`, password: crypto.randomUUID(), email_confirm: true }),
  });
  const json = (await response.json()) as { id?: string };
  if (!json.id) throw new Error(`could not create a test user: ${response.status}`);
  return { id: json.id, token: signToken(json.id) };
}

async function rpc(player: Player, name: string, args: unknown = {}): Promise<{ status: number; body: unknown }> {
  const response = await fetch(`${REST}/rpc/${name}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", apikey: LOCAL_ANON_KEY, Authorization: `Bearer ${player.token}` },
    body: JSON.stringify(args),
  });
  return { status: response.status, body: (await response.json()) as unknown };
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

interface Room {
  readonly id: string;
  readonly code: string;
}

/** A private lobby hosted by `host` with `members` joined, through the client's own RPCs. */
async function lobby(host: Player, members: readonly Player[]): Promise<Room> {
  const created = await rpc(host, "create_private_room", { p_max_seats: Math.max(2, members.length + 1) });
  const room = (Array.isArray(created.body) ? created.body[0] : created.body) as Room | null;
  if (created.status !== 200 || !room?.id) throw new Error(`create_private_room: ${created.status} ${JSON.stringify(created.body)}`);
  for (const member of members) {
    const joined = await rpc(member, "join_private_room", { p_code: room.code });
    const row = (Array.isArray(joined.body) ? joined.body[0] : joined.body) as { id?: string } | null;
    if (joined.status !== 200 || row?.id !== room.id) throw new Error(`join_private_room: ${joined.status} ${JSON.stringify(joined.body)}`);
  }
  return room;
}

const deal = (host: Player, roomId: string) =>
  call("create-session", host.token, { action: "START_PRIVATE_TABLE", clientRequestId: crypto.randomUUID(), roomId, clientSentAt: iso() });
const openAi = (player: Player) =>
  call("create-session", player.token, { action: "OPEN_AI_TABLE", clientRequestId: crypto.randomUUID(), clientSentAt: iso() });
const quickPlay = (player: Player) =>
  call("create-session", player.token, { action: "OPEN", clientRequestId: crypto.randomUUID(), tier: "casual", clientSentAt: iso() });
const daily = (player: Player) =>
  call("create-session", player.token, { action: "START_DAILY_CHALLENGE", clientRequestId: crypto.randomUUID(), clientSentAt: iso() });
const cashOut = (player: Player, gameId: string) =>
  call("create-session", player.token, { action: "CASH_OUT", clientRequestId: crypto.randomUUID(), gameId, clientSentAt: iso() });

/** The player's live seats as the DATABASE holds them — `mode:gameId`, sorted. Not `my_active_session()`. */
function liveSeats(player: Player): string[] {
  const rows = sql(
    `select g.mode::text || ':' || g.id from public.game_session_seats s join public.game_sessions g on g.id = s.game_session_id
     where s.user_id = '${player.id}'::uuid and s.status <> 'left' and g.status in ('lobby', 'active') order by 1`,
  );
  return rows === "" ? [] : rows.split("\n");
}

const privateSessionsHostedBy = (player: Player): string =>
  sql(`select count(*) from public.game_sessions where host_user_id = '${player.id}'::uuid and mode = 'private_table'`);

const roomRow = (roomId: string): string =>
  sql(`select status::text || '|' || coalesce(game_session_id::text, 'none') from public.rooms where id = '${roomId}'::uuid`);

/** The wallet and ledger as the player reads them, asserted against what must have happened. */
async function expectWallet(player: Player, expected: "untouched" | "one_buy_in"): Promise<void> {
  const ledger = await readAs<{ delta: number; reason: string }[]>(
    player,
    `wallet_ledger?select=delta,reason&user_id=eq.${player.id}&order=created_at.asc`,
  );
  const wallet = await readAs<{ balance: number }[]>(player, `wallets?select=balance&user_id=eq.${player.id}`);
  if (wallet.length !== 1) throw new Error(`could not read own wallet: ${JSON.stringify(wallet)}`);
  if (expected === "untouched") {
    expect(ledger.map((row) => row.reason)).toEqual(["initial_grant"]);
    expect(Number(wallet[0]!.balance)).toBe(OPENING_GRANT);
  } else {
    expect(ledger.map((row) => row.reason)).toEqual(["initial_grant", "table_buy_in"]);
    expect(Number(wallet[0]!.balance)).toBe(OPENING_GRANT + Number(ledger[1]!.delta));
  }
}

async function myActive(player: Player): Promise<string[]> {
  const rows = await readAs<{ game_session_id: string }[]>(player, "rpc/my_active_session");
  return rows.map((row) => row.game_session_id);
}

function expectRefusedSeat(answer: Awaited<ReturnType<typeof call>>): void {
  expect(answer.status).toBe(409);
  expect(answer.body.code).toBe("SESSION_ALREADY_ACTIVE");
}

const suite = stackUp ? describe : describe.skip;

// ---------------------------------------------------------------------------

suite("C-1 private admission: an existing seat refuses a private deal", () => {
  it("A — the AI player HOSTS: the deal is refused and they keep exactly their AI seat", async () => {
    const player = await createPlayer();
    const guest = await createPlayer();
    const ai = await openAi(player);
    expect(ai.status).toBe(200);
    const room = await lobby(player, [guest]);

    expectRefusedSeat(await deal(player, room.id));

    expect(liveSeats(player)).toEqual([`ai_table:${ai.body.gameId}`]);
    expect(liveSeats(guest)).toEqual([]);
    expect(privateSessionsHostedBy(player)).toBe("0");
    expect(roomRow(room.id)).toBe("lobby|none");
    expect(await myActive(player)).toEqual([ai.body.gameId]);
  }, 60_000);

  it("B — a DIFFERENT host deals the AI player in: refused, and nobody is seated", async () => {
    const player = await createPlayer();
    const host = await createPlayer();
    const ai = await openAi(player);
    expect(ai.status).toBe(200);
    const room = await lobby(host, [player]);

    expectRefusedSeat(await deal(host, room.id));

    expect(liveSeats(player)).toEqual([`ai_table:${ai.body.gameId}`]);
    expect(liveSeats(host)).toEqual([]);
    expect(privateSessionsHostedBy(host)).toBe("0");
    expect(roomRow(room.id)).toBe("lobby|none");
  }, 60_000);

  it("D — a Quick Play seat refuses the deal, and its escrow stays the only money moved", async () => {
    const player = await createPlayer();
    const host = await createPlayer();
    const quick = await quickPlay(player);
    expect(quick.status).toBe(200);
    const room = await lobby(host, [player]);

    expectRefusedSeat(await deal(host, room.id));

    expect(liveSeats(player)).toEqual([`solo:${quick.body.gameId}`]);
    expect(await myActive(player)).toEqual([quick.body.gameId]);
    await expectWallet(player, "one_buy_in");
    await expectWallet(host, "untouched");
  }, 60_000);

  it("D — a Daily attempt refuses the deal when its player hosts", async () => {
    const player = await createPlayer();
    const guest = await createPlayer();
    const attempt = await daily(player);
    expect(attempt.status).toBe(200);
    const room = await lobby(player, [guest]);

    expectRefusedSeat(await deal(player, room.id));

    expect(liveSeats(player)).toEqual([`daily_challenge:${attempt.body.gameId}`]);
    expect(liveSeats(guest)).toEqual([]);
    expect(roomRow(room.id)).toBe("lobby|none");
  }, 60_000);
});

suite("C-1 private admission: a private seat refuses every other mode", () => {
  it("C/D — AI, Quick Play and Daily are all refused to a seated private player, charging nothing", async () => {
    const host = await createPlayer();
    const player = await createPlayer();
    const room = await lobby(host, [player]);
    const dealt = await deal(host, room.id);
    expect(dealt.status).toBe(200);

    expectRefusedSeat(await openAi(player));
    expectRefusedSeat(await quickPlay(player));
    expectRefusedSeat(await daily(player));

    expect(liveSeats(player)).toEqual([`private_table:${dealt.body.gameId}`]);
    await expectWallet(player, "untouched");
  }, 60_000);
});

// ---------------------------------------------------------------------------

suite("C-1 private admission: controlled interleavings", () => {
  type Answer = Awaited<ReturnType<typeof call>>;

  /**
   * `first` is parked past its check by the player's barrier, `second` is sent
   * while it is parked, and only then does either commit. Before the repair
   * the private deal never waited for anybody's admission, so both parked AT
   * the barrier and both committed; after it, the second waits on the first's
   * admission lock and then sees its seat.
   */
  async function interleave(player: Player, first: () => Promise<Answer>, second: () => Promise<Answer>) {
    const barrier: Barrier = await holdPlayerAdmissions(player.id);
    try {
      const firstSent = first();
      await waitUntil(() => barrier.parked() >= 1, "the first admission to reach the barrier");
      const secondSent = second();
      await waitUntil(() => barrier.parked() >= 2, "the second admission to queue behind it");
      await barrier.release();
      const [firstAnswer, secondAnswer] = await Promise.all([firstSent, secondSent]);
      return { firstAnswer, secondAnswer };
    } finally {
      await barrier.release();
    }
  }

  type Other = { label: string; mode: string; send: (player: Player) => Promise<Answer>; wallet: "untouched" | "one_buy_in" };
  const others: Other[] = [
    { label: "AI table", mode: "ai_table", send: openAi, wallet: "untouched" },
    { label: "Quick Play", mode: "solo", send: quickPlay, wallet: "one_buy_in" },
    { label: "Daily", mode: "daily_challenge", send: daily, wallet: "untouched" },
  ];

  for (const other of others) {
    it(`${other.label} first, then a private deal by another host: the deal is refused`, async () => {
      const player = await createPlayer();
      const host = await createPlayer();
      const room = await lobby(host, [player]);

      const { firstAnswer, secondAnswer } = await interleave(player, () => other.send(player), () => deal(host, room.id));

      expect(firstAnswer.status).toBe(200);
      expectRefusedSeat(secondAnswer);
      expect(liveSeats(player)).toEqual([`${other.mode}:${firstAnswer.body.gameId}`]);
      expect(liveSeats(host)).toEqual([]);
      expect(privateSessionsHostedBy(host)).toBe("0");
      expect(roomRow(room.id)).toBe("lobby|none");
      await expectWallet(player, other.wallet);
    }, 120_000);

    it(`a private deal first, then ${other.label}: the ${other.label} admission is refused`, async () => {
      const player = await createPlayer();
      const host = await createPlayer();
      const room = await lobby(host, [player]);

      const { firstAnswer, secondAnswer } = await interleave(player, () => deal(host, room.id), () => other.send(player));

      expect(firstAnswer.status).toBe(200);
      expectRefusedSeat(secondAnswer);
      expect(liveSeats(player)).toEqual([`private_table:${firstAnswer.body.gameId}`]);
      expect(await myActive(player)).toEqual([firstAnswer.body.gameId]);
      await expectWallet(player, "untouched");
    }, 120_000);
  }

  it("two private deals sharing a member: one table, the other room untouched", async () => {
    const shared = await createPlayer();
    const [hostOne, hostTwo] = [await createPlayer(), await createPlayer()];
    const roomOne = await lobby(hostOne, [shared]);
    const roomTwo = await lobby(hostTwo, [shared]);

    const { firstAnswer, secondAnswer } = await interleave(shared, () => deal(hostOne, roomOne.id), () => deal(hostTwo, roomTwo.id));

    expect(firstAnswer.status).toBe(200);
    expectRefusedSeat(secondAnswer);
    expect(liveSeats(shared)).toEqual([`private_table:${firstAnswer.body.gameId}`]);
    expect(liveSeats(hostTwo)).toEqual([]);
    expect(roomRow(roomTwo.id)).toBe("lobby|none");
  }, 120_000);

  /**
   * THE LOCK ORDER, made deterministic. Two rooms share members `x` and `y`,
   * seated `[x, y]` in one and `[y, x]` in the other. A controller holds `x`'s
   * admission lock; the first deal queues on it, then the second. Locking in
   * SEAT order, the second would hold `y` while waiting for `x`, the first would
   * be granted `x` and wait for `y`, and Postgres would abort one as a deadlock
   * (HTTP 500). In the one global order both ask for the shared keys in the same
   * sequence, so the second simply queues behind the first and is refused.
   */
  it("opposite seat orders cannot deadlock: the second deal queues and is refused", async () => {
    const [x, y] = [await createPlayer(), await createPlayer()];
    const [hostOne, hostTwo] = [await createPlayer(), await createPlayer()];
    const roomOne = await lobby(hostOne, [x, y]);
    const roomTwo = await lobby(hostTwo, [y, x]);

    const barrier = await holdAdmissionLock(x.id);
    let answers: Answer[];
    try {
      const first = deal(hostOne, roomOne.id);
      await waitUntil(() => barrier.parked() >= 1, "the first deal to queue on x");
      const second = deal(hostTwo, roomTwo.id);
      await waitUntil(() => barrier.parked() >= 2, "the second deal to queue");
      await barrier.release();
      answers = await Promise.all([first, second]);
    } finally {
      await barrier.release();
    }

    expect(answers.map((answer) => answer.status)).toEqual([200, 409]);
    expect(answers[1]!.body.code).toBe("SESSION_ALREADY_ACTIVE");
    for (const player of [x, y]) expect(liveSeats(player)).toEqual([`private_table:${answers[0]!.body.gameId}`]);
    expect(roomRow(roomTwo.id)).toBe("lobby|none");
  }, 120_000);

  /**
   * Free-running, with two members held in common and listed in OPPOSITE seat
   * order by the two rooms. Locks are taken in one global order whatever the
   * room's order, so this can never deadlock — which would surface as a 500 —
   * and exactly one of the two deals can win.
   */
  it("overlapping three-seat deals sent together, five times: one winner, no 500, nobody seated twice", async () => {
    for (let trial = 0; trial < 5; trial += 1) {
      const [a, b] = [await createPlayer(), await createPlayer()];
      const [hostOne, hostTwo] = [await createPlayer(), await createPlayer()];
      const roomOne = await lobby(hostOne, [a, b]);
      const roomTwo = await lobby(hostTwo, [b, a]);

      const answers = await Promise.all(
        trial % 2 === 0 ? [deal(hostOne, roomOne.id), deal(hostTwo, roomTwo.id)] : [deal(hostTwo, roomTwo.id), deal(hostOne, roomOne.id)],
      );
      expect(answers.map((answer) => answer.status).sort()).toEqual([200, 409]);
      expect(answers.find((answer) => answer.status === 409)?.body.code).toBe("SESSION_ALREADY_ACTIVE");
      for (const player of [a, b]) expect(liveSeats(player)).toHaveLength(1);
      expect(liveSeats(hostOne).length + liveSeats(hostTwo).length).toBe(1);
    }
  }, 240_000);
});

// ---------------------------------------------------------------------------

suite("C-1 private admission: all or nothing, then recovery", () => {
  it("F — one ineligible member refuses the WHOLE deal; G — once they leave, the same room deals", async () => {
    const host = await createPlayer();
    const eligible = await createPlayer();
    const busy = await createPlayer();
    const ai = await openAi(busy);
    expect(ai.status).toBe(200);
    const aiVersion = sql(`select version from private.game_state_private where game_session_id = '${ai.body.gameId}'::uuid`);
    const room = await lobby(host, [eligible, busy]);

    expectRefusedSeat(await deal(host, room.id));

    // Nothing partial survived: no session, no seat, no room change, no money.
    expect(privateSessionsHostedBy(host)).toBe("0");
    expect(liveSeats(host)).toEqual([]);
    expect(liveSeats(eligible)).toEqual([]);
    expect(roomRow(room.id)).toBe("lobby|none");
    await expectWallet(host, "untouched");
    await expectWallet(eligible, "untouched");
    // And the busy member's own table was not touched by the refusal.
    expect(liveSeats(busy)).toEqual([`ai_table:${ai.body.gameId}`]);
    expect(sql(`select version from private.game_state_private where game_session_id = '${ai.body.gameId}'::uuid`)).toBe(aiVersion);

    // G: the conflicting seat closes legitimately, and the very same room deals.
    expect((await cashOut(busy, ai.body.gameId as string)).status).toBe(200);
    expect(liveSeats(busy)).toEqual([]);
    const dealt = await deal(host, room.id);
    expect(dealt.status).toBe(200);
    for (const player of [host, eligible, busy]) {
      expect(liveSeats(player)).toEqual([`private_table:${dealt.body.gameId}`]);
    }
  }, 120_000);
});

suite("C-1 private admission: an ordinary private table is unchanged", () => {
  it("H/I — deals, resumes for host and member, binds each seat to its member, plays a hand, moves no chips", async () => {
    const host = await createPlayer();
    const members = [await createPlayer(), await createPlayer()];
    const room = await lobby(host, members);
    const everyone = [host, ...members];

    // Before the deal only the host may deal, and a stranger is no participant.
    const stranger = await createPlayer();
    expect((await deal(stranger, room.id)).status).toBe(403);
    expect((await deal(members[0]!, room.id)).status).toBe(403);
    expect(roomRow(room.id)).toBe("lobby|none");

    const dealt = await deal(host, room.id);
    expect(dealt.status).toBe(200);
    const gameId = dealt.body.gameId as string;

    // A retry by the host and a late tap by a member land on the SAME game.
    const again = await deal(host, room.id);
    const late = await deal(members[0]!, room.id);
    expect([again.status, late.status]).toEqual([200, 200]);
    expect([again.body.gameId, late.body.gameId]).toEqual([gameId, gameId]);
    expect(late.body.seatId).not.toBe(dealt.body.seatId);

    // I: one seat per member, owned by that member, on the table's own stack.
    const seats = sql(
      `select user_id || '|' || stack || '|' || buy_in || '|' || status from public.game_session_seats
       where game_session_id = '${gameId}'::uuid order by user_id`,
    ).split("\n");
    expect(seats).toEqual(
      everyone.map((player) => player.id).sort().map((id) => `${id}|${PRIVATE_TABLE_STACK}|0|active`),
    );
    expect(sql(`select escrow_chips || '|' || host_user_id from public.game_sessions where id = '${gameId}'::uuid`)).toBe(`0|${host.id}`);
    for (const player of everyone) {
      expect(liveSeats(player)).toEqual([`private_table:${gameId}`]);
      expect(await myActive(player)).toEqual([gameId]);
    }

    // The hand progresses: every seat bets and locks through its own JWT.
    let state = dealt.body.publicState as { version: number; phase: string; seats: { seatId: string; userId: string | null }[] };
    for (const player of everyone) {
      const seatId = state.seats.find((seat) => seat.userId === player.id)?.seatId;
      expect(seatId).toBeDefined();
      for (const [type, payload] of [["PLACE_BET", { amount: 100 }], ["LOCK_BET", undefined]] as const) {
        const answer = await call("game-command", player.token, {
          gameId,
          clientActionId: crypto.randomUUID(),
          type,
          ...(payload ? { payload } : {}),
          expectedVersion: state.version,
          clientSentAt: iso(),
        });
        expect(answer.status).toBe(200);
        state = answer.body.publicState as typeof state;
      }
    }
    // Betting closes on the LAST lock and the cascade stops in one of three places.
    expect(["PLAYER_TURNS", "INSURANCE_OFFER", "HAND_COMPLETE"]).toContain(state.phase);

    // No wallet was touched by dealing or playing — a private table is a closed economy.
    for (const player of everyone) await expectWallet(player, "untouched");
  }, 120_000);
});

// ---------------------------------------------------------------------------

suite("C-1 private admission: siblings on the same path", () => {
  /**
   * `joinPublicTable` reads its room `where mode = 'public_table'`, and
   * `startPrivateTable` read its room by id alone. A matched public room has
   * `joined` members and no game until somebody buys in, so whoever the queue
   * made its host could deal it as a PRIVATE table and seat a matched stranger
   * there — reproduced against the running stack before the repair (200, a
   * `private_table` session, the stranger seated). The room is a fixture here
   * because the queue's allocation is global and shared with other files —
   * and it is FULL, so the queue can never hand it to anybody else's test.
   *
   * WORSE THAN A STRANGER SEATED. The dealt room stayed `public_table` and
   * `active` while pointing at a `private_table` game, so the queue could hand
   * any free seat in it to the next player: `JOIN_PUBLIC_TABLE` debited their
   * 2,000 into that game and `CASH_OUT` — correctly reading the SESSION's mode —
   * returned 0. Measured by accident during this repair: a pre-repair probe room
   * with free seats was allocated to `game-command.integration.test.ts`, which
   * failed `expected +0 to be 2000`. Hence the full room, and the `finally`.
   */
  it("a PUBLIC room cannot be dealt as a private table", async () => {
    const host = await createPlayer();
    const stranger = await createPlayer();
    const roomId = crypto.randomUUID();
    sql(
      `insert into public.rooms (id, code, host_user_id, visibility, mode, max_seats, status, tier, expires_at)
       values ('${roomId}', 'Q' || upper(substr(md5(random()::text), 1, 5)), '${host.id}', 'public', 'public_table', 2, 'lobby', 'casual', now() + interval '10 minutes');
       insert into public.room_members (room_id, user_id, seat_index, status)
       values ('${roomId}', '${host.id}', 0, 'joined'), ('${roomId}', '${stranger.id}', 1, 'joined');`,
    );

    try {
      const answer = await deal(host, roomId);

      expect(answer.status).toBe(403);
      expect(answer.body.code).toBe("NOT_A_PARTICIPANT");
      expect(roomRow(roomId)).toBe("lobby|none");
      expect(liveSeats(host)).toEqual([]);
      expect(liveSeats(stranger)).toEqual([]);
    } finally {
      // Whatever happened, the fixture must never be offered to the queue.
      sql(`update public.rooms set status = 'closed' where id = '${roomId}'::uuid`);
    }
  }, 60_000);

  /**
   * THE SPRINT DEALER SEATS A WHOLE FIELD, and each entrant was admitted when
   * they registered. What protects them afterwards is that a PENDING entry
   * counts as a seat — and the seat check read seats and pending entries in two
   * statements, each with its own READ COMMITTED snapshot. A deal committed
   * between them turned an entry into a seat the first read had not seen and
   * the second no longer counted, so the check passed for a player who now held
   * a tournament seat.
   *
   * Made deterministic: a controller holds `tournament_entries` exclusively,
   * the AI open parks on the entries read, the controller commits the dealer's
   * effect (session, seat, tournament running, entries active) and releases.
   * A probe tournament, outside the `sprint-%` pool so no registration can
   * land in it.
   */
  it("a sprint entry dealt into a seat mid-check is still seen: the second admission is refused", async () => {
    const player = await createPlayer();
    const tournamentId = crypto.randomUUID();
    const gameId = crypto.randomUUID();
    sql(
      `insert into public.tournaments
         (id, code, name, format, status, ruleset_id, tier, entry_fee_chips, starting_chips, min_entries, max_entries,
          registration_opens_at, starts_at)
       select '${tournamentId}', 'admission-probe-' || substr(md5(random()::text), 1, 10), 'Admission probe', 'leaderboard',
              'registering', id, 'standard', 0, 10000, 4, 4, now(), now()
       from public.rulesets where is_active order by created_at desc limit 1;
       insert into public.tournament_entries (tournament_id, user_id, status, bracket_seed)
       values ('${tournamentId}', '${player.id}', 'registered', 1);`,
    );
    // The entry alone already refuses a new seat — the half that always held.
    expectRefusedSeat(await openAi(player));

    const barrier = await holdTournamentEntries();
    let answer: Awaited<ReturnType<typeof call>> | undefined;
    try {
      const sent = openAi(player);
      await waitUntil(() => barrier.parked() >= 1, "the AI open to park on the entries read");
      await barrier.release(
        `insert into public.game_sessions (id, mode, ruleset_id, tournament_id, host_user_id, status, max_seats, escrow_chips, started_at)
         select '${gameId}', 'tournament', ruleset_id, '${tournamentId}', '${player.id}', 'active', 4, 0, now()
         from public.tournaments where id = '${tournamentId}';
         insert into public.game_session_seats (game_session_id, seat_index, user_id, display_name, stack, buy_in, status)
         values ('${gameId}', 0, '${player.id}', 'Probe', 10000, 0, 'active');
         update public.tournaments set status = 'running' where id = '${tournamentId}';
         update public.tournament_entries set status = 'active' where tournament_id = '${tournamentId}';`,
      );
      answer = await sent;

      expectRefusedSeat(answer);
      expect(liveSeats(player)).toEqual([`tournament:${gameId}`]);
    } finally {
      await barrier.release();
      // Retire the fixture whatever happened: it has no engine state, and
      // nothing should find it.
      sql(
        `update public.game_session_seats set status = 'left', left_at = now() where game_session_id = '${gameId}'::uuid;
         update public.game_sessions set status = 'completed', ended_at = now() where id = '${gameId}'::uuid;
         update public.tournaments set status = 'cancelled' where id = '${tournamentId}'::uuid;`,
      );
    }
  }, 60_000);
});
