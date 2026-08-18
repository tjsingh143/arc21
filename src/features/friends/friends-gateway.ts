/**
 * Arc 21 — talking to the friend graph.
 *
 * Nine methods, and not one of them names the caller. Every RPC underneath
 * takes only the *other* person's id and reads the acting player from the
 * verified session, so there is no spelling of `sendRequest` that sends a
 * request as somebody else. That is not the security control — the database is
 * — but it is what makes the control legible: a reviewer can see in ten seconds
 * that this file cannot forge a relationship.
 *
 * Nothing here throws. Every failure is a value, because the states are the
 * product: a signed-out player, a build with no server, and a server that did
 * not answer are three different things and must read as three different
 * sentences. Collapsing them into "something went wrong" is what turns an
 * honest empty state into a bug report.
 *
 * Every call is bounded with `withTimeout`. A request to a host that silently
 * drops packets neither resolves nor rejects, and a friends list stuck on a
 * spinner forever is a worse failure than one that says the server is
 * unreachable.
 */

import type { ArcSupabaseClient } from "../../lib/supabase/client.js";
import { isTimedOut, withTimeout } from "../../lib/supabase/with-timeout.js";
import {
  describeRpcFailure,
  toBlockedPlayers,
  toFriendRequests,
  toFriends,
  toRelationshipState,
  toSearchResults,
  type BlockedPlayer,
  type Friend,
  type FriendRequest,
  type RelationshipState,
  type SearchResult,
} from "./friends.js";

export type FriendsFailureReason =
  /** No Supabase configuration in this build. Offline play is unaffected. */
  | "not-configured"
  /** A guest. Not an error, and not a state to be shown as "no friends". */
  | "signed-out"
  /** No answer inside the timeout. */
  | "unreachable"
  /** The server answered, and the answer was a refusal. */
  | "refused";

export interface FriendsFailure {
  readonly ok: false;
  readonly reason: FriendsFailureReason;
  readonly message: string;
}

export type FriendsLoadOutcome =
  | {
      readonly ok: true;
      readonly friends: readonly Friend[];
      readonly requests: readonly FriendRequest[];
      /** Rows that failed validation and were not rendered. */
      readonly dropped: number;
      /**
       * Stated reason the pending requests are missing, or `null` when they
       * arrived. An empty `requests` array means "none pending" — so when the
       * second read fails, the screen has to be told, or an unread list would
       * render as an answered one.
       */
      readonly requestsUnavailable: string | null;
    }
  | FriendsFailure;

export type FriendsSearchOutcome =
  | {
      readonly ok: true;
      /** Echoed back so a result list can never be labelled with a newer query. */
      readonly query: string;
      readonly results: readonly SearchResult[];
      readonly dropped: number;
    }
  | FriendsFailure;

export type BlockedLoadOutcome =
  | {
      readonly ok: true;
      readonly blocked: readonly BlockedPlayer[];
      /** Rows that failed validation and were not rendered. */
      readonly dropped: number;
    }
  | FriendsFailure;

export type RelationshipOutcome =
  | {
      readonly ok: true;
      /**
       * What the server says the relationship is now.
       *
       * `null` means the action was applied but its echo could not be read. It
       * is not a failure — the write happened — so the caller reloads rather
       * than reporting one, and no relationship is invented from the request
       * that was sent.
       */
      readonly relationship: RelationshipState | null;
    }
  | FriendsFailure;

export interface FriendsGateway {
  readonly kind: "supabase" | "unconfigured" | "fake";
  /** Friends and pending requests together — the two halves of one screen. */
  load(): Promise<FriendsLoadOutcome>;
  /**
   * Callers are expected to enforce `MIN_SEARCH_LENGTH` themselves so they can
   * explain the empty result; the server independently returns nothing below
   * it, so a caller that forgets leaks no data — it just learns nothing.
   */
  search(query: string): Promise<FriendsSearchOutcome>;
  /**
   * The player's own blocks, read separately from `load`.
   *
   * Separate because it is the only read on this screen whose failure must not
   * take the friends list down with it, and whose *empty* answer is the normal
   * one: most players have blocked nobody. Folding it into `load` would make a
   * refused blocked-list read look like a refused friends read.
   */
  listBlocked(): Promise<BlockedLoadOutcome>;
  sendRequest(playerId: string): Promise<RelationshipOutcome>;
  acceptRequest(playerId: string): Promise<RelationshipOutcome>;
  declineRequest(playerId: string): Promise<RelationshipOutcome>;
  removeFriend(playerId: string): Promise<RelationshipOutcome>;
  blockPlayer(playerId: string): Promise<RelationshipOutcome>;
  /**
   * Deletes the block and nothing else.
   *
   * It restores no friendship and revives no request — the server returns
   * `'none'`, not `'friends'` — so a caller must never present this as undoing
   * everything that the block did.
   */
  unblockPlayer(playerId: string): Promise<RelationshipOutcome>;
}

export function createUnconfiguredFriendsGateway(message: string): FriendsGateway {
  const refuse = async (): Promise<FriendsFailure> => ({
    ok: false,
    reason: "not-configured",
    message,
  });

  return {
    kind: "unconfigured",
    load: refuse,
    search: refuse,
    listBlocked: refuse,
    sendRequest: refuse,
    acceptRequest: refuse,
    declineRequest: refuse,
    removeFriend: refuse,
    blockPlayer: refuse,
    unblockPlayer: refuse,
  };
}

/*
 * Every RPC this file calls is declared in `database.types.ts`, which is the
 * *authorised surface* rather than generated types: a function that is not
 * listed there is a compile error at the call site rather than a 404 at run
 * time. A local name union used to stand in for that list while the friend
 * functions were undeclared; it is gone, because two lists of the same thing
 * drift and only one of them is the one the compiler checks.
 */

/** Postgres `insufficient_privilege` — every RPC raises it with no session. */
const NO_SESSION_CODE = "42501";

export function createSupabaseFriendsGateway(
  client: ArcSupabaseClient,
  options: { readonly timeoutMs?: number } = {},
): FriendsGateway {
  const { timeoutMs } = options;

  async function bounded<T>(work: PromiseLike<T>): Promise<T | null> {
    const result = await withTimeout(Promise.resolve(work), timeoutMs);
    return isTimedOut(result) ? null : result;
  }

  /** `null` when there is a session; a stated failure when there is not. */
  async function requireSession(): Promise<FriendsFailure | null> {
    const session = await bounded(client.auth.getSession());
    if (session === null) return { ok: false, reason: "unreachable", message: UNREACHABLE };
    if (session.data.session === null) {
      return { ok: false, reason: "signed-out", message: SIGNED_OUT };
    }
    return null;
  }

  /**
   * Runs one of the five mutating RPCs and reads its relationship back.
   *
   * The call is passed in already built rather than assembled from a name and a
   * loose bag of arguments. The five take the same uuid under three different
   * parameter names (`p_to`, `p_from`, `p_other`), and a `Record<string,
   * unknown>` would let any of them be called with the wrong one — which
   * typechecks and then silently does nothing at run time.
   */
  async function mutate(
    run: () => PromiseLike<{ data: unknown; error: { message: string; code?: string } | null }>,
  ): Promise<RelationshipOutcome> {
    const noSession = await requireSession();
    if (noSession !== null) return noSession;

    const result = await bounded(run());
    if (result === null) return { ok: false, reason: "unreachable", message: UNREACHABLE };

    if (result.error) {
      if (result.error.code === NO_SESSION_CODE) {
        return { ok: false, reason: "signed-out", message: SIGNED_OUT };
      }
      return { ok: false, reason: "refused", message: describeRpcFailure(result.error) };
    }

    return { ok: true, relationship: toRelationshipState(result.data) };
  }

  return {
    kind: "supabase",

    async load(): Promise<FriendsLoadOutcome> {
      const noSession = await requireSession();
      if (noSession !== null) return noSession;

      const friendsResult = await bounded(client.rpc("list_friends"));
      if (friendsResult === null) {
        return { ok: false, reason: "unreachable", message: UNREACHABLE };
      }
      if (friendsResult.error) {
        if (friendsResult.error.code === NO_SESSION_CODE) {
          return { ok: false, reason: "signed-out", message: SIGNED_OUT };
        }
        return { ok: false, reason: "refused", message: LIST_REFUSED };
      }

      /*
       * The friends list read cleanly. Dropping it because the second call
       * failed would hide people the player definitely has — so the requests
       * become a stated absence instead, exactly as the wallet keeps a balance
       * whose ledger page did not arrive.
       */
      const requestsResult = await bounded(client.rpc("list_friend_requests"));
      const requestsFailed = requestsResult === null || requestsResult.error !== null;

      const friends = toFriends(asRows(friendsResult.data));
      const requests = requestsFailed
        ? { requests: [] as readonly FriendRequest[], dropped: 0 }
        : toFriendRequests(asRows(requestsResult.data));

      return {
        ok: true,
        friends: friends.friends,
        requests: requests.requests,
        dropped: friends.dropped + requests.dropped,
        requestsUnavailable: requestsFailed ? REQUESTS_REFUSED : null,
      };
    },

    async search(query: string): Promise<FriendsSearchOutcome> {
      const noSession = await requireSession();
      if (noSession !== null) return noSession;

      const result = await bounded(client.rpc("search_players", { p_query: query }));
      if (result === null) return { ok: false, reason: "unreachable", message: UNREACHABLE };
      if (result.error) {
        if (result.error.code === NO_SESSION_CODE) {
          return { ok: false, reason: "signed-out", message: SIGNED_OUT };
        }
        return { ok: false, reason: "refused", message: SEARCH_REFUSED };
      }

      const { results, dropped } = toSearchResults(asRows(result.data));
      return { ok: true, query, results, dropped };
    },

    async listBlocked(): Promise<BlockedLoadOutcome> {
      const noSession = await requireSession();
      if (noSession !== null) return noSession;

      const result = await bounded(client.rpc("list_blocked"));
      if (result === null) return { ok: false, reason: "unreachable", message: UNREACHABLE };
      if (result.error) {
        if (result.error.code === NO_SESSION_CODE) {
          return { ok: false, reason: "signed-out", message: SIGNED_OUT };
        }
        return { ok: false, reason: "refused", message: BLOCKED_REFUSED };
      }

      const { blocked, dropped } = toBlockedPlayers(asRows(result.data));
      return { ok: true, blocked, dropped };
    },

    sendRequest: (playerId) => mutate(() => client.rpc("send_friend_request", { p_to: playerId })),
    acceptRequest: (playerId) => mutate(() => client.rpc("accept_friend_request", { p_from: playerId })),
    declineRequest: (playerId) => mutate(() => client.rpc("decline_friend_request", { p_from: playerId })),
    removeFriend: (playerId) => mutate(() => client.rpc("remove_friend", { p_other: playerId })),
    blockPlayer: (playerId) => mutate(() => client.rpc("block_player", { p_other: playerId })),
    unblockPlayer: (playerId) => mutate(() => client.rpc("unblock_player", { p_other: playerId })),
  };
}

/**
 * A set-returning RPC answers with an array. Anything else is not a list, and
 * treating it as one row would render a fabricated player.
 */
function asRows(data: unknown): readonly unknown[] {
  return Array.isArray(data) ? data : [];
}

const UNREACHABLE = "Could not reach the server, so your friends are not shown.";
const SIGNED_OUT =
  "Friends need an Arc 21 account. Practice stays on this device and works either way.";
const LIST_REFUSED = "Your friends list could not be read. Nothing has been changed.";
const REQUESTS_REFUSED = "Your pending requests could not be read. Nothing has been changed.";
const SEARCH_REFUSED = "That search could not be run. Nothing has been changed.";
/*
 * Deliberately not "you have blocked nobody". A refused read of this list must
 * never read as an empty one: somebody who came here to undo a block would be
 * told the block is already gone.
 */
const BLOCKED_REFUSED = "Your blocked list could not be read. Nobody has been unblocked.";
