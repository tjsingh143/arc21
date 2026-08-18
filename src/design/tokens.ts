/**
 * Arc 21 — design tokens.
 *
 * Dark, understated, original. Not a casino: no green felt default, no
 * gold-rimmed buttons, no neon, no flashing currency.
 *
 * These are the whole palette. Components read from here rather than writing
 * literal colours, so a theme change is one edit and contrast can be audited in
 * one place.
 */

export const colors = {
  background: "#0B0D10",
  surface: "#151A20",
  surfaceRaised: "#1E252D",
  surfaceSoft: "#252D36",

  textPrimary: "#F5F3EE",
  textSecondary: "#A5ADB7",
  textDisabled: "#6B737D",

  accent: "#F0B36A",
  accentSoft: "#5A4630",

  info: "#79C2FF",
  success: "#7ED6A7",
  warning: "#F2C96D",
  danger: "#F07B78",

  cardFace: "#F8F6F1",
  cardInk: "#15171A",
  cardRed: "#C84D55",

  border: "rgba(255,255,255,0.10)",
  borderStrong: "rgba(255,255,255,0.18)",

  /** Scrim behind bottom sheets and confirmation dialogs. */
  scrim: "rgba(0,0,0,0.6)",
} as const;

export type ColorToken = keyof typeof colors;

/** 4-point spacing scale. Use these, not arbitrary numbers. */
export const spacing = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24,
  xxl: 32,
  xxxl: 40,
} as const;

export const radius = {
  small: 12,
  card: 18,
  sheet: 24,
  /** Pill — clamp to half the height at the call site. */
  pill: 999,
} as const;

/**
 * Minimum interactive target. Every button, chip and tappable row must meet
 * this, including when a label is short.
 */
export const MIN_TOUCH_TARGET = 48;

export const layout = {
  minTouchTarget: MIN_TOUCH_TARGET,
  /** Table content stays readable rather than stretching on tablets. */
  maxTableWidth: 560,
  screenPadding: spacing.lg,
} as const;

/**
 * Playing card proportions. 5:7 is close to a real card (2.5" × 3.5") and keeps
 * ranks legible at the compact sizes used for other players' seats.
 */
export const cardAspectRatio = 5 / 7;

export const cardSizes = {
  /** The current player's hand — the visual priority of the table. */
  hero: { width: 92, height: 92 / cardAspectRatio },
  /** Dealer and split-hand previews. */
  medium: { width: 68, height: 68 / cardAspectRatio },
  /** Other seats at a multiplayer table. */
  compact: { width: 40, height: 40 / cardAspectRatio },
} as const;

export type CardSize = keyof typeof cardSizes;
