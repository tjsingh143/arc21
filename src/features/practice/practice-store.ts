/**
 * Arc 21 — Practice session store.
 *
 * A thin Zustand wrapper over the shared engine. It owns no game rules: every
 * transition goes through `applyCommand`, and every rendered control comes from
 * `getLegalActions`. If you find yourself deciding here whether a hand can
 * split, you are in the wrong file.
 *
 * Practice is local and offline by design. Its bankroll is disposable and is NOT
 * the global wallet — nothing here can ever credit server chips.
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
import { getLegalActions, type LegalActionSet } from "../../../shared/blackjack/legal-actions.js";
import { computeAdvice, gradeDecision, type DecisionVerdict } from "./advice.js";
import { PracticePersistence } from "./persistence.js";
import { SqliteKeyValueStore } from "../../lib/persistence/key-value-store.js";
import { rulesetKey } from "../../../shared/blackjack/rules.js";
import { ARC_STANDARD_RULES, rulesForTier, TABLE_TIERS } from "../../../shared/blackjack/rules.js";
import { EngineError, type EngineEvent, type PlayerActionType } from "../../../shared/blackjack/types.js";

/** Practice uses the Casual stakes so small bankrolls stay playable. */
const PRACTICE_RULES = rulesForTier(
  TABLE_TIERS.find((tier) => tier.id === "casual") ?? TABLE_TIERS[1]!,
  ARC_STANDARD_RULES,
);

export const PRACTICE_STARTING_BANKROLL = 5_000;
export const PRACTICE_SEAT_ID = "practice";

/** Rendered before a session exists. Nothing is legal with no game. */
export const NO_LEGAL_ACTIONS: LegalActionSet = {
  actions: [],
  chipCost: {},
  canPlaceBet: false,
  canLockBet: false,
  betBounds: null,
  canTakeInsurance: false,
  canDeclineInsurance: false,
  insuranceStake: null,
  insuranceIsEvenMoney: false,
  canStartNextHand: false,
};

/**
 * Assistance modes, all backed by the validated strategy tables.
 *
 *   play       no assistance during the decision
 *   learn      a compact recommendation, expandable to a rationale
 *   analysis   collapsed chip expanding to EVs for every legal action
 *   challenge  no hint before acting; correctness feedback immediately after
 */
export type AssistanceMode = "play" | "learn" | "analysis" | "challenge";

/**
 * Local practice statistics.
 *
 * Strategy accuracy — not win rate — is the mastery metric: short-run blackjack
 * outcomes are dominated by variance, so a player can play perfectly and lose.
 *
 * Decisions are only counted when the tables could actually adjudicate them, so
 * an unpriced state never counts as a mistake. Accuracy is tracked separately
 * for modes that reveal the answer first, because a "correct" decision made
 * while reading the recommendation measures nothing about the player.
 */
export interface PracticeStats {
  handsPlayed: number;
  decisions: number;
  correct: number;
  /** Decisions made without the answer on screen (play and challenge modes). */
  unaidedDecisions: number;
  unaidedCorrect: number;
  estimatedEvLost: number;
  hardDecisions: number;
  hardCorrect: number;
  softDecisions: number;
  softCorrect: number;
  pairDecisions: number;
  pairCorrect: number;
}

const EMPTY_STATS: PracticeStats = {
  handsPlayed: 0,
  decisions: 0,
  correct: 0,
  unaidedDecisions: 0,
  unaidedCorrect: 0,
  estimatedEvLost: 0,
  hardDecisions: 0,
  hardCorrect: 0,
  softDecisions: 0,
  softCorrect: 0,
  pairDecisions: 0,
  pairCorrect: 0,
};

/** Feedback surfaced after a decision in Challenge mode. */
export interface DecisionFeedback extends DecisionVerdict {
  handNumber: number;
}

interface PracticeStore {
  game: EngineState | null;
  /** Chips staged on the felt but not yet locked. */
  stagedBet: number;
  /** Bet carried over as a suggestion for the next hand. Never auto-committed. */
  lastBet: number;
  mode: AssistanceMode;
  recentEvents: EngineEvent[];
  error: string | null;
  stats: PracticeStats;
  /** Most recent graded decision. Drives Challenge feedback and the history drawer. */
  feedback: DecisionFeedback | null;
  /** Every graded decision this session, newest first. */
  decisionLog: DecisionFeedback[];

  start: () => void;
  resetBankroll: () => void;
  setMode: (mode: AssistanceMode) => void;
  dismissFeedback: () => void;
  resetStats: () => void;

  addChip: (denomination: number) => void;
  clearBet: () => void;
  repeatLastBet: () => void;
  lockBet: () => void;

  act: (action: PlayerActionType) => void;
  takeInsurance: () => void;
  declineInsurance: () => void;
  nextHand: () => void;

  /** Restores a saved session, or starts a fresh one. Safe to call twice. */
  hydrate: () => Promise<void>;
  /**
   * Writes the session and waits for it to land.
   *
   * Ordinary autosave is fire-and-forget so play is never blocked on disk, but
   * that leaves a window: an app killed immediately after a command can die
   * before the write completes. The UI awaits this when backgrounding, which is
   * the last moment the app reliably gets before it is suspended or killed.
   */
  flush: () => Promise<void>;
  /** True once hydration has run, so the UI does not flash a new shoe first. */
  hydrated: boolean;
}

/**
 * Swapped for an in-memory store in tests. Left null until first use so a plain
 * Node test process never touches expo-sqlite's native module.
 */
let persistence: PracticePersistence | null = null;

export function setPracticePersistence(next: PracticePersistence | null): void {
  persistence = next;
}

function activePersistence(): PracticePersistence {
  persistence ??= new PracticePersistence(new SqliteKeyValueStore());
  return persistence;
}

/** How long hydration waits for storage before giving up and dealing a fresh shoe. */
export const HYDRATE_TIMEOUT_MS = 2_000;

/**
 * Bounds a storage read.
 *
 * A rejected promise is already handled by the caller's try/catch, but a promise
 * that never settles is not: the native module can fail to initialise, and the
 * player would be left staring at "Shuffling…" forever with no way forward.
 * Losing a resume is a small cost; losing the table entirely is not.
 */
async function withTimeout<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((resolve) => {
        timer = setTimeout(() => resolve(fallback), ms);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * Practice runs on the same CSPRNG as production. It is created lazily so the
 * crypto polyfill is guaranteed to be installed first.
 */
let randomSource: CryptoRandomSource | null = null;
function context(): CommandContext {
  randomSource ??= new CryptoRandomSource();
  return { random: randomSource };
}

function newGame(bankroll: number): EngineState {
  const created = createGame({
    gameId: `practice-${Date.now()}`,
    rules: PRACTICE_RULES,
    seats: [{ seatId: PRACTICE_SEAT_ID, displayName: "You", stack: bankroll }],
    random: context().random!,
    // No timers in Practice: the player sets their own pace.
    timing: null,
  });
  return startSession(created, context()).state;
}

export const usePracticeStore = create<PracticeStore>((set, get) => {
  /**
   * Writes the current session. Fire-and-forget: a failed write must never
   * interrupt play, and the next accepted command will try again.
   */
  async function persistNow(): Promise<void> {
    const { game, stats, mode, lastBet } = get();
    if (!game) return;
    try {
      await activePersistence().save({
        engineState: game,
        stats,
        mode,
        lastBet,
        savedAt: new Date().toISOString(),
      });
    } catch {
      // Losing a save is recoverable; losing the hand to an exception is not.
    }
  }

  /**
   * Runs an engine command, capturing typed errors as UI state rather than
   * throwing into a render. An illegal command leaves the state untouched, so
   * there is nothing to roll back.
   */
  function dispatch(run: (game: EngineState) => { state: EngineState; events: EngineEvent[] }) {
    const { game } = get();
    if (!game) return;

    try {
      const result = run(game);
      // Count a hand when it actually reaches settlement, not when the player
      // taps "next hand" — quitting after the result still played the hand.
      const completed =
        result.state.phase === "HAND_COMPLETE" && game.phase !== "HAND_COMPLETE";

      set((current) => ({
        game: result.state,
        recentEvents: result.events,
        error: null,
        stats: completed
          ? { ...current.stats, handsPlayed: current.stats.handsPlayed + 1 }
          : current.stats,
      }));

      // Autosave after every accepted transition, so an app kill loses at most
      // the command in flight rather than the hand.
      void persistNow();
    } catch (cause) {
      if (cause instanceof EngineError) {
        set({ error: cause.message });
        return;
      }
      throw cause;
    }
  }

  return {
    game: null,
    stagedBet: 0,
    lastBet: 0,
    mode: "play",
    recentEvents: [],
    error: null,
    stats: { ...EMPTY_STATS },
    feedback: null,
    decisionLog: [],

    start: () => {
      set({
        game: newGame(PRACTICE_STARTING_BANKROLL),
        stagedBet: 0,
        lastBet: 0,
        recentEvents: [],
        error: null,
      });
    },

    resetBankroll: () => {
      set({
        game: newGame(PRACTICE_STARTING_BANKROLL),
        stagedBet: 0,
        recentEvents: [],
        error: null,
      });
    },

    setMode: (mode) => set({ mode }),

    addChip: (denomination) => {
      const { game, stagedBet } = get();
      if (!game) return;

      const seat = game.seats[0];
      if (!seat) return;

      const next = stagedBet + denomination;
      const affordable = seat.stack + seat.originalBet;

      // Silently clamp rather than erroring: tapping a chip you cannot fully
      // afford should do the sensible thing, not scold.
      if (next > Math.min(affordable, game.rules.maxBet)) return;

      set({ stagedBet: next, error: null });
      dispatch((current) =>
        applyCommand(current, { type: "PLACE_BET", seatId: PRACTICE_SEAT_ID, amount: next }, context()),
      );
    },

    clearBet: () => {
      set({ stagedBet: 0, error: null });
      // Zero is the engine's "take the chips back off the felt" amount, so the
      // refund happens authoritatively rather than only in the UI.
      dispatch((current) =>
        applyCommand(current, { type: "PLACE_BET", seatId: PRACTICE_SEAT_ID, amount: 0 }, context()),
      );
    },

    repeatLastBet: () => {
      const { lastBet } = get();
      if (lastBet <= 0) return;
      set({ stagedBet: 0 });
      get().addChip(lastBet);
    },

    lockBet: () => {
      const { stagedBet } = get();
      if (stagedBet <= 0) return;
      set({ lastBet: stagedBet });
      dispatch((current) =>
        applyCommand(current, { type: "LOCK_BET", seatId: PRACTICE_SEAT_ID }, context()),
      );
    },

    act: (action) => {
      const { game, mode } = get();
      if (!game) return;

      const seat = game.seats.find((candidate) => candidate.seatId === PRACTICE_SEAT_ID);
      if (!seat) return;

      // Grade against the state as it was BEFORE the action, while the decision
      // the player faced is still the current one.
      const advice = computeAdvice(game, seat, getLegalActions(game, PRACTICE_SEAT_ID).actions);
      const verdict = gradeDecision(advice, action);

      dispatch((current) =>
        applyCommand(current, { type: action, seatId: PRACTICE_SEAT_ID }, context()),
      );

      // Only record when the engine accepted the command; a rejected action was
      // never a decision the player actually made.
      if (get().error !== null || !verdict || !advice.state) return;

      // Learn and Analysis put the answer on screen before the choice, so those
      // decisions cannot measure recall. They still count toward overall
      // accuracy, but are excluded from the unaided figure that means something.
      const unaided = mode === "play" || mode === "challenge";
      const handClass = advice.state.handClass;

      const feedback: DecisionFeedback = { ...verdict, handNumber: game.handNumber };

      // Read stats through the updater rather than from a value captured before
      // dispatch: dispatch may already have incremented `handsPlayed` when the
      // action settled the hand, and writing back a pre-dispatch copy would
      // silently discard it.
      set((current) => ({
        stats: {
          ...current.stats,
          decisions: current.stats.decisions + 1,
          correct: current.stats.correct + (verdict.correct ? 1 : 0),
          unaidedDecisions: current.stats.unaidedDecisions + (unaided ? 1 : 0),
          unaidedCorrect: current.stats.unaidedCorrect + (unaided && verdict.correct ? 1 : 0),
          estimatedEvLost: current.stats.estimatedEvLost + (verdict.evLost ?? 0),
          hardDecisions: current.stats.hardDecisions + (handClass === "hard" ? 1 : 0),
          hardCorrect:
            current.stats.hardCorrect + (handClass === "hard" && verdict.correct ? 1 : 0),
          softDecisions: current.stats.softDecisions + (handClass === "soft" ? 1 : 0),
          softCorrect:
            current.stats.softCorrect + (handClass === "soft" && verdict.correct ? 1 : 0),
          pairDecisions: current.stats.pairDecisions + (handClass === "pair" ? 1 : 0),
          pairCorrect:
            current.stats.pairCorrect + (handClass === "pair" && verdict.correct ? 1 : 0),
        },
        // Feedback is surfaced in Challenge mode; the log is kept in every mode
        // so a post-hand review is always available.
        feedback: mode === "challenge" ? feedback : null,
        decisionLog: [feedback, ...current.decisionLog].slice(0, 100),
      }));
    },

    hydrated: false,

    hydrate: async () => {
      if (get().hydrated) return;

      let restored = false;
      try {
        const result = await withTimeout(
          activePersistence().load(rulesetKey(PRACTICE_RULES)),
          HYDRATE_TIMEOUT_MS,
          { session: null, failure: null },
        );
        if (result.session) {
          set({
            game: result.session.engineState,
            stats: result.session.stats,
            mode: result.session.mode,
            lastBet: result.session.lastBet,
            // A staged bet belongs to a betting round that was interrupted; the
            // engine still holds it, so re-derive rather than assume zero.
            stagedBet: result.session.engineState.seats[0]?.originalBet ?? 0,
            error: null,
          });
          restored = true;
        }
      } catch {
        // A broken save must not prevent play. Fall through to a fresh session.
      }

      if (!restored) get().start();
      set({ hydrated: true });
    },

    flush: async () => {
      await persistNow();
    },

    dismissFeedback: () => set({ feedback: null }),

    resetStats: () => set({ stats: { ...EMPTY_STATS }, decisionLog: [], feedback: null }),

    takeInsurance: () => {
      dispatch((current) =>
        applyCommand(current, { type: "INSURANCE", seatId: PRACTICE_SEAT_ID }, context()),
      );
    },

    declineInsurance: () => {
      dispatch((current) =>
        applyCommand(current, { type: "DECLINE_INSURANCE", seatId: PRACTICE_SEAT_ID }, context()),
      );
    },

    nextHand: () => {
      set({ stagedBet: 0 });
      dispatch((current) => beginNextHand(current, context()));
    },
  };
});
