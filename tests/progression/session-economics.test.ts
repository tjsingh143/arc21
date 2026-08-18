/**
 * Which tables owe chips back to a wallet.
 *
 * This module exists because the answer used to be nowhere, and the cost of that
 * was a live chip mint: leaving a private table credited its 5,000 session chips
 * to the global wallet, turning 25,000 into 30,000, repeatable once per table.
 * Measured against the running stack, not theorised.
 *
 * So these tests are deliberately blunt. They pin the classification of every
 * mode by name, and they fail if a new mode is added without someone deciding
 * which side of the line it falls on — because the default for an unclassified
 * mode is "mints chips" in one direction and "strands a player's real chips" in
 * the other, and neither is safe.
 */

import { describe, expect, it } from "vitest";

import {
  ALL_SESSION_MODES,
  chipsCameFromWallet,
  isKnownSessionMode,
  WALLET_BACKED_MODES,
} from "../../supabase/functions/_shared/session-economics.js";

describe("modes whose chips came out of a wallet", () => {
  it("is exactly solo and public tables", () => {
    expect([...WALLET_BACKED_MODES]).toEqual(["solo", "public_table"]);
  });

  it("says so for each of them", () => {
    expect(chipsCameFromWallet("solo")).toBe(true);
    expect(chipsCameFromWallet("public_table")).toBe(true);
  });
});

describe("closed economies", () => {
  it("refuses every one of them", () => {
    // A private table so two accounts cannot transfer a bankroll by agreeing to
    // lose; a tournament and a daily challenge because their stacks are a scoring
    // medium whose only wallet exposure is the entry fee going the other way.
    expect(chipsCameFromWallet("private_table")).toBe(false);
    expect(chipsCameFromWallet("tournament")).toBe(false);
    expect(chipsCameFromWallet("daily_challenge")).toBe(false);
    expect(chipsCameFromWallet("practice")).toBe(false);
  });

  it("would have refused the private table that minted 5,000 chips", () => {
    // The specific defect, stated as a test so it cannot come back.
    expect(chipsCameFromWallet("private_table")).toBe(false);
  });
});

describe("every mode is classified", () => {
  it("covers the whole database enum", () => {
    // `supabase/tests/16_sprint_and_daily.test.sql` holds the database's
    // `game_mode` enum to this exact list, so a seventh mode fails the suite until
    // it is placed on one side of the line or the other.
    expect([...ALL_SESSION_MODES]).toEqual([
      "practice",
      "solo",
      "private_table",
      "public_table",
      "tournament",
      "daily_challenge",
    ]);
  });

  it("lists every wallet-backed mode among the known ones", () => {
    for (const mode of WALLET_BACKED_MODES) {
      expect(isKnownSessionMode(mode)).toBe(true);
    }
  });

  it("recognises each known mode and nothing else", () => {
    for (const mode of ALL_SESSION_MODES) expect(isKnownSessionMode(mode)).toBe(true);
    expect(isKnownSessionMode("side_bet_bonanza")).toBe(false);
    expect(isKnownSessionMode("")).toBe(false);
  });

  it("does not quietly treat an unknown mode as closed", () => {
    // `chipsCameFromWallet` returning false for an unknown mode would strand a
    // real player's real chips. The caller pairs it with `isKnownSessionMode` and
    // throws instead, which is why both predicates exist rather than one.
    expect(chipsCameFromWallet("something_new")).toBe(false);
    expect(isKnownSessionMode("something_new")).toBe(false);
  });
});
