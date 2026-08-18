/**
 * The catalogue's asset keys, as data — no React and no SVG, so stores and
 * node-side tests can import them without a native renderer in the graph.
 *
 * Two files describe the same set: this one names the keys, and `registry.ts`
 * maps each to its drawing. `tests/cosmetics/registry.test.ts` parses the
 * catalogue in `supabase/seed.sql` and asserts all three agree in both
 * directions, so neither file can drift from the database nor from the other.
 */

export const AVATAR_KEYS = [
  "avatars/house_dealer",
  "avatars/first_chip",
  "avatars/apprentice",
  "avatars/draftsman",
  "avatars/architect",
  "avatars/night_shift",
  "avatars/old_hand",
  "avatars/foundation",
  "avatars/machinist",
  "avatars/skyline",
  "avatars/clockwork",
  "avatars/laurel",
] as const;

export const CARD_BACK_KEYS = [
  "card_backs/arc_standard",
  "card_backs/slate",
  "card_backs/brass",
  "card_backs/drafting",
  "card_backs/blueprint",
  "card_backs/meridian",
  "card_backs/thirty_days",
  "card_backs/podium",
] as const;

export const TABLE_THEME_KEYS = [
  "tables/arc_green",
  "tables/workshop_oak",
  "tables/skyline_dusk",
  "tables/midnight",
] as const;

/**
 * The considered default for each slot — what a guest, a signed-out player and
 * a signed-in player who has equipped nothing all see. All three are
 * `unlock_type = default` in the catalogue, so nothing here shows anybody an
 * item they do not own.
 */
export const DEFAULT_ASSET_KEYS = {
  avatar: "avatars/house_dealer",
  card_back: "card_backs/arc_standard",
  table_theme: "tables/arc_green",
} as const;
