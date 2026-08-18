/**
 * The engine primitives the strategy module needs, re-exported at a depth the
 * Edge runtime can resolve.
 *
 * `supabase/functions/_shared/*.ts` reaching `../../../shared/blackjack/index.js`
 * is the specifier form the Supabase CLI already walks and bind-mounts. The same
 * import from one directory deeper — `../../../../shared/blackjack/rules.js` —
 * fails with "no such file or directory", so the strategy module goes through
 * this file instead of reaching out itself.
 *
 * Nothing is reimplemented here. It is a re-export list and nothing else, so
 * there is still exactly one definition of every function it names.
 */

export {
  ARC_STANDARD_RULES,
  cardValue,
  evaluateHand,
  isSplitEligible,
  rulesetKey,
} from "../../../shared/blackjack/index.js";

export type {
  BlackjackRules,
  Card,
  PlayerActionType,
  SplitPolicy,
} from "../../../shared/blackjack/index.js";
