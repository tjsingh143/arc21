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
