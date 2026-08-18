/**
 * Inviting a friend to the table you are sitting at.
 *
 * The one notification a player can cause directly, which is why the server does
 * all four checks itself — you are at the table, they are a confirmed friend,
 * neither of you has blocked the other, and the same invite twice is one
 * notification. Nothing here decides any of that; it sends the room and the
 * friend and renders what comes back.
 *
 * A room code travels in the invite because that is the deep link. It is not
 * authorisation: opening `arc21://room/CODE` re-enters through
 * `join_private_room`, which checks capacity, expiry, status and blocks again.
 */

import { create } from "zustand";

import { getSupabase } from "../../lib/supabase/client.js";
import { isTimedOut, withTimeout } from "../../lib/supabase/with-timeout.js";

export interface RoomInvitesState {
  /** Friend ids already invited to the current room, so the button can settle. */
  readonly invited: readonly string[];
  readonly busy: string | null;
  readonly notice: string | null;

  invite: (roomId: string, friendId: string) => Promise<void>;
  /** Called when the room changes, so a new table starts with a clean slate. */
  reset: () => void;
}

export const useRoomInvites = create<RoomInvitesState>((set, get) => ({
  invited: [],
  busy: null,
  notice: null,

  invite: async (roomId, friendId) => {
    const availability = getSupabase();
    if (availability.status !== "ready") {
      set({ notice: availability.message });
      return;
    }

    set({ busy: friendId, notice: null });
    const result = await withTimeout(
      Promise.resolve(
        availability.client.rpc("invite_friend_to_room", {
          p_room_id: roomId,
          p_friend: friendId,
        }),
      ),
      undefined,
    );

    if (isTimedOut(result) || result.error) {
      set({ busy: null, notice: "Could not send that invite." });
      return;
    }

    set({
      busy: null,
      // Recorded locally so the row reads "Invited" rather than offering the
      // same invite again. The server collapses a repeat anyway; this is so the
      // screen does not imply otherwise.
      invited: [...get().invited, friendId],
      notice: null,
    });
  },

  reset: () => set({ invited: [], busy: null, notice: null }),
}));
