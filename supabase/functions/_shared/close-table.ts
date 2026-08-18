/**
 * Arc 21 — closing a table and returning the stack.
 *
 * Two paths reach this: a `LEAVE` command at a safe phase, and an explicit
 * `CASH_OUT`. They share one implementation and, more importantly, one
 * idempotency key — `table_cash_out:<gameId>:<seatId>` — so the two are
 * idempotent against each other as well as against themselves. A player whose
 * LEAVE response was dropped and who then taps "cash out" is credited once.
 *
 * `apply_wallet_delta` is the only thing here that moves a chip.
 */

import type { EngineState } from "../../../shared/blackjack/index.js";
import { CommandError } from "./command-errors.ts";
import type { Tx } from "./postgres-client.ts";
import { chipsCameFromWallet, isKnownSessionMode } from "./session-economics.ts";
import {
  applyWalletDelta,
  cashOutKey,
  findLedgerEntry,
  loadSession,
  seatChipsAtTable,
  walletBalance,
} from "./session-repository.ts";

export interface ClosureResult {
  /** Chips credited back to the wallet. Zero when the stack was already empty. */
  returned: number;
  walletBalance: number;
  /** True when the table ended for everyone, false when other seats remain. */
  sessionEnded: boolean;
}

/**
 * Credits the seat's remaining table stack and marks the engine state closed.
 *
 * `state` must already have had the engine's `LEAVE` applied, so any staged but
 * uncommitted bet is back in the stack. The caller persists the mutated state;
 * this function does the money and the bookkeeping that must accompany it.
 */
export async function settleTableClosure(
  tx: Tx,
  params: { gameId: string; userId: string; seatId: string; state: EngineState },
): Promise<ClosureResult> {
  const seat = params.state.seats.find((candidate) => candidate.seatId === params.seatId);
  if (!seat) throw new CommandError("INTERNAL", "seat missing from engine state at closure");

  /*
   * The mode is read here rather than accepted as an argument.
   *
   * Two call sites reach this function and a third will eventually, and the
   * consequence of one of them passing the wrong answer is minting chips. Taking
   * the fact from the session row the closure is about removes that possibility
   * instead of documenting it.
   */
  const session = await loadSession(tx, params.gameId);
  if (!session) throw new CommandError("INTERNAL", "no session row at closure");
  if (!isKnownSessionMode(session.mode)) {
    // Not "assume it is closed": a mode nobody has classified could be one whose
    // player really is owed their chips, and stranding them is not the safe
    // direction either. Fail loudly and let someone decide.
    throw new CommandError("INTERNAL", `unclassified session mode ${session.mode}`);
  }

  const owesWallet = chipsCameFromWallet(session.mode);
  const returned = owesWallet ? seatChipsAtTable(seat) : 0;
  let balance: number;

  if (returned > 0) {
    const entry = await applyWalletDelta(tx, {
      userId: params.userId,
      delta: returned,
      reason: "table_cash_out",
      idempotencyKey: cashOutKey(params.gameId, params.seatId),
      referenceId: params.gameId,
      metadata: { seatId: params.seatId, handNumber: params.state.handNumber },
    });
    balance = entry.balanceAfter;
  } else {
    balance = await walletBalance(tx, params.userId);
  }

  // The chips live in the wallet now, so the authoritative table stack must
  // read zero. Leaving it populated would have the engine state and the ledger
  // describing the same chips twice. This is session bookkeeping rather than a
  // rule change: the engine has no cash-out command because cashing out is not
  // a play, and every hand at this point is either absent or already settled.
  //
  // A closed-economy table clears the seat for the same reason even though no
  // ledger row was written: the player has left, and those chips end with them.
  seat.stack = 0;
  seat.originalBet = 0;
  seat.insuranceBet = 0;
  seat.hands = [];
  seat.connected = false;
  seat.sittingOut = true;

  /*
   * Whether the TABLE ends, as opposed to this seat.
   *
   * This used to be unconditional, and on a shared table that was wrong in a way
   * a player would feel: at a two-seat private table the host leaving set
   * SESSION_COMPLETE, and the remaining player's next command came back
   * SESSION_CLOSED with their bet already staged. A tournament makes the same
   * demand — three people must keep playing after a fourth quits.
   */
  const sessionEnded = !params.state.seats.some(
    (candidate) => candidate.seatId !== params.seatId && candidate.connected,
  );

  if (sessionEnded) {
    params.state.phase = "SESSION_COMPLETE";
    params.state.actionDeadlineAt = null;
    params.state.activeSeatIndex = null;
    params.state.activeHandIndex = null;
  }

  return { returned, walletBalance: balance, sessionEnded };
}

/**
 * The already-cashed-out answer.
 *
 * A closure that credited nothing writes no ledger row — `wallet_ledger` has a
 * `delta <> 0` CHECK — so "no row" is not proof that nothing happened. The
 * caller pairs this with the seat's `left` status to tell the two apart.
 */
export async function previousClosure(
  tx: Tx,
  gameId: string,
  seatId: string,
  userId: string,
): Promise<ClosureResult | null> {
  const entry = await findLedgerEntry(tx, cashOutKey(gameId, seatId));
  if (!entry) return null;
  if (entry.userId !== userId) {
    throw new CommandError("IDEMPOTENCY_CONFLICT", "cash-out key belongs to another account");
  }
  // A ledger row only ever exists for a wallet-backed table, and one that paid
  // out has certainly ended for this seat.
  return { returned: entry.delta, walletBalance: entry.balanceAfter, sessionEnded: true };
}
