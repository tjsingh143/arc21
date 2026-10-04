/**
 * Keeps `profiles.privacy` equal to the player's stored visibility choice.
 *
 * Mounted once at the root, beside the session hydration, because the case that
 * matters most cannot be caught by the Settings screen. The local default is
 * `private` and the column default is `public`, so a player who NEVER OPENS
 * SETTINGS has a preference of "private" and a profile row that is public. The
 * screen can only reconcile someone who visits it; this reconciles everybody,
 * the moment a session exists.
 *
 * It is also the ONLY caller of the sync. The Settings screen used to call
 * `syncProfilePrivacy` itself, after awaiting its local save — so the write was
 * bound to whichever player was current when the save finished, and ordered by
 * when the save finished. The final Refresh-B audit (B-F3) held A's save across
 * a sign-in to B and B's own "private", and A's late sync wrote "public" onto
 * B. The in-memory choice changes synchronously when the control is pressed,
 * so this effect sees each choice in the order it was made, under the player
 * current when it runs; `profile-privacy.ts` binds the write to that player
 * before anything is awaited and lets the server refuse a stale one.
 *
 * It lives here rather than in `auth-store.ts` for a mechanical reason worth
 * recording: `use-settings.ts` reaches the audio and haptics adapters, which
 * import React Native, and `tests/auth/auth-store.test.ts` runs under plain
 * Node. Importing the settings store into the auth store turned that suite into
 * `Flow is not supported` at `react-native/index.js` — the same wall CLAUDE.md
 * describes between `src/design` and the test suite. A hook on the React side
 * has no such problem.
 */

import { useEffect } from "react";

import { useAuthStore } from "../auth/auth-store.js";
import { syncProfilePrivacy, type PrivacySyncOutcome } from "./profile-privacy.js";
import type { StatsVisibility } from "./settings.js";
import { useSettingsStore } from "./use-settings.js";

/**
 * The effect's body, as a function the tests drive with the same inputs.
 *
 * Nothing to reconcile without both halves: an account to write to, and a
 * preference that has actually been read off disk. Syncing before the load
 * completes would push the DEFAULT over the player's stored choice.
 */
export function reconcileProfilePrivacy(
  userId: string | null,
  ready: boolean,
  statsVisibility: StatsVisibility,
): Promise<PrivacySyncOutcome> | null {
  if (userId === null || !ready) return null;
  return syncProfilePrivacy(statsVisibility);
}

export function useProfilePrivacySync(): void {
  const userId = useAuthStore((state) => state.session?.account.userId ?? null);
  const ready = useSettingsStore((state) => state.ready);
  const statsVisibility = useSettingsStore((state) => state.settings.statsVisibility);

  useEffect(() => {
    void reconcileProfilePrivacy(userId, ready, statsVisibility);
  }, [userId, ready, statsVisibility]);
}
