/**
 * Arc 21 — accessibility preference wiring.
 *
 * Four settings live in `AppSettings` (`reducedMotion`, `increasedContrast`,
 * `largerTableText`, `largeCardLabels`) and this module is what makes each of
 * them do something observable, per the specification's accessibility
 * acceptance criteria. Before this file, all of them were stored and read by
 * nothing — see `settings.ts` and the `UnavailableNote` that used to sit under
 * them on the Settings screen. `largeCardLabels` was the last one left in that
 * state, and it kept its note for a whole phase after the others lost theirs.
 *
 * `reducedMotion` is wired directly into `useMotion()` in `motion.ts`: the app
 * setting can only ADD reduction on top of the OS setting, never remove it, so
 * this file does not touch it.
 *
 * `increasedContrast` and `largerTableText` need a place to live that every
 * consumer can read without re-deriving it from `useSettings()` — a component
 * that subscribed to the whole settings record would re-render on every OTHER
 * preference change too (sound, notifications, ...), which is unwanted churn
 * at a table mid-hand. A small context, provided once at the root, is that
 * place.
 */

import { createContext, useContext, useMemo, type ReactNode } from "react";

import { useSettings } from "../features/settings/use-settings";
import { accessibleColors, colors } from "./tokens";
import { TABLE_TEXT_SCALE_UP } from "./type-scale";
import type { TypographyToken } from "./typography";

export interface AccessibilityPrefs {
  increasedContrast: boolean;
  largerTableText: boolean;
  /**
   * Bigger ranks and suit glyphs on the card faces.
   *
   * It belongs here rather than being read from `useSettings()` at the card,
   * for the reason in the header: a hero hand plus a dealer hand plus four
   * other seats is a dozen `PlayingCard`s, and subscribing each of them to the
   * whole settings record would re-render every card whenever the sound
   * preference changed.
   */
  largeCardLabels: boolean;
}

const DEFAULT_PREFS: AccessibilityPrefs = {
  increasedContrast: false,
  largerTableText: false,
  largeCardLabels: false,
};

const AccessibilityPrefsContext = createContext<AccessibilityPrefs>(DEFAULT_PREFS);

/**
 * Provided once, at the root layout. Falls back to `DEFAULT_PREFS` for any
 * tree rendered without it — a unit test mounting a single component, for
 * instance — so nothing has to be wrapped in this provider to render.
 */
export function AccessibilityPrefsProvider({ children }: { children: ReactNode }) {
  const { settings } = useSettings();

  const value = useMemo<AccessibilityPrefs>(
    () => ({
      increasedContrast: settings.increasedContrast,
      largerTableText: settings.largerTableText,
      largeCardLabels: settings.largeCardLabels,
    }),
    [settings.increasedContrast, settings.largerTableText, settings.largeCardLabels],
  );

  return (
    <AccessibilityPrefsContext.Provider value={value}>{children}</AccessibilityPrefsContext.Provider>
  );
}

export function useAccessibilityPrefs(): AccessibilityPrefs {
  return useContext(AccessibilityPrefsContext);
}

/**
 * A border colour for a boundary that carries meaning — a card outline, a
 * tappable surface, a slot marking where a card will land — rather than a
 * purely decorative divider.
 *
 * `colors.border` and `colors.borderStrong` measure at 1.3–1.8:1 against the
 * app's dark surfaces (see `scripts/check-contrast.ts`), well under the 3:1
 * WCAG floor for a meaningful UI graphic. That is a deliberate "hairline"
 * design choice for the default state — the surface colour underneath, not
 * the outline, is what mainly separates a card from the background. Increased
 * Contrast trades that restraint for a boundary that actually clears the bar:
 * `accessibleColors.border` is 0.4-alpha white, which check-contrast.ts
 * measures at ~3.8:1 against both `background` and `surface`.
 */
export function useBorderColor(): string {
  const { increasedContrast } = useAccessibilityPrefs();
  return increasedContrast ? accessibleColors.border : colors.border;
}

/** As `useBorderColor`, for the stronger token — same accessible value under the toggle. */
export function useBorderStrongColor(): string {
  const { increasedContrast } = useAccessibilityPrefs();
  return increasedContrast ? accessibleColors.border : colors.borderStrong;
}

/**
 * `textSecondary` already clears AA comfortably everywhere it is used (see
 * check-contrast.ts) — this is not fixing a failure, it is honouring the
 * Settings copy's own promise of "brighter secondary text" for a player who
 * asked for more separation than the default gives.
 */
export function useSecondaryTextColor(): string {
  const { increasedContrast } = useAccessibilityPrefs();
  return increasedContrast ? accessibleColors.textSecondary : colors.textSecondary;
}

export function useTableTextVariant(base: TypographyToken): TypographyToken {
  const { largerTableText } = useAccessibilityPrefs();
  return largerTableText ? TABLE_TEXT_SCALE_UP[base] : base;
}
