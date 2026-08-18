/**
 * The drawing half of the cosmetics feature. Everything exported here imports
 * `react-native-svg`, so it is kept out of the feature's main barrel — stores
 * and node-side tests use `../index.js` instead.
 */

export {
  AVATAR_ART,
  CARD_BACK_ART,
  TABLE_THEME_ART,
  DEFAULT_ASSET_KEYS,
  avatarArt,
  cardBackArt,
  tableThemeArt,
} from "./registry.js";
export { CosmeticAvatar } from "./CosmeticAvatar.js";
export { TableSurface } from "./TableSurface.js";
export type { AvatarMark, AvatarMarkProps } from "./avatars.js";
export type { CardBackArt as CardBackArtComponent, CardBackArtProps } from "./card-backs.js";
export type { TableThemeArt as TableThemeArtDefinition, ThemeElementProps } from "./table-themes.js";
