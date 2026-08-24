/**
 * Private tables.
 *
 * No export here can move a chip. Seats start on a fixed session stack and
 * those chips cannot reach a wallet — the anti-collusion rule, enforced by the
 * database and reflected in the absence of any buy-in or cash-out call.
 */

export {
  ROOM_CODE_LENGTH,
  ROOM_CODE_PATTERN,
  looksLikeRoomCode,
  normaliseRoomCode,
  toRoom,
  toRoomState,
  type Room,
  type RoomMember,
  type RoomState,
} from "./rooms.js";

export {
  createSupabaseRoomsGateway,
  createUnconfiguredRoomsGateway,
  type RoomsGateway,
  type RoomsFailure,
  type RoomOutcome,
  type RoomStateOutcome,
  type RoomStartOutcome,
  type RoomLookupOutcome,
  type RoomRemovalOutcome,
} from "./rooms-gateway.js";

export {
  activeRoomsGateway,
  setRoomsGateway,
  useRoomsStore,
  type RoomsStatus,
  type RoomsStoreState,
} from "./rooms-store.js";

/**
 * The lobby's predicates live apart from both the store and the screen, so the
 * question "may this control be offered?" can be asserted without a renderer.
 */
export {
  canRemoveMember,
  canSetReady,
  canStartTable,
  describeInviteUnavailable,
  describeReadiness,
  inviteAffordance,
  isHost,
  isReady,
  shareMessage,
  type InviteAffordance,
} from "./lobby-affordance.js";
export { useRoomInvites, type RoomInvitesState } from "./use-room-invites.js";
