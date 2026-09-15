/**
 * One other player's profile.
 *
 * The parser and the presenters, asserted without a renderer — the same split
 * `betting-affordance` and `lobby-affordance` exist for. Three defects in this
 * project survived a test of the function a dead control would have called, so
 * what is asserted here is what the SCREEN will decide from, not just that the
 * RPC can be parsed.
 */

import { describe, expect, it } from "vitest";

import {
  describeHiddenRecord,
  hasRecord,
  presentPresence,
  presentRecord,
  toPlayerProfile,
  type PlayerRecord,
} from "../../src/features/friends/player-profile.js";

const ROW = {
  user_id: "11111111-1111-4111-8111-111111111111",
  username: "riverboat",
  display_name: "Riverboat",
  avatar_url: null,
  country_code: "GB",
  level: 12,
  privacy: "public" as const,
  is_friend: true,
  stats_visible: true,
  hands_played: 400,
  hands_won: 180,
  hands_pushed: 34,
  decisions_total: 350,
  decisions_optimal: 301,
  career_stars: 14,
  career_nodes_completed: 6,
  tournaments_entered: 5,
  tournament_wins: 2,
  last_seen_at: "2026-08-24T00:00:00.000Z",
};

describe("toPlayerProfile", () => {
  it("reads the row PostgREST returns for a set-returning function", () => {
    // A bare row and a one-element array are both accepted, because which one
    // arrives depends on the function's shape rather than on anything a caller
    // controls.
    for (const value of [ROW, [ROW]]) {
      const profile = toPlayerProfile(value);
      expect(profile?.username).toBe("riverboat");
      expect(profile?.level).toBe(12);
      expect(profile?.record?.careerStars).toBe(14);
      expect(profile?.record?.tournamentWins).toBe(2);
    }
  });

  /**
   * No row is the server's answer to a block in EITHER direction, to a user id
   * that never existed, and to a deleted account. All three must reach the
   * screen as the same value, or a block becomes discoverable by the person
   * blocked.
   */
  it("returns null for no row at all", () => {
    expect(toPlayerProfile(null)).toBeNull();
    expect(toPlayerProfile([])).toBeNull();
    expect(toPlayerProfile(undefined)).toBeNull();
    expect(toPlayerProfile({})).toBeNull();
  });

  /**
   * The rule the whole file exists to keep: NULL is not zero. A hidden record
   * must not arrive as a record of nothing, which is a different and untrue
   * claim about somebody.
   */
  it("keeps a hidden record null rather than turning it into zeroes", () => {
    const profile = toPlayerProfile({
      ...ROW,
      privacy: "private",
      stats_visible: false,
      hands_played: null,
      hands_won: null,
      hands_pushed: null,
      decisions_total: null,
      decisions_optimal: null,
      career_stars: null,
      career_nodes_completed: null,
      tournaments_entered: null,
      tournament_wins: null,
    });

    expect(profile).not.toBeNull();
    expect(profile?.statsVisible).toBe(false);
    expect(profile?.record).toBeNull();
    // Identity still comes back: `search_players` already discloses these three
    // for anybody not blocked, so withholding them here would conceal nothing.
    expect(profile?.displayName).toBe("Riverboat");
    expect(profile?.level).toBe(12);
  });

  /** A half-populated record would print real figures beside invented zeroes. */
  it("refuses a record that is only partly present", () => {
    const profile = toPlayerProfile({ ...ROW, career_stars: null });
    expect(profile?.record).toBeNull();
  });

  /**
   * Visibility is the SERVER's answer. Recomputing it from `privacy` and
   * `is_friend` would be a second implementation of a privacy rule, and the
   * client's copy is the one a player sees.
   */
  it("does not second-guess the server's visibility verdict", () => {
    const profile = toPlayerProfile({ ...ROW, privacy: "private", stats_visible: true });
    expect(profile?.statsVisible).toBe(true);
    expect(profile?.record?.handsPlayed).toBe(400);
  });
});

describe("presentPresence", () => {
  const now = new Date("2026-08-24T00:10:00.000Z");
  const seen = "2026-08-24T00:00:00.000Z";

  it("reports a live channel state as a live claim", () => {
    expect(presentPresence("in_game", seen, now)).toMatchObject({
      presence: "in_game",
      label: "In a game",
      live: true,
    });
    expect(presentPresence("available", seen, now)).toMatchObject({
      presence: "available",
      label: "Online",
      live: true,
    });
  });

  /**
   * Absence from the channel is not proof of being offline: a backgrounded app
   * or a bad connection looks exactly the same. So the word is "Offline", the
   * claim is not marked live, and the sentence beside it says why.
   */
  it("says offline without pretending to know", () => {
    const off = presentPresence(undefined, seen, now);
    expect(off.presence).toBe("offline");
    expect(off.live).toBe(false);
    expect(off.detail).toContain("Last seen 10 minutes ago");
    expect(off.detail).toContain("poor one shows as offline");
  });

  it("carries the last-seen line even when the channel is live", () => {
    expect(presentPresence("available", seen, now).detail).toContain("Last seen 10 minutes ago");
  });
});

describe("the record as rows", () => {
  const full: PlayerRecord = {
    handsPlayed: 400,
    handsWon: 180,
    handsPushed: 34,
    decisionsTotal: 350,
    decisionsOptimal: 301,
    careerStars: 14,
    careerNodesCompleted: 6,
    tournamentsEntered: 5,
    tournamentWins: 2,
  };

  it("renders every figure the specification names", () => {
    const rows = presentRecord(full);
    const byKey = Object.fromEntries(rows.map((row) => [row.key, row.value]));
    expect(byKey.hands).toBe("400");
    expect(byKey.stars).toBe("14 from 6 nodes");
    expect(byKey.wins).toBe("2 from 5 entered");
    expect(byKey.accuracy).toBe("86.0%");
  });

  /** Floored, so nobody is shown a figure above what they achieved. */
  it("floors accuracy rather than rounding it up", () => {
    const rows = presentRecord({ ...full, decisionsTotal: 3, decisionsOptimal: 2 });
    expect(rows.find((row) => row.key === "accuracy")?.value).toBe("66.6%");
  });

  /**
   * No graded decisions is not 0% — a player with nothing graded has no
   * accuracy, which is not the same as being wrong every time. The row is
   * omitted, the same rule Statistics follows.
   */
  it("omits accuracy when nothing has been graded", () => {
    const rows = presentRecord({ ...full, decisionsTotal: 0, decisionsOptimal: 0 });
    expect(rows.some((row) => row.key === "accuracy")).toBe(false);
  });

  it("singularises one career node", () => {
    const rows = presentRecord({ ...full, careerNodesCompleted: 1 });
    expect(rows.find((row) => row.key === "stars")?.value).toBe("14 from 1 node");
  });

  it("tells an empty record apart from a hidden one", () => {
    expect(hasRecord(full)).toBe(true);
    expect(
      hasRecord({
        handsPlayed: 0,
        handsWon: 0,
        handsPushed: 0,
        decisionsTotal: 0,
        decisionsOptimal: 0,
        careerStars: 0,
        careerNodesCompleted: 0,
        tournamentsEntered: 0,
        tournamentWins: 0,
      }),
    ).toBe(false);
  });
});

describe("describeHiddenRecord", () => {
  const base = toPlayerProfile(ROW)!;

  /**
   * Phrased as the other player's choice, never as a refusal aimed at the
   * viewer — "you may not see this" invites somebody to think they did
   * something wrong.
   */
  it("names whose setting it is", () => {
    expect(describeHiddenRecord({ ...base, privacy: "private" })).toBe(
      "Riverboat keeps their record private, so none of it is shown here.",
    );
    expect(describeHiddenRecord({ ...base, privacy: "friends", isFriend: false })).toBe(
      "Riverboat shows their record to friends only.",
    );
  });

  it("does not invent a reason the server did not give", () => {
    expect(describeHiddenRecord({ ...base, privacy: "public" })).toBe(
      "Riverboat's record is not being shown.",
    );
  });
});
