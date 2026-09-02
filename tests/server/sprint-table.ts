/**
 * The one way a server test gets a four-player Sprint Tournament.
 *
 * WHY THIS IS A MODULE. Two things about the sprint are easy to get wrong and
 * expensive to get wrong twice.
 *
 * The first is ALLOCATION. Registration deliberately fills the oldest
 * tournament still short of players — that is the matchmaking lesson applied
 * before it could be relearned, and it means a half-filled tournament left
 * behind by an earlier run SPLITS the next test's four players across two
 * tournaments and neither is dealt. `drainWaitingSprints` empties the pool
 * first. It was written for `game-command.integration.test.ts` after that flake
 * was reproduced deliberately (seed two leftover entries, watch it fail), and
 * it now lives here so there is one copy rather than one per suite.
 *
 * The second is BETTING ORDER. A tournament table bets SEQUENTIALLY: the server
 * names the current bettor in `activeSeatId`, and a bet from anybody else is
 * refused `NOT_YOUR_TURN`. So `playSprintHand` never assumes an order — it reads
 * the one the server published, which is also the only way a test can notice if
 * that order stops being enforced.
 *
 * A failure here THROWS, and names what it actually saw. A helper that reads
 * something must never return a sentinel: `-1` from a wallet reader once turned
 * a harness fault into "expected 25200 to be 199" and cost three runs.
 */

/** Calls an Edge Function as a signed-in player. Owned by the caller's suite. */
export interface FunctionCaller {
  (
    fn: string,
    token: string,
    body: Record<string, unknown>,
  ): Promise<{ status: number; body: Record<string, unknown> }>;
}

/** Calls a Postgres RPC as a signed-in player. Never as the service role. */
export interface RpcCaller {
  (
    token: string,
    name: string,
    args?: Record<string, unknown>,
  ): Promise<{ status: number; body: unknown }>;
}

/** Mints a fresh confirmed account and returns its id. */
export interface AccountFactory {
  (): Promise<string>;
}

/** Signs a token for an account id. */
export interface TokenSigner {
  (userId: string): string;
}

export interface SprintDeps {
  readonly call: FunctionCaller;
  readonly rpc: RpcCaller;
  readonly createUser: AccountFactory;
  readonly signToken: TokenSigner;
}

/** Just enough of the public snapshot for a tournament test to steer by. */
export interface SprintSnapshot {
  version: number;
  phase: string;
  handNumber: number;
  activeSeatId: string | null;
  deadlineAt: string | null;
  seats: Array<{
    seatId: string;
    stack: number;
    originalBet: number;
    betLocked: boolean;
    sittingOut: boolean;
    connected: boolean;
  }>;
  legalActions: Record<
    string,
    {
      canPlaceBet: boolean;
      canLockBet: boolean;
      canDeclineInsurance: boolean;
      canStartNextHand: boolean;
      betBounds: { min: number; max: number; increment: number } | null;
    }
  >;
}

export interface SprintPlayer {
  readonly userId: string;
  readonly token: string;
  /** The player's SEAT at the tournament table, not their entry. */
  readonly seatId: string;
  readonly entryId: string;
  readonly walletBefore: number;
}

export interface SprintTable {
  readonly tournamentId: string;
  readonly gameId: string;
  /** In registration order, which is NOT the order the button deals in. */
  readonly players: readonly SprintPlayer[];
  state: SprintSnapshot;
}

const iso = () => new Date().toISOString();
const uuid = () => globalThis.crypto.randomUUID();

const registerFor = (deps: SprintDeps, token: string) =>
  deps.call("create-session", token, {
    action: "REGISTER_SPRINT",
    clientRequestId: uuid(),
    clientSentAt: iso(),
  });

/**
 * Empties the waiting pool so the next four registrants share one tournament.
 *
 * Bounded: three throwaway players finish any one tournament, and a handful of
 * rounds clears a realistically dirty database. It uses nothing but the
 * registration responses themselves, which report `entriesFilled`, so it needs
 * no read privilege on the tournament tables.
 */
export async function drainWaitingSprints(deps: SprintDeps): Promise<void> {
  for (let round = 0; round < 12; round += 1) {
    const scout = await registerFor(deps, deps.signToken(await deps.createUser()));
    if (scout.status !== 200) return;

    const filled = scout.body.entriesFilled as number;
    const required = scout.body.seatsRequired as number;

    // This player opened a brand-new tournament, so nothing was waiting. Fill it
    // and stop: leaving it half-open would recreate the exact problem.
    for (let seat = 0; seat < required - filled; seat += 1) {
      await registerFor(deps, deps.signToken(await deps.createUser()));
    }
    if (filled === 1) return;
  }
  throw new Error("could not drain the sprint tournament pool in twelve rounds");
}

interface SprintEntryRow {
  tournament_id: string;
  entry_id: string;
  game_session_id: string | null;
  game_session_seat_id: string | null;
}

const firstRow = <T,>(value: unknown): T | null =>
  Array.isArray(value) ? ((value[0] ?? null) as T | null) : ((value ?? null) as T | null);

/**
 * Registers four fresh accounts into one tournament and returns the dealt table.
 *
 * Each player's seat id comes from `my_sprint_entry`, which is the lookup the
 * app itself uses to rejoin — the registration reply carries a seat only for the
 * fourth player, whose call is the one that deals.
 */
export async function openSprintTable(
  deps: SprintDeps,
  walletOf: (token: string) => Promise<number>,
): Promise<SprintTable> {
  await drainWaitingSprints(deps);

  const userIds: string[] = [];
  for (let index = 0; index < 4; index += 1) userIds.push(await deps.createUser());
  const tokens = userIds.map((id) => deps.signToken(id));

  const before: number[] = [];
  for (const token of tokens) before.push(await walletOf(token));

  let last: Awaited<ReturnType<FunctionCaller>> | null = null;
  for (const token of tokens) {
    const result = await registerFor(deps, token);
    if (result.status !== 200) {
      throw new Error(`REGISTER_SPRINT answered ${result.status}: ${JSON.stringify(result.body)}`);
    }
    last = result;
  }

  const tournamentId = last!.body.tournamentId as string;
  const gameId = last!.body.gameId as string | null;
  if (!gameId) {
    throw new Error(
      `four registrants did not fill one tournament: ${JSON.stringify(last!.body)}. ` +
        "The pool was drained first, so this is an allocation failure, not a leftover.",
    );
  }

  const players: SprintPlayer[] = [];
  for (const [index, token] of tokens.entries()) {
    const mine = await deps.rpc(token, "my_sprint_entry");
    const row = firstRow<SprintEntryRow>(mine.body);
    if (!row?.game_session_seat_id) {
      throw new Error(
        `my_sprint_entry gave player ${index} no seat at ${gameId}: ${JSON.stringify(mine.body)}`,
      );
    }
    players.push({
      userId: userIds[index]!,
      token,
      seatId: row.game_session_seat_id,
      entryId: row.entry_id,
      walletBefore: before[index]!,
    });
  }

  return {
    tournamentId,
    gameId,
    players,
    state: last!.body.publicState as unknown as SprintSnapshot,
  };
}

export interface CommandResult {
  status: number;
  body: Record<string, unknown>;
}

/**
 * Sends one game command as a player and folds any snapshot back into `table`.
 *
 * `expectedVersion` comes from the table's own last-known version, so a caller
 * never has to thread it — and a stale answer updates the table rather than
 * being silently discarded.
 */
export async function sendSprintCommand(
  deps: SprintDeps,
  table: SprintTable,
  playerIndex: number,
  type: string,
  payload?: Record<string, unknown>,
): Promise<CommandResult> {
  const result = await deps.call("game-command", table.players[playerIndex]!.token, {
    gameId: table.gameId,
    clientActionId: uuid(),
    type,
    ...(payload ? { payload } : {}),
    expectedVersion: table.state.version,
    clientSentAt: iso(),
  });
  const snapshot = (result.body as { publicState?: SprintSnapshot }).publicState;
  if (snapshot) table.state = snapshot;
  return result;
}

/** The index of the player holding a seat id, or -1. */
export function playerHoldingSeat(table: SprintTable, seatId: string | null): number {
  if (!seatId) return -1;
  return table.players.findIndex((player) => player.seatId === seatId);
}

export interface HandOptions {
  /**
   * What each seat bets, by seat id. Anything absent bets the table minimum.
   * Clamped into the published bounds, so a caller can ask for more than the
   * ceiling allows and get the ceiling.
   */
  readonly bets?: Readonly<Record<string, number>>;
  /** Called with each bettor's seat id in the order the SERVER asked for them. */
  readonly onBet?: (seatId: string, snapshot: SprintSnapshot) => void;
}

/**
 * Plays one hand: bets in the server's order, declines insurance, stands.
 *
 * Standing is deliberate. This helper exists to move a tournament through its
 * structure — hand counts, boundaries, placements — and a helper that hit would
 * make the chip movement depend on cards, which is the one thing a structural
 * test must not be at the mercy of.
 *
 * Throws rather than returning if the table stops somewhere unexpected, and says
 * where: an intermittent that reports "expected HAND_COMPLETE" and nothing else
 * is the shape this project has repeatedly mis-read as a flake.
 */
export async function playSprintHand(
  deps: SprintDeps,
  table: SprintTable,
  options: HandOptions = {},
): Promise<void> {
  // --- Betting, one seat at a time, in the order the server names ---------
  for (let guard = 0; guard < 12 && table.state.phase === "BETTING_OPEN"; guard += 1) {
    const seatId = table.state.activeSeatId;
    if (!seatId) {
      throw new Error(
        `BETTING_OPEN with no active bettor at hand ${table.state.handNumber}. ` +
          "A sequential table must always name one.",
      );
    }
    const index = playerHoldingSeat(table, seatId);
    if (index < 0) throw new Error(`the current bettor ${seatId} is not one of this table's players`);

    options.onBet?.(seatId, table.state);

    const bounds = table.state.legalActions[seatId]?.betBounds;
    if (!bounds) {
      throw new Error(`seat ${seatId} is the current bettor and has no bet bounds`);
    }
    const wanted = options.bets?.[seatId] ?? bounds.min;
    const amount = Math.min(Math.max(wanted, bounds.min), bounds.max);

    const placed = await sendSprintCommand(deps, table, index, "PLACE_BET", { amount });
    if (placed.status !== 200) {
      throw new Error(`PLACE_BET ${amount} for seat ${seatId} answered ${placed.status}: ${JSON.stringify(placed.body)}`);
    }
    const locked = await sendSprintCommand(deps, table, index, "LOCK_BET");
    if (locked.status !== 200) {
      throw new Error(`LOCK_BET for seat ${seatId} answered ${locked.status}: ${JSON.stringify(locked.body)}`);
    }
  }

  // --- The hand ----------------------------------------------------------
  for (let step = 0; step < 80 && table.state.phase !== "HAND_COMPLETE"; step += 1) {
    if (table.state.phase === "SESSION_COMPLETE") return;

    /*
     * INSURANCE_OFFER is one of the three places the cascade after betting can
     * stop — about one hand in thirteen, whenever the dealer shows an ace. A
     * helper that assumed PLAYER_TURNS here was the whole of an "unreproduced"
     * failure in phase 6.
     */
    if (table.state.phase === "INSURANCE_OFFER") {
      let acted = false;
      for (const [index, player] of table.players.entries()) {
        if (table.state.legalActions[player.seatId]?.canDeclineInsurance) {
          await sendSprintCommand(deps, table, index, "DECLINE_INSURANCE");
          acted = true;
        }
      }
      if (!acted) {
        throw new Error("INSURANCE_OFFER with nobody able to answer it");
      }
      continue;
    }

    if (table.state.phase === "PLAYER_TURNS") {
      const index = playerHoldingSeat(table, table.state.activeSeatId);
      if (index < 0) {
        throw new Error(`PLAYER_TURNS names seat ${table.state.activeSeatId}, which is not at this table`);
      }
      await sendSprintCommand(deps, table, index, "STAND");
      continue;
    }

    throw new Error(`unexpected phase ${table.state.phase} while playing a tournament hand`);
  }

  if (table.state.phase !== "HAND_COMPLETE" && table.state.phase !== "SESSION_COMPLETE") {
    throw new Error(`hand did not settle: phase ${table.state.phase}`);
  }
}

/**
 * Asks for the next hand, from whichever seat is still able to.
 *
 * An eliminated seat is `left`, and its commands are refused SESSION_CLOSED, so
 * "player 0 asks" stops working the moment player 0 goes out at hand six.
 * Returns false when nobody could advance it — which at a settled tournament
 * means the session is over.
 */
export async function advanceSprintHand(deps: SprintDeps, table: SprintTable): Promise<boolean> {
  for (const [index] of table.players.entries()) {
    const next = await sendSprintCommand(deps, table, index, "NEXT_HAND");
    if (next.status === 200) return true;
  }
  return false;
}
