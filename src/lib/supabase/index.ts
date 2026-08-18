/**
 * Arc 21 — Supabase wiring.
 *
 * `auto-refresh.ts` is deliberately NOT re-exported: it imports React Native, and
 * this barrel is imported by runtime-neutral modules that are unit-tested in a
 * plain Node process. Screens import it directly.
 */

export {
  describeConfigProblems,
  readEnvConfig,
  readSupabaseConfig,
  looksLikeServerSecret,
  type SupabaseConfig,
  type SupabaseConfigProblem,
} from "./config.js";

export {
  buildAvailability,
  getSupabase,
  isSupabaseConfigured,
  setSupabaseAvailabilityForTests,
  supabaseClientOrNull,
  type ArcSupabaseClient,
  type SupabaseAvailability,
} from "./client.js";

export {
  ChunkedSecureSessionStorage,
  createSecureSessionStorage,
  EphemeralSessionStorage,
  type SecureStoreLike,
  type SupportedStorage,
} from "./secure-session-storage.js";

export {
  GAME_COMMAND_FUNCTION,
  sendGameCommand,
  type GameCommandOutcome,
  type GameCommandRequest,
  type GameCommandResponse,
  type GameCommandTransportFailure,
} from "./game-command.js";

export { isGuestId, newClientActionId, newGuestId, randomUuid } from "./ids.js";

export {
  DEFAULT_REQUEST_TIMEOUT_MS,
  isTimedOut,
  TIMED_OUT,
  withTimeout,
  type TimedOut,
} from "./with-timeout.js";

export type {
  Database,
  LedgerReason,
  ProfileRow,
  WalletLedgerRow,
  WalletRow,
} from "./database.types.js";
