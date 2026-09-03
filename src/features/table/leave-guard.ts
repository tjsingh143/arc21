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

import { canCloseSeat, type ClosableTable } from "../../../shared/blackjack/table-closure.js";
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

/**
 * What the table says while a refused leave is being held.
 *
 * It states the two things the player needs and nothing else: that they are
 * still going, and that they do not have to do anything again. The refusal's
 * own wording cannot carry this — `notice` is cleared by the next successful
 * poll three seconds later, which is precisely why the promise it made went
 * unkept.
 */
export const LEAVING_AT_BOUNDARY_NOTICE =
  "Leaving when this hand ends. Your chips come back automatically.";

/** The way back out of it, for a player who changes their mind. */
export const STAY_AT_TABLE_LABEL = "Stay at the table";

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

/**
 * WHETHER A LEAVE THAT THE SERVER REFUSED SHOULD NOW BE COMPLETED.
 *
 * THE GAP THIS CLOSES. A player who taps "Leave table" mid-hand is refused —
 * correctly, because their wager is committed and "leaving is never a way to
 * escape a committed wager". The screen said so ("This hand is still live. Your
 * chips come back as soon as it settles") and then did nothing about it: the
 * chips came back only if the player was still watching, remembered, and tapped
 * the control a second time at the right moment. Somebody who taps leave and
 * puts the phone down stays seated at a live public table, is stood in by the
 * action timer hand after hand, and their buy-in sits in escrow — while every
 * refusal they saw had promised the opposite.
 *
 * So the intent is REMEMBERED and honoured at the first safe boundary. The
 * phase test is `canCloseSeat`, the engine's own — the same function the server
 * refuses with — so the client cannot ask for something about to be refused,
 * three seconds at a time.
 *
 * `pending` is what stops the poll firing a second cash-out over an unanswered
 * one. That would be idempotent server-side (the key is derived from
 * `gameId:seatId`), but a retry loop relying on idempotency to terminate is
 * still a loop.
 *
 * Pure, and on the testable side of the React Native wall, like everything else
 * in this file: the store owns the flag, the screen owns the wording, and this
 * owns the rule.
 */
export function shouldCompleteLeave(input: {
  /** Set when a cash-out was refused because the hand was still live. */
  leavingWhenSafe: boolean;
  /** A request is already in flight. */
  pending: boolean;
  /** The server's latest snapshot, or null before one has arrived. */
  table: ClosableTable | null;
  seatId: string;
}): boolean {
  if (!input.leavingWhenSafe || input.pending || !input.table) return false;
  return canCloseSeat(input.table, input.seatId);
}

/**
 * WHETHER THE SCREEN SHOULD NOW TAKE THE PLAYER OFF A TABLE THEY ASKED TO LEAVE.
 *
 * `shouldCompleteLeave` above answers when the STORE should send the held
 * cash-out. This answers what the SCREEN does once it has been sent and the seat
 * is gone — and the two were not connected, which is the defect.
 *
 * A cash-out refused mid-hand is held as `leavingWhenSafe` and completed by the
 * poll at the first safe boundary. That path calls `forgetTable()`; it does not
 * navigate, because navigation belongs to the screen. So the seat settled, the
 * chips came back, and the table screen re-rendered into its "Reading the
 * table…" branch and stayed there for ever: the only control left was "Leave
 * table", which cashes out an already-settled seat and goes nowhere. Measured on
 * two simulators at a public table and then reproduced with one, the wallet
 * correct throughout and the app unusable until it was force-quit.
 *
 * `askedToLeave` has to be REMEMBERED by the caller rather than read from the
 * store, because completing the leave clears `leavingWhenSafe` in the same
 * update that drops the seat: at the only moment this question can be answered,
 * the state that would justify it is already gone.
 *
 * Both conditions are needed and the seat is the one that says "now". A player
 * who asked to leave and is still seated is watching out a live hand, which is
 * exactly what the hold is for.
 */
export function shouldExitAfterHeldLeave(input: {
  /** The player asked to leave and the server held the request. */
  askedToLeave: boolean;
  /** Whether the seat is still held. */
  holdsSeat: boolean;
}): boolean {
  return input.askedToLeave && !input.holdsSeat;
}
