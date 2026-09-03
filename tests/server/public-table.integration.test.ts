/**
 * PUBLIC TABLES, END TO END, AGAINST THE REAL STACK.
 *
 * Everything below runs through calls a shipped client can make: the two
 * matchmaking RPCs, `create-session` and `game-command`, with a real JWT per
 * account. Nothing is inserted by the service role — `public.rooms`,
 * `room_members`, `game_sessions` and `game_session_seats` carry no write grant
 * to it at all — so a fixture that could not be produced by playing is not
 * available here, which is the point.
 *
 * WHY THIS FILE EXISTS. Public multiplayer was built, typechecked and covered
 * by unit tests, and two people could not sit at the same table. Measured with
 * two real accounts before a line of the fix was written:
 *
 *     A join_matchmaking  200
 *     A poll              matched, room 4285219d-…   (lobby)
 *     A JOIN_PUBLIC_TABLE 200  buyIn 2000             (room -> active)
 *     B join_matchmaking  200
 *     B poll              matched, room e67e20e4-…   <- a different table
 *
 * `poll_matchmaking` considered only rooms at `status = 'lobby'` and the buy-in
 * sets a room to `active`. So the ordinary sequence — queue, tap "Take the
 * seat", and somebody else queues ten seconds later — allocated a brand new
 * table every time, and the specification's mid-shoe join (a seat appended to a
 * live engine state, dealt in at the next BETTING_OPEN) was code no allocation
 * could reach. A "public table" was a solo table with a queue in front of it.
 *
 * Nothing in the build noticed, and that is the shape this repository keeps
 * finding: `tests/server` reached `JOIN_PUBLIC_TABLE` by handing it a room id,
 * so the handler was well covered and the path to it was not tested at all.
 * Every test here therefore GOES THROUGH THE QUEUE.
 *
 * ISOLATION IS RELATIONAL, NOT ABSOLUTE. Allocation is global by design — the
 * point of a queue is that strangers share a table — so assertions here are
 * about this file's own accounts, its own wallets and its own seats, never
 * about how many rooms the database happens to hold. The same rule that keeps
 * `15_matchmaking.test.sql` from failing on a dirty database.
 *
 *   supabase start
 *   supabase functions serve --no-verify-jwt
 */

import crypto from "node:crypto";
import { describe, expect, it } from "vitest";

import { callFunction as call } from "./call-function.js";
import { matchEachIntoAPublicRoom, matchIntoAPublicRoom, type PublicTier } from "./public-seat.js";
import { stackUp } from "./stack-guard.js";

const REST = "http://127.0.0.1:54321/rest/v1";
const AUTH_ADMIN = "http://127.0.0.1:54321/auth/v1/admin/users";

/** Published local-development keys. Identical on every machine, useless elsewhere. */
const LOCAL_JWT_SECRET = "super-secret-jwt-token-with-at-least-32-characters-long";
const LOCAL_SERVICE_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU";
const LOCAL_ANON_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0";

const OPENING_GRANT = 25_000;
const CASUAL = { buyIn: 2_000, minBet: 20, maxBet: 500 } as const;
const MAX_SEATS = 5;

const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
const iso = () => new Date().toISOString();

/**
 * No `iat`, deliberately — the same reasoning as every other signer here.
 *
 * PostgREST validates `iat` against its own clock and answers
 * `PGRST303 "JWT issued at future"` when the host is ahead of the container,
 * and that failure does not look like a clock problem: it looks like a wallet
 * reading -1 or a seat that was never created. `iat` is optional and nothing in
 * this app reads it, so omitting it removes the failure mode rather than
 * narrowing it.
 */
function signToken(sub: string, secondsValid = 3600): string {
  const header = b64({ alg: "HS256", typ: "JWT" });
  const payload = b64({
    sub,
    role: "authenticated",
    aud: "authenticated",
    /*
     * `secondsValid` exists so a SECOND device can hold a genuinely different
     * token for the same account. Without it this signer is deterministic to
     * the second — no `iat`, and `exp` at whole-second granularity — so two
     * calls in the same tick return byte-identical strings, and a test meaning
     * to prove two independent sessions would have proved one.
     */
    exp: Math.floor(Date.now() / 1000) + secondsValid,
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
      email: `public-${crypto.randomUUID()}@arc21.test`,
      password: crypto.randomUUID(),
      email_confirm: true,
    }),
  });
  const json = (await response.json()) as { id?: string };
  if (!json.id) throw new Error(`could not create a test account: ${response.status}`);
  return { id: json.id, token: signToken(json.id) };
}

async function rpc(
  token: string,
  name: string,
  args: Record<string, unknown> = {},
): Promise<{ status: number; body: unknown }> {
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

/**
 * Read as the PLAYER, never as the service role.
 *
 * Not a stylistic preference: `wallets`, `game_sessions` and
 * `game_session_seats` carry no grant to `service_role`, because chip writes are
 * server-only and the only client that may read a wallet is its owner. So every
 * assertion below goes through the same RLS the app does, and is evidence about
 * the shipped policy as well as about the number.
 */
async function readAs(token: string, path: string): Promise<unknown> {
  const response = await fetch(`${REST}/${path}`, {
    headers: { apikey: LOCAL_ANON_KEY, Authorization: `Bearer ${token}` },
  });
  return (await response.json()) as unknown;
}

/** THROWS when it cannot read. A sentinel here turns a harness fault into a lie. */
async function balanceOf(player: Player): Promise<number> {
  const rows = (await readAs(player.token, "wallets?select=balance")) as {
    balance: number;
  }[];
  if (!Array.isArray(rows) || rows.length !== 1) {
    throw new Error(`could not read a wallet: ${JSON.stringify(rows)}`);
  }
  return Number(rows[0]?.balance);
}

interface LedgerRow {
  delta: number;
  reason: string;
  reference_id: string | null;
}

async function ledgerOf(player: Player): Promise<LedgerRow[]> {
  const rows = (await readAs(
    player.token,
    "wallet_ledger?select=delta,reason,reference_id&order=created_at.asc",
  )) as LedgerRow[];
  if (!Array.isArray(rows)) throw new Error(`could not read a ledger: ${JSON.stringify(rows)}`);
  return rows;
}

/**
 * The seats THIS player holds. `user_id=eq.` is load-bearing.
 *
 * `game_session_seats_select_participant` correctly shows a participant every
 * seat at a table they are sitting at, so the unfiltered query returns the whole
 * table — which once reported two seats for one player the moment a second
 * account was matched into the same public room, and read exactly like a double
 * buy-in. A read through RLS is scoped to what the policy permits, not to "your
 * own rows".
 */
async function seatsOf(player: Player): Promise<{ game_session_id: string; status: string }[]> {
  const rows = (await readAs(
    player.token,
    `game_session_seats?select=game_session_id,status&user_id=eq.${player.id}`,
  )) as { game_session_id: string; status: string }[];
  if (!Array.isArray(rows)) throw new Error(`could not read seats: ${JSON.stringify(rows)}`);
  return rows;
}

/**
 * A card as a client sees it.
 *
 * `id` is the PHYSICAL card — `d4-10C` is the ten of clubs from the fifth deck
 * — and it is the only field that distinguishes the six aces of spades a
 * six-deck shoe holds. `Card`'s own doc comment in `shared/blackjack/types.ts`
 * says never to infer identity from rank and suit; a test that did failed one
 * run in three.
 */
interface VisibleCard {
  id: string;
  rank: string;
  suit: string;
}

interface PublicSeat {
  seatId: string;
  userId: string;
  displayName: string;
  stack: number;
  originalBet: number;
  betLocked: boolean;
  sittingOut: boolean;
  connected: boolean;
  hands: { handId: string; wager: number; cards: VisibleCard[] }[];
}

interface PublicState {
  gameId: string;
  version: number;
  phase: string;
  handNumber: number;
  seats: PublicSeat[];
  dealer: {
    cards: (VisibleCard | { hidden: true })[];
    holeCardRevealed: boolean;
  };
  activeSeatId: string | null;
  deadlineAt: string | null;
  shoe: { shuffleNumber: number; approximateRemainingDecks?: number };
  legalActions: Record<
    string,
    {
      actions: string[];
      canPlaceBet: boolean;
      canLockBet: boolean;
      canDeclineInsurance: boolean;
    }
  >;
}

interface Seated {
  readonly player: Player;
  readonly gameId: string;
  readonly seatId: string;
  readonly roomId: string;
}

/** One game command, as the app sends it. */
async function command(
  player: Player,
  gameId: string,
  type: string,
  expectedVersion: number,
  payload: Record<string, unknown> = {},
  clientActionId: string = crypto.randomUUID(),
) {
  return await call("game-command", player.token, {
    gameId,
    clientActionId,
    type,
    payload,
    expectedVersion,
    clientSentAt: iso(),
  });
}

/**
 * The authoritative snapshot, exactly as the app asks for one.
 *
 * `RESOLVE_TIMEOUT` pinned to version 0 can never apply, so the server answers
 * `stale` with the current state — which is what `snapshot()` in
 * `online-table-gateway.ts` does, and using anything else here would test a
 * path no client takes.
 */
async function snapshot(player: Player, gameId: string): Promise<PublicState> {
  const result = await command(player, gameId, "RESOLVE_TIMEOUT", 0);
  const state = result.body.publicState as PublicState | undefined;
  if (!state) {
    throw new Error(`no snapshot for ${gameId}: HTTP ${result.status} ${result.raw.slice(0, 300)}`);
  }
  return state;
}

/** Buys the matched seat. Throws with the server's own words when refused. */
async function takeSeat(player: Player, roomId: string): Promise<Seated> {
  const taken = await call("create-session", player.token, {
    action: "JOIN_PUBLIC_TABLE",
    clientRequestId: crypto.randomUUID(),
    roomId,
    clientSentAt: iso(),
  });
  if (taken.status !== 200) {
    throw new Error(`JOIN_PUBLIC_TABLE was refused: ${taken.status} ${taken.raw.slice(0, 300)}`);
  }
  return {
    player,
    roomId,
    gameId: taken.body.gameId as string,
    seatId: taken.body.seatId as string,
  };
}

/**
 * Queue, match and buy in for every player, and hand back a table of exactly
 * these seats.
 *
 * THE RETRY IS THE POINT, and it is not a flake allowance. Allocation is global
 * — a public table takes players for as long as it has room, which is the whole
 * of what phase 7 fixed — so an attempt can legitimately land these accounts at
 * a table somebody else is already playing at, and an assertion about "the two
 * seats at this table" would then be about three or four. A contaminated
 * attempt is ABANDONED RATHER THAN CASHED OUT on purpose: the seats it bought
 * stay at that table, which is what stops the next attempt being allocated to
 * it, so this converges instead of looping. The accounts are throwaway and the
 * chips are virtual.
 *
 * A test that needs an isolated table therefore gets one, and it gets it by
 * playing rather than by writing a fixture the service role has no grant to
 * write.
 */
async function openPublicTable(count: number, tier: PublicTier = "casual"): Promise<Seated[]> {
  let lastProblem: unknown = null;

  for (let attempt = 0; attempt < 8; attempt += 1) {
    const players: Player[] = [];
    for (let i = 0; i < count; i += 1) players.push(await createPlayer());

    let roomId: string;
    try {
      const rooms = await matchEachIntoAPublicRoom(
        rpc,
        players.map((p) => p.token),
        tier,
        async () => (await createPlayer()).token,
      );
      const distinct = new Set(rooms);
      if (distinct.size !== 1) {
        // A contended tier split them: the oldest table had one seat free and
        // the first player took it. The memberships stay where they are,
        // filling those tables, so the next attempt sees fewer of them.
        throw new Error(
          `matchmaking split ${players.length} players across ${distinct.size} tables`,
        );
      }
      roomId = rooms[0] as string;
    } catch (error) {
      lastProblem = error;
      continue;
    }

    const seated: Seated[] = [];
    try {
      for (const player of players) seated.push(await takeSeat(player, roomId));
    } catch (error) {
      lastProblem = error;
      continue;
    }

    const games = new Set(seated.map((s) => s.gameId));
    if (games.size !== 1) throw new Error(`one room produced ${games.size} games`);

    const state = await snapshot(seated[0]!.player, seated[0]!.gameId);
    if (state.seats.length === count) return seated;

    lastProblem = new Error(
      `landed at a table already holding ${state.seats.length - count} other seats`,
    );
  }

  throw new Error(`could not open a table of ${count} at ${tier}: ${String(lastProblem)}`);
}

/**
 * Everybody leaves, so the table closes and the next test cannot inherit it.
 *
 * Not tidiness: a public table keeps taking players while it has room, so a
 * table this file leaves open is a table the next allocation may hand to
 * somebody else's test. Cash-out is refused while a wager is committed, so a
 * busy table is stood out first — the same order a player takes.
 */
async function closeTable(seats: Seated[]): Promise<void> {
  const remaining = [...seats];
  while (remaining.length > 0) {
    const seat = remaining[0] as Seated;
    let out = await cashOut(seat);
    if (out.status === 409) {
      await standToSettlement(remaining);
      out = await cashOut(seat);
    }
    remaining.shift();
  }
}

function seatOf(state: PublicState, seat: Seated): PublicSeat {
  const found = state.seats.find((candidate) => candidate.seatId === seat.seatId);
  if (!found) throw new Error(`seat ${seat.seatId} is not in the snapshot at ${state.phase}`);
  return found;
}

/** Places and locks a bet for one seat, at whatever version the server holds. */
async function bet(seat: Seated, amount: number): Promise<PublicState> {
  const before = await snapshot(seat.player, seat.gameId);
  const placed = await command(seat.player, seat.gameId, "PLACE_BET", before.version, { amount });
  if (placed.status !== 200) {
    throw new Error(`PLACE_BET(${amount}) refused at ${before.phase}: ${placed.raw.slice(0, 300)}`);
  }
  const version = (placed.body.publicState as PublicState).version;
  const locked = await command(seat.player, seat.gameId, "LOCK_BET", version);
  if (locked.status !== 200) {
    throw new Error(`LOCK_BET refused: ${locked.raw.slice(0, 300)}`);
  }
  return locked.body.publicState as PublicState;
}

/**
 * Every seat bets, and the table is driven to PLAYER_TURNS.
 *
 * THE CASCADE AFTER BETTING CLOSES STOPS IN THREE PLACES, and assuming two of
 * them is a documented source of intermittents in this repository: PLAYER_TURNS,
 * HAND_COMPLETE on a natural, and INSURANCE_OFFER whenever the dealer shows an
 * ace — about one hand in thirteen. The offer is answered the way an absent
 * player's clock would answer it, and a natural is dealt past.
 */
async function dealAHand(seats: Seated[], amount = 100): Promise<PublicState> {
  // Twenty-four rather than twelve, because an attempt is now also spent on a
  // hand this file did not get to play: a betting window that closed while the
  // bets were going in, or one a stranger left open past its deadline. Naturals
  // alone would never need this many.
  for (let attempt = 0; attempt < 24; attempt += 1) {
    /*
     * THE ENGINE PARKS AT HAND_COMPLETE BY DESIGN, so a settlement is never
     * animated over, and it expects the caller to advance. Starting a hand from
     * there without saying so is how every online table in this project once
     * stopped after hand one.
     */
    const opening = await snapshot(seats[0]!.player, seats[0]!.gameId);
    if (opening.phase === "HAND_COMPLETE") {
      const advanced = await command(
        seats[0]!.player,
        seats[0]!.gameId,
        "NEXT_HAND",
        opening.version,
      );
      if (advanced.status !== 200) {
        throw new Error(`could not open betting from HAND_COMPLETE: ${advanced.raw.slice(0, 300)}`);
      }
    }

    /*
     * A BET IS READ-THEN-ACT, and at a shared table the phase can move between
     * the two: `bet` takes a snapshot to learn the version, and by the time the
     * command lands the betting deadline may have closed the round. The server
     * answers WRONG_PHASE or ILLEGAL_ACTION, which is correct, and the right
     * response is the one this loop already exists to make — go round and try
     * the next window. Anything else is rethrown, so a genuine refusal still
     * fails the test rather than spinning twelve times.
     */
    let raced = false;
    for (const seat of seats) {
      try {
        await bet(seat, amount);
      } catch (problem) {
        const message = problem instanceof Error ? problem.message : String(problem);
        if (!/WRONG_PHASE|ILLEGAL_ACTION/.test(message)) throw problem;
        raced = true;
        break;
      }
    }
    if (raced) continue;

    let state = await snapshot(seats[0]!.player, seats[0]!.gameId);

    /*
     * A PUBLIC TABLE IS NOT THIS FILE'S TABLE, and betting closes on the LAST
     * seat to lock rather than the first — deliberately, because closing on the
     * first is a defect this project has already fixed and written down. So a
     * stranger matched into this table after `openPublicTable` returned leaves
     * betting OPEN once every one of OUR seats has locked, and what ends it is
     * the betting DEADLINE (15 s), not the predicate.
     *
     * Snapshotting is how the app itself asks: `snapshot()` sends
     * `RESOLVE_TIMEOUT`, which the server acts on once the deadline has passed.
     * So this waits the stranger out through the product's own clock rather
     * than through anything test-only. Same lesson as `standEveryHandOut`
     * below, which already carries it.
     *
     * Reproduced deliberately rather than retried: seating a stranger into the
     * casual pool every 1.2 s for the length of the run gave
     * `betting closed into BETTING_OPEN, which is not one of the three`.
     */
    for (let waited = 0; waited < 25 && state.phase === "BETTING_OPEN"; waited += 1) {
      await new Promise((resolve) => setTimeout(resolve, 1_000));
      state = await snapshot(seats[0]!.player, seats[0]!.gameId);
    }

    if (state.phase === "INSURANCE_OFFER") {
      for (const seat of seats) {
        const current = await snapshot(seat.player, seat.gameId);
        if (current.legalActions[seat.seatId]?.canDeclineInsurance) {
          await command(seat.player, seat.gameId, "DECLINE_INSURANCE", current.version);
        }
      }
      state = await snapshot(seats[0]!.player, seats[0]!.gameId);
    }

    if (state.phase === "PLAYER_TURNS") return state;

    /*
     * STILL OPEN AFTER THE DEADLINE SHOULD HAVE PASSED, which happens when a
     * table is taking new players faster than a hand takes to play: each
     * arrival opens the next betting window and there is always somebody who
     * has not bet. That is the product working, so this goes round the outer
     * loop and bets again rather than throwing — the loop's own twelve-attempt
     * guard still bounds it, and the message below still names any phase that
     * is genuinely unexpected.
     */
    if (state.phase === "BETTING_OPEN") continue;

    if (state.phase !== "HAND_COMPLETE") {
      throw new Error(`betting closed into ${state.phase}, which is not one of the three`);
    }
    // A natural, the player's or the dealer's, settled inside the same cascade.
    const next = await command(seats[0]!.player, seats[0]!.gameId, "NEXT_HAND", state.version);
    if (next.status !== 200) {
      throw new Error(`could not deal again from HAND_COMPLETE: ${next.raw.slice(0, 300)}`);
    }
  }
  throw new Error(
    "twenty-four attempts and never reached PLAYER_TURNS: either the shoe is not " +
      "fair, or this table is taking new players faster than a hand takes to play",
  );
}

/**
 * Stands every hand out until the dealer has resolved the round.
 *
 * A PUBLIC TABLE IS NOT THIS FILE'S TABLE. Allocation is global, CI runs two
 * server files at once, and a public room keeps taking players while it has
 * room — so a seat this suite never created can legitimately be the one being
 * waited on. The first version threw "the active seat X is not one of ours"
 * there, which failed one run in a handful and read as a product defect. It is
 * the same lesson `public-seat.ts` records one layer up, and the same lesson as
 * the RLS-scoped reads: a shared database means assertions have to be
 * relational, and helpers have to cope with somebody else being at the table.
 *
 * A stranger's turn is waited out the way the app waits one out: a public table
 * carries clocks, and any connected client may ask the server to resolve an
 * expired deadline. `snapshot` sends exactly that request, so the loop's own
 * next pass advances the table — and if the deadline has not passed yet, the
 * server refuses and the pass after it tries again.
 */
async function standToSettlement(seats: Seated[]): Promise<PublicState> {
  for (let guard = 0; guard < 60; guard += 1) {
    const state = await snapshot(seats[0]!.player, seats[0]!.gameId);
    if (state.phase === "HAND_COMPLETE" || state.phase === "SESSION_COMPLETE") return state;

    /*
     * A DEALER ACE, which is about one hand in thirteen. The cascade after
     * betting closes stops in THREE places and this helper knew two of them —
     * the same assumption `CLAUDE.md` records costing a phase of "unreproduced,
     * not diagnosed", made here in a third helper. `npm run test:server` threw
     * `unexpected phase while standing out a hand: INSURANCE_OFFER` from inside
     * `closeTable`, so a correct table failed a correct-looking suite.
     *
     * Declining is the right answer rather than waiting: it is what the
     * absent-player default does, it costs nothing, and it leads to the two
     * phases this already handled. A stranger's decision cannot be answered
     * here, so their insurance clock is left to the next pass — which is how
     * this loop already waits out a stranger's turn.
     */
    if (state.phase === "INSURANCE_OFFER") {
      let answered = false;
      for (const seat of seats) {
        const current = await snapshot(seat.player, seat.gameId);
        if (current.legalActions[seat.seatId]?.canDeclineInsurance) {
          await command(seat.player, seat.gameId, "DECLINE_INSURANCE", current.version);
          answered = true;
        }
      }
      if (!answered) await new Promise((resolve) => setTimeout(resolve, 1_000));
      continue;
    }

    /*
     * BETTING IS OPEN AGAIN, which means the round settled while this loop was
     * waiting a stranger out. `snapshot` sends `RESOLVE_TIMEOUT`, and a
     * settlement-window timeout STARTS THE NEXT HAND — 12 s against this loop's
     * 60. Nothing is committed in a fresh betting window, which is precisely
     * the state every caller is here to reach: a cash-out is refused only while
     * a wager is live.
     */
    if (state.phase === "BETTING_OPEN") return state;

    if (state.phase !== "PLAYER_TURNS") {
      throw new Error(`unexpected phase while standing out a hand: ${state.phase}`);
    }
    const actor = seats.find((seat) => seat.seatId === state.activeSeatId);
    if (!actor) {
      // Somebody else's seat. Their action clock is running; the next pass asks
      // the server to resolve it, which stands them exactly as the timeout does.
      await new Promise((resolve) => setTimeout(resolve, 1_000));
      continue;
    }
    const stood = await command(actor.player, actor.gameId, "STAND", state.version);
    if (stood.status !== 200) throw new Error(`STAND refused: ${stood.raw.slice(0, 300)}`);
  }
  throw new Error(
    `the hand never settled. Our seats: ${seats.map((seat) => seat.seatId).join(", ")}`,
  );
}

async function cashOut(seat: Seated, requestId: string = crypto.randomUUID()) {
  return await call("create-session", seat.player.token, {
    action: "CASH_OUT",
    clientRequestId: requestId,
    gameId: seat.gameId,
    clientSentAt: iso(),
  });
}

const one = (value: unknown) => (Array.isArray(value) ? value[0] : value);

const suite = stackUp ? describe : describe.skip;

// ---------------------------------------------------------------------------
// §A, §B — the queues, and what waiting means
// ---------------------------------------------------------------------------

suite("public queues and matchmaking", () => {
  it("seats a player only when there is somebody to share the table with", async () => {
    const alone = await createPlayer();
    expect((await rpc(alone.token, "join_matchmaking", { p_tier: "casual" })).status).toBe(200);

    const polled = await rpc(alone.token, "poll_matchmaking");
    const row = one(polled.body) as
      { status?: string; room_id?: string | null; others_waiting?: number } | undefined;

    /*
     * THE RULE, exactly as the server implements it: a table is opened only
     * when there is somebody to share it with, and otherwise the player waits.
     *
     * Two defects live under it. `poll_matchmaking` used to create a room on a
     * lone player's very FIRST poll and answer `matched`, so `waiting` lasted a
     * few milliseconds at most and the Keep Waiting / Play Solo / Cancel offer
     * the specification asks for after twenty seconds could not be reached by
     * anybody. And once that was fixed, an emptied room left behind by an
     * earlier run was still a candidate, so the lone player was matched into a
     * leftover — same outcome, different cause, caught by running this suite
     * twice.
     *
     * WHY THIS IS STATED AS A RELATIONSHIP AND NOT AS `expect("waiting")`.
     * Allocation is global, the queue entry lives five minutes, and CI runs two
     * server files at once — so another suite's enrolled player is a real
     * waiter at these stakes, and a table opened to share with them is the
     * server being right. The absolute form failed on two runs in three for
     * that reason. What is asserted instead is that every `matched` answer has
     * one of the two legitimate causes, which is falsifiable in both
     * directions: remove the `v_waiting = 0` guard and a matched player has
     * neither cause; remove `seats.taken > 0` and they are matched into a room
     * with nobody in it.
     */
    const othersWaiting = row?.others_waiting ?? 0;
    expect(typeof othersWaiting).toBe("number");

    /*
     * The queue is left in a `finally` because a FAILING assertion here would
     * otherwise strand this account as a live waiter for five minutes — and a
     * live waiter is not inert: it is what makes the next lone player in any
     * suite get matched. A test whose failure changes the answer the next run
     * gets is a test that hides itself.
     */
    try {
      if (row?.status === "matched") {
        const members = (await readAs(
          alone.token,
          `room_members?select=user_id&room_id=eq.${row.room_id}&status=eq.joined`,
        )) as { user_id: string }[];
        const strangers = members.map((m) => m.user_id).filter((id) => id !== alone.id).length;

        // Either they joined a table that has people at it, or they opened one
        // because the server had counted somebody else in the queue.
        expect(
          strangers > 0 || othersWaiting > 0,
          `matched at a table of ${strangers + 1} with ${othersWaiting} others queueing: ` +
            "a room was opened for one player, which is the defect this test exists for",
        ).toBe(true);
      } else {
        expect(row?.status).toBe("waiting");
        expect(row?.room_id ?? null).toBeNull();
        // Nothing to share with, which is the only reason to be told to wait.
        expect(othersWaiting).toBe(0);
      }
    } finally {
      await rpc(alone.token, "leave_matchmaking");
    }
  }, 60_000);

  it("seats two players who chose the same stakes at ONE table", async () => {
    /*
     * THE DEFECT THIS IS ABOUT, in one sentence: two people who both chose
     * Casual four seconds apart never met, because the first one's buy-in set
     * their room to `active` and `poll_matchmaking` only ever looked at rooms
     * in `lobby`.
     */
    const seats = await openPublicTable(2);
    const [alice, bob] = seats as [Seated, Seated];

    expect(bob.roomId).toBe(alice.roomId);
    expect(bob.gameId).toBe(alice.gameId);
    expect(bob.seatId).not.toBe(alice.seatId);

    const members = (await readAs(
      alice.player.token,
      `room_members?select=user_id&room_id=eq.${alice.roomId}&status=eq.joined`,
    )) as { user_id: string }[];
    expect(members.map((m) => m.user_id)).toEqual(
      expect.arrayContaining([alice.player.id, bob.player.id]),
    );

    const state = await snapshot(alice.player, alice.gameId);
    expect(state.seats.map((seat) => seat.seatId).sort()).toEqual(
      [alice.seatId, bob.seatId].sort(),
    );

    await closeTable(seats);
  }, 90_000);

  it("counts the other players queueing for these stakes rather than assuming none", async () => {
    /*
     * The waiting card used to state "Nobody else is queueing for these stakes
     * right now" whenever it offered a way out, without having asked — and it
     * was wrong in exactly the case that matters, because two people waiting is
     * when holding on for a few more seconds is worth doing. `others_waiting`
     * is the server's count.
     */
    const alice = await createPlayer();
    const bob = await createPlayer();

    await rpc(alice.token, "join_matchmaking", { p_tier: "high" });
    await rpc(bob.token, "join_matchmaking", { p_tier: "high" });

    // High is level-gated, so neither is enrolled and nobody is waiting there.
    const highRow = one((await rpc(alice.token, "poll_matchmaking")).body);
    expect(highRow ?? null).toBeNull();

    await rpc(alice.token, "join_matchmaking", { p_tier: "casual" });
    const first = one((await rpc(alice.token, "poll_matchmaking")).body) as {
      status: string;
      others_waiting?: number;
    };

    if (first.status === "waiting") {
      await rpc(bob.token, "join_matchmaking", { p_tier: "casual" });
      const withCompany = one((await rpc(alice.token, "poll_matchmaking")).body) as {
        status: string;
        others_waiting?: number;
      };
      // Either alice has now been matched WITH bob, or she is still waiting and
      // has been told he is there. Both are honest; silence is not.
      if (withCompany.status === "waiting") {
        expect(withCompany.others_waiting).toBeGreaterThanOrEqual(1);
      } else {
        expect(withCompany.status).toBe("matched");
      }
    }

    for (const account of [alice, bob]) await rpc(account.token, "leave_matchmaking");
  }, 90_000);

  it("does not offer the high table below level 10, and says so with a code a client can branch on", async () => {
    const player = await createPlayer();
    const refused = await rpc(player.token, "join_matchmaking", {
      p_tier: "high",
    });

    expect(refused.status).toBe(400);
    expect((refused.body as { message?: string }).message).toMatch(/level 10/i);

    // Nothing was enrolled, so a refusal cannot leave a player holding a place.
    const queued = (await readAs(
      player.token,
      `matchmaking_queue?select=status&user_id=eq.${player.id}`,
    )) as { status: string }[];
    expect(queued).toEqual([]);
  }, 60_000);

  it("answers the already-seated refusal as PT409, not as a server fault", async () => {
    const seats = await openPublicTable(2);
    const [seat] = seats as [Seated, Seated];

    const requeue = await rpc(seat.player.token, "join_matchmaking", {
      p_tier: "casual",
    });

    /*
     * PostgREST maps SQLSTATE `PTnnn` to HTTP nnn. Raised as `P0001` this
     * arrived as HTTP 400 carrying a lowercase sentence and no code, so the
     * queue screen printed the server's own words and offered nothing to do
     * about them — one step before `takeSeat` names the way back for the very
     * same condition. 409 is what lets the client say "your chips are at that
     * other table; return to it from Play".
     */
    expect(requeue.status).toBe(409);
    expect((requeue.body as { code?: string }).code).toBe("PT409");

    await closeTable(seats);
  }, 60_000);
});

// ---------------------------------------------------------------------------
// §C — seat allocation under contention
// ---------------------------------------------------------------------------

suite("seat allocation is race-safe", () => {
  it("fills a table before opening another and never seats a sixth player", async () => {
    /*
     * Seven players, one tier, polling simultaneously. The first implementation
     * used `for update skip locked`, which is safe and wrong: under contention
     * each poller SKIPPED the table another was holding and opened its own, so
     * six players arriving together landed at five different tables. Allocation
     * is serialised per tier by an advisory lock instead.
     */
    const players: Player[] = [];
    for (let i = 0; i < 7; i += 1) players.push(await createPlayer());

    for (const player of players) {
      expect((await rpc(player.token, "join_matchmaking", { p_tier: "standard" })).status).toBe(
        200,
      );
    }

    // Two rounds, because a player who polls while alone is told to wait.
    const rooms = new Map<string, string>();
    for (let round = 0; round < 3; round += 1) {
      const answers = await Promise.all(
        players.map(async (player) => ({
          player,
          row: one((await rpc(player.token, "poll_matchmaking")).body) as {
            status?: string;
            room_id?: string;
          },
        })),
      );
      for (const { player, row } of answers) {
        if (row?.status === "matched" && row.room_id) rooms.set(player.id, row.room_id);
      }
      if (rooms.size === players.length) break;
    }

    expect(rooms.size).toBe(players.length);

    // Every allocated room, counted through the policy that shows a member the
    // room they are in.
    const occupancy = new Map<string, number>();
    for (const player of players) {
      const roomId = rooms.get(player.id) as string;
      if (occupancy.has(roomId)) continue;
      const members = (await readAs(
        player.token,
        `room_members?select=user_id&room_id=eq.${roomId}&status=eq.joined`,
      )) as { user_id: string }[];
      occupancy.set(roomId, members.length);
    }

    for (const [roomId, taken] of occupancy) {
      expect(`${roomId}:${taken}`).toBe(`${roomId}:${Math.min(taken, MAX_SEATS)}`);
      expect(taken).toBeLessThanOrEqual(MAX_SEATS);
    }

    /*
     * FILLING, NOT SPREADING. At most one of the rooms these seven landed in may
     * be under capacity — the last one opened. Asserted as a relationship
     * rather than "exactly two rooms", because a table left open at these stakes
     * by an earlier run is a legitimate place for them to sit and counting rooms
     * globally is how a test starts failing on a dirty database.
     */
    const underCapacity = [...occupancy.values()].filter((taken) => taken < MAX_SEATS);
    expect(underCapacity.length).toBeLessThanOrEqual(1);

    for (const player of players) await rpc(player.token, "leave_matchmaking");
  }, 120_000);
});

// ---------------------------------------------------------------------------
// §D — the buy-in escrow
// ---------------------------------------------------------------------------

suite("the public buy-in is one atomic escrow", () => {
  it("debits once, records one ledger row, and puts the chips in the table's escrow", async () => {
    const seats = await openPublicTable(2);
    const [alice, bob] = seats as [Seated, Seated];

    for (const seat of seats) {
      expect(await balanceOf(seat.player)).toBe(OPENING_GRANT - CASUAL.buyIn);

      const buyIns = (await ledgerOf(seat.player)).filter((row) => row.reason === "table_buy_in");
      expect(buyIns).toHaveLength(1);
      expect(buyIns[0]).toMatchObject({
        delta: -CASUAL.buyIn,
        reference_id: seat.gameId,
      });
    }

    const sessions = (await readAs(
      alice.player.token,
      `game_sessions?select=mode,status,escrow_chips,tier,max_seats&id=eq.${alice.gameId}`,
    )) as {
      mode: string;
      status: string;
      escrow_chips: number;
      tier: string;
      max_seats: number;
    }[];
    expect(sessions[0]).toMatchObject({
      mode: "public_table",
      status: "active",
      tier: "casual",
      max_seats: MAX_SEATS,
    });

    const state = await snapshot(alice.player, alice.gameId);
    expect(seatOf(state, alice).stack).toBe(CASUAL.buyIn);
    expect(seatOf(state, bob).stack).toBe(CASUAL.buyIn);

    /*
     * THE CHIPS ARE AT THE TABLE, NOT GONE: escrow equals the sum of the
     * stacks. Not `buyIn * 2` — a public table keeps taking players while it
     * has room, which is the phase 7 fix working as specified, and allocation
     * is GLOBAL, so a third seat belonging to a file running beside this one is
     * legitimate and `buyIn * 2` is then an assertion about somebody else's
     * chips. CI answered `expected 6000 to be 4000`.
     *
     * AND THE TWO READS MUST BE OF THE SAME MOMENT. The first version of this
     * fix summed the seats from one request and compared them with an escrow
     * from another, which is the identical race one step along: CI answered
     * `expected 4000 to be 6000` when a stranger bought in between them. So
     * both are re-read together until they agree, which is what asserting an
     * INVARIANT of a moving table actually requires — and if they never do,
     * the failure says so rather than printing two numbers.
     */
    let escrow = -1;
    let stacks = -2;
    for (let attempt = 0; attempt < 8 && escrow !== stacks; attempt += 1) {
      const seen = await snapshot(alice.player, alice.gameId);
      stacks = seen.seats.reduce((total, seat) => total + seat.stack, 0);
      const row = (await readAs(
        alice.player.token,
        `game_sessions?select=escrow_chips&id=eq.${alice.gameId}`,
      )) as { escrow_chips: number }[];
      escrow = Number(row[0]?.escrow_chips);
    }
    expect(escrow, "escrow never agreed with the stacks over eight reads").toBe(stacks);

    await closeTable(seats);
  }, 90_000);

  it("does not buy a second seat when the request is retried with a fresh id", async () => {
    const seats = await openPublicTable(2);
    const [seat] = seats as [Seated, Seated];

    const after = await balanceOf(seat.player);
    const retry = await call("create-session", seat.player.token, {
      action: "JOIN_PUBLIC_TABLE",
      // A DIFFERENT request id, which is exactly what a retry after a dropped
      // response looks like. The idempotency key is derived from the game and
      // the player, never from this.
      clientRequestId: crypto.randomUUID(),
      roomId: seat.roomId,
      clientSentAt: iso(),
    });

    expect(retry.status).toBe(200);
    expect(retry.body.gameId).toBe(seat.gameId);
    expect(retry.body.seatId).toBe(seat.seatId);
    expect(await balanceOf(seat.player)).toBe(after);
    expect((await ledgerOf(seat.player)).filter((r) => r.reason === "table_buy_in")).toHaveLength(
      1,
    );
    expect((await seatsOf(seat.player)).filter((r) => r.status !== "left")).toHaveLength(1);

    await closeTable(seats);
  }, 90_000);
});

// ---------------------------------------------------------------------------
// §E — one live seat, whatever the second table is
// ---------------------------------------------------------------------------

suite("a second live seat is refused before any chips move", () => {
  it("refuses a public buy-in while a SOLO table is live", async () => {
    /*
     * THE PARTNER SITS DOWN FIRST, and that is what makes the refusal below a
     * statement about the PLAYER rather than about the room.
     *
     * Allocation is global, so the room this test is matched into is one any
     * file running beside it can be matched into as well — and a room closes
     * when the last seat at its table leaves. `JOIN_PUBLIC_TABLE` checks the
     * room's status BEFORE it looks at who is asking, correctly, because a
     * closed room must take no more buy-ins. So a room strangers had finished
     * with answered `SESSION_CLOSED` and CI reported
     * `expected 'SESSION_CLOSED' to be 'SESSION_ALREADY_ACTIVE'`: two correct
     * refusals, and a test that had assumed which one it would get.
     *
     * STAGED IN A RETRY rather than asserted first time, because the room can
     * be gone before the partner sits too — the first version of this fix put
     * the same race one step earlier and CI answered `expected 409 to be 200`
     * on the partner's own buy-in. A seat nobody has given up cannot be closed
     * out from under this, so once one is held the guard under test is the only
     * thing left that can refuse. Same shape as `openPublicTable` above.
     */
    let player: Player | null = null;
    let partner: Player | null = null;
    let room: string | null = null;
    let heldGameId: string | null = null;

    for (let attempt = 0; attempt < 6; attempt += 1) {
      const candidate = await createPlayer();
      const mate = await createPlayer();
      const allocated = await matchIntoAPublicRoom(
        rpc,
        [candidate.token, mate.token],
        "casual",
        async () => (await createPlayer()).token,
      );
      const sat = await call("create-session", mate.token, {
        action: "JOIN_PUBLIC_TABLE",
        clientRequestId: crypto.randomUUID(),
        roomId: allocated,
        clientSentAt: iso(),
      });
      if (sat.status === 200) {
        player = candidate;
        partner = mate;
        room = allocated;
        heldGameId = sat.body.gameId as string;
        break;
      }
      for (const account of [candidate, mate]) await rpc(account.token, "leave_matchmaking");
    }

    if (!player || !partner || !room || !heldGameId) {
      throw new Error(
        "six matched rooms and none stayed open long enough to seat a partner: the " +
          "shared pool was closing tables faster than this could take a seat at one",
      );
    }

    const solo = await call("create-session", player.token, {
      action: "OPEN",
      clientRequestId: crypto.randomUUID(),
      tier: "casual",
      clientSentAt: iso(),
    });
    expect(solo.status).toBe(200);
    const afterSolo = await balanceOf(player);

    const refused = await call("create-session", player.token, {
      action: "JOIN_PUBLIC_TABLE",
      clientRequestId: crypto.randomUUID(),
      roomId: room,
      clientSentAt: iso(),
    });
    expect(refused.status, refused.raw).toBe(409);
    expect(refused.body.code, refused.raw).toBe("SESSION_ALREADY_ACTIVE");
    expect(await balanceOf(player)).toBe(afterSolo);
    expect((await seatsOf(player)).filter((r) => r.status !== "left")).toHaveLength(1);

    // Give the partner's seat back, or this room stays open and keeps being
    // allocated to whoever queues next — including the rest of this file.
    await call("create-session", partner.token, {
      action: "CASH_OUT",
      gameId: heldGameId,
      clientRequestId: crypto.randomUUID(),
      clientSentAt: iso(),
    });
    for (const account of [player, partner]) await rpc(account.token, "leave_matchmaking");
  }, 90_000);

  it("refuses a public buy-in while a PRIVATE table is live", async () => {
    /*
     * The private table is the case the guard's own predicate covers and no
     * test had ever exercised: its chips are the table's own and never reach a
     * wallet, so a second escrow there costs the player their public buy-in
     * with nothing to show for it and no way back to either table.
     */
    const host = await createPlayer();
    const guest = await createPlayer();

    const created = await rpc(host.token, "create_private_room", {
      p_max_seats: 2,
    });
    expect(created.status).toBe(200);
    const privateRoom = one(created.body) as { id: string; code: string };
    expect(
      (
        await rpc(guest.token, "join_private_room", {
          p_code: privateRoom.code,
        })
      ).status,
    ).toBe(200);

    const started = await call("create-session", host.token, {
      action: "START_PRIVATE_TABLE",
      clientRequestId: crypto.randomUUID(),
      roomId: privateRoom.id,
      clientSentAt: iso(),
    });
    expect(started.status).toBe(200);

    const before = await balanceOf(guest);
    const partner = await createPlayer();
    const publicRoom = await matchIntoAPublicRoom(
      rpc,
      [partner.token, (await createPlayer()).token],
      "casual",
      async () => (await createPlayer()).token,
    );

    // The guest is not a member of that public room, so the refusal must be the
    // SESSION one and not merely "you are not at that table": queue them in.
    const refusedQueue = await rpc(guest.token, "join_matchmaking", {
      p_tier: "casual",
    });
    expect(refusedQueue.status).toBe(409);
    expect((refusedQueue.body as { code?: string }).code).toBe("PT409");

    const refused = await call("create-session", guest.token, {
      action: "JOIN_PUBLIC_TABLE",
      clientRequestId: crypto.randomUUID(),
      roomId: publicRoom,
      clientSentAt: iso(),
    });
    expect(refused.status).toBeGreaterThanOrEqual(400);
    expect(["SESSION_ALREADY_ACTIVE", "NOT_A_PARTICIPANT"]).toContain(refused.body.code);
    expect(await balanceOf(guest)).toBe(before);
  }, 120_000);

  it("refuses a second PUBLIC table and leaves the first one holding the chips", async () => {
    const seats = await openPublicTable(2);
    const [seat] = seats as [Seated, Seated];
    const after = await balanceOf(seat.player);

    // A second table, opened and funded by two other people, whose id this
    // player has: exactly the state a client is in after being matched twice.
    const strangers = await openPublicTable(2);
    const otherRoom = (strangers[0] as Seated).roomId;
    expect(otherRoom).not.toBe(seat.roomId);

    const refused = await call("create-session", seat.player.token, {
      action: "JOIN_PUBLIC_TABLE",
      clientRequestId: crypto.randomUUID(),
      roomId: otherRoom,
      clientSentAt: iso(),
    });
    expect(refused.status).toBeGreaterThanOrEqual(400);
    expect(await balanceOf(seat.player)).toBe(after);
    expect((await seatsOf(seat.player)).filter((r) => r.status !== "left")).toHaveLength(1);

    /*
     * AND THE REFUSAL NAMES SOMETHING THE PLAYER CAN DO. `my_active_session()`
     * is where the chips are, derived from the JWT with the same predicate the
     * refusal used — asserted by provoking the refusal and checking the lookup
     * names the same table, rather than by comparing two copies of a predicate.
     */
    const active = one((await rpc(seat.player.token, "my_active_session")).body) as {
      game_session_id: string;
      seat_id: string;
      mode: string;
    };
    expect(active).toMatchObject({
      game_session_id: seat.gameId,
      seat_id: seat.seatId,
      mode: "public_table",
    });

    await closeTable(strangers);
    await closeTable(seats);
  }, 120_000);

  it("refuses a stale room id whose table has closed, and charges nothing", async () => {
    const seats = await openPublicTable(2);
    const [alice, bob] = seats as [Seated, Seated];

    for (const seat of seats) {
      const out = await cashOut(seat);
      expect(out.status).toBe(200);
    }
    expect(await balanceOf(alice.player)).toBe(OPENING_GRANT);

    // The room id is still in the client's hands — it lives in a store and in a
    // route parameter, both of which outlive the table.
    const stale = await call("create-session", alice.player.token, {
      action: "JOIN_PUBLIC_TABLE",
      clientRequestId: crypto.randomUUID(),
      roomId: alice.roomId,
      clientSentAt: iso(),
    });
    expect(stale.status).toBeGreaterThanOrEqual(400);
    expect(["SESSION_CLOSED", "NOT_A_PARTICIPANT"]).toContain(stale.body.code);
    expect(await balanceOf(alice.player)).toBe(OPENING_GRANT);
    expect(await balanceOf(bob.player)).toBe(OPENING_GRANT);
  }, 120_000);
});

// ---------------------------------------------------------------------------
// §F — joining a table that has already dealt
// ---------------------------------------------------------------------------

suite("joining mid-shoe", () => {
  it("reserves a seat, deals the newcomer no cards, and plays them in at the next betting window", async () => {
    const seats = await openPublicTable(2);
    const [alice, bob] = seats as [Seated, Seated];

    const dealt = await dealAHand([alice, bob]);
    expect(dealt.phase).toBe("PLAYER_TURNS");

    /*
     * THE ALLOCATION THAT COULD NOT HAPPEN. `poll_matchmaking` considered only
     * rooms at `status = 'lobby'`, and the buy-in sets a room to `active`, so
     * this newcomer used to be handed a brand new table of their own. The seat
     * `joinPublicTable` appends to a live engine state — written, typechecked
     * and correct — was unreachable.
     */
    /*
     * ALLOCATION IS GLOBAL, so "the newcomer lands at OUR table" is STAGING and
     * not the subject of this test. `poll_matchmaking` offers the oldest public
     * table still short of players, and on a pool this file shares with
     * whatever runs beside it that can legitimately be somebody else's — which
     * answered a bare uuid mismatch, reading exactly like the phase 7 defect
     * described above coming back.
     *
     * So it is retried with a fresh account rather than asserted first time,
     * and if the pool never offers this table the failure NAMES why instead of
     * printing two uuids.
     */
    let latecomer: Player | null = null;
    let placed: { status: string; room_id: string } | null = null;
    for (let attempt = 0; attempt < 6; attempt += 1) {
      const candidate = await createPlayer();
      await rpc(candidate.token, "join_matchmaking", { p_tier: "casual" });
      const row = one((await rpc(candidate.token, "poll_matchmaking")).body) as {
        status: string;
        room_id: string;
      };
      if (row.status === "matched" && row.room_id === alice.roomId) {
        latecomer = candidate;
        placed = row;
        break;
      }
      await rpc(candidate.token, "leave_matchmaking");
    }
    if (!latecomer || !placed) {
      throw new Error(
        `six accounts queued for casual and none was offered ${alice.roomId}: an ` +
          `older public table still had room, which is allocation working and ` +
          `makes this scenario unstageable rather than broken`,
      );
    }
    expect(placed.status).toBe("matched");
    expect(placed.room_id).toBe(alice.roomId);

    const third = await takeSeat(latecomer, placed.room_id);
    expect(third.gameId).toBe(alice.gameId);

    const midHand = await snapshot(latecomer, third.gameId);
    expect(midHand.phase).toBe("PLAYER_TURNS");

    // NO CARDS MIDWAY THROUGH A COMMITTED HAND, and the full buy-in still theirs.
    const reserved = seatOf(midHand, third);
    expect(reserved.hands).toEqual([]);
    expect(reserved.stack).toBe(CASUAL.buyIn);
    expect(reserved.originalBet).toBe(0);
    expect(reserved.betLocked).toBe(false);

    // The players who committed a wager still hold their cards.
    expect(seatOf(midHand, alice).hands[0]?.cards.length).toBeGreaterThanOrEqual(2);

    await standToSettlement([alice, bob]);
    const settled = await snapshot(alice.player, alice.gameId);
    const next = await command(alice.player, alice.gameId, "NEXT_HAND", settled.version);
    expect(next.status).toBe(200);

    const betting = next.body.publicState as PublicState;
    expect(betting.phase).toBe("BETTING_OPEN");
    // And now they play: not sat out, and able to bet.
    expect(seatOf(betting, third).sittingOut).toBe(false);
    expect(betting.legalActions[third.seatId]?.canPlaceBet).toBe(true);

    const staked = await bet(third, 100);
    expect(seatOf(staked, third).originalBet).toBe(100);

    await closeTable([alice, bob, third]);
  }, 180_000);
});

// ---------------------------------------------------------------------------
// §G, §H — leaving, and being paid exactly once
// ---------------------------------------------------------------------------

suite("leaving and cashing out", () => {
  it("refuses a mid-hand cash-out, resolves the committed wager, then pays at the boundary", async () => {
    const seats = await openPublicTable(2);
    const [alice, bob] = seats as [Seated, Seated];

    await dealAHand([alice, bob]);
    const beforeLeaving = await balanceOf(alice.player);

    const refused = await cashOut(alice);
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe("SESSION_BUSY");
    // "Leaving is never a way to escape a committed wager."
    expect(await balanceOf(alice.player)).toBe(beforeLeaving);
    expect(
      (await ledgerOf(alice.player)).filter((r) => r.reason === "table_cash_out"),
    ).toHaveLength(0);

    await standToSettlement([alice, bob]);

    const paid = await cashOut(alice);
    expect(paid.status).toBe(200);
    expect(paid.body.walletBalance).toBe(beforeLeaving + (paid.body.returned as number));
    // The whole seat came back: nothing is left stranded at the table.
    expect(paid.body.returned).toBeGreaterThan(0);

    // The table did NOT end for the other player.
    expect(paid.body.sessionEnded).toBe(false);
    const remaining = await snapshot(bob.player, bob.gameId);
    expect(remaining.phase).not.toBe("SESSION_COMPLETE");
    expect(seatOf(remaining, bob).stack).toBeGreaterThan(0);

    await closeTable([bob]);
  }, 180_000);

  it("credits exactly once however many times the cash-out is asked for", async () => {
    const seats = await openPublicTable(2);
    const [alice, bob] = seats as [Seated, Seated];

    const first = await cashOut(alice);
    expect(first.status).toBe(200);
    expect(first.body.returned).toBe(CASUAL.buyIn);
    expect(first.body.walletBalance).toBe(OPENING_GRANT);

    // A fresh request id — a retry after a lost response — and the same id
    // again, which is the other half of the same guarantee.
    const retryId = crypto.randomUUID();
    for (const answer of [
      await cashOut(alice),
      await cashOut(alice, retryId),
      await cashOut(alice, retryId),
    ]) {
      expect(answer.status).toBe(200);
      expect(answer.body.returned).toBe(CASUAL.buyIn);
      expect(answer.body.walletBalance).toBe(OPENING_GRANT);
    }

    expect(await balanceOf(alice.player)).toBe(OPENING_GRANT);
    expect(
      (await ledgerOf(alice.player)).filter((r) => r.reason === "table_cash_out"),
    ).toHaveLength(1);
    expect((await seatsOf(alice.player)).filter((r) => r.status !== "left")).toHaveLength(0);
    // And the way back into a table is open again, which is what the guard is for.
    expect((await rpc(alice.player.token, "my_active_session")).body).toEqual([]);

    await closeTable([bob]);
  }, 120_000);
});

// ---------------------------------------------------------------------------
// §I, §J — the table itself, and coming back to it
// ---------------------------------------------------------------------------

suite("public gameplay is the server's", () => {
  it("shares one shoe, hides the hole card, and takes turns in seat order", async () => {
    const seats = await openPublicTable(3);
    const [alice] = seats as [Seated, Seated, Seated];

    const dealt = await dealAHand(seats);
    expect(dealt.phase).toBe("PLAYER_TURNS");
    expect(dealt.seats.length).toBeGreaterThanOrEqual(3);

    /*
     * ONE SHOE. Every card on the table is a distinct PHYSICAL card, across
     * every seat and the dealer — the property a second shoe or a re-deal
     * would break.
     *
     * Keyed on `id`, not on rank+suit. A six-deck shoe holds six aces of
     * spades and dealing two of them to one table is correct; `Card`'s own
     * doc comment says so ("Never infer identity from rank/suit alone"), and
     * `id` carries the deck index for exactly this reason. The rank+suit
     * version of this assertion failed about one run in three with
     * "expected 6 to be 7" — the assertion was wrong, not the shoe, and it
     * would have gone on being wrong at a rate that reads as a flake.
     */
    const shown = [
      ...dealt.seats.flatMap((seat) => seat.hands.flatMap((hand) => hand.cards)),
      ...dealt.dealer.cards.filter((card): card is VisibleCard => !("hidden" in card)),
    ].map((card) => card.id);
    expect(shown.every((id) => /^d\d+-/.test(id))).toBe(true);
    expect(new Set(shown).size).toBe(shown.length);

    // NO EARLY HOLE CARD, and no future cards, in the payload of any client.
    for (const seat of seats) {
      const view = await command(seat.player, seat.gameId, "RESOLVE_TIMEOUT", 0);
      expect(view.raw).not.toMatch(/nextIndex/);
      expect(view.raw).not.toMatch(/"shoe":\s*\{[^}]*"cards"/);
      const state = view.body.publicState as PublicState;
      expect(state.dealer.cards.filter((card) => "hidden" in card)).toHaveLength(1);
      expect(state.dealer.holeCardRevealed).toBe(false);
      expect(state.shoe.shuffleNumber).toBe(1);
    }

    // ONE ACTOR AT A TIME, and it is not the others.
    const active = dealt.activeSeatId;
    expect(active).toBeTruthy();
    const notTheirTurn = seats.find((seat) => seat.seatId !== active);
    if (!notTheirTurn) throw new Error("every seat is the active one");
    const jumped = await command(notTheirTurn.player, notTheirTurn.gameId, "HIT", dealt.version);
    expect(jumped.status).toBe(422);
    expect(jumped.body.code).toBe("NOT_YOUR_TURN");

    // A SHARED TABLE STATES ITS CLOCK, which is what a countdown renders and
    // what `RESOLVE_TIMEOUT` acts on. A solo table carries none on purpose.
    expect(dealt.deadlineAt).not.toBeNull();

    // And a wager outside the tier's band is refused by the SERVER.
    const actor = seats.find((seat) => seat.seatId === active) as Seated;
    await standToSettlement(seats);
    const settled = await snapshot(actor.player, actor.gameId);
    const reopened = await command(actor.player, actor.gameId, "NEXT_HAND", settled.version);
    expect(reopened.status).toBe(200);
    const version = (reopened.body.publicState as PublicState).version;
    const tooBig = await command(actor.player, actor.gameId, "PLACE_BET", version, {
      amount: CASUAL.maxBet + 10,
    });
    expect(tooBig.status).toBe(422);
    expect(tooBig.body.code).toBe("BET_ABOVE_MAXIMUM");

    await closeTable(seats);
  }, 180_000);

  it("finds the table again from the JWT alone, with the countdown restored from the server", async () => {
    const seats = await openPublicTable(2);
    const [alice, bob] = seats as [Seated, Seated];
    await dealAHand([alice, bob]);

    /*
     * THE CLIENT HAS FORGOTTEN EVERYTHING. A killed app, a rebooted phone, or a
     * second device: the game id reached this client once, in the reply to the
     * buy-in, and lived afterwards only in a route parameter. Every online mode
     * refuses a second buy-in while a seat is held, so losing it used to lock
     * the account out for ever with the chips stranded.
     */
    const found = one((await rpc(alice.player.token, "my_active_session")).body) as {
      game_session_id: string;
      seat_id: string;
      mode: string;
      tier: string;
    };
    expect(found).toMatchObject({
      game_session_id: alice.gameId,
      seat_id: alice.seatId,
      mode: "public_table",
      tier: "casual",
    });

    // The snapshot is authoritative and carries the server's own deadline.
    const restored = await snapshot(alice.player, found.game_session_id);
    expect(restored.gameId).toBe(alice.gameId);
    expect(restored.deadlineAt).not.toBeNull();
    expect(Number.isFinite(Date.parse(restored.deadlineAt as string))).toBe(true);
    expect(seatOf(restored, alice).hands[0]?.cards.length).toBeGreaterThanOrEqual(2);

    // THE MATCH DID NOT PAUSE while the client was away, and a safe leave still
    // works afterwards.
    await standToSettlement([alice, bob]);
    const out = await cashOut(alice);
    expect(out.status).toBe(200);
    expect(
      (await ledgerOf(alice.player)).filter((r) => r.reason === "table_cash_out"),
    ).toHaveLength(1);

    await closeTable([bob]);
  }, 180_000);
});

// ---------------------------------------------------------------------------
// §K — concurrency
// ---------------------------------------------------------------------------

suite("concurrent commands at one public table", () => {
  it("applies one of two commands racing the same version and tells the other it is stale", async () => {
    const seats = await openPublicTable(2);
    const [alice, bob] = seats as [Seated, Seated];

    const state = await snapshot(alice.player, alice.gameId);
    const [first, second] = await Promise.all([
      command(alice.player, alice.gameId, "PLACE_BET", state.version, {
        amount: 100,
      }),
      command(bob.player, bob.gameId, "PLACE_BET", state.version, {
        amount: 60,
      }),
    ]);

    const outcomes = [first, second].map((r) => r.body.status);
    expect(outcomes).toContain("accepted");
    // The loser is told the authoritative version rather than being applied
    // twice or silently dropped.
    expect(outcomes.filter((status) => status === "accepted").length).toBe(1);
    const loser = [first, second].find((r) => r.body.status !== "accepted");
    expect(loser?.body.status).toBe("stale");
    expect((loser?.body.publicState as PublicState).version).toBeGreaterThan(state.version);

    await closeTable(seats);
  }, 120_000);

  /*
   * THE SAME ACCOUNT FROM TWO DEVICES, which is not the same thing as two
   * accounts racing and not the same thing as a retry.
   *
   * A phone and a tablet signed into one account hold two independent tokens
   * for the SAME `sub`, each with its own view of the table, and each mints its
   * own `clientActionId` — so the idempotency key that makes a retry safe does
   * not apply. Both may act on the same version at the same moment. What must
   * come out is one command applied and one seat: the version guard is the only
   * thing standing between two devices and a stack debited twice for one bet.
   */
  it("applies one of two commands from the same account on two devices", async () => {
    const seats = await openPublicTable(2);
    const [alice] = seats as [Seated, Seated];

    // A second device: the same account, its own independently signed session.
    const tablet: Player = { id: alice.player.id, token: signToken(alice.player.id, 7200) };
    expect(tablet.token).not.toBe(alice.player.token);

    const state = await snapshot(alice.player, alice.gameId);
    const stackBefore = seatOf(state, alice).stack;

    const [phone, pad] = await Promise.all([
      command(alice.player, alice.gameId, "PLACE_BET", state.version, { amount: 100 }),
      command(tablet, alice.gameId, "PLACE_BET", state.version, { amount: 100 }),
    ]);

    const statuses = [phone.body.status, pad.body.status];
    expect(statuses.filter((status) => status === "accepted")).toHaveLength(1);
    expect(statuses).toContain("stale");

    // ONE BET, not two. The refused device is told the authoritative version.
    const after = await snapshot(alice.player, alice.gameId);
    expect(seatOf(after, alice).originalBet).toBe(100);
    expect(seatOf(after, alice).stack).toBe(stackBefore - 100);

    // AND ONE SEAT. A second device does not become a second player.
    expect((await seatsOf(alice.player)).filter((row) => row.status !== "left")).toHaveLength(1);
    // Both devices read the same table through their own token.
    expect((await snapshot(tablet, alice.gameId)).version).toBe(after.version);

    await closeTable(seats);
  }, 120_000);

  it("applies a duplicated command exactly once and replays its result", async () => {
    const seats = await openPublicTable(2);
    const [alice] = seats as [Seated, Seated];

    const state = await snapshot(alice.player, alice.gameId);
    const actionId = crypto.randomUUID();
    const first = await command(
      alice.player,
      alice.gameId,
      "PLACE_BET",
      state.version,
      { amount: 100 },
      actionId,
    );
    expect(first.status).toBe(200);

    // The same clientActionId again — a retry after a dropped response.
    const replay = await command(
      alice.player,
      alice.gameId,
      "PLACE_BET",
      state.version,
      { amount: 100 },
      actionId,
    );
    expect(replay.status).toBe(200);

    /*
     * A REPLAYED COMMAND'S PAYLOAD IS NOT BYTE-IDENTICAL: it is served from
     * `private.game_commands` as `jsonb`, which sorts keys by length then
     * bytewise. Same value, different bytes — so the assertion is on the parsed
     * body.
     */
    expect(replay.body.publicState).toEqual(first.body.publicState);

    /*
     * ASSERTED ON THE COMMAND'S OWN ANSWER, not on a later re-read.
     *
     * `snapshot()` sends `RESOLVE_TIMEOUT`, so a read taken after a betting
     * deadline has passed can itself close betting, deal the hand and settle
     * it — and `openBetting` clears `originalBet` for the next window. At a
     * table this file shares with whoever else was matched into it, that is an
     * ordinary sequence of events rather than a replay defect, and it answered
     * `expected +0 to be 100`. What this test is about is that the replay
     * changed nothing, which is a statement about the moment the command was
     * applied.
     */
    const applied = first.body.publicState as PublicState;
    expect(seatOf(applied, alice).originalBet).toBe(100);
    expect(seatOf(applied, alice).stack).toBe(CASUAL.buyIn - 100);

    await closeTable(seats);
  }, 120_000);

  it("keeps the table coherent when a leave races a join", async () => {
    const seats = await openPublicTable(2);
    const [alice, bob] = seats as [Seated, Seated];

    const latecomer = await createPlayer();
    await rpc(latecomer.token, "join_matchmaking", { p_tier: "casual" });
    const placed = one((await rpc(latecomer.token, "poll_matchmaking")).body) as {
      room_id: string;
    };

    const [left, joined] = await Promise.all([
      cashOut(alice),
      call("create-session", latecomer.token, {
        action: "JOIN_PUBLIC_TABLE",
        clientRequestId: crypto.randomUUID(),
        roomId: placed.room_id,
        clientSentAt: iso(),
      }),
    ]);

    expect(left.status).toBe(200);
    expect(left.body.returned).toBe(CASUAL.buyIn);
    expect(await balanceOf(alice.player)).toBe(OPENING_GRANT);

    /*
     * The joiner either landed at this table or was told it had closed. Both
     * are correct answers to the race; what must not happen is a charge with no
     * seat, which is what the assertion below actually checks.
     */
    const live = (await seatsOf(latecomer)).filter((row) => row.status !== "left");
    const charged = (await ledgerOf(latecomer)).filter((row) => row.reason === "table_buy_in");
    expect(charged).toHaveLength(live.length);
    if (joined.status === 200) {
      expect(live).toHaveLength(1);
      const state = await snapshot(latecomer, joined.body.gameId as string);
      // The seat that left is gone from the table's chips, and nobody else's
      // stack moved.
      expect(seatOf(state, bob).stack).toBe(CASUAL.buyIn);
    } else {
      expect(live).toHaveLength(0);
      expect(await balanceOf(latecomer)).toBe(OPENING_GRANT);
    }

    const stillSeated: Seated[] = [bob];
    if (joined.status === 200) {
      stillSeated.push({
        player: latecomer,
        gameId: joined.body.gameId as string,
        seatId: joined.body.seatId as string,
        roomId: placed.room_id,
      });
    }
    await closeTable(stillSeated);
  }, 180_000);
});

// ---------------------------------------------------------------------------
// §L — the whole thing, with three independent accounts
// ---------------------------------------------------------------------------

suite("three accounts play a public table through", () => {
  it("matches, plays several hands, loses one player, and stays coherent", async () => {
    const seats = await openPublicTable(3);
    const [alice, bob, carol] = seats as [Seated, Seated, Seated];

    /*
     * The chips ON the table, measured at HAND_COMPLETE where every wager has
     * been settled back into a stack. Summing stacks AND wagers mid-hand would
     * count the same chips twice — `originalBet` and a hand's `wager` are two
     * views of one commitment, not two piles.
     */
    const chipsAtTable = (state: PublicState) =>
      state.seats.reduce((total, seat) => total + seat.stack, 0);

    let handsPlayed = 0;
    for (let hand = 0; hand < 3; hand += 1) {
      const dealt = await dealAHand(seats);
      expect(dealt.seats.length).toBeGreaterThanOrEqual(3);
      await standToSettlement(seats);
      handsPlayed += 1;

      const settled = await snapshot(alice.player, alice.gameId);
      expect(settled.phase).toBe("HAND_COMPLETE");
      if (hand < 2) {
        const next = await command(alice.player, alice.gameId, "NEXT_HAND", settled.version);
        expect(next.status).toBe(200);
      }
    }
    expect(handsPlayed).toBe(3);

    // Chips are conserved at the table: nothing was minted by playing, and no
    // wallet moved after the buy-ins.
    for (const seat of seats) {
      expect(await balanceOf(seat.player)).toBe(OPENING_GRANT - CASUAL.buyIn);
    }

    const beforeLeaving = await snapshot(bob.player, bob.gameId);
    const tableChipsBefore = chipsAtTable(beforeLeaving);
    const bobStack = seatOf(beforeLeaving, bob).stack;

    const out = await cashOut(bob);
    expect(out.status).toBe(200);
    expect(out.body.returned).toBe(bobStack);
    expect(out.body.sessionEnded).toBe(false);
    expect(await balanceOf(bob.player)).toBe(OPENING_GRANT - CASUAL.buyIn + bobStack);
    expect((await ledgerOf(bob.player)).filter((r) => r.reason === "table_cash_out")).toHaveLength(
      1,
    );

    // THE REMAINING GAME IS COHERENT: two seats, their stacks untouched, and
    // the table still plays.
    const after = await snapshot(alice.player, alice.gameId);
    expect(after.phase).not.toBe("SESSION_COMPLETE");
    expect(chipsAtTable(after)).toBe(tableChipsBefore - bobStack);
    expect(seatOf(after, alice).stack).toBe(seatOf(beforeLeaving, alice).stack);
    expect(seatOf(after, carol).stack).toBe(seatOf(beforeLeaving, carol).stack);
    expect(seatOf(after, bob).connected).toBe(false);

    const dealtOn = await dealAHand([alice, carol]);
    expect(dealtOn.phase).toBe("PLAYER_TURNS");
    expect(seatOf(dealtOn, bob).hands).toEqual([]);
    await standToSettlement([alice, carol]);

    // And the two who stayed can leave with what they hold.
    for (const seat of [alice, carol]) {
      const held = seatOf(await snapshot(seat.player, seat.gameId), seat).stack;
      const paid = await cashOut(seat);
      expect(paid.status).toBe(200);
      expect(paid.body.returned).toBe(held);
      expect(await balanceOf(seat.player)).toBe(OPENING_GRANT - CASUAL.buyIn + held);
    }

    /*
     * AND THE TABLE IS FINISHED, not merely emptied. Three buy-ins left three
     * wallets and three cash-outs came back to them; every wallet is now its
     * opening grant plus or minus what the dealer took or paid, and no seat,
     * session or room is left holding anything. A ledger row per movement and
     * no more: three `table_buy_in`, three `table_cash_out`, across the three
     * accounts.
     */
    const movements = (await Promise.all(seats.map((seat) => ledgerOf(seat.player)))).flat();
    expect(movements.filter((row) => row.reason === "table_buy_in")).toHaveLength(3);
    expect(movements.filter((row) => row.reason === "table_cash_out")).toHaveLength(3);

    for (const seat of seats) {
      expect((await seatsOf(seat.player)).filter((row) => row.status !== "left")).toHaveLength(0);
      expect((await rpc(seat.player.token, "my_active_session")).body).toEqual([]);
    }

    const closed = (await readAs(
      alice.player.token,
      `game_sessions?select=status,escrow_chips&id=eq.${alice.gameId}`,
    )) as { status: string; escrow_chips: number }[];
    expect(closed[0]?.status).toBe("completed");
    expect(Number(closed[0]?.escrow_chips)).toBe(0);
  }, 300_000);
});
