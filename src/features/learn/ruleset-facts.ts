/**
 * Arc 21 — the rules, in words, derived from the ruleset.
 *
 * How to Play must describe the game the player is actually about to play. The
 * fastest way for a rules article to become a lie is for someone to type "six
 * decks, dealer stands on soft 17" into a paragraph and for the ruleset to
 * change later — so every rule-dependent sentence below is built from a
 * `BlackjackRules` value instead of written out.
 *
 * If the ruleset changes, this article changes with it, and
 * `tests/learn/ruleset-facts.test.ts` checks the variant branches by feeding it
 * a modified ruleset rather than trusting the shipped one to exercise them.
 *
 * Runtime-neutral: no React, no React Native.
 */

import { ARC_STANDARD_RULES, type BlackjackRules } from "../../../shared/blackjack/rules.js";

/**
 * Stated identically everywhere it appears. Virtual chips have no monetary
 * value; saying so in three slightly different ways invites one of them to be
 * softened later.
 */
export const VIRTUAL_CHIPS_DISCLAIMER =
  "Arc 21 is a simulated card game. Virtual chips have no monetary value, cannot " +
  "be withdrawn, and cannot be exchanged for money or prizes.";

/**
 * The honest ceiling on what any of this teaches. Basic strategy is a way to
 * lose more slowly, and the product must never imply otherwise.
 */
export const NO_PROFIT_CLAIM =
  "Basic strategy minimises the house edge — it does not remove it. No strategy " +
  "makes blackjack profitable, and nothing here predicts results.";

export function blackjackPayoutRatio(rules: BlackjackRules): string {
  return `${rules.blackjackPayoutNumerator}:${rules.blackjackPayoutDenominator}`;
}

export function insurancePayoutRatio(rules: BlackjackRules): string {
  return `${rules.insurancePayoutNumerator}:${rules.insurancePayoutDenominator}`;
}

/** "half your original bet" when the fraction is 1/2, otherwise the raw fraction. */
export function insuranceStakeDescription(rules: BlackjackRules): string {
  const { insuranceFractionNumerator: num, insuranceFractionDenominator: den } = rules;
  if (num === 1 && den === 2) return "half your original bet";
  return `${num}/${den} of your original bet`;
}

/** The dealer's drawing rule, which is fixed and never varies with the player. */
export function dealerRuleSentence(rules: BlackjackRules): string {
  return rules.dealerHitsSoft17
    ? "The dealer draws to 16 and stands on 17 or more, but must draw again on a soft 17 (an ace counting as 11)."
    : "The dealer draws to 16 and stands on all 17s, including a soft 17. There is no judgement involved and no reaction to how you are doing.";
}

export function doubleRuleSentence(rules: BlackjackRules): string {
  if (!rules.doubleAllowed) return "Doubling is not offered in this ruleset.";
  const base = rules.doubleOnAnyTwoCards
    ? "You may double on any first two cards"
    : "You may double only on selected totals";
  const das = rules.doubleAfterSplit
    ? ", including hands you have just split"
    : ", but not after a split";
  return `${base}${das}. You add a second bet equal to the first, take exactly one more card, and then stand.`;
}

export function splitRuleSentence(rules: BlackjackRules): string {
  const eligibility =
    rules.splitPolicy === "same_value"
      ? "Any two cards of equal point value can be split — so a king and a queen qualify"
      : "Two cards of the same rank can be split";
  const aces = rules.splitAcesAllowed
    ? rules.hitSplitAcesAllowed
      ? "Split aces may be hit normally."
      : "Split aces receive exactly one card each and cannot be hit, doubled or re-split."
    : "Aces cannot be split.";
  const cap = `You can end up with as many as ${rules.maxSplitHands} hands.`;
  return `${eligibility}. Each new hand takes its own bet equal to the original. ${cap} ${aces}`;
}

export function surrenderRuleSentence(rules: BlackjackRules): string {
  return rules.lateSurrenderAllowed
    ? "Late surrender: on your original two cards, after the dealer has checked for blackjack, you can give up the hand and take back half your bet. It is the right play on a small number of genuinely bad hands, and the chart says which."
    : "Surrender is not offered in this ruleset.";
}

export function splitAceTwentyOneSentence(rules: BlackjackRules): string {
  return rules.splitAceTwentyOneIsBlackjack
    ? "An ace plus a ten on a split hand counts as blackjack."
    : "An ace plus a ten on a split hand is an ordinary 21 and pays 1:1 — it is not a blackjack.";
}

export interface RuleFact {
  label: string;
  value: string;
}

/** The at-a-glance table. Every value is read from the ruleset. */
export function rulesetFacts(rules: BlackjackRules = ARC_STANDARD_RULES): RuleFact[] {
  return [
    { label: "Decks", value: `${rules.deckCount}, shuffled together` },
    {
      label: "Dealer",
      value: rules.dealerHitsSoft17 ? "Hits soft 17" : "Stands on all 17s",
    },
    { label: "Blackjack pays", value: blackjackPayoutRatio(rules) },
    {
      label: "Double",
      value: rules.doubleAllowed
        ? rules.doubleAfterSplit
          ? "Any two cards, including after a split"
          : "Any two cards, not after a split"
        : "Not offered",
    },
    {
      label: "Split",
      value:
        rules.splitPolicy === "same_value"
          ? `Equal values, up to ${rules.maxSplitHands} hands`
          : `Same rank, up to ${rules.maxSplitHands} hands`,
    },
    {
      label: "Surrender",
      value: rules.lateSurrenderAllowed ? "Late surrender, half your bet back" : "Not offered",
    },
    {
      label: "Insurance",
      value: rules.insuranceAllowed
        ? `${insuranceStakeDescription(rules)}, pays ${insurancePayoutRatio(rules)}`
        : "Not offered",
    },
  ];
}

export interface SettlementRow {
  result: string;
  /** What comes back to your stack, stated as a multiple of the hand's bet. */
  returns: string;
  note: string;
}

/**
 * The settlement table, derived from the payout ratios rather than transcribed.
 *
 * Stated as what is *returned* rather than as profit, because that is what the
 * engine actually does: the stake leaves the stack when the bet is committed, so
 * settlement only ever credits.
 */
export function settlementRows(rules: BlackjackRules = ARC_STANDARD_RULES): SettlementRow[] {
  const bjMultiple =
    1 + rules.blackjackPayoutNumerator / rules.blackjackPayoutDenominator;

  const rows: SettlementRow[] = [
    {
      result: "Blackjack",
      returns: `${formatMultiple(bjMultiple)}× your bet`,
      note: `Pays ${blackjackPayoutRatio(rules)} on a two-card 21.`,
    },
    {
      result: "Win",
      returns: "2× your bet",
      note: "Your bet back, plus the same again.",
    },
    { result: "Push", returns: "1× your bet", note: "A tie. Your bet is returned." },
    { result: "Loss or bust", returns: "Nothing", note: "The bet is already gone from your stack." },
  ];

  if (rules.lateSurrenderAllowed) {
    rows.push({
      result: "Surrender",
      returns: "0.5× your bet",
      note: "Half the bet back, and the hand ends immediately.",
    });
  }

  if (rules.insuranceAllowed) {
    rows.push({
      result: "Insurance",
      returns: `${formatMultiple(1 + rules.insurancePayoutNumerator / rules.insurancePayoutDenominator)}× the insurance stake`,
      note: `A separate side bet that pays ${insurancePayoutRatio(rules)} only when the dealer has blackjack.`,
    });
  }

  return rows;
}

/** `2.5` → `"2.5"`, `2` → `"2"`. No trailing zeros on whole multiples. */
function formatMultiple(value: number): string {
  return Number.isInteger(value) ? String(value) : String(Math.round(value * 100) / 100);
}
