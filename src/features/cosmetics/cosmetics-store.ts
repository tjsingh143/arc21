import { playerScopedSetter } from "../player/player-scope.js";
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
import { bindCurrentPlayer, sentAs, confirmedSession } from "../../lib/supabase/player-binding.js";
import { isTimedOut, withTimeout } from "../../lib/supabase/with-timeout.js";
import { toItems, type CosmeticItem } from "./cosmetics.js";
import { useLoadoutStore } from "./loadout-store.js";

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
  "Connect to see cosmetics earned by your player. Practice stays available offline.";

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
    const setForPlayer = playerScopedSetter(set);
    const availability = getSupabase();
    if (availability.status !== "ready") {
      setForPlayer({ status: { kind: "unavailable", message: availability.message } });
      return;
    }

    const session = await bounded(confirmedSession(availability.client));
    if (session === null) {
      setForPlayer({ status: { kind: "unavailable", message: UNREACHABLE } });
      return;
    }
    if (!session.data.session) {
      setForPlayer({ status: { kind: "unavailable", message: SIGNED_OUT } });
      return;
    }

    // Idempotent. Everything it grants was earned by progression the server can
    // see; there is no argument through which a client could ask for an item.
    const granted = await bounded(availability.client.rpc("grant_earned_cosmetics"));
    const newlyGranted =
      granted && !granted.error && typeof granted.data === "number" ? granted.data : 0;

    const inventory = await bounded(availability.client.rpc("my_inventory"));
    if (inventory === null || inventory.error) {
      setForPlayer({ status: { kind: "unavailable", message: UNREACHABLE } });
      return;
    }

    setForPlayer({
      status: { kind: "ready", items: toItems(inventory.data) },
      newlyGranted,
      notice: null,
    });
  },

  /**
   * Bound to the player who chose the item (`player-binding.ts`). Ownership is
   * not identity: the default items belong to everybody, so an unbound request
   * held across a sign-in (Refresh-B audit, B-R3) equipped player A's choice on
   * player B's loadout and the server rightly accepted it — B owned it too.
   */
  equip: async (cosmeticId) => {
    const setForPlayer = playerScopedSetter(set);
    const availability = getSupabase();
    if (availability.status !== "ready" || get().busy) return;

    setForPlayer({ busy: true, notice: null });
    const bound = await bindCurrentPlayer(availability.client);
    if (!bound.ok || !bound.player.isCurrent()) {
      setForPlayer({
        busy: false,
        // A changed player has already had this screen cleared.
        notice: bound.ok || bound.reason === "identity-changed"
          ? null
          : bound.reason === "signed-out" ? SIGNED_OUT : UNREACHABLE,
      });
      return;
    }
    const result = await bounded(
      sentAs(availability.client.rpc("equip_cosmetic", { p_cosmetic_id: cosmeticId }), bound.player),
    );
    setForPlayer({ busy: false });
    // Everything below is this player's follow-up, including the reloads.
    if (!bound.player.isCurrent()) return;

    if (result === null) {
      setForPlayer({ notice: UNREACHABLE });
      return;
    }
    if (result.error) {
      // The server refuses an unowned or wrong-kind item at the loadout trigger.
      // Its refusal is the accurate one; this layer does not second-guess it.
      setForPlayer({ notice: "That could not be equipped." });
      return;
    }

    // Re-read rather than patching locally: what is equipped is the server's
    // answer, and one slot changing can unequip another. The loadout store is
    // refreshed too, so the avatar, card back and table across the app change
    // with the same tap that changed the inventory.
    await Promise.all([get().load(), useLoadoutStore.getState().load()]);
  },
}));
