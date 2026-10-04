/**
 * Public profile presentation and device-local Practice summary.
 * Server profiles supply online handles, names and competitive progression.
 * The offline fallback never invents a canonical handle, XP or a server level.
 * Runtime-neutral: no React, React Native or Expo imports.
 */

import type { UnavailableCopy } from "./competition.js";
import { rate, type Rate } from "./rate.js";
import type { PracticeStatsSnapshot } from "./aggregate.js";

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

export interface GuestIdentity {
  kind: "guest";
  /**
   * What to show where a username would go. Not a generated handle: a made-up
   * name would be indistinguishable from one the player chose.
   */
  displayName: string;
  /** One or two letters for the avatar. */
  initials: string;
  detail: string;
}

export interface AccountIdentity {
  kind: "account";
  displayName: string;
  initials: string;
  detail: string;
}

export type ProfileIdentity = GuestIdentity | AccountIdentity;

export const GUEST_IDENTITY: GuestIdentity = {
  kind: "guest",
  displayName: "Player",
  initials: "P",
  detail: "Practice is saved on this device. Connect for your online player profile.",
};

/**
 * Initials for an avatar, from a display name the player actually chose.
 *
 * Never called for a guest — `GUEST_IDENTITY` carries its own — but it exists
 * so that the day sign-in lands, the avatar does not need inventing again.
 */
export function initialsFor(displayName: string): string {
  const words = displayName
    .trim()
    .split(/\s+/)
    .filter((word) => word.length > 0);

  const first = words[0]?.[0] ?? "";
  const second = words.length > 1 ? (words[words.length - 1]?.[0] ?? "") : "";
  const initials = `${first}${second}`.toUpperCase();

  return initials === "" ? "?" : initials;
}

export function profileIdentity(context: {
  hasAccount: boolean;
  displayName?: string | null;
  /** The server-normalised handle, rendered as `@handle`. */
  username?: string | null;
}): ProfileIdentity {
  if (!context.hasAccount) return GUEST_IDENTITY;

  const name = context.displayName?.trim();
  if (!name) return GUEST_IDENTITY;

  const handle = context.username?.trim();
  return {
    kind: "account",
    displayName: name,
    initials: initialsFor(name),
    /*
     * The handle, when there is one. The specification's profile hierarchy is
     * "Avatar / Display name / @username", and this line is the third of those.
     *
     * It used to read "Your Arc 21 player profile." beneath a display name that was
     * the player's EMAIL ADDRESS — the largest type on the screen, in a
     * screenshot anybody might share.
     */
    detail: handle ? `@${handle}` : "Your Arc 21 player profile.",
  };
}

// ---------------------------------------------------------------------------
// Level and XP
// ---------------------------------------------------------------------------

export type ProgressionUnavailableReason = "NO_ACCOUNT" | "OFFLINE";

export interface ProgressionRecord {
  level: number;
  xpIntoLevel: number;
  xpForNextLevel: number;
}

export type ProgressionState =
  | { status: "unavailable"; reason: ProgressionUnavailableReason }
  | { status: "ready"; record: ProgressionRecord; progress: Rate };

/**
 * Whether a level and XP bar may be drawn at all.
 *
 * There is deliberately no "level 0" or "0 XP" branch. A zero is a value, and a
 * value the player did not earn is a fabrication regardless of how small it is.
 */
export function progressionState(context: {
  hasAccount: boolean;
  online?: boolean;
  record?: ProgressionRecord | null;
}): ProgressionState {
  if (!context.hasAccount) return { status: "unavailable", reason: "NO_ACCOUNT" };
  if (!context.record) return { status: "unavailable", reason: "OFFLINE" };

  return {
    status: "ready",
    record: context.record,
    progress: rate(context.record.xpIntoLevel, context.record.xpForNextLevel),
  };
}

export function describeProgressionUnavailable(
  reason: ProgressionUnavailableReason,
): UnavailableCopy {
  switch (reason) {
    case "NO_ACCOUNT":
      return {
        title: "No level yet",
        /*
         * "This build has no sign-in" was true when it was written and false by
         * the time anybody read it — the identical expiry that
         * `describeCompetitionUnavailable` carried, found in the same sweep.
         * The screen offering this note also offers a working sign-in, so the
         * note now names it instead of denying it exists.
         */
        body:
          "Level and XP come from online play. Your player identity connects automatically " +
          "without an email or password. Practice remains available offline.",
      };
    case "OFFLINE":
      return {
        title: "Offline",
        body: "Your level lives on the server and has not been loaded on this device yet.",
      };
  }
}

// ---------------------------------------------------------------------------
// The summary
// ---------------------------------------------------------------------------

export interface CareerStars {
  earned: number;
  available: number;
}

export interface ProfileHeadline {
  /** The mastery figure: unaided decisions only. */
  accuracy: Rate;
  /** Every graded decision, including those made with the answer on screen. */
  accuracyIncludingAided: Rate;
  handsPlayed: number;
  careerStars: CareerStars;
  /** Progress through the career map, for the stars ring. */
  careerProgress: Rate;
  /** Server-recorded tournament wins, or null when unread. Never a defaulted zero. */
  tournamentWins: number | null;
}

export interface ProfileSummary {
  identity: ProfileIdentity;
  progression: ProgressionState;
  headline: ProfileHeadline;
  /** False before a single hand or decision, so the screen can say so plainly. */
  hasPlayed: boolean;
}

export function summariseProfile(input: {
  stats: PracticeStatsSnapshot;
  careerStars: CareerStars;
  hasAccount?: boolean;
  displayName?: string | null;
  username?: string | null;
  progression?: ProgressionRecord | null;
  /** Server-recorded, or null when it could not be read. Never defaulted to 0. */
  tournamentWins?: number | null;
}): ProfileSummary {
  const hasAccount = input.hasAccount ?? false;
  const stats = input.stats;

  const handsPlayed = nonNegative(stats.handsPlayed);
  const earned = nonNegative(input.careerStars.earned);
  const available = nonNegative(input.careerStars.available);

  return {
    identity: profileIdentity({
      hasAccount,
      displayName: input.displayName ?? null,
      username: input.username ?? null,
    }),
    progression: progressionState({ hasAccount, record: input.progression ?? null }),
    headline: {
      accuracy: rate(stats.unaidedCorrect, stats.unaidedDecisions),
      accuracyIncludingAided: rate(stats.correct, stats.decisions),
      handsPlayed,
      careerStars: { earned, available },
      careerProgress: rate(earned, available),
      /*
       * Null, not zero, when it has not been read. A zero is a value, and a
       * value nobody earned asserts the app is keeping score of something it is
       * not — the same rule the level bar follows two fields up.
       */
      tournamentWins: input.tournamentWins ?? null,
    },
    hasPlayed: handsPlayed > 0 || nonNegative(stats.decisions) > 0,
  };
}

function nonNegative(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0;
}
