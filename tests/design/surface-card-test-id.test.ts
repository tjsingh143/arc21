/**
 * `SurfaceCard` must stay addressable in BOTH of its shapes.
 *
 * THE DEFECT this guards, found in phase 4 while adding the resume card:
 * `SurfaceCard` renders a plain `View` when it is given no `onPress`, and that
 * branch did not forward `testID`. So `app/table/[gameId].tsx` had carried
 * `<SurfaceCard testID="table-advice">` since the advice panel shipped — an id
 * present in the source, absent from the tree, and a selector for it would have
 * failed while looking like a broken screen.
 *
 * The inert shape is not an edge case, it is the CORRECT shape for a card whose
 * control is a Button inside it: a labelled `Pressable` replaces the text of
 * everything within it in the iOS accessibility tree, which has cost this
 * project three surfaces (the Home card, the accessibility switches, both
 * Practice sheets). So the shape that avoids that trap must not fall into the
 * other one.
 *
 * ── WHAT THIS TEST PROVES, AND WHAT IT DOES NOT ─────────────────────────────
 *
 * It reads the source. It cannot render `SurfaceCard` — `react-native` fails to
 * parse under Node with "Flow is not supported", which is the wall four modules
 * in `src/design` already exist to sit on the other side of — so it proves the
 * prop is FORWARDED, not that the tree contains it. Asserting the rendered
 * result is a Maestro job, and `play-resume` is now on screen for one.
 *
 * That limit is worth stating plainly rather than letting a green tick imply
 * more than it earned. The same caveat `no-write-path.test.ts` carries.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const CARD = fileURLToPath(new URL("../../src/components/ui/Card.tsx", import.meta.url));
const source = readFileSync(CARD, "utf8");

/** Everything from the `if (!onPress)` guard to the closing brace of its block. */
function inertBranch(): string {
  const start = source.indexOf("if (!onPress) {");
  expect(start, "the inert branch has been renamed or removed").toBeGreaterThan(-1);
  const end = source.indexOf("return (\n    <Pressable", start);
  expect(end, "the pressable branch has been renamed or removed").toBeGreaterThan(start);
  return source.slice(start, end);
}

describe("the source this test reads", () => {
  it("was actually found", () => {
    // The phase 2 anti-fake sweep reported nine directories clean before it had
    // scanned a single file. A scan states what it scanned.
    expect(source.length).toBeGreaterThan(500);
    expect(source).toContain("export function SurfaceCard");
  });
});

describe("an inert SurfaceCard", () => {
  it("forwards testID to the View it renders", () => {
    expect(inertBranch()).toMatch(/<View\b[\s\S]*?testID=\{testID\}/);
  });

  it("is still a View rather than a Pressable, which is the point of it", () => {
    // If this ever becomes a Pressable, every label inside every inert card
    // collapses into one accessibility node.
    expect(inertBranch()).toContain("<View");
    expect(inertBranch()).not.toContain("<Pressable");
  });
});

describe("a pressable SurfaceCard", () => {
  it("still forwards testID too", () => {
    expect(source.slice(source.indexOf("<Pressable"))).toMatch(/testID=\{testID\}/);
  });
});
