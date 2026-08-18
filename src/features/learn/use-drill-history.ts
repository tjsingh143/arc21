/**
 * Arc 21 — drill history, loaded once and shared across the Learn screens.
 *
 * A small Zustand store, deliberately shaped like `use-career-progress.ts`: the
 * category list and the session screen both read this, and two different answers
 * to "where does drill history live" would be one too many.
 *
 * The store is the only place in Learn that touches storage. Everything it holds
 * comes back through the validating loader in `drill-history.ts`, so a corrupt
 * blob resets the review queue rather than crashing the screen.
 *
 * Writes are fire-and-forget on purpose: the in-memory history is already
 * correct when a question is graded, and blocking the next question on a disk
 * write would make the drill feel broken on a slow device. A failed write costs
 * at most the scheduling weight of one answer, and the next one retries.
 */

import { useEffect } from "react";
import { create } from "zustand";

import { SqliteKeyValueStore } from "../../lib/persistence/key-value-store.js";
import {
  DrillHistoryStore,
  type DrillHistoryLoadFailure,
} from "./drill-history.js";
import { recordDrillAnswer, type DrillHistory } from "./spaced-repetition.js";

/** Swapped for an in-memory store in tests. */
let store: DrillHistoryStore | null = null;

export function setDrillHistoryStore(next: DrillHistoryStore | null): void {
  store = next;
}

function activeStore(): DrillHistoryStore {
  store ??= new DrillHistoryStore(new SqliteKeyValueStore());
  return store;
}

/** Matches the Practice and Career stores, and for the same reason. */
export const DRILL_HISTORY_LOAD_TIMEOUT_MS = 2_000;

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

const EMPTY: DrillHistory = Object.freeze({});

interface DrillHistoryState {
  history: DrillHistory;
  ready: boolean;
  /** Why a previous save could not be read, if that happened. Diagnostic only. */
  loadFailure: DrillHistoryLoadFailure | null;
  load: () => Promise<void>;
  /** Records one graded answer and persists the updated history. */
  record: (key: string, correct: boolean) => Promise<void>;
  reset: () => Promise<void>;
}

export const useDrillHistoryStore = create<DrillHistoryState>((set, get) => ({
  history: EMPTY,
  ready: false,
  loadFailure: null,

  load: async () => {
    if (get().ready) return;
    try {
      // Storage that never answers must not leave the drills permanently blank.
      // An empty history is truthful — nothing has been proven — and the player
      // can still drill, they simply start from an unweighted rotation.
      const result = await withTimeout(activeStore().load(), DRILL_HISTORY_LOAD_TIMEOUT_MS, {
        history: EMPTY,
        failure: null,
      });
      set({ history: result.history, loadFailure: result.failure });
    } catch {
      set({ history: EMPTY, loadFailure: null });
    }
    set({ ready: true });
  },

  record: async (key, correct) => {
    const next = recordDrillAnswer(get().history, key, correct, Date.now());
    set({ history: next });
    try {
      await activeStore().save(next);
    } catch {
      // In-memory history is already correct; the next answer's save retries.
    }
  },

  reset: async () => {
    set({ history: EMPTY, loadFailure: null });
    try {
      await activeStore().clear();
    } catch {
      // Non-fatal: the cleared history is already what the screens read.
    }
  },
}));

export interface UseDrillHistory {
  history: DrillHistory;
  ready: boolean;
  record: (key: string, correct: boolean) => Promise<void>;
}

/** Loads history on first use and returns it. */
export function useDrillHistory(): UseDrillHistory {
  const history = useDrillHistoryStore((state) => state.history);
  const ready = useDrillHistoryStore((state) => state.ready);
  const load = useDrillHistoryStore((state) => state.load);
  const record = useDrillHistoryStore((state) => state.record);

  useEffect(() => {
    if (!ready) void load();
  }, [ready, load]);

  return { history, ready, record };
}
