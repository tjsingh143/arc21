/**
 * The mapping from a stored preference to the column that enforces it.
 *
 * `StatsVisibility` and `public.profile_privacy` have the same three members
 * because they describe the same thing, and the temptation is to cast between
 * them. This asserts the mapping instead, so that adding a member to either
 * side is a failure rather than a silent widening.
 *
 * The write itself is proved against the real database in
 * `tests/server/profile-privacy.integration.test.ts` — a column grant is not
 * something a unit test can verify.
 */

import { describe, expect, it } from "vitest";

import { profilePrivacyFor, syncProfilePrivacy } from "../../src/features/settings/profile-privacy.js";
import { DEFAULT_SETTINGS, type StatsVisibility } from "../../src/features/settings/settings.js";

const ALL: StatsVisibility[] = ["public", "friends", "private"];

describe("visibility maps onto the profile_privacy enum", () => {
  it("maps every member, and only onto members the column accepts", () => {
    expect(ALL.map(profilePrivacyFor)).toEqual(["public", "friends", "private"]);
  });

  it("covers every value the settings schema will accept", () => {
    // If `StatsVisibility` gains a member, this array and the switch in
    // `profilePrivacyFor` both have to be updated — the switch stops
    // compiling, and this stops passing.
    for (const visibility of ALL) {
      expect(() => profilePrivacyFor(visibility)).not.toThrow();
    }
  });
});

describe("the local default is the one that most needed syncing", () => {
  it("defaults to private locally, while the column defaults to public", () => {
    /*
     * This is the whole reason the sync exists at root rather than only in the
     * Settings screen. A player who never opens Settings holds "private" here
     * and `public` on the server, so the people most likely to care were the
     * ones least likely to be protected.
     */
    expect(DEFAULT_SETTINGS.statsVisibility).toBe("private");
    expect(profilePrivacyFor(DEFAULT_SETTINGS.statsVisibility)).toBe("private");
  });
});

describe("syncing without a server", () => {
  it("skips rather than failing when Supabase is not configured", async () => {
    // The repository ships with no `.env.local`, so this is the shipped path:
    // a preference write must never turn into an error on a build with no
    // server, and must never block the local write that already succeeded.
    const outcome = await syncProfilePrivacy("private");
    expect(outcome.status).toBe("skipped");
    if (outcome.status === "skipped") {
      expect(outcome.reason).toBe("not-configured");
    }
  });
});
