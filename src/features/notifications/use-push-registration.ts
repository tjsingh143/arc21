/**
 * Keeping the server's idea of this device in step with the Settings screen.
 *
 * The rule this enforces: **a toggle a player moves must change what the server
 * does.** Per-kind preferences are sent with the registration and the sender
 * pushes only the kinds a device asked for, so "Your turn" being off is a fact
 * about the queue rather than a decoration in a settings screen.
 *
 * Permission is requested from the MOMENTS listed in
 * `PermissionMoment` — accepting a friend request, entering a tournament,
 * opening a private table, or moving the switch — and never from onboarding.
 * That is a specification rule, and it is also the difference between a prompt
 * that gets a yes and one that gets a permanent no.
 */

import { create } from "zustand";

import {
  ensurePermission,
  permissionStatus,
  registerDevice,
  retireDevice,
  type RegistrationOutcome,
} from "../../lib/notifications/push.js";
import {
  preferencesAfterGrant,
  type NotificationPreferences,
  type PermissionMoment,
} from "./notifications.js";

export interface PushRegistrationState {
  /**
   * Why push is not active, in words a screen can show. Null when it is active,
   * or when nothing has been attempted yet.
   */
  readonly unavailable: string | null;
  readonly registered: boolean;
  readonly busy: boolean;

  /**
   * Ask for permission, then register. Returns whether push ended up active, so
   * a caller can leave the toggle where it was if the OS said no.
   */
  enable: (moment: PermissionMoment, preferences: NotificationPreferences) => Promise<boolean>;
  /** Push off for this device. */
  disable: () => Promise<void>;
  /** Re-send the kind allowlist after a per-kind toggle moved. */
  sync: (preferences: NotificationPreferences) => Promise<void>;
  /**
   * The moment-based offer.
   *
   * Returns the preferences to persist when the player granted permission, and
   * null when nothing should change. It asks in exactly one case — notifications
   * are off in the app AND the OS has never been asked — so it can neither nag
   * somebody who declined nor quietly switch back on something a player turned
   * off in Settings.
   */
  offer: (
    moment: PermissionMoment,
    preferences: NotificationPreferences,
  ) => Promise<NotificationPreferences | null>;
}

const DENIED =
  "Your device is set to refuse notifications from Arc 21. That is changed in the system settings, not here.";

function describe(outcome: RegistrationOutcome): string | null {
  switch (outcome.kind) {
    case "registered":
      return null;
    case "no-permission":
      return DENIED;
    case "signed-out":
      return "Notifications need an account. Practice never sends you anything.";
    case "unavailable":
      return outcome.reason;
  }
}

export const usePushRegistration = create<PushRegistrationState>((set, get) => ({
  unavailable: null,
  registered: false,
  busy: false,

  enable: async (_moment, preferences) => {
    set({ busy: true });
    const permission = await ensurePermission();

    if (permission.kind !== "granted") {
      set({
        busy: false,
        registered: false,
        unavailable: permission.kind === "denied" ? DENIED : permission.reason,
      });
      return false;
    }

    const outcome = await registerDevice(preferences);
    const unavailable = describe(outcome);
    set({ busy: false, registered: unavailable === null, unavailable });
    return unavailable === null;
  },

  disable: async () => {
    set({ busy: true });
    await retireDevice();
    set({ busy: false, registered: false, unavailable: null });
  },

  offer: async (moment, preferences) => {
    if (preferences.notificationsEnabled) {
      // Already on: keep the server's allowlist in step and ask nothing.
      await get().sync(preferences);
      return null;
    }
    if ((await permissionStatus()) !== "undetermined") return null;

    const wanted = preferencesAfterGrant(moment, preferences);
    const granted = await get().enable(moment, wanted);
    return granted ? wanted : null;
  },

  sync: async (preferences) => {
    // Only meaningful once this device is registered; otherwise there is nothing
    // on the server to bring in step, and asking would prompt for permission at
    // a moment the player did not choose.
    if (!get().registered) return;
    const outcome = await registerDevice(preferences);
    set({ unavailable: describe(outcome) });
  },
}));
