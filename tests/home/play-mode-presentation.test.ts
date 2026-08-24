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

import {
  modeAccessibilityHint,
  modeAccessibilityLabel,
  modeBadge,
  modeNotice,
} from "../../src/features/home/play-mode-presentation.js";

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

/**
 * What a screen reader is told.
 *
 * `SurfaceCard` is a plain View without `onPress` and a labelled `Pressable`
 * with one, and on iOS a labelled element REPLACES its children in the tree. So
 * the moment every mode on the Play tab became reachable, every card became a
 * labelled Pressable and a screen reader started hearing ONE WORD — the title —
 * where a sighted player reads four lines. Found because an audit-flow assertion
 * on ".*Needs an account.*" stopped matching, which is the only reason anybody
 * looked.
 *
 * A hint cannot fix it: hints are supplementary, spoken last, suppressed when
 * the user turns them off, and are not part of an element's matchable text.
 */
describe("what a screen reader hears", () => {
  const QUICK = {
    title: "Quick Play",
    purpose: "A standard table using your global chip balance.",
    structure: "Casual, Standard or High stakes",
    playable: true,
    reason: "Needs an account so chips are server-authoritative.",
  };

  it("announces everything the card renders, in the order it renders it", () => {
    expect(modeAccessibilityLabel(QUICK)).toBe(
      "Quick Play. A standard table using your global chip balance. " +
        "Casual, Standard or High stakes. Needs an account so chips are server-authoritative.",
    );
  });

  /**
   * THE REGRESSION, stated as the four things that must never go missing again
   * rather than as the exact string, so a reworded card still fails only if it
   * actually drops something.
   */
  it("never drops the stakes, the structure or the requirement", () => {
    const spoken = modeAccessibilityLabel(QUICK);
    expect(spoken).toContain("Quick Play");
    expect(spoken).toContain("global chip balance");
    expect(spoken).toContain("Casual, Standard or High stakes");
    expect(spoken).toContain("Needs an account");
  });

  it("does not invent a requirement where there is none", () => {
    const offline = modeAccessibilityLabel({
      title: "Practice",
      purpose: "Play as long as you like with disposable chips.",
      structure: "Unlimited hands · resettable bankroll",
      playable: true,
    });
    expect(offline).toBe(
      "Practice. Play as long as you like with disposable chips. " +
        "Unlimited hands · resettable bankroll.",
    );
  });

  /** A screen reader pauses on a full stop; without one the parts run together. */
  it("separates the parts so they are not spoken as one word", () => {
    expect(modeAccessibilityLabel(QUICK)).not.toMatch(/[a-z][A-Z]/);
  });

  /**
   * The hint answers "what will this do?" and nothing a player needs in order to
   * CHOOSE belongs in it — that is the label's job, and putting it in the hint
   * is what hid it.
   */
  it("keeps the hint about the action", () => {
    expect(modeAccessibilityHint({ playable: true })).toBe("Opens this mode");
    expect(modeAccessibilityHint({ playable: false })).toBe("Not available in this build");
  });
});
