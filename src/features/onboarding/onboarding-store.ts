/**
 * Arc 21 — onboarding gate state.
 *
 * Small on purpose: read the flag once per launch, expose whether it has
 * settled, and record completion. Every decision derived from it lives in
 * `launch.ts` as a pure function.
 *
 * Hydration is TIME-BOUNDED for the same reason the Practice table's is: a
 * rejected promise is already handled, but a storage module that fails to
 * initialise returns a promise that never settles, and the player would be left
 * looking at an empty background with no way forward. Losing the flag costs
 * three pages; losing the launch costs the app.
 */

import { create } from "zustand";

import { SqliteKeyValueStore } from "../../lib/persistence/key-value-store.js";
import {
  buildCompletion,
  OnboardingFlagStore,
  type OnboardingCompletion,
  type OnboardingEntry,
} from "./onboarding-flag.js";

/** How long the launch waits for storage before assuming a first launch. */
export const ONBOARDING_HYDRATE_TIMEOUT_MS = 2_000;

/**
 * Left null until first use so a plain Node test process never touches
 * expo-sqlite's native module. Swappable for a `MemoryKeyValueStore`-backed
 * instance in tests.
 */
let flagStore: OnboardingFlagStore | null = null;

export function setOnboardingFlagStore(next: OnboardingFlagStore | null): void {
  flagStore = next;
}

function activeFlagStore(): OnboardingFlagStore {
  // The same database file as the Practice session — one local store, not two.
  flagStore ??= new OnboardingFlagStore(new SqliteKeyValueStore());
  return flagStore;
}

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

interface OnboardingStore {
  /** True once the read has settled — including when it timed out or failed. */
  hydrated: boolean;
  completion: OnboardingCompletion | null;
  hydrate: () => Promise<void>;
  complete: (entry: OnboardingEntry) => void;
  /** Replays the introduction. Exposed for Settings; unused by the shell today. */
  reset: () => Promise<void>;
}

export const useOnboardingStore = create<OnboardingStore>((set, get) => ({
  hydrated: false,
  completion: null,

  hydrate: async () => {
    if (get().hydrated) return;

    let completion: OnboardingCompletion | null = null;
    try {
      completion = await withTimeout(activeFlagStore().read(), ONBOARDING_HYDRATE_TIMEOUT_MS, null);
    } catch {
      // An unreadable flag is indistinguishable from a first launch, and is
      // treated as one. Showing the disclosure again is the safe direction.
    }

    set({ completion, hydrated: true });
  },

  /**
   * Flips the gate immediately and persists in the background.
   *
   * Making the player wait on a disk write to leave a marketing screen would
   * trade a certain delay for an uncertain one. If the write is lost they see
   * the introduction once more next launch, which is recoverable; a stalled
   * "Continue" button is not.
   */
  complete: (entry) => {
    const store = activeFlagStore();
    const now = new Date();

    // Built by the same function that writes the record, so the in-memory value
    // and the persisted one can never describe different things.
    set({ completion: buildCompletion(entry, now), hydrated: true });

    void store.complete(entry, now).catch(() => {
      // Best effort. The next launch re-shows the introduction at worst.
    });
  },

  reset: async () => {
    try {
      await activeFlagStore().clear();
    } finally {
      set({ completion: null, hydrated: true });
    }
  },
}));
