/**
 * The equipped loadout, as client state — the consumer `my_loadout()` never
 * had. Until this existed, equipping a cosmetic changed a database row and
 * nothing else happened anywhere in the app.
 *
 * The resting state is the DEFAULT loadout, not an empty one. A guest, a
 * signed-out player and a signed-in player who has equipped nothing all get
 * the same considered look — the three `unlock_type = default` items — so
 * every surface that reads this store can render immediately and offline.
 * Practice never waits on this fetch.
 */

import { z } from "zod";
import { create } from "zustand";

import { getSupabase } from "../../lib/supabase/client.js";
import { isTimedOut, withTimeout } from "../../lib/supabase/with-timeout.js";
import {
  AVATAR_KEYS,
  CARD_BACK_KEYS,
  DEFAULT_ASSET_KEYS,
  TABLE_THEME_KEYS,
} from "./art/keys.js";

const AVATARS = new Set<string>(AVATAR_KEYS);
const CARD_BACKS = new Set<string>(CARD_BACK_KEYS);
const TABLE_THEMES = new Set<string>(TABLE_THEME_KEYS);

export interface EquippedLoadout {
  readonly avatarKey: string;
  readonly cardBackKey: string;
  readonly tableThemeKey: string;
}

export const DEFAULT_LOADOUT: EquippedLoadout = {
  avatarKey: DEFAULT_ASSET_KEYS.avatar,
  cardBackKey: DEFAULT_ASSET_KEYS.card_back,
  tableThemeKey: DEFAULT_ASSET_KEYS.table_theme,
};

const slotSchema = z.object({
  slot: z.enum(["avatar", "card_back", "table_theme"]),
  asset_key: z.string().nullable(),
});

/**
 * Server rows to a full loadout.
 *
 * Every gap falls back to the slot's default: a missing row, a slot equipped
 * with nothing, and — deliberately — an `asset_key` this build has no art for,
 * which can happen when the catalogue gains an item before the app that draws
 * it ships. A default in that moment is honest; a blank would be a defect.
 */
export function toLoadout(value: unknown): EquippedLoadout {
  let avatarKey: string = DEFAULT_LOADOUT.avatarKey;
  let cardBackKey: string = DEFAULT_LOADOUT.cardBackKey;
  let tableThemeKey: string = DEFAULT_LOADOUT.tableThemeKey;

  if (Array.isArray(value)) {
    for (const candidate of value) {
      const parsed = slotSchema.safeParse(candidate);
      if (!parsed.success || parsed.data.asset_key === null) continue;
      const key = parsed.data.asset_key;
      switch (parsed.data.slot) {
        case "avatar":
          if (AVATARS.has(key)) avatarKey = key;
          break;
        case "card_back":
          if (CARD_BACKS.has(key)) cardBackKey = key;
          break;
        case "table_theme":
          if (TABLE_THEMES.has(key)) tableThemeKey = key;
          break;
      }
    }
  }

  return { avatarKey, cardBackKey, tableThemeKey };
}

export interface LoadoutStoreState {
  readonly loadout: EquippedLoadout;
  load: () => Promise<void>;
}

async function bounded<T>(work: PromiseLike<T>): Promise<T | null> {
  const result = await withTimeout(Promise.resolve(work), undefined);
  return isTimedOut(result) ? null : result;
}

export const useLoadoutStore = create<LoadoutStoreState>((set) => ({
  loadout: DEFAULT_LOADOUT,

  load: async () => {
    const availability = getSupabase();
    if (availability.status !== "ready") {
      set({ loadout: DEFAULT_LOADOUT });
      return;
    }

    const session = await bounded(availability.client.auth.getSession());
    if (session === null || !session.data.session) {
      set({ loadout: DEFAULT_LOADOUT });
      return;
    }

    const result = await bounded(availability.client.rpc("my_loadout"));
    if (result === null || result.error) {
      // Unreachable is not unequipped: keep whatever was last known rather
      // than snapping a player's table back to defaults on a network blip.
      return;
    }

    set({ loadout: toLoadout(result.data) });
  },
}));
