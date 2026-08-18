import { describe, expect, it } from "vitest";

import { ARC_STANDARD_RULES, assertRulesAreCoherent } from "../../shared/blackjack/rules.js";
import {
  evenMoneyBranchNets,
  insuranceStakeFor,
  ratioProfit,
  settleHand,
  settleInsurance,
} from "../../shared/blackjack/settlement.js";
import type { PlayerHand } from "../../shared/blackjack/types.js";
import { cards } from "../helpers/engine-harness.js";

const RULES = ARC_STANDARD_RULES;

function hand(spec: string, overrides: Partial<PlayerHand> = {}): PlayerHand {
  return {
    id: "h1",
    cards: cards(spec),
    wager: 100,
    status: "STOOD",
    cameFromSplit: false,
    cameFromSplitAces: false,
    ...overrides,
  };
}

const dealer = (spec: string) => {
  const list = cards(spec);
  return { cards: list, hasNaturalBlackjack: list.length === 2 && total(list) === 21 };
};

function total(list: ReturnType<typeof cards>): number {
  let sum = 0;
  let aces = 0;
  for (const card of list) {
    if (card.rank === "A") {
      aces++;
      sum += 1;
    } else if (["10", "J", "Q", "K"].includes(card.rank)) sum += 10;
    else sum += Number(card.rank);
  }
  return aces > 0 && sum + 10 <= 21 ? sum + 10 : sum;
}

describe("ratio payouts stay integral", () => {
  it("pays 3:2 exactly on every legal bet increment", () => {
    for (let bet = RULES.minBet; bet <= RULES.maxBet; bet += RULES.betIncrement) {
      const profit = ratioProfit(bet, 3, 2);
      expect(profit * 2).toBe(bet * 3);
    }
  });

  it("halves surrender and insurance stakes exactly", () => {
    for (let bet = RULES.minBet; bet <= RULES.maxBet; bet += RULES.betIncrement) {
      expect(ratioProfit(bet, 1, 2) * 2).toBe(bet);
      expect(insuranceStakeFor(bet, RULES) * 2).toBe(bet);
    }
  });

  it("rejects a ruleset whose minimum bet cannot pay a natural exactly", () => {
    expect(() =>
      assertRulesAreCoherent({ ...RULES, minBet: 5, betIncrement: 5 }),
    ).toThrow(/whole chips/);
  });
});

describe("main hand settlement", () => {
  it("pays a natural 3:2", () => {
    const outcome = settleHand(hand("AS KD", { status: "BLACKJACK" }), dealer("10H 9C"), RULES);
    expect(outcome).toEqual({ kind: "BLACKJACK", credit: 250, net: 150 });
  });

  it("pushes natural against natural", () => {
    const outcome = settleHand(hand("AS KD", { status: "BLACKJACK" }), dealer("AH KC"), RULES);
    expect(outcome).toEqual({ kind: "PUSH", credit: 100, net: 0 });
  });

  it("beats a non-natural 21 with a dealer natural", () => {
    const outcome = settleHand(hand("7S 7D 7H"), dealer("AH KC"), RULES);
    expect(outcome).toEqual({ kind: "LOSS", credit: 0, net: -100 });
  });

  it("pays a split-hand 21 at 1:1, not 3:2", () => {
    const outcome = settleHand(
      hand("AS KD", { cameFromSplit: true, cameFromSplitAces: true, status: "TWENTY_ONE" }),
      dealer("10H 9C"),
      RULES,
    );
    expect(outcome).toEqual({ kind: "WIN", credit: 200, net: 100 });
  });

  it("credits nothing on a bust regardless of the dealer's hand", () => {
    const busted = hand("10S 9D 5C", { status: "BUSTED" });
    expect(settleHand(busted, dealer("10H 9C"), RULES).credit).toBe(0);
    // Dealer also busts — the player still loses, having busted first.
    expect(settleHand(busted, dealer("10H 9C 5S"), RULES).credit).toBe(0);
  });

  it("returns half on surrender", () => {
    const outcome = settleHand(hand("10S 6D", { status: "SURRENDERED" }), dealer("10H 9C"), RULES);
    expect(outcome).toEqual({ kind: "SURRENDER", credit: 50, net: -50 });
  });

  it("wins when the dealer busts", () => {
    expect(settleHand(hand("10S 6D"), dealer("10H 9C 5S"), RULES).kind).toBe("WIN");
  });

  it("compares totals when neither busts", () => {
    expect(settleHand(hand("10S 9D"), dealer("10H 8C"), RULES).kind).toBe("WIN");
    expect(settleHand(hand("10S 8D"), dealer("10H 8C"), RULES).kind).toBe("PUSH");
    expect(settleHand(hand("10S 7D"), dealer("10H 8C"), RULES).kind).toBe("LOSS");
  });

  it("settles a doubled wager on the doubled amount", () => {
    const outcome = settleHand(hand("5S 6D 10H", { wager: 200, status: "DOUBLED_COMPLETE" }), dealer("10C 9S"), RULES);
    expect(outcome).toEqual({ kind: "WIN", credit: 400, net: 200 });
  });
});

describe("insurance settlement", () => {
  it("returns 3x the stake against a dealer natural", () => {
    expect(settleInsurance(50, dealer("AH KC"), RULES)).toBe(150);
  });

  it("returns nothing otherwise", () => {
    expect(settleInsurance(50, dealer("AH 5C"), RULES)).toBe(0);
  });

  it("returns nothing when no insurance was taken", () => {
    expect(settleInsurance(0, dealer("AH KC"), RULES)).toBe(0);
  });
});

describe("even money identity", () => {
  it("nets exactly the original bet on both branches", () => {
    for (const bet of [50, 100, 250, 1000]) {
      const nets = evenMoneyBranchNets(bet, RULES);
      expect(nets.dealerNatural).toBe(bet);
      expect(nets.dealerNoNatural).toBe(bet);
    }
  });
});
