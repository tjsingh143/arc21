/**
 * Arc 21 — friends.
 *
 * The screens import from here. Nothing outside this folder should reach for
 * `friends-gateway.ts` directly: the gateway boundary is what keeps every
 * relationship a server answer rather than a client opinion, and it is the seam
 * the tests substitute.
 */

export {
  applySearchRelationship,
  blockedPlayerRowSchema,
  describeLastSeen,
  describeRpcFailure,
  friendRequestRowSchema,
  friendRowSchema,
  FRIENDS_ACTION_FAILED,
  MIN_SEARCH_LENGTH,
  presentRequest,
  presentSearchResult,
  presentUnblockConfirmation,
  searchResultRowSchema,
  SEARCH_TOO_SHORT,
  toBlockedPlayers,
  toFriendRequests,
  toFriends,
  toRelationshipState,
  toSearchResults,
  type BlockedPlayer,
  type Friend,
  type FriendRequest,
  type PlayerSummary,
  type Relationship,
  type RelationshipState,
  type RequestPresentation,
  type SearchPresentation,
  type SearchResult,
  type UnblockConfirmation,
} from "./friends.js";

export {
  createSupabaseFriendsGateway,
  createUnconfiguredFriendsGateway,
  type BlockedLoadOutcome,
  type FriendsFailure,
  type FriendsFailureReason,
  type FriendsGateway,
  type FriendsLoadOutcome,
  type FriendsSearchOutcome,
  type RelationshipOutcome,
} from "./friends-gateway.js";

export {
  activeFriendsGateway,
  selectBlocked,
  selectFriend,
  selectFriends,
  selectIncomingRequests,
  selectOutgoingRequests,
  setFriendsGateway,
  shouldShowBlocked,
  useFriendsStore,
  type BlockedStatus,
  type FriendsStatus,
  type FriendsStoreState,
  type SearchStatus,
} from "./friends-store.js";
