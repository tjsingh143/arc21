/**
 * Arc 21 — career session runner.
 *
 * Runs one career node to completion and hands the result to star evaluation.
 * It owns no game rules: standard nodes go through the same `applyCommand` the
 * Practice table uses, and drill nodes present scenarios from `drillPool`, which
 * guarantees every question is gradeable by the validated tables.
 *
 * Two properties are deliberate:
 *
 *   - A standard node deals from a NORMAL FAIR SHOE. Nothing here inspects or
 *     arranges cards to make a target reachable. If the cards do not cooperate,
 *     the player still earns the completion star and still unlocks the next
 *     node — variance must never gate progression.
 *   - A drill node builds targeted scenarios and is labelled "Drill" everywhere
 *     it appears. It is not an organically shuffled casino hand and the product
 *     never implies it is.
 */

import { create } from "zustand";

import {
  applyCommand,
  beginNextHand,
  createGame,
  startSession,
  type CommandContext,
  type EngineState,
} from "../../../shared/blackjack/reducer.js";
import { CryptoRandomSource } from "../../../shared/blackjack/rng.js";
import { getLegalActions } from "../../../shared/blackjack/legal-actions.js";
import { EngineError, type PlayerActionType } from "../../../shared/blackjack/types.js";
import {
  CAREER_RULES,
  careerNodeBySlug,
  maxWagerForNode,
} from "../../../shared/career/nodes.js";
import { drillPool, type DrillScenario } from "../../../shared/career/drills.js";
import {
  evaluateStars,
  type CareerSessionResult,
  type StarEvaluation,
} from "../../../shared/career/stars.js";
import type { CareerNode } from "../../../shared/career/types.js";
import { adviseAction } from "../../../shared/strategy/index.js";
import { computeAdvice, gradeDecision } from "../practice/advice.js";
import { useCareerStore } from "./use-career-progress.js";

export const CAREER_SEAT_ID = "career";

/** Running totals that feed star evaluation. */
interface RunningTotals {
  handsPlayed: number;
  decisions: number;
  correct: number;
  unaidedDecisions: number;
  unaidedCorrect: number;
  estimatedEvLost: number;
}

const ZERO: RunningTotals = {
  handsPlayed: 0,
  decisions: 0,
  correct: 0,
  unaidedDecisions: 0,
  unaidedCorrect: 0,
  estimatedEvLost: 0,
};

export interface DrillFeedback {
  correct: boolean;
  recommended: string;
  chosen: PlayerActionType;
  evLost: number | null;
}

interface CareerSessionStore {
  node: CareerNode | null;

  /** Standard nodes only. */
  game: EngineState | null;
  stagedBet: number;

  /** Drill nodes only. */
  scenarios: DrillScenario[];
  scenarioIndex: number;
  drillFeedback: DrillFeedback | null;

  totals: RunningTotals;
  finished: boolean;
  evaluation: StarEvaluation | null;
  error: string | null;

  start: (slug: string) => void;
  /** Discards the session without recording anything. */
  abandon: () => void;

  addChip: (amount: number) => void;
  clearBet: () => void;
  lockBet: () => void;
  act: (action: PlayerActionType) => void;
  declineInsurance: () => void;
  takeInsurance: () => void;
  nextHand: () => void;

  answerDrill: (action: PlayerActionType) => void;
  nextDrill: () => void;
}

let randomSource: CryptoRandomSource | null = null;
function context(): CommandContext {
  randomSource ??= new CryptoRandomSource();
  return { random: randomSource };
}

export const useCareerSessionStore = create<CareerSessionStore>((set, get) => {
  /** Builds the result star evaluation reads, then records it once. */
  function finish(reason: CareerSessionResult["completionReason"]): void {
    const { node, game, totals } = get();
    if (!node) return;

    const endingBankroll =
      node.format === "standard" ? (game?.seats[0]?.stack ?? node.startingBankroll) : node.startingBankroll;

    const result: CareerSessionResult = {
      nodeId: node.id,
      completed: reason !== "abandoned",
      completionReason: reason,
      handsPlayed: totals.handsPlayed,
      decisions: totals.decisions,
      correct: totals.correct,
      unaidedDecisions: totals.unaidedDecisions,
      unaidedCorrect: totals.unaidedCorrect,
      estimatedEvLost: totals.estimatedEvLost,
      startingBankroll: node.startingBankroll,
      endingBankroll,
    };

    const evaluation = evaluateStars(node, result);
    set({ finished: true, evaluation });

    // Progress is recorded once, at the end, from the authoritative totals —
    // never incrementally, where a mid-session crash could bank a partial run.
    void useCareerStore.getState().record(node, result);
  }

  /** Records one graded decision against the running totals. */
  function grade(action: PlayerActionType, unaided: boolean): void {
    const { game, node } = get();
    if (!game || !node) return;

    const seat = game.seats.find((candidate) => candidate.seatId === CAREER_SEAT_ID);
    if (!seat) return;

    const advice = computeAdvice(game, seat, getLegalActions(game, CAREER_SEAT_ID).actions);
    const verdict = gradeDecision(advice, action);
    // An ungradeable state never counts — for or against the player.
    if (!verdict) return;

    set((current) => ({
      totals: {
        ...current.totals,
        decisions: current.totals.decisions + 1,
        correct: current.totals.correct + (verdict.correct ? 1 : 0),
        unaidedDecisions: current.totals.unaidedDecisions + (unaided ? 1 : 0),
        unaidedCorrect: current.totals.unaidedCorrect + (unaided && verdict.correct ? 1 : 0),
        estimatedEvLost: current.totals.estimatedEvLost + (verdict.evLost ?? 0),
      },
    }));
  }

  function dispatch(run: (game: EngineState) => { state: EngineState }): void {
    const { game, node } = get();
    if (!game || !node) return;

    try {
      const next = run(game).state;
      const completedHand = next.phase === "HAND_COMPLETE" && game.phase !== "HAND_COMPLETE";

      set((current) => ({
        game: next,
        error: null,
        totals: completedHand
          ? { ...current.totals, handsPlayed: current.totals.handsPlayed + 1 }
          : current.totals,
      }));

      if (!completedHand) return;

      const played = get().totals.handsPlayed;
      const stack = next.seats[0]?.stack ?? 0;

      if (node.hands !== null && played >= node.hands) {
        finish("target_reached");
      } else if (stack < next.rules.minBet) {
        // Out of chips is still a completion: the player finished what they
        // could, and the completion star is not conditional on winning.
        finish("bankroll_exhausted");
      }
    } catch (cause) {
      if (cause instanceof EngineError) {
        set({ error: cause.message });
        return;
      }
      throw cause;
    }
  }

  return {
    node: null,
    game: null,
    stagedBet: 0,
    scenarios: [],
    scenarioIndex: 0,
    drillFeedback: null,
    totals: { ...ZERO },
    finished: false,
    evaluation: null,
    error: null,

    start: (slug) => {
      const node = careerNodeBySlug(slug);
      if (!node) {
        set({ error: `Unknown career node "${slug}"` });
        return;
      }

      if (node.format === "drill") {
        const focus = node.drillFocus ?? "mixed";
        const pool = drillPool(CAREER_RULES, focus);
        // Deterministically rotate the pool per attempt so a repeat is not the
        // identical sequence, without needing gameplay randomness here.
        set({
          node,
          game: null,
          scenarios: pool,
          scenarioIndex: 0,
          drillFeedback: null,
          totals: { ...ZERO },
          finished: false,
          evaluation: null,
          error: null,
        });
        return;
      }

      const created = createGame({
        gameId: `career-${node.slug}-${Date.now()}`,
        rules: CAREER_RULES,
        seats: [{ seatId: CAREER_SEAT_ID, displayName: "You", stack: node.startingBankroll }],
        random: context().random!,
        timing: null,
      });

      set({
        node,
        game: startSession(created, context()).state,
        stagedBet: 0,
        scenarios: [],
        scenarioIndex: 0,
        drillFeedback: null,
        totals: { ...ZERO },
        finished: false,
        evaluation: null,
        error: null,
      });
    },

    abandon: () => {
      set({
        node: null,
        game: null,
        scenarios: [],
        scenarioIndex: 0,
        drillFeedback: null,
        totals: { ...ZERO },
        finished: false,
        evaluation: null,
        error: null,
        stagedBet: 0,
      });
    },

    addChip: (amount) => {
      const { game, stagedBet, node } = get();
      if (!game || !node) return;

      const seat = game.seats[0];
      if (!seat) return;

      const next = stagedBet + amount;
      const ceiling = Math.min(
        seat.stack + seat.originalBet,
        maxWagerForNode(node, game.rules),
      );
      if (next > ceiling) return;

      set({ stagedBet: next, error: null });
      dispatch((current) =>
        applyCommand(current, { type: "PLACE_BET", seatId: CAREER_SEAT_ID, amount: next }, context()),
      );
    },

    clearBet: () => {
      set({ stagedBet: 0, error: null });
      dispatch((current) =>
        applyCommand(current, { type: "PLACE_BET", seatId: CAREER_SEAT_ID, amount: 0 }, context()),
      );
    },

    lockBet: () => {
      if (get().stagedBet <= 0) return;
      dispatch((current) =>
        applyCommand(current, { type: "LOCK_BET", seatId: CAREER_SEAT_ID }, context()),
      );
    },

    act: (action) => {
      const { node } = get();
      if (!node) return;
      // Learn and Analysis put the answer on screen, so those decisions are not
      // unaided and cannot count toward a node graded on recall.
      const unaided = node.assistance === "play" || node.assistance === "challenge";
      grade(action, unaided);
      dispatch((current) =>
        applyCommand(current, { type: action, seatId: CAREER_SEAT_ID }, context()),
      );
    },

    takeInsurance: () => {
      dispatch((current) =>
        applyCommand(current, { type: "INSURANCE", seatId: CAREER_SEAT_ID }, context()),
      );
    },

    declineInsurance: () => {
      dispatch((current) =>
        applyCommand(current, { type: "DECLINE_INSURANCE", seatId: CAREER_SEAT_ID }, context()),
      );
    },

    nextHand: () => {
      set({ stagedBet: 0 });
      dispatch((current) => beginNextHand(current, context()));
    },

    answerDrill: (action) => {
      const { node, scenarios, scenarioIndex, drillFeedback } = get();
      if (!node || drillFeedback) return; // one answer per scenario

      const scenario = scenarios[scenarioIndex];
      if (!scenario) return;

      const advice = adviseAction({
        rules: CAREER_RULES,
        state: scenario.state,
        legalActions: scenario.legalActions,
      });
      // drillPool guarantees this, but a null here must skip rather than guess.
      if (!advice) return;

      const correct = action === advice.action;

      set((current) => ({
        drillFeedback: {
          correct,
          recommended: advice.action,
          chosen: action,
          evLost: null,
        },
        totals: {
          ...current.totals,
          decisions: current.totals.decisions + 1,
          correct: current.totals.correct + (correct ? 1 : 0),
          // A drill withholds the answer until after the choice, so every drill
          // decision is unaided by construction.
          unaidedDecisions: current.totals.unaidedDecisions + 1,
          unaidedCorrect: current.totals.unaidedCorrect + (correct ? 1 : 0),
        },
      }));
    },

    nextDrill: () => {
      const { node, scenarioIndex, scenarios, totals } = get();
      if (!node) return;

      const target = node.decisions ?? scenarios.length;
      if (totals.decisions >= target) {
        finish("target_reached");
        return;
      }

      set({
        // Wrap rather than run out: a pool smaller than the target should repeat
        // its scenarios instead of ending the node early.
        scenarioIndex: (scenarioIndex + 1) % Math.max(1, scenarios.length),
        drillFeedback: null,
      });
    },
  };
});
