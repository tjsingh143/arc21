/**
 * The cosmetic art registry: every `asset_key` in the catalogue, resolved to
 * the drawing that renders it.
 *
 * This mapping is the difference between a cosmetic system and a database of
 * names — an `asset_key` with no entry here is an item that can be earned,
 * owned and equipped while rendering nothing, which is exactly the
 * built-but-never-connected defect this project has now found eight times.
 * `tests/cosmetics/registry.test.ts` parses the catalogue in
 * `supabase/seed.sql` and asserts this registry and the catalogue agree in
 * both directions, so a new cosmetic cannot ship silently invisible.
 */

import {
  Apprentice,
  Architect,
  Clockwork,
  Draftsman,
  FirstChip,
  Foundation,
  HouseDealer,
  Laurel,
  Machinist,
  NightShift,
  OldHand,
  Skyline,
  type AvatarMark,
} from "./avatars.js";
import {
  ArcStandard,
  Blueprint,
  Brass,
  Drafting,
  Meridian,
  Podium,
  Slate,
  ThirtyDays,
  type CardBackArt,
} from "./card-backs.js";
import {
  ArcGreen,
  Midnight,
  SkylineDusk,
  WorkshopOak,
  type TableThemeArt,
} from "./table-themes.js";
import { DEFAULT_ASSET_KEYS } from "./keys.js";

export { DEFAULT_ASSET_KEYS } from "./keys.js";

export const AVATAR_ART: Record<string, AvatarMark> = {
  "avatars/house_dealer": HouseDealer,
  "avatars/first_chip": FirstChip,
  "avatars/apprentice": Apprentice,
  "avatars/draftsman": Draftsman,
  "avatars/architect": Architect,
  "avatars/night_shift": NightShift,
  "avatars/old_hand": OldHand,
  "avatars/foundation": Foundation,
  "avatars/machinist": Machinist,
  "avatars/skyline": Skyline,
  "avatars/clockwork": Clockwork,
  "avatars/laurel": Laurel,
};

export const CARD_BACK_ART: Record<string, CardBackArt> = {
  "card_backs/arc_standard": ArcStandard,
  "card_backs/slate": Slate,
  "card_backs/brass": Brass,
  "card_backs/drafting": Drafting,
  "card_backs/blueprint": Blueprint,
  "card_backs/meridian": Meridian,
  "card_backs/thirty_days": ThirtyDays,
  "card_backs/podium": Podium,
};

export const TABLE_THEME_ART: Record<string, TableThemeArt> = {
  "tables/arc_green": ArcGreen,
  "tables/workshop_oak": WorkshopOak,
  "tables/skyline_dusk": SkylineDusk,
  "tables/midnight": Midnight,
};

/** Art for an avatar key, falling back to the default for an unknown one. */
export function avatarArt(assetKey: string | null): AvatarMark {
  return (
    (assetKey !== null ? AVATAR_ART[assetKey] : undefined) ??
    (AVATAR_ART[DEFAULT_ASSET_KEYS.avatar] as AvatarMark)
  );
}

/** Art for a card-back key, falling back to the default for an unknown one. */
export function cardBackArt(assetKey: string | null): CardBackArt {
  return (
    (assetKey !== null ? CARD_BACK_ART[assetKey] : undefined) ??
    (CARD_BACK_ART[DEFAULT_ASSET_KEYS.card_back] as CardBackArt)
  );
}

/** Art for a table-theme key, falling back to the default for an unknown one. */
export function tableThemeArt(assetKey: string | null): TableThemeArt {
  return (
    (assetKey !== null ? TABLE_THEME_ART[assetKey] : undefined) ??
    (TABLE_THEME_ART[DEFAULT_ASSET_KEYS.table_theme] as TableThemeArt)
  );
}
