/**
 * The signed-in player's own profile row: display name and handle.
 *
 * The Profile screen rendered `session.account.email` as the display name. Two
 * things wrong with that, and the second is the worse one:
 *
 *   * it is not the display name. `public.profiles` carries `display_name` and
 *     `username`, both server-normalised, both put through the reserved-name
 *     and profanity filter, and the specification's profile hierarchy is
 *     "Avatar / Display name / @username";
 *   * it puts an EMAIL ADDRESS at the top of a screen, in the largest type on
 *     it. A screenshot of your own profile should not disclose your email.
 *
 * Scoped to `id = <you>` deliberately. `public.profiles` is a directory —
 * `profiles_select_visible` shows any authenticated caller a profile that is
 * `public`, not blocked either way — so an unfiltered read returns strangers,
 * and `rows[0]` is one of them. Verified: the policy honours `privacy`, refuses
 * `private`, and requires friendship for `friends`.
 */

import { create } from "zustand";

import { getSupabase } from "../../lib/supabase/client.js";
import { isTimedOut, withTimeout } from "../../lib/supabase/with-timeout.js";

export interface AccountProfile {
  readonly userId: string;
  readonly username: string;
  readonly displayName: string;
}

export interface AccountProfileState {
  /** Null for a guest, and null when the row could not be read. */
  readonly profile: AccountProfile | null;
  readonly loaded: boolean;
  load: () => Promise<void>;
  clear: () => void;
}

function toProfile(value: unknown): AccountProfile | null {
  const row = Array.isArray(value) ? value[0] : value;
  if (typeof row !== "object" || row === null) return null;
  const candidate = row as Record<string, unknown>;
  if (
    typeof candidate.id !== "string" ||
    typeof candidate.username !== "string" ||
    typeof candidate.display_name !== "string"
  ) {
    return null;
  }
  return {
    userId: candidate.id,
    username: candidate.username,
    displayName: candidate.display_name,
  };
}

export const useAccountProfileStore = create<AccountProfileState>((set) => ({
  profile: null,
  loaded: false,

  load: async () => {
    const availability = getSupabase();
    if (availability.status !== "ready") {
      set({ profile: null, loaded: true });
      return;
    }

    const session = await withTimeout(
      Promise.resolve(availability.client.auth.getSession()),
      undefined,
    );
    if (isTimedOut(session) || !session.data.session) {
      set({ profile: null, loaded: true });
      return;
    }

    const result = await withTimeout(
      Promise.resolve(
        availability.client
          .from("profiles")
          .select("id, username, display_name")
          .eq("id", session.data.session.user.id)
          .maybeSingle(),
      ),
      undefined,
    );
    if (isTimedOut(result) || result.error) {
      set({ loaded: true });
      return;
    }

    set({ profile: toProfile(result.data), loaded: true });
  },

  clear: () => set({ profile: null, loaded: false }),
}));
