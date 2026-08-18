/**
 * The Daily Challenge reminder.
 *
 * Scheduled ON THE DEVICE rather than pushed from the server, and that is the
 * whole design. A daily reminder needs no server knowledge — the challenge
 * exists every day for everybody — so pushing it would mean a scheduler, a fan-
 * out to every registered token, and a queue that grows by one row per player
 * per day, to say something the device already knows.
 *
 * It also means the toggle in Settings does something. Without this, the
 * `daily_challenge` kind would be a switch governing a notification nothing ever
 * writes, which is precisely the sort of decoration this phase's audit was for.
 *
 * The copy is deliberately flat. "Today's challenge is available" is a fact; a
 * streak counter, a countdown or a warning about what is about to be lost would
 * be a retention mechanic wearing a reminder's clothes, and this product does not
 * do that.
 */

import * as Notifications from "expo-notifications";

/**
 * A stable identifier so rescheduling replaces rather than accumulates.
 *
 * Without it, every toggle would leave another daily notification behind and a
 * player who flipped the switch a few times would be reminded several times a
 * day — the classic way this feature goes wrong.
 */
const IDENTIFIER = "arc21-daily-challenge";

/**
 * Early evening, local time.
 *
 * A daily challenge takes a few minutes, so the reminder wants a moment when
 * that is plausible: not the morning commute, not the middle of the working day,
 * and not late enough to be the last thing before sleep.
 */
const HOUR = 18;
const MINUTE = 0;

export async function scheduleDailyChallengeReminder(): Promise<void> {
  try {
    await cancelDailyChallengeReminder();
    await Notifications.scheduleNotificationAsync({
      identifier: IDENTIFIER,
      content: {
        title: "Today's Daily Challenge",
        body: "Everyone plays the same shoe. One ranked attempt a day.",
        // Routed by KIND, exactly like a server notification — the destination
        // is never a path carried in a payload.
        data: { kind: "daily_challenge" },
        // No sound. A reminder is not an alert, and the banner is enough.
        sound: false,
      },
      trigger: {
        type: Notifications.SchedulableTriggerInputTypes.DAILY,
        hour: HOUR,
        minute: MINUTE,
      },
    });
  } catch {
    // No notification support on this build, or permission was revoked between
    // the toggle and here. A missing reminder is not worth an error.
  }
}

export async function cancelDailyChallengeReminder(): Promise<void> {
  try {
    await Notifications.cancelScheduledNotificationAsync(IDENTIFIER);
  } catch {
    // Nothing scheduled. Cancelling something absent is not a failure.
  }
}

/** Brings the schedule in line with a preference. */
export async function applyDailyReminderPreference(enabled: boolean): Promise<void> {
  if (enabled) await scheduleDailyChallengeReminder();
  else await cancelDailyChallengeReminder();
}
