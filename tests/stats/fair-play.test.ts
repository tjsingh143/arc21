/**
 * The Fair Play disclosure, checked against the code it describes.
 *
 * `src/features/settings/fair-play-facts.ts` names THIS FILE twice — once for
 * the derived shuffle figures and once for the forbidden-claim sweep — and
 * until now it did not exist. The module that guards absolute invariant 8
 * ("never claim an external audit or certification") had no test at all, and
 * `FORBIDDEN_CLAIM_TERMS` had no consumer: a list of words nothing checked,
 * under a comment saying a copy edit that added "independently audited" would
 * fail the build. It would not have.
 *
 * Two things are asserted separately here, because they pull in opposite
 * directions:
 *
 *   - the CLAIMS must never contain a forbidden term. They are positive
 *     statements about the product, and "certified" in one of them would be a
 *     false claim;
 *   - the LIMIT statements must contain the negated forms. "Arc 21 has not been
 *     tested or certified …" is the sentence that makes the page honest, and a
 *     naive substring sweep over every string in the module would forbid it.
 *     That collision is the likeliest reason the sweep was never written; the
 *     answer is to say which strings are claims and which are the limits, not
 *     to drop the check.
 *
 * The derived figures are fed VARIANT rulesets, the way
 * `tests/learn/ruleset-facts.test.ts` does, so a paragraph that silently
 * hard-codes "six decks" fails instead of shipping.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { ARC_STANDARD_RULES, type BlackjackRules } from "../../shared/blackjack/rules.js";
import { computeCutIndex, SAFETY_RESERVE_CARDS } from "../../shared/blackjack/shoe.js";
import {
  RECOVERY_GRANT_COOLDOWN_MS,
  RECOVERY_GRANT_THRESHOLD,
} from "../../src/features/wallet/recovery-grant.js";
import {
  CHIPS_NOT_MONEY_FOOTER,
  fairPlayClaims,
  FORBIDDEN_CLAIM_TERMS,
  NO_CERTIFICATION_STATEMENT,
  NO_GUARANTEE_STATEMENT,
  responsiblePlayStatements,
  shuffleFacts,
} from "../../src/features/settings/fair-play-facts.js";

const RULES = ARC_STANDARD_RULES;

function variant(overrides: Partial<BlackjackRules>): BlackjackRules {
  return { ...RULES, ...overrides };
}

/**
 * Everything the screen renders as a positive claim, flattened.
 *
 * The responsible-play statements are included: they are claims about the
 * product on the same screen, and "certified" would be exactly as false there.
 */
function claimStrings(rules: BlackjackRules = RULES): string[] {
  return [
    ...fairPlayClaims(rules).flatMap((claim) => [claim.title, claim.body]),
    ...responsiblePlayStatements().flatMap((s) => [s.title, s.body]),
  ];
}

// ---------------------------------------------------------------------------

describe("the shuffle figures are derived, not transcribed", () => {
  it("agrees with the engine's own cut-card arithmetic", () => {
    const facts = shuffleFacts(RULES);

    expect(facts.totalCards).toBe(RULES.deckCount * 52);
    expect(facts.cutIndex).toBe(computeCutIndex(facts.totalCards, RULES.targetPenetration));
    expect(facts.cardsBehindCut).toBe(facts.totalCards - facts.cutIndex);
    expect(facts.safetyReserve).toBe(SAFETY_RESERVE_CARDS);
    expect(facts.deckCount).toBe(RULES.deckCount);
    expect(facts.penetrationPercent).toBe(Math.round(RULES.targetPenetration * 100));
  });

  it("reports the reserve as behind the cut card for the shipped ruleset", () => {
    // The deliberate deviation recorded in CLAUDE.md: the reserve is 52 cards,
    // not 104, precisely so that the advertised penetration stays reachable.
    // If that relationship ever inverts, the screen must not claim otherwise.
    const facts = shuffleFacts(RULES);
    expect(facts.reserveIsBehindCut).toBe(true);
    expect(facts.cardsBehindCut).toBeGreaterThanOrEqual(facts.safetyReserve);
  });

  it("follows the ruleset to a different deck count instead of saying six", () => {
    const eight = shuffleFacts(variant({ deckCount: 8 }));
    expect(eight.totalCards).toBe(416);
    expect(eight.deckCount).toBe(8);

    const body = claimStrings(variant({ deckCount: 8 })).join(" ");
    expect(body).toContain("8 decks");
    expect(body).not.toContain("6 decks");
  });

  it("follows the ruleset to a different penetration instead of saying 75%", () => {
    const shallow = shuffleFacts(variant({ targetPenetration: 0.5 }));
    expect(shallow.penetrationPercent).toBe(50);

    const body = claimStrings(variant({ targetPenetration: 0.5 })).join(" ");
    expect(body).toContain("50%");
    expect(body).not.toContain("75%");
  });
});

// ---------------------------------------------------------------------------

describe("the dealer sentence follows the ruleset", () => {
  it("describes S17 for Arc Standard and H17 when the rule flips", () => {
    const stands = claimStrings(variant({ dealerHitsSoft17: false })).join(" ");
    expect(stands).toContain("stands on all 17s");

    const hits = claimStrings(variant({ dealerHitsSoft17: true })).join(" ");
    expect(hits).toContain("draws again on a soft 17");
    expect(hits).not.toContain("stands on all 17s");
  });

  it("states the blackjack payout from the ruleset", () => {
    expect(claimStrings(RULES).join(" ")).toContain(
      `${RULES.blackjackPayoutNumerator}:${RULES.blackjackPayoutDenominator}`,
    );
    expect(claimStrings(variant({ blackjackPayoutNumerator: 6, blackjackPayoutDenominator: 5 })).join(" "))
      .toContain("6:5");
  });
});

// ---------------------------------------------------------------------------

describe("absolute invariant 8 — no claim of audit or certification", () => {
  it("keeps every forbidden term out of every claim, under every ruleset", () => {
    const rulesets = [
      RULES,
      variant({ dealerHitsSoft17: true }),
      variant({ deckCount: 8, targetPenetration: 0.5 }),
      variant({ lateSurrenderAllowed: false, insuranceAllowed: false }),
      variant({ blackjackPayoutNumerator: 6, blackjackPayoutDenominator: 5 }),
    ];

    for (const rules of rulesets) {
      for (const text of claimStrings(rules)) {
        for (const term of FORBIDDEN_CLAIM_TERMS) {
          expect(
            text.toLowerCase().includes(term.toLowerCase()),
            `a Fair Play claim contains the forbidden term "${term}": ${text}`,
          ).toBe(false);
        }
      }
    }
  });

  it("has a forbidden list that would actually catch the claim it exists to stop", () => {
    // A list nothing checks reads as enforcement. Prove the sweep bites: the
    // sentence below is the exact edit the module's comment warns about.
    const tempting = "Arc 21 is independently audited and certified fair.";
    const caught = FORBIDDEN_CLAIM_TERMS.filter((term) =>
      tempting.toLowerCase().includes(term.toLowerCase()),
    );
    expect(caught).toContain("audited");
    expect(caught).toContain("certified");
  });

  it("says plainly that no external test or certification has happened", () => {
    expect(NO_CERTIFICATION_STATEMENT).toContain("has not been tested or certified");
    expect(NO_CERTIFICATION_STATEMENT).toContain("not an audit");
    // The negation is the whole point: this is the one string allowed to use
    // the word, and only in this shape.
    expect(NO_CERTIFICATION_STATEMENT).not.toMatch(/\bis certified\b/i);
    expect(NO_CERTIFICATION_STATEMENT).not.toMatch(/\bindependently audited\b/i);
  });

  it("never promises a result", () => {
    expect(NO_GUARANTEE_STATEMENT).toContain("not a promise about your session");
    expect(NO_GUARANTEE_STATEMENT).toContain("never removes it");
    expect(NO_GUARANTEE_STATEMENT).not.toMatch(/\bguaranteed\b/i);
  });
});

// ---------------------------------------------------------------------------

describe("the claims the page must not quietly lose", () => {
  it("keeps the no-adaptation claim, which is absolute invariant 1", () => {
    const claim = fairPlayClaims(RULES).find((c) => c.id === "no-adaptation");
    expect(claim).toBeDefined();
    expect(claim!.body).toContain("not changed because you are winning");
    expect(claim!.body).toContain("because you are losing");
  });

  it("keeps the CSPRNG claim, which is absolute invariant 4", () => {
    const claim = fairPlayClaims(RULES).find((c) => c.id === "randomness");
    expect(claim).toBeDefined();
    expect(claim!.body).toContain("Math.random");
    expect(claim!.body).toContain("refuses to");
  });

  it("keeps the nothing-to-buy claim, which is absolute invariant 2", () => {
    const claim = fairPlayClaims(RULES).find((c) => c.id === "money");
    expect(claim).toBeDefined();
    expect(claim!.body).toContain("sells nothing");
    expect(claim!.body).toContain("no ads");
  });

  it("keeps the chips-are-not-money claim in its strongest form", () => {
    const claim = fairPlayClaims(RULES).find((c) => c.id === "chips");
    expect(claim).toBeDefined();
    expect(claim!.body).toContain("no monetary value");
    expect(claim!.body).toContain("cashed out");
    expect(claim!.body).toContain("money or prizes");
  });

  it("keeps the advice-cannot-peek claim, which is absolute invariant 5", () => {
    const claim = fairPlayClaims(RULES).find((c) => c.id === "advice");
    expect(claim).toBeDefined();
    expect(claim!.body).toContain("never the hole card");
  });
});

// ---------------------------------------------------------------------------

describe("the one-line disclosure says the same thing everywhere", () => {
  /**
   * `app.json` is not TypeScript, so nothing else in the build can notice when
   * it drifts. It held its own wording — "cannot be redeemed", with "for money
   * or prizes" missing — and no code read it, which is why nobody saw. Store
   * metadata is the most likely thing to be written from that key, so it is
   * pinned here rather than left to convention.
   *
   * This is the pattern CLAUDE.md prescribes for a constant that genuinely has
   * to exist twice: duplicate it, then assert the two are equal.
   */
  const appConfig = JSON.parse(
    readFileSync(fileURLToPath(new URL("../../app.json", import.meta.url)), "utf8"),
  ) as { expo: { extra?: { disclaimer?: string } } };

  it("matches the constant the four screens render", () => {
    expect(appConfig.expo.extra?.disclaimer).toBe(CHIPS_NOT_MONEY_FOOTER);
  });

  it("keeps the parts that make it a disclosure rather than a slogan", () => {
    expect(CHIPS_NOT_MONEY_FOOTER).toContain("no monetary value");
    expect(CHIPS_NOT_MONEY_FOOTER).toContain("money or prizes");
    expect(CHIPS_NOT_MONEY_FOOTER).toContain("Simulated");
  });
});

// ---------------------------------------------------------------------------

describe("the responsible-play disclosure", () => {
  const statements = responsiblePlayStatements();
  const byId = (id: string) => statements.find((s) => s.id === id);

  it("states an age, because the store listing will and the two must agree", () => {
    expect(byId("adults")?.body).toContain("18 and over");
  });

  it("derives the Recovery Grant figures instead of typing them", () => {
    const broke = byId("broke");
    expect(broke).toBeDefined();
    expect(broke!.body).toContain(RECOVERY_GRANT_THRESHOLD.toLocaleString("en-GB"));
    expect(broke!.body).toContain(`${Math.round(RECOVERY_GRANT_COOLDOWN_MS / 3_600_000)} hours`);
  });

  it("promises no transfer of skill to real money", () => {
    expect(byId("no-transfer")?.body).toContain(
      "does not improve your chances of winning money anywhere else",
    );
    expect(byId("no-transfer")?.body).toContain("never removes it");
  });

  it("claims no affiliation with any support service and names none", () => {
    const help = byId("help");
    expect(help).toBeDefined();
    expect(help!.body).toContain("not affiliated with");
    expect(help!.body).toContain("not treatment");
    /*
     * A phone number or URL here would be wrong in most of the world and
     * impossible to keep correct. If one is ever added, this fails and whoever
     * added it has to justify it.
     */
    expect(help!.body).not.toMatch(/https?:\/\//);
    expect(help!.body).not.toMatch(/\d{3,}/);
  });

  it("says nothing is designed to keep you playing, which is only true while no streak exists", () => {
    expect(byId("no-pressure")?.body).toContain("no login streak");
    expect(byId("no-pressure")?.body).toContain("switched off in Settings");
  });
});
