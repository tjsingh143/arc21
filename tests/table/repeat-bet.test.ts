/**
 * Repeat must work at the tables where a player actually repeats a bet.
 *
 * THE DEFECT. `BettingBar` has always drawn three controls — Clear, Repeat,
 * Deal — and gates Repeat on `lastBet > 0`. Practice passes a real `lastBet`
 * and a real `onRepeat`. The other two tables did not:
 *
 *   app/table/[gameId].tsx     lastBet={0}   onRepeat={() => undefined}
 *   app/career/play/[slug].tsx lastBet={0}   onRepeat={() => {}}
 *
 * So the control rendered permanently disabled at every server table — Quick
 * Play, public, private, tournament, daily — and at every career node. Not a
 * dead button in the loudest sense; a worse one. It was drawn, greyed, and
 * could never become enabled, so nothing about the screen suggested the feature
 * was missing rather than merely unavailable right now.
 *
 * These are the tables where it earns its place. A career node is ten to twenty
 * hands at one stake, and an online table is where a player bets the same
 * amount hand after hand while other people take their turns.
 *
 * The specification's rule is also asserted here: a previous bet may be
 * SUGGESTED next hand and must never be silently committed. Repeat stages; the
 * player still presses Deal.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it } from "vitest";

import { useOnlineTableStore } from "../../src/features/table/online-table-store.js";
import { setTableGateway } from "../../src/features/table/online-table-store.js";
import type { PublicGameState } from "../../shared/blackjack/public-state.js";
import type { TableGateway } from "../../src/features/table/online-table-gateway.js";

const SEAT = "seat-1";
const GAME = "game-1";

function snapshot(overrides: { stack?: number; max?: number } = {}): PublicGameState {
  const stack = overrides.stack ?? 5_000;
  return {
    gameId: GAME,
    version: 1,
    phase: "BETTING_OPEN",
    rulesSummary: {
      deckCount: 6,
      dealerHitsSoft17: false,
      blackjackPayout: "3:2",
      surrenderAllowed: true,
      doubleAfterSplit: true,
    },
    handNumber: 1,
    seats: [
      {
        seatId: SEAT,
        userId: "user-1",
        displayName: "You",
        stack,
        originalBet: 0,
        insuranceBet: 0,
        hands: [],
        connected: true,
        sittingOut: false,
        betLocked: false,
      },
    ],
    dealer: { cards: [], displayedTotal: null, holeCardRevealed: false },
    activeSeatId: null,
    activeHandId: null,
    deadlineAt: null,
    shoe: { shuffleNumber: 1, approximateRemainingDecks: 6 },
    legalActions: {
      [SEAT]: {
        actions: [],
        canPlaceBet: true,
        canLockBet: false,
        canStartNextHand: false,
        canTakeInsurance: false,
        insuranceStake: null,
        insuranceIsEvenMoney: false,
        betBounds: { min: 100, max: overrides.max ?? 2_000 },
        chipCost: {},
      },
    },
  } as unknown as PublicGameState;
}

/**
 * A gateway that accepts everything.
 *
 * `lockBet` sends PLACE_BET then LOCK_BET, so both have to answer. Neither
 * changes the snapshot here: this test is about what the STORE remembers, and a
 * fabricated post-lock state would be asserting the fake rather than the store.
 */
function acceptingGateway(state: PublicGameState): TableGateway {
  return {
    kind: "fake",
    snapshot: async () => ({ ok: true, state, events: [] }),
    command: async () => ({ ok: true, status: "applied", state, events: [] }),
    cashOut: async () => ({ ok: true, balance: 0 }),
    subscribe: () => () => undefined,
  } as unknown as TableGateway;
}

beforeEach(() => {
  useOnlineTableStore.getState().forgetTable();
});

describe("the online store", () => {
  it("remembers nothing before a bet has been accepted", () => {
    expect(useOnlineTableStore.getState().lastBet).toBe(0);
  });

  it("does nothing when asked to repeat with no history", () => {
    useOnlineTableStore.getState().repeatBet();
    expect(useOnlineTableStore.getState().stagedBet).toBe(0);
  });

  it("records the accepted wager when LOCK_BET succeeds", async () => {
    const state = snapshot();
    setTableGateway(acceptingGateway(state));

    await useOnlineTableStore.getState().enter(GAME, SEAT);
    useOnlineTableStore.getState().addChip(500);
    await useOnlineTableStore.getState().lockBet();

    expect(useOnlineTableStore.getState().lastBet).toBe(500);
    // Staged is cleared: the bet is the server's now, not a local intent.
    expect(useOnlineTableStore.getState().stagedBet).toBe(0);
  });

  it("stages the previous amount again rather than committing it", async () => {
    const state = snapshot();
    setTableGateway(acceptingGateway(state));

    await useOnlineTableStore.getState().enter(GAME, SEAT);
    useOnlineTableStore.getState().addChip(500);
    await useOnlineTableStore.getState().lockBet();

    useOnlineTableStore.getState().repeatBet();

    /*
     * STAGED, not sent. "Previous bet may be suggested next hand but not
     * silently committed" — the player still presses Deal, and can Clear
     * instead.
     */
    expect(useOnlineTableStore.getState().stagedBet).toBe(500);
    expect(useOnlineTableStore.getState().status.kind).toBe("at-table");
  });

  it("replaces whatever was staged rather than adding to it", async () => {
    const state = snapshot();
    setTableGateway(acceptingGateway(state));

    await useOnlineTableStore.getState().enter(GAME, SEAT);
    useOnlineTableStore.getState().addChip(500);
    await useOnlineTableStore.getState().lockBet();

    useOnlineTableStore.getState().addChip(100);
    useOnlineTableStore.getState().repeatBet();

    // 500, not 600. Repeat means "that bet again", not "that bet on top".
    expect(useOnlineTableStore.getState().stagedBet).toBe(500);
  });

  it("clamps the repeat against the stack, through addChip's single clamp", async () => {
    /*
     * The stack can shrink between hands, and a tournament's boundary can move
     * the table maximum. Repeat goes through `addChip` so the clamp lives in
     * exactly one place — copying it here would be a second implementation of
     * the rule the server enforces anyway.
     */
    const rich = snapshot({ stack: 5_000 });
    setTableGateway(acceptingGateway(rich));
    await useOnlineTableStore.getState().enter(GAME, SEAT);
    useOnlineTableStore.getState().addChip(1_000);
    await useOnlineTableStore.getState().lockBet();
    expect(useOnlineTableStore.getState().lastBet).toBe(1_000);

    // The same seat, now nearly broke. `enter` clears `lastBet`, so the repeat
    // is exercised by pushing a poorer snapshot through the store's own setter.
    useOnlineTableStore.setState({
      status: { kind: "at-table", state: snapshot({ stack: 250 }), seatId: SEAT },
    });
    useOnlineTableStore.getState().repeatBet();

    expect(useOnlineTableStore.getState().stagedBet).toBe(250);
  });

  it("forgets the last bet when the table is left", async () => {
    const state = snapshot();
    setTableGateway(acceptingGateway(state));
    await useOnlineTableStore.getState().enter(GAME, SEAT);
    useOnlineTableStore.getState().addChip(500);
    await useOnlineTableStore.getState().lockBet();

    useOnlineTableStore.getState().forgetTable();
    expect(useOnlineTableStore.getState().lastBet).toBe(0);
  });

  it("forgets it on entering a different table", async () => {
    // A different table has different limits and a different stack, and this
    // client has no history at the new one.
    const state = snapshot();
    setTableGateway(acceptingGateway(state));
    await useOnlineTableStore.getState().enter(GAME, SEAT);
    useOnlineTableStore.getState().addChip(500);
    await useOnlineTableStore.getState().lockBet();

    await useOnlineTableStore.getState().enter("game-2", SEAT);
    expect(useOnlineTableStore.getState().lastBet).toBe(0);
  });
});

describe("the screens that draw the betting bar", () => {
  const SCREENS = {
    online: "../../app/table/[gameId].tsx",
    career: "../../app/career/play/[slug].tsx",
    practice: "../../app/game/practice.tsx",
  } as const;

  function source(key: keyof typeof SCREENS): string {
    return readFileSync(fileURLToPath(new URL(SCREENS[key], import.meta.url)), "utf8");
  }

  it("were actually found", () => {
    for (const key of Object.keys(SCREENS) as (keyof typeof SCREENS)[]) {
      expect(source(key), key).toContain("<BettingBar");
    }
  });

  it("never passes a hardcoded zero for the last bet", () => {
    // The defect, in one line each. `lastBet={0}` can only ever draw a disabled
    // Repeat, whatever the player does.
    for (const key of Object.keys(SCREENS) as (keyof typeof SCREENS)[]) {
      expect(source(key), key).not.toContain("lastBet={0}");
    }
  });

  it("never passes an empty callback for Repeat", () => {
    for (const key of Object.keys(SCREENS) as (keyof typeof SCREENS)[]) {
      expect(source(key), key).not.toMatch(/onRepeat=\{\(\) => (undefined|\{\})\}/);
    }
  });
});
