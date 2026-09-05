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
  engineEventsOf,
  seqRangeOf,
  type TableCommand,
  type TableEvents,
  type TableFailure,
  type TableGateway,
  type TableSnapshotOutcome,
  type TableStackResetOutcome,
} from "./online-table-gateway.js";

export {
  BROKE_AT_PRIVATE_TABLE_BODY,
  BROKE_AT_PRIVATE_TABLE_TITLE,
  mayResetPrivateStack,
  RESET_PRIVATE_STACK_LABEL,
  type BrokeSeatView,
} from "./broke-affordance.js";

export {
  COUNTDOWN_TICK_MS,
  deadlineAwaitsSeat,
  describeDeadline,
  secondsUntilDeadline,
  shouldRequestTimeoutResolution,
  TIMEOUT_RESOLVE_GRACE_MS,
  TIMEOUT_RETRY_MS,
} from "./table-deadline.js";

export {
  activeTableGateway,
  isMyTurn,
  ownSeat,
  SEAT_CLOSED_MESSAGE,
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
  resolveTableSeat,
  resumeTargetFor,
  type ActiveSession,
  type ActiveSessionMode,
  type ResumeTarget,
  type TableSeatResolution,
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

export {
  describeSeatBetting,
  seatPresence,
  type SeatPresence,
  type SeatPresenceView,
} from "./seat-presence.js";
