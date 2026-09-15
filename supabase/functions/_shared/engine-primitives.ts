/**
 * The engine primitives the strategy and career modules need, re-exported at a
 * depth the Edge runtime can resolve.
 *
 * `supabase/functions/_shared/*.ts` reaching `../../../shared/blackjack/index.js`
 * is the specifier form the Supabase CLI already walks and bind-mounts. The same
 * import from one directory deeper — `../../../../shared/blackjack/rules.js` —
 * fails with "no such file or directory", so the strategy module goes through
 * this file instead of reaching out itself. `_shared/career` was moved in for
 * the same reason and goes through the same door.
 *
 * Nothing is reimplemented here. It is a re-export list and nothing else, so
 * there is still exactly one definition of every function it names.
 */

export {
  ARC_STANDARD_RULES,
  cardValue,
  evaluateHand,
  getLegalActions,
  isSplitEligible,
  randomIntBelow,
  rulesForTier,
  rulesetKey,
  TABLE_TIERS,
} from "../../../shared/blackjack/index.js";

export type {
  BlackjackGameState,
  BlackjackRules,
  Card,
  PlayerActionType,
  Rank,
  RandomSource,
  SplitPolicy,
  Suit,
} from "../../../shared/blackjack/index.js";
