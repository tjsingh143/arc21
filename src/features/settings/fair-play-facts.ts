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
import {
  RECOVERY_GRANT_COOLDOWN_MS,
  RECOVERY_GRANT_THRESHOLD,
} from "../wallet/recovery-grant.js";

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

export interface ResponsiblePlayStatement {
  id: string;
  title: string;
  body: string;
}

/**
 * Playing responsibly — a SHIPPED surface, not only store copy.
 *
 * A simulated casino game owes the player this whether or not a store asks for
 * it, and the store will ask. Every statement below is checkable against the
 * repository, exactly like `fairPlayClaims`:
 *
 *   adults      → the onboarding disclosure, which states 18+ before play
 *   not-a-bet   → no purchase, cash-out or prize path exists anywhere
 *   no-transfer → NO_PROFIT_CLAIM, and the solver that computes the advice
 *   broke       → `RECOVERY_GRANT_THRESHOLD` / `RECOVERY_GRANT_COOLDOWN_MS`
 *   no-pressure → no login streak and no consecutive-day bonus exists; the one
 *                 reminder is scheduled on the device and has a Settings switch
 *   help        → deliberately names no service, claims no affiliation
 *
 * The last one is the one to be careful with. Arc 21 has no relationship with
 * any support organisation, so it must not imply one, must not print a number
 * it cannot keep correct in every country, and must not present itself as help.
 * Saying plainly that it is a simulation and not a treatment is the honest
 * version of this paragraph.
 */
export function responsiblePlayStatements(): ResponsiblePlayStatement[] {
  const cooldownHours = Math.round(RECOVERY_GRANT_COOLDOWN_MS / 3_600_000);

  return [
    {
      id: "adults",
      title: "For adults",
      body:
        "Arc 21 is intended for players aged 18 and over. It simulates a casino game, " +
        "and it says so before the first hand is dealt.",
    },
    {
      id: "not-a-bet",
      title: "Nothing here is a bet",
      body:
        "No money enters or leaves this app. There is nothing to buy, no way to cash out, " +
        "no prizes, and no advantage that could be paid for. A wager here moves virtual " +
        "chips between your own stack and a simulated table and nothing else.",
    },
    {
      id: "no-transfer",
      title: "This does not transfer to real money",
      body:
        "Playing well here does not improve your chances of winning money anywhere else. " +
        "Basic strategy narrows the house edge; it never removes it, and no run of results " +
        "here predicts a run of results somewhere real.",
    },
    {
      id: "broke",
      title: "Running out costs you nothing",
      body:
        `If your bankroll falls below ${RECOVERY_GRANT_THRESHOLD.toLocaleString("en-GB")} chips, a Recovery Grant ` +
        `restores it, once every ${cooldownHours} hours. You cannot buy your way back, because ` +
        "there is nothing to buy — and Practice never touches your bankroll at all.",
    },
    {
      id: "no-pressure",
      title: "Nothing here is designed to keep you playing",
      body:
        "There is no login streak, no bonus for consecutive days, and nothing is taken away " +
        "for not playing. The one reminder Arc 21 sends is scheduled on your own device and " +
        "can be switched off in Settings.",
    },
    {
      id: "help",
      title: "If real gambling is causing you harm",
      body:
        "Arc 21 is a simulation, not treatment and not advice, and it is not affiliated with " +
        "any support organisation. If gambling with real money is affecting you or someone " +
        "close to you, a national support service is the right place to look — not this app.",
    },
  ];
}

/**
 * The one-line disclosure that sits at the foot of Home, Profile, Statistics
 * and Fair Play.
 *
 * It was typed out four times, and `app.json` carried a FIFTH wording that no
 * code read at all — "cannot be redeemed", with the "for money or prizes"
 * dropped. Four copies drift slowly; a copy nothing renders drifts silently,
 * and it is the one a store listing would most likely be written from.
 * `tests/stats/fair-play.test.ts` pins `app.json` to this constant so the
 * config and the app cannot say different things.
 */
export const CHIPS_NOT_MONEY_FOOTER =
  "Simulated card game. Virtual chips have no monetary value and cannot be " +
  "redeemed for money or prizes.";

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
