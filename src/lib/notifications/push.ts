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
import { capturePlayerScope } from "../../features/player/player-scope.js";

import { SqliteKeyValueStore, type KeyValueStore } from "../persistence/key-value-store.js";
import { getSupabase } from "../supabase/client.js";
import { mayActAs } from "../supabase/adopted-player.js";
import { bindCurrentPlayer, sentAs, confirmedSession } from "../supabase/player-binding.js";
import { isTimedOut, withTimeout } from "../supabase/with-timeout.js";
import {
  ANDROID_CHANNEL_DEFAULT,
  ANDROID_CHANNEL_TURN,
} from "./channels.js";
import {
  allowedKinds,
  type NotificationPreferences,
} from "../../features/notifications/notifications.js";

export type PermissionStatus = "undetermined" | "granted" | "denied";

let registrationRevision = 0;
let deviceMutation: Promise<unknown> = Promise.resolve();
export function cancelPendingPushRegistration(): void { registrationRevision += 1; }
function mutateDevice<T>(work: () => PromiseLike<T>): Promise<T> {
  const actual = deviceMutation.then(work);
  deviceMutation = actual.catch(() => undefined);
  return actual;
}

/*
 * THE ORDER TRAVELS WITH THE WRITE (B-H4).
 *
 * The lane above runs this device's writes one at a time, and the final
 * Refresh-B audit showed why that is not enough: an older "Your turn: on" was
 * accepted by the server's side of the connection, the connection then failed,
 * the lane moved on and a newer "off" was written and acknowledged — and the
 * accepted "on" reached Postgres AFTER it. Work that has already left the
 * device cannot be ordered by the device.
 *
 * So every registration and retirement carries an INTENT REVISION, allocated
 * inside the lane in the order the writes are made, persisted before it is
 * sent, and never reused: the larger of one more than the last revision this
 * install allocated and the wall clock in milliseconds (so a reinstall, which
 * forgets the counter, still starts above everything sent before it). The
 * server applies a write only if its revision is newer than the row's
 * (`20261004120000_push_registration_intent_order.sql`): an obsolete write that
 * outlives its connection is a no-op, and the same write arriving twice is
 * applied once.
 */
const REVISION_KEY = "push:intent-revision:v1";
let revisionStore: KeyValueStore | null = null;
let lastRevision = 0;
let revisionRead = false;

/** Test seam: where the last allocated revision is kept. */
export function setPushRevisionStore(next: KeyValueStore | null): void {
  revisionStore = next;
  lastRevision = 0;
  revisionRead = false;
}

/** Strictly greater than every revision this install has allocated, and above `floor`. Lane-only. */
async function nextIntentRevision(floor = 0): Promise<number> {
  revisionStore ??= new SqliteKeyValueStore();
  if (!revisionRead) {
    revisionRead = true;
    try {
      const stored = Number(await revisionStore.get(REVISION_KEY));
      if (Number.isSafeInteger(stored) && stored > lastRevision) lastRevision = stored;
    } catch {
      // Unreadable: the wall clock below still starts above anything sent before.
    }
  }
  lastRevision = Math.max(lastRevision + 1, Date.now(), floor + 1);
  try {
    await revisionStore.set(REVISION_KEY, String(lastRevision));
  } catch {
    // Not persisted: still unique in this process, and above the clock.
  }
  return lastRevision;
}

/** The server's verdict on one ordered write: `{applied, revision}`. */
function orderVerdict(data: unknown): { readonly applied: boolean; readonly revision: number | null } | null {
  if (typeof data !== "object" || data === null) return null;
  const { applied, revision } = data as { applied?: unknown; revision?: unknown };
  if (typeof applied !== "boolean") return null;
  return { applied, revision: typeof revision === "number" ? revision : null };
}

type OrderedWrite = (revision: number) => PromiseLike<{ readonly data: unknown; readonly error: unknown }>;

/**
 * One ordered device write, inside the lane. Applied, or the same revision
 * already applied (a replay), is success. A row holding a revision NEWER than
 * any this install allocated — a reinstall, or a clock that went backwards —
 * moves the counter above it and asks once more, as the newest intent; an
 * intent that is genuinely obsolete never reaches this point, because nothing
 * in the lane is older than the write being made now.
 */
async function writeInOrder(
  write: OrderedWrite,
  stillCurrent: () => boolean = () => true,
): Promise<{ readonly error: unknown }> {
  let revision = await nextIntentRevision();
  for (let attempt = 0; attempt < 2; attempt += 1) {
    // A registration is pinned to its player; it never goes out for anybody else.
    if (!stillCurrent()) return { error: new Error("Player changed") };
    const result = await write(revision);
    if (result.error) return { error: result.error };
    const verdict = orderVerdict(result.data);
    if (verdict === null || verdict.applied || verdict.revision === null || verdict.revision <= revision) {
      return { error: null };
    }
    revision = await nextIntentRevision(verdict.revision);
  }
  return { error: null };
}

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

/**
 * What a registration asks the server to deliver: the preferences themselves,
 * or how to read the device's preferences as they stand. Either way it is
 * resolved inside the device lane, at the write (`registerDevice`).
 */
export type PreferenceSource = NotificationPreferences | (() => NotificationPreferences);

export type RegistrationOutcome =
  | { readonly kind: "registered" }
  | { readonly kind: "no-permission" }
  | { readonly kind: "signed-out" }
  /** A newer notification choice was made first; this registration wrote nothing. */
  | { readonly kind: "superseded" }
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
 *
 * The allowlist is read INSIDE the device lane, immediately before the write.
 * Everything before the lane can be delayed — the session read, the permission
 * read, the native token request — and the final Refresh-B audit (B-G2) held
 * that token request for an older "Your turn: on" while a newer "off" was
 * written and acknowledged; released, the older registration entered the lane
 * last and wrote its tap-time snapshot over the newer choice. The lane orders
 * writes, not intents; reading at the write is what lets the newest choice be
 * the one that commits, whichever registration happens to arrive last.
 */
export async function registerDevice(
  source: PreferenceSource,
  options: {
    /** False once a newer notification choice has made this registration's intent obsolete. */
    readonly intentIsCurrent?: () => boolean;
  } = {},
): Promise<RegistrationOutcome> {
  const revision = registrationRevision;
  const playerIsCurrent = capturePlayerScope();
  const isCurrent = () => playerIsCurrent() && revision === registrationRevision;
  const availability = getSupabase();
  if (availability.status !== "ready") {
    return { kind: "unavailable", reason: availability.message };
  }

  const { data } = await confirmedSession(availability.client);
  if (!data.session) return { kind: "signed-out" };
  const player = data.session.user.id;
  // Only ever for the player the app has adopted, checked again at the write.
  const forThisPlayer = () => isCurrent() && mayActAs(availability.client, player);

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

  if (!forThisPlayer()) return { kind: "signed-out" };
  const authorization = `Bearer ${data.session.access_token}`;
  let superseded = false;
  const result = await withTimeout(mutateDevice<{ error: unknown }>(() => {
    if (!forThisPlayer()) return Promise.resolve({ error: new Error("Player changed") });
    // An intent made obsolete by a newer choice writes nothing at all.
    if (options.intentIsCurrent && !options.intentIsCurrent()) {
      superseded = true;
      return Promise.resolve({ error: null });
    }
    return writeInOrder((revision) => {
      // Resolved at the write, so the newest choice is what this revision carries.
      const preferences = typeof source === "function" ? source() : source;
      return availability.client.rpc("register_push_token", {
        p_token: token,
        p_platform: Platform.OS === "android" ? "android" : "ios",
        p_device_id: Constants.sessionId ?? null,
        p_kinds: allowedKinds(preferences),
        p_revision: revision,
      }).setHeader("Authorization", authorization);
    }, forThisPlayer);
  }));
  if (!isCurrent()) return { kind: "signed-out" };
  if (isTimedOut(result) || result.error) return { kind: "unavailable", reason: "Could not register this device." };
  if (superseded) return { kind: "superseded" };

  await ensureAndroidChannels();
  return { kind: "registered" };
}

/**
 * Stops push to this device.
 *
 * Called when the switch goes off and when the player signs out. The row is
 * deactivated rather than deleted, so turning it back on does not depend on the
 * OS reissuing a token.
 *
 * A departure belongs to the player who is leaving, and its credential is
 * bound to them before anything is awaited (`player-binding.ts`). The device
 * token is shared by whoever signs in next, so the server's
 * `user_id = auth.uid()` check cannot tell the two apart once the credential is
 * the new player's: the Refresh-B audit (B-R5) held a retirement's session read
 * across a sign-in, let the new player register this device, and the stale
 * retirement then switched the NEW player's registration off. A retirement
 * whose credential could not be read before the player changed is refused.
 *
 * Once bound, it is deliberately NOT refused for a later switch, unlike
 * registration. Sent with the departing player's pinned credential, the server
 * confines it to that player's own row, so it cannot touch the new player's —
 * and completing it is what stops the departed player's pushes arriving on this
 * device when it had to wait behind another device write. Registration is the
 * opposite case: `on conflict (token)` would hand the row back to the departed
 * player, so a stale one is refused.
 */
export async function retireDevice(): Promise<void> {
  cancelPendingPushRegistration();
  const availability = getSupabase();
  if (availability.status !== "ready") return;

  const projectId = easProjectId();
  if (!projectId) return;

  try {
    // Captures the departing player's scope synchronously: nothing above awaits.
    const bound = await bindCurrentPlayer(availability.client);
    if (!bound.ok || !bound.player.isCurrent()) return;

    const token = await withTimeout(Notifications.getExpoPushTokenAsync({ projectId }));
    if (isTimedOut(token)) return;
    await withTimeout(mutateDevice(() => writeInOrder((revision) =>
      sentAs(availability.client.rpc("retire_push_token", { p_token: token.data, p_revision: revision }), bound.player))));
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
