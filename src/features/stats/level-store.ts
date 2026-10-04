import { playerScopedSetter } from "../player/player-scope.js";
/**
 * Level and XP, read from the server.
 *
 * This exists because the audit for this phase found the Profile screen passing
 * `hasAccount: false` as a hardcoded constant, months after accounts, wallets,
 * XP and the level curve had all shipped. Every signed-in player was shown the
 * guest profile, and the level bar — which `progressionState` has been able to
 * render since phase 6 — could never appear for anybody.
 *
 * `my_level_progress` is derived on the server from stored XP by a trigger, so
 * there is no arithmetic here to disagree with it. A client that computed a
 * level from an XP figure would be a second implementation of a rule, and the
 * one thing this project does not do is have two.
 */

import { create } from "zustand";
import { z } from "zod";

import { getSupabase } from "../../lib/supabase/client.js";
import { confirmedSession } from "../../lib/supabase/player-binding.js";
import { isTimedOut, withTimeout } from "../../lib/supabase/with-timeout.js";
import type { ProgressionRecord } from "./profile.js";

const rowSchema = z.object({
  level: z.number().int().min(1),
  total_xp: z.number().int().min(0),
  xp_into_level: z.number().int().min(0),
  /** Null at the level cap: there is no next level to be part-way through. */
  xp_for_next_level: z.number().int().min(1).nullable(),
  is_max_level: z.boolean(),
});

export interface LevelStoreState {
  /**
   * Null until a signed-in player's progression has been read. Null is what
   * makes the screen say "not available" instead of drawing a zero — a zero is
   * a value, and a value nobody earned is a fabrication however small.
   */
  readonly record: ProgressionRecord | null;
  readonly atMaxLevel: boolean;
  readonly loaded: boolean;

  load: () => Promise<void>;
  clear: () => void;
}

export const useLevelStore = create<LevelStoreState>((set) => ({
  record: null,
  atMaxLevel: false,
  loaded: false,

  load: async () => {
    const setForPlayer = playerScopedSetter(set);
    const availability = getSupabase();
    if (availability.status !== "ready") {
      setForPlayer({ record: null, atMaxLevel: false, loaded: true });
      return;
    }

    const session = await withTimeout(
      Promise.resolve(confirmedSession(availability.client)),
      undefined,
    );
    if (isTimedOut(session) || !session.data.session) {
      setForPlayer({ record: null, atMaxLevel: false, loaded: true });
      return;
    }

    const response = await withTimeout(
      Promise.resolve(availability.client.rpc("my_level_progress")),
      undefined,
    );
    if (isTimedOut(response) || response.error) {
      // Unreachable is not the same as "no account". The screen distinguishes
      // them, so this leaves the record null and lets it say so.
      setForPlayer({ record: null, atMaxLevel: false, loaded: true });
      return;
    }

    const rows = Array.isArray(response.data) ? response.data : [response.data];
    const parsed = rowSchema.safeParse(rows[0]);
    if (!parsed.success) {
      setForPlayer({ record: null, atMaxLevel: false, loaded: true });
      return;
    }

    setForPlayer({
      record: {
        level: parsed.data.level,
        xpIntoLevel: parsed.data.xp_into_level,
        // At the cap the bar has no denominator. Reporting the XP already in the
        // level keeps `rate()` at 1 rather than dividing by zero.
        xpForNextLevel: parsed.data.xp_for_next_level ?? Math.max(1, parsed.data.xp_into_level),
      },
      atMaxLevel: parsed.data.is_max_level,
      loaded: true,
    });
  },

  clear: () => set({ record: null, atMaxLevel: false, loaded: false }),
}));
