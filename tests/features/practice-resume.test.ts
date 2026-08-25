/**
 * THE KILL / RESUME GATE.
 *
 * The specification's requirement is exact resume, not approximate resume: kill
 * the app in the middle of a hand and everything must come back — the shoe's
 * position, the cards on the table, every wager, the bankroll, which hand is
 * active, the phase — with no settlement replayed and no card appearing from
 * nowhere.
 *
 * These tests drive the REAL store against a real key/value store and then throw
 * every piece of in-memory state away, exactly as a process death does. A test
 * that keeps the store's state and calls `hydrate` again proves nothing: the
 * answers are already sitting in memory.
 *
 * The hard case is an active SPLIT, because that is where the state has more
 * than one moving part — two hands, two wagers, a cursor saying which is being
 * played, and a settlement that has not happened yet.
 */

import { beforeEach, describe, expect, it } from "vitest";

import { getLegalActions } from "../../shared/blackjack/legal-actions.js";
import {
  ARC_STANDARD_RULES,
  rulesForTier,
  TABLE_TIERS,
} from "../../shared/blackjack/rules.js";
import { createPreorderedShoe } from "../../shared/blackjack/shoe.js";
import { createGame, startSession } from "../../shared/blackjack/reducer.js";
import { SeededTestRandomSource } from "../../shared/blackjack/rng.js";
import { MemoryKeyValueStore } from "../../src/lib/persistence/key-value-store.js";
import { PracticePersistence } from "../../src/features/practice/persistence.js";
import { EMPTY_PRACTICE_STATS } from "../../src/features/practice/practice-record.js";
import {
  PRACTICE_SEAT_ID,
  PRACTICE_STARTING_BANKROLL,
  setPracticePersistence,
  usePracticeStore,
} from "../../src/features/practice/practice-store.js";
import { cards } from "../helpers/engine-harness.js";

const PRACTICE_RULES = rulesForTier(
  TABLE_TIERS.find((tier) => tier.id === "casual")!,
  ARC_STANDARD_RULES,
);

const store = () => usePracticeStore.getState();

let disk: MemoryKeyValueStore;

/**
 * Order-insensitive deep comparison.
 *
 * A JSON round trip reorders object keys, so `JSON.stringify(a) === b` fails on
 * a state that is genuinely identical. Comparing canonical forms asserts the
 * thing actually claimed.
 */
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = canonical((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

/** Everything a process death destroys. Nothing survives but the disk. */
function killTheApp(): void {
  usePracticeStore.setState({
    hydrated: false,
    game: null,
    stagedBet: 0,
    lastBet: 0,
    mode: "play",
    recentEvents: [],
    error: null,
    stats: { ...EMPTY_PRACTICE_STATS },
    feedback: null,
    decisionLog: [],
    handHistory: [],
  });
}

/**
 * Seats the store on a shoe we chose, so a split is reached on hand one rather
 * than after a hundred random deals.
 */
function seatOnFixture(shoe: string, bankroll = PRACTICE_STARTING_BANKROLL): void {
  const context = { random: new SeededTestRandomSource(7) };
  let state = createGame({
    gameId: "practice-fixture",
    rules: PRACTICE_RULES,
    seats: [{ seatId: PRACTICE_SEAT_ID, displayName: "You", stack: bankroll }],
    random: context.random,
    timing: null,
  });
  state = {
    ...state,
    shoe: createPreorderedShoe(
      cards(shoe),
      cards(Array.from({ length: 60 }, () => "5C 6D 7H 8S 9C").join(" ")),
    ),
  };
  usePracticeStore.setState({ game: startSession(state, context).state, hydrated: true });
}

beforeEach(async () => {
  disk = new MemoryKeyValueStore();
  setPracticePersistence(new PracticePersistence(disk));
  killTheApp();
  await store().hydrate();
  store().resetStats();
});

// ---------------------------------------------------------------------------

describe("exact resume through an active split hand", () => {
  it("restores the shoe, the cards, both wagers, the bankroll, the active hand and the phase", async () => {
    // 8,8 against a 9: the classic split, and the fixture puts it on hand one.
    seatOnFixture("8S 9C 8H 7D 3D 4C 10H 2S");

    store().addChip(100);
    store().lockBet();
    store().act("SPLIT");
    // Draw on the first split hand so the two hands differ and the cursor is
    // demonstrably pointing at one of them.
    store().act("HIT");

    const live = store().game!;
    expect(live.phase).toBe("PLAYER_TURNS");
    expect(live.seats[0]!.hands).toHaveLength(2);

    const wagers = live.seats[0]!.hands.map((hand) => hand.wager);
    const cardIds = live.seats[0]!.hands.map((hand) => hand.cards.map((card) => card.id));
    const shoeCursor = live.shoe.nextIndex;
    const shoeIds = live.shoe.cards.map((card) => card.id);
    const stack = live.seats[0]!.stack;
    const activeHand = live.activeHandIndex ?? live.seats[0]!.currentHandIndex;
    const stats = store().stats;

    // --- KILL. The write is forced to land first, exactly as backgrounding
    //     does through `usePersistOnBackground`.
    await store().flush();
    killTheApp();
    expect(store().game).toBeNull();

    // --- RESTART.
    await store().hydrate();
    const back = store().game!;

    expect(back.phase).toBe("PLAYER_TURNS");
    expect(back.seats[0]!.hands).toHaveLength(2);
    expect(back.seats[0]!.hands.map((hand) => hand.wager)).toEqual(wagers);
    expect(back.seats[0]!.hands.map((hand) => hand.cards.map((card) => card.id))).toEqual(cardIds);
    expect(back.seats[0]!.stack).toBe(stack);
    expect(back.activeHandIndex ?? back.seats[0]!.currentHandIndex).toBe(activeHand);

    // Same shoe, same position in it. A resumed hand dealt from a different
    // shoe is a different game wearing the same cards.
    expect(back.shoe.nextIndex).toBe(shoeCursor);
    expect(back.shoe.cards.map((card) => card.id)).toEqual(shoeIds);

    expect(store().stats).toEqual(stats);

    // And the whole engine state, field for field.
    expect(canonical(back)).toEqual(canonical(live));
  });

  it("plays on from the restored split and settles once, with no phantom cards", async () => {
    seatOnFixture("8S 9C 8H 7D 3D 4C 10H 2S");

    store().addChip(100);
    store().lockBet();
    store().act("SPLIT");

    const dealtBefore = store().game!.shoe.nextIndex;

    await store().flush();
    killTheApp();
    await store().hydrate();

    // Nothing was drawn by restoring.
    expect(store().game!.shoe.nextIndex).toBe(dealtBefore);

    let guard = 0;
    while (store().game!.phase !== "HAND_COMPLETE" && guard < 20) {
      guard += 1;
      const legal = getLegalActions(store().game!, PRACTICE_SEAT_ID);
      if (store().game!.phase === "INSURANCE_OFFER") {
        store().declineInsurance();
        continue;
      }
      if (!legal.actions.includes("STAND")) break;
      store().act("STAND");
    }

    expect(store().game!.phase).toBe("HAND_COMPLETE");
    // One round, two settled hands, settled exactly once each.
    expect(store().stats.handsPlayed).toBe(1);
    expect(store().stats.handsSettled).toBe(2);
    expect(store().handHistory).toHaveLength(1);
    expect(store().handHistory[0]!.outcomes).toHaveLength(2);
  });

  it("carries the decision log and the hand history across the restart", async () => {
    seatOnFixture("10S 9C 9H 7D 8C 2D 3H 4S 5C 6D");

    store().addChip(100);
    store().lockBet();
    store().act("STAND");

    const log = store().decisionLog;
    const history = store().handHistory;
    expect(log.length).toBeGreaterThan(0);
    expect(history).toHaveLength(1);

    await store().flush();
    killTheApp();
    await store().hydrate();

    // Before this was persisted, Mastery survived a relaunch and every other
    // section of Statistics — behaviour, streaks, trend — silently emptied.
    expect(store().decisionLog).toEqual(log);
    expect(store().handHistory).toEqual(history);
  });
});

// ---------------------------------------------------------------------------

describe("the mutations a player can see are the mutations that get written", () => {
  it("persists a bankroll reset immediately, so a kill cannot undo it", async () => {
    store().addChip(100);
    store().lockBet();
    await store().flush();

    const beforeReset = store().game!.gameId;

    // No flush, no further command: the Reset must stand on its own.
    store().resetBankroll();
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));

    killTheApp();
    await store().hydrate();

    expect(store().game!.gameId).not.toBe(beforeReset);
    expect(store().game!.seats[0]!.stack).toBe(PRACTICE_STARTING_BANKROLL);
    expect(store().game!.phase).toBe("BETTING_OPEN");
  });

  it("persists the assistance mode immediately", async () => {
    store().setMode("analysis");
    await new Promise((resolve) => setTimeout(resolve, 0));

    killTheApp();
    await store().hydrate();

    expect(store().mode).toBe("analysis");
  });

  it("persists a statistics reset immediately", async () => {
    store().addChip(100);
    store().lockBet();
    await store().flush();
    expect(store().stats.chipsWagered).toBe(100);

    store().resetStats();
    await new Promise((resolve) => setTimeout(resolve, 0));

    killTheApp();
    await store().hydrate();

    expect(store().stats).toEqual(EMPTY_PRACTICE_STATS);
    expect(store().handHistory).toEqual([]);
  });
});
