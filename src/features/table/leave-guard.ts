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
/**
 * Where a player goes once their seat is settled.
 *
 * THE DEAD END THIS CLOSES, photographed on a device. Leaving replays the
 * navigation action that was cancelled — a GO_BACK — and the table route is
 * often the BOTTOM of the stack: it is reached by `router.replace` from the
 * lobby, by `arc21://table/...`, by a notification, and by the resume card on a
 * cold launch. With nothing beneath it, GO_BACK is not handled at all. The
 * cash-out had committed, the seat was settled, the chips were back — and the
 * screen sat on "Reading the table…" with a dev-build banner reading "The
 * action 'GO_BACK' was not handled by any navigator", and no way off it: the
 * only control is "Leave table", which cashes out an already-settled seat and
 * dispatches the same unhandled GO_BACK again.
 *
 * So the exit is a DESTINATION when there is no history, not a direction. Home
 * rather than the lobby: a player whose table has ended is not necessarily
 * looking for another one, and Home is the only route that is always there.
 */
export const TABLE_EXIT_ROUTE = "/(tabs)/home";

/**
 * `"back"` when the stack has somewhere to return to, and the exit route when
 * it does not.
 *
 * Takes the answer rather than asking the navigator, so the rule is testable
 * without React Navigation — the same reason `shouldConfirmLeavingTable` takes
 * the preference rather than reading it.
 */
export function tableExitDestination(canGoBack: boolean): "back" | typeof TABLE_EXIT_ROUTE {
  return canGoBack ? "back" : TABLE_EXIT_ROUTE;
}

/**
 * `holdsSeat` IS THE ONE THAT WEDGED THE APP, and it is the first thing checked
 * on purpose.
 *
 * `beforeRemove` exists to stop an accidental exit from a table whose escrow is
 * still open. When the seat is already gone there is nothing to protect — and
 * asking anyway is not merely redundant, it is a trap. Photographed on a
 * device, twice: after a settled cash-out the listener cancelled the navigation
 * and asked again about a seat that no longer existed, so the screen sat on its
 * own "You are no longer at this table" notice with the table gone and NO WAY
 * OFF IT — `arc21://table/lobby` reported COMPLETED and changed nothing, because
 * every navigation away fires this listener and every firing cancelled it. Only
 * killing the app got the player out. (The first photograph caught the
 * intermediate state: a second confirmation dialog, modal, sitting over that
 * notice.)
 *
 * The store's own status is the source: `at-table` or not. Passed in rather
 * than read here, like every other input, so the rule stays testable without
 * React Native.
 */
export function mayLeaveTable(input: {
  alreadyLeaving: boolean;
  cashedOut: boolean;
  /** Whether the player still holds a live seat at this table. */
  holdsSeat: boolean;
}): boolean {
  return !input.holdsSeat || input.alreadyLeaving || input.cashedOut;
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

/**
 * One step of leaving a table, once the server has settled the seat.
 *
 * `mark-leaving` records that this screen is on its way out; the second step is
 * how it actually goes.
 */
export type TableExitStep = "mark-leaving" | "replay-back" | "replace";

/**
 * The whole exit, in order, for both of the two ways off a table.
 *
 * THE DEFECT THIS CLOSES IS AN ASYMMETRY, not a wrong answer. The screen had two
 * leave paths — the back bar's control and the `beforeRemove` listener that
 * catches Android back and a stack-resetting deep link — and each carried its
 * own copy of these steps. One copy left out `mark-leaving`. So the back bar
 * confirmed, cashed out, and navigated; `beforeRemove` then fired with
 * `alreadyLeaving: false`, cancelled the navigation and **asked a second time
 * whether to leave a table the player had already left**, quoting a stack the
 * seat no longer held. An `Alert` is modal, so the app was stuck behind it — a
 * deep link to the lobby reported COMPLETED and landed underneath.
 *
 * Photographed on the simulator, over the screen's own "You are no longer at
 * this table. Your seat is settled and anything it held has been returned."
 *
 * The point of returning a SEQUENCE rather than just the destination is that
 * `mark-leaving` is then part of the answer instead of something each caller has
 * to remember. `tests/table/leave-guard.test.ts` asserts it comes first whether
 * there is a route behind this one or not, which is the case that differed.
 */
export function tableExitSequence(canGoBack: boolean): readonly TableExitStep[] {
  return ["mark-leaving", tableExitDestination(canGoBack) === "back" ? "replay-back" : "replace"];
}
