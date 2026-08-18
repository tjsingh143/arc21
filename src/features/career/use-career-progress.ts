/**
 * Career progress, loaded once and shared across screens.
 *
 * A tiny Zustand store rather than React context: the map, the node detail and
 * Home all read this, and threading a provider through three route groups to
 * share one small immutable record is more machinery than the problem needs.
 */

import { useEffect } from "react";
import { create } from "zustand";

import {
  emptyCareerProgress,
  recordSessionResult,
  type CareerProgress,
} from "../../../shared/career/index.js";
import type { CareerNode } from "../../../shared/career/types.js";
import { evaluateStars, type CareerSessionResult } from "../../../shared/career/stars.js";
import { CareerPersistence } from "./career-persistence.js";
import { SqliteKeyValueStore } from "../../lib/persistence/key-value-store.js";

/** Swapped for an in-memory store in tests. */
let persistence: CareerPersistence | null = null;

export function setCareerPersistence(next: CareerPersistence | null): void {
  persistence = next;
}

function activePersistence(): CareerPersistence {
  persistence ??= new CareerPersistence(new SqliteKeyValueStore());
  return persistence;
}

/** Matches the Practice store's hydration bound, and for the same reason. */
export const CAREER_LOAD_TIMEOUT_MS = 2_000;

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

interface CareerStore {
  progress: CareerProgress;
  ready: boolean;
  load: () => Promise<void>;
  /** Records a finished attempt and persists the updated record. */
  record: (node: CareerNode, result: CareerSessionResult) => Promise<void>;
  reset: () => Promise<void>;
}

export const useCareerStore = create<CareerStore>((set, get) => ({
  progress: emptyCareerProgress(),
  ready: false,

  load: async () => {
    if (get().ready) return;
    try {
      // Storage that never answers must not leave Career permanently blank; an
      // empty record is a truthful fallback, since nothing has been proven.
      const result = await withTimeout(activePersistence().load(), CAREER_LOAD_TIMEOUT_MS, {
        progress: emptyCareerProgress(),
        failure: null,
      });
      set({ progress: result.progress });
    } catch {
      // Fall through to empty progress rather than blocking the screen.
    }
    set({ ready: true });
  },

  record: async (node, result) => {
    // Evaluation is derived here rather than passed in, so a caller can never
    // record a star count the session result does not actually justify.
    const evaluation = evaluateStars(node, result);
    const next = recordSessionResult(
      get().progress,
      node,
      evaluation,
      result,
      new Date().toISOString(),
    );
    set({ progress: next });
    try {
      await activePersistence().save(next);
    } catch {
      // The in-memory record is already correct; the next save will retry.
    }
  },

  reset: async () => {
    const empty = emptyCareerProgress();
    set({ progress: empty });
    try {
      await activePersistence().save(empty);
    } catch {
      // Non-fatal.
    }
  },
}));

/** Loads progress on first use and returns it. */
export function useCareerProgress(): { progress: CareerProgress; ready: boolean } {
  const progress = useCareerStore((state) => state.progress);
  const ready = useCareerStore((state) => state.ready);
  const load = useCareerStore((state) => state.load);

  useEffect(() => {
    if (!ready) void load();
  }, [ready, load]);

  return { progress, ready };
}
