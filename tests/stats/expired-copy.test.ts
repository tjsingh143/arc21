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

describe("the account-shaped refusals", () => {
  it("name the thing a player can do about it", () => {
    /*
     * "A control that refuses must name something the player can do." Both of
     * these refuse for a reason the player can fix in about a minute, and
     * neither used to say so.
     */
    expect(describeCompetitionUnavailable("NO_ACCOUNT").body).toMatch(/create an account/i);
    expect(describeProgressionUnavailable("NO_ACCOUNT").body).toMatch(/create an account/i);
  });

  it("still refuse to invent a record of zero", () => {
    // The reason these states exist at all. A zero is a value, and a value
    // nobody earned asserts the app is keeping score of something it is not.
    expect(describeCompetitionUnavailable("NO_ACCOUNT").body).toMatch(/not a record of zero/i);
    expect(describeProgressionUnavailable("NO_ACCOUNT").body).toMatch(/inventing one/i);
  });

  it("says guest, which is what the player actually is", () => {
    expect(describeCompetitionUnavailable("NO_ACCOUNT").body).toMatch(/guest/i);
    expect(describeProgressionUnavailable("NO_ACCOUNT").body).toMatch(/guest/i);
  });
});
