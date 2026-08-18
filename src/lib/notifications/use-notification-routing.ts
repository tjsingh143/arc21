/**
 * Arc 21 — where a tapped notification goes.
 *
 * Mounted once at the root. Two paths lead here and both are handled:
 *
 *   - the app was already running and a notification was tapped;
 *   - the app was launched BY a notification, so the tap happened before any
 *     listener existed. `getLastNotificationResponseAsync` is what recovers it,
 *     and forgetting it is the classic reason a cold-start deep link "does
 *     nothing".
 *
 * The payload is untrusted. It arrives through the OS, so the destination is
 * derived from the notification's KIND by `destinationFor` and never read as a
 * path — a payload that could name its own route would be an open redirect
 * wearing an app icon.
 */

import { useEffect, useRef } from "react";
import * as Notifications from "expo-notifications";
import { useRouter } from "expo-router";

import { playSound } from "../audio/audio.js";
import {
  NOTIFICATION_KINDS,
  destinationFor,
  pathFor,
  type NotificationKind,
} from "../../features/notifications/notifications.js";

/** Reads a kind out of a push payload, or nothing. */
function kindOf(data: unknown): NotificationKind | null {
  if (typeof data !== "object" || data === null) return null;
  const candidate = (data as { kind?: unknown }).kind;
  if (typeof candidate !== "string") return null;
  return (NOTIFICATION_KINDS as readonly string[]).includes(candidate)
    ? (candidate as NotificationKind)
    : null;
}

function roomCodeOf(data: unknown): string | undefined {
  const value = (data as { room_code?: unknown } | null)?.room_code;
  return typeof value === "string" ? value : undefined;
}

function gameIdOf(data: unknown): string | undefined {
  const value = (data as { game_id?: unknown } | null)?.game_id;
  return typeof value === "string" ? value : undefined;
}

export function useNotificationRouting(): void {
  const router = useRouter();
  // A cold-start response is delivered to BOTH the listener and the "last
  // response" query on some platforms. Routing twice would push the screen twice.
  const handled = useRef<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    const route = (response: Notifications.NotificationResponse | null): void => {
      if (cancelled || !response) return;

      const id = response.notification.request.identifier;
      if (handled.current === id) return;
      handled.current = id;

      const data = response.notification.request.content.data;
      const kind = kindOf(data);
      if (!kind) return;

      const path = pathFor(
        destinationFor({
          kind,
          data: { room_code: roomCodeOf(data), game_id: gameIdOf(data) },
        }),
      );
      router.push(path as never);
    };

    Notifications.getLastNotificationResponseAsync()
      .then(route)
      .catch(() => {
        // No launch notification, or notifications unavailable on this build.
      });

    const subscription = Notifications.addNotificationResponseReceivedListener(route);

    /*
     * A notification that arrives while the app is OPEN gets the friend-invite
     * cue — the specification lists it among the sounds, and this is the only
     * moment at which the app is in a position to make one. A backgrounded
     * arrival is the operating system's to announce, with the device's own sound
     * and not ours.
     *
     * `playSound` is a no-op when sound is switched off, so this needs no
     * separate check.
     */
    const arrival = Notifications.addNotificationReceivedListener((notification) => {
      const kind = kindOf(notification.request.content.data);
      if (kind === "friend_request" || kind === "friend_accepted" || kind === "table_invite") {
        playSound("friendInvite");
      }
    });

    return () => {
      cancelled = true;
      subscription.remove();
      arrival.remove();
    };
  }, [router]);
}
