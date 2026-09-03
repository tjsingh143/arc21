/**
 * The privacy note may not claim more than the server enforces.
 *
 * THE DEFECT, measured against the running stack in phase 10. `statsVisibility`
 * is carried to `public.profiles.privacy` and enforced there, and it does three
 * things:
 *
 *   1. `profiles_select_visible` refuses the row to a stranger outright;
 *   2. `player_public_profile` answers `stats_visible = false` and returns every
 *      statistic as NULL rather than zero;
 *   3. …and that is all it does.
 *
 * It does NOT take the player off the leaderboards, and it does NOT hide them
 * from `search_players`. Both were measured on a fresh second account: a
 * `private` profile with 4,242 weekly XP came back on `leaderboard_weekly_xp`
 * under its display name, and came back from `search_players` on a six-character
 * prefix of its handle.
 *
 * Neither is a bug. The specification's leaderboard section asks for a global
 * board carrying "avatar, display name, value" and forbids only exposing "a
 * private email or account identifier"; friend search is specified as "search
 * exact or partial username", and a player who cannot be found cannot be sent a
 * friend request. The sentence was the thing that was wrong, and the word doing
 * the damage was "standings" — a leaderboard placement is exactly a standing.
 *
 * This is the third instance of the same failure in this repository, and the
 * second one inside this very string's neighbourhood: `tests/stats/expired-copy.test.ts`
 * exists because two "requires an account" states went on claiming the build had
 * no sign-in for a whole phase. Its header quotes this file's subject — "a
 * privacy note is the single worst place in a product for a sentence that has
 * quietly expired" — which is why this one gets a guard rather than a fix alone.
 */

import { describe, expect, it } from "vitest";

import {
  DEFAULT_SETTINGS,
  STATS_VISIBILITY_LABELS,
  STATS_VISIBILITY_NOTE,
  type StatsVisibility,
} from "../../src/features/settings/settings.js";
import { profilePrivacyFor } from "../../src/features/settings/profile-privacy.js";

describe("the statistics-visibility note", () => {
  it("does not claim to control standings, which it has never controlled", () => {
    expect(STATS_VISIBILITY_NOTE).not.toMatch(/standings/i);
  });

  it("says out loud what the setting leaves visible", () => {
    // A control that does less than a player expects has to say so on the same
    // screen, not in a policy document they will not open.
    expect(STATS_VISIBILITY_NOTE).toMatch(/leaderboards/i);
    expect(STATS_VISIBILITY_NOTE).toMatch(/search/i);
  });

  it("still names what it DOES control, so it is not merely a disclaimer", () => {
    expect(STATS_VISIBILITY_NOTE).toMatch(/statistics/i);
    expect(STATS_VISIBILITY_NOTE).toMatch(/profile/i);
  });

  it("keeps the two claims it can keep", () => {
    // Practice really is local, and the setting really is sent to the server.
    expect(STATS_VISIBILITY_NOTE).toMatch(/practice/i);
    expect(STATS_VISIBILITY_NOTE).toMatch(/signed in/i);
  });

  it("has not re-acquired the expired sentences the sweep already banned", () => {
    expect(STATS_VISIBILITY_NOTE).not.toMatch(/no sign[- ]?in/i);
    expect(STATS_VISIBILITY_NOTE).not.toMatch(/this build has no/i);
  });
});

describe("the setting behind the note", () => {
  it("still defaults to the most private option", () => {
    // The quietest configuration is the one a player gets without touching
    // anything. If this ever flips, the note above is describing the wrong
    // default as well as the wrong scope.
    expect(DEFAULT_SETTINGS.statsVisibility).toBe("private");
  });

  it("maps each label onto the column value that enforces it", () => {
    const expected: Record<StatsVisibility, string> = {
      public: "public",
      friends: "friends",
      private: "private",
    };
    for (const visibility of Object.keys(STATS_VISIBILITY_LABELS) as StatsVisibility[]) {
      expect(profilePrivacyFor(visibility)).toBe(expected[visibility]);
    }
  });
});
