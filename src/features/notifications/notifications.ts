/**
 * Reading notifications, and deciding where one leads.
 *
 * Pure and runtime-neutral, so the two things worth being sure of can be tested
 * without a device, a push service or a network:
 *
 *   - a payload from the server is UNTRUSTED INPUT. It arrives through a push
 *     message, which is the one channel this app does not fully control, so a
 *     row that cannot be read is dropped rather than half-rendered;
 *   - a notification never carries a route. The destination is derived from its
 *     KIND, and only the parameters that kind expects are read. A payload that
 *     asked to be opened at an arbitrary path would be an open redirect with a
 *     friendly icon.
 */

import { z } from "zod";

import { looksLikeRoomCode, normaliseRoomCode } from "../rooms/rooms.js";

export const NOTIFICATION_KINDS = [
  "friend_request",
  "friend_accepted",
  "table_invite",
  "your_turn",
  "tournament_starting",
  "tournament_result",
  "daily_challenge",
  "career_unlocked",
  "system",
] as const;

export type NotificationKind = (typeof NOTIFICATION_KINDS)[number];

/**
 * Deep-link parameters only, mirroring the allowlist the database enforces on
 * the column. Anything else is stripped here as well as refused there: two
 * checks, because this one also sees payloads that arrive through the OS.
 */
const dataSchema = z
  .object({
    room_code: z.string().max(64).optional(),
    tournament_id: z.string().max(64).optional(),
    game_id: z.string().max(64).optional(),
    entry_id: z.string().max(64).optional(),
    challenge_date: z.string().max(64).optional(),
    from_user_id: z.string().max(64).optional(),
    from_display_name: z.string().max(64).optional(),
    placement: z.union([z.number(), z.string()]).optional(),
  })
  .catchall(z.unknown())
  .transform((value) => ({
    room_code: value.room_code,
    tournament_id: value.tournament_id,
    game_id: value.game_id,
    entry_id: value.entry_id,
    challenge_date: value.challenge_date,
    from_user_id: value.from_user_id,
  }));

export const notificationSchema = z.object({
  id: z.string().uuid(),
  kind: z.enum(NOTIFICATION_KINDS),
  title: z.string(),
  body: z.string(),
  data: dataSchema.nullish().transform((value) => value ?? {}),
  read_at: z.string().nullable(),
  created_at: z.string(),
});

export type AppNotification = z.infer<typeof notificationSchema>;

export function toNotifications(value: unknown): AppNotification[] {
  if (!Array.isArray(value)) return [];
  const rows: AppNotification[] = [];
  for (const candidate of value) {
    const parsed = notificationSchema.safeParse(candidate);
    if (parsed.success) rows.push(parsed.data);
  }
  return rows;
}

export function unreadCount(rows: readonly AppNotification[]): number {
  return rows.filter((row) => row.read_at === null).length;
}

// ---------------------------------------------------------------------------
// Where a notification leads
// ---------------------------------------------------------------------------

/**
 * An in-app destination.
 *
 * A closed union rather than a string, so every place a notification can send
 * someone is written down here and nowhere else. Adding a kind that leads
 * somewhere new is a change to this file, which is exactly the review that a
 * navigation target deserves.
 */
export type Destination =
  | { readonly screen: "social" }
  | { readonly screen: "room"; readonly code: string }
  | { readonly screen: "tournament" }
  | { readonly screen: "daily" }
  | { readonly screen: "table"; readonly gameId: string }
  | { readonly screen: "career" }
  | { readonly screen: "notifications" };

/** `crypto.randomUUID()`'s shape, which is every id this app hands out. */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The room code in a payload, or nothing.
 *
 * A PUSH PAYLOAD IS ATTACKER-CONTROLLED. `use-notification-routing.ts` says so
 * and validates the KIND against a closed list for exactly that reason — but the
 * two parameters were passed through untouched and then interpolated into a
 * router path by `pathFor`, so a payload carrying `room_code: "../../settings"`
 * produced the path `/room/../../settings`. That is the open redirect the
 * routing module's own header says it is preventing, arriving through the
 * parameter rather than through the kind.
 *
 * A push reaches a device through APNs/FCM, so the sender is whoever holds that
 * device's Expo token, not necessarily this server. `notifications.data`'s CHECK
 * constraint bounds what WE write; it cannot bound what arrives.
 *
 * Nothing is granted by a route in this app — `/room/<code>` hands the code to
 * `join_private_room`, which decides — so the damage a forged route can do is to
 * open the wrong screen. It is still a route the payload chose, and the fix is
 * one line: a value that is not the shape of the thing it claims to be is not
 * that thing.
 */
function roomCodeIn(data: { room_code?: string }): string | null {
  const raw = data.room_code;
  if (typeof raw !== "string" || !looksLikeRoomCode(raw)) return null;
  return normaliseRoomCode(raw);
}

/** The same rule for a game id, which is always a uuid this server generated. */
function gameIdIn(data: { game_id?: string }): string | null {
  const raw = data.game_id;
  return typeof raw === "string" && UUID_PATTERN.test(raw) ? raw : null;
}

/**
 * Where tapping this notification should go.
 *
 * Every branch reads only the parameters its own kind defines, and reads them
 * through a validator rather than raw — see `roomCodeIn`. A `table_invite`
 * without a USABLE room code leads to Social rather than to a broken route: the
 * notification is still true — somebody did invite you — and the lobby is one
 * tap away.
 */
export function destinationFor(notification: {
  kind: NotificationKind;
  data: { room_code?: string; game_id?: string };
}): Destination {
  switch (notification.kind) {
    case "friend_request":
    case "friend_accepted":
      return { screen: "social" };
    case "table_invite": {
      const code = roomCodeIn(notification.data);
      return code ? { screen: "room", code } : { screen: "social" };
    }
    case "tournament_starting":
    case "tournament_result":
      return { screen: "tournament" };
    case "daily_challenge":
      return { screen: "daily" };
    case "your_turn": {
      const gameId = gameIdIn(notification.data);
      return gameId ? { screen: "table", gameId } : { screen: "notifications" };
    }
    case "career_unlocked":
      return { screen: "career" };
    case "system":
      return { screen: "notifications" };
  }
}

/** The path `expo-router` should push for a destination. */
export function pathFor(destination: Destination): string {
  switch (destination.screen) {
    case "social":
      return "/social";
    case "room":
      return `/room/${destination.code}`;
    case "tournament":
      return "/tournament";
    case "daily":
      return "/daily";
    case "table":
      return `/table/${destination.gameId}`;
    case "career":
      return "/career";
    case "notifications":
      return "/notifications";
  }
}

// ---------------------------------------------------------------------------
// Copy
// ---------------------------------------------------------------------------

/**
 * What each kind is called on screen.
 *
 * The titles and bodies themselves come from the server, so they cannot drift
 * between the push message and the inbox. This is the grouping label only.
 */
export const KIND_LABELS: Record<NotificationKind, string> = {
  friend_request: "Friends",
  friend_accepted: "Friends",
  table_invite: "Table",
  your_turn: "Table",
  tournament_starting: "Tournament",
  tournament_result: "Tournament",
  daily_challenge: "Daily Challenge",
  career_unlocked: "Career",
  system: "Arc 21",
};

/**
 * Which kinds each Settings toggle governs.
 *
 * The device sends this to the server when it registers, and the server pushes
 * only what the device asked for. A toggle that changed nothing on the server
 * would be a lie told in a settings screen.
 */
export const KINDS_BY_PREFERENCE = {
  notifyYourTurn: ["your_turn"],
  notifyFriendRequests: ["friend_request", "friend_accepted", "table_invite"],
  notifyDailyChallenge: ["daily_challenge"],
  /**
   * Tournament and career notifications follow the master switch alone. Both
   * are consequences of something the player deliberately entered, and neither
   * repeats: a tournament announces itself once and settles once.
   */
  always: ["tournament_starting", "tournament_result", "career_unlocked", "system"],
} as const satisfies Record<string, readonly NotificationKind[]>;

export interface NotificationPreferences {
  readonly notificationsEnabled: boolean;
  readonly notifyYourTurn: boolean;
  readonly notifyFriendRequests: boolean;
  readonly notifyDailyChallenge: boolean;
}

/**
 * The kinds this device wants pushed.
 *
 * Empty when the master switch is off — which is not the same as "no
 * registration". A device with an empty allowlist is still known to the server
 * and simply receives nothing, so turning notifications back on does not have
 * to wait for the OS to reissue a token.
 */
export function allowedKinds(preferences: NotificationPreferences): NotificationKind[] {
  if (!preferences.notificationsEnabled) return [];

  const kinds: NotificationKind[] = [...KINDS_BY_PREFERENCE.always];
  if (preferences.notifyYourTurn) kinds.push(...KINDS_BY_PREFERENCE.notifyYourTurn);
  if (preferences.notifyFriendRequests) kinds.push(...KINDS_BY_PREFERENCE.notifyFriendRequests);
  if (preferences.notifyDailyChallenge) kinds.push(...KINDS_BY_PREFERENCE.notifyDailyChallenge);
  return kinds;
}

/**
 * Moments at which asking for notification permission is reasonable.
 *
 * The specification is explicit that onboarding is not one of them: permission
 * is requested only after the player does something that notifications are
 * about. Naming the moments in a union means a new prompt site cannot be added
 * without appearing in this list.
 */
export type PermissionMoment =
  | "accepted-friend-request"
  | "entered-tournament"
  | "created-private-table"
  | "settings-toggle";

export const PERMISSION_RATIONALE: Record<PermissionMoment, string> = {
  "accepted-friend-request": "Get told when a friend invites you to a table.",
  "entered-tournament": "Get told when your tournament starts and when it finishes.",
  "created-private-table": "Get told when someone joins your table.",
  "settings-toggle": "Choose what Arc 21 may notify you about.",
};

/**
 * What granting permission AT a moment switches on.
 *
 * The moment's own kind, and nothing else. Someone who says yes while accepting
 * a friend request has agreed to hear about friends — reading that as consent to
 * every category would be the reason people turn notifications off wholesale.
 *
 * Tournament and career kinds are absent because they are in `always`: they
 * follow the master switch and have no toggle of their own.
 */
export function preferencesAfterGrant(
  moment: PermissionMoment,
  current: NotificationPreferences,
): NotificationPreferences {
  return { ...current, ...grantPatch(moment) };
}

/**
 * The notification choices a change touches — those keys and nothing else.
 *
 * What an asynchronous notification flow carries instead of a Settings
 * snapshot (B-H2): a snapshot taken before an await restores, after it, every
 * newer choice made meanwhile — the final Refresh-B audit watched a delayed
 * offer turn an explicit "Friends: off" back on and a "Only me" back to public.
 * A patch merged into the record AS IT STANDS cannot.
 */
export type NotificationPatch = Partial<NotificationPreferences>;

const PATCH_KEYS = ["notificationsEnabled", "notifyYourTurn", "notifyFriendRequests", "notifyDailyChallenge"] as const;

/** The notification keys of any object, and only those — a full Settings record included. */
export function notificationPatchOf(value: NotificationPatch): NotificationPatch {
  const patch: { -readonly [K in keyof NotificationPreferences]?: boolean } = {};
  for (const key of PATCH_KEYS) {
    if (typeof value[key] === "boolean") patch[key] = value[key];
  }
  return patch;
}

/** What granting permission at a moment switches on, as a patch (`preferencesAfterGrant`). */
export function grantPatch(moment: PermissionMoment): NotificationPatch {
  switch (moment) {
    case "accepted-friend-request":
    case "created-private-table":
      return { notificationsEnabled: true, notifyFriendRequests: true };
    case "entered-tournament":
      // Tournament notifications need no per-kind switch. Nothing else is
      // presumed from entering one.
      return { notificationsEnabled: true };
    case "settings-toggle":
      // The player is looking at the switches. Changing one they did not touch
      // would be the screen arguing with them.
      return { notificationsEnabled: true };
  }
}

/**
 * Relative time, in the plainest words that stay accurate.
 *
 * Deliberately coarse. A notification list is not a log, and "3 minutes ago"
 * carries no more meaning here than "just now" while inviting the reader to
 * check whether the clock is right.
 */
export function describeAge(createdAt: string, now: Date = new Date()): string {
  const then = Date.parse(createdAt);
  if (Number.isNaN(then)) return "";

  const seconds = Math.max(0, Math.round((now.getTime() - then) / 1_000));
  if (seconds < 60) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"} ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.round(hours / 24);
  if (days < 7) return `${days} day${days === 1 ? "" : "s"} ago`;
  return new Date(then).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
  });
}
