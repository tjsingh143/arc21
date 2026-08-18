/**
 * What the introduction says, and the arithmetic that pages it.
 *
 * Two things are worth a test rather than a review. The disclosure is the
 * reason the gate exists at all, so "do we still say it?" is asserted here. And
 * the recommendation on page two is READ from the generated strategy table
 * rather than typed into a screen — this file proves the screen and the shipped
 * chart cannot disagree, because both come from the same cell.
 */

import { describe, expect, it } from "vitest";

import { evaluateHand } from "../../shared/blackjack/hand-value.js";
import { ARC_STANDARD_RULES } from "../../shared/blackjack/rules.js";
import { ARC_STANDARD_STRATEGY_TABLE } from "../../shared/strategy/index.js";
import {
  accountOption,
  ACCOUNT_OPTIONS,
  clampPageIndex,
  offsetForPageIndex,
  ONBOARDING_DISCLOSURE,
  ONBOARDING_PAGE_COUNT,
  ONBOARDING_PAGES,
  pageIndexFromOffset,
} from "../../src/features/onboarding/pages.js";
import {
  SHOWCASE_STRATEGY_KEY,
  strategyShowcase,
  WELCOME_BLACKJACK_PAYOUT_LABEL,
  WELCOME_DEALER_UPCARD,
  WELCOME_PLAYER_CARDS,
} from "../../src/features/onboarding/showcase.js";

describe("pages", () => {
  it("is three pages, and stays three", () => {
    // An introduction that outlasts the player's patience teaches nothing.
    expect(ONBOARDING_PAGES).toHaveLength(3);
    expect(ONBOARDING_PAGE_COUNT).toBe(3);
    expect(ONBOARDING_PAGES.map((page) => page.id)).toEqual(["table", "strategy", "together"]);
  });

  it("names every action the guidance covers", () => {
    const strategy = ONBOARDING_PAGES.find((page) => page.id === "strategy");
    for (const action of ["Hit", "Stand", "Double", "Split", "Surrender"]) {
      expect(strategy?.body).toContain(action);
    }
  });

  it("qualifies the page that promises what this build cannot do", () => {
    // Online play needs a server we do not have. Saying so on the page that
    // promises it beats letting it be discovered on a dead button later.
    const together = ONBOARDING_PAGES.find((page) => page.id === "together");
    expect(together?.caveat).toMatch(/not available/i);
    expect(ONBOARDING_PAGES.find((page) => page.id === "table")?.caveat).toBeNull();
  });
});

describe("disclosure", () => {
  const text = ONBOARDING_DISCLOSURE.join(" ");

  it("states the age gate", () => {
    expect(text).toContain("18+");
  });

  it("states that chips are worthless and nothing pays out", () => {
    expect(text).toContain("no monetary value");
    expect(text).toMatch(/no real-money gambling or cash prizes/i);
  });

  it("does not imply an edge in real gambling", () => {
    expect(text).toMatch(/does not improve your chances/i);
  });
});

describe("account options", () => {
  /*
   * These used to assert that both options EXPLAINED WHY ACCOUNTS DID NOT EXIST,
   * which was true when written and stopped being true three phases later. The
   * test passed the whole time, because it was checking that the copy still said
   * what it said. Onboarding was telling people accounts were unavailable while
   * `app/(auth)/` was signing them in.
   *
   * So the assertions are now about REACHABILITY: both paths lead to a route
   * that exists, and neither claims an absence.
   */
  it("offers both paths, and both lead somewhere", () => {
    expect(ACCOUNT_OPTIONS.map((option) => option.id)).toEqual(["create-account", "sign-in"]);
    for (const option of ACCOUNT_OPTIONS) {
      expect(option.route.startsWith("/(auth)/")).toBe(true);
      expect(option.hint.length).toBeGreaterThan(10);
    }
  });

  it("never claims accounts are unavailable", () => {
    for (const option of ACCOUNT_OPTIONS) {
      expect(option.hint).not.toMatch(/not available|no Arc 21 account|nothing to sign/i);
    }
  });

  it("says Practice does not need one", () => {
    // Guest play is still first and still complete. The buttons are an offer,
    // not a gate.
    expect(accountOption("create-account").hint).toMatch(/Practice never needs one/i);
  });

  it("throws on an unknown option rather than rendering undefined", () => {
    expect(accountOption("sign-in").label).toBe("Sign In");
    // @ts-expect-error — the union is the point; this is the runtime guard.
    expect(() => accountOption("magic-link")).toThrow();
  });
});

describe("paging arithmetic", () => {
  it("clamps to the available pages", () => {
    expect(clampPageIndex(-5)).toBe(0);
    expect(clampPageIndex(0)).toBe(0);
    expect(clampPageIndex(2)).toBe(2);
    expect(clampPageIndex(99)).toBe(2);
    expect(clampPageIndex(Number.NaN)).toBe(0);
    expect(clampPageIndex(1.7)).toBe(1);
  });

  it("rounds a scroll offset to the page actually on screen", () => {
    // Real devices stop a pixel or two short of the boundary.
    expect(pageIndexFromOffset(0, 400)).toBe(0);
    expect(pageIndexFromOffset(399, 400)).toBe(1);
    expect(pageIndexFromOffset(801, 400)).toBe(2);
    expect(pageIndexFromOffset(4_000, 400)).toBe(2);
  });

  it("reports page 0 before the layout has measured", () => {
    expect(pageIndexFromOffset(120, 0)).toBe(0);
    expect(pageIndexFromOffset(Number.NaN, 400)).toBe(0);
    expect(offsetForPageIndex(2, 0)).toBe(0);
  });

  it("returns the left edge of each page", () => {
    expect(offsetForPageIndex(0, 400)).toBe(0);
    expect(offsetForPageIndex(1, 400)).toBe(400);
    expect(offsetForPageIndex(9, 400)).toBe(800);
  });
});

describe("the hands the introduction shows", () => {
  it("shows a hand the engine would recognise", () => {
    const value = evaluateHand([...WELCOME_PLAYER_CARDS]);
    expect(value.isNaturalBlackjack).toBe(true);
    expect(value.bestTotal).toBe(21);
    expect(WELCOME_DEALER_UPCARD.rank).toBe("7");
  });

  it("quotes the payout the ruleset actually pays", () => {
    expect(WELCOME_BLACKJACK_PAYOUT_LABEL).toBe(
      `${ARC_STANDARD_RULES.blackjackPayoutNumerator}:${ARC_STANDARD_RULES.blackjackPayoutDenominator}`,
    );
  });

  it("reads its recommendation out of the generated table", () => {
    const showcase = strategyShowcase();
    expect(showcase).not.toBeNull();

    const cell = ARC_STANDARD_STRATEGY_TABLE.entries[SHOWCASE_STRATEGY_KEY];
    expect(cell).toBeDefined();

    // The screen shows whatever the solver put in this cell. If a future run
    // moves it, the screen moves with it and this test still passes — what it
    // forbids is the screen and the chart disagreeing.
    expect(showcase!.action).toBe(cell!.recommendedAction);
    expect(showcase!.scenario.key).toBe(SHOWCASE_STRATEGY_KEY);
  });

  it("shows cards that really are the hand it labels", () => {
    const showcase = strategyShowcase();
    const scenario = showcase!.scenario;

    // Built by the shared drill builder, which re-derives the state from the
    // cards themselves — so the label under the cards cannot drift from them.
    expect(scenario.playerCards).toHaveLength(2);
    expect(evaluateHand([...scenario.playerCards]).bestTotal).toBe(11);
    expect(scenario.state.handClass).toBe("hard");
    expect(scenario.handLabel).toBe("Hard 11");
    expect(scenario.upcardLabel).toBe("6");
    expect(scenario.legalActions).toContain(showcase!.action);
  });

  it("memoises, so a swipe does not rebuild the pool", () => {
    expect(strategyShowcase()).toBe(strategyShowcase());
  });
});
