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

/**
 * The modes whose chips are the table's own and whose broke seats may start
 * again: a private table and, since Astra Refresh C, an AI table.
 *
 * Mirrors `FREE_STACK_RESET_MODES` in
 * `supabase/functions/_shared/session-economics.ts`, which is the server's
 * answer and the one that is enforced; `tests/table/broke-affordance.test.ts`
 * holds the two equal. This copy decides only what an honest client draws.
 */
export const FREE_RESET_TABLE_MODES = ["private_table", "ai_table"] as const;

export function offersFreeReset(mode: string): boolean {
  return (FREE_RESET_TABLE_MODES as readonly string[]).includes(mode);
}

/** Phases and states in which the free reset is worth offering. */
export interface BrokeSeatView {
  /**
   * Whether this table's chips are the table's own — a private table or an AI
   * table, by `offersFreeReset`.
   *
   * Read from `my_active_session()`, which derives the mode server-side from
   * the session row — not from a route parameter, which a stack-resetting deep
   * link or a stale navigation can carry from the table before. The server
   * checks the mode again anyway; this decides only what an honest client draws.
   */
  readonly freeResetTable: boolean;
  /** The phase from the server's snapshot. */
  readonly phase: string;
  /** This seat's `sittingOut`, from the server's snapshot. */
  readonly sittingOut: boolean;
  /** This seat's `connected`, from the server's snapshot. */
  readonly connected: boolean;
  /**
   * Whether this seat can still put chips on the felt, or already has: the
   * server's `canPlaceBet || canLockBet` for the seat, or its `betLocked`.
   *
   * False is the broke state seen from the other side. A seat whose stack
   * cannot cover the minimum is offered neither control by `getLegalActions`,
   * and that is true BEFORE anything sits it out.
   */
  readonly canStake: boolean;
}

/**
 * May the table offer a free reset?
 *
 * Two shapes of the same stuck seat, in the betting window:
 *
 *   * `sittingOut`. The engine sets it in betting for three reasons — a
 *     competition holding a seat out of one hand, a seat that has DEPARTED, and
 *     a betting deadline that lapsed on a stack that could not cover the
 *     minimum — and only the last can be true of a connected seat at a private
 *     table, which is why `connected` is part of the question rather than
 *     assumed.
 *   * NOT sitting out, and unable to stake. Nothing sits a broke seat out except
 *     a lapsed betting clock, and an AI table carries no clock — so without this
 *     branch a player who ran out of chips there would face "Waiting for the next
 *     hand." with no deadline ever coming to change it. At a private table it is
 *     the fifteen seconds before that clock lapses, and the reset is the right
 *     offer there too: the server's own guard is "the stack cannot cover the
 *     minimum", which is exactly what an empty legal set at this phase means.
 *
 * Deliberately not offered at `HAND_COMPLETE`, where a seat that has just lost
 * its last chips still reads as playing and `getLegalActions` offers it only the
 * next hand, so the snapshot cannot yet say whether it can bet again. One beat
 * later the betting window opens and the answer is on the snapshot. Offering it
 * earlier would mean guessing, and a guess here is a "refill" button beside a
 * stack that is merely small.
 */
export function mayResetPrivateStack(view: BrokeSeatView): boolean {
  if (!view.freeResetTable) return false;
  if (view.phase !== "BETTING_OPEN") return false;
  if (!view.connected) return false;
  return view.sittingOut || !view.canStake;
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
