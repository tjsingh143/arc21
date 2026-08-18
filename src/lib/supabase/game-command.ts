/**
 * Arc 21 — the client half of the authoritative command channel.
 *
 * This is a transport, not a rules engine. It sends an intent and returns what
 * the server decided. It never computes a card, a balance, a legality or an
 * outcome, and it never trusts anything it sent to still be true when the
 * response arrives.
 *
 * The wire contract, mirrored from `shared/contracts` (see the note at the
 * bottom of this file):
 *
 *   request  { gameId, clientActionId, expectedVersion, type, payload, clientSentAt }
 *   response { status: "accepted", publicState, events }
 *            | { status: "stale",    publicState }
 *            | { status: "rejected", code, message }
 *
 * Three things are load-bearing here:
 *
 *   * **No identity in the payload.** There is no `userId` field and there never
 *     will be one. The Edge Function derives identity from the verified JWT; a
 *     client-supplied id would be a request to act as someone else.
 *   * **`clientActionId` is generated per intent, not per attempt.** Retrying a
 *     timed-out bet must reuse the same key so the server returns the first
 *     committed result instead of placing a second bet. `sendGameCommand` takes
 *     the id rather than minting one, precisely so a retry cannot accidentally
 *     get a fresh one.
 *   * **The response is parsed, not cast.** Everything arriving from outside is
 *     untrusted input, including a response that claims to come from our own
 *     server.
 */

import { z } from "zod";

import { supabaseClientOrNull } from "./client.js";
import { isTimedOut, withTimeout, DEFAULT_REQUEST_TIMEOUT_MS } from "./with-timeout.js";

/** The deployed Edge Function that owns the command transaction. */
export const GAME_COMMAND_FUNCTION = "game-command";

export interface GameCommandRequest {
  readonly gameId: string;
  /** Stable across retries of the same intent. See the header. */
  readonly clientActionId: string;
  /** The version the client believes it is acting on. A mismatch returns `stale`. */
  readonly expectedVersion: number;
  readonly type: string;
  readonly payload: Readonly<Record<string, unknown>>;
  /** ISO 8601, informational only — the server's clock is the authority. */
  readonly clientSentAt: string;
}

/**
 * The sanitised snapshot. Structurally `PublicGameState` from
 * `shared/blackjack/public-state.ts`, which is the only function permitted to
 * produce a client-visible payload; it is typed loosely here so this transport
 * does not have to be edited every time the engine adds a public field.
 */
export type PublicStatePayload = Readonly<Record<string, unknown>>;

export type GameCommandResponse =
  | {
      readonly status: "accepted";
      readonly publicState: PublicStatePayload;
      readonly events: readonly Readonly<Record<string, unknown>>[];
    }
  | { readonly status: "stale"; readonly publicState: PublicStatePayload }
  | { readonly status: "rejected"; readonly code: string; readonly message: string };

/**
 * A failure to *reach* a verdict, as distinct from a verdict of "rejected".
 *
 * The difference matters at the call site: a rejection is final and the UI
 * should say why; an unreachable server means the command may or may not have
 * been applied, and the correct response is to re-fetch the authoritative
 * snapshot — never to assume either outcome.
 */
export type GameCommandTransportFailure =
  | { readonly kind: "not-configured"; readonly message: string }
  | { readonly kind: "signed-out"; readonly message: string }
  | { readonly kind: "unreachable"; readonly message: string }
  | { readonly kind: "malformed-response"; readonly message: string };

export type GameCommandOutcome =
  | { readonly ok: true; readonly response: GameCommandResponse }
  | { readonly ok: false; readonly failure: GameCommandTransportFailure };

/**
 * Loose on the snapshot, strict on the envelope.
 *
 * The envelope is the part this module reasons about, so it is validated
 * exactly. The snapshot is passed straight through to the engine-facing layer,
 * which has its own types; re-declaring every public field here would create a
 * second definition of the public shape that could drift from the first.
 */
const publicStateSchema = z.looseObject({});

const responseSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("accepted"),
    publicState: publicStateSchema,
    events: z.array(z.looseObject({})),
  }),
  z.object({
    status: z.literal("stale"),
    publicState: publicStateSchema,
  }),
  z.object({
    status: z.literal("rejected"),
    code: z.string().min(1).max(64),
    message: z.string().max(500),
  }),
]);

/**
 * Sends one command and returns the server's verdict.
 *
 * Requires a session: a guest has no server identity and therefore no game to
 * command. That check is a courtesy to the UI, not a security control — the
 * Edge Function authenticates independently and would refuse an anonymous call
 * regardless.
 */
export async function sendGameCommand(
  request: GameCommandRequest,
  options: { readonly timeoutMs?: number } = {},
): Promise<GameCommandOutcome> {
  const client = supabaseClientOrNull();
  if (client === null) {
    return {
      ok: false,
      failure: {
        kind: "not-configured",
        message: "This build has no server configured, so online play is unavailable.",
      },
    };
  }

  const sessionResult = await withTimeout(client.auth.getSession(), options.timeoutMs);
  if (isTimedOut(sessionResult) || sessionResult.data.session === null) {
    return {
      ok: false,
      failure: { kind: "signed-out", message: "Sign in to play at a server table." },
    };
  }

  const invocation = await withTimeout(
    client.functions.invoke(GAME_COMMAND_FUNCTION, { body: request }),
    options.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
  );

  if (isTimedOut(invocation)) {
    return {
      ok: false,
      failure: {
        kind: "unreachable",
        message: "The server did not answer in time. Your table will be re-synced.",
      },
    };
  }

  if (invocation.error) {
    return {
      ok: false,
      failure: {
        kind: "unreachable",
        // The raw error is deliberately not surfaced: it can carry internal
        // detail, and none of it helps a player decide what to do next.
        message: "Could not reach the server. Your table will be re-synced.",
      },
    };
  }

  const parsed = responseSchema.safeParse(invocation.data);
  if (!parsed.success) {
    return {
      ok: false,
      failure: {
        kind: "malformed-response",
        message: "The server sent something this version does not understand.",
      },
    };
  }

  return { ok: true, response: parsed.data as GameCommandResponse };
}

/**
 * NOTE ON `shared/contracts`.
 *
 * The request and response types above are written to the exact shape the
 * contract module defines, so when `shared/contracts` lands these aliases can be
 * replaced by imports with no change at any call site — TypeScript's structural
 * typing means the two descriptions are already the same type. They are declared
 * locally today only so this module compiles before that file exists; they are
 * not a second source of truth for the protocol, and the server's definition
 * wins in every disagreement.
 */
