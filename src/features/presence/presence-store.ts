/**
 * The presence channel, as client state.
 *
 * One channel for the whole app, joined once when a signed-in player opens
 * Social and left when they leave it. Joining per screen would publish and
 * withdraw a player several times a minute, which reads to their friends as
 * someone flickering in and out of existence.
 */

import { create } from "zustand";

import { getSupabase } from "../../lib/supabase/client.js";
import {
  PRESENCE_TOPIC,
  summarisePresence,
  type PresenceEntry,
  type PresenceState,
} from "./presence.js";

export interface PresenceStoreState {
  /** Who is online, by user id. Absent means "not on the channel", not "offline". */
  readonly online: ReadonlyMap<string, PresenceState>;
  readonly joined: boolean;

  join: (userId: string, state: PresenceEntry["state"]) => void;
  setOwnState: (state: PresenceEntry["state"]) => void;
  leave: () => void;
}

/**
 * The live channel handle.
 *
 * Held outside the store for the same reason the table's is: it is a side
 * effect with a lifetime, not a value to render, and putting it in state would
 * re-render every subscriber whenever the connection object changed.
 */
let channel: { track: (payload: unknown) => unknown; unsubscribe?: () => unknown } | null = null;
let teardown: (() => void) | null = null;
let ownUserId: string | null = null;

export const usePresenceStore = create<PresenceStoreState>((set) => ({
  online: new Map(),
  joined: false,

  join: (userId, state) => {
    if (channel !== null) return;

    const availability = getSupabase();
    // Without a server there is no presence — and no pretence of it. The screen
    // falls back to "Last seen …", which is honest about what it knows.
    if (availability.status !== "ready") return;

    ownUserId = userId;
    const client = availability.client;
    const live = client.channel(PRESENCE_TOPIC, { config: { presence: { key: userId } } });

    live
      .on("presence", { event: "sync" }, () => {
        set({ online: summarisePresence(live.presenceState()) });
      })
      .subscribe((status: string) => {
        if (status !== "SUBSCRIBED") return;
        void live.track({ userId, state });
        set({ joined: true });
      });

    channel = live as unknown as typeof channel;
    teardown = () => {
      void client.removeChannel(live);
    };
  },

  /** Called when the player sits at a table, so friends see "In a game". */
  setOwnState: (state) => {
    if (channel === null || ownUserId === null) return;
    void channel.track({ userId: ownUserId, state });
  },

  leave: () => {
    teardown?.();
    channel = null;
    teardown = null;
    ownUserId = null;
    set({ online: new Map(), joined: false });
  },
}));
