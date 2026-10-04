/**
 * No player-facing sentence may claim this build has no sign-in.
 *
 * THE DEFECT. Two "requires an account" empty states told the player, in so
 * many words, that Arc 21 had no sign-in:
 *
 *   Statistics → Competition   "This build has no sign-in yet, so there is no
 *                               record to show — not a record of zero."
 *   Profile    → Level         "This build has no sign-in, so there is no level
 *                               to show…"
 *
 * Both were true when they were written and false by the time anybody read
 * them. Accounts, XP, the level curve and the leaderboards all shipped, and
 * `competition.ts`'s own header documents the sibling half of the same expiry —
 * `hasAccount` written as the literal `false` and never revisited — while the
 * copy underneath it went on asserting the thing that literal had assumed.
 *
 * It is worse than a stale comment for one reason: a refusal has to name
 * something the player can DO. These named the opposite — a guest was told the
 * feature did not exist, on a screen that was one tap from the sign-in that
 * would have given it to them.
 *
 * `STATS_VISIBILITY_NOTE` already carries this exact lesson in its own header
 * ("A privacy note is the single worst place in a product for a sentence that
 * has quietly expired"), which is what makes these two worth a guard rather
 * than a fix: the rule was known and written down, and two strings still drifted
 * past it.
 */

import { describe, expect, it } from "vitest";

import {
  describeCompetitionUnavailable,
  type CompetitionUnavailableReason,
} from "../../src/features/stats/competition.js";
import {
  describeProgressionUnavailable,
  type ProgressionUnavailableReason,
} from "../../src/features/stats/profile.js";
import { STATS_VISIBILITY_NOTE } from "../../src/features/settings/settings.js";

const COMPETITION_REASONS: CompetitionUnavailableReason[] = ["NO_ACCOUNT", "OFFLINE"];
const PROGRESSION_REASONS: ProgressionUnavailableReason[] = ["NO_ACCOUNT", "OFFLINE"];

/** Every string this app shows a player who has no account. */
function everyUnavailableSentence(): string[] {
  return [
    ...COMPETITION_REASONS.flatMap((reason) => {
      const copy = describeCompetitionUnavailable(reason);
      return [copy.title, copy.body];
    }),
    ...PROGRESSION_REASONS.flatMap((reason) => {
      const copy = describeProgressionUnavailable(reason);
      return [copy.title, copy.body];
    }),
    STATS_VISIBILITY_NOTE,
  ];
}

describe("copy that could expire", () => {
  it("never claims the build has no sign-in", () => {
    // Both spellings that shipped: "has no sign-in yet" and "has no sign-in".
    for (const sentence of everyUnavailableSentence()) {
      expect(sentence, sentence).not.toMatch(/no sign[- ]?in/i);
      expect(sentence, sentence).not.toMatch(/this build has no/i);
    }
  });

  it("never claims nothing is uploaded, which stopped being true too", () => {
    // The third instance, already fixed before this test existed. Kept in the
    // sweep so it cannot come back.
    for (const sentence of everyUnavailableSentence()) {
      expect(sentence, sentence).not.toMatch(/nothing on this device is uploaded/i);
    }
  });
});

describe("offline identity explanations", () => {
  it("offers connection without asking the player to register", () => {
    for (const copy of [describeCompetitionUnavailable("NO_ACCOUNT"), describeProgressionUnavailable("NO_ACCOUNT")]) {
      expect(copy.body).toMatch(/connect/i);
      expect(copy.body).toMatch(/without an email or password|No email or password/i);
      expect(copy.body).not.toMatch(/guest|create an account/i);
      expect(copy.body).toMatch(/Practice.*offline/i);
    }
  });
});
