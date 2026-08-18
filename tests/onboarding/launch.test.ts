/**
 * The launch decision.
 *
 * `app/index.tsx` renders exactly what this returns, so every combination of
 * (flag read / not read / absent) is pinned here. The property that matters
 * most is the one a renderer test would struggle to express: while the flag is
 * still loading the answer is neither destination — showing the tabs
 * optimistically would flash the app at someone who has not seen the 18+
 * disclosure yet, and showing onboarding optimistically would flash an
 * introduction at a returning player on every cold start.
 */

import { describe, expect, it } from "vitest";

import {
  APP_HOME_HREF,
  decideLaunchDestination,
  ONBOARDING_HREF,
} from "../../src/features/onboarding/launch.js";
import {
  buildCompletion,
  type OnboardingCompletion,
} from "../../src/features/onboarding/onboarding-flag.js";

const COMPLETED: OnboardingCompletion = buildCompletion("guest", new Date("2026-08-13T12:00:00Z"));

describe("decideLaunchDestination", () => {
  it("renders neither destination while the flag is still loading", () => {
    expect(decideLaunchDestination({ hydrated: false, completion: null })).toEqual({
      kind: "pending",
    });
  });

  it("stays pending even if a completion is already in hand", () => {
    // Defensive: `hydrated` is the only signal that the read has settled. A
    // completion arriving first would mean the store set it out of order, and
    // the gate must not start guessing on the strength of that.
    expect(decideLaunchDestination({ hydrated: false, completion: COMPLETED })).toEqual({
      kind: "pending",
    });
  });

  it("shows onboarding when the flag is absent", () => {
    expect(decideLaunchDestination({ hydrated: true, completion: null })).toEqual({
      kind: "onboarding",
      href: ONBOARDING_HREF,
    });
  });

  it("goes straight to the app when the flag is set", () => {
    expect(decideLaunchDestination({ hydrated: true, completion: COMPLETED })).toEqual({
      kind: "app",
      href: APP_HOME_HREF,
    });
  });

  it("uses the paths recorded in docs/ROUTES.md", () => {
    // These strings are a contract with every other screen in the app; a typo
    // here is a route that silently does not exist.
    expect(ONBOARDING_HREF).toBe("/(onboarding)/welcome");
    expect(APP_HOME_HREF).toBe("/(tabs)/home");
  });
});
