/**
 * Reward-bearing career attempts, which run on the SERVER.
 *
 * The distinction this store exists to draw:
 *
 *   `career-session-store.ts`  local, offline, unranked. Grants nothing.
 *   this file                  server-authoritative. Grants chips, XP, stars
 *                              and cosmetics.
 *
 * That is the specification's own line — "A Career node may be practiced
 * offline, but any reward-bearing attempt requires server authority" — and both
 * halves ship. A player with no account, or no connection, still gets every
 * node, every star target and every drill; what they do not get is chips they
 * did not earn under a shoe the server owns.
 *
 * Nothing here computes a result. It starts an attempt, hands the table to the
 * shared table screen or the drill to the drill screen, and reports what the
 * server said. A store that could decide a star is a store an attacker could
 * decide one from.
 */

import { create } from "zustand";

import type { Card, PlayerActionType } from "../../../shared/blackjack/index.js";
import { getSupabase } from "../../lib/supabase/client.js";
import { readRejection } from "../../lib/supabase/rejection.js";
import { isTimedOut, withTimeout } from "../../lib/supabase/with-timeout.js";
import { useWalletStore } from "../wallet/wallet-store.js";

/** One drill question, exactly as the server issued it. */
export interface ServerDrillScenario {
  readonly index: number;
  readonly playerCards: readonly Card[];
  readonly dealerUpCard: Card;
  readonly legalActions: readonly PlayerActionType[];
  readonly label: string;
  readonly upcardLabel: string;
}

export interface StartedCareerAttempt {
  readonly attemptId: string;
  readonly nodeSlug: string;
  readonly format: "standard" | "drill";
  readonly startingChips: number;
  readonly gameId: string | null;
  readonly seatId: string | null;
  readonly scenarios: readonly ServerDrillScenario[];
  readonly bestStars: number;
  /** True when this node's first-completion reward has already been paid. */
  readonly rewardPaid: boolean;
}

export interface DrillVerdictRow {
  readonly chosen: PlayerActionType;
  readonly recommended: PlayerActionType;
  readonly correct: boolean;
}

export interface GradedDrill {
  readonly stars: number;
  readonly decisions: number;
  readonly correct: number;
  readonly rewardChips: number;
  readonly rewardXp: number;
  readonly verdicts: readonly DrillVerdictRow[];
}

/** Server-recorded progress, keyed by node slug. */
export interface ServerNodeProgress {
  readonly stars: number;
  readonly attempts: number;
  readonly completed: boolean;
  readonly rewardClaimed: boolean;
}

export interface CareerServerState {
  readonly progress: Readonly<Record<string, ServerNodeProgress>>;
  readonly loaded: boolean;
  readonly busy: boolean;
  readonly notice: string | null;

  /** The current drill, once one has been started. */
  readonly drill: StartedCareerAttempt | null;
  readonly graded: GradedDrill | null;

  refresh: () => Promise<void>;
  /** Starts a ranked attempt, or returns null and sets `notice`. */
  start: (nodeSlug: string) => Promise<StartedCareerAttempt | null>;
  submitDrill: (answers: readonly PlayerActionType[]) => Promise<GradedDrill | null>;
  clearDrill: () => void;
}

const UNREACHABLE = "Could not reach the server. Nothing has been recorded.";
const SIGNED_OUT = "Ranked career attempts need an account. Practice stays available without one.";

async function bounded<T>(work: PromiseLike<T>): Promise<T | null> {
  const result = await withTimeout(Promise.resolve(work), undefined);
  return isTimedOut(result) ? null : result;
}

function toProgress(value: unknown): Record<string, ServerNodeProgress> {
  if (!Array.isArray(value)) return {};
  const map: Record<string, ServerNodeProgress> = {};
  for (const row of value) {
    const candidate = row as {
      node_code?: unknown;
      stars?: unknown;
      attempts?: unknown;
      status?: unknown;
      reward_claimed_at?: unknown;
    };
    if (typeof candidate.node_code !== "string") continue;
    map[candidate.node_code] = {
      stars: typeof candidate.stars === "number" ? candidate.stars : 0,
      attempts: typeof candidate.attempts === "number" ? candidate.attempts : 0,
      completed: candidate.status === "completed",
      rewardClaimed: typeof candidate.reward_claimed_at === "string",
    };
  }
  return map;
}

export const useCareerServerStore = create<CareerServerState>((set, get) => ({
  progress: {},
  loaded: false,
  busy: false,
  notice: null,
  drill: null,
  graded: null,

  refresh: async () => {
    const availability = getSupabase();
    if (availability.status !== "ready") {
      // Not an error. An unconfigured build plays career offline, and the map
      // says so rather than showing an empty server record as if it were one.
      set({ loaded: true });
      return;
    }
    const result = await bounded(availability.client.rpc("my_career_progress"));
    if (result === null || result.error) {
      set({ loaded: true });
      return;
    }
    set({ progress: toProgress(result.data), loaded: true });
  },

  start: async (nodeSlug) => {
    const availability = getSupabase();
    if (availability.status !== "ready") {
      set({ notice: availability.message });
      return null;
    }

    const session = await bounded(availability.client.auth.getSession());
    if (session === null) {
      set({ notice: UNREACHABLE });
      return null;
    }
    if (!session.data.session) {
      set({ notice: SIGNED_OUT });
      return null;
    }

    set({ busy: true, notice: null, graded: null });
    const result = await bounded(
      availability.client.functions.invoke("create-session", {
        body: {
          action: "START_CAREER_NODE",
          clientRequestId: globalThis.crypto.randomUUID(),
          nodeSlug,
          clientSentAt: new Date().toISOString(),
        },
      }),
    );
    set({ busy: false });

    if (result === null) {
      set({ notice: UNREACHABLE });
      return null;
    }
    if (result.error) {
      const rejection = await readRejection(result.error);
      set({
        notice:
          rejection?.code === "SESSION_ALREADY_ACTIVE"
            ? "You are already seated at a table. Return to it from Play and leave it there — nothing has been charged for this."
            : (rejection?.message ?? UNREACHABLE),
      });
      return null;
    }

    const data = result.data as Record<string, unknown> | null;
    if (typeof data?.attemptId !== "string" || typeof data.nodeSlug !== "string") {
      set({ notice: "The attempt opened, but the reply could not be read. Reopen this node." });
      return null;
    }

    const attempt: StartedCareerAttempt = {
      attemptId: data.attemptId,
      nodeSlug: data.nodeSlug,
      format: data.format === "drill" ? "drill" : "standard",
      startingChips: typeof data.startingChips === "number" ? data.startingChips : 0,
      gameId: typeof data.gameId === "string" ? data.gameId : null,
      seatId: typeof data.seatId === "string" ? data.seatId : null,
      scenarios: Array.isArray(data.scenarios) ? (data.scenarios as ServerDrillScenario[]) : [],
      bestStars: typeof data.bestStars === "number" ? data.bestStars : 0,
      rewardPaid: data.rewardPaid === true,
    };
    if (attempt.format === "drill") set({ drill: attempt });
    return attempt;
  },

  submitDrill: async (answers) => {
    const attempt = get().drill;
    if (!attempt) return null;

    const availability = getSupabase();
    if (availability.status !== "ready") {
      set({ notice: availability.message });
      return null;
    }

    set({ busy: true, notice: null });
    const result = await bounded(
      availability.client.functions.invoke("create-session", {
        body: {
          action: "SUBMIT_CAREER_DRILL",
          clientRequestId: globalThis.crypto.randomUUID(),
          attemptId: attempt.attemptId,
          answers,
          clientSentAt: new Date().toISOString(),
        },
      }),
    );
    set({ busy: false });

    if (result === null) {
      set({ notice: UNREACHABLE });
      return null;
    }
    if (result.error) {
      const rejection = await readRejection(result.error);
      set({ notice: rejection?.message ?? UNREACHABLE });
      return null;
    }

    const data = result.data as Record<string, unknown> | null;
    if (typeof data?.stars !== "number") {
      set({ notice: "The drill was graded, but the reply could not be read. Reopen this node." });
      return null;
    }

    const graded: GradedDrill = {
      stars: data.stars,
      decisions: typeof data.decisions === "number" ? data.decisions : 0,
      correct: typeof data.correct === "number" ? data.correct : 0,
      rewardChips: typeof data.rewardChips === "number" ? data.rewardChips : 0,
      rewardXp: typeof data.rewardXp === "number" ? data.rewardXp : 0,
      verdicts: Array.isArray(data.verdicts) ? (data.verdicts as DrillVerdictRow[]) : [],
    };
    set({ graded });

    // Chips actually moved. The header caches the balance for the life of the
    // session, so without this a player who just earned 350 keeps seeing the
    // old number until the next launch.
    if (graded.rewardChips > 0) void useWalletStore.getState().refresh();
    await get().refresh();
    return graded;
  },

  clearDrill: () => set({ drill: null, graded: null, notice: null }),
}));
