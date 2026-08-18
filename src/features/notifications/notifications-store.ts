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
  "Notifications need an account. Practice does not, and never sends you anything.";

async function bounded<T>(work: PromiseLike<T>): Promise<T | null> {
  const result = await withTimeout(Promise.resolve(work), undefined);
  return isTimedOut(result) ? null : result;
}

export const useNotificationsStore = create<NotificationsStoreState>((set, get) => ({
  status: { kind: "loading" },
  unread: 0,
  busy: false,

  load: async () => {
    const availability = getSupabase();
    if (availability.status !== "ready") {
      set({ status: { kind: "unavailable", message: availability.message }, unread: 0 });
      return;
    }

    const session = await bounded(availability.client.auth.getSession());
    if (session === null) {
      set({ status: { kind: "unavailable", message: UNREACHABLE }, unread: 0 });
      return;
    }
    if (!session.data.session) {
      set({ status: { kind: "unavailable", message: SIGNED_OUT }, unread: 0 });
      return;
    }

    const response = await bounded(availability.client.rpc("my_notifications", { p_limit: 50 }));
    if (response === null || response.error) {
      set({ status: { kind: "unavailable", message: UNREACHABLE }, unread: 0 });
      return;
    }

    const rows = toNotifications(response.data);
    set({ status: { kind: "ready", rows }, unread: unreadCount(rows) });
  },

  markRead: async (id) => {
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
      set({ status: { kind: "ready", rows }, unread: unreadCount(rows) });
    }

    await bounded(availability.client.rpc("mark_notifications_read", { p_ids: [id] }));
  },

  markAllRead: async () => {
    const availability = getSupabase();
    if (availability.status !== "ready") return;

    set({ busy: true });
    const response = await bounded(
      availability.client.rpc("mark_notifications_read", { p_ids: null }),
    );
    set({ busy: false });

    if (response === null || response.error) return;
    await get().load();
  },
}));
