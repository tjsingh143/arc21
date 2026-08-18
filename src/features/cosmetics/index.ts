/**
 * The node-safe half of the cosmetics feature: reading the inventory, the
 * loadout, and the catalogue's key set. Nothing here imports React Native, so
 * unit tests import this barrel directly.
 *
 * The drawings — which do import `react-native-svg` — live behind
 * `./art/index.js`, and screens import them from there.
 */

export {
  COSMETIC_KINDS,
  KIND_TABS,
  toItems,
  itemsOfKind,
  summarise,
  lockedLabel,
  canEquip,
  itemSchema,
  type CosmeticKind,
  type CosmeticItem,
  type KindSummary,
} from "./cosmetics.js";
export {
  useCosmeticsStore,
  type InventoryStatus,
  type CosmeticsStoreState,
} from "./cosmetics-store.js";
export {
  DEFAULT_LOADOUT,
  toLoadout,
  useLoadoutStore,
  type EquippedLoadout,
  type LoadoutStoreState,
} from "./loadout-store.js";
export {
  AVATAR_KEYS,
  CARD_BACK_KEYS,
  TABLE_THEME_KEYS,
  DEFAULT_ASSET_KEYS,
} from "./art/keys.js";
