/**
 * Arc 21 — structured logging.
 *
 * SECURITY.md sets the rule this module enforces mechanically: logs carry game
 * id, session id, state version, command id, event seq, user id and an error
 * code — and they NEVER carry a password, a token, the hidden shoe, an
 * unrevealed hole card, a daily-challenge seed or a service credential.
 *
 * The field set is a closed TypeScript interface rather than a free
 * `Record<string, unknown>`. That is the whole point: you cannot accidentally
 * log an engine state through this function, because engine state is not an
 * assignable value for any field it accepts.
 */

export type CommandOutcome =
  | "accepted"
  | "stale"
  | "rejected"
  | "replayed"
  | "opened"
  | "cashed_out"
  | "private_table_started"
  | "private_stack_reset"
  | "public_seat_taken"
  | "daily_challenge_started"
  | "sprint_registered";

export interface LogFields {
  /** Correlates a client-visible failure with the server-side detail. */
  requestId: string;
  fn: string;
  userId?: string;
  gameId?: string;
  seatId?: string;
  commandId?: string;
  commandType?: string;
  expectedVersion?: number;
  stateVersion?: number;
  firstSeq?: number;
  lastSeq?: number;
  eventCount?: number;
  chipDelta?: number;
  outcome?: CommandOutcome;
  code?: string;
  durationMs?: number;
  /**
   * What a competition boundary decided: a hand number, a bet ceiling, a tie-break
   * count, a placement. Never a card, a shoe position or a hole card — the
   * boundary module has no access to any of them, so there is nothing here for a
   * refactor to widen into a leak.
   */
  boundary?: string;
  /**
   * Why a decision was not graded: a mode, a missing hand, an unpriced cell. Never
   * the recommended action — a diagnostic that named the right play would be a hint
   * leaking through the logs.
   */
  decisionSkipped?: string;
  /**
   * How long a rate-limited caller has to wait. A duration, never the limit's
   * identity or the target of the refused action.
   */
  retryAfterSeconds?: number;
}

function emit(level: "info" | "warn" | "error", message: string, fields: LogFields, detail?: string): void {
  const record: Record<string, unknown> = { level, message, ...fields };
  if (detail !== undefined) {
    // Truncated because an unbounded driver or engine message is the one place
    // an unexpected value could reach a log line.
    record.detail = detail.slice(0, 500);
  }
  const line = JSON.stringify(record);
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}

export function logInfo(message: string, fields: LogFields): void {
  emit("info", message, fields);
}

export function logWarn(message: string, fields: LogFields, detail?: string): void {
  emit("warn", message, fields, detail);
}

/**
 * The only place an unexpected error's text is recorded. It is written to the
 * server log and correlated by `requestId`; the client receives a generic
 * message and that id, never this text.
 */
export function logError(message: string, fields: LogFields, error: unknown): void {
  const detail = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  emit("error", message, fields, detail);
}
