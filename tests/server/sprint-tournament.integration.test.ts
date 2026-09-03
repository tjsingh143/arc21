/**
 * The Sprint Tournament, played against the REAL functions and the REAL database.
 *
 * `game-command.integration.test.ts` already runs one whole tournament end to
 * end. This file is what phase 8 added around it, and every case in it exists
 * because something was measurably wrong first:
 *
 *   - BETTING WAS NOT SEQUENTIAL. The format's defining mechanic — "Betting is
 *     sequential. Earlier committed tournament bets become visible" — did not
 *     exist. A probe had the LAST seat in button order place and lock before the
 *     first and the server answered 200 to both, and one shared seven-second
 *     clock covered all four players instead of giving each their own.
 *
 *   - THE COMPETITION BOUNDARY WAS SKIPPED BY THE SETTLEMENT TIMEOUT. A settled
 *     hand also advances when its eight-second rest window lapses and any
 *     connected client asks the server to resolve the deadline — and
 *     `game-command` ran the boundary only for `NEXT_HAND`. Measured:
 *     `scheduled_hands_played` stayed at 0 while hand 2 was dealt, so hand six
 *     never eliminated anybody, the bet ceiling never rose, and the tournament
 *     could never reach twelve and pay a prize.
 *
 *   - A PAID ENTRY COULD NEVER BE GIVEN UP. Registration returns the same entry
 *     to anybody already in a `registering` tournament, so a player whose field
 *     never filled was locked to it for ever with the fee spent.
 *
 *   - REGISTERING DID NOT CHECK FOR A SEAT ELSEWHERE. An account holding a live
 *     solo table registered, filled a field, and was dealt a SECOND live seat;
 *     `my_active_session()` then named only the newer of the two.
 *
 * WHERE A FIXTURE IS USED AND WHY. Three cases here set stacks (or the scheduled
 * hand count) directly in `private.game_state_private` before letting the server
 * decide what happens next. That is constructing a STANDING, never an outcome: a
 * tie at the elimination boundary, a player below the table minimum and a tie at
 * the top after hand twelve cannot be produced on demand by betting into a fair
 * shoe, and the alternative — retrying a full tournament until the cards
 * cooperate — is the flake this project has already spent two phases learning to
 * refuse. Every decision that follows the fixture is the real server's.
 */

import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";

import { callFunction as call } from "./call-function.js";
import { stackUp } from "./stack-guard.js";
import { SPRINT } from "../../supabase/functions/_shared/tournament-format.js";
import {
  advanceSprintHand,
  drainWaitingSprints,
  openSprintTable,
  playerHoldingSeat,
  playSprintHand,
  sendSprintCommand,
  type SprintDeps,
  type SprintTable,
} from "./sprint-table.js";

const REST = "http://127.0.0.1:54321/rest/v1";
const AUTH_ADMIN = "http://127.0.0.1:54321/auth/v1/admin/users";

/**
 * The published local-development secret and service key from `supabase start`.
 * Identical on every machine and worth nothing anywhere else.
 */
const LOCAL_JWT_SECRET = "super-secret-jwt-token-with-at-least-32-characters-long";
const LOCAL_SERVICE_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU";

const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");

/**
 * No `iat`, deliberately: PostgREST validates it against its own clock and the
 * Docker VM's jumps rather than drifts. See the note in
 * `game-command.integration.test.ts` — the failure reads as a wallet of -1, not
 * as a clock problem.
 */
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

async function createUser(): Promise<string> {
  const response = await fetch(AUTH_ADMIN, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: LOCAL_SERVICE_KEY,
      Authorization: `Bearer ${LOCAL_SERVICE_KEY}`,
    },
    body: JSON.stringify({
      email: `sprint-${crypto.randomUUID()}@arc21.test`,
      password: "sprint-password-123",
      email_confirm: true,
    }),
  });
  const body = (await response.json()) as { id?: string };
  if (!body.id) throw new Error(`could not create a test account: ${JSON.stringify(body)}`);
  return body.id;
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
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = raw;
  }
  return { status: response.status, body: parsed };
}

/**
 * A wallet balance, or a THROW.
 *
 * A helper that reads something must never return a sentinel: `-1` from an
 * earlier version of this reader turned a harness fault into
 * "expected 25200 to be 199" and cost three runs.
 */
async function walletOf(token: string): Promise<number> {
  const response = await fetch(`${REST}/wallets?select=balance`, {
    headers: { apikey: LOCAL_SERVICE_KEY, Authorization: `Bearer ${token}` },
  });
  const rows = (await response.json()) as Array<{ balance: number }>;
  const balance = rows[0]?.balance;
  if (typeof balance !== "number") {
    throw new Error(`could not read a wallet: ${JSON.stringify(rows)}`);
  }
  return balance;
}

const deps: SprintDeps = {
  call: (fn, token, body) => call(fn, token, body) as never,
  rpc,
  createUser,
  signToken,
};

const iso = () => new Date().toISOString();
const register = (token: string) =>
  call("create-session", token, {
    action: "REGISTER_SPRINT",
    clientRequestId: crypto.randomUUID(),
    clientSentAt: iso(),
  });
const withdraw = (token: string) =>
  call("create-session", token, {
    action: "WITHDRAW_SPRINT",
    clientRequestId: crypto.randomUUID(),
    clientSentAt: iso(),
  });

/**
 * Runs SQL against the local database container.
 *
 * Test fixture only, and used for exactly one thing: putting the tournament into
 * a standing that a fair shoe will not produce to order. Nothing here decides an
 * outcome — the server's own boundary reads the state and makes every decision
 * that follows.
 */
function sql(statement: string): string {
  return execFileSync(
    "docker",
    ["exec", "supabase_db_arc21", "psql", "-U", "postgres", "-d", "postgres", "-tAc", statement],
    { encoding: "utf8" },
  ).trim();
}

/** Sets one seat's stack in the authoritative engine state. */
function setStack(gameId: string, seatIndexInEngine: number, stack: number): void {
  sql(
    `update private.game_state_private
     set engine_state = jsonb_set(engine_state, '{seats,${seatIndexInEngine},stack}', '${stack}')
     where game_session_id = '${gameId}'`,
  );
}

/** Where a seat currently sits in the ENGINE's order, which the button rotates. */
function engineIndexOf(table: SprintTable, seatId: string): number {
  return table.state.seats.findIndex((seat) => seat.seatId === seatId);
}

function tournamentRow(tournamentId: string): {
  status: string;
  scheduled_hands_played: number;
  tie_break_hands_used: number;
  tie_break_boundary: number | null;
  initial_button: number | null;
} {
  const raw = sql(
    `select json_build_object(
       'status', status, 'scheduled_hands_played', scheduled_hands_played,
       'tie_break_hands_used', tie_break_hands_used,
       'tie_break_boundary', tie_break_boundary, 'initial_button', initial_button)
     from public.tournaments where id = '${tournamentId}'`,
  );
  return JSON.parse(raw);
}

function entryRows(tournamentId: string): Array<{
  id: string;
  user_id: string;
  status: string;
  chips: number;
  placement: number | null;
  eliminated_after_hand: number | null;
  in_tie_break: boolean;
  prize_chips: number;
  prize_xp: number;
}> {
  const raw = sql(
    `select coalesce(json_agg(json_build_object(
       'id', id, 'user_id', user_id, 'status', status, 'chips', chips,
       'placement', placement, 'eliminated_after_hand', eliminated_after_hand,
       'in_tie_break', in_tie_break, 'prize_chips', prize_chips, 'prize_xp', prize_xp)), '[]')
     from public.tournament_entries where tournament_id = '${tournamentId}'`,
  );
  return JSON.parse(raw);
}

/** Prize ledger rows for one tournament, read as the service role. */
function prizeLedger(tournamentId: string): Array<{ user_id: string; delta: number; reason: string }> {
  const raw = sql(
    `select coalesce(json_agg(json_build_object(
       'user_id', user_id, 'delta', delta, 'reason', reason)), '[]')
     from public.wallet_ledger
     where reference_id = '${tournamentId}' and reason in ('tournament_prize', 'tournament_refund')`,
  );
  return JSON.parse(raw);
}

const suite = stackUp ? describe : describe.skip;

// ---------------------------------------------------------------------------

suite("sprint entry is server-authoritative and exactly once", () => {
  it("publishes the same format the server enforces", async () => {
    /*
     * `sprint_format()` is what a player reads BEFORE spending 500 chips, and
     * `SPRINT` is what the server enforces afterwards. Two sources of truth on
     * the one screen where being wrong costs somebody chips, so they are
     * compared directly rather than each being pinned to the same literals in
     * two suites that never meet.
     */
    const format = ((await rpc(signToken(await createUser()), "sprint_format")).body as Array<{
      seats: number;
      scheduled_hands: number;
      starting_chips: number;
      entry_fee_chips: number;
      min_bet: number;
      early_max_bet: number;
      late_max_bet: number;
      late_bets_from: number;
      elimination_hand: number;
      prize_structure: Array<{ placement: number; chips: number; xp: number }>;
    }>)[0]!;

    expect(format.seats).toBe(SPRINT.seats);
    expect(format.scheduled_hands).toBe(SPRINT.scheduledHands);
    expect(format.starting_chips).toBe(SPRINT.startingStack);
    expect(format.entry_fee_chips).toBe(SPRINT.entryFee);
    expect(format.min_bet).toBe(SPRINT.minBet);
    expect(format.early_max_bet).toBe(SPRINT.earlyMaxBet);
    expect(format.late_max_bet).toBe(SPRINT.lateMaxBet);
    expect(format.late_bets_from).toBe(SPRINT.lateBetsFromHand);
    expect(format.elimination_hand).toBe(SPRINT.eliminationHand);

    const chips = format.prize_structure
      .slice()
      .sort((a, b) => a.placement - b.placement)
      .map((prize) => prize.chips);
    expect(chips).toEqual([...SPRINT.prizeChips]);
    const xp = format.prize_structure
      .slice()
      .sort((a, b) => a.placement - b.placement)
      .map((prize) => prize.xp);
    expect(xp).toEqual([...SPRINT.prizeXp]);
  }, 60_000);

  it("seats four genuine players on equal stacks and debits each of them once", async () => {
    const table = await openSprintTable(deps, walletOf);

    expect(table.players).toHaveLength(4);
    expect(new Set(table.players.map((player) => player.userId)).size).toBe(4);
    expect(new Set(table.players.map((player) => player.seatId)).size).toBe(4);
    expect(table.state.seats).toHaveLength(4);
    for (const seat of table.state.seats) expect(seat.stack).toBe(10_000);

    for (const player of table.players) {
      expect(await walletOf(player.token)).toBe(player.walletBefore - 500);
    }

    // One ledger row per player, and it is the entry fee.
    const entries = sql(
      `select count(*) from public.wallet_ledger
       where reference_id = '${table.tournamentId}' and reason = 'tournament_entry'`,
    );
    expect(Number(entries)).toBe(4);
  }, 180_000);

  it("charges nothing for a retry carrying a fresh request id", async () => {
    const table = await openSprintTable(deps, walletOf);
    const player = table.players[0]!;

    const retry = await register(player.token);
    expect(retry.status).toBe(200);
    expect(retry.body.entryFee).toBe(0);
    expect(await walletOf(player.token)).toBe(player.walletBefore - 500);
  }, 180_000);

  it("refuses a player who already holds a live seat somewhere else", async () => {
    /*
     * MEASURED BEFORE THE GUARD EXISTED: an account holding a live solo table
     * registered, its field filled, and the server dealt it a second live seat.
     * `OPEN` refuses this exact thing with SESSION_ALREADY_ACTIVE; registration
     * did not, and the resulting second seat made `my_active_session()` name
     * only the newer of the two — losing the address of a table with the
     * player's buy-in still in escrow.
     */
    const token = signToken(await createUser());
    const opened = await call("create-session", token, {
      action: "OPEN",
      clientRequestId: crypto.randomUUID(),
      clientSentAt: iso(),
      tier: "casual",
    });
    expect(opened.status).toBe(200);

    const refused = await register(token);
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe("SESSION_ALREADY_ACTIVE");

    // And nothing was charged for the refusal.
    const balance = await walletOf(token);
    const again = await register(token);
    expect(again.status).toBe(409);
    expect(await walletOf(token)).toBe(balance);
  }, 120_000);

  it("refuses a table to a player still waiting for a tournament to fill", async () => {
    /*
     * The other direction of the same invariant, and the one that is reached by
     * SOMEBODY ELSE'S command: the fourth registrant's request seats the whole
     * field without asking the other three. A player who registered and then
     * opened a solo table would be given a second live seat by a stranger.
     */
    await drainWaitingSprints(deps);
    const token = signToken(await createUser());
    const entered = await register(token);
    expect(entered.status).toBe(200);
    expect(entered.body.gameId).toBeNull();

    const refused = await call("create-session", token, {
      action: "OPEN",
      clientRequestId: crypto.randomUUID(),
      clientSentAt: iso(),
      tier: "casual",
    });
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe("SESSION_ALREADY_ACTIVE");

    // The refusal names something the player can actually do: leave the queue.
    const left = await withdraw(token);
    expect(left.status).toBe(200);
    const nowOpened = await call("create-session", token, {
      action: "OPEN",
      clientRequestId: crypto.randomUUID(),
      clientSentAt: iso(),
      tier: "casual",
    });
    expect(nowOpened.status).toBe(200);
  }, 120_000);
});

// ---------------------------------------------------------------------------

suite("leaving the sprint queue refunds through the ledger", () => {
  it("returns the entry fee once, and only once", async () => {
    await drainWaitingSprints(deps);
    const token = signToken(await createUser());
    const before = await walletOf(token);

    const entered = await register(token);
    expect(entered.status).toBe(200);
    expect(entered.body.entryFee).toBe(500);
    expect(await walletOf(token)).toBe(before - 500);
    const tournamentId = entered.body.tournamentId as string;

    const left = await withdraw(token);
    expect(left.status).toBe(200);
    expect(left.body.status).toBe("sprint_withdrawn");
    expect(left.body.refundChips).toBe(500);
    // A lone registrant leaving empties the tournament, so the server closes it.
    expect(left.body.tournamentCancelled).toBe(true);
    expect(await walletOf(token)).toBe(before);

    // A second withdrawal has nothing to withdraw — the entry is gone from the
    // caller's live lookup — and cannot mint a second refund.
    const again = await withdraw(token);
    expect(again.status).toBe(403);
    expect(again.body.code).toBe("NOT_A_PARTICIPANT");
    expect(await walletOf(token)).toBe(before);

    const refunds = prizeLedger(tournamentId).filter((row) => row.reason === "tournament_refund");
    expect(refunds).toHaveLength(1);
    expect(refunds[0]?.delta).toBe(500);

    expect(tournamentRow(tournamentId).status).toBe("cancelled");
    // Nothing left to find, so the screen offers a fresh entry rather than a
    // tournament that will never be dealt.
    expect((await rpc(token, "my_sprint_entry")).body).toEqual([]);
  }, 120_000);

  it("refuses a withdrawal once the cards are out, and takes nothing for trying", async () => {
    const table = await openSprintTable(deps, walletOf);
    const player = table.players[0]!;
    const before = await walletOf(player.token);

    const refused = await withdraw(player.token);
    // SESSION_BUSY, not a flat refusal: the entry resolves itself when the
    // tournament finishes. A player must not be able to buy out of a tournament
    // they are losing.
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe("SESSION_BUSY");
    expect(await walletOf(player.token)).toBe(before);
  }, 180_000);
});

// ---------------------------------------------------------------------------

suite("tournament betting is sequential, visible and bounded", () => {
  it("takes bets one seat at a time, in button order, and refuses anybody else", async () => {
    const table = await openSprintTable(deps, walletOf);
    expect(table.state.phase).toBe("BETTING_OPEN");

    const order = table.state.seats.map((seat) => seat.seatId);
    const bettor = table.state.activeSeatId;
    expect(bettor).toBe(order[0]);

    // Everybody else is offered nothing at all — not a disabled control, no
    // bounds to draw a chip tray from.
    for (const seatId of order.slice(1)) {
      const legal = table.state.legalActions[seatId];
      expect(legal?.canPlaceBet).toBe(false);
      expect(legal?.canLockBet).toBe(false);
      expect(legal?.betBounds ?? null).toBeNull();
    }
    expect(table.state.legalActions[bettor!]?.betBounds).toEqual({
      min: 100,
      max: 2_000,
      increment: 10,
    });

    const outOfTurn = table.players.findIndex((player) => player.seatId !== bettor);
    const placed = await sendSprintCommand(deps, table, outOfTurn, "PLACE_BET", { amount: 500 });
    expect(placed.status).toBe(422);
    expect(placed.body.code).toBe("NOT_YOUR_TURN");
    const locked = await sendSprintCommand(deps, table, outOfTurn, "LOCK_BET");
    expect(locked.status).toBe(422);
    expect(locked.body.code).toBe("NOT_YOUR_TURN");

    // In turn, and the turn moves one seat along.
    const mine = playerHoldingSeat(table, bettor);
    const deadlineBefore = table.state.deadlineAt;
    await sendSprintCommand(deps, table, mine, "PLACE_BET", { amount: 300 });
    const accepted = await sendSprintCommand(deps, table, mine, "LOCK_BET");
    expect(accepted.status).toBe(200);
    expect(table.state.activeSeatId).toBe(order[1]);

    // Each bettor gets their own clock: "7 seconds/person", not seven seconds
    // between four people.
    expect(table.state.deadlineAt).not.toBe(deadlineBefore);

    // VISIBLE. The committed bet is on the snapshot every seat reads, which is
    // the whole reason the format bets in turn.
    const committed = table.state.seats.find((seat) => seat.seatId === bettor);
    expect(committed?.originalBet).toBe(300);
    expect(committed?.betLocked).toBe(true);
  }, 180_000);

  it("rejects a bet below the minimum, above the ceiling, or off the increment", async () => {
    const table = await openSprintTable(deps, walletOf);
    const bettor = table.state.activeSeatId!;
    const index = playerHoldingSeat(table, bettor);

    for (const [amount, code] of [
      [90, "BET_BELOW_MINIMUM"],
      [2_010, "BET_ABOVE_MAXIMUM"],
      [155, "BET_NOT_MULTIPLE_OF_INCREMENT"],
    ] as const) {
      const result = await sendSprintCommand(deps, table, index, "PLACE_BET", { amount });
      expect(result.status).toBe(422);
      expect(result.body.code).toBe(code);
    }

    // The refusals changed nothing: the seat is still the bettor with no bet.
    expect(table.state.activeSeatId).toBe(bettor);
    expect(table.state.seats.find((seat) => seat.seatId === bettor)?.originalBet).toBe(0);
  }, 180_000);

  it("cannot be made to stake more than the seat holds", async () => {
    const table = await openSprintTable(deps, walletOf);
    const bettor = table.state.activeSeatId!;
    setStack(table.gameId, engineIndexOf(table, bettor), 400);

    // Re-read: the fixture changed the authoritative state under the snapshot.
    const resync = await sendSprintCommand(deps, table, 0, "RESOLVE_TIMEOUT");
    expect(resync.status).toBeGreaterThanOrEqual(200);

    const index = playerHoldingSeat(table, bettor);
    const tooBig = await sendSprintCommand(deps, table, index, "PLACE_BET", { amount: 1_000 });
    expect(tooBig.status).toBe(422);
    expect(["INSUFFICIENT_STACK", "BET_ABOVE_MAXIMUM"]).toContain(tooBig.body.code);
  }, 180_000);
});

// ---------------------------------------------------------------------------

suite("a whole sprint tournament", () => {
  it("plays twelve hands, eliminates after six, places everyone and pays once", async () => {
    const table = await openSprintTable(deps, walletOf);
    const tournamentId = table.tournamentId;

    const ceilings: number[] = [];
    const buttons: string[] = [];
    const bettingOrders: string[][] = [];
    let advancedByTimeoutOnce = false;

    /*
     * Read through a call, not a property. `playSprintHand` replaces
     * `table.state` and TypeScript cannot see that, so a literal comparison
     * earlier in the loop narrows the phase for the rest of the body and the
     * later checks become "comparisons with no overlap".
     */
    const phaseNow = (): string => table.state.phase;

    for (let hand = 1; hand <= 24; hand += 1) {
      if (phaseNow() !== "BETTING_OPEN") break;

      /*
       * The button is the first seat in the engine's order — that array IS the
       * order, and rotating it is how the format moves the button.
       *
       * The first BETTOR is the first seat clockwise from the button that is
       * still in the hand. Those are the same seat until somebody is eliminated
       * after hand six, at which point the button keeps rotating over all four
       * positions and an eliminated seat simply has no bet to place. Asserting
       * they are always identical fails on hand seven, which is the format
       * working rather than a defect.
       */
      buttons.push(table.state.seats[0]!.seatId);
      const expectedOrder = table.state.seats
        .filter((seat) => !seat.sittingOut)
        .map((seat) => seat.seatId);
      expect(table.state.activeSeatId).toBe(expectedOrder[0]);

      const bettor = table.state.activeSeatId!;
      ceilings.push(table.state.legalActions[bettor]?.betBounds?.max ?? 0);

      const asked: string[] = [];
      // Distinct bets so the stacks diverge and the elimination has something to
      // bite on. Keyed by seat so a rotated order still bets differently.
      const bets: Record<string, number> = {};
      for (const [index, seat] of table.state.seats.entries()) {
        bets[seat.seatId] = [100, 200, 400, 800][index] ?? 100;
      }
      await playSprintHand(deps, table, { bets, onBet: (seatId) => asked.push(seatId) });
      // The server asked for the bets in exactly the order the button set, one
      // seat at a time, with nobody asked twice and nobody skipped.
      expect(asked).toEqual(expectedOrder);
      bettingOrders.push(asked);

      // No coaching in a ranked tournament: the server never attaches advice.
      expect((table.state as unknown as { advice?: unknown }).advice ?? null).toBeNull();

      if (phaseNow() === "SESSION_COMPLETE") break;

      /*
       * ADVANCE ONE HAND BY LETTING THE REST WINDOW LAPSE.
       *
       * This is the regression for the boundary defect: before it was fixed the
       * server ran `resolveHandBoundary` only for `NEXT_HAND`, so a settlement
       * timeout dealt the next hand with no boundary at all — the scheduled hand
       * count stayed put and the tournament could never finish. Done once rather
       * than every hand because each one costs the full eight-second window.
       */
      if (!advancedByTimeoutOnce && table.state.deadlineAt) {
        const wait = Date.parse(table.state.deadlineAt) - Date.now() + 1_500;
        if (wait > 0 && wait < 15_000) {
          await new Promise((resolve) => setTimeout(resolve, wait));
          const before = tournamentRow(tournamentId).scheduled_hands_played;
          const resolved = await sendSprintCommand(deps, table, 0, "RESOLVE_TIMEOUT");
          expect(resolved.status).toBe(200);
          expect(tournamentRow(tournamentId).scheduled_hands_played).toBe(before + 1);
          advancedByTimeoutOnce = true;
          continue;
        }
      }

      if (!(await advanceSprintHand(deps, table))) break;
    }

    expect(advancedByTimeoutOnce).toBe(true);
    expect(phaseNow()).toBe("SESSION_COMPLETE");

    // --- The structure -----------------------------------------------------
    const row = tournamentRow(tournamentId);
    expect(row.status).toBe("completed");
    expect(row.scheduled_hands_played).toBe(12);
    expect(row.initial_button).not.toBeNull();

    // The ceiling opens up at the ninth SCHEDULED hand. Counting distinct values
    // rather than indexes, because a sudden-death hand is an extra hand at its
    // boundary and carries that boundary's ceiling.
    expect(ceilings[0]).toBe(2_000);
    expect(ceilings[ceilings.length - 1]).toBe(5_000);
    expect(new Set(ceilings)).toEqual(new Set([2_000, 5_000]));

    // The button moved every hand, and never repeated consecutively.
    for (let index = 1; index < buttons.length; index += 1) {
      expect(buttons[index]).not.toBe(buttons[index - 1]);
    }

    // Twelve scheduled hands were actually played and bet on.
    expect(bettingOrders).toHaveLength(12);
    // Four bettors before the elimination, three after it.
    expect(bettingOrders.slice(0, 6).every((order) => order.length === 4)).toBe(true);
    expect(bettingOrders.slice(6).every((order) => order.length === 3)).toBe(true);

    // --- The result --------------------------------------------------------
    const entries = entryRows(tournamentId);
    expect(entries).toHaveLength(4);
    for (const entry of entries) expect(entry.placement).not.toBeNull();
    expect(new Set(entries.map((entry) => entry.placement))).not.toEqual(new Set([null]));

    const eliminated = entries.filter((entry) => entry.status === "eliminated");
    expect(eliminated).toHaveLength(1);
    expect(eliminated[0]?.eliminated_after_hand).toBe(6);

    // Placements are a permutation of 1..4 unless a tie shared one, in which
    // case competition ranking skips the slots the tie occupied.
    const places = entries.map((entry) => entry.placement!).sort((a, b) => a - b);
    expect(places[0]).toBe(1);
    expect(places.every((place) => place >= 1 && place <= 4)).toBe(true);

    // --- The chips ---------------------------------------------------------
    const paid = entries.reduce((total, entry) => total + entry.prize_chips, 0);
    expect(paid).toBeLessThanOrEqual(3_500);

    let netToWallets = 0;
    for (const player of table.players) {
      netToWallets += (await walletOf(player.token)) - player.walletBefore;
    }
    // 2,000 of fees out, the prize schedule back in. Tournament STACKS never
    // reach a wallet in either direction.
    expect(netToWallets).toBe(paid - 2_000);

    // Exactly one ledger row per paid placement, ever.
    const prizes = prizeLedger(tournamentId).filter((r) => r.reason === "tournament_prize");
    const byUser = new Map<string, number>();
    for (const prize of prizes) byUser.set(prize.user_id, (byUser.get(prize.user_id) ?? 0) + 1);
    for (const count of byUser.values()) expect(count).toBe(1);
    expect(prizes.reduce((total, prize) => total + prize.delta, 0)).toBe(paid);

    // --- The prize cannot be paid twice ------------------------------------
    /*
     * Replaying the command that settled it, and asking every other seat to
     * advance the finished table, must move no chips. The gate is the
     * tournament's `completed` status plus the ledger's unique idempotency key
     * — `sprint_prize:<tournamentId>:<userId>` exists at most once whatever this
     * is asked to do.
     */
    for (const [index] of table.players.entries()) {
      await sendSprintCommand(deps, table, index, "NEXT_HAND");
    }
    const afterReplay = prizeLedger(tournamentId).filter((r) => r.reason === "tournament_prize");
    expect(afterReplay).toHaveLength(prizes.length);

    let netAfter = 0;
    for (const player of table.players) {
      netAfter += (await walletOf(player.token)) - player.walletBefore;
    }
    expect(netAfter).toBe(netToWallets);

    // --- And the player can read the result --------------------------------
    /*
     * `my_sprint_entry` used to filter on `registering`/`running`, so the result
     * disappeared in the same transaction that created it: the Sprint screen
     * offered a fresh entry with no placement and no prize anywhere on it.
     */
    const survivor = table.players.find(
      (player) => entries.find((entry) => entry.user_id === player.userId)?.status !== "eliminated",
    )!;
    const lookup = (await rpc(survivor.token, "my_sprint_entry")).body as Array<{
      tournament_id: string;
      tournament_status: string;
      placement: number | null;
    }>;
    expect(lookup[0]?.tournament_id).toBe(tournamentId);
    expect(lookup[0]?.tournament_status).toBe("completed");
    expect(lookup[0]?.placement).not.toBeNull();

    const standings = (await rpc(survivor.token, "sprint_standings", {
      p_tournament_id: tournamentId,
    })).body as Array<{ placement: number | null; prize_chips: number }>;
    expect(standings).toHaveLength(4);
    for (const standing of standings) expect(standing.placement).not.toBeNull();

    // --- A finished tournament does not block the next one -----------------
    const rematch = await register(survivor.token);
    expect(rematch.status).toBe(200);
    expect(rematch.body.entryFee).toBe(500);
    expect(rematch.body.tournamentId).not.toBe(tournamentId);
  }, 600_000);
});

// ---------------------------------------------------------------------------

suite("boundaries a fair shoe will not produce to order", () => {
  /**
   * Plays hands until the tournament has just settled its `handsToPlay`-th, then
   * hands back control WITHOUT advancing — so a caller can set up a standing and
   * then let the server's boundary decide.
   */
  async function playUpTo(table: SprintTable, handsToPlay: number): Promise<void> {
    for (let hand = 1; hand <= handsToPlay; hand += 1) {
      expect(table.state.phase).toBe("BETTING_OPEN");
      await playSprintHand(deps, table);
      if (hand < handsToPlay) {
        expect(await advanceSprintHand(deps, table)).toBe(true);
      }
    }
  }

  it("plays sudden death when the elimination boundary ties", async () => {
    const table = await openSprintTable(deps, walletOf);

    // Jump to the hand-six boundary: the scheduled counter is what the boundary
    // reads, and playing five real hands to reach it proves nothing this case is
    // about.
    sql(
      `update public.tournaments set scheduled_hands_played = 5 where id = '${table.tournamentId}'`,
    );
    await playUpTo(table, 1);

    // Two seats tied for the lowest stack. Constructed, because a fair shoe will
    // not produce it on demand — and retrying until it does is the flake this
    // project spent two phases learning to refuse.
    const order = table.state.seats.map((seat) => seat.seatId);
    setStack(table.gameId, 0, 12_000);
    setStack(table.gameId, 1, 12_000);
    setStack(table.gameId, 2, 8_000);
    setStack(table.gameId, 3, 8_000);

    expect(await advanceSprintHand(deps, table)).toBe(true);

    const row = tournamentRow(table.tournamentId);
    expect(row.scheduled_hands_played).toBe(6);
    expect(row.tie_break_boundary).toBe(6);
    // Nobody goes out on a tie: the boundary has to be played out first.
    const beforeTieBreak = entryRows(table.tournamentId);
    expect(beforeTieBreak.filter((entry) => entry.status === "eliminated")).toHaveLength(0);
    expect(beforeTieBreak.filter((entry) => entry.in_tie_break)).toHaveLength(2);

    // Only the tied players are dealt in, and the sudden-death hand carries hand
    // six's ceiling rather than hand seven's.
    const playing = table.state.seats.filter((seat) => !seat.sittingOut);
    expect(playing).toHaveLength(2);
    expect(new Set(playing.map((seat) => seat.seatId))).toEqual(new Set([order[2], order[3]]));
    const bettor = table.state.activeSeatId!;
    expect(table.state.legalActions[bettor]?.betBounds?.max).toBe(2_000);

    // Break the tie deliberately, then let the server resolve the boundary.
    await playSprintHand(deps, table);
    setStack(table.gameId, engineIndexOf(table, order[2]!), 9_000);
    setStack(table.gameId, engineIndexOf(table, order[3]!), 7_000);
    expect(await advanceSprintHand(deps, table)).toBe(true);

    const after = tournamentRow(table.tournamentId);
    // A sudden-death hand is an EXTRA hand at the boundary, not hand seven.
    expect(after.scheduled_hands_played).toBe(6);
    expect(after.tie_break_boundary).toBeNull();
    expect(after.tie_break_hands_used).toBe(1);

    const entries = entryRows(table.tournamentId);
    const out = entries.filter((entry) => entry.status === "eliminated");
    expect(out).toHaveLength(1);
    expect(out[0]?.eliminated_after_hand).toBe(6);
    expect(entries.every((entry) => !entry.in_tie_break)).toBe(true);

    // Seating order is not corrupted by the elimination: four seats, same ids.
    expect(new Set(table.state.seats.map((seat) => seat.seatId))).toEqual(new Set(order));
  }, 600_000);

  it("eliminates a player who can no longer cover the minimum bet", async () => {
    const table = await openSprintTable(deps, walletOf);
    await playUpTo(table, 1);

    const broke = table.state.seats[2]!.seatId;
    setStack(table.gameId, engineIndexOf(table, broke), 40);

    expect(await advanceSprintHand(deps, table)).toBe(true);

    const entries = entryRows(table.tournamentId);
    const out = entries.filter((entry) => entry.status === "eliminated");
    expect(out).toHaveLength(1);
    // Out at the hand that was just played, well before the hand-six boundary:
    // "if a player already became unable to make minimum bet before hand six,
    // they are already eliminated".
    expect(out[0]?.eliminated_after_hand).toBe(1);
    expect(tournamentRow(table.tournamentId).scheduled_hands_played).toBe(1);

    // The seat is out of the hand and is never staked again.
    const seat = table.state.seats.find((candidate) => candidate.seatId === broke);
    expect(seat?.sittingOut).toBe(true);
    expect(seat?.connected).toBe(false);
    // And the other three carry on, with the button still rotating over four.
    expect(table.state.seats).toHaveLength(4);
    expect(table.state.activeSeatId).not.toBe(broke);
  }, 600_000);

  it("plays sudden death for a tie at the top, then settles a terminal result", async () => {
    const table = await openSprintTable(deps, walletOf);

    sql(
      `update public.tournaments set scheduled_hands_played = 11 where id = '${table.tournamentId}'`,
    );
    await playUpTo(table, 1);

    const order = table.state.seats.map((seat) => seat.seatId);
    setStack(table.gameId, 0, 14_000);
    setStack(table.gameId, 1, 14_000);
    setStack(table.gameId, 2, 6_000);
    setStack(table.gameId, 3, 6_000);

    expect(await advanceSprintHand(deps, table)).toBe(true);

    const atFinal = tournamentRow(table.tournamentId);
    expect(atFinal.scheduled_hands_played).toBe(12);
    expect(atFinal.tie_break_boundary).toBe(12);
    expect(atFinal.status).toBe("running");
    // The final hand's ceiling, because a tie-break hand carries its boundary's.
    expect(table.state.legalActions[table.state.activeSeatId!]?.betBounds?.max).toBe(5_000);

    // Only the two leaders play it.
    expect(table.state.seats.filter((seat) => !seat.sittingOut)).toHaveLength(2);

    await playSprintHand(deps, table);
    setStack(table.gameId, engineIndexOf(table, order[0]!), 15_000);
    setStack(table.gameId, engineIndexOf(table, order[1]!), 13_000);
    await advanceSprintHand(deps, table);

    const settled = tournamentRow(table.tournamentId);
    expect(settled.status).toBe("completed");
    expect(settled.tie_break_hands_used).toBe(1);

    const entries = entryRows(table.tournamentId);
    expect(entries).toHaveLength(4);
    for (const entry of entries) expect(entry.placement).not.toBeNull();

    const winner = entries.find((entry) => entry.placement === 1);
    expect(winner?.prize_chips).toBe(2_000);
    const total = entries.reduce((sum, entry) => sum + entry.prize_chips, 0);
    expect(total).toBeLessThanOrEqual(3_500);

    // Deterministic termination: the session is over and no further hand exists.
    expect(table.state.phase).toBe("SESSION_COMPLETE");
  }, 600_000);
});

// ---------------------------------------------------------------------------

suite("adversarial commands against a live tournament", () => {
  it("answers a stale command with the snapshot and applies nothing", async () => {
    const table = await openSprintTable(deps, walletOf);
    const bettor = table.state.activeSeatId!;
    const index = playerHoldingSeat(table, bettor);

    const stale = await call("game-command", table.players[index]!.token, {
      gameId: table.gameId,
      clientActionId: crypto.randomUUID(),
      type: "PLACE_BET",
      payload: { amount: 500 },
      expectedVersion: table.state.version - 1,
      clientSentAt: iso(),
    });
    expect(stale.status).toBe(200);
    expect(stale.body.status).toBe("stale");
    const snapshot = stale.body.publicState as { seats: Array<{ originalBet: number }> };
    expect(snapshot.seats.every((seat) => seat.originalBet === 0)).toBe(true);
  }, 180_000);

  it("replays a repeated bet byte for byte instead of staking twice", async () => {
    const table = await openSprintTable(deps, walletOf);
    const bettor = table.state.activeSeatId!;
    const index = playerHoldingSeat(table, bettor);
    const actionId = crypto.randomUUID();

    const body = {
      gameId: table.gameId,
      clientActionId: actionId,
      type: "PLACE_BET",
      payload: { amount: 400 },
      expectedVersion: table.state.version,
      clientSentAt: iso(),
    };
    const first = await call("game-command", table.players[index]!.token, body);
    expect(first.status).toBe(200);
    const second = await call("game-command", table.players[index]!.token, body);
    expect(second.status).toBe(200);

    // A replayed payload is served from `private.game_commands` as jsonb, which
    // sorts keys by length then bytewise — so compare the PARSED body.
    expect(second.body).toEqual(first.body);
    const state = second.body.publicState as {
      version: number;
      seats: Array<{ seatId: string; originalBet: number; stack: number }>;
    };
    const seat = state.seats.find((candidate) => candidate.seatId === bettor);
    expect(seat?.originalBet).toBe(400);
    expect(seat?.stack).toBe(9_600);
  }, 180_000);

  it("lets a player who lost their client find the table again", async () => {
    const table = await openSprintTable(deps, walletOf);
    await playSprintHand(deps, table);

    /*
     * The reconnect path is `my_sprint_entry`, and it has to name the SEAT as
     * well as the game: the table screen resolves the player's own hand and
     * controls by seat id, and handed an entry id it renders a table with no
     * buttons on it.
     */
    const player = table.players[2]!;
    const row = ((await rpc(player.token, "my_sprint_entry")).body as Array<{
      game_session_id: string | null;
      game_session_seat_id: string | null;
      tournament_status: string;
    }>)[0];
    expect(row?.game_session_id).toBe(table.gameId);
    expect(row?.game_session_seat_id).toBe(player.seatId);
    expect(row?.tournament_status).toBe("running");

    // And that seat can still act: a `RESOLVE_TIMEOUT` at version 0 is the app's
    // own read-dressed-as-a-command, which returns the authoritative snapshot.
    const resync = await call("game-command", player.token, {
      gameId: table.gameId,
      clientActionId: crypto.randomUUID(),
      type: "RESOLVE_TIMEOUT",
      expectedVersion: 0,
      clientSentAt: iso(),
    });
    expect(resync.status).toBe(200);
    expect(resync.body.status).toBe("stale");
  }, 180_000);

  /**
   * WHO MAY READ AN ENTRY, measured with two real tokens.
   *
   * `sprint_standings` has always refused a non-participant — it raises 42501,
   * which PostgREST renders as HTTP 403 — and `tournament_entries` behind it did
   * not. `tournament_entries_select_visible` carried a third clause,
   * `exists (select 1 from public.profiles p where p.id = user_id)`, whose
   * reasoning was that nested access runs as the invoking role so a hidden
   * profile hides the entry. True in shape, and beside the point: `privacy`
   * DEFAULTS to `public`, so for an ordinary account the clause is simply TRUE
   * and every entry in the database was world-readable to any signed-in caller.
   * Measured before the fix: **152 rows** — `user_id`, live `chips`, `placement`
   * and `prize_chips` for every entrant — to an account created seconds earlier.
   *
   * `tests/server/rls-idor.integration.test.ts` classified the table as OWNED
   * ("a stranger must see NONE of it") and passed the whole time, because its
   * fixture never created an entry. This test is the positive half that the file
   * could not have: a real four-player tournament exists here, so the row it
   * asserts about is one somebody is actually playing.
   */
  it("shows an entry to the field and to nobody else", async () => {
    const table = await openSprintTable(deps, walletOf);
    const stranger = signToken(await createUser());
    const me = table.players[0]!;

    const readAs = async (token: string, path: string): Promise<unknown[]> => {
      const response = await fetch(`${REST}/${path}`, {
        headers: { apikey: LOCAL_SERVICE_KEY, Authorization: `Bearer ${token}` },
      });
      const raw = await response.text();
      if (response.status !== 200) {
        throw new Error(`GET ${path} answered ${response.status}: ${raw}`);
      }
      const rows = JSON.parse(raw) as unknown;
      if (!Array.isArray(rows)) throw new Error(`GET ${path} did not answer a list: ${raw}`);
      return rows;
    };

    // A competitor sees the whole field. This is load-bearing for the format —
    // bankroll-position strategy needs the other stacks — so it is asserted
    // FIRST: without it every refusal below could be a table returning nothing
    // to anybody, which is the failure mode a privacy sweep most easily hides.
    const field = await readAs(
      me.token,
      `tournament_entries?select=id,user_id,chips&tournament_id=eq.${table.tournamentId}`,
    );
    expect(field.length, "a competitor cannot see the field they are playing").toBe(
      SPRINT.seats,
    );

    // The stranger, three ways: by the tournament, by a named opponent, and with
    // no filter at all. The last is the one that matters — the leak was found by
    // asking for everything, and a filtered read is exactly what hid it.
    expect(
      await readAs(
        stranger,
        `tournament_entries?select=id&tournament_id=eq.${table.tournamentId}`,
      ),
      "a stranger read the entries of a tournament they are not in",
    ).toHaveLength(0);

    expect(
      await readAs(stranger, `tournament_entries?select=id&user_id=eq.${me.userId}`),
      "a stranger read a named player's entry",
    ).toHaveLength(0);

    expect(
      await readAs(stranger, `tournament_entries?select=id,user_id,chips,prize_chips&limit=200`),
      "a stranger enumerated tournament entries with no filter at all",
    ).toHaveLength(0);

    // And the sanctioned read path agrees, rather than being stricter than the
    // table it reads. Those two disagreeing is what the defect WAS.
    const standings = await rpc(stranger, "sprint_standings", {
      p_tournament_id: table.tournamentId,
    });
    expect(standings.status, JSON.stringify(standings.body)).toBe(403);

    const mine = await rpc(me.token, "sprint_standings", {
      p_tournament_id: table.tournamentId,
    });
    expect(mine.status).toBe(200);
    expect(Array.isArray(mine.body) ? mine.body.length : -1).toBe(SPRINT.seats);
  }, 180_000);

  it("refuses a stranger's command against a tournament table", async () => {
    const table = await openSprintTable(deps, walletOf);
    const stranger = signToken(await createUser());

    const refused = await call("game-command", stranger, {
      gameId: table.gameId,
      clientActionId: crypto.randomUUID(),
      type: "PLACE_BET",
      payload: { amount: 500 },
      expectedVersion: table.state.version,
      clientSentAt: iso(),
    });
    expect(refused.status).toBe(403);
    expect(refused.body.code).toBe("NOT_A_PARTICIPANT");
  }, 180_000);

  it("plays for a bettor who has gone, without touching anybody else's clock", async () => {
    /*
     * The host/session-disconnect case. Nothing in Arc 21 runs a long-lived game
     * process, so a lapsed deadline moves only when a connected client asks —
     * and the default is stated in advance: "Timeout bet: minimum legal bet if
     * sufficient stack".
     *
     * At a sequential table that default must apply to the CURRENT bettor alone.
     * Staking everybody at once would collapse the whole round the moment one
     * player looked away, and the players after them would never see the bets
     * they are entitled to bet against.
     */
    const table = await openSprintTable(deps, walletOf);
    const absent = table.state.activeSeatId!;
    const order = table.state.seats.map((seat) => seat.seatId);
    expect(table.state.deadlineAt).not.toBeNull();

    const wait = Date.parse(table.state.deadlineAt!) - Date.now() + 1_500;
    await new Promise((resolve) => setTimeout(resolve, Math.max(0, wait)));

    // ANOTHER player asks. The absent one sends nothing at all.
    const asker = table.players.findIndex((player) => player.seatId !== absent);
    const resolved = await sendSprintCommand(deps, table, asker, "RESOLVE_TIMEOUT");
    expect(resolved.status).toBe(200);

    const staked = table.state.seats.find((seat) => seat.seatId === absent);
    expect(staked?.betLocked).toBe(true);
    expect(staked?.originalBet).toBe(100);
    expect(staked?.stack).toBe(9_900);

    // The turn moved on, and NOBODY else was staked by the lapse.
    expect(table.state.activeSeatId).toBe(order[1]);
    for (const seatId of order.slice(1)) {
      const seat = table.state.seats.find((candidate) => candidate.seatId === seatId);
      expect(seat?.betLocked).toBe(false);
      expect(seat?.originalBet).toBe(0);
    }
  }, 180_000);

  it("settles nothing at all when the prize credit fails", async () => {
    /*
     * "Database transaction failure: rollback everything; no partial wallet
     * debit; the same idempotency ID can retry safely."
     *
     * The whole settlement — every placement, every prize, the XP beside it and
     * the tournament's own `completed` status — is written in ONE transaction
     * with the command that triggered it. This proves that by breaking the chip
     * credit on purpose and checking that nothing else survived: a tournament
     * left `completed` with no prizes would be unrecoverable, because the status
     * is the gate that stops a second settlement.
     */
    const table = await openSprintTable(deps, walletOf);
    sql(
      `update public.tournaments set scheduled_hands_played = 11 where id = '${table.tournamentId}'`,
    );
    await playSprintHand(deps, table);

    /*
     * Distinct stacks, so the final boundary SETTLES rather than playing sudden
     * death. Everybody betting the table minimum for one hand leaves two or more
     * players level far more often than not — the first version of this test hit
     * exactly that and reported "no seat's NEXT_HAND failed", which is a tie at
     * the top being resolved correctly, not a missing failure.
     */
    setStack(table.gameId, 0, 14_000);
    setStack(table.gameId, 1, 12_000);
    setStack(table.gameId, 2, 9_000);
    setStack(table.gameId, 3, 5_000);

    // Break the ledger for THIS tournament's prizes only, so nothing else on the
    // machine is affected while the trigger exists.
    sql(
      `create or replace function public.arc21_test_break_prize() returns trigger
       language plpgsql as $fn$
       begin
         if new.reason = 'tournament_prize'
            and new.reference_id = '${table.tournamentId}'::uuid then
           raise exception 'injected failure during prize settlement'
             using errcode = 'P0001';
         end if;
         return new;
       end $fn$`,
    );
    sql(
      `create trigger arc21_test_break_prize before insert on public.wallet_ledger
       for each row execute function public.arc21_test_break_prize()`,
    );

    try {
      let refused = false;
      const seen: string[] = [];
      for (const [index] of table.players.entries()) {
        const next = await sendSprintCommand(deps, table, index, "NEXT_HAND");
        seen.push(`${next.status} ${JSON.stringify(next.body).slice(0, 120)}`);
        if (next.status >= 500) {
          expect(next.body.code).toBe("INTERNAL");
          refused = true;
          break;
        }
      }
      // Names what it actually saw: a bare "expected false to be true" here is
      // the shape this project keeps mis-reading as a flake.
      expect(refused, `no seat's NEXT_HAND failed. Saw: ${seen.join(" | ")}`).toBe(true);

      // NOTHING was written: not the status, not a placement, not a prize.
      const row = tournamentRow(table.tournamentId);
      expect(row.status).toBe("running");
      const entries = entryRows(table.tournamentId);
      expect(entries.every((entry) => entry.placement === null)).toBe(true);
      expect(entries.every((entry) => entry.prize_chips === 0)).toBe(true);
      expect(prizeLedger(table.tournamentId)).toHaveLength(0);
      for (const player of table.players) {
        expect(await walletOf(player.token)).toBe(player.walletBefore - 500);
      }
    } finally {
      sql(`drop trigger if exists arc21_test_break_prize on public.wallet_ledger`);
      sql(`drop function if exists public.arc21_test_break_prize()`);
    }

    // And the retry settles it, exactly once.
    expect(await advanceSprintHand(deps, table)).toBe(true);
    const settled = tournamentRow(table.tournamentId);
    expect(settled.status).toBe("completed");
    const entries = entryRows(table.tournamentId);
    for (const entry of entries) expect(entry.placement).not.toBeNull();
    const prizes = prizeLedger(table.tournamentId).filter((r) => r.reason === "tournament_prize");
    const paid = entries.reduce((total, entry) => total + entry.prize_chips, 0);
    expect(prizes.reduce((total, prize) => total + prize.delta, 0)).toBe(paid);
    expect(new Set(prizes.map((prize) => prize.user_id)).size).toBe(prizes.length);

    // Every player is told the result, fourth place included, deduped on the
    // tournament so a replay cannot say it twice.
    const notified = sql(
      `select count(*) from public.notifications
       where kind = 'tournament_result'
         and data ->> 'tournament_id' = '${table.tournamentId}'`,
    );
    expect(Number(notified)).toBe(4);
  }, 600_000);

  it("records no ranked strategy decisions for tournament play", async () => {
    /*
     * "Do not count tournament decisions in normal basic-strategy accuracy."
     * Held by an ALLOWLIST — `ACCURACY_ELIGIBLE_MODES` names solo, public_table
     * and daily_challenge — rather than by construction, so this asserts the
     * consequence rather than the list.
     */
    const table = await openSprintTable(deps, walletOf);
    const player = table.players[0]!;
    const before = sql(
      `select coalesce(sum(decisions_total), 0) from public.player_decision_periods
       where user_id = '${player.userId}'`,
    );

    await playSprintHand(deps, table);

    const after = sql(
      `select coalesce(sum(decisions_total), 0) from public.player_decision_periods
       where user_id = '${player.userId}'`,
    );
    expect(Number(after)).toBe(Number(before));
  }, 180_000);
});
