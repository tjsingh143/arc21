/**
 * Arc 21 — rule configuration.
 *
 * Every rule-dependent decision in the product flows through a `BlackjackRules`
 * value. Do not scatter rule assumptions (deck count, S17, payout ratios,
 * surrender availability) into components, server handlers or strategy code —
 * read them from the ruleset that is in force for the session.
 *
 * Strategy tables are keyed to `id` + `version`. Changing any rule that alters
 * basic strategy MUST bump `version`, otherwise stale advice will be served.
 */

// Value import into a module that shoe.ts imports back from — but shoe.ts only
// takes a *type* from here, which is erased at runtime, so there is no cycle.
import { assertPenetrationIsCoherent } from "./shoe.js";

export type SplitPolicy = "same_value" | "same_rank";

export interface BlackjackRules {
  id: string;
  version: number;

  deckCount: number;

  dealerHitsSoft17: boolean;
  dealerHoleCard: boolean;
  dealerPeeksForBlackjack: boolean;

  blackjackPayoutNumerator: number;
  blackjackPayoutDenominator: number;

  insuranceAllowed: boolean;
  insuranceFractionNumerator: number;
  insuranceFractionDenominator: number;
  insurancePayoutNumerator: number;
  insurancePayoutDenominator: number;

  lateSurrenderAllowed: boolean;

  doubleAllowed: boolean;
  doubleOnAnyTwoCards: boolean;
  doubleAfterSplit: boolean;

  splitPolicy: SplitPolicy;
  maxSplitHands: number;

  splitAcesAllowed: boolean;
  resplitAcesAllowed: boolean;
  hitSplitAcesAllowed: boolean;
  doubleSplitAcesAllowed: boolean;
  splitAceTwentyOneIsBlackjack: boolean;

  /** Fraction of the shoe dealt before the cut card. */
  targetPenetration: number;

  minBet: number;
  maxBet: number;
  betIncrement: number;

  /**
   * Whether seats bet ONE AT A TIME, in seating order, or all at once.
   *
   * A posted table property, like the bet band above it — not a rule of
   * blackjack. It changes who may stake chips at a given moment and nothing
   * about what a hand is worth, so it does NOT alter basic strategy and does not
   * bump `version`; the strategy tables keyed to `id@version` are untouched by
   * it.
   *
   * False everywhere except the Sprint Tournament, where the specification is
   * explicit that betting is "sequential and visible" with a bet timer of
   * "7 seconds/person", because tournament strategy derives partly from seeing
   * what the players before you have committed. With it false, every seat may
   * stake at any moment during BETTING_OPEN and one shared clock covers them
   * all, which is what an ordinary casino table does.
   *
   * Optional so that engine states persisted before it existed load unchanged —
   * the same reason `SeatState.sitOutNextHand` is optional.
   */
  sequentialBetting?: boolean;
}

/**
 * The Arc Standard ruleset — a legitimate player-friendly six-deck family.
 * This is a product choice, not a universal definition of blackjack.
 */
export const ARC_STANDARD_RULES: BlackjackRules = {
  id: "arc-standard",
  version: 1,

  deckCount: 6,

  dealerHitsSoft17: false,
  dealerHoleCard: true,
  dealerPeeksForBlackjack: true,

  blackjackPayoutNumerator: 3,
  blackjackPayoutDenominator: 2,

  insuranceAllowed: true,
  insuranceFractionNumerator: 1,
  insuranceFractionDenominator: 2,
  insurancePayoutNumerator: 2,
  insurancePayoutDenominator: 1,

  lateSurrenderAllowed: true,

  doubleAllowed: true,
  doubleOnAnyTwoCards: true,
  doubleAfterSplit: true,

  splitPolicy: "same_value",
  maxSplitHands: 4,

  splitAcesAllowed: true,
  resplitAcesAllowed: false,
  hitSplitAcesAllowed: false,
  doubleSplitAcesAllowed: false,
  splitAceTwentyOneIsBlackjack: false,

  targetPenetration: 0.75,

  minBet: 50,
  maxBet: 1000,
  betIncrement: 10,

  // Stated rather than left to the optional's default: an ordinary Arc 21 table
  // takes bets from every seat at once.
  sequentialBetting: false,
};

/** Table tiers differ only in stakes; all other rules stay identical. */
export interface TableTier {
  id: "casual" | "standard" | "high";
  label: string;
  buyIn: number;
  minBet: number;
  maxBet: number;
  unlockLevel: number;
}

/**
 * A private table's fixed session stack.
 *
 * Every seat starts here and nothing moves in or out — no buy-in, no cash-out,
 * no ledger entry. That is the anti-collusion rule: if chips could travel
 * between a private table and the global wallet, two accounts could transfer a
 * bankroll by agreeing to lose, and every leaderboard downstream would be
 * meaningless. A player who busts may reset to this figure between hands,
 * because the chips are unranked and worth nothing outside the room.
 */
export const PRIVATE_TABLE_STACK = 5_000;

/** Stakes for a private table. Unranked, so the band is deliberately gentle. */
export const PRIVATE_TABLE_MIN_BET = 20;
export const PRIVATE_TABLE_MAX_BET = 500;

/** Arc Standard at private-table stakes. Rules never differ, only the band. */
export function privateTableRules(): BlackjackRules {
  return {
    ...ARC_STANDARD_RULES,
    minBet: PRIVATE_TABLE_MIN_BET,
    maxBet: PRIVATE_TABLE_MAX_BET,
  };
}

/*
 * AN AI TABLE: one person and computer-controlled seats, unranked.
 *
 * Every figure that shapes one lives here, beside the private table's, because
 * they are the same kind of fact — what a table posts and what a seat starts
 * on — and one place to change them is the point. Nothing here is a rule of
 * blackjack: the cards, the dealer and every payout are Arc Standard, which is
 * why `aiTableRules` changes the bet band and nothing else, and why the solved
 * strategy chart keyed to `arc-standard@1` still applies (the band is excluded
 * from `StrategyRulesSummary` for exactly this reason).
 *
 * A CLOSED ECONOMY, like a private table: every seat — the player's and each
 * computer player's — starts on `AI_TABLE_STACK` chips that come from nowhere,
 * stay at the table and vanish with it. No buy-in, no cash-out, no ledger row.
 * If the player's chips could leave an AI table, beating a computer player
 * would be a way to mint wallet chips; see `session-economics.ts`.
 */

/** Every seat's starting stack, the player's and each computer player's. */
export const AI_TABLE_STACK = 5_000;

/** The private table's gentle band, for the same reason: the chips are unranked. */
export const AI_TABLE_MIN_BET = 20;
export const AI_TABLE_MAX_BET = 500;

/**
 * Seats at an AI table, the player's included: the player and two computer
 * players. Within the 2–5 shape of the shared tables, and small enough that
 * every seat stays readable on a phone.
 */
export const AI_TABLE_SEAT_COUNT = 3;

/**
 * Where the player sits, zero-based in dealing order: the middle.
 *
 * Deliberate. With a computer player on each side, every hand has one acting
 * BEFORE the player and one AFTER, so the table hands the turn to the player
 * and takes it back again exactly as a full table would.
 */
export const AI_TABLE_PLAYER_SEAT_INDEX = 1;

/** Arc Standard at AI-table stakes. Rules never differ, only the band. */
export function aiTableRules(): BlackjackRules {
  return {
    ...ARC_STANDARD_RULES,
    minBet: AI_TABLE_MIN_BET,
    maxBet: AI_TABLE_MAX_BET,
  };
}

export const TABLE_TIERS: readonly TableTier[] = [
  { id: "casual", label: "Casual", buyIn: 2_000, minBet: 20, maxBet: 500, unlockLevel: 1 },
  { id: "standard", label: "Standard", buyIn: 5_000, minBet: 50, maxBet: 1_000, unlockLevel: 1 },
  { id: "high", label: "High", buyIn: 20_000, minBet: 200, maxBet: 5_000, unlockLevel: 10 },
];

export function rulesForTier(tier: TableTier, base: BlackjackRules = ARC_STANDARD_RULES): BlackjackRules {
  return { ...base, minBet: tier.minBet, maxBet: tier.maxBet };
}

/**
 * Stable identity for strategy-table lookups and stat bucketing.
 * Two rulesets producing the same key must produce the same basic strategy.
 */
export function rulesetKey(rules: BlackjackRules): string {
  return `${rules.id}@${rules.version}`;
}

/**
 * Guards against configurations the engine's integer money model cannot settle
 * exactly. Called at session construction so a bad config fails loudly and
 * early rather than silently rounding chips away from players.
 */
export function assertRulesAreCoherent(rules: BlackjackRules): void {
  const problems: string[] = [];

  if (rules.deckCount < 1 || !Number.isInteger(rules.deckCount)) {
    problems.push("deckCount must be a positive integer");
  }
  if (rules.betIncrement < 1 || !Number.isInteger(rules.betIncrement)) {
    problems.push("betIncrement must be a positive integer");
  }
  if (rules.minBet % rules.betIncrement !== 0) {
    problems.push("minBet must be a multiple of betIncrement");
  }
  if (rules.maxBet % rules.betIncrement !== 0) {
    problems.push("maxBet must be a multiple of betIncrement");
  }
  if (rules.minBet > rules.maxBet) {
    problems.push("minBet must not exceed maxBet");
  }
  if (rules.maxSplitHands < 1) {
    problems.push("maxSplitHands must be at least 1");
  }
  if (rules.targetPenetration <= 0 || rules.targetPenetration >= 1) {
    problems.push("targetPenetration must be strictly between 0 and 1");
  }
  if (rules.dealerHoleCard === false && rules.dealerPeeksForBlackjack) {
    problems.push("cannot peek without a hole card");
  }

  /*
   * The engine has no model of "double on 9-11 only".
   *
   * `doubleOnAnyTwoCards: false` reads like a restriction to certain totals, and
   * that is what a future ruleset author would mean by it — but `getLegalActions`
   * has no allowlist to consult, so the flag does not restrict doubling, it
   * REMOVES it. A table advertising "double on 9, 10 and 11" that in fact offers
   * no double at all is exactly the silent divergence this guard exists to stop.
   * Model the restriction first, then relax this check.
   */
  if (rules.doubleAllowed && !rules.doubleOnAnyTwoCards) {
    problems.push(
      "doubleOnAnyTwoCards: false does not restrict doubling to certain totals — " +
        "the engine models no such allowlist, so it disables doubling entirely. " +
        "Set doubleAllowed: false to mean that, or add the allowlist first",
    );
  }

  /*
   * Split aces that may be hit are ordinary split hands, and a hand that keeps
   * drawing has no "exactly one card" rule to break. But split aces that may NOT
   * be hit are completed by the engine the instant they receive their card, so a
   * ruleset that forbids hitting them and permits doubling them is asking for a
   * decision the player will never be offered.
   */
  if (rules.splitAcesAllowed && rules.doubleSplitAcesAllowed && !rules.hitSplitAcesAllowed) {
    problems.push(
      "doubleSplitAcesAllowed requires hitSplitAcesAllowed: a split ace that " +
        "cannot be hit is completed on its one card and never offered a decision",
    );
  }

  // A blackjack payout on the minimum bet must be exact, or the house is
  // quietly shaving chips off every natural.
  const bjProfit = (rules.minBet * rules.blackjackPayoutNumerator) / rules.blackjackPayoutDenominator;
  if (!Number.isInteger(bjProfit)) {
    problems.push(
      `minBet ${rules.minBet} cannot pay ${rules.blackjackPayoutNumerator}:${rules.blackjackPayoutDenominator} in whole chips`,
    );
  }

  if (problems.length > 0) {
    throw new Error(`Incoherent BlackjackRules "${rules.id}": ${problems.join("; ")}`);
  }

  // Checked last so the clearer field-level messages surface first.
  assertPenetrationIsCoherent(rules);
}
