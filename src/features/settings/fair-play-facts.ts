/**
 * Arc 21 — the Fair Play disclosure, derived from the code it describes.
 *
 * EVERY CLAIM ON THE FAIR PLAY SCREEN MUST BE TRUE OF THE SHIPPED CODE.
 *
 * The fastest way for a fairness page to become a lie is for someone to type
 * "six decks, 75% penetration" into a paragraph and for `ARC_STANDARD_RULES` to
 * change later. So every rule-dependent number below is read from the ruleset
 * and the shoe module rather than written out, and `tests/stats/fair-play.test.ts`
 * checks the derived figures against the engine's own functions.
 *
 * Two things this module must never produce:
 *
 *   1. A claim of external certification, independent audit, RNG testing-house
 *      approval or a published RTP. **None of that exists.** Saying it would be
 *      the single most damaging false statement this product could make.
 *   2. A guarantee about results. The shuffle is fair; that is a statement about
 *      the process, not a promise about any session.
 *
 * Runtime-neutral: no React, React Native or Expo imports.
 */

import { ARC_STANDARD_RULES, type BlackjackRules } from "../../../shared/blackjack/rules.js";
import { computeCutIndex, SAFETY_RESERVE_CARDS } from "../../../shared/blackjack/shoe.js";

export interface ShuffleFacts {
  deckCount: number;
  totalCards: number;
  /** Whole-percent penetration target, e.g. 75. */
  penetrationPercent: number;
  /** Index of the cut card within the shoe. */
  cutIndex: number;
  /** Cards still behind the cut card when it is reached. */
  cardsBehindCut: number;
  /** The backstop that must never fire before the cut card. */
  safetyReserve: number;
  /**
   * True when the reserve genuinely cannot pre-empt the cut card. The engine
   * refuses to construct a ruleset where this is false, so the screen never has
   * to describe an incoherent configuration — but the flag is derived rather
   * than assumed.
   */
  reserveIsBehindCut: boolean;
}

export function shuffleFacts(rules: BlackjackRules = ARC_STANDARD_RULES): ShuffleFacts {
  const totalCards = rules.deckCount * 52;
  const cutIndex = computeCutIndex(totalCards, rules.targetPenetration);
  const cardsBehindCut = totalCards - cutIndex;

  return {
    deckCount: rules.deckCount,
    totalCards,
    penetrationPercent: Math.round(rules.targetPenetration * 100),
    cutIndex,
    cardsBehindCut,
    safetyReserve: SAFETY_RESERVE_CARDS,
    reserveIsBehindCut: cardsBehindCut >= SAFETY_RESERVE_CARDS,
  };
}

export interface FairPlayClaim {
  id: string;
  title: string;
  /** Plain language. Short sentences. No jargon the player has to decode. */
  body: string;
}

/**
 * The disclosure, in the order a suspicious player would ask the questions.
 *
 * Each claim maps to something checkable in the repository:
 *
 *   rules       → `ARC_STANDARD_RULES` (shared/blackjack/rules.ts)
 *   shuffle     → `createShoe`, `needsReshuffle` (shared/blackjack/shoe.ts)
 *   randomness  → `CryptoRandomSource`, `shuffleInPlace` (shared/blackjack/rng.ts)
 *   order       → `drawCard` (shared/blackjack/shoe.ts)
 *   dealer      → `playDealerHand` (shared/blackjack/reducer.ts)
 *   advice      → `computeAdvice` (src/features/practice/advice.ts)
 *   money       → no purchase path exists anywhere in the product
 */
export function fairPlayClaims(rules: BlackjackRules = ARC_STANDARD_RULES): FairPlayClaim[] {
  const shoe = shuffleFacts(rules);

  return [
    {
      id: "rules",
      title: "The rules, stated up front",
      body:
        `${shoe.deckCount} decks are shuffled together. The dealer ` +
        `${rules.dealerHitsSoft17 ? "draws again on a soft 17" : "stands on all 17s, including a soft 17"}. ` +
        `Blackjack pays ${rules.blackjackPayoutNumerator}:${rules.blackjackPayoutDenominator}. ` +
        "These are the same rules in every mode, and they are the rules the strategy advice is computed for.",
    },
    {
      id: "shuffle",
      title: "When the cards are shuffled",
      body:
        `A cut card sits about ${shoe.penetrationPercent}% of the way through the shoe. ` +
        `Once it is reached, the whole shoe is reshuffled before the next hand begins — ` +
        `never in the middle of one. A reserve of ${shoe.safetyReserve} cards sits behind the cut card ` +
        "so a hand in progress can never run the shoe dry; in ordinary play it is never touched.",
    },
    {
      id: "randomness",
      title: "How the shuffle is made",
      body:
        "Practice shuffles with your device's cryptographically secure random number generator, " +
        "using an unbiased Fisher-Yates shuffle. It never uses Math.random, and the code refuses to " +
        "deal at all if secure randomness is unavailable rather than quietly falling back to something weaker.",
    },
    {
      id: "order",
      title: "Cards come off the shoe in order",
      body:
        "Once shuffled, the order is fixed. Every card is dealt from the top of the shoe in sequence. " +
        "Nothing looks ahead to pick a card, and no card is ever created on demand.",
    },
    {
      id: "no-adaptation",
      title: "Nothing reacts to how you are doing",
      body:
        "The cards are not changed because you are winning, because you are losing, because you are on a " +
        "streak, or because you are about to stop playing. There is no code that looks at your results and " +
        "adjusts the shoe, and there is no difficulty setting hidden behind the table.",
    },
    {
      id: "dealer",
      title: "The dealer is not an opponent",
      body:
        "The dealer follows a fixed rule and has no choices to make: draw below 17, " +
        `${rules.dealerHitsSoft17 ? "draw again on a soft 17" : "stand on 17 or more"}. ` +
        "It does not know your bankroll, your level, or how long you have been playing.",
    },
    {
      id: "advice",
      title: "The advice only sees what you see",
      body:
        "Practice runs entirely on this device, so the shoe is stored here too. The code that recommends a " +
        "play reads only your own cards and the dealer's face-up card — never the hole card and never the " +
        "rest of the shoe. Advice that peeked would not be advice.",
    },
    {
      id: "strategy",
      title: "Where the strategy chart comes from",
      body:
        "The recommendations are computed for these exact rules by an expected-value solver, not copied " +
        "from a chart found elsewhere. When the tables have no answer for a situation, you are shown " +
        "nothing rather than a guess.",
    },
    {
      id: "money",
      title: "There is nothing to buy",
      body:
        "Arc 21 sells nothing. There are no chip packages, no subscriptions, no ads and no rewarded videos. " +
        "Because there is nothing to buy, there is nothing that could change your odds if you bought it.",
    },
    {
      id: "chips",
      title: "The chips are not money",
      body:
        "Virtual chips have no monetary value. They cannot be bought, cashed out, withdrawn, transferred, " +
        "or exchanged for money or prizes. Running out costs you nothing, which is the point of practising here.",
    },
  ];
}

/**
 * The limits of this page, stated on the page.
 *
 * A fairness disclosure that only lists reassurances is marketing. These two
 * paragraphs are the ones that make the rest of it worth reading.
 */
export const NO_CERTIFICATION_STATEMENT =
  "Arc 21 has not been tested or certified by any external laboratory, regulator or " +
  "auditor, and this page is not an audit. It is a description of how the code works, " +
  "written to be checked against the code itself.";

export const NO_GUARANTEE_STATEMENT =
  "A fair shuffle is a statement about the process, not a promise about your session. " +
  "Blackjack is dominated by variance in the short run: you can play every hand correctly " +
  "and still lose for a long time. Basic strategy narrows the house edge — it never removes it.";

/**
 * Words that would turn this page into a false claim.
 *
 * Asserted against every string this module produces in
 * `tests/stats/fair-play.test.ts`, so a well-meaning copy edit that adds
 * "independently audited" fails the build instead of shipping.
 */
export const FORBIDDEN_CLAIM_TERMS: readonly string[] = [
  "certified",
  "certification",
  "audited",
  "independent audit",
  "accredited",
  "eCOGRA",
  "iTech Labs",
  "GLI",
  "guaranteed",
  "provably fair",
  "RTP",
  "return to player",
  "licensed",
];
