/**
 * Arc 21 — WCAG contrast audit.
 *
 * Computes the actual contrast ratio of every foreground/background pairing
 * the app renders, from `src/design/tokens.ts`, and fails on anything under
 * the bar the specification sets: 4.5:1 for body text, 3:1 for large text and
 * meaningful UI graphics (borders that carry information, e.g. a focus ring
 * or a card outline).
 *
 * This turns "meets WCAG AA" from an opinion into something that runs in the
 * test suite — see `tests/design/contrast.test.ts`, which imports the same
 * pairing list and asserts on it. This file is also runnable directly for a
 * human-readable report:
 *
 *   npx tsx scripts/check-contrast.ts
 */

import { accessibleColors, colors, cosmeticColors } from "../src/design/tokens";

// ---------------------------------------------------------------------------
// Colour maths
// ---------------------------------------------------------------------------

interface Rgb {
  r: number;
  g: number;
  b: number;
}

function parseHex(hex: string): Rgb {
  const clean = hex.replace("#", "");
  const full = clean.length === 3
    ? clean.split("").map((c) => c + c).join("")
    : clean;
  return {
    r: parseInt(full.slice(0, 2), 16),
    g: parseInt(full.slice(2, 4), 16),
    b: parseInt(full.slice(4, 6), 16),
  };
}

function parseRgba(value: string): { rgb: Rgb; alpha: number } {
  const match = /rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)/.exec(value);
  if (!match) throw new Error(`Unparseable colour: ${value}`);
  return {
    rgb: { r: Number(match[1]), g: Number(match[2]), b: Number(match[3]) },
    alpha: match[4] !== undefined ? Number(match[4]) : 1,
  };
}

/** Any token colour, resolved to opaque RGB. `bg` is used to composite a translucent one. */
function resolve(color: string, bg: Rgb): Rgb {
  if (color.startsWith("#")) return parseHex(color);
  const { rgb, alpha } = parseRgba(color);
  return {
    r: rgb.r * alpha + bg.r * (1 - alpha),
    g: rgb.g * alpha + bg.g * (1 - alpha),
    b: rgb.b * alpha + bg.b * (1 - alpha),
  };
}

/** WCAG relative luminance. */
function relativeLuminance({ r, g, b }: Rgb): number {
  const channel = (c: number) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

/** WCAG contrast ratio, always >= 1. */
export function contrastRatio(fgToken: string, bgToken: string): number {
  const bgRgb = resolve(bgToken, { r: 0, g: 0, b: 0 });
  const fgRgb = resolve(fgToken, bgRgb);
  const l1 = relativeLuminance(fgRgb);
  const l2 = relativeLuminance(bgRgb);
  const lighter = Math.max(l1, l2);
  const darker = Math.min(l1, l2);
  return (lighter + 0.05) / (darker + 0.05);
}

// ---------------------------------------------------------------------------
// The pairings the app actually renders
// ---------------------------------------------------------------------------

export type ContrastKind = "body" | "large" | "graphic";

export interface ContrastPairing {
  name: string;
  fg: string;
  bg: string;
  kind: ContrastKind;
}

const BACKGROUNDS: Record<string, string> = {
  background: colors.background,
  surface: colors.surface,
  surfaceRaised: colors.surfaceRaised,
  surfaceSoft: colors.surfaceSoft,
};

const BODY_TEXT_TOKENS: Record<string, string> = {
  textPrimary: colors.textPrimary,
  textSecondary: colors.textSecondary,
  warning: colors.warning,
  danger: colors.danger,
  info: colors.info,
  success: colors.success,
};

/**
 * Every text colour actually used against every surface it can actually sit
 * on. `textDisabled` is excluded from the body-text pairings and checked
 * separately at the lower "large text / meaningful graphic" bar — disabled
 * content is explicitly exempt from AA in the spec WCAG defers to (1.4.3
 * Exception 2 covers "inactive user interface components"), but this project
 * still wants it legible, just not to the same bar as active text.
 */
const pairings: ContrastPairing[] = [];

for (const [bgName, bg] of Object.entries(BACKGROUNDS)) {
  for (const [fgName, fg] of Object.entries(BODY_TEXT_TOKENS)) {
    pairings.push({ name: `${fgName} on ${bgName}`, fg, bg, kind: "body" });
  }
  pairings.push({ name: `textDisabled on ${bgName}`, fg: colors.textDisabled, bg, kind: "large" });
}

// Card faces: rank/suit ink on the physical card, not the app background.
pairings.push({ name: "cardInk on cardFace", fg: colors.cardInk, bg: colors.cardFace, kind: "body" });
pairings.push({ name: "cardRed on cardFace", fg: colors.cardRed, bg: colors.cardFace, kind: "body" });

// Button labels: the label colour against the button's own fill, not the screen.
pairings.push({ name: "cardInk on accent (primary button label)", fg: colors.cardInk, bg: colors.accent, kind: "body" });
pairings.push({ name: "textPrimary on surfaceRaised (secondary button label)", fg: colors.textPrimary, bg: colors.surfaceRaised, kind: "body" });
pairings.push({ name: "danger on background (danger button label)", fg: colors.danger, bg: colors.background, kind: "body" });
pairings.push({ name: "accent on accentSoft (toggle thumb context)", fg: colors.accent, bg: colors.accentSoft, kind: "graphic" });

// Table themes: labels ("Dealer", "You", bet text) render directly over the
// equipped table surface, not inside a SurfaceCard — added by session 1.
for (const [themeName, surface] of Object.entries({
  arcGreen: cosmeticColors.arcGreenSurface,
  workshopOak: cosmeticColors.workshopOakSurface,
  skylineDusk: cosmeticColors.skylineDuskSurface,
  midnight: cosmeticColors.midnightSurface,
})) {
  pairings.push({ name: `textPrimary on ${themeName} table surface`, fg: colors.textPrimary, bg: surface, kind: "body" });
  pairings.push({ name: `textSecondary on ${themeName} table surface`, fg: colors.textSecondary, bg: surface, kind: "body" });
  pairings.push({ name: `warning on ${themeName} table surface`, fg: colors.warning, bg: surface, kind: "body" });
}

export const CONTRAST_PAIRINGS = pairings;

/**
 * `colors.border` and `colors.borderStrong` (0.10/0.18-alpha white hairlines)
 * measure at 1.3–1.8:1 against `background` and `surface` — well under the
 * 3:1 floor for a meaningful UI graphic. That is a deliberate default: the
 * design brief is "dark, understated" hairlines, and the surface colour
 * underneath a card is what actually separates it from the background, not
 * the outline. Rather than brightening the default palette (a redesign,
 * explicitly out of scope for an audit-and-fix session), the "Increased
 * contrast" accessibility setting substitutes `accessibleColors.border` for
 * these — see `src/design/accessibility.tsx`. These pairings are checked
 * separately from `CONTRAST_PAIRINGS` so a passing default-palette report
 * does not hide a boundary that never clears 3:1 in EITHER state.
 */
export const DEFERRED_TO_INCREASED_CONTRAST: ContrastPairing[] = [
  { name: "border on background (card slot outline)", fg: colors.border, bg: colors.background, kind: "graphic" },
  { name: "border on surface (card outline)", fg: colors.border, bg: colors.surface, kind: "graphic" },
  { name: "borderStrong on background", fg: colors.borderStrong, bg: colors.background, kind: "graphic" },
  { name: "borderStrong on surface", fg: colors.borderStrong, bg: colors.surface, kind: "graphic" },
];

/** The accessible substitute for each of the above, which MUST clear 3:1. */
export const INCREASED_CONTRAST_PAIRINGS: ContrastPairing[] = [
  { name: "accessibleColors.border on background (Increased contrast)", fg: accessibleColors.border, bg: colors.background, kind: "graphic" },
  { name: "accessibleColors.border on surface (Increased contrast)", fg: accessibleColors.border, bg: colors.surface, kind: "graphic" },
];

export function bar(kind: ContrastKind): number {
  return kind === "body" ? 4.5 : 3.0;
}

// ---------------------------------------------------------------------------
// CLI report
// ---------------------------------------------------------------------------

function report(pairings: ContrastPairing[]): number {
  let failures = 0;
  for (const pairing of pairings) {
    const ratio = contrastRatio(pairing.fg, pairing.bg);
    const required = bar(pairing.kind);
    const pass = ratio >= required;
    if (!pass) failures += 1;
    console.log(
      `${pass ? "PASS" : "FAIL"}  ${ratio.toFixed(2)}:1  (needs ${required}:1, ${pairing.kind})  ${pairing.name}`,
    );
  }
  return failures;
}

function main() {
  console.log("Default palette (must all pass):");
  const failures = report(CONTRAST_PAIRINGS);
  console.log(`${CONTRAST_PAIRINGS.length} pairings checked, ${failures} failing.\n`);

  console.log("Deliberately under 3:1 by default — addressed by Increased contrast, not fixed here:");
  report(DEFERRED_TO_INCREASED_CONTRAST);

  console.log("\nIncreased contrast substitutes (must all pass):");
  const accessibleFailures = report(INCREASED_CONTRAST_PAIRINGS);
  console.log(`${INCREASED_CONTRAST_PAIRINGS.length} pairings checked, ${accessibleFailures} failing.`);

  if (failures > 0 || accessibleFailures > 0) process.exitCode = 1;
}

if (require.main === module) main();
