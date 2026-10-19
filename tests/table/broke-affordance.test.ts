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
  FREE_RESET_TABLE_MODES,
  mayResetPrivateStack,
  offersFreeReset,
  type BrokeSeatView,
} from "../../src/features/table/index.js";
import {
  ALL_SESSION_MODES,
  FREE_STACK_RESET_MODES,
  WALLET_BACKED_MODES,
} from "../../supabase/functions/_shared/session-economics.js";

/**
 * A connected seat, sat out for want of chips, in a private table's betting window.
 *
 * `canStake: true` by default so that every case below which varies one field
 * from this one is about THAT field. The broke-but-not-yet-sat-out shape — the
 * only shape an AI table can produce, since it has no clock — has its own
 * section further down.
 */
function stuck(overrides: Partial<BrokeSeatView> = {}): BrokeSeatView {
  return {
    freeResetTable: true,
    phase: "BETTING_OPEN",
    sittingOut: true,
    connected: true,
    canStake: true,
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
    expect(mayResetPrivateStack({ ...view, freeResetTable: false })).toBe(false);
  });

  it("is never offered at a wallet-backed table, where it would mint chips", () => {
    // Solo, public and career tables are backed by the global wallet. A free
    // reset there is chips out of nothing, which is why the server refuses it
    // on the session's own mode — this only decides what an honest client draws.
    expect(mayResetPrivateStack(stuck({ freeResetTable: false }))).toBe(false);
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

/**
 * THE AI TABLE'S SHAPE OF THE SAME STUCK SEAT (Astra Refresh C).
 *
 * Nothing sits a broke seat out except a lapsed betting clock, and an AI table
 * carries no clock — so a player who ran out of chips there is NOT sitting out.
 * They are connected, in the betting window, and offered no bet by the engine.
 * The original predicate required `sittingOut`, so at an AI table it would never
 * have been true: "Waiting for the next hand." with no deadline ever coming to
 * change it, which is exactly the dead table this file exists to prevent.
 */
describe("offering the reset to a broke seat nothing has sat out", () => {
  /** Connected, not sitting out, and unable to put a chip on the felt. */
  const brokeAtAnAiTable = (overrides: Partial<BrokeSeatView> = {}) =>
    stuck({ sittingOut: false, canStake: false, ...overrides });

  it("offers it to a connected seat that can no longer stake the minimum", () => {
    expect(mayResetPrivateStack(brokeAtAnAiTable())).toBe(true);
  });

  it("does not offer it to a seat that can still stake, or already has", () => {
    // `canStake` is the server's `canPlaceBet || canLockBet`, or `betLocked`: a
    // seat with any of those is playing, however small its stack.
    expect(mayResetPrivateStack(brokeAtAnAiTable({ canStake: true }))).toBe(false);
  });

  it("is still never offered at a wallet-backed table", () => {
    expect(mayResetPrivateStack(brokeAtAnAiTable({ freeResetTable: false }))).toBe(false);
  });

  it("is still never offered to a seat that has left", () => {
    expect(mayResetPrivateStack(brokeAtAnAiTable({ connected: false }))).toBe(false);
  });

  it("is still offered in the betting window and nowhere else", () => {
    for (const phase of ["HAND_COMPLETE", "PLAYER_TURNS", "INSURANCE_OFFER", "SESSION_COMPLETE"]) {
      expect(mayResetPrivateStack(brokeAtAnAiTable({ phase })), phase).toBe(false);
    }
  });
});

describe("which tables offer the reset at all", () => {
  it("is exactly a private table and an AI table", () => {
    expect([...FREE_RESET_TABLE_MODES].sort()).toEqual(["ai_table", "private_table"]);
    expect(offersFreeReset("private_table")).toBe(true);
    expect(offersFreeReset("ai_table")).toBe(true);
  });

  it("agrees with the server, which is the list that is enforced", () => {
    // Two copies of one answer, compared, so the client cannot draw a control
    // the server refuses — or hide one the server would honour.
    expect([...FREE_RESET_TABLE_MODES].sort()).toEqual([...FREE_STACK_RESET_MODES].sort());
  });

  it("never names a wallet-backed mode, where a free reset would mint chips", () => {
    for (const mode of WALLET_BACKED_MODES) expect(offersFreeReset(mode), mode).toBe(false);
  });

  it("answers for every mode the server knows", () => {
    const offered = ALL_SESSION_MODES.filter((mode) => offersFreeReset(mode));
    expect(offered.sort()).toEqual(["ai_table", "private_table"]);
  });
});
