/**
 * What the Profile screen says you are called.
 *
 * It said your EMAIL ADDRESS. `summariseProfile` was given
 * `session.account.email` as the display name, so the largest type on the
 * screen — the one a screenshot shares — was an email. The profile row carries
 * `display_name` and `username`, both server-normalised and both put through
 * the reserved-name and profanity filter, and the specification's hierarchy is
 * "Avatar / Display name / @username".
 *
 * These are the boundaries that decide whether a number or a name appears at
 * all. The screen's whole discipline is that nothing is shown unless somebody
 * earned it, so "not read yet" must never render as zero.
 */

import { describe, expect, it } from "vitest";

import {
  competitionState,
  describeCompetitionUnavailable,
} from "../../src/features/stats/competition.js";
import { profileIdentity, summariseProfile } from "../../src/features/stats/profile.js";

const NO_STATS = {
  handsPlayed: 0,
  decisions: 0,
  correct: 0,
  unaidedDecisions: 0,
  unaidedCorrect: 0,
} as never;

describe("who the profile says you are", () => {
  it("shows the display name and the handle, never an email", () => {
    const identity = profileIdentity({
      hasAccount: true,
      displayName: "Wren",
      username: "wren_plays",
    });

    expect(identity.displayName).toBe("Wren");
    expect(identity.detail).toBe("@wren_plays");
    // The specific regression: an address must not reach either line.
    expect(`${identity.displayName} ${identity.detail}`).not.toMatch(/@[^ ]+\.[a-z]{2,}/i);
  });

  it("falls back to a plain sentence when the handle has not been read", () => {
    // Not "@undefined", and not a blank line where the handle belongs.
    const identity = profileIdentity({ hasAccount: true, displayName: "Wren", username: null });
    expect(identity.detail).toBe("Signed in to Arc 21.");
  });

  it("is a guest when there is no account, whatever else it was handed", () => {
    const identity = profileIdentity({
      hasAccount: false,
      displayName: "Wren",
      username: "wren_plays",
    });
    expect(identity.kind).toBe("guest");
  });

  it("is a guest when the account has no readable display name", () => {
    expect(profileIdentity({ hasAccount: true, displayName: "   " }).kind).toBe("guest");
  });
});

describe("tournament wins on the profile", () => {
  it("is null until the server has been read, so the screen can show a dash", () => {
    const summary = summariseProfile({
      stats: NO_STATS,
      careerStars: { earned: 0, available: 54 },
      hasAccount: true,
      displayName: "Wren",
      username: "wren_plays",
    });
    // A zero is a value. "You have won no tournaments" and "we have not looked"
    // are different statements, and only one of them is true here.
    expect(summary.headline.tournamentWins).toBeNull();
  });

  it("shows a real zero once the server has actually said zero", () => {
    const summary = summariseProfile({
      stats: NO_STATS,
      careerStars: { earned: 0, available: 54 },
      hasAccount: true,
      displayName: "Wren",
      tournamentWins: 0,
    });
    expect(summary.headline.tournamentWins).toBe(0);
  });
});

describe("the Competition section's state", () => {
  it("no longer tells a signed-in player they need an account", () => {
    /*
     * The defect, as a test. `app/stats/index.tsx` called
     * `competitionState({ hasAccount: false, online: false })` with both values
     * written as literals, so this branch was the ONLY one reachable.
     */
    const guest = competitionState({ hasAccount: false, online: true });
    expect(guest).toEqual({ status: "unavailable", reason: "NO_ACCOUNT" });
    expect(describeCompetitionUnavailable("NO_ACCOUNT").title).toMatch(/account/i);

    const signedIn = competitionState({
      hasAccount: true,
      online: true,
      cached: {
        tournamentsEntered: 3,
        tournamentWins: 1,
        bestFinish: 1,
        dailyChallengesPlayed: 7,
        dailyChallengeBestRank: 12,
      },
    });
    expect(signedIn.status).toBe("ready");
  });

  it("shows a previously fetched record while offline, flagged stale", () => {
    const state = competitionState({
      hasAccount: true,
      online: false,
      cached: {
        tournamentsEntered: 1,
        tournamentWins: 0,
        bestFinish: 3,
        dailyChallengesPlayed: 2,
        dailyChallengeBestRank: 40,
      },
    });
    // A real result already fetched is still real. It is never fabricated when
    // no fetch has ever succeeded — that case is OFFLINE, below.
    expect(state).toMatchObject({ status: "ready", stale: true });
  });

  it("says offline rather than inventing an empty record", () => {
    expect(competitionState({ hasAccount: true, online: false, cached: null })).toEqual({
      status: "unavailable",
      reason: "OFFLINE",
    });
  });
});
