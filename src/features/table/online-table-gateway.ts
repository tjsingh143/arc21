/**
 * Talking to a server-authoritative table.
 *
 * Two methods: read the snapshot, and send a command. Neither can decide
 * anything — a command names an action and the version it believes it is acting
 * on, and the server decides whether that is legal, whether it is this seat's
 * turn, and what the table looks like afterwards.
 *
 * `clientActionId` is generated per attempt and never reused. That is what
 * makes a retry safe: the server returns the first committed result for a
 * repeated id rather than applying the action twice, so a flaky connection
 * cannot double-hit a hand.
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
import { isTimedOut, withTimeout } from "../../lib/supabase/with-timeout.js";

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

export interface TableGateway {
  readonly kind: "supabase" | "unconfigured" | "fake";
  snapshot(gameId: string): Promise<TableSnapshotOutcome>;
  command(gameId: string, command: TableCommand): Promise<TableSnapshotOutcome>;
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

const UNREACHABLE = "Could not reach the table. The hand continues on the server.";
const SIGNED_OUT = "Sign in to play at a table.";
const UNREADABLE = "The table sent something this app could not read.";

export function createUnconfiguredTableGateway(message: string): TableGateway {
  const refuse = async () => ({ ok: false as const, reason: "not-configured" as const, message });
  return {
    kind: "unconfigured",
    snapshot: refuse,
    command: refuse,
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

export function createSupabaseTableGateway(
  client: ArcSupabaseClient,
  options: { readonly timeoutMs?: number } = {},
): TableGateway {
  const { timeoutMs } = options;

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

  async function send(gameId: string, command: TableCommand): Promise<TableSnapshotOutcome> {
    const denied = await requireSession();
    if (denied) return denied;

    const result = await bounded(
      client.functions.invoke("game-command", {
        body: {
          gameId,
          clientActionId: globalThis.crypto.randomUUID(),
          expectedVersion: command.expectedVersion,
          type: command.type,
          payload: command.payload,
          clientSentAt: new Date().toISOString(),
        },
      }),
    );
    if (result === null) return { ok: false, reason: "unreachable", message: UNREACHABLE };

    if (result.error) {
      // A rejection still carries the reason the server gave; the body is more
      // useful than "something went wrong".
      return { ok: false, reason: "refused", message: "That move was not accepted." };
    }

    const read = readState(result.data);
    if (!read) return { ok: false, reason: "unreachable", message: UNREADABLE };
    return { ok: true, state: read.state, events: read.events };
  }

  return {
    kind: "supabase",

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
    async snapshot(gameId: string): Promise<TableSnapshotOutcome> {
      return await send(gameId, {
        type: "RESOLVE_TIMEOUT",
        expectedVersion: 0,
        payload: {},
      });
    },

    async command(gameId: string, command: TableCommand): Promise<TableSnapshotOutcome> {
      return await send(gameId, command);
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
