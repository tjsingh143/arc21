/**
 * Keeps the access token fresh while the app is in the foreground.
 *
 * Supabase's `autoRefreshToken` uses a timer, and on mobile a backgrounded app's
 * timers are suspended by the OS. Without this, a session that was valid when
 * the player switched away can be expired when they switch back — and the first
 * thing they would see is a command rejected as unauthenticated, at the table,
 * mid-hand.
 *
 * The refresh loop is deliberately stopped in the background rather than left
 * running: a timer firing while suspended produces failed refreshes that count
 * against the auth rate limit and can, in the worst case, rotate a refresh token
 * whose replacement never gets persisted.
 *
 * This is the only file in `src/lib/supabase` that imports React Native, which
 * is why it is separate. Nothing in `tests/` imports it; the modules that do are
 * screens.
 */

import { AppState, type AppStateStatus } from "react-native";

import { getSupabase } from "./client.js";

let subscription: { remove: () => void } | null = null;

/**
 * Starts the foreground refresh loop. Safe to call more than once — a second
 * call is a no-op rather than a second subscription.
 */
export function startSupabaseAutoRefresh(): void {
  if (subscription !== null) return;

  const availability = getSupabase();
  if (availability.status !== "ready") return;

  const { client } = availability;

  const apply = (state: AppStateStatus): void => {
    if (state === "active") {
      void client.auth.startAutoRefresh();
    } else {
      void client.auth.stopAutoRefresh();
    }
  };

  apply(AppState.currentState);
  subscription = AppState.addEventListener("change", apply);
}

export function stopSupabaseAutoRefresh(): void {
  subscription?.remove();
  subscription = null;
}
