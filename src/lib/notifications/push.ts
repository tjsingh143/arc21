/**
 * Arc 21 — push registration and permission.
 *
 * The device half of notifications. Everything here is best-effort and fails
 * quietly: a game must not break because a token could not be fetched, and a
 * player who says no must be able to keep playing without being asked again on
 * the next screen.
 *
 * WHEN PERMISSION IS ASKED FOR
 *
 * Only after the player has done something notifications are about — accepting a
 * friend request, entering a tournament, opening a private table, or turning the
 * switch on themselves. Never during onboarding. That is a specification rule
 * and it is also the difference between a prompt that gets a yes and one that
 * gets a permanent no.
 *
 * WITHOUT EAS CREDENTIALS
 *
 * `getExpoPushTokenAsync` needs a configured EAS project, and this repository
 * has none. The call therefore fails on a development build, and it is REPORTED
 * as unavailable rather than swallowed — `docs/AUDIT.md` grades push delivery on
 * exactly that basis. Everything either side of it is real: the permission flow,
 * the token schema, the per-kind allowlist, the server sender and the deep-link
 * routing all run and are tested.
 */

import * as Notifications from "expo-notifications";
import { Platform } from "react-native";
import Constants from "expo-constants";

import { getSupabase } from "../supabase/client.js";
import {
  ANDROID_CHANNEL_DEFAULT,
  ANDROID_CHANNEL_TURN,
} from "./channels.js";
import {
  allowedKinds,
  type NotificationPreferences,
} from "../../features/notifications/notifications.js";

export type PermissionStatus = "undetermined" | "granted" | "denied";

/**
 * What the OS currently thinks, WITHOUT prompting.
 *
 * The difference between "never asked" and "said no" is the whole reason this
 * exists: a moment-based prompt may only fire on the first, and re-asking
 * someone who declined is how an app earns a permanent refusal.
 */
export async function permissionStatus(): Promise<PermissionStatus> {
  try {
    const existing = await Notifications.getPermissionsAsync();
    if (existing.granted) return "granted";
    return existing.canAskAgain ? "undetermined" : "denied";
  } catch {
    return "denied";
  }
}

export type PermissionOutcome =
  /** The OS says yes. A token may be requested. */
  | { readonly kind: "granted" }
  /** The player said no, now or previously. Never ask again in-session. */
  | { readonly kind: "denied" }
  /** No push on this platform or build. Stated, not hidden. */
  | { readonly kind: "unavailable"; readonly reason: string };

/**
 * Foreground behaviour.
 *
 * A banner while the app is open is worth showing — the player may be on the
 * Learn tab when a table invite arrives — but never a sound on top of the game's
 * own audio, and never a badge fought over with the in-app unread count.
 */
export function configureNotificationHandler(): void {
  Notifications.setNotificationHandler({
    handleNotification: async () => ({
      shouldShowBanner: true,
      shouldShowList: true,
      shouldPlaySound: false,
      shouldSetBadge: false,
    }),
  });
}

/**
 * Android channels, created once.
 *
 * The channel decides importance and sound at the OS level, and a player can
 * change either without turning Arc 21 off entirely — which is the outcome a
 * single all-or-nothing channel produces.
 */
export async function ensureAndroidChannels(): Promise<void> {
  if (Platform.OS !== "android") return;
  try {
    await Notifications.setNotificationChannelAsync(ANDROID_CHANNEL_TURN, {
      name: "Your turn",
      importance: Notifications.AndroidImportance.HIGH,
      vibrationPattern: [0, 120],
      enableVibrate: true,
    });
    await Notifications.setNotificationChannelAsync(ANDROID_CHANNEL_DEFAULT, {
      name: "Friends and tournaments",
      importance: Notifications.AndroidImportance.DEFAULT,
      enableVibrate: false,
    });
  } catch {
    // An older Android or a restricted build. Notifications still arrive on the
    // default channel; nothing here is load-bearing.
  }
}

/**
 * Asks for permission, at a moment the caller has justified.
 *
 * Never prompts twice: if the OS has already answered, that answer is returned
 * without a second dialog. A player who declined is not nagged, and the Settings
 * screen explains how to change it in the OS.
 */
export async function ensurePermission(): Promise<PermissionOutcome> {
  try {
    const existing = await Notifications.getPermissionsAsync();
    if (existing.granted) return { kind: "granted" };
    if (!existing.canAskAgain) return { kind: "denied" };

    const requested = await Notifications.requestPermissionsAsync();
    return requested.granted ? { kind: "granted" } : { kind: "denied" };
  } catch (error) {
    return { kind: "unavailable", reason: describe(error) };
  }
}

export type RegistrationOutcome =
  | { readonly kind: "registered" }
  | { readonly kind: "no-permission" }
  | { readonly kind: "signed-out" }
  /**
   * The honest branch. A development build with no EAS project cannot obtain a
   * token, and the reason is carried so a screen can say so rather than showing
   * a switch that appears to have worked.
   */
  | { readonly kind: "unavailable"; readonly reason: string };

/**
 * Registers this device for the kinds the player's settings allow.
 *
 * Called after a granted prompt and again whenever the toggles change, so the
 * server's allowlist matches what the Settings screen shows. Registration is an
 * upsert on the token, so calling it repeatedly costs one statement.
 */
export async function registerDevice(
  preferences: NotificationPreferences,
): Promise<RegistrationOutcome> {
  const availability = getSupabase();
  if (availability.status !== "ready") {
    return { kind: "unavailable", reason: availability.message };
  }

  const { data } = await availability.client.auth.getSession();
  if (!data.session) return { kind: "signed-out" };

  const permission = await Notifications.getPermissionsAsync().catch(() => null);
  if (!permission?.granted) return { kind: "no-permission" };

  const projectId = easProjectId();
  if (!projectId) {
    return {
      kind: "unavailable",
      reason:
        "This build has no EAS project configured, so the device cannot be issued a push token.",
    };
  }

  let token: string;
  try {
    const result = await Notifications.getExpoPushTokenAsync({ projectId });
    token = result.data;
  } catch (error) {
    return { kind: "unavailable", reason: describe(error) };
  }

  const { error } = await availability.client.rpc("register_push_token", {
    p_token: token,
    p_platform: Platform.OS === "android" ? "android" : "ios",
    p_device_id: Constants.sessionId ?? null,
    p_kinds: allowedKinds(preferences),
  });
  if (error) return { kind: "unavailable", reason: "Could not register this device." };

  await ensureAndroidChannels();
  return { kind: "registered" };
}

/**
 * Stops push to this device.
 *
 * Called when the switch goes off and when the player signs out. The row is
 * deactivated rather than deleted, so turning it back on does not depend on the
 * OS reissuing a token.
 */
export async function retireDevice(): Promise<void> {
  const availability = getSupabase();
  if (availability.status !== "ready") return;

  const projectId = easProjectId();
  if (!projectId) return;

  try {
    const { data } = await availability.client.auth.getSession();
    if (!data.session) return;

    const token = await Notifications.getExpoPushTokenAsync({ projectId });
    await availability.client.rpc("retire_push_token", { p_token: token.data });
  } catch {
    // No token means nothing to retire.
  }
}

// ---------------------------------------------------------------------------

function easProjectId(): string | undefined {
  const fromConfig = Constants.expoConfig?.extra?.eas as { projectId?: string } | undefined;
  return fromConfig?.projectId ?? Constants.easConfig?.projectId;
}

function describe(error: unknown): string {
  if (error instanceof Error) return error.message.slice(0, 160);
  return "Push notifications are unavailable on this build.";
}
