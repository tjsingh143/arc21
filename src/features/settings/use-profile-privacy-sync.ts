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
import { syncProfilePrivacy } from "./profile-privacy.js";
import { useSettingsStore } from "./use-settings.js";

export function useProfilePrivacySync(): void {
  const userId = useAuthStore((state) => state.session?.account.userId ?? null);
  const ready = useSettingsStore((state) => state.ready);
  const statsVisibility = useSettingsStore((state) => state.settings.statsVisibility);

  useEffect(() => {
    // Nothing to reconcile without both halves: an account to write to, and a
    // preference that has actually been read off disk. Syncing before the load
    // completes would push the DEFAULT over the player's stored choice.
    if (userId === null || !ready) return;
    void syncProfilePrivacy(statsVisibility);
  }, [userId, ready, statsVisibility]);
}
