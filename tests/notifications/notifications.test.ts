/**
 * Reading a notification, and deciding where it leads.
 *
 * The security-relevant test in this file is the routing one. A notification
 * payload is the only content in this app that arrives through the operating
 * system rather than through a channel it controls, so a payload that could name
 * its own destination would be an open redirect with an app icon on it. The
 * destination is derived from the KIND, and these prove it stays that way.
 *
 * The rest is about not misleading a player: a row that cannot be read is
 * dropped rather than half-rendered, and a toggle in Settings maps to kinds the
 * server actually filters on.
 */

import { describe, expect, it } from "vitest";

import {
  KINDS_BY_PREFERENCE,
  KIND_LABELS,
  NOTIFICATION_KINDS,
  allowedKinds,
  describeAge,
  destinationFor,
  pathFor,
  preferencesAfterGrant,
  toNotifications,
  unreadCount,
  type NotificationKind,
} from "../../src/features/notifications/notifications.js";
import {
  ANDROID_CHANNEL_DEFAULT,
  ANDROID_CHANNEL_TURN,
} from "../../src/lib/notifications/channels.js";
import { ANDROID_CHANNELS } from "../../supabase/functions/_shared/push-message.js";

const ROW = {
  id: "11111111-1111-4111-8111-111111111111",
  kind: "friend_request" as const,
  title: "Friend request",
  body: "Someone wants to be friends.",
  data: { from_user_id: "22222222-2222-4222-8222-222222222222" },
  read_at: null,
  created_at: "2026-08-17T10:00:00.000Z",
};

describe("reading the inbox", () => {
  it("parses a list", () => {
    expect(toNotifications([ROW, { ...ROW, id: "22222222-2222-4222-8222-222222222222" }])).toHaveLength(2);
  });

  it("drops a row it cannot read rather than half-rendering it", () => {
    expect(toNotifications([ROW, { id: "not-a-uuid" }])).toHaveLength(1);
    expect(toNotifications([ROW, { ...ROW, kind: "invented_kind" }])).toHaveLength(1);
  });

  it("returns nothing for a non-list", () => {
    expect(toNotifications(null)).toEqual([]);
    expect(toNotifications({ id: ROW.id })).toEqual([]);
  });

  it("tolerates an absent payload", () => {
    const parsed = toNotifications([{ ...ROW, data: null }]);
    expect(parsed).toHaveLength(1);
    expect(parsed[0]?.data).toEqual({});
  });

  it("strips anything that is not a deep-link parameter", () => {
    // The database refuses these at the column. This is the second check, and it
    // is the one that sees payloads arriving through the operating system.
    const parsed = toNotifications([
      { ...ROW, data: { room_code: "ABCDEF", seed_secret: "hunter2", shoe: ["AS", "KD"] } },
    ]);
    expect(parsed[0]?.data).toEqual({
      room_code: "ABCDEF",
      tournament_id: undefined,
      game_id: undefined,
      entry_id: undefined,
      challenge_date: undefined,
      from_user_id: undefined,
    });
    expect(JSON.stringify(parsed[0]?.data)).not.toContain("hunter2");
  });

  it("counts unread", () => {
    const rows = toNotifications([
      ROW,
      { ...ROW, id: "33333333-3333-4333-8333-333333333333", read_at: "2026-08-17T11:00:00.000Z" },
    ]);
    expect(unreadCount(rows)).toBe(1);
  });
});

describe("where a notification leads", () => {
  it("has a destination for every kind", () => {
    // No kind may fall through to undefined: a tapped notification that does
    // nothing reads as a broken app.
    for (const kind of NOTIFICATION_KINDS) {
      const destination = destinationFor({ kind, data: {} });
      expect(destination, kind).toBeDefined();
      expect(pathFor(destination).startsWith("/"), kind).toBe(true);
    }
  });

  it("routes a table invite to the room, by code", () => {
    expect(pathFor(destinationFor({ kind: "table_invite", data: { room_code: "ABCDEF" } }))).toBe(
      "/room/ABCDEF",
    );
  });

  it("falls back rather than building a broken route", () => {
    // An invite with no code is still true — somebody did invite you — so it
    // leads to Social rather than to `/room/undefined`.
    expect(pathFor(destinationFor({ kind: "table_invite", data: {} }))).toBe("/social");
    expect(pathFor(destinationFor({ kind: "your_turn", data: {} }))).toBe("/notifications");
  });

  it("never reads a path out of the payload", () => {
    // The whole point. A payload naming `/settings` or an external URL changes
    // nothing about where the notification goes.
    const destination = destinationFor({
      kind: "friend_request",
      data: { room_code: "../../settings" } as never,
    });
    expect(pathFor(destination)).toBe("/social");
  });

  it("puts a room code straight into the path, so the route must validate it", () => {
    // Documented rather than defended here: `app/room/[code].tsx` normalises and
    // shape-checks the code, and `join_private_room` re-checks everything that
    // matters server-side. A code is an address, not a key.
    expect(pathFor(destinationFor({ kind: "table_invite", data: { room_code: "zz" } }))).toBe(
      "/room/zz",
    );
  });

  it("labels every kind", () => {
    for (const kind of NOTIFICATION_KINDS) {
      expect(KIND_LABELS[kind].length, kind).toBeGreaterThan(0);
    }
  });
});

describe("what a device asks the server to push", () => {
  const off = {
    notificationsEnabled: false,
    notifyYourTurn: false,
    notifyFriendRequests: false,
    notifyDailyChallenge: false,
  };

  it("asks for nothing when notifications are off", () => {
    expect(allowedKinds(off)).toEqual([]);
    // Even with every per-kind switch on. The master switch is the master switch.
    expect(
      allowedKinds({
        notificationsEnabled: false,
        notifyYourTurn: true,
        notifyFriendRequests: true,
        notifyDailyChallenge: true,
      }),
    ).toEqual([]);
  });

  it("always includes the kinds that follow the master switch alone", () => {
    const kinds = allowedKinds({ ...off, notificationsEnabled: true });
    expect(kinds).toEqual([...KINDS_BY_PREFERENCE.always]);
  });

  it("adds exactly the kinds a toggle governs", () => {
    const kinds = allowedKinds({ ...off, notificationsEnabled: true, notifyFriendRequests: true });
    expect(kinds).toContain("table_invite");
    expect(kinds).toContain("friend_request");
    expect(kinds).not.toContain("your_turn");
  });

  it("covers every kind across the preference map", () => {
    // A kind missing from the map would be pushed to nobody, forever, with no
    // switch to turn it on — the quietest possible way for a feature to be dead.
    const mapped = new Set<NotificationKind>(
      Object.values(KINDS_BY_PREFERENCE).flatMap((kinds) => [...kinds]),
    );
    for (const kind of NOTIFICATION_KINDS) {
      expect(mapped.has(kind), kind).toBe(true);
    }
  });
});

describe("granting permission at a moment", () => {
  const off = {
    notificationsEnabled: false,
    notifyYourTurn: false,
    notifyFriendRequests: false,
    notifyDailyChallenge: false,
  };

  it("switches on only the moment's own category", () => {
    const after = preferencesAfterGrant("accepted-friend-request", off);
    expect(after.notificationsEnabled).toBe(true);
    expect(after.notifyFriendRequests).toBe(true);
    // Saying yes while accepting a friend request is not consent to be told
    // that a hand timed out at a table.
    expect(after.notifyYourTurn).toBe(false);
    expect(after.notifyDailyChallenge).toBe(false);
  });

  it("presumes nothing extra from entering a tournament", () => {
    const after = preferencesAfterGrant("entered-tournament", off);
    expect(after.notificationsEnabled).toBe(true);
    expect(after.notifyFriendRequests).toBe(false);
    expect(after.notifyYourTurn).toBe(false);
  });

  it("changes nothing the player did not touch in Settings", () => {
    const after = preferencesAfterGrant("settings-toggle", off);
    expect(after).toEqual({ ...off, notificationsEnabled: true });
  });
});

describe("the Android channels agree across the runtime boundary", () => {
  it("names the same channels the server puts on a message", () => {
    // The server stamps `channelId` on every push message and the device creates
    // the channels. A disagreement is silent: the notification lands on
    // Android's fallback and quietly loses the importance its kind was given.
    expect(ANDROID_CHANNELS.timeCritical).toBe(ANDROID_CHANNEL_TURN);
    expect(ANDROID_CHANNELS.default).toBe(ANDROID_CHANNEL_DEFAULT);
  });
});

describe("how old a notification reads", () => {
  const now = new Date("2026-08-17T12:00:00.000Z");

  it("is coarse on purpose", () => {
    expect(describeAge("2026-08-17T11:59:30.000Z", now)).toBe("just now");
    expect(describeAge("2026-08-17T11:55:00.000Z", now)).toBe("5 minutes ago");
    expect(describeAge("2026-08-17T11:00:00.000Z", now)).toBe("1 hour ago");
    expect(describeAge("2026-08-15T12:00:00.000Z", now)).toBe("2 days ago");
  });

  it("says nothing rather than something wrong", () => {
    expect(describeAge("not a date", now)).toBe("");
  });

  it("never reads as being in the future", () => {
    // Clock skew between a device and the server is ordinary. "In 3 minutes" is
    // not.
    expect(describeAge("2026-08-17T12:05:00.000Z", now)).toBe("just now");
  });
});
