/**
 * Arc 21 — motion.
 *
 * Animation is short, physical, informational and interruptible. It never
 * blocks game truth: if a transition is cut short by navigation, backgrounding
 * or a reconnect, the authoritative final state is rendered immediately.
 *
 * Every duration here is halved-or-removed under Reduce Motion. Use
 * `useMotion()` rather than reading `durations` directly in a component.
 */

import { useMemo } from "react";
import { AccessibilityInfo } from "react-native";
import { useEffect, useState } from "react";
import { Easing } from "react-native-reanimated";

import { useSettings } from "../features/settings/use-settings";
import { durations } from "./motion-timing";

// Defined in `motion-timing.ts`, which has no React Native or Reanimated
// import, so the benchmark and unit tests can read the timing budget. See that
// file's own comment.
export { durations, type DurationToken } from "./motion-timing";

export const easings = {
  /** Cards and chips settling — decelerating, physical. */
  settle: Easing.bezier(0.22, 1, 0.36, 1),
  /** Symmetric, for opacity and colour crossfades. */
  fade: Easing.bezier(0.4, 0, 0.2, 1),
} as const;

export const springs = {
  /** Bottom sheets — native-feeling, no overshoot wobble. */
  sheet: { damping: 22, stiffness: 220, mass: 0.9 },
  card: { damping: 18, stiffness: 260, mass: 0.8 },
} as const;

/** Tracks the OS Reduce Motion setting and keeps it current. */
export function useReduceMotion(): boolean {
  const [reduceMotion, setReduceMotion] = useState(false);

  useEffect(() => {
    let cancelled = false;

    AccessibilityInfo.isReduceMotionEnabled()
      .then((enabled) => {
        if (!cancelled) setReduceMotion(enabled);
      })
      .catch(() => {
        // Preference unavailable on this platform; full motion is the default.
      });

    const subscription = AccessibilityInfo.addEventListener(
      "reduceMotionChanged",
      (enabled) => setReduceMotion(enabled),
    );

    return () => {
      cancelled = true;
      subscription.remove();
    };
  }, []);

  return reduceMotion;
}

export interface Motion {
  reduceMotion: boolean;
  /** Duration in ms, collapsed to a short crossfade under Reduce Motion. */
  duration: (token: keyof typeof durations) => number;
  /** Per-card stagger; zero under Reduce Motion so cards appear together. */
  stagger: (index: number) => number;
}

/**
 * Under Reduce Motion, travel animations become short crossfades and stagger
 * disappears. Result holds are shortened but never removed — the player still
 * needs time to read the outcome.
 *
 * Two sources feed this: the OS setting (`useReduceMotion`, above) and the
 * app-level "Always reduce motion" toggle in `AppSettings`. They are ORed
 * together, never one replacing the other — the app setting can only ADD
 * reduction on top of what the OS already asks for, so turning it off never
 * un-reduces motion the OS is asking to reduce.
 */
export function useMotion(): Motion {
  const osReduceMotion = useReduceMotion();
  const appReduceMotion = useSettings().settings.reducedMotion;
  const reduceMotion = osReduceMotion || appReduceMotion;

  return useMemo<Motion>(
    () => ({
      reduceMotion,
      duration: (token) => {
        const base = durations[token];
        if (!reduceMotion) return base;
        if (token === "resultHold" || token === "feedbackHold") {
          return Math.round(base * 0.75);
        }
        return 120;
      },
      stagger: (index) => (reduceMotion ? 0 : index * durations.cardStagger),
    }),
    [reduceMotion],
  );
}
