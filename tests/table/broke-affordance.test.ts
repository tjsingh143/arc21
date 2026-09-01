/**
 * The free reset a private table owes a player who has run out of chips.
 *
 * THE DEFECT THESE PIN. `RESET_PRIVATE_STACK` was the only one of the nine
 * actions in `shared/contracts/session-command.ts` with no client caller
 * anywhere in `src`, `app` or `scripts` — contracted, implemented in
 * `create-session`, guarded three ways, given its own structured-log status,
 * and unreachable. The specification's rule is explicit: *"if a private player
 * reaches zero session chips, permit a free reset to 5,000 between hands;
 * private mode is unranked."*
 *
 * And nothing looked broken. A seat that cannot cover the minimum is sat out by
 * `openBetting`; `getLegalActions` answers `NO_ACTIONS` for a seat that is
 * sitting out; the table screen's control chain therefore falls all the way
 * through to "Waiting for the next hand." — correct-looking copy, rendered for
 * ever, at the one mode whose whole point is playing with people you know.
 *
 * "Test the CONTROL, not only the function behind it" is why this file exists
 * rather than only a test of `resetStack`. A test that calls the store action
 * proves the store action works; it proves nothing about whether a player stuck
 * at a table can reach it.
 */

import { describe, expect, it } from "vitest";

import {
  mayResetPrivateStack,
  type BrokeSeatView,
} from "../../src/features/table/index.js";

/** A connected seat, sat out for want of chips, in a private table's betting window. */
function stuck(overrides: Partial<BrokeSeatView> = {}): BrokeSeatView {
  return {
    isPrivateTable: true,
    phase: "BETTING_OPEN",
    sittingOut: true,
    connected: true,
    ...overrides,
  };
}

describe("offering a broke private seat its free reset", () => {
  it("offers it to a connected seat sat out in the betting window", () => {
    expect(mayResetPrivateStack(stuck())).toBe(true);
  });

  /**
   * THE STATE THE PLAYER WAS ACTUALLY LEFT IN, and the one that has to be true.
   *
   * `getLegalActions` returns `NO_ACTIONS` for a seat that is sitting out — no
   * bet, no action, not even `canStartNextHand` — so every other branch of the
   * screen is false here. If this predicate were false as well, the screen would
   * be exactly what shipped: a permanent "Waiting for the next hand."
   */
  it("is the only thing true of a seat with no legal action left", () => {
    const view = stuck();
    expect(mayResetPrivateStack(view)).toBe(true);
    expect(mayResetPrivateStack({ ...view, isPrivateTable: false })).toBe(false);
  });

  it("is never offered at a wallet-backed table, where it would mint chips", () => {
    // Solo, public and career tables are backed by the global wallet. A free
    // reset there is chips out of nothing, which is why the server refuses it
    // on the session's own mode — this only decides what an honest client draws.
    expect(mayResetPrivateStack(stuck({ isPrivateTable: false }))).toBe(false);
  });

  it("is not offered while a seat is playing", () => {
    expect(mayResetPrivateStack(stuck({ sittingOut: false }))).toBe(false);
  });

  /**
   * Sitting out has three causes in the engine and only one of them is "broke".
   * A DEPARTED seat — `connected` cleared by LEAVE, a closure or an elimination,
   * and never set back — is also sat out, and must not be offered chips.
   */
  it("is not offered to a seat that has departed", () => {
    expect(mayResetPrivateStack(stuck({ connected: false }))).toBe(false);
  });

  it("is offered in the betting window and nowhere else", () => {
    for (const phase of [
      "SESSION_READY",
      "INSURANCE_OFFER",
      "PLAYER_TURNS",
      "DEALER_TURN",
      "SETTLEMENT",
      "HAND_COMPLETE",
      "BETWEEN_HANDS",
      "SESSION_COMPLETE",
    ]) {
      expect(mayResetPrivateStack(stuck({ phase })), phase).toBe(false);
    }
    expect(mayResetPrivateStack(stuck({ phase: "BETTING_OPEN" }))).toBe(true);
  });
});
