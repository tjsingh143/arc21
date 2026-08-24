/**
 * The Play tab's mode cards.
 *
 * The defect was an INVERSION, which is the kind a screenshot hides and a test
 * catches: the badge took its word from `availability` and its colour from
 * `playable`, and the two agreed only while the online modes were unbuilt. Once
 * they shipped, every "Online" badge rendered in the green this app reserves for
 * "needs no server at all" — on the screen whose whole job is saying which
 * modes need one.
 */

import { describe, expect, it } from "vitest";

import { modeBadge, modeNotice } from "../../src/features/home/play-mode-presentation.js";

describe("the availability badge", () => {
  it("takes its word and its colour from the same field", () => {
    expect(modeBadge("offline")).toEqual({ label: "Offline", tone: "success" });
    expect(modeBadge("online")).toEqual({ label: "Online", tone: "neutral" });
  });

  /**
   * THE REGRESSION. Stated as the thing that must never be true again rather
   * than as a restatement of the mapping above, so a future change that
   * reintroduces the crossing fails here whatever shape it takes.
   */
  it("never gives an online mode the offline colour", () => {
    expect(modeBadge("online").tone).not.toBe("success");
    expect(modeBadge("offline").tone).toBe("success");
  });

  it("does not colour an online mode as a problem", () => {
    // "Online" is a different thing, not a warning. The card's own notice
    // carries what it needs.
    expect(modeBadge("online").tone).toBe("neutral");
  });
});

describe("the notice under a mode card", () => {
  /**
   * It used to render only for an unplayable mode, so the moment every mode
   * became reachable six sentences about what each one needs were shown to
   * nobody — and a guest learned an account was wanted only after tapping.
   */
  it("still speaks when the mode is playable", () => {
    expect(modeNotice({ playable: true, reason: "Needs an account." })).toEqual({
      text: "Needs an account.",
      tone: "secondary",
    });
  });

  /** A refusal looks like a refusal; a requirement does not. */
  it("warns only when the mode cannot be opened", () => {
    expect(modeNotice({ playable: false, reason: "Not built yet." })?.tone).toBe("warning");
    expect(modeNotice({ playable: true, reason: "Not built yet." })?.tone).toBe("secondary");
  });

  it("says nothing when there is nothing to say", () => {
    expect(modeNotice({ playable: true })).toBeNull();
    expect(modeNotice({ playable: false })).toBeNull();
    expect(modeNotice({ playable: true, reason: "" })).toBeNull();
  });
});
