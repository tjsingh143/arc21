/**
 * Refresh D — Home and Play render the hierarchy, rather than restating it.
 *
 * React Native cannot be rendered under this suite (`typography.ts` calls
 * `Platform.select` at module load), so the ORDER and the CLAIMS are proven
 * against `product-hierarchy.ts` in `product-hierarchy.test.ts`, and this file
 * proves the two screens actually render from it — a screen that kept a private
 * list of its own would pass every model test while showing something else.
 * What a device shows is proven by `tests/e2e/home-hierarchy.yaml`.
 *
 * It also holds the anchors that native flows select on, because a renamed
 * testID fails a flow that nobody may run for a phase.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const read = (path: string) => readFileSync(join(process.cwd(), path), "utf8");
const HOME = read("app/(tabs)/home.tsx");
const PLAY = read("app/(tabs)/play.tsx");
const LOBBY = read("app/table/lobby.tsx");
const CARD = read("src/components/ui/Card.tsx");

/** A `SurfaceCard` with its own `onPress` — the shape that nests a pressable around a Button. */
const PRESSABLE_CARD = /<SurfaceCard\b[^>]*?\bonPress=/;

describe("the Play tab", () => {
  it("renders the shared sections, and keeps no mode list of its own", () => {
    expect(PLAY).toMatch(/PLAY_SECTIONS\.map\(/);
    expect(PLAY).toMatch(/PLAY_MODES\[/);
    expect(PLAY).not.toMatch(/\bconst MODES\b/);
  });

  it("tells a screen reader the badge and the facts line it shows", () => {
    expect(PLAY).toMatch(/modeAccessibilityLabel\(\{[^}]*availability:[^}]*\bfacts\b/s);
    expect(PLAY).toMatch(/modeFacts\(/);
  });

  it("states why online modes cannot open, when they cannot", () => {
    expect(PLAY).toMatch(/onlineAvailability\(/);
  });

  it("reads an unanswered bootstrap as the server not answering, as Home does", () => {
    for (const screen of [PLAY, HOME]) {
      expect(screen).toMatch(/serverUnreached:\s*bootstrapFailure\?\.code === "NETWORK"/);
    }
  });

  it("keeps the anchors the native flows select on", () => {
    for (const anchor of ['testID="play-resume-card"', 'testID="play-resume"', "Same rules everywhere."]) {
      expect(PLAY).toContain(anchor);
    }
  });
});

describe("Home", () => {
  it("renders the blocks the layout returns, in the order it returns them", () => {
    expect(HOME).toMatch(/homeLayout\(\{/);
    expect(HOME).toMatch(/\bblocks\.map\(renderBlock\)/);
    expect(HOME).toMatch(/homeResume\(/);
    expect(HOME).toMatch(/onlineAvailability\(/);
  });

  it("orders its chip block: other people, then solo Quick Play", () => {
    const publicTable = HOME.indexOf('testID="home-public-table"');
    const privateTable = HOME.indexOf('testID="home-private-table"');
    const quickPlay = HOME.indexOf('testID="home-quick-play"');
    expect(publicTable).toBeGreaterThan(-1);
    expect(privateTable).toBeGreaterThan(publicTable);
    expect(quickPlay).toBeGreaterThan(privateTable);
  });

  /**
   * A pressable card wrapping a Button gives one action two overlapping touch
   * targets, and on Android two focusable elements — while on iOS the card's
   * label hides the Button entirely. Home's cards are inert containers whose
   * Button is the one control, which is the shape the Play resume card already
   * documents.
   */
  it("has no pressable card wrapped around its own button", () => {
    expect(HOME).not.toMatch(PRESSABLE_CARD);
    // Positive control for the pattern.
    expect('<SurfaceCard\n  testID="x"\n  onPress={() => go()}>').toMatch(PRESSABLE_CARD);
  });

  it("keeps the anchors the native flows select on", () => {
    for (const anchor of [
      'testID="home-screen"',
      'testID="home-practice"',
      "Blackjack, without the noise.",
    ]) {
      expect(HOME).toContain(anchor);
    }
  });
});

/**
 * The lobby said "Unranked. Hands here do not count towards leaderboards"
 * while private hands earn XP and the weekly XP board sums it. Its line now
 * comes from the same `recording` field as the Play card's facts line.
 */
describe("the private table lobby", () => {
  it("states what its hands count toward from the shared model", () => {
    expect(LOBBY).toMatch(/recordingSentence\(PLAY_MODES\["private-table"\]\)/);
    expect(LOBBY).not.toMatch(/do not count towards leaderboards/);
    expect(LOBBY).not.toMatch(/>\s*Unranked\./);
  });
});

/**
 * At the largest text sizes the badge squeezed each Play title to a sliver and
 * the half-width link tiles did the same to theirs: "Publi / c / Table",
 * "Lear / n", "Chall / enge" on the iPhone 17e. Both reflow from the shared
 * predicate, and both titles stop growing at the measured cap
 * (`tests/design/font-scale-stacking.test.ts`).
 */
describe("at accessibility text sizes", () => {
  it("stacks the Play card's badge under its title rather than beside it", () => {
    expect(PLAY).toMatch(/rowStacksAtFontScale\(fontScale\)/);
    expect(PLAY).toMatch(/styles\.cardHeader,\s*stacked \? styles\.cardHeaderStacked/);
    expect(PLAY).toMatch(/cardHeaderStacked:\s*\{[^}]*flexDirection:\s*"column"/);
  });

  it("caps the Play card's title and the link tile's title at the measured scale", () => {
    expect(PLAY).toMatch(/variant="sectionTitle"[^>]*maxFontSizeMultiplier=\{MAX_TITLE_FONT_SCALE\}/s);
    expect(CARD).toMatch(/variant="bodyStrong"[^>]*maxFontSizeMultiplier=\{MAX_TITLE_FONT_SCALE\}/s);
  });

  it("stacks the career card's star count under its chapter on Home", () => {
    // Walked at AX5 on the 17e: "FOUNDATIONS0/", the badge run into the
    // overline and cut off at the card's edge.
    expect(HOME).toMatch(/styles\.cardHeader,\s*stackHeaders \? styles\.cardHeaderStacked/);
    expect(HOME).toMatch(/cardHeaderStacked:\s*\{[^}]*flexDirection:\s*"column"/);
    expect(HOME).toMatch(/const stackHeaders = rowStacksAtFontScale\(fontScale\)/);
  });

  it("gives every link tile a row of its own, on Home and on Play", () => {
    expect(HOME).toMatch(/rowStacksAtFontScale\(fontScale\)/);
    expect(HOME).toMatch(/inRows\(links, stacked \? 1 : 2\)/);
    expect(PLAY).toMatch(/inRows\(PLAY_SUPPORT_LINKS, stacked \? 1 : 2\)/);
  });
});
