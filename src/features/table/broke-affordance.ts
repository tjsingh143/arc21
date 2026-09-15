/**
 * What a table offers a seat that has run out of chips.
 *
 * THE DEFECT THIS EXISTS TO CLOSE. The specification's rule for a private
 * table is one sentence — *"if a private player reaches zero session chips,
 * permit a free reset to 5,000 between hands; private mode is unranked"* — and
 * the server has implemented it since the private-table work landed:
 * `RESET_PRIVATE_STACK` is in the wire contract, has a handler in
 * `create-session`, guards itself three ways and even has its own structured-log
 * status. **Nothing in this app had ever sent it.** It was the only action of
 * the nine in `session-command.ts` with no client caller.
 *
 * What that cost is easy to miss because nothing errors. A seat that cannot
 * cover the 20-chip minimum is sat out by `openBetting`, `getLegalActions`
 * answers `NO_ACTIONS` for a seat that is sitting out, and the table screen
 * falls through to *"Waiting for the next hand."* — hand after hand, for the
 * life of the table, at the one mode whose whole point is playing with people
 * you know. The remedy was on the other side of the wire the entire time.
 *
 * Pure and separate from the screen for the reason `CLAUDE.md` gives: test the
 * CONTROL, not only the function behind it. A test that calls `resetStack`
 * proves `resetStack` works; it proves nothing about whether anybody stuck at a
 * table can reach it.
 */

/** Phases and states in which the free reset is worth offering. */
export interface BrokeSeatView {
  /**
   * Whether this table's chips are the table's own.
   *
   * Read from `my_active_session()`, which derives the mode server-side from
   * the session row — not from a route parameter, which a stack-resetting deep
   * link or a stale navigation can carry from the table before. The server
   * checks the mode again anyway; this decides only what an honest client draws.
   */
  readonly isPrivateTable: boolean;
  /** The phase from the server's snapshot. */
  readonly phase: string;
  /** This seat's `sittingOut`, from the server's snapshot. */
  readonly sittingOut: boolean;
  /** This seat's `connected`, from the server's snapshot. */
  readonly connected: boolean;
}

/**
 * May the table offer a free reset?
 *
 * `sittingOut` during `BETTING_OPEN` is exactly the stuck state and nothing
 * else. The engine sets it there for three reasons — a competition holding a
 * seat out of one hand, a seat that has DEPARTED, and a stack that cannot cover
 * the minimum — and only the third can be true of a connected seat at a private
 * table, which is why `connected` is part of the question rather than assumed.
 *
 * Deliberately not offered at `HAND_COMPLETE`, where a seat that has just lost
 * its last chips still reads as playing: the engine has not sat it out yet, so
 * the snapshot cannot yet distinguish it from a seat about to bet again. One
 * beat later the betting window opens, the flag is set, and the offer appears
 * beside the reason for it. Offering it earlier would mean guessing, and a
 * guess here is a "refill" button beside a stack that is merely small.
 */
export function mayResetPrivateStack(view: BrokeSeatView): boolean {
  if (!view.isPrivateTable) return false;
  if (view.phase !== "BETTING_OPEN") return false;
  if (!view.connected) return false;
  return view.sittingOut;
}

/**
 * What the screen says beside the control.
 *
 * It states the two things that are surprising and the one that is reassuring:
 * these chips belong to the table, nothing is taken from or added to the
 * player's balance, and sitting out is not a punishment they have to accept.
 * The figure is deliberately absent — the amount is the server's, and a number
 * typed here would be a second copy of it.
 */
export const BROKE_AT_PRIVATE_TABLE_TITLE = "You are out of table chips";

export const BROKE_AT_PRIVATE_TABLE_BODY =
  "This table's chips are its own, so you can start again from the full amount " +
  "as often as you like. Nothing here touches your balance in either direction.";

/** The control's label. */
export const RESET_PRIVATE_STACK_LABEL = "Start again with a full stack";
