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
  AI_SEAT_MODES,
  ALL_SESSION_MODES,
  allowsFreeStackReset,
  chipsCameFromWallet,
  FREE_STACK_RESET_MODES,
  freeResetStackFor,
  isKnownSessionMode,
  seatsComputerPlayers,
  WALLET_BACKED_MODES,
} from "../../supabase/functions/_shared/session-economics.js";
import { AI_TABLE_STACK, PRIVATE_TABLE_STACK } from "../../shared/blackjack/index.js";

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
    // A career node starts on 2,000 chips that came from nowhere and vanish
    // with the session. Crediting them would mint 2,000 per attempt.
    expect(chipsCameFromWallet("career")).toBe(false);
  });

  it("would have refused the private table that minted 5,000 chips", () => {
    // The specific defect, stated as a test so it cannot come back.
    expect(chipsCameFromWallet("private_table")).toBe(false);
  });
});

describe("every mode is classified", () => {
  it("covers the whole database enum", () => {
    // `supabase/tests/16_sprint_and_daily.test.sql` holds the database's
    // `game_mode` enum to this exact list, so a new mode fails the suite until
    // it is placed on one side of the line or the other. `career` was added in
    // the closure mission and failed here and there, as intended; `ai_table`
    // was added in Astra Refresh C and did the same, and is classified below.
    expect([...ALL_SESSION_MODES]).toEqual([
      "practice",
      "solo",
      "private_table",
      "public_table",
      "tournament",
      "daily_challenge",
      "career",
      "ai_table",
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

/**
 * AN AI TABLE IS A CLOSED ECONOMY (Astra Refresh C).
 *
 * Every seat at one — the person's and each computer player's — starts on
 * `AI_TABLE_STACK` chips the server created. A computer player has no wallet, so
 * a chip the person wins from one was never debited from anybody: if an AI
 * table's stack could reach a wallet, every hand a computer player lost would be
 * chips minted on demand. The server-side proof is in
 * `tests/server/ai-table.integration.test.ts`, which wins and leaves and reads the
 * wallet; this pins the classification that makes it so.
 */
describe("the AI table", () => {
  it("is never wallet-backed: its chips can never cross into a wallet", () => {
    expect(chipsCameFromWallet("ai_table")).toBe(false);
    expect(WALLET_BACKED_MODES as readonly string[]).not.toContain("ai_table");
    expect(isKnownSessionMode("ai_table")).toBe(true);
  });

  it("is the one mode that seats computer players", () => {
    expect([...AI_SEAT_MODES]).toEqual(["ai_table"]);
    for (const mode of ALL_SESSION_MODES) {
      expect(seatsComputerPlayers(mode), mode).toBe(mode === "ai_table");
    }
  });

  it("lets a broke player start again from the table's own stack, as a private table does", () => {
    expect([...FREE_STACK_RESET_MODES].sort()).toEqual(["ai_table", "private_table"]);
    expect(allowsFreeStackReset("ai_table")).toBe(true);
    expect(freeResetStackFor("ai_table")).toBe(AI_TABLE_STACK);
    expect(freeResetStackFor("private_table")).toBe(PRIVATE_TABLE_STACK);
  });

  it("never offers a free reset where the chips came from a wallet — that would mint them", () => {
    for (const mode of WALLET_BACKED_MODES) {
      expect(allowsFreeStackReset(mode), mode).toBe(false);
      expect(freeResetStackFor(mode), mode).toBeNull();
    }
    for (const mode of FREE_STACK_RESET_MODES) {
      expect(chipsCameFromWallet(mode), mode).toBe(false);
    }
  });

  it("names no reset figure for any mode without a reset", () => {
    for (const mode of ALL_SESSION_MODES) {
      if (!allowsFreeStackReset(mode)) expect(freeResetStackFor(mode), mode).toBeNull();
    }
    expect(freeResetStackFor("something_new")).toBeNull();
  });
});
