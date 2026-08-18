/**
 * Arc 21 — error mapping.
 *
 * The contract this module keeps: **nothing internal ever reaches the client.**
 * No SQL text, no driver message, no stack trace, no row contents, no engine
 * message (which interpolates seat ids, phases and, in one branch, the command
 * itself). A caller receives a stable code, a fixed human-readable sentence and
 * a request id it can quote to support.
 *
 * Everything else is logged server-side against that request id.
 */

import { EngineError, type EngineErrorCode } from "../../../shared/blackjack/index.js";
import type {
  CommandRejectionCode,
  RejectedResponse,
} from "../../../shared/contracts/index.js";

/**
 * Fixed public messages, one per code. Deliberately written for a player rather
 * than a developer, and deliberately not derived from the underlying error.
 */
const PUBLIC_MESSAGES: Record<CommandRejectionCode, string> = {
  UNAUTHENTICATED: "Sign in again to continue.",
  NOT_A_PARTICIPANT: "You do not hold a seat at this table.",
  INVALID_REQUEST: "That request was not understood.",
  IDEMPOTENCY_CONFLICT: "That action id has already been used by another account.",
  SESSION_CLOSED: "This table has closed.",
  SESSION_BUSY: "Finish the current hand before leaving the table.",
  SESSION_ALREADY_ACTIVE: "You are already seated at a table.",
  TABLE_LOCKED: "This table is not available at your level yet.",

  WRONG_PHASE: "That action is not available right now.",
  UNKNOWN_SEAT: "You do not hold a seat at this table.",
  NOT_YOUR_TURN: "It is not your turn.",
  ILLEGAL_ACTION: "That action is not legal for this hand.",
  BET_BELOW_MINIMUM: "That bet is below the table minimum.",
  BET_ABOVE_MAXIMUM: "That bet is above the table maximum.",
  BET_NOT_MULTIPLE_OF_INCREMENT: "That bet is not a valid chip amount.",
  INSUFFICIENT_STACK: "You do not have enough chips for that.",
  INSURANCE_NOT_AVAILABLE: "Insurance is not available right now.",
  DEADLINE_NOT_REACHED: "The timer has not expired yet.",
  SHOE_EXHAUSTED: "The hand could not be dealt. No chips were moved.",
  NO_ACTIVE_HAND: "You have no hand to act on.",

  RATE_LIMITED: "Too many requests. Try again in a moment.",
  INTERNAL: "Something went wrong. No chips were moved.",
};

const HTTP_STATUS: Record<CommandRejectionCode, number> = {
  UNAUTHENTICATED: 401,
  NOT_A_PARTICIPANT: 403,
  INVALID_REQUEST: 400,
  IDEMPOTENCY_CONFLICT: 409,
  SESSION_CLOSED: 409,
  SESSION_BUSY: 409,
  SESSION_ALREADY_ACTIVE: 409,
  TABLE_LOCKED: 403,

  WRONG_PHASE: 422,
  UNKNOWN_SEAT: 403,
  NOT_YOUR_TURN: 422,
  ILLEGAL_ACTION: 422,
  BET_BELOW_MINIMUM: 422,
  BET_ABOVE_MAXIMUM: 422,
  BET_NOT_MULTIPLE_OF_INCREMENT: 422,
  INSUFFICIENT_STACK: 422,
  INSURANCE_NOT_AVAILABLE: 422,
  DEADLINE_NOT_REACHED: 422,
  SHOE_EXHAUSTED: 500,
  NO_ACTIVE_HAND: 422,

  RATE_LIMITED: 429,
  INTERNAL: 500,
};

/**
 * `EngineErrorCode` and `CommandRejectionCode` share their spelling for the
 * overlapping members, so this is an identity map rather than a translation
 * layer that could drift. The annotation is what proves it: adding a member to
 * `EngineErrorCode` without adding it to the contract fails to compile.
 */
const ENGINE_CODE_TO_REJECTION: Record<EngineErrorCode, CommandRejectionCode> = {
  WRONG_PHASE: "WRONG_PHASE",
  UNKNOWN_SEAT: "UNKNOWN_SEAT",
  NOT_YOUR_TURN: "NOT_YOUR_TURN",
  ILLEGAL_ACTION: "ILLEGAL_ACTION",
  BET_BELOW_MINIMUM: "BET_BELOW_MINIMUM",
  BET_ABOVE_MAXIMUM: "BET_ABOVE_MAXIMUM",
  BET_NOT_MULTIPLE_OF_INCREMENT: "BET_NOT_MULTIPLE_OF_INCREMENT",
  INSUFFICIENT_STACK: "INSUFFICIENT_STACK",
  INSURANCE_NOT_AVAILABLE: "INSURANCE_NOT_AVAILABLE",
  DEADLINE_NOT_REACHED: "DEADLINE_NOT_REACHED",
  SHOE_EXHAUSTED: "SHOE_EXHAUSTED",
  NO_ACTIVE_HAND: "NO_ACTIVE_HAND",
};

/**
 * A rejection the handler raised on purpose. Its message is chosen from the
 * table above, never supplied by the thrower, so a future `throw new
 * CommandError(code, someDbError.message)` is not expressible.
 */
export class CommandError extends Error {
  readonly code: CommandRejectionCode;
  /** Server-side only. Logged against the request id; never serialised. */
  readonly internalDetail: string | undefined;

  constructor(code: CommandRejectionCode, internalDetail?: string) {
    super(PUBLIC_MESSAGES[code]);
    this.name = "CommandError";
    this.code = code;
    this.internalDetail = internalDetail;
  }

  get httpStatus(): number {
    return HTTP_STATUS[this.code];
  }
}

export function isCommandError(error: unknown): error is CommandError {
  return error instanceof CommandError;
}

/**
 * Normalises anything thrown inside a handler into a rejection code.
 *
 * An `EngineError` maps to its matching code. Everything else — a driver error,
 * a constraint violation, a bug — collapses to INTERNAL, because distinguishing
 * them for the caller would mean describing the server's internals to an
 * adversary.
 */
export function classify(error: unknown): CommandError {
  if (isCommandError(error)) return error;

  if (error instanceof EngineError) {
    return new CommandError(ENGINE_CODE_TO_REJECTION[error.code], `engine: ${error.code}`);
  }

  return new CommandError("INTERNAL");
}

/**
 * Builds the client-visible rejection. `requestId` is appended so a player can
 * quote it and an operator can find the real cause in the logs — it identifies
 * a log line, not a resource.
 */
export function toRejectedResponse(error: CommandError, requestId: string): RejectedResponse {
  return {
    status: "rejected",
    code: error.code,
    message: `${PUBLIC_MESSAGES[error.code]} (ref ${requestId})`,
  };
}
