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
 *
 * Bringing the server in step (`sync`, `restore`) never carries a copy of the
 * preferences: the registration reads the device's Settings at its write, so
 * the newest choice is what the server keeps however the requests interleave
 * (`registerDevice`, B-G2), and the server keeps only the newest write
 * (`push.ts`, B-H4).
 *
 * Nothing carries a Settings SNAPSHOT across an await, either (B-H2). `enable`
 * names only the notification keys it switches on — a patch, applied to the
 * record as it stands at the write — and `offer` records its patch itself, into
 * the record as it stands, at the same step as its last check that no newer
 * notification choice has been made. An offer overtaken by a newer choice
 * registers nothing and records nothing; nor can it touch anything but
 * notification keys, privacy included.
 */

import { create } from "zustand";
import { playerScopedSetter } from "../player/player-scope.js";
import { captureNotificationIntent, useSettingsStore } from "../settings/use-settings.js";

import {
  ensurePermission,
  permissionStatus,
  registerDevice,
  retireDevice,
  cancelPendingPushRegistration,
  type RegistrationOutcome,
} from "../../lib/notifications/push.js";
import {
  grantPatch,
  notificationPatchOf,
  type NotificationPatch,
  type NotificationPreferences,
  type PermissionMoment,
} from "./notifications.js";

/**
 * The device's preferences as they stand: the Settings record, in memory the
 * moment a switch moves and saved behind it in order (`use-settings.ts`).
 */
const devicePreferences = (): NotificationPreferences => useSettingsStore.getState().settings;

export interface PushRegistrationState {
  /**
   * Why push is not active, in words a screen can show. Null when it is active,
   * or when nothing has been attempted yet.
   */
  readonly unavailable: string | null;
  readonly registered: boolean;
  readonly busy: boolean;

  /**
   * Ask for permission, then register this device for its Settings with
   * `patch` applied — read at the write, not when called. Returns whether push
   * ended up active, so a caller can leave the toggle where it was if the OS
   * said no; recording the choice is the caller's. Writes nothing once a newer
   * notification choice has been made.
   */
  enable: (moment: PermissionMoment, patch: NotificationPatch) => Promise<boolean>;
  /** Push off for this device. */
  disable: () => Promise<void>;
  /** Re-send the kind allowlist after a per-kind toggle moved: Settings as they stand at the write. */
  sync: () => Promise<void>;
  /** Re-associate an already permitted device after restoring/changing identity, from Settings. */
  restore: () => Promise<void>;
  /** Clear only the local association; never ask the OS for permission. */
  forget: () => void;
  /**
   * The moment-based offer.
   *
   * It asks in exactly one case — notifications are off in the app AND the OS
   * has never been asked — so it can neither nag somebody who declined nor
   * quietly switch back on something a player turned off in Settings. When the
   * player grants it, it records the moment's own patch into Settings as they
   * stand and returns true; otherwise nothing changes and it returns false.
   * Any notification choice made after it began makes it obsolete (B-H2).
   */
  offer: (moment: PermissionMoment) => Promise<boolean>;
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
      return "Connect your player identity to enable notifications. Practice works offline.";
    case "superseded":
      return null;
    case "unavailable":
      return outcome.reason;
  }
}

export const usePushRegistration = create<PushRegistrationState>((set, get) => {
  /**
   * Permission, then the registration — for the device's Settings as they
   * stand at the write, with `patch` applied — while `intentIsCurrent`.
   */
  async function enableFor(patch: NotificationPatch, intentIsCurrent: () => boolean): Promise<boolean> {
    const setForPlayer = playerScopedSetter(set);
    setForPlayer({ busy: true });
    const permission = await ensurePermission();

    if (permission.kind !== "granted") {
      setForPlayer({
        busy: false,
        registered: false,
        unavailable: permission.kind === "denied" ? DENIED : permission.reason,
      });
      return false;
    }

    if (!setForPlayer.isCurrent() || !intentIsCurrent()) {
      setForPlayer({ busy: false });
      return false;
    }
    const narrow = notificationPatchOf(patch);
    const outcome = await registerDevice(() => ({ ...devicePreferences(), ...narrow }), { intentIsCurrent });
    if (outcome.kind === "superseded") {
      setForPlayer({ busy: false });
      return false;
    }
    const unavailable = describe(outcome);
    setForPlayer({ busy: false, registered: unavailable === null, unavailable });
    if (!setForPlayer.isCurrent() || unavailable !== null) return false;
    if (!intentIsCurrent()) {
      // Written, and then a newer choice arrived before this could be recorded.
      // Settings already hold that choice, and the server must end with it too:
      // re-sent as it stands, or — notifications now off — retired. Both carry
      // a newer revision than this write, so they are what the row keeps.
      if (devicePreferences().notificationsEnabled) await get().sync();
      else await get().disable();
      return false;
    }
    return true;
  }

  return {
  unavailable: null,
  registered: false,
  busy: false,

  enable: (_moment, patch) => enableFor(patch, captureNotificationIntent()),

  disable: async () => {
    const setForPlayer = playerScopedSetter(set);
    setForPlayer({ busy: true });
    await retireDevice();
    setForPlayer({ busy: false, registered: false, unavailable: null });
  },

  offer: async (moment) => {
    // Captured before anything is awaited: every await below is a chance for
    // the player to choose something newer (B-H2).
    const intentIsCurrent = captureNotificationIntent();
    const { ready, settings } = useSettingsStore.getState();
    // Nothing read off disk yet: an offer measured against the defaults would
    // be recorded over the player's stored choices.
    if (!ready) return false;
    if (settings.notificationsEnabled) {
      // Already on: keep the server's allowlist in step and ask nothing.
      await get().sync();
      return false;
    }
    if ((await permissionStatus()) !== "undetermined" || !intentIsCurrent()) return false;

    const patch = grantPatch(moment);
    if (!(await enableFor(patch, intentIsCurrent))) return false;
    // Recorded into the record AS IT STANDS — notification keys only — in the
    // same synchronous step as the check: nothing newer can come between them.
    if (!intentIsCurrent()) return false;
    await useSettingsStore.getState().update(patch);
    return true;
  },

  sync: async () => {
    const setForPlayer = playerScopedSetter(set);
    // Only meaningful once this device is registered; otherwise there is nothing
    // on the server to bring in step, and asking would prompt for permission at
    // a moment the player did not choose.
    if (!get().registered) return;
    const outcome = await registerDevice(devicePreferences);
    setForPlayer({ unavailable: describe(outcome) });
  },

  restore: async () => {
    const setForPlayer = playerScopedSetter(set);
    if (!devicePreferences().notificationsEnabled || (await permissionStatus()) !== "granted") return;
    if (!setForPlayer.isCurrent()) return;
    const outcome = await registerDevice(devicePreferences);
    const unavailable = describe(outcome);
    setForPlayer({ unavailable, registered: unavailable === null });
  },

  forget: () => { cancelPendingPushRegistration(); set({ unavailable: null, registered: false, busy: false }); },
  };
});

/** Run while the departing user's session still exists, before sign-out/switch. */
export async function preparePlayerDeparture(): Promise<void> {
  await retireDevice();
  usePushRegistration.getState().forget();
}
