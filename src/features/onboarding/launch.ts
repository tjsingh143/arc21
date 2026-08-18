/**
 * Arc 21 — the launch decision.
 *
 * `app/index.tsx` renders exactly what this function returns, and holds no
 * branching logic of its own. Keeping the decision here means the rule "never
 * show a screen before the flag has actually been read" is a unit test rather
 * than a claim about a component.
 *
 * The `pending` state is load-bearing. Rendering the tabs optimistically and
 * correcting a frame later would flash the wrong screen at every first launch,
 * which is precisely the defect this separation exists to prevent.
 */

import type { OnboardingCompletion } from "./onboarding-flag.js";

/** Route contract paths — see docs/ROUTES.md. */
export const ONBOARDING_HREF = "/(onboarding)/welcome";
export const APP_HOME_HREF = "/(tabs)/home";

export type LaunchDestination =
  /** The flag has not been read yet. Render the background, and nothing else. */
  | { kind: "pending" }
  | { kind: "onboarding"; href: typeof ONBOARDING_HREF }
  | { kind: "app"; href: typeof APP_HOME_HREF };

export interface LaunchInput {
  /** True once the flag read has settled — including when it failed. */
  hydrated: boolean;
  completion: OnboardingCompletion | null;
}

export function decideLaunchDestination(input: LaunchInput): LaunchDestination {
  if (!input.hydrated) return { kind: "pending" };
  if (input.completion === null) return { kind: "onboarding", href: ONBOARDING_HREF };
  return { kind: "app", href: APP_HOME_HREF };
}
