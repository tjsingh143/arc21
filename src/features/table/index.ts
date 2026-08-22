/**
 * Server-authoritative tables.
 *
 * Nothing here decides an outcome. The store holds the server's last snapshot
 * and the gateway carries commands to it; every rule is applied on the server
 * by the same engine the client renders.
 */

export {
  createSupabaseTableGateway,
  createUnconfiguredTableGateway,
  type TableCommand,
  type TableFailure,
  type TableGateway,
  type TableSnapshotOutcome,
} from "./online-table-gateway.js";

export {
  activeTableGateway,
  isMyTurn,
  ownSeat,
  setTableGateway,
  useOnlineTableStore,
  type OnlineTableStatus,
  type OnlineTableStoreState,
} from "./online-table-store.js";

export {
  describeDealerUpCardForAnnouncement,
  describeOutcomeForAnnouncement,
  YOUR_TURN_ANNOUNCEMENT,
} from "./outcome-announcement.js";
