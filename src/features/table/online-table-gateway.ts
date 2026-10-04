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
 *
 * **AND EVERY CALL IS BOUND TO THE PLAYER WHO ASKED FOR IT.** A command names a
 * `gameId` and never a player: WHO is acting is read from the verified JWT the
 * request arrives with, and the SDK attaches whichever session the shared client
 * holds as the request leaves — not the one the player held when they tapped.
 * Between those two moments sits the session read below.
 *
 * That was argued to be harmless here, on the grounds that a replacement player
 * has no seat at the named game and the server answers `NOT_A_PARTICIPANT`. The
 * argument is wrong, and the independent audit reproduced it: **a multiplayer
 * table has more than one participant.** Player A's held Leave was released
 * after a real sign-in to player B, who was seated at the SAME game — so the
 * server found B's seat, passed every membership check, and cashed B out. A
 * stayed seated, B's stack went to zero, and the store correctly discarded the
 * reply afterwards, which is precisely why nothing on screen said anything. A
 * game id is a table, not an identity; and the `gameId:seatId` idempotency key
 * derived from that request was B's too, so it protected nothing of A's.
 *
 * So the credential is chosen ONCE per intent and travels with the request, the
 * way `session-intent.ts` has always done it for the economic one-shots:
 * `player-binding.ts` captures the player scope before the session read, refuses
 * outright if the app has moved on, and pins the verified token onto the
 * outbound call — including onto every RETRY, so a backoff cannot silently pick
 * up the replacement player's session between attempts.
 */

import { z } from "zod";

import {
  publicGameEventSchema,
  publicGameStateSchema,
  type ContractEngineEvent,
  type ContractPublicGameState,
  type PublicGameEvent,
} from "../../../shared/contracts/index.js";
import type { PublicGameState } from "../../../shared/blackjack/index.js";
import type { ArcSupabaseClient } from "../../lib/supabase/client.js";
import { newClientActionId } from "../../lib/supabase/ids.js";
import { readRejection } from "../../lib/supabase/rejection.js";
import { bindCurrentPlayer, type BoundPlayer } from "../../lib/supabase/player-binding.js";
import { isTimedOut, withTimeout } from "../../lib/supabase/with-timeout.js";
import { retryWhile, type BackoffPolicy } from "../../lib/supabase/with-retry.js";

export type TableFailureReason =
  | "not-configured"
  | "signed-out"
  /**
   * The app moved to another player while this call was being prepared, so it
   * was never sent.
   *
   * Its own answer rather than a borrowed one. "Signed out" would be false —
   * somebody IS signed in, just not the player who asked — and "unreachable"
   * would blame a server that was never called. Rarely rendered, because the
   * identity change has already torn this screen down, but a table operation
   * that refuses has to say which refusal it is.
   */
  | "stale-identity"
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
 *
 * THE ORDERING ENVELOPE TRAVELS WITH THEM. This used to be
 * `readonly ContractEngineEvent[]`, unwrapped here with the comment "the
 * sequence numbers are the store's concern" — and the store never received one,
 * because this is where they were thrown away. `publicGameEventSchema` has
 * carried `seq` since the contract was written, and both it and
 * `_shared/realtime-broadcast.ts` describe a client that "tracks lastAppliedSeq
 * and refetches on a gap"; nothing did. The visible cost was a duplicate
 * broadcast replaying the settlement: the store deduped on `version`, which is
 * EQUAL for a command's own reply and the broadcast that follows it, so every
 * action at a server table fired its cards and its outcome twice.
 */
export type TableEvents = readonly PublicGameEvent[];

/** The events of one batch, unwrapped for anything that only cares what happened. */
export function engineEventsOf(events: TableEvents): readonly ContractEngineEvent[] {
  return events.map((published) => published.event);
}

/**
 * The sequence range a batch covers, or `null` when it carried no events.
 *
 * `null` is a real answer and not a missing one: a snapshot read carries no
 * events by construction, and `closeCompetition` broadcasts an empty batch. A
 * caller with no sequence to compare falls back to the state version.
 */
export function seqRangeOf(events: TableEvents): { first: number; last: number } | null {
  const first = events[0];
  const last = events[events.length - 1];
  if (!first || !last) return null;
  return { first: first.seq, last: last.seq };
}

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

/**
 * What came back from a private table's free reset.
 *
 * The snapshot is the server's, exactly as it is for a command: the stack in it
 * is the ruleset's figure applied server-side, never one this client named.
 */
export type TableStackResetOutcome =
  | { readonly ok: true; readonly state: PublicGameState }
  | TableFailure;

export interface TableGateway {
  readonly kind: "supabase" | "unconfigured" | "fake";
  snapshot(gameId: string, options?: TableCallOptions): Promise<TableSnapshotOutcome>;
  /**
   * Put a broke seat back on a private table's fixed stack.
   *
   * The specification's rule for a private table: "if a private player reaches
   * zero session chips, permit a free reset to 5,000 between hands; private
   * mode is unranked." `RESET_PRIVATE_STACK` has been implemented, contracted
   * and logged on the server since the private-table work landed, and **nothing
   * in this app had ever sent it** — so a player who busted at a table with
   * their friends sat out every remaining hand of it, permanently, with the
   * remedy sitting unreachable behind the wire.
   *
   * Named ONLY by its game. The amount is the ruleset's and the three guards —
   * private table, between hands, actually broke — are all the server's. A
   * client that could name a stack at an unranked table could name one anywhere.
   */
  resetPrivateStack(gameId: string): Promise<TableStackResetOutcome>;
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
const SIGNED_OUT = "Connect your player to return to this table. Practice works offline.";
const UNREADABLE = "The table sent something this app could not read.";
/**
 * Said, not sent.
 *
 * The screen this would appear on has almost always been replaced by the time
 * this value exists — an identity change resets the table store — so the wording
 * matters less than the fact that the call REFUSED rather than going out as
 * somebody else.
 */
const STALE_IDENTITY = "This table belongs to the player who was signed in before. Nothing was sent.";

export function createUnconfiguredTableGateway(message: string): TableGateway {
  const refuse = async () => ({ ok: false as const, reason: "not-configured" as const, message });
  return {
    kind: "unconfigured",
    snapshot: refuse,
    command: refuse,
    cashOut: refuse,
    resetPrivateStack: refuse,
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
    // Kept IN their ordering envelope. The store dedupes on `seq`; unwrapping
    // here is what left it with only `version` to compare, and a command's own
    // reply and the broadcast that follows it share a version.
    events: parsed.data.events ?? [],
  };
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

  /** Nothing was sent, because the player who asked for it is no longer here. */
  const stale = (): TableFailure => ({
    ok: false,
    reason: "stale-identity",
    message: STALE_IDENTITY,
  });

  /**
   * The player this call belongs to, or the stated reason there is none.
   *
   * Replaces a plain "is anybody signed in" check, which is not enough for a
   * table: knowing that SOMEBODY has a session says nothing about whether the
   * request will leave carrying the credential of the player who asked for it,
   * and at a multiplayer table the replacement player has a seat of their own
   * for the server to find. See the file header and `player-binding.ts`.
   *
   * Called as the FIRST statement of every outbound path here, so the scope it
   * captures is the caller's dispatch rather than whoever is current by the time
   * the session read returns.
   */
  async function bindPlayer(): Promise<
    { readonly ok: true; readonly player: BoundPlayer } | TableFailure
  > {
    const binding = await bindCurrentPlayer(client, timeoutMs);
    if (binding.ok) return binding;
    switch (binding.reason) {
      case "unreachable":
        return { ok: false, reason: "unreachable", message: UNREACHABLE };
      case "signed-out":
        return { ok: false, reason: "signed-out", message: SIGNED_OUT };
      default:
        return stale();
    }
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
    player: BoundPlayer,
  ): Promise<TableSnapshotOutcome> {
    /*
     * THE GATE ON EVERY ATTEMPT, not just the first.
     *
     * `retryWhile` calls this function again after a silence, and the whole
     * point of a backoff is that seconds pass inside it. A check made once
     * before the loop would be a check made before an account switch that
     * happened during it, and the second attempt would carry the new player's
     * intent under the old player's request id.
     */
    if (!player.isCurrent()) return stale();

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
        /*
         * Pinned, exactly as `session-intent.ts` pins the economic one-shots.
         * The SDK's `fetchWithAuth` sets `Authorization` only when it is absent,
         * and `functions.invoke` gives call-level headers priority over the
         * client's own — so a sign-in landing inside this fetch cannot
         * substitute the replacement player's JWT.
         */
        headers: { Authorization: player.authorization },
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
    const bound = await bindPlayer();
    if (!bound.ok) return bound;

    // Minted ONCE, here, outside the retry loop. Moving this line inside
    // `attempt` is how a retried bet becomes two bets.
    const clientActionId = newClientActionId();

    if (sendOptions.retry === false) {
      return await attempt(gameId, command, clientActionId, bound.player);
    }

    const { value } = await retryWhile(
      () => attempt(gameId, command, clientActionId, bound.player),
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
    const bound = await bindPlayer();
    if (!bound.ok) return bound;
    /*
     * The last gate before the write, and the one the audit's reproduction
     * needed. Nothing is awaited between the binding and here today; this is
     * what keeps that true, because a check made earlier is not a check made
     * now — and `cashOut` is the call that closes a seat and moves chips.
     */
    if (!bound.player.isCurrent()) return stale();

    const result = await bounded(
      client.functions.invoke("create-session", {
        body: {
          action: "CASH_OUT",
          gameId,
          clientRequestId: globalThis.crypto.randomUUID(),
          clientSentAt: new Date().toISOString(),
        },
        // The seat the server closes is the one it finds for the JWT it
        // receives. At a table with more than one participant that is the whole
        // of the identity check, so the token must be this player's.
        headers: { Authorization: bound.player.authorization },
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

  /**
   * The free reset, at `create-session` rather than `game-command`.
   *
   * The same boundary as the cash-out and for the same reason: `create-session`
   * owns what a seat is worth, `game-command` owns play. Retried on silence like
   * every other one-shot the player is waiting on — a reset that arrives twice
   * sets the same stack to the same figure, and the server refuses the second
   * outright once the first has left the seat able to cover the minimum.
   */
  async function requestStackReset(gameId: string): Promise<TableStackResetOutcome> {
    const bound = await bindPlayer();
    if (!bound.ok) return bound;

    /*
     * Minted ONCE, outside the retry loop, for the same reason `send` does it:
     * every attempt at one intent presents the same key. The server derives no
     * idempotency record from it today — it does not need one, because a
     * SECOND reset finds a stack that can cover the minimum and is refused on
     * that guard — but a request id that changed per attempt would be a lie
     * about what the attempts are, and the guard is not the place to rely on.
     */
    const clientRequestId = globalThis.crypto.randomUUID();

    const attemptOnce = async (): Promise<TableStackResetOutcome> => {
      // Re-checked per attempt, for the reason `attempt` states: the retry loop
      // is where the seconds are, and a private stack is a seat's whole
      // position.
      if (!bound.player.isCurrent()) return stale();

      const result = await bounded(
        client.functions.invoke("create-session", {
          body: {
            action: "RESET_PRIVATE_STACK",
            gameId,
            clientRequestId,
            clientSentAt: new Date().toISOString(),
          },
          headers: { Authorization: bound.player.authorization },
        }),
      );
      if (result === null) return { ok: false, reason: "unreachable", message: UNREACHABLE };

      if (result.error) {
        const rejection = await readRejection(result.error);
        if (rejection === null) {
          return { ok: false, reason: "unreachable", message: UNREACHABLE };
        }
        return {
          ok: false,
          reason: "refused",
          message: rejection.message,
          code: rejection.code,
        };
      }

      const read = readState(result.data);
      if (!read) return { ok: false, reason: "unreachable", message: UNREADABLE };
      return { ok: true, state: read.state };
    };

    const { value } = await retryWhile(
      attemptOnce,
      (outcome) => !outcome.ok && outcome.reason === "unreachable",
      { ...(policy ? { policy } : {}) },
    );
    return value;
  }

  return {
    kind: "supabase",
    cashOut: requestCashOut,
    resetPrivateStack: requestStackReset,

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
     *
     * NOT BOUND, and it cannot be. This is the one path here that mutates
     * nothing: it opens a socket subscription, and Realtime authorises a socket
     * from the token the client sets on it, which is a property of the client
     * and not of one request — there is no per-message header to pin. Nothing
     * here can therefore act as the replacement player. What it could do is push
     * a stale table at a screen belonging to somebody else, and the store closes
     * that from the other end: an identity change runs `resetPlayerState()`,
     * which calls `forgetTable()`, which unsubscribes and bumps the generation
     * every handler checks.
     */
    subscribe(
      gameId: string,
      onState: (state: PublicGameState, events: TableEvents) => void,
    ): () => void {
      const channel = client
        /*
         * PRIVATE. A public topic delivered this table's state to anyone
         * holding the anon key and accepted a forged `state` from any account
         * — both measured against the running stack. Declaring it private makes
         * Realtime check `realtime.messages`, where the policy requires a live
         * seat at THIS game to read and grants no client the right to write.
         */
        .channel(`game:${gameId}`, { config: { private: true } })
        .on("broadcast", { event: "state" }, (message: { payload?: unknown }) => {
          const parsed = broadcastSchema.safeParse(message.payload);
          if (!parsed.success) return;
          onState(
            parsed.data.publicState as ContractPublicGameState as PublicGameState,
            parsed.data.events ?? [],
          );
        })
        .subscribe();

      return () => {
        void client.removeChannel(channel);
      };
    },
  };
}
