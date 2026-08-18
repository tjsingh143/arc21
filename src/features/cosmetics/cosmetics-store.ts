/**
 * The cosmetic inventory, as client state.
 *
 * Loading asks the server to grant anything newly earned first. That is on
 * purpose: unlocks are also granted at the moments progression happens — a
 * tournament placement, a completed challenge — but a level reached through
 * ordinary play has no such moment, and a player should not have to guess which
 * screen to visit. The grant is idempotent, so calling it on every open costs a
 * statement and grants nothing twice.
 */

import { create } from "zustand";

import { getSupabase } from "../../lib/supabase/client.js";
import { isTimedOut, withTimeout } from "../../lib/supabase/with-timeout.js";
import { toItems, type CosmeticItem } from "./cosmetics.js";

export type InventoryStatus =
  | { readonly kind: "loading" }
  | { readonly kind: "ready"; readonly items: readonly CosmeticItem[] }
  | { readonly kind: "unavailable"; readonly message: string };

export interface CosmeticsStoreState {
  readonly status: InventoryStatus;
  readonly notice: string | null;
  readonly busy: boolean;
  /** Set when this visit granted something, so the screen can say what arrived. */
  readonly newlyGranted: number;

  load: () => Promise<void>;
  equip: (cosmeticId: string) => Promise<void>;
}

const UNREACHABLE = "Could not reach your inventory.";
const SIGNED_OUT =
  "Cosmetics need an account, because what you have earned is recorded on the server. Practice stays available without one.";

async function bounded<T>(work: PromiseLike<T>): Promise<T | null> {
  const result = await withTimeout(Promise.resolve(work), undefined);
  return isTimedOut(result) ? null : result;
}

export const useCosmeticsStore = create<CosmeticsStoreState>((set, get) => ({
  status: { kind: "loading" },
  notice: null,
  busy: false,
  newlyGranted: 0,

  load: async () => {
    const availability = getSupabase();
    if (availability.status !== "ready") {
      set({ status: { kind: "unavailable", message: availability.message } });
      return;
    }

    const session = await bounded(availability.client.auth.getSession());
    if (session === null) {
      set({ status: { kind: "unavailable", message: UNREACHABLE } });
      return;
    }
    if (!session.data.session) {
      set({ status: { kind: "unavailable", message: SIGNED_OUT } });
      return;
    }

    // Idempotent. Everything it grants was earned by progression the server can
    // see; there is no argument through which a client could ask for an item.
    const granted = await bounded(availability.client.rpc("grant_earned_cosmetics"));
    const newlyGranted =
      granted && !granted.error && typeof granted.data === "number" ? granted.data : 0;

    const inventory = await bounded(availability.client.rpc("my_inventory"));
    if (inventory === null || inventory.error) {
      set({ status: { kind: "unavailable", message: UNREACHABLE } });
      return;
    }

    set({
      status: { kind: "ready", items: toItems(inventory.data) },
      newlyGranted,
      notice: null,
    });
  },

  equip: async (cosmeticId) => {
    const availability = getSupabase();
    if (availability.status !== "ready" || get().busy) return;

    set({ busy: true, notice: null });
    const result = await bounded(
      availability.client.rpc("equip_cosmetic", { p_cosmetic_id: cosmeticId }),
    );
    set({ busy: false });

    if (result === null) {
      set({ notice: UNREACHABLE });
      return;
    }
    if (result.error) {
      // The server refuses an unowned or wrong-kind item at the loadout trigger.
      // Its refusal is the accurate one; this layer does not second-guess it.
      set({ notice: "That could not be equipped." });
      return;
    }

    // Re-read rather than patching locally: what is equipped is the server's
    // answer, and one slot changing can unequip another.
    await get().load();
  },
}));
