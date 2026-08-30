/**
 * The two facts that stop a player walking away from chips in escrow.
 *
 * Leaving a table is an ECONOMIC command: `CASH_OUT` returns the remaining
 * stack to the wallet, and `app/table/[gameId].tsx` refuses to navigate if the
 * server says no. Any route removal that does NOT go through that control is a
 * buy-in left in escrow — the seat stays `active`, the wallet stays short, and
 * the screen that took the chips promised "whatever is left comes back when you
 * leave".
 *
 * There are three such removals, and one option does not cover all of them:
 *
 *   the iOS swipe-back gesture  → `TABLE_SCREEN_OPTIONS.gestureEnabled: false`
 *   the Android hardware back   → the screen's `beforeRemove` listener
 *   a deep link resetting the stack → the same listener
 *
 * Kept here, as plain values on the testable side of the React Native import
 * wall, so `tests/table/leave-guard.test.ts` can assert them. A comment saying
 * "do not remove this option" is a comment; a failing test is a guard.
 */

import { formatChips } from "../../design/format-chips.js";

/**
 * Screen options for `table/[gameId]`.
 *
 * `gestureEnabled` defaults to TRUE on an iOS native stack, and `headerShown:
 * false` does not change that — which is why the swipe stayed open after the
 * "Leave table" control was fixed to cash out.
 */
export const TABLE_SCREEN_OPTIONS = { gestureEnabled: false } as const;

/**
 * Whether a route removal may proceed.
 *
 * `cashedOut` is the server's answer, never a local guess. A refusal — mid-hand,
 * most often — keeps the player at the table with the reason on screen.
 *
 * `alreadyLeaving` is what stops the replay looping: dispatching the original
 * navigation action re-fires `beforeRemove`, and without this the second pass
 * would send a second CASH_OUT. That is idempotent server-side (the key is
 * derived from `gameId:seatId`), but a loop that relies on idempotency to
 * terminate is still a loop.
 */
export function mayLeaveTable(input: {
  alreadyLeaving: boolean;
  cashedOut: boolean;
}): boolean {
  return input.alreadyLeaving || input.cashedOut;
}

/**
 * Whether leaving this table should ask first.
 *
 * THE DEFECT THIS EXISTS TO CLOSE. `AppSettings.confirmLeavingOnlineGame` was
 * declared, defaulted to `true`, validated by the Zod schema and written to
 * disk on every save — and a full-repository grep found exactly three
 * references to it, all inside `settings.ts` itself. There was no Settings row
 * offering it and no call site reading it. A preference that governs nothing is
 * the built-but-never-connected pattern this project keeps rediscovering, and
 * this instance was the quietest kind: the stored value was real, so a blob
 * inspected on disk would have looked like a working feature.
 *
 * What it guards is not cosmetic. "Leave table" sends `CASH_OUT`, which closes
 * the seat and returns the escrowed stack — an economic command, and the only
 * one in the app a single mis-tap can fire. The control sits at the top-left of
 * the table, exactly where a thumb reaches for "back".
 *
 * `hasStack` is what keeps the prompt from becoming noise: a seat holding
 * nothing has nothing to lose by leaving, and confirming that would train
 * people to dismiss the dialog without reading it — which is how a confirmation
 * stops being one.
 *
 * Pure, and on the testable side of the React Native import wall, so the rule
 * is asserted rather than described. The dialog itself belongs to the screen.
 */
export function shouldConfirmLeavingTable(input: {
  /** `AppSettings.confirmLeavingOnlineGame`. */
  confirmEnabled: boolean;
  /** Chips still in the seat's stack, from the server's snapshot. */
  stack: number;
}): boolean {
  return input.confirmEnabled && input.stack > 0;
}

/** The dialog's own words, here so the test can assert them and the screen cannot drift. */
export const LEAVE_TABLE_CONFIRM_TITLE = "Leave this table?";

export function describeLeaveTableConfirmation(stack: number): string {
  return (
    `Your seat closes and ${formatChips(stack)} chips return to your balance. ` +
    "You cannot rejoin this table afterwards."
  );
}
