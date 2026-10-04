import { playerScopedSetter } from "../player/player-scope.js";
/**
 * The notification inbox, as client state.
 *
 * The inbox is not a fallback for push — it is the record. Push is a way of
 * being told sooner, and it can fail for reasons the app never sees: permission
 * refused, a token expired, a build with no credentials. Everything that
 * happened is here regardless, which is also what makes the feature testable
 * without a push service at all.
 */

import { create } from "zustand";

import { getSupabase } from "../../lib/supabase/client.js";
import { bindCurrentPlayer, sentAs, confirmedSession } from "../../lib/supabase/player-binding.js";
import { isTimedOut, withTimeout } from "../../lib/supabase/with-timeout.js";
import { toNotifications, unreadCount, type AppNotification } from "./notifications.js";

export type InboxStatus =
  | { readonly kind: "loading" }
  | { readonly kind: "ready"; readonly rows: readonly AppNotification[] }
  | { readonly kind: "unavailable"; readonly message: string };

export interface NotificationsStoreState {
  readonly status: InboxStatus;
  readonly unread: number;
  readonly busy: boolean;

  load: () => Promise<void>;
  markRead: (id: string) => Promise<void>;
  markAllRead: () => Promise<void>;
}

const UNREACHABLE = "Could not reach your notifications.";
const SIGNED_OUT =
  "Connect to see your player notifications. Practice works offline.";

async function bounded<T>(work: PromiseLike<T>): Promise<T | null> {
  const result = await withTimeout(Promise.resolve(work), undefined);
  return isTimedOut(result) ? null : result;
}

export const useNotificationsStore = create<NotificationsStoreState>((set, get) => ({
  status: { kind: "loading" },
  unread: 0,
  busy: false,

  load: async () => {
    const setForPlayer = playerScopedSetter(set);
    const availability = getSupabase();
    if (availability.status !== "ready") {
      setForPlayer({ status: { kind: "unavailable", message: availability.message }, unread: 0 });
      return;
    }

    const session = await bounded(confirmedSession(availability.client));
    if (session === null) {
      setForPlayer({ status: { kind: "unavailable", message: UNREACHABLE }, unread: 0 });
      return;
    }
    if (!session.data.session) {
      setForPlayer({ status: { kind: "unavailable", message: SIGNED_OUT }, unread: 0 });
      return;
    }

    const response = await bounded(availability.client.rpc("my_notifications", { p_limit: 50 }));
    if (response === null || response.error) {
      setForPlayer({ status: { kind: "unavailable", message: UNREACHABLE }, unread: 0 });
      return;
    }

    const rows = toNotifications(response.data);
    setForPlayer({ status: { kind: "ready", rows }, unread: unreadCount(rows) });
  },

  markRead: async (id) => {
    const setForPlayer = playerScopedSetter(set);
    const availability = getSupabase();
    if (availability.status !== "ready") return;

    // Optimistic, and safe to be: the only thing a client may change on a
    // notification is `read_at`, and marking something read that was already
    // read is not an error anywhere in the stack.
    const current = get().status;
    if (current.kind === "ready") {
      const rows = current.rows.map((row) =>
        row.id === id && row.read_at === null
          ? { ...row, read_at: new Date().toISOString() }
          : row,
      );
      setForPlayer({ status: { kind: "ready", rows }, unread: unreadCount(rows) });
    }

    // Sent only as the adopted player: never as a restored credential the
    // server has not confirmed (B-H1).
    const session = await bounded(confirmedSession(availability.client));
    if (session === null || !session.data.session) return;
    await bounded(availability.client.rpc("mark_notifications_read", { p_ids: [id] })
      .setHeader("Authorization", `Bearer ${session.data.session.access_token}`));
  },

  /**
   * `p_ids: null` means EVERY unread notification of whoever the request is
   * sent as — the server scopes it to `auth.uid()` and nothing else — so it is
   * bound to the player who tapped it (`player-binding.ts`). Unbound, the
   * Refresh-B audit (B-R2) held player A's tap across a sign-in to B and B's
   * inbox was marked read while A's stayed unread. `markRead` needs no binding:
   * its explicit id belongs to one player, and a request sent as anybody else
   * matches no row.
   */
  markAllRead: async () => {
    const setForPlayer = playerScopedSetter(set);
    const availability = getSupabase();
    if (availability.status !== "ready") return;

    setForPlayer({ busy: true });
    const bound = await bindCurrentPlayer(availability.client);
    if (!bound.ok || !bound.player.isCurrent()) {
      setForPlayer({ busy: false });
      return;
    }
    const response = await bounded(
      sentAs(availability.client.rpc("mark_notifications_read", { p_ids: null }), bound.player),
    );
    setForPlayer({ busy: false });

    // The reload belongs to the same player; a replacement's inbox is theirs
    // to load when their own screen asks.
    if (response === null || response.error || !bound.player.isCurrent()) return;
    await get().load();
  },
}));
