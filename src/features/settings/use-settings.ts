/**
 * Settings, loaded once and shared across screens.
 *
 * Kept apart from `settings.ts` so the serialisation stays importable in a plain
 * Node test process — this file is the only part that touches Zustand, storage
 * and the audio/haptics adapters.
 *
 * Writes are optimistic: the in-memory record updates immediately and the disk
 * write is awaited in the background. A toggle that waits on SQLite before it
 * moves feels broken, and a failed write costs one preference, not the app.
 */

import { useEffect } from "react";
import { create } from "zustand";

import { setSoundEnabled } from "../../lib/audio/audio.js";
import { setHapticsEnabled } from "../../lib/haptics/haptics.js";
import { SqliteKeyValueStore } from "../../lib/persistence/key-value-store.js";
import {
  DEFAULT_SETTINGS,
  SettingsPersistence,
  normaliseSettings,
  type AppSettings,
  type SettingsLoadFailure,
} from "./settings.js";

/** Swapped for an in-memory store in tests. */
let persistence: SettingsPersistence | null = null;

export function setSettingsPersistence(next: SettingsPersistence | null): void {
  persistence = next;
}

function activePersistence(): SettingsPersistence {
  persistence ??= new SettingsPersistence(new SqliteKeyValueStore());
  return persistence;
}

/** Matches the Practice store's hydration bound, and for the same reason. */
export const SETTINGS_LOAD_TIMEOUT_MS = 2_000;

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
 * Pushes the preferences that have a live adapter into it.
 *
 * Only sound and haptics have one today. The rest are stored for the surfaces
 * that will read them; nothing here pretends otherwise.
 */
export function applySettingsSideEffects(settings: AppSettings): void {
  setSoundEnabled(settings.soundEnabled);
  setHapticsEnabled(settings.hapticsEnabled);
}

interface SettingsStore {
  settings: AppSettings;
  ready: boolean;
  /** Why the stored blob was discarded, if it was. Surfaced once, quietly. */
  failure: SettingsLoadFailure | null;
  load: () => Promise<void>;
  /** Applies a partial change, normalises it, and persists the result. */
  update: (patch: Partial<AppSettings>) => Promise<void>;
  reset: () => Promise<void>;
}

export const useSettingsStore = create<SettingsStore>((set, get) => ({
  settings: { ...DEFAULT_SETTINGS },
  ready: false,
  failure: null,

  load: async () => {
    if (get().ready) return;

    let result = { settings: { ...DEFAULT_SETTINGS }, failure: null as SettingsLoadFailure | null };
    try {
      // Storage that never answers must not leave the app without preferences;
      // defaults are always a usable answer.
      result = await withTimeout(activePersistence().load(), SETTINGS_LOAD_TIMEOUT_MS, result);
    } catch {
      // Fall through to defaults rather than blocking every screen.
    }

    applySettingsSideEffects(result.settings);
    set({ settings: result.settings, failure: result.failure, ready: true });
  },

  update: async (patch) => {
    const next = normaliseSettings({ ...get().settings, ...patch });
    applySettingsSideEffects(next);
    // Clear the failure banner: whatever was wrong on disk is about to be
    // overwritten by a record the user just authored.
    set({ settings: next, failure: null });

    try {
      await activePersistence().save(next);
    } catch {
      // The in-memory record is already correct; the next change will retry.
    }
  },

  reset: async () => {
    const defaults = { ...DEFAULT_SETTINGS };
    applySettingsSideEffects(defaults);
    set({ settings: defaults, failure: null });

    try {
      await activePersistence().save(defaults);
    } catch {
      // Non-fatal.
    }
  },
}));

/** Loads settings on first use and returns them. */
export function useSettings(): {
  settings: AppSettings;
  ready: boolean;
  failure: SettingsLoadFailure | null;
  update: (patch: Partial<AppSettings>) => Promise<void>;
  reset: () => Promise<void>;
} {
  const settings = useSettingsStore((state) => state.settings);
  const ready = useSettingsStore((state) => state.ready);
  const failure = useSettingsStore((state) => state.failure);
  const load = useSettingsStore((state) => state.load);
  const update = useSettingsStore((state) => state.update);
  const reset = useSettingsStore((state) => state.reset);

  useEffect(() => {
    if (!ready) void load();
  }, [ready, load]);

  return { settings, ready, failure, update, reset };
}
