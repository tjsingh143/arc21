/**
 * "Confirm before leaving an online table" must govern something.
 *
 * THE DEFECT. `AppSettings.confirmLeavingOnlineGame` was declared, defaulted to
 * `true`, listed in the Zod schema and written to disk on every save — and a
 * full-repository grep for its name returned three hits, all of them inside
 * `settings.ts` itself. There was no Settings row offering it and no call site
 * reading it. The stored blob looked like a working feature; nothing was.
 *
 * That is the built-but-never-connected pattern, and this instance guarded the
 * only economic command in the app a single mis-tap can fire. "Leave table"
 * sends `CASH_OUT` — it closes the seat and returns the escrowed stack — and it
 * is drawn at the top-left of the table, precisely where a thumb reaches for a
 * back button that is not there.
 *
 * ── WHAT THESE TESTS PROVE, AND WHAT THEY DO NOT ────────────────────────────
 *
 * The predicate is asserted directly. The WIRING is asserted by reading the two
 * source files, for the reason four modules in `src/design` exist: importing
 * `app/table/[gameId].tsx` here would pull in `react-native`, which does not
 * parse under Node ("Flow is not supported"). So this proves the preference is
 * read at the leave path and offered on the Settings screen — not that the
 * rendered dialog appears. Asserting the rendered result is a Maestro job.
 *
 * The same caveat `surface-card-test-id.test.ts` carries, stated for the same
 * reason: a green tick must not imply more than it earned.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  describeLeaveTableConfirmation,
  LEAVE_TABLE_CONFIRM_TITLE,
  shouldConfirmLeavingTable,
} from "../../src/features/table/leave-guard.js";
import { DEFAULT_SETTINGS } from "../../src/features/settings/settings.js";

const TABLE_SCREEN = fileURLToPath(new URL("../../app/table/[gameId].tsx", import.meta.url));
const SETTINGS_SCREEN = fileURLToPath(new URL("../../app/settings/index.tsx", import.meta.url));
const tableSource = readFileSync(TABLE_SCREEN, "utf8");
const settingsSource = readFileSync(SETTINGS_SCREEN, "utf8");

/**
 * Source with comments removed.
 *
 * The first version of the call-site count matched three `leaveTable()` and
 * failed, because one of them was inside a doc comment describing the very
 * behaviour being asserted. Counting call sites means counting CODE.
 */
function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}

describe("the sources these tests read", () => {
  it("were actually found", () => {
    // The phase 2 anti-fake sweep reported nine directories clean before it had
    // scanned a single file. A scan states what it scanned.
    expect(tableSource).toContain("function Frame(");
    expect(settingsSource).toContain('<Section title="Gameplay">');
  });
});

describe("whether leaving should ask first", () => {
  it("asks when the preference is on and the seat holds chips", () => {
    expect(shouldConfirmLeavingTable({ confirmEnabled: true, stack: 2_400 })).toBe(true);
  });

  it("does not ask when the player turned the preference off", () => {
    expect(shouldConfirmLeavingTable({ confirmEnabled: false, stack: 2_400 })).toBe(false);
  });

  it("does not ask when the seat holds nothing", () => {
    /*
     * A seat with an empty stack has nothing to lose by leaving. Confirming it
     * anyway would train people to dismiss the dialog without reading it, which
     * is how a confirmation stops being one.
     */
    expect(shouldConfirmLeavingTable({ confirmEnabled: true, stack: 0 })).toBe(false);
  });

  it("is on by default, because the safe answer is the one nobody chose", () => {
    expect(DEFAULT_SETTINGS.confirmLeavingOnlineGame).toBe(true);
    expect(
      shouldConfirmLeavingTable({
        confirmEnabled: DEFAULT_SETTINGS.confirmLeavingOnlineGame,
        stack: 500,
      }),
    ).toBe(true);
  });
});

describe("what the dialog says", () => {
  it("names the amount coming back, with separators", () => {
    expect(describeLeaveTableConfirmation(12_500)).toContain("12,500 chips");
  });

  it("states the consequence rather than only asking a question", () => {
    // "A control that refuses must name something the player can do" — the same
    // rule, applied to a control that is about to do something irreversible.
    expect(describeLeaveTableConfirmation(500)).toMatch(/seat closes/i);
    expect(describeLeaveTableConfirmation(500)).toMatch(/cannot rejoin/i);
    expect(LEAVE_TABLE_CONFIRM_TITLE).toMatch(/leave/i);
  });
});

describe("the table screen", () => {
  it("reads the preference rather than assuming it", () => {
    expect(tableSource).toContain("shouldConfirmLeavingTable");
    expect(tableSource).toContain("settings.confirmLeavingOnlineGame");
  });

  it("routes BOTH leave paths through the confirmation", () => {
    /*
     * The control and the `beforeRemove` listener are two doors to the same
     * command. `leave-guard.test.ts` documents why: the Android hardware back
     * button and a deep link that replaces the stack both remove the route
     * without anybody pressing anything, and the swipe gesture is only off
     * because `TABLE_SCREEN_OPTIONS` says so.
     *
     * So `leaveTable()` must not be called raw anywhere in this screen — every
     * call site goes through `confirmThenLeave`, which asks when it should and
     * forwards to `leaveTable()` when it should not.
     */
    const frame = withoutComments(tableSource.slice(tableSource.indexOf("function Frame(")));
    expect(frame).toContain("await confirmThenLeave()");

    // Exactly two calls, and both inside `confirmThenLeave` itself: the
    // un-confirmed path and the confirmed one.
    expect(frame.match(/\bleaveTable\(\)/g) ?? []).toHaveLength(2);
    const confirmer = frame.slice(
      frame.indexOf("const confirmThenLeave"),
      frame.indexOf("useEffect(", frame.indexOf("const confirmThenLeave")),
    );
    expect(confirmer.match(/\bleaveTable\(\)/g) ?? []).toHaveLength(2);
  });

  it("carries the negative answer on Cancel rather than relying on onDismiss", () => {
    // `onDismiss` is Android-only, and an iOS backdrop tap does not fire it. A
    // promise that never settles would leave the player unable to leave at all.
    expect(tableSource).toMatch(/style: "cancel", onPress: \(\) => resolve\(false\)/);
  });
});

describe("the Settings screen", () => {
  it("offers the preference in the Gameplay section", () => {
    const gameplay = settingsSource.slice(
      settingsSource.indexOf('<Section title="Gameplay">'),
      settingsSource.indexOf('<Section title="Audio">'),
    );
    expect(gameplay).toContain("settings.confirmLeavingOnlineGame");
    expect(gameplay).toContain("confirmLeavingOnlineGame: next");
  });
});
