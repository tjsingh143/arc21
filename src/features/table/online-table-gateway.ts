/**
 * Talking to a server-authoritative table.
 *
 * Two methods: read the snapshot, and send a command. Neither can decide
 * anything — a command names an action and the version it believes it is acting
 * on, and the server decides whether that is legal, whether it is this seat's
 * turn, and what the table looks like afterwards.
 *
 * `clientActionId` is generated once per INTENT and reused by every attempt at
 * it. That is what makes a retry safe: the server returns the first committed
 * result for a repeated id rather than applying the action twice, so a flaky
 * connection cannot double-hit a hand.
 *
 * This comment used to say the opposite — "generated per attempt and never
 * reused" — above code that called `crypto.randomUUID()` inside the send. It
 * was harmless only because nothing retried: one intent made one attempt, so
 * the key was per-intent by accident. `newClientActionId()` had existed since
 * the identifier module was written, carrying this exact warning in its own
 * doc comment, and had never been called by anything but a uniqueness test.
 * Adding backoff below is what would have turned that into a second bet.
 *
 * **Retry only when no verdict arrived.** A response this function can parse as
 * a rejection is the server's answer and the command definitively did not apply
 * — the handler is one transaction and a rejection rolls it back. Asking again
 * would at best waste a round trip and at worst hammer a server that is already
 * refusing (`RATE_LIMITED` is a rejection, and is not retried). Silence is the
 * only outcome worth repeating, because silence is the only one where the
 * client does not know what happened.
 */

import { z } from "zod";

import {
  publicGameEventSchema,
  publicGameStateSchema,
  type ContractEngineEvent,
  type ContractPublicGameState,
} from "../../../shared/contracts/index.js";
import type { PublicGameState } from "../../../shared/blackjack/index.js";
import type { ArcSupabaseClient } from "../../lib/supabase/client.js";
import { newClientActionId } from "../../lib/supabase/ids.js";
import { isTimedOut, withTimeout } from "../../lib/supabase/with-timeout.js";
import { retryWhile, type BackoffPolicy } from "../../lib/supabase/with-retry.js";

export type TableFailureReason =
  | "not-configured"
  | "signed-out"
  /** The server answered and refused — wrong turn, illegal action, stale. */
  | "refused"
  | "unreachable";

export interface TableFailure {
  readonly ok: false;
  readonly reason: TableFailureReason;
  readonly message: string;
  /**
   * The contract's rejection code, when the server sent one.
   *
   * Present only on `refused`. Carried so the store can tell a rate limit from
   * an illegal move without matching on prose, and absent on every transport
   * failure — where the point is precisely that no code arrived.
   */
  readonly code?: string;
}

/**
 * The events that produced this snapshot, when the server sent any.
 *
 * Carried alongside the state rather than derived from it. Feedback — a card
 * sound, a win haptic — must describe what the server said happened, and a diff
 * between two snapshots cannot tell a second card of a deal from a redraw.
 */
export type TableEvents = readonly ContractEngineEvent[];

export type TableSnapshotOutcome =
  | { readonly ok: true; readonly state: PublicGameState; readonly events: TableEvents }
  | TableFailure;

export interface TableCommand {
  readonly type: string;
  readonly expectedVersion: number;
  readonly payload: Record<string, unknown>;
}

/**
 * How much effort one call may spend before reporting back.
 *
 * `retry: false` is for the table's three-second poll, which is already a retry
 * loop — stacking backoff inside it would leave several polls in flight at once
 * against a server that is struggling. Everything else defaults to retrying,
 * because everything else is a one-shot the player is waiting on.
 *
 * `onRetry` fires the moment an attempt comes back with no verdict, so the
 * screen can say "reconnecting" while the backoff is still running rather than
 * thirty seconds later when it gives up.
 */
export interface TableCallOptions {
  readonly retry?: boolean;
  readonly onRetry?: () => void;
}

/**
 * What came back from a cash-out.
 *
 * `walletBalance` is the server's number after the credit, not one this client
 * computed — the whole point of the escrow is that the client never arithmetics
 * its way to a balance.
 */
export type TableCashOutOutcome =
  | { readonly ok: true; readonly walletBalance: number | null }
  | TableFailure;

export interface TableGateway {
  readonly kind: "supabase" | "unconfigured" | "fake";
  snapshot(gameId: string, options?: TableCallOptions): Promise<TableSnapshotOutcome>;
  /**
   * Close this seat and return the remaining stack to the wallet.
   *
   * `CASH_OUT` has existed and been tested on the server since phase 5, and
   * nothing in this app has ever sent it — so a player who left a table left
   * their stack behind, permanently, while the screen promised "whatever is
   * left comes back when you leave". The server refuses mid-hand (SESSION_BUSY)
   * and is idempotent per `gameId:seatId`, so a retry cannot credit twice.
   */
  cashOut(gameId: string): Promise<TableCashOutOutcome>;
  command(
    gameId: string,
    command: TableCommand,
    options?: TableCallOptions,
  ): Promise<TableSnapshotOutcome>;
  /**
   * Listen for the server's post-commit broadcast.
   *
   * Returns an unsubscribe function. The handler receives states that were
   * already committed — the server broadcasts AFTER commit precisely so a
   * client never renders a hand that then rolls back.
   */
  subscribe(
    gameId: string,
    onState: (state: PublicGameState, events: TableEvents) => void,
  ): () => void;
}

/**
 * The wording is load-bearing, not decorative.
 *
 * The specification's rule for a lost connection is that the client must not
 * locally assume the hand stopped: the server's clock is still running and its
 * timeout defaults — stand, decline insurance — will be applied whether or not
 * this phone is listening. Telling a player "no connection" and leaving them to
 * infer the rest invites them to assume the hand is paused, which is the one
 * thing that is not true.
 */
const UNREACHABLE = "Could not reach the table. The hand continues on the server.";
const SIGNED_OUT = "Sign in to play at a table.";
const UNREADABLE = "The table sent something this app could not read.";

export function createUnconfiguredTableGateway(message: string): TableGateway {
  const refuse = async () => ({ ok: false as const, reason: "not-configured" as const, message });
  return {
    kind: "unconfigured",
    snapshot: refuse,
    command: refuse,
    cashOut: refuse,
    subscribe: () => () => undefined,
  };
}

/**
 * A response carrying a snapshot, whether it was accepted or rejected as stale.
 *
 * A `stale` answer is not an error to show a player: it means someone else
 * acted first, and the payload is the authoritative table. Adopting it is how a
 * client that missed an update catches up.
 */
const responseSchema = z.object({
  status: z.string(),
  publicState: publicGameStateSchema.optional(),
  events: z.array(publicGameEventSchema).optional(),
  message: z.string().optional(),
});

/** What the server fans out after a command commits. */
const broadcastSchema = z.object({
  publicState: publicGameStateSchema,
  events: z.array(publicGameEventSchema).optional(),
});

function readState(
  body: unknown,
): { state: PublicGameState; events: TableEvents } | null {
  const parsed = responseSchema.safeParse(body);
  if (!parsed.success || !parsed.data.publicState) return null;
  // The contract schema and the engine type are the same shape; the schema is
  // what proves the bytes matched it.
  return {
    state: parsed.data.publicState as ContractPublicGameState as PublicGameState,
    // Unwrapped from their ordering envelope: feedback cares what happened, and
    // the sequence numbers are the store's concern.
    events: (parsed.data.events ?? []).map((published) => published.event),
  };
}

/**
 * The rejection envelope, as `toRejectedResponse` builds it on the server.
 *
 * A rejection arrives with the contract's own HTTP status — 409, 422, 429 —
 * so `functions.invoke` reports it as an error and hands back the `Response`
 * rather than the body. Parsing it here is what distinguishes "the server
 * answered and said no" from "nothing answered", which is the distinction the
 * whole retry decision rests on.
 */
const rejectionSchema = z.object({
  status: z.literal("rejected"),
  code: z.string().min(1).max(64),
  message: z.string().min(1).max(500),
});

/** A Response, structurally — `FunctionsFetchError` carries something else. */
function responseLike(value: unknown): { json: () => Promise<unknown> } | null {
  if (typeof value !== "object" || value === null) return null;
  const candidate = value as { json?: unknown };
  return typeof candidate.json === "function"
    ? (value as { json: () => Promise<unknown> })
    : null;
}

/**
 * The server's verdict, or null when nothing recognisable came back.
 *
 * Null is the important return: a 503 from the API gateway with the Edge
 * runtime down, an HTML error page from a captive portal, or a body that fails
 * the schema all mean the same thing — this client did not learn what happened
 * to its command, and must not pretend otherwise.
 */
async function readRejection(
  error: unknown,
): Promise<{ code: string; message: string } | null> {
  const context = responseLike((error as { context?: unknown } | null)?.context);
  if (context === null) return null;

  let body: unknown;
  try {
    body = await context.json();
  } catch {
    return null;
  }

  const parsed = rejectionSchema.safeParse(body);
  return parsed.success ? { code: parsed.data.code, message: parsed.data.message } : null;
}

export function createSupabaseTableGateway(
  client: ArcSupabaseClient,
  options: { readonly timeoutMs?: number; readonly policy?: BackoffPolicy } = {},
): TableGateway {
  const { timeoutMs, policy } = options;

  async function bounded<T>(work: PromiseLike<T>): Promise<T | null> {
    const result = await withTimeout(Promise.resolve(work), timeoutMs);
    return isTimedOut(result) ? null : result;
  }

  async function requireSession(): Promise<TableFailure | null> {
    const session = await bounded(client.auth.getSession());
    if (session === null) return { ok: false, reason: "unreachable", message: UNREACHABLE };
    if (!session.data.session) return { ok: false, reason: "signed-out", message: SIGNED_OUT };
    return null;
  }

  /**
   * One attempt at one command.
   *
   * `clientActionId` is a parameter rather than something this function mints,
   * so every attempt at a given intent presents the same key and the server's
   * idempotency record can do its job. See the file header.
   */
  async function attempt(
    gameId: string,
    command: TableCommand,
    clientActionId: string,
  ): Promise<TableSnapshotOutcome> {
    const result = await bounded(
      client.functions.invoke("game-command", {
        body: {
          gameId,
          clientActionId,
          expectedVersion: command.expectedVersion,
          type: command.type,
          payload: command.payload,
          clientSentAt: new Date().toISOString(),
        },
      }),
    );
    if (result === null) return { ok: false, reason: "unreachable", message: UNREACHABLE };

    if (result.error) {
      const rejection = await readRejection(result.error);
      // No parseable verdict means the command's fate is unknown, not refused.
      // Reporting "that move was not accepted" here would be a guess, and the
      // wrong one whenever the server committed and the answer went missing.
      if (rejection === null) {
        return { ok: false, reason: "unreachable", message: UNREACHABLE };
      }
      // The server's own public wording, which is written for players and
      // already carries a request reference for support.
      return {
        ok: false,
        reason: "refused",
        message: rejection.message,
        code: rejection.code,
      };
    }

    const read = readState(result.data);
    if (!read) return { ok: false, reason: "unreachable", message: UNREADABLE };
    return { ok: true, state: read.state, events: read.events };
  }

  async function send(
    gameId: string,
    command: TableCommand,
    sendOptions: { readonly retry?: boolean; readonly onRetry?: () => void } = {},
  ): Promise<TableSnapshotOutcome> {
    const denied = await requireSession();
    if (denied) return denied;

    // Minted ONCE, here, outside the retry loop. Moving this line inside
    // `attempt` is how a retried bet becomes two bets.
    const clientActionId = newClientActionId();

    if (sendOptions.retry === false) {
      return await attempt(gameId, command, clientActionId);
    }

    const { value } = await retryWhile(
      () => attempt(gameId, command, clientActionId),
      (outcome) => !outcome.ok && outcome.reason === "unreachable",
      {
        ...(policy ? { policy } : {}),
        ...(sendOptions.onRetry ? { onRetry: sendOptions.onRetry } : {}),
      },
    );
    return value;
  }

  /**
   * Close the seat and take the remaining stack back to the wallet.
   *
   * A DIFFERENT function from the one every other call here uses:
   * `create-session` owns the economic boundary, `game-command` owns play. The
   * idempotency key the server derives is `gameId:seatId`, NOT this request id,
   * so a retried cash-out cannot buy a second credit — which is why retrying is
   * safe and why leaving without one is not.
   */
  async function requestCashOut(gameId: string): Promise<TableCashOutOutcome> {
    const denied = await requireSession();
    if (denied) return denied;

    const result = await bounded(
      client.functions.invoke("create-session", {
        body: {
          action: "CASH_OUT",
          gameId,
          clientRequestId: globalThis.crypto.randomUUID(),
          clientSentAt: new Date().toISOString(),
        },
      }),
    );
    if (result === null) return { ok: false, reason: "unreachable", message: UNREACHABLE };

    if (result.error) {
      const rejection = await readRejection(result.error);
      if (rejection) {
        return {
          ok: false,
          reason: "refused",
          message:
            rejection.code === "SESSION_BUSY"
              ? "This hand is still live. Your chips come back as soon as it settles."
              : rejection.message,
          code: rejection.code,
        };
      }
      return { ok: false, reason: "unreachable", message: UNREACHABLE };
    }

    const body = result.data as { walletBalance?: unknown } | null;
    return {
      ok: true,
      walletBalance: typeof body?.walletBalance === "number" ? body.walletBalance : null,
    };
  }

  return {
    kind: "supabase",
    cashOut: requestCashOut,

    /**
     * Read the table without changing it.
     *
     * Sent as a deliberately stale command: the server answers a version it has
     * moved past with the authoritative snapshot and applies nothing, which is
     * exactly a read.
     *
     * Version 0 is the choice on purpose. A session opens at version 1, so 0 can
     * never be current and the command can never actually apply — while -1,
     * the obvious sentinel, is rejected by the contract as negative before the
     * server ever looks at it.
     */
    async snapshot(
      gameId: string,
      callOptions: TableCallOptions = {},
    ): Promise<TableSnapshotOutcome> {
      return await send(
        gameId,
        {
          type: "RESOLVE_TIMEOUT",
          expectedVersion: 0,
          payload: {},
        },
        callOptions,
      );
    },

    async command(
      gameId: string,
      command: TableCommand,
      callOptions: TableCallOptions = {},
    ): Promise<TableSnapshotOutcome> {
      return await send(gameId, command, callOptions);
    },

    /**
     * Subscribe to the table's broadcast topic.
     *
     * A dropped message is survivable rather than fatal: the store keeps
     * polling as a fallback, and any snapshot — pushed or polled — is the
     * authoritative one. That is why this can afford to be best-effort.
     *
     * The payload is validated like everything else off the wire. An
     * unparseable broadcast is ignored rather than rendered, and the next poll
     * corrects the screen.
     */
    subscribe(
      gameId: string,
      onState: (state: PublicGameState, events: TableEvents) => void,
    ): () => void {
      const channel = client
        .channel(`game:${gameId}`)
        .on("broadcast", { event: "state" }, (message: { payload?: unknown }) => {
          const parsed = broadcastSchema.safeParse(message.payload);
          if (!parsed.success) return;
          onState(
            parsed.data.publicState as ContractPublicGameState as PublicGameState,
            (parsed.data.events ?? []).map((published) => published.event),
          );
        })
        .subscribe();

      return () => {
        void client.removeChannel(channel);
      };
    },
  };
}
