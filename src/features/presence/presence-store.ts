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

/**
 * The durable half of presence, and the one that was missing.
 *
 * `profiles.last_seen_at` is written by `handle_new_user` at signup and, until
 * `touch_last_seen()` existed, by nothing else — while `list_friends()` returns
 * it, `player_public_profile()` returns it, and `describeLastSeen` renders it as
 * "Last seen 3 hours ago" beneath every friend who is not on the presence
 * channel. The specification asks for exactly this column as the fallback under
 * ephemeral presence; what shipped was the account's creation date wearing its
 * clothes.
 *
 * Stamped at the two moments a player publishes presence, so the sentence "last
 * seen" means "last on the presence channel" rather than an unstated moment in
 * the past. Fire-and-forget in both directions: a failed stamp must never stop
 * somebody joining the channel, and there is nothing on screen that depends on
 * the answer.
 *
 * The write is the SERVER's. `authenticated` holds no UPDATE grant on that
 * column — `assert_client_authorization_surface()` would fail a migration that
 * added one — so this cannot become a client that dates its own presence.
 */
function stampLastSeen(): void {
  const availability = getSupabase();
  if (availability.status !== "ready") return;
  void availability.client.rpc("touch_last_seen").then(
    () => undefined,
    () => undefined,
  );
}

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
    stampLastSeen();
    const client = availability.client;
    // Private, so the roster needs an account. It is a shared topic by design
    // — everybody publishes and the client renders only its own friends — but
    // before this an anon key could read the whole thing.
    const live = client.channel(PRESENCE_TOPIC, {
      config: { presence: { key: userId }, private: true },
    });

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
    // Stamped whether or not this client holds a channel. Sitting down at a
    // table is a player being present, and the durable fallback should say so
    // even for somebody who never opened Social this session — which, since the
    // channel is joined there and only there, is most of them.
    stampLastSeen();
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
