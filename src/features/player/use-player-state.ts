import { useEffect } from "react";

import { useAuthStore } from "../auth/auth-store.js";
import { useAccountProfileStore } from "../auth/account-profile-store.js";
import { usePushRegistration } from "../notifications/use-push-registration.js";
import { useSettingsStore } from "../settings/use-settings.js";
import { resetPlayerState } from "./reset-player-state.js";

/** Install once at the app root, before session hydration. */
export function usePlayerState(): void {
  useEffect(() => useSettingsStore.subscribe((next, previous) => {
    if (next.ready && !previous.ready && useAuthStore.getState().session) {
      void usePushRegistration.getState().restore();
    }
  }), []);
  useEffect(() => useAuthStore.subscribe((next, previous) => {
    const userId = next.session?.account.userId ?? null;
    if (userId === (previous.session?.account.userId ?? null)) return;
    resetPlayerState();
    useAccountProfileStore.getState().clear();
    usePushRegistration.getState().forget();
    const settings = useSettingsStore.getState();
    if (userId && settings.ready && settings.settings.notificationsEnabled) {
      void usePushRegistration.getState().restore();
    }
  }), []);
}
