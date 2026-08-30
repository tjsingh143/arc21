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

export { insuranceOffer, type InsuranceOffer } from "./insurance-affordance.js";

export {
  ACTIVE_SESSION_MODES,
  ACTIVE_SESSION_ROUTE,
  canResume,
  describeActiveSession,
  describeActiveSessionMode,
  parseActiveSession,
  parseActiveSessionRows,
  resumeTargetFor,
  type ActiveSession,
  type ActiveSessionMode,
  type ResumeTarget,
} from "./active-session.js";

export {
  activeSessionGateway,
  createSupabaseActiveSessionGateway,
  createUnconfiguredActiveSessionGateway,
  selectActiveSession,
  setActiveSessionGateway,
  useActiveSessionStore,
  type ActiveSessionGateway,
  type ActiveSessionOutcome,
  type ActiveSessionStatus,
  type ActiveSessionStoreState,
} from "./active-session-store.js";

export {
  describeDealerUpCardForAnnouncement,
  describeOutcomeForAnnouncement,
  YOUR_TURN_ANNOUNCEMENT,
} from "./outcome-announcement.js";
