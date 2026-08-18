/**
 * Arc 21 — settlement and money math.
 *
 * INVARIANT: chips are integers. No floating-point arithmetic ever touches a
 * balance. All ratios resolve through `ratioProfit`, which floors — and
 * `assertRulesAreCoherent` guarantees the configured minimum bet pays a natural
 * exactly, so flooring never actually shaves chips under the shipped rulesets.
 *
 * The stake is deducted from the seat stack when the wager is committed, so
 * settlement only ever *credits*. A losing hand credits zero; it does not
 * subtract again.
 */

import { evaluateHand, evaluatePlayerHand } from "./hand-value.js";
import type { BlackjackRules } from "./rules.js";
import type { Card, HandOutcome, PlayerHand, SeatState } from "./types.js";

/**
 * Integer profit for a ratio payout. Floors, which rounds toward the house on
 * configurations that cannot pay exactly; the ruleset guard prevents shipping
 * such a configuration.
 */
export function ratioProfit(wager: number, numerator: number, denominator: number): number {
  return Math.floor((wager * numerator) / denominator);
}

export interface DealerFinal {
  cards: Card[];
  hasNaturalBlackjack: boolean;
}

export function describeDealerFinal(cards: Card[]): DealerFinal {
  return {
    cards,
    hasNaturalBlackjack: evaluateHand(cards).isNaturalBlackjack,
  };
}

/**
 * Settles one player hand against the dealer's final hand.
 *
 * Credit table (multiples of the hand's wager):
 *   loss / bust      0
 *   push             1.0
 *   ordinary win     2.0   (stake + 1:1)
 *   natural          2.5   (stake + 3:2)
 *   surrender        0.5
 */
export function settleHand(
  hand: PlayerHand,
  dealer: DealerFinal,
  rules: BlackjackRules,
): HandOutcome {
  const wager = hand.wager;

  if (hand.status === "SURRENDERED") {
    const credit = ratioProfit(wager, 1, 2);
    return { kind: "SURRENDER", credit, net: credit - wager };
  }

  if (hand.status === "BUSTED") {
    // The player busted first; the dealer's hand is irrelevant.
    return { kind: "BUST", credit: 0, net: -wager };
  }

  const player = evaluatePlayerHand(hand, rules.splitAceTwentyOneIsBlackjack);
  const dealerValue = evaluateHand(dealer.cards);

  if (player.isNaturalBlackjack) {
    if (dealer.hasNaturalBlackjack) {
      return { kind: "PUSH", credit: wager, net: 0 };
    }
    const credit = wager + ratioProfit(wager, rules.blackjackPayoutNumerator, rules.blackjackPayoutDenominator);
    return { kind: "BLACKJACK", credit, net: credit - wager };
  }

  // A dealer natural beats every non-natural player hand, including a 21 built
  // from three cards or from a split.
  if (dealer.hasNaturalBlackjack) {
    return { kind: "LOSS", credit: 0, net: -wager };
  }

  if (dealerValue.isBust || player.bestTotal > dealerValue.bestTotal) {
    return { kind: "WIN", credit: wager * 2, net: wager };
  }

  if (player.bestTotal === dealerValue.bestTotal) {
    return { kind: "PUSH", credit: wager, net: 0 };
  }

  return { kind: "LOSS", credit: 0, net: -wager };
}

/**
 * Settles a seat's insurance side wager. Independent of the main hand.
 *
 * Insurance stake was already deducted when taken, so this only credits:
 *   dealer natural → stake + 2:1 profit (3× stake)
 *   otherwise      → 0
 */
export function settleInsurance(
  insuranceBet: number,
  dealer: DealerFinal,
  rules: BlackjackRules,
): number {
  if (insuranceBet <= 0) return 0;
  if (!dealer.hasNaturalBlackjack) return 0;
  return (
    insuranceBet + ratioProfit(insuranceBet, rules.insurancePayoutNumerator, rules.insurancePayoutDenominator)
  );
}

/** The stake an insurance offer would cost this seat. */
export function insuranceStakeFor(originalBet: number, rules: BlackjackRules): number {
  return ratioProfit(originalBet, rules.insuranceFractionNumerator, rules.insuranceFractionDenominator);
}

/**
 * "Even money" is the UI shortcut offered when a player holds a natural against
 * a dealer ace. It is not a distinct wager: it is ordinary insurance taken on a
 * natural, and Arc 21 books it that way so there is exactly one accounting path
 * in the ledger rather than a special case to audit separately.
 *
 * Both branches net exactly +1× the original bet, which is what makes the
 * shortcut honest:
 *
 *   dealer natural     main pushes (1×) + insurance pays 3× stake
 *                      net = 1 + 3(0.5) - 1 - 0.5 = +1.0×
 *   dealer no natural  main pays 3:2 (2.5×) + insurance lost
 *                      net = 2.5 - 1 - 0.5 = +1.0×
 *
 * Returns the net chip result of each branch so tests can assert the identity
 * directly instead of trusting the comment.
 */
export function evenMoneyBranchNets(
  originalBet: number,
  rules: BlackjackRules,
): { dealerNatural: number; dealerNoNatural: number; investment: number } {
  const stake = insuranceStakeFor(originalBet, rules);
  const investment = originalBet + stake;

  const dealerNaturalCredit =
    originalBet + settleInsurance(stake, { cards: [], hasNaturalBlackjack: true }, rules);

  const dealerNoNaturalCredit =
    originalBet +
    ratioProfit(originalBet, rules.blackjackPayoutNumerator, rules.blackjackPayoutDenominator);

  return {
    dealerNatural: dealerNaturalCredit - investment,
    dealerNoNatural: dealerNoNaturalCredit - investment,
    investment,
  };
}

export interface SeatSettlement {
  seatId: string;
  handOutcomes: Array<{ handId: string; outcome: HandOutcome }>;
  insuranceCredit: number;
  /** Total chips returned to the seat stack. */
  totalCredit: number;
  /** Net chip change across the whole round, including insurance. */
  net: number;
}

export function settleSeat(
  seat: SeatState,
  dealer: DealerFinal,
  rules: BlackjackRules,
): SeatSettlement {
  const handOutcomes = seat.hands.map((hand) => ({
    handId: hand.id,
    outcome: settleHand(hand, dealer, rules),
  }));

  const insuranceCredit = settleInsurance(seat.insuranceBet, dealer, rules);

  const handCredit = handOutcomes.reduce((sum, entry) => sum + entry.outcome.credit, 0);
  const handNet = handOutcomes.reduce((sum, entry) => sum + entry.outcome.net, 0);

  return {
    seatId: seat.seatId,
    handOutcomes,
    insuranceCredit,
    totalCredit: handCredit + insuranceCredit,
    net: handNet + (insuranceCredit - seat.insuranceBet),
  };
}
