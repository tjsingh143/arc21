/**
 * Arc 21 — haptics.
 *
 * Deliberately restrained. Haptics mark meaningful state changes — a card
 * landing, a hand won — not every animation frame. A device buzzing through a
 * dealer's draw is noise, and it is worse than noise for someone using a screen
 * reader or Reduce Motion, who cannot see what the buzzing corresponds to.
 *
 * Every call is fire-and-forget and swallows its errors: a platform without a
 * taptic engine must degrade to silence, never to a crash mid-hand.
 */

import * as Haptics from "expo-haptics";
import { Platform } from "react-native";

let enabled = true;

/** Wired to the Settings toggle. Defaults on. */
export function setHapticsEnabled(next: boolean): void {
  enabled = next;
}

export function hapticsEnabled(): boolean {
  return enabled;
}

/**
 * Android's haptic support through Expo is inconsistent across devices and the
 * heavier styles can feel like a malfunction rather than feedback, so the
 * richer notification patterns are iOS-only. Selection feedback is safe on both.
 */
const supportsNotificationHaptics = Platform.OS === "ios";

function guard(run: () => Promise<unknown>): void {
  if (!enabled) return;
  void run().catch(() => {
    // No taptic engine, or the user disabled system haptics. Silence is correct.
  });
}

/** Chip taps, mode changes, selecting a split hand. */
export function hapticSelection(): void {
  guard(() => Haptics.selectionAsync());
}

/** A card landing, or an action being accepted. */
export function hapticAction(): void {
  guard(() => Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light));
}

/** An ordinary win. */
export function hapticWin(): void {
  guard(() =>
    supportsNotificationHaptics
      ? Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success)
      : Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium),
  );
}

/** A natural blackjack — the one moment that earns a stronger cue. */
export function hapticBlackjack(): void {
  guard(() =>
    supportsNotificationHaptics
      ? Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success)
      : Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy),
  );
}

/**
 * Advancing in a tournament — the field filling, or a placement settling.
 *
 * The specification asks for "notification-style feedback" here specifically,
 * and the distinction is real: this is news arriving rather than an action being
 * confirmed, so it uses the notification pattern rather than an impact. On
 * Android, where the notification patterns are inconsistent across devices, it
 * degrades to a single medium impact rather than to something that feels broken.
 */
export function hapticTournamentAdvance(): void {
  guard(() =>
    supportsNotificationHaptics
      ? Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success)
      : Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium),
  );
}

/**
 * A bust or a loss.
 *
 * Uses the *warning* pattern, not *error*: losing a hand is an ordinary outcome
 * of a fair game, not a mistake the player made. Punishing a loss with an error
 * buzz is exactly the loss-shaming this product avoids.
 */
export function hapticLoss(): void {
  guard(() =>
    supportsNotificationHaptics
      ? Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning)
      : Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light),
  );
}

/** An illegal action, or a rejected command. */
export function hapticRejected(): void {
  guard(() =>
    supportsNotificationHaptics
      ? Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error)
      : Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Rigid),
  );
}

import type { HandOutcomeKind } from "../../../shared/blackjack/types.js";

/**
 * Maps a settled hand to its feedback, so callers never re-derive the mapping
 * and every surface stays consistent.
 */
export function hapticForOutcome(kind: HandOutcomeKind): void {
  switch (kind) {
    case "BLACKJACK":
      hapticBlackjack();
      break;
    case "WIN":
      hapticWin();
      break;
    case "BUST":
    case "LOSS":
      hapticLoss();
      break;
    case "PUSH":
    case "SURRENDER":
      // Neutral outcomes get no haptic at all. Not every event needs one.
      break;
  }
}
