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
 *
 * Disk writes go one at a time, and each writes the record as it stands when
 * its turn comes. Two unordered saves used to finish in either order, so a
 * slow earlier save could leave the OLDER choice on disk under a newer one in
 * memory — and the next launch would load it and carry it to the server
 * (found with the Refresh-B B-F3 reproduction, which held one save open).
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

let saving: Promise<void> = Promise.resolve();

/*
 * WHICH NOTIFICATION CHOICE IS NEWEST (B-H2).
 *
 * A notification offer is asynchronous — an OS permission read, perhaps a
 * prompt, a registration — and the final Refresh-B audit held one open while
 * the player turned notifications on in Settings, turned "Friends" on and then
 * explicitly OFF, and chose "Only me". Released, the old offer registered from
 * its own snapshot and its caller saved the WHOLE snapshot back: Friends on
 * again, and privacy public again, on the server too.
 *
 * Every explicit notification choice advances this counter, synchronously, as
 * the choice is recorded. An asynchronous flow captures it when it begins and
 * may act only while it is unchanged; a newer choice makes it obsolete.
 */
const NOTIFICATION_KEYS = ["notificationsEnabled", "notifyYourTurn", "notifyFriendRequests", "notifyDailyChallenge"] as const;
let notificationIntent = 0;

/** True for as long as no notification choice has been recorded since this was called. */
export function captureNotificationIntent(): () => boolean {
  const captured = notificationIntent;
  return () => captured === notificationIntent;
}

/** Resolves once the record current at its turn is on disk, or failed to be. */
function persistLatest(): Promise<void> {
  const turn = saving.then(async () => {
    try {
      await activePersistence().save(useSettingsStore.getState().settings);
    } catch {
      // The in-memory record is already correct; the next change will retry.
    }
  });
  saving = turn;
  return turn;
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
    // The stored record replaces the defaults wholesale: nothing begun against
    // the defaults may act on it.
    notificationIntent += 1;
    set({ settings: result.settings, failure: result.failure, ready: true });
  },

  update: async (patch) => {
    const next = normaliseSettings({ ...get().settings, ...patch });
    if (NOTIFICATION_KEYS.some((key) => key in patch)) notificationIntent += 1;
    applySettingsSideEffects(next);
    // Clear the failure banner: whatever was wrong on disk is about to be
    // overwritten by a record the user just authored.
    set({ settings: next, failure: null });
    await persistLatest();
  },

  reset: async () => {
    const defaults = { ...DEFAULT_SETTINGS };
    notificationIntent += 1;
    applySettingsSideEffects(defaults);
    set({ settings: defaults, failure: null });
    await persistLatest();
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
