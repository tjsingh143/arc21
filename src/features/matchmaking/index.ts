/**
 * Public matchmaking.
 *
 * Nothing here moves a chip. Finding a seat and paying for one are separate
 * steps on purpose — a player who is matched has not yet been charged.
 */

export {
  OFFER_ALTERNATIVES_AFTER_MS,
  describeWait,
  shouldOfferAlternatives,
  toQueuePlace,
  type QueuePlace,
  type QueueStatus,
  type TierId,
} from "./matchmaking.js";

export {
  useMatchmakingStore,
  type MatchmakingStatus,
  type MatchmakingStoreState,
} from "./matchmaking-store.js";
