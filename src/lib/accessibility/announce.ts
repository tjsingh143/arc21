/**
 * Arc 21 — screen-reader announcements.
 *
 * State that changes without a navigation — whose turn it is, what the
 * dealer's up-card is, how a hand settled — needs an explicit announcement,
 * because a VoiceOver user does not re-read a value just because it changed
 * under them. These are exactly the events the specification names.
 *
 * Deliberately NOT wired to decorative motion: `DealtCard`'s per-card deal
 * animation and `OutcomeBadge`'s halo fire on every frame of a four-card
 * stagger, and announcing each of those would bury the one announcement that
 * matters (the settlement) under noise. Only the settled state is announced,
 * once, by the caller — see `outcome-announcement.ts` and its call site in
 * `OutcomeBadge`.
 *
 * Indirected through a sink for the same reason `audio.ts` is:
 * `AccessibilityInfo.announceForAccessibility` has no meaningful behaviour
 * under Node, and this module is called from the same table code the unit
 * tests drive.
 */

import { AccessibilityInfo } from "react-native";

export interface AnnouncementSink {
  announce(message: string): void;
}

/** The sink before a device one is installed, and the one tests run against by default. */
export class SilentAnnouncementSink implements AnnouncementSink {
  announce(): void {}
}

/** Records calls so tests can assert what the table announced, without a device. */
export class RecordingAnnouncementSink implements AnnouncementSink {
  readonly announced: string[] = [];
  announce(message: string): void {
    this.announced.push(message);
  }
}

class LiveAnnouncementSink implements AnnouncementSink {
  announce(message: string): void {
    AccessibilityInfo.announceForAccessibility(message);
  }
}

let sink: AnnouncementSink = new SilentAnnouncementSink();

export function setAnnouncementSink(next: AnnouncementSink): void {
  sink = next;
}

/** Installs the real device sink. Called once, from the app root. */
export function installLiveAnnouncementSink(): void {
  sink = new LiveAnnouncementSink();
}

export function announce(message: string): void {
  try {
    sink.announce(message);
  } catch {
    // An announcement is never load-bearing. A failed one must not interrupt a hand.
  }
}
