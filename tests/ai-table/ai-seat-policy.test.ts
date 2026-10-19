/**
 * What a computer player decides (Astra Refresh C).
 *
 * The policy is deterministic and small on purpose: the table minimum, flat;
 * insurance always declined; the solved basic-strategy chart for every play;
 * STAND where the chart is silent; and never the next hand. These tests pin each
 * of those, and then the two properties the server relies on:
 *
 *   TOTALITY — the policy answers exactly when the table is waiting on the seat
 *              (`aiSeatOwesDecision`), so the driver can fail loudly on a
 *              decision that is owed and not made;
 *   LEGALITY — every answer is drawn from the legal set the engine computed.
 *
 * The chart check deliberately reads the GENERATED TABLE'S cells rather than
 * calling `adviseAction`: a test that compared the policy to the function the
 * policy calls would prove only that it calls it.
 */

import { describe, expect, it } from "vitest";

import {
  AI_TABLE_MIN_BET,
  aiTableRules,
  applyCommand,
  getLegalActions,
  toPublicState,
  type EngineCommand,
  type EngineState,
  type PlayerActionType,
} from "../../shared/blackjack/index.js";
import {
  ARC_STANDARD_STRATEGY_TABLE,
  describeStrategyState,
  normalizeStrategyKey,
} from "../../shared/strategy/index.js";
import {
  AI_SEAT_FALLBACK_ACTION,
  aiSeatOwesDecision,
  aiSeatWager,
  decideAiSeatAction,
  observeAiSeat,
  type AiSeatObservation,
} from "../../supabase/functions/_shared/ai-seat-policy.js";
import { AI_TEST_CONTEXT, aiTable, shuffledAiTable } from "../helpers/ai-table-harness.js";
import { cards } from "../helpers/engine-harness.js";

function observe(state: EngineState, seatId: string): AiSeatObservation {
  const observation = observeAiSeat(toPublicState(state), seatId, state.rules);
  if (observation === null) throw new Error(`no observation for ${seatId}`);
  return observation;
}

function send(state: EngineState, command: EngineCommand): EngineState {
  return applyCommand(state, command, AI_TEST_CONTEXT).state;
}

/** Every seat stakes the minimum and locks — WITHOUT the driver, so a test can stop anywhere. */
function everyoneBets(state: EngineState): EngineState {
  let current = state;
  for (const seat of current.seats) {
    current = send(current, { type: "PLACE_BET", seatId: seat.seatId, amount: AI_TABLE_MIN_BET });
  }
  for (const seat of current.seats) {
    if (current.phase !== "BETTING_OPEN") break;
    current = send(current, { type: "LOCK_BET", seatId: seat.seatId });
  }
  return current;
}

// ---------------------------------------------------------------------------
// Betting
// ---------------------------------------------------------------------------

describe("a computer player's bet", () => {
  it("stakes the table minimum when nothing is staged", () => {
    const state = aiTable({ shoe: "10S 9H 8D 7C 6S 5H 4D 3C" });
    const observation = observe(state, "ai-0");
    expect(decideAiSeatAction(observation)).toEqual({ type: "PLACE_BET", amount: AI_TABLE_MIN_BET });
  });

  it("locks the bet it staged", () => {
    const staged = send(aiTable({ shoe: "10S 9H 8D 7C 6S 5H 4D 3C" }), {
      type: "PLACE_BET",
      seatId: "ai-0",
      amount: AI_TABLE_MIN_BET,
    });
    expect(decideAiSeatAction(observe(staged, "ai-0"))).toEqual({ type: "LOCK_BET" });
  });

  it("asks nothing more once its bet is locked", () => {
    let state = send(aiTable({ shoe: "10S 9H 8D 7C 6S 5H 4D 3C" }), {
      type: "PLACE_BET",
      seatId: "ai-0",
      amount: AI_TABLE_MIN_BET,
    });
    state = send(state, { type: "LOCK_BET", seatId: "ai-0" });
    const observation = observe(state, "ai-0");
    expect(decideAiSeatAction(observation)).toBeNull();
    expect(aiSeatOwesDecision(observation)).toBe(false);
  });

  it("leaves the table when its stack cannot cover the minimum, because it could never join a round", () => {
    const state = aiTable({ shoe: "10S 9H 8D 7C 6S 5H 4D 3C", stacks: [AI_TABLE_MIN_BET - 10, 5_000, 5_000] });
    expect(getLegalActions(state, "ai-0").canPlaceBet).toBe(false);
    expect(decideAiSeatAction(observe(state, "ai-0"))).toEqual({ type: "LEAVE" });
  });

  it("is asked nothing once it has left", () => {
    const state = send(aiTable({ shoe: "10S 9H 8D 7C 6S 5H 4D 3C" }), { type: "LEAVE", seatId: "ai-0" });
    const observation = observe(state, "ai-0");
    expect(observation.seat.connected).toBe(false);
    expect(decideAiSeatAction(observation)).toBeNull();
    expect(aiSeatOwesDecision(observation)).toBe(false);
  });

  it("stakes from the engine's own bounds, so it can never name a refused figure", () => {
    const bounds = { min: 20, max: 500, increment: 10 };
    const wager = aiSeatWager(bounds);
    expect(wager).toBe(bounds.min);
    expect(wager % bounds.increment).toBe(0);
    expect(wager).toBeLessThanOrEqual(bounds.max);
  });
});

// ---------------------------------------------------------------------------
// Insurance
// ---------------------------------------------------------------------------

describe("a computer player and insurance", () => {
  it("declines it", () => {
    // ai-0: 10,8; person: 9,7; ai-2: 8,9; dealer A up, 5 in the hole.
    const offered = everyoneBets(aiTable({ shoe: "10S 9H 8D AC 8S 7H 9D 5C" }));
    expect(offered.phase).toBe("INSURANCE_OFFER");
    const observation = observe(offered, "ai-0");
    expect(observation.legal.canTakeInsurance).toBe(true);
    expect(decideAiSeatAction(observation)).toEqual({ type: "DECLINE_INSURANCE" });
  });

  it("declines even money too, because basic strategy does and the chart was solved that way", () => {
    // ai-0 holds a natural against an ace: the offer reads "Even Money".
    const offered = everyoneBets(aiTable({ shoe: "AS 9H 8D AC KS 7H 9D 5C" }));
    const observation = observe(offered, "ai-0");
    expect(observation.legal.insuranceIsEvenMoney).toBe(true);
    expect(decideAiSeatAction(observation)).toEqual({ type: "DECLINE_INSURANCE" });
    expect(ARC_STANDARD_STRATEGY_TABLE.metadata.method.approximations.join(" ")).not.toMatch(
      /insurance (is )?taken/i,
    );
  });

  it("is asked nothing once it has answered", () => {
    const offered = everyoneBets(aiTable({ shoe: "10S 9H 8D AC 8S 7H 9D 5C" }));
    const answered = send(offered, { type: "DECLINE_INSURANCE", seatId: "ai-0" });
    const observation = observe(answered, "ai-0");
    expect(decideAiSeatAction(observation)).toBeNull();
    expect(aiSeatOwesDecision(observation)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Playing a hand: the solved chart, cell for cell
// ---------------------------------------------------------------------------

/** Card ranks standing for each value; tens are written as "10". */
const RANK_FOR_VALUE: Record<number, string> = {
  2: "2", 3: "3", 4: "4", 5: "5", 6: "6", 7: "7", 8: "8", 9: "9", 10: "10", 11: "A",
};
const VALUES = [2, 3, 4, 5, 6, 7, 8, 9, 10, 11];

/**
 * A one-seat table where the computer player holds exactly `first, second`
 * against `upcard`, stopped at its decision. The hole card is a 5, so no upcard
 * can make a dealer natural and skip the decision.
 */
function decisionFor(first: string, second: string, upcard: string): EngineState | null {
  let state = aiTable({ shoe: `${first}S ${upcard}H ${second}D 5C`, layout: ["ai"] });
  state = everyoneBets(state);
  if (state.phase === "INSURANCE_OFFER") state = send(state, { type: "DECLINE_INSURANCE", seatId: "ai-0" });
  return state.phase === "PLAYER_TURNS" && state.seats[0]?.hands[0]?.status === "ACTIVE" ? state : null;
}

describe("a computer player's play", () => {
  it("is the generated chart's recommendation on every two-card decision", () => {
    let checked = 0;
    for (const a of VALUES) {
      for (const b of VALUES) {
        if (b < a) continue;
        for (const up of VALUES) {
          const state = decisionFor(RANK_FOR_VALUE[a]!, RANK_FOR_VALUE[b]!, RANK_FOR_VALUE[up]!);
          if (state === null) continue; // a natural: there is nothing to decide
          const hand = state.seats[0]!.hands[0]!;
          const strategyState = describeStrategyState(hand.cards, state.dealer.cards[0]!, {
            splitPolicy: state.rules.splitPolicy,
          });
          const cell = ARC_STANDARD_STRATEGY_TABLE.entries[normalizeStrategyKey(strategyState!)];
          expect(cell, `no cell for ${a},${b} v ${up}`).toBeDefined();

          const decision = decideAiSeatAction(observe(state, "ai-0"));
          // A fresh two-card hand with a full stack may do anything the chart
          // asks — so the answer must be the cell's own recommendation, exactly.
          expect(decision, `${a},${b} v ${up}`).toEqual({ type: cell!.recommendedAction });
          checked += 1;
        }
      }
    }
    // 55 starting pairs × 10 upcards, less the naturals (A,10 against all ten).
    expect(checked).toBe(540);
  });

  it("falls back the way the chart says when the recommended play is not legal", () => {
    // Three cards: DOUBLE, SPLIT and SURRENDER are gone, so a "double" cell
    // resolves through its own fallback rather than the recommendation.
    let resolved = 0;
    for (const up of VALUES) {
      // 2,3 then a 4 is a hard 9; 2,3 then a 6 is a hard 11 — both double cells against weak upcards.
      for (const third of ["4", "6", "8", "10"]) {
        let state = decisionFor("2", "3", RANK_FOR_VALUE[up]!);
        if (state === null) continue;
        // Splice the third card in as the next one off the shoe, then HIT.
        const next = state.shoe.nextIndex;
        const shoeCards = [...state.shoe.cards];
        shoeCards[next] = cards(`${third}S`)[0]!;
        state = { ...state, shoe: { ...state.shoe, cards: shoeCards } };
        state = send(state, { type: "HIT", seatId: "ai-0" });
        if (state.phase !== "PLAYER_TURNS") continue;

        const observation = observe(state, "ai-0");
        expect(observation.legal.actions).toEqual(["HIT", "STAND"]);
        const hand = state.seats[0]!.hands[0]!;
        const cell = ARC_STANDARD_STRATEGY_TABLE.entries[
          normalizeStrategyKey(describeStrategyState(hand.cards, state.dealer.cards[0]!)!)
        ]!;
        const expected: PlayerActionType = ["HIT", "STAND"].includes(cell.recommendedAction)
          ? cell.recommendedAction
          : cell.fallbackAction!;
        expect(decideAiSeatAction(observation)).toEqual({ type: expected });
        resolved += 1;
      }
    }
    expect(resolved).toBeGreaterThan(20);
  });

  it("only ever answers with a play the engine offered", () => {
    for (const a of VALUES) {
      for (const up of VALUES) {
        const state = decisionFor(RANK_FOR_VALUE[a]!, RANK_FOR_VALUE[a]!, RANK_FOR_VALUE[up]!);
        if (state === null) continue;
        const observation = observe(state, "ai-0");
        const decision = decideAiSeatAction(observation);
        expect(observation.legal.actions).toContain(decision?.type);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Where the chart is silent
// ---------------------------------------------------------------------------

describe("the fallback", () => {
  const atDecision = () => observe(decisionFor("10", "6", "10")!, "ai-0");

  it("is STAND, the engine's own default for a hand nobody decided", () => {
    expect(AI_SEAT_FALLBACK_ACTION).toBe("STAND");
  });

  it("stands when no chart was solved for the table's rules", () => {
    // A ruleset id with no registered table: `adviseAction` answers null rather
    // than guessing, and so does nothing here — the seat stands.
    const observation = { ...atDecision(), rules: { ...aiTableRules(), id: "unsolved-variant" } };
    expect(decideAiSeatAction(observation)).toEqual({ type: "STAND" });
  });

  it("stands when the chart's stamp matches but the rules do not", () => {
    // H17 edited in WITHOUT a version bump: the advisor refuses (RULES_MISMATCH).
    const observation = { ...atDecision(), rules: { ...aiTableRules(), dealerHitsSoft17: true } };
    expect(decideAiSeatAction(observation)).toEqual({ type: "STAND" });
  });

  it("stands rather than guessing when it cannot see an upcard or its hand", () => {
    expect(decideAiSeatAction({ ...atDecision(), dealerUpCard: null })).toEqual({ type: "STAND" });
    expect(decideAiSeatAction({ ...atDecision(), activeHandId: "not-a-hand" })).toEqual({
      type: "STAND",
    });
  });

  it("is a decision for the AI seat's own hand only — with no legal play it says nothing", () => {
    const observation = { ...atDecision(), legal: { ...atDecision().legal, actions: [] } };
    expect(decideAiSeatAction(observation)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The next hand
// ---------------------------------------------------------------------------

describe("between hands", () => {
  it("never starts the next hand, although the engine would let it", () => {
    let state = decisionFor("10", "8", "7")!;
    state = send(state, { type: "STAND", seatId: "ai-0" });
    expect(state.phase).toBe("HAND_COMPLETE");
    const observation = observe(state, "ai-0");
    expect(observation.legal.canStartNextHand).toBe(true);
    expect(decideAiSeatAction(observation)).toBeNull();
    expect(aiSeatOwesDecision(observation)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Determinism, totality and legality over real tables
// ---------------------------------------------------------------------------

/** A deterministic scripted table: every seat plays, including the person. */
function scriptedStep(state: EngineState, step: number): EngineCommand | null {
  switch (state.phase) {
    case "BETTING_OPEN":
      for (const seat of state.seats) {
        const legal = getLegalActions(state, seat.seatId);
        if (legal.canLockBet) return { type: "LOCK_BET", seatId: seat.seatId };
        if (legal.canPlaceBet && legal.betBounds) {
          return { type: "PLACE_BET", seatId: seat.seatId, amount: legal.betBounds.min * (1 + (step % 4)) };
        }
      }
      return null;
    case "INSURANCE_OFFER":
      for (const seat of state.seats) {
        if (getLegalActions(state, seat.seatId).canDeclineInsurance) {
          return { type: "DECLINE_INSURANCE", seatId: seat.seatId };
        }
      }
      return null;
    case "PLAYER_TURNS": {
      const seat = state.seats[state.activeSeatIndex ?? -1];
      if (!seat) return null;
      const actions = getLegalActions(state, seat.seatId).actions;
      const action = actions[step % actions.length];
      return action ? { type: action, seatId: seat.seatId } : null;
    }
    case "HAND_COMPLETE":
      return { type: "NEXT_HAND", seatId: state.seats[0]!.seatId };
    default:
      return null;
  }
}

/** Every reachable state of a few hundred scripted hands, as the policy would see them. */
function sampledObservations(): AiSeatObservation[] {
  const out: AiSeatObservation[] = [];
  for (const seed of [3, 17, 29]) {
    let state = shuffledAiTable(seed);
    for (let step = 0; step < 900; step += 1) {
      for (const seat of state.seats) {
        if (seat.isAi === true) out.push(observe(state, seat.seatId));
      }
      const command = scriptedStep(state, step);
      if (command === null) break;
      state = send(state, command);
    }
  }
  return out;
}

describe("over every situation a real table produces", () => {
  const sample = sampledObservations();

  it("sampled every decision family", () => {
    const phases = new Set(sample.map((observation) => observation.phase));
    for (const phase of ["BETTING_OPEN", "INSURANCE_OFFER", "PLAYER_TURNS", "HAND_COMPLETE"]) {
      expect(phases.has(phase as never), phase).toBe(true);
    }
    expect(sample.length).toBeGreaterThan(1_000);
  });

  it("answers exactly when the table is waiting on the seat", () => {
    for (const observation of sample) {
      expect(decideAiSeatAction(observation) !== null).toBe(aiSeatOwesDecision(observation));
    }
  });

  it("answers only with something the engine offered", () => {
    for (const observation of sample) {
      const decision = decideAiSeatAction(observation);
      if (decision === null) continue;
      const { legal } = observation;
      switch (decision.type) {
        case "PLACE_BET":
          expect(legal.canPlaceBet).toBe(true);
          expect(decision.amount).toBeGreaterThanOrEqual(legal.betBounds!.min);
          expect(decision.amount).toBeLessThanOrEqual(legal.betBounds!.max);
          break;
        case "LOCK_BET":
          expect(legal.canLockBet).toBe(true);
          break;
        case "DECLINE_INSURANCE":
          expect(legal.canDeclineInsurance).toBe(true);
          break;
        case "LEAVE":
          // Only when it can neither stake nor lock in a betting round.
          expect(observation.phase).toBe("BETTING_OPEN");
          expect(legal.canPlaceBet || legal.canLockBet).toBe(false);
          break;
        default:
          expect(legal.actions).toContain(decision.type);
      }
    }
  });

  it("is deterministic: the same observation always gets the same answer", () => {
    for (const observation of sample) {
      const clone = JSON.parse(JSON.stringify(observation)) as AiSeatObservation;
      expect(decideAiSeatAction(clone)).toEqual(decideAiSeatAction(observation));
      expect(decideAiSeatAction(observation)).toEqual(decideAiSeatAction(observation));
    }
  });
});
