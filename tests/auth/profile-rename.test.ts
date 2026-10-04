/**
 * The rename the server had already implemented, and no player could reach.
 *
 * THE DEFECT. Five server-side guards and two rate-limit policies have covered
 * renaming since phase 3:
 *
 *   `guard_profile_username`            lowercases; refuses a reserved handle
 *   `normalise_profile_display_name`    sanitises; refuses an invisible name
 *   `profiles_username_key`             the handle is unique
 *   `profile_username_change`           1 per 30 days
 *   `profile_display_name_change`       5 per hour
 *
 * `docs/AUDIT.md` records both limits being MEASURED over HTTP against the live
 * stack — "the 2nd rename in 30 days returns 429" — and `CLAUDE.md` carries the
 * fix that made it a 429 rather than a 500, written up in terms of the player
 * it misled: "a player who renamed themselves twice in a month was told the
 * server had broken."
 *
 * Nothing in the app had ever written either column after signup. The Profile
 * screen read both and offered no way to change either, so a player was stuck
 * for good with whatever handle the signup form derived for them. All of that
 * enforcement guarded a door with no handle on the inside — and the HTTP-status
 * fix improved a message no player could ever see.
 *
 * These tests cover the client half: what changed, what is worth sending, and
 * how each of the server's error codes is rendered. The server half is already
 * proved by `docs/AUDIT.md`'s HTTP measurement and by pgTAP.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  changedFields,
  describeRenameError,
  DISPLAY_NAME_MAX_LENGTH,
  hasChanges,
  RENAME_LIMIT_NOTE,
  validateDisplayName,
} from "../../src/features/auth/profile-rename.js";

const CURRENT = { displayName: "Sam Vale", username: "samv" };

describe("what actually changed", () => {
  it("is nothing when nothing was typed", () => {
    const request = changedFields({ current: CURRENT, draft: { ...CURRENT } });
    expect(request).toEqual({});
    expect(hasChanges(request)).toBe(false);
  });

  it("is nothing when only the letter case of the handle differs", () => {
    /*
     * `guard_profile_username` lowercases before comparing, so "SamV" IS the
     * current handle as far as the server is concerned. Sending it would be a
     * request that changes nothing — and the player would have no way to tell
     * that from a change that was silently rejected.
     */
    const request = changedFields({
      current: CURRENT,
      draft: { displayName: "Sam Vale", username: "SamV" },
    });
    expect(hasChanges(request)).toBe(false);
  });

  it("is nothing when only surrounding whitespace differs", () => {
    const request = changedFields({
      current: CURRENT,
      draft: { displayName: "  Sam Vale  ", username: " samv " },
    });
    expect(hasChanges(request)).toBe(false);
  });

  it("carries only the field that moved", () => {
    expect(
      changedFields({ current: CURRENT, draft: { displayName: "Sam V.", username: "samv" } }),
    ).toEqual({ displayName: "Sam V." });

    expect(
      changedFields({ current: CURRENT, draft: { displayName: "Sam Vale", username: "vale" } }),
    ).toEqual({ username: "vale" });
  });

  it("normalises the handle it sends", () => {
    // Sent lowercase, because that is what will be stored. Sending "Vale" and
    // then rendering "Vale" back would show a value that does not exist.
    expect(
      changedFields({ current: CURRENT, draft: { displayName: "Sam Vale", username: " VALE " } }),
    ).toEqual({ username: "vale" });
  });
});

describe("the display name check", () => {
  it("refuses a name with nothing visible in it", () => {
    // `normalise_profile_display_name` refuses this too, and says why: a length
    // check alone accepts a name made of zero-width characters.
    expect(validateDisplayName("   ")).toMatch(/visible character/i);
    expect(validateDisplayName("")).toMatch(/visible character/i);
  });

  it("refuses one that is too long", () => {
    expect(validateDisplayName("x".repeat(DISPLAY_NAME_MAX_LENGTH + 1))).toMatch(/or fewer/i);
  });

  it("accepts an ordinary name", () => {
    expect(validateDisplayName("Sam Vale")).toBeUndefined();
    expect(validateDisplayName("x".repeat(DISPLAY_NAME_MAX_LENGTH))).toBeUndefined();
  });
});

describe("how the server's refusals are rendered", () => {
  it("distinguishes the rate limit, because the player did nothing wrong", () => {
    /*
     * The one refusal where the answer is "later" rather than "fix your name".
     * Collapsing it into a generic failure tells somebody to change a name that
     * is perfectly good — and this limit is one change per THIRTY DAYS, so the
     * advice would be wrong for a month.
     *
     * PT429 is the code `enforce_rate_limit` raises. PostgREST maps `PTnnn` to
     * HTTP nnn, which is exactly why the limit was moved off 55000.
     */
    const described = describeRenameError({ code: "PT429", message: "rate limit exceeded" });
    expect(described.reason).toBe("RATE_LIMITED");
    expect(described.message).toMatch(/30 days/);
    expect(described.message).toMatch(/try again later/i);
  });

  it("names a taken handle as taken", () => {
    const described = describeRenameError({
      code: "23505",
      message: 'duplicate key value violates unique constraint "profiles_username_key"',
    });
    expect(described.reason).toBe("TAKEN");
    expect(described.message).toMatch(/already taken/i);
    // Never the raw constraint name: that is a database detail, not an answer.
    expect(described.message).not.toMatch(/profiles_username_key/);
  });

  it("tells the two 23514 guards apart", () => {
    // `guard_profile_username` and `normalise_profile_display_name` both raise
    // 23514, and the advice differs completely.
    const reserved = describeRenameError({
      code: "23514",
      message: 'username "admin" is reserved or not permitted',
    });
    expect(reserved.reason).toBe("RESERVED");
    expect(reserved.message).toMatch(/not available/i);

    const invisible = describeRenameError({
      code: "23514",
      message: "display_name must contain at least one visible character",
    });
    expect(invisible.reason).toBe("INVALID");
    expect(invisible.message).toMatch(/visible character/i);
  });

  it("reports an unrecognised refusal as itself rather than guessing", () => {
    // A refusal the client does not understand must not be dressed up as one
    // it does — that is how a player is given advice for the wrong problem.
    const described = describeRenameError({ code: "P0001", message: "something else entirely" });
    expect(described.reason).toBe("REFUSED");
    expect(described.message).toBe("something else entirely");
  });

  it("still says something when the server said nothing", () => {
    expect(describeRenameError({}).message.trim()).not.toBe("");
  });
});

describe("the limits the screen states up front", () => {
  it("name both windows, so neither is learned by tripping it", () => {
    // A limit a player discovers by hitting it is a trap; one they are told
    // about is a rule. The same reasoning the tournament screen applies to its
    // entry fee.
    expect(RENAME_LIMIT_NOTE).toMatch(/30 days/);
    expect(RENAME_LIMIT_NOTE).toMatch(/five times an hour/i);
    expect(RENAME_LIMIT_NOTE).toMatch(/lowercase/i);
  });
});

/**
 * The CONTROL, not only the function behind it.
 *
 * Read from source rather than rendered: `react-native` does not parse under
 * Node, the wall four modules in `src/design` exist to sit the other side of.
 * So this proves the editor is wired to the store — not that the tree shows it,
 * which is a Maestro job. The same caveat `surface-card-test-id.test.ts`
 * carries, and the reason it matters here is the defect itself: every server
 * guard worked and no control called any of them.
 */
describe("the Profile screen", () => {
  const source = readFileSync(
    fileURLToPath(new URL("../../app/profile/index.tsx", import.meta.url)),
    "utf8",
  );

  it("was actually found", () => {
    expect(source).toContain("export default function ProfileScreen");
  });

  it("offers the editor to a signed-in player", () => {
    expect(source).toContain("<EditIdentityCard");
    expect(source).toContain('testID="profile-edit-name"');
  });

  it("sends the change through the store's rename", () => {
    expect(source).toContain("state.rename");
    expect(source).toContain("changedFields");
  });

  it("states the limits before the player commits", () => {
    expect(source).toContain("RENAME_LIMIT_NOTE");
  });

  it("keys the editor on the stored values rather than syncing in an effect", () => {
    /*
     * The first version called `setState` inside a `useEffect` keyed on the
     * profile, which the React Compiler lint rejects — it schedules a second
     * render pass on every change of the row. A key is the idiomatic answer and
     * has the better behaviour: a refused save keeps what the player typed,
     * because the row did not change.
     */
    expect(source).toMatch(/key=\{`\$\{accountProfile\.userId\}:\$\{accountProfile\.displayName\}:\$\{accountProfile\.username\}`\}/);
  });
});
