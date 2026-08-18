/**
 * Reading the cosmetic inventory.
 *
 * A locked item shows what to DO to earn it — the server sends the requirement in
 * words, derived from the same predicate that would unlock it — and never a price,
 * because there is nothing to buy. The specification is explicit: no purchase
 * price in the MVP, and no Shop route.
 */

import { z } from "zod";

export const COSMETIC_KINDS = ["avatar", "card_back", "table_theme"] as const;
export type CosmeticKind = (typeof COSMETIC_KINDS)[number];

export const itemSchema = z.object({
  cosmetic_id: z.string().uuid(),
  code: z.string(),
  kind: z.enum(COSMETIC_KINDS),
  name: z.string(),
  description: z.string().nullable(),
  asset_key: z.string(),
  owned: z.boolean(),
  equipped: z.boolean(),
  unlock_type: z.string(),
  requirement: z.string().nullable(),
  sort_order: z.number().int(),
});

export type CosmeticItem = z.infer<typeof itemSchema>;

export function toItems(value: unknown): CosmeticItem[] {
  if (!Array.isArray(value)) return [];
  const rows: CosmeticItem[] = [];
  for (const candidate of value) {
    const parsed = itemSchema.safeParse(candidate);
    // A row that cannot be read is dropped. Showing an item whose ownership could
    // not be parsed would either tease something owned or hide something earned.
    if (parsed.success) rows.push(parsed.data);
  }
  return rows;
}

/** Tab labels, in the specification's order: Avatar / Cards / Table. */
export const KIND_TABS: readonly { kind: CosmeticKind; label: string }[] = [
  { kind: "avatar", label: "Avatar" },
  { kind: "card_back", label: "Cards" },
  { kind: "table_theme", label: "Table" },
];

export function itemsOfKind(
  items: readonly CosmeticItem[],
  kind: CosmeticKind,
): CosmeticItem[] {
  return items
    .filter((item) => item.kind === kind)
    .sort((a, b) => a.sort_order - b.sort_order || a.name.localeCompare(b.name));
}

export interface KindSummary {
  readonly owned: number;
  readonly total: number;
}

export function summarise(items: readonly CosmeticItem[], kind: CosmeticKind): KindSummary {
  const ofKind = items.filter((item) => item.kind === kind);
  return { owned: ofKind.filter((item) => item.owned).length, total: ofKind.length };
}

/**
 * What to show under a locked item.
 *
 * The server's wording, unchanged. Rewriting it here would be a second
 * description of the same rule, and the one on screen is the one that could then
 * be wrong.
 */
export function lockedLabel(item: CosmeticItem): string {
  return item.requirement ?? "Not yet available";
}

/**
 * Whether equipping is possible, said plainly.
 *
 * The server refuses an unowned item — the loadout trigger validates every slot
 * for any write path — so this is only about not offering a control that would
 * fail.
 */
export function canEquip(item: CosmeticItem): boolean {
  return item.owned && !item.equipped;
}
