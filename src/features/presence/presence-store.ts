/** Friend presence comes from a scoped server projection, never track metadata. */
import { create } from "zustand";
import { mayActAs, someoneIsAdopted } from "../../lib/supabase/adopted-player.js";
import { getSupabase } from "../../lib/supabase/client.js";
import { isTimedOut, withTimeout } from "../../lib/supabase/with-timeout.js";
import { presenceFromRows, type PresenceEntry, type PresenceState } from "./presence.js";

export interface PresenceStoreState {
  readonly online: ReadonlyMap<string, PresenceState>;
  readonly joined: boolean;
  join: (userId: string, state: PresenceEntry["state"]) => void;
  setOwnState: (state: PresenceEntry["state"]) => void;
  leave: () => void;
}

export const PRESENCE_POLL_MS = 30_000;
let timer: ReturnType<typeof setInterval> | null = null;
let generation = 0;
let ownUserId: string | null = null;

function stampLastSeen(): void {
  const availability = getSupabase();
  if (availability.status !== "ready") return;
  // A heartbeat is a write as whoever the SDK holds, so it waits for an
  // adopted player: a restored credential awaiting the server's word is not
  // one (B-H1).
  if (!someoneIsAdopted(availability.client)) return;
  // The RPC derives auth.uid() and its timestamp on the server.
  void availability.client.rpc("touch_last_seen").then(() => undefined, () => undefined);
}

export const usePresenceStore = create<PresenceStoreState>((set, get) => ({
  online: new Map(),
  joined: false,

  join: (userId, _state) => {
    if (ownUserId === userId && timer !== null) return;
    get().leave();
    const availability = getSupabase();
    if (availability.status !== "ready") return;
    if (!mayActAs(availability.client, userId)) return;
    ownUserId = userId;
    const captured = generation;
    let pending = false;
    const refresh = async () => {
      if (pending || captured !== generation) return;
      pending = true;
      stampLastSeen();
      try {
        const result = await withTimeout(Promise.resolve(availability.client.rpc("list_friend_presence")));
        if (captured !== generation) return;
        if (isTimedOut(result) || result.error) {
          // A failed heartbeat must not leave an unbounded "recently active" claim.
          set({ online: new Map(), joined: false });
          return;
        }
        set({ online: presenceFromRows(result.data), joined: true });
      } catch {
        if (captured === generation) set({ online: new Map(), joined: false });
      } finally {
        pending = false;
      }
    };
    void refresh();
    timer = setInterval(() => void refresh(), PRESENCE_POLL_MS);
  },

  // Sitting at a table is a heartbeat; the server decides the in-game state.
  setOwnState: (_state) => stampLastSeen(),

  leave: () => {
    generation += 1;
    if (timer !== null) clearInterval(timer);
    timer = null;
    ownUserId = null;
    set({ online: new Map(), joined: false });
  },
}));
