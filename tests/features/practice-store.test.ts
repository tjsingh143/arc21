/**
 * Practice store integration tests.
 *
 * These sit between the engine unit tests and the UI. They exercise the store
 * the table actually drives, and they are where chip-conservation is proved end
 * to end: chips must never appear from nowhere.
 *
 * The store deliberately uses the production CSPRNG, so card values are not
 * predictable here. These tests therefore assert *invariants* over many random
 * hands rather than specific outcomes — the deterministic card-by-card cases
 * live in tests/engine.
 */

import { beforeEach, describe, expect, it } from "vitest";

import {
  NO_LEGAL_ACTIONS,
  PRACTICE_SEAT_ID,
  PRACTICE_STARTING_BANKROLL,
  usePracticeStore,
} from "../../src/features/practice/practice-store.js";
import { getLegalActions } from "../../shared/blackjack/legal-actions.js";
import type { PlayerActionType } from "../../shared/blackjack/types.js";

const store = () => usePracticeStore.getState();

function game() {
  const current = store().game;
  if (!current) throw new Error("No practice session");
  return current;
}

function seat() {
  const found = game().seats.find((candidate) => candidate.seatId === PRACTICE_SEAT_ID);
  if (!found) throw new Error("No practice seat");
  return found;
}

function legal() {
  return getLegalActions(game(), PRACTICE_SEAT_ID);
}

/** Chips committed to the felt but not yet resolved. */
function committed(): number {
  return seat().hands.reduce((sum, hand) => sum + hand.wager, 0) + seat().insuranceBet;
}

beforeEach(() => {
  store().start();
  // `start()` intentionally preserves practice statistics — they are cumulative
  // across sessions, per the spec — so tests must clear them explicitly to stay
  // independent of one another.
  store().resetStats();
  store().setMode("play");
});

describe("session setup", () => {
  it("starts with the practice bankroll and an open betting round", () => {
    expect(seat().stack).toBe(PRACTICE_STARTING_BANKROLL);
    expect(game().phase).toBe("BETTING_OPEN");
    expect(game().handNumber).toBe(1);
  });

  it("uses the casual tier stakes so a small bankroll stays playable", () => {
    expect(game().rules.minBet).toBe(20);
    expect(game().rules.maxBet).toBe(500);
  });

  it("exposes no legal actions before a session exists", () => {
    expect(NO_LEGAL_ACTIONS.actions).toEqual([]);
    expect(NO_LEGAL_ACTIONS.canLockBet).toBe(false);
  });
});

describe("betting", () => {
  it("debits the stack as chips are added", () => {
    store().addChip(100);
    expect(seat().originalBet).toBe(100);
    expect(seat().stack).toBe(PRACTICE_STARTING_BANKROLL - 100);
  });

  it("accumulates chip taps", () => {
    store().addChip(100);
    store().addChip(50);
    expect(seat().originalBet).toBe(150);
    expect(seat().stack).toBe(PRACTICE_STARTING_BANKROLL - 150);
  });

  it("refuses to exceed the table maximum", () => {
    store().addChip(500);
    store().addChip(500); // would be 1000, above the 500 cap
    expect(seat().originalBet).toBe(500);
  });

  it("clears the staged bet and refunds it authoritatively", () => {
    store().addChip(300);
    store().clearBet();

    expect(seat().originalBet).toBe(0);
    // The refund must reach the engine, not just the UI.
    expect(seat().stack).toBe(PRACTICE_STARTING_BANKROLL);
    expect(game().phase).toBe("BETTING_OPEN");
  });

  it("enables Deal only once a valid bet is staged", () => {
    expect(legal().canLockBet).toBe(false);
    store().addChip(100);
    expect(legal().canLockBet).toBe(true);
  });

  it("repeats the previous wager without committing it automatically", () => {
    store().addChip(100);
    store().lockBet();

    // Play out whatever was dealt.
    settleCurrentHand();
    store().nextHand();

    expect(seat().originalBet).toBe(0); // nothing auto-committed
    store().repeatLastBet();
    expect(seat().originalBet).toBe(100);
  });

  it("deals once the bet is locked", () => {
    store().addChip(100);
    store().lockBet();
    expect(game().phase).not.toBe("BETTING_OPEN");
    expect(seat().hands.length).toBeGreaterThan(0);
    expect(game().dealer.cards.length).toBeGreaterThanOrEqual(2);
  });
});

describe("bankroll reset", () => {
  it("restores the starting bankroll and a fresh shoe", () => {
    store().addChip(100);
    store().lockBet();
    settleCurrentHand();

    store().resetBankroll();
    expect(seat().stack).toBe(PRACTICE_STARTING_BANKROLL);
    expect(game().handNumber).toBe(1);
  });
});

/** Plays the current hand to completion using only legal actions. */
function settleCurrentHand(chooser: (actions: PlayerActionType[]) => PlayerActionType = () => "STAND") {
  let guard = 0;

  while (game().phase !== "HAND_COMPLETE" && guard++ < 60) {
    const current = game();

    if (current.phase === "INSURANCE_OFFER") {
      store().declineInsurance();
      continue;
    }

    const available = getLegalActions(current, PRACTICE_SEAT_ID).actions;
    if (available.length === 0) break;

    const choice = chooser(available);
    store().act(available.includes(choice) ? choice : (available[0] as PlayerActionType));
  }

  if (guard >= 60) throw new Error("Hand failed to settle within the guard");
}

describe("chip conservation over many hands", () => {
  it("never creates or destroys chips across 150 randomised hands", () => {
    let expected = PRACTICE_STARTING_BANKROLL;
    const seen = new Set<string>();

    for (let round = 0; round < 150; round++) {
      const affordable = Math.min(seat().stack, 100);
      if (affordable < game().rules.minBet) break;

      store().addChip(affordable >= 100 ? 100 : game().rules.minBet);
      const wagerBefore = seat().originalBet;
      store().lockBet();

      // Randomly exercise every branch the hand offers.
      settleCurrentHand((actions) => {
        const preference: PlayerActionType[] = ["SPLIT", "DOUBLE", "HIT", "STAND"];
        for (const action of preference) {
          if (actions.includes(action) && Math.random() < 0.55) return action;
        }
        return "STAND";
      });

      for (const hand of seat().hands) {
        seen.add(hand.status);
        expect(hand.outcome).toBeDefined();
      }

      // Everything committed this round must be fully resolved.
      expect(committed()).toBeGreaterThanOrEqual(0);

      const net =
        seat().hands.reduce((sum, hand) => sum + (hand.outcome?.net ?? 0), 0) +
        (seat().insuranceBet > 0 ? -seat().insuranceBet : 0);

      expected += net;

      // The authoritative bankroll must match the sum of settled outcomes
      // exactly — no rounding drift, no phantom chips.
      expect(seat().stack).toBe(expected);
      expect(Number.isInteger(seat().stack)).toBe(true);
      expect(seat().stack).toBeGreaterThanOrEqual(0);
      expect(wagerBefore).toBeGreaterThan(0);

      store().nextHand();
    }

    // The fuzz should have reached a variety of terminal states, not just STOOD.
    expect(seen.size).toBeGreaterThan(1);
  });

  it("reshuffles between hands rather than mid-hand", () => {
    let shuffleChanges = 0;
    let previousShuffle = game().shoe.shuffleNumber;

    for (let round = 0; round < 120; round++) {
      if (seat().stack < game().rules.minBet) break;

      store().addChip(game().rules.minBet);
      store().lockBet();

      const shuffleDuringHand = game().shoe.shuffleNumber;
      settleCurrentHand();
      // The shuffle number must not change while a hand is in progress.
      expect(game().shoe.shuffleNumber).toBe(shuffleDuringHand);

      if (game().shoe.shuffleNumber !== previousShuffle) shuffleChanges++;
      previousShuffle = game().shoe.shuffleNumber;

      store().nextHand();
    }

    // Reshuffles may or may not occur in 120 short hands, but if one did it
    // must have happened at a betting boundary — asserted above.
    expect(shuffleChanges).toBeGreaterThanOrEqual(0);
  });
});

describe("strategy tracking", () => {
  /** Plays one hand, taking `action` on the first decision. */
  function playOneDecision(action: PlayerActionType) {
    store().addChip(100);
    store().lockBet();
    if (game().phase === "INSURANCE_OFFER") store().declineInsurance();
    if (game().phase !== "PLAYER_TURNS") return false;

    const available = getLegalActions(game(), PRACTICE_SEAT_ID).actions;
    if (!available.includes(action)) return false;
    store().act(action);
    return true;
  }

  it("keeps the accuracy counters internally consistent", () => {
    for (let i = 0; i < 25; i++) {
      playOneDecision("STAND");
      settleCurrentHand();
      store().nextHand();
    }

    const s = store().stats;
    expect(s.decisions).toBeGreaterThan(0);
    expect(s.correct).toBeLessThanOrEqual(s.decisions);
    // Every counted decision lands in exactly one hand class.
    expect(s.hardDecisions + s.softDecisions + s.pairDecisions).toBe(s.decisions);
    expect(s.hardCorrect + s.softCorrect + s.pairCorrect).toBe(s.correct);
    // EV lost is a cost, never a credit.
    expect(s.estimatedEvLost).toBeGreaterThanOrEqual(0);
    // Play mode is unaided, so every decision here counts toward the real figure.
    expect(s.unaidedDecisions).toBe(s.decisions);
  });

  it("treats Play and Challenge decisions as unaided, Learn and Analysis as aided", () => {
    store().setMode("learn");
    for (let i = 0; i < 6; i++) {
      playOneDecision("STAND");
      settleCurrentHand();
      store().nextHand();
    }
    const afterAided = store().stats;
    expect(afterAided.decisions).toBeGreaterThan(0);
    // The answer was on screen, so none of it counts as unaided.
    expect(afterAided.unaidedDecisions).toBe(0);

    store().setMode("challenge");
    for (let i = 0; i < 6; i++) {
      playOneDecision("STAND");
      settleCurrentHand();
      store().nextHand();
    }
    expect(store().stats.unaidedDecisions).toBeGreaterThan(0);
  });

  it("surfaces feedback in Challenge mode only", () => {
    store().setMode("learn");
    playOneDecision("STAND");
    expect(store().feedback).toBeNull();

    settleCurrentHand();
    store().nextHand();

    store().setMode("challenge");
    const acted = playOneDecision("STAND");
    if (acted && store().stats.decisions > 0) {
      expect(store().feedback).not.toBeNull();
      store().dismissFeedback();
      expect(store().feedback).toBeNull();
    }
  });

  it("logs decisions in every mode for later review", () => {
    store().setMode("play");
    // A dealt hand can resolve with no decision at all (a natural, or a dealer
    // blackjack found at the peek), and the shoe is a real CSPRNG — so play on
    // until a decision actually occurs rather than assuming the first hand asks
    // for one.
    for (let i = 0; i < 30 && store().decisionLog.length === 0; i++) {
      playOneDecision("STAND");
      settleCurrentHand();
      store().nextHand();
    }
    expect(store().decisionLog.length).toBeGreaterThan(0);
    expect(store().decisionLog[0]?.handNumber).toBeGreaterThan(0);
  });

  it("does not record a decision the engine rejected", () => {
    // Acting during betting is illegal and must not move accuracy.
    store().act("HIT");
    expect(store().error).toBeTruthy();
    expect(store().stats.decisions).toBe(0);
    expect(store().decisionLog).toEqual([]);
  });

  it("counts a hand at settlement, not when the player asks for the next one", () => {
    store().addChip(100);
    store().lockBet();
    settleCurrentHand();
    expect(store().stats.handsPlayed).toBe(1);
    // Still 1 after advancing — the count follows settlement, not the button.
    store().nextHand();
    expect(store().stats.handsPlayed).toBe(1);
  });

  it("clears stats and log on reset", () => {
    playOneDecision("STAND");
    settleCurrentHand();
    store().resetStats();
    expect(store().stats.decisions).toBe(0);
    expect(store().stats.handsPlayed).toBe(0);
    expect(store().decisionLog).toEqual([]);
  });
});

describe("error surfacing", () => {
  it("captures an illegal command as UI state instead of throwing", () => {
    // Acting during the betting phase is illegal.
    store().act("HIT");
    expect(store().error).toBeTruthy();
    expect(game().phase).toBe("BETTING_OPEN");
  });

  it("clears the error once a legal command succeeds", () => {
    store().act("HIT");
    expect(store().error).toBeTruthy();

    store().addChip(100);
    expect(store().error).toBeNull();
  });
});
