/**
 * Arc 21 — friends view state.
 *
 * A cache of what the server said about the player's friend graph, and a status
 * describing why it is not there when it is not.
 *
 * The states matter more than the data, for the same reason they do in the
 * wallet. A friends surface has four ways to have no list — no server in this
 * build, nobody signed in, the server unreachable, the read refused — and every
 * one of them must be a sentence rather than an empty list. "No friends yet" is
 * a *claim* about somebody's social life, and it is the wrong answer that looks
 * most like a right one.
 *
 * Nothing here decides a relationship. Each action asks the server and then
 * reloads: the RPC's return value is the only thing that says whether two
 * people are now friends, and an optimistic local edge that survived a failed
 * request would be a friendship this app invented.
 */

import { create } from "zustand";

import { getSupabase } from "../../lib/supabase/client.js";
import {
  createSupabaseFriendsGateway,
  createUnconfiguredFriendsGateway,
  type FriendsFailure,
  type FriendsGateway,
  type RelationshipOutcome,
} from "./friends-gateway.js";
import {
  applySearchRelationship,
  FRIENDS_ACTION_FAILED,
  MIN_SEARCH_LENGTH,
  SEARCH_TOO_SHORT,
  type BlockedPlayer,
  type Friend,
  type FriendRequest,
  type SearchResult,
} from "./friends.js";

export type FriendsStatus =
  /** Nothing has been requested yet. */
  | { readonly kind: "idle" }
  | { readonly kind: "loading" }
  | {
      readonly kind: "ready";
      readonly friends: readonly Friend[];
      /** Pending requests, incoming first. */
      readonly requests: readonly FriendRequest[];
      /** Rows that failed validation; the screen says the list is partial. */
      readonly dropped: number;
      /** Set when the requests half of the read failed and the friends half did not. */
      readonly requestsUnavailable: string | null;
      /** ISO 8601 — how stale what is on screen is. */
      readonly fetchedAt: string;
    }
  /** No server in this build. Practice is unaffected. */
  | { readonly kind: "not-configured"; readonly message: string }
  /** A guest has no friend graph. Not an error. */
  | { readonly kind: "signed-out"; readonly message: string }
  | { readonly kind: "unavailable"; readonly message: string };

export type SearchStatus =
  /** Nothing has been searched for yet. */
  | { readonly kind: "idle" }
  /** The query is too short to send, and the screen says so instead of sending it. */
  | { readonly kind: "too-short"; readonly message: string }
  | { readonly kind: "searching"; readonly query: string }
  | {
      readonly kind: "results";
      /** The query these results answer — never the one currently in the box. */
      readonly query: string;
      readonly results: readonly SearchResult[];
      readonly dropped: number;
    }
  | { readonly kind: "failed"; readonly message: string };

/**
 * The blocked list, kept apart from `FriendsStatus`.
 *
 * It has no "signed-out" or "not-configured" kind, because the screen only
 * reaches this section once the friends read has succeeded — which already
 * means there is a server and a session. What it does need is `unavailable`:
 * "you have blocked nobody" and "your blocked list could not be read" are
 * opposite answers, and only one of them is safe to render as silence.
 */
export type BlockedStatus =
  | { readonly kind: "idle" }
  | { readonly kind: "loading" }
  | {
      readonly kind: "ready";
      /** Newest block first, as the server ordered them. */
      readonly blocked: readonly BlockedPlayer[];
      /** Rows that failed validation — each one is somebody who cannot be unblocked here. */
      readonly dropped: number;
    }
  | { readonly kind: "unavailable"; readonly message: string };

export interface FriendsStoreState {
  readonly status: FriendsStatus;
  /** Who the player has blocked, or why that is not known. */
  readonly blocked: BlockedStatus;
  readonly searchStatus: SearchStatus;
  /** What is in the search box. Separate from what the results answer. */
  readonly query: string;
  /** A reload is in flight. Keeps the visible list rather than blanking it. */
  readonly refreshing: boolean;
  /** The player an action is running against, so one row can show it. */
  readonly pending: string | null;
  /** The last refused action, in the player's words. */
  readonly actionError: string | null;

  refresh: () => Promise<void>;
  setQuery: (next: string) => void;
  search: () => Promise<void>;
  clearSearch: () => void;

  /**
   * Each resolves `true` only when the server applied the change.
   *
   * A screen that navigates away on completion needs to know the difference:
   * leaving on a refusal would dismiss the very message explaining that nothing
   * happened.
   */
  sendRequest: (playerId: string) => Promise<boolean>;
  acceptRequest: (playerId: string) => Promise<boolean>;
  declineRequest: (playerId: string) => Promise<boolean>;
  removeFriend: (playerId: string) => Promise<boolean>;
  blockPlayer: (playerId: string) => Promise<boolean>;
  /**
   * Deletes the block. It does not restore a friendship, so nothing else on
   * this screen gains a row when it succeeds.
   */
  unblockPlayer: (playerId: string) => Promise<boolean>;

  /** Drops everything. Called on sign-out so no list outlives a session. */
  clear: () => void;
}

let gatewayOverride: FriendsGateway | null = null;

export function setFriendsGateway(next: FriendsGateway | null): void {
  gatewayOverride = next;
}

export function activeFriendsGateway(): FriendsGateway {
  if (gatewayOverride !== null) return gatewayOverride;

  const availability = getSupabase();
  if (availability.status !== "ready") {
    return createUnconfiguredFriendsGateway(availability.message);
  }
  return createSupabaseFriendsGateway(availability.client);
}

/** A stated failure becomes a stated state. There is no generic error kind. */
function statusForFailure(failure: FriendsFailure): FriendsStatus {
  switch (failure.reason) {
    case "not-configured":
      return { kind: "not-configured", message: failure.message };
    case "signed-out":
      return { kind: "signed-out", message: failure.message };
    default:
      return { kind: "unavailable", message: failure.message };
  }
}

const LOAD_FAILED = "Your friends could not be loaded.";
const BLOCKED_LOAD_FAILED = "Your blocked list could not be read. Nobody has been unblocked.";

export const useFriendsStore = create<FriendsStoreState>((set, get) => {
  /**
   * `quiet` keeps whatever is on screen while a reload runs.
   *
   * A reload after accepting a request would otherwise blank the whole list for
   * as long as the round trip takes, which reads as the list having been
   * emptied by the thing the player just did.
   */
  async function load(quiet: boolean): Promise<void> {
    if (get().refreshing) return;
    set({ refreshing: true });
    // An explicit re-read also clears the last refusal: leaving a red banner
    // above a list that has just been read again describes a state that is over.
    if (!quiet) set({ status: { kind: "loading" }, actionError: null });

    let outcome;
    try {
      outcome = await activeFriendsGateway().load();
    } catch {
      // A gateway is not supposed to throw, but a friends screen is not the
      // place to find out that one did.
      set({ status: { kind: "unavailable", message: LOAD_FAILED }, refreshing: false });
      return;
    }

    if (!outcome.ok) {
      set({ status: statusForFailure(outcome), refreshing: false });
      return;
    }

    set({
      status: {
        kind: "ready",
        friends: outcome.friends,
        requests: outcome.requests,
        dropped: outcome.dropped,
        requestsUnavailable: outcome.requestsUnavailable,
        fetchedAt: new Date().toISOString(),
      },
      refreshing: false,
    });
  }

  /**
   * Reads the blocked list on its own.
   *
   * Its failure is kept out of `status` on purpose. A blocked list that cannot
   * be read is not a reason to stop showing friends — but it is also not a
   * reason to show nothing at all, which is why it becomes `unavailable` rather
   * than an empty list. Silence on this section means "the server says you have
   * blocked nobody", and nothing else may make that claim.
   */
  async function loadBlocked(quiet: boolean): Promise<void> {
    if (!quiet) set({ blocked: { kind: "loading" } });

    let outcome;
    try {
      outcome = await activeFriendsGateway().listBlocked();
    } catch {
      set({ blocked: { kind: "unavailable", message: BLOCKED_LOAD_FAILED } });
      return;
    }

    if (!outcome.ok) {
      set({ blocked: { kind: "unavailable", message: outcome.message } });
      return;
    }

    set({ blocked: { kind: "ready", blocked: outcome.blocked, dropped: outcome.dropped } });
  }

  /**
   * Runs one relationship change, then re-reads the graph.
   *
   * The reload is the point. `send_friend_request` accepts instead of sending
   * when the other person had already asked, and `block_player` also removes a
   * friendship — so what a tap did is not derivable from what it asked for, and
   * only the server can say what the lists look like afterwards.
   *
   * `reloadBlocked` is opt-in because only the two block actions can change
   * that list. Re-reading it after an accept would spend a round trip to learn
   * the same answer, and every action on this screen already costs one.
   */
  async function mutate(
    playerId: string,
    run: (gateway: FriendsGateway) => Promise<RelationshipOutcome>,
    options: { readonly reloadBlocked?: boolean } = {},
  ): Promise<boolean> {
    // One at a time. Two relationship changes in flight would each reload the
    // graph, and the slower answer would overwrite the newer one.
    if (get().pending !== null) return false;
    set({ pending: playerId, actionError: null });

    let outcome: RelationshipOutcome;
    try {
      outcome = await run(activeFriendsGateway());
    } catch {
      set({ pending: null, actionError: FRIENDS_ACTION_FAILED });
      return false;
    }

    if (!outcome.ok) {
      set({
        pending: null,
        actionError: outcome.message,
        // Losing the session mid-action is a change of state, not just a failed
        // tap, and the whole screen has to stop claiming a list it cannot read.
        ...(outcome.reason === "signed-out" || outcome.reason === "not-configured"
          ? { status: statusForFailure(outcome) }
          : {}),
      });
      return false;
    }

    if (outcome.relationship !== null) {
      const current = get().searchStatus;
      if (current.kind === "results") {
        set({
          searchStatus: {
            ...current,
            results: applySearchRelationship(current.results, playerId, outcome.relationship),
          },
        });
      }
    }

    await load(true);
    if (options.reloadBlocked === true) await loadBlocked(true);
    set({ pending: null });
    return true;
  }

  return {
    status: { kind: "idle" },
    blocked: { kind: "idle" },
    searchStatus: { kind: "idle" },
    query: "",
    refreshing: false,
    pending: null,
    actionError: null,

    // Both reads, together. They are independent — one failing does not make
    // the other's answer any less true — so they are not chained.
    refresh: async () => {
      await Promise.all([load(false), loadBlocked(false)]);
    },

    setQuery: (next) => set({ query: next }),

    search: async () => {
      const query = get().query.trim();

      /*
       * Below the minimum the server returns nothing at all, so sending the
       * request would spend a round trip to learn what is already known and
       * come back with an empty list that reads like "nobody matches".
       */
      if (query.length < MIN_SEARCH_LENGTH) {
        set({ searchStatus: { kind: "too-short", message: SEARCH_TOO_SHORT } });
        return;
      }

      set({ searchStatus: { kind: "searching", query } });

      let outcome;
      try {
        outcome = await activeFriendsGateway().search(query);
      } catch {
        set({ searchStatus: { kind: "failed", message: LOAD_FAILED } });
        return;
      }

      if (!outcome.ok) {
        set({ searchStatus: { kind: "failed", message: outcome.message } });
        if (outcome.reason === "signed-out" || outcome.reason === "not-configured") {
          set({ status: statusForFailure(outcome) });
        }
        return;
      }

      set({
        searchStatus: {
          kind: "results",
          query: outcome.query,
          results: outcome.results,
          dropped: outcome.dropped,
        },
      });
    },

    clearSearch: () => set({ query: "", searchStatus: { kind: "idle" } }),

    sendRequest: (playerId) => mutate(playerId, (gateway) => gateway.sendRequest(playerId)),
    acceptRequest: (playerId) => mutate(playerId, (gateway) => gateway.acceptRequest(playerId)),
    declineRequest: (playerId) => mutate(playerId, (gateway) => gateway.declineRequest(playerId)),
    removeFriend: (playerId) => mutate(playerId, (gateway) => gateway.removeFriend(playerId)),
    blockPlayer: (playerId) =>
      mutate(playerId, (gateway) => gateway.blockPlayer(playerId), { reloadBlocked: true }),
    unblockPlayer: (playerId) =>
      mutate(playerId, (gateway) => gateway.unblockPlayer(playerId), { reloadBlocked: true }),

    clear: () =>
      set({
        status: { kind: "idle" },
        blocked: { kind: "idle" },
        searchStatus: { kind: "idle" },
        query: "",
        refreshing: false,
        pending: null,
        actionError: null,
      }),
  };
});

/**
 * The friends list, or null when there is not one to show.
 *
 * Null rather than `[]` for the same reason the wallet returns null rather than
 * `0`: an empty array renders as "you have no friends", which is a statement
 * about the player, and it must never be what an unread list looks like.
 */
export function selectFriends(status: FriendsStatus): readonly Friend[] | null {
  return status.kind === "ready" ? status.friends : null;
}

export function selectIncomingRequests(status: FriendsStatus): readonly FriendRequest[] | null {
  if (status.kind !== "ready") return null;
  return status.requests.filter((request) => request.direction === "incoming");
}

export function selectOutgoingRequests(status: FriendsStatus): readonly FriendRequest[] | null {
  if (status.kind !== "ready") return null;
  return status.requests.filter((request) => request.direction === "outgoing");
}

/**
 * Who the player has blocked, or null when that is not known.
 *
 * Null rather than `[]` for the same reason as `selectFriends`: an empty array
 * is the server saying "nobody", and an unread list must not be able to say it.
 */
export function selectBlocked(status: BlockedStatus): readonly BlockedPlayer[] | null {
  return status.kind === "ready" ? status.blocked : null;
}

/**
 * Whether the Blocked section appears at all.
 *
 * Most players have blocked nobody, and a permanent "Blocked — none" heading
 * would put a moderation surface in front of every one of them. So the section
 * is absent when the server says the list is empty: nothing is claimed, because
 * there is nothing to say.
 *
 * It is present when the read failed, though. That is the case where hiding the
 * section *would* be a claim — somebody who came looking for a block to undo
 * would find no trace of it and conclude it was already gone.
 */
export function shouldShowBlocked(status: BlockedStatus): boolean {
  if (status.kind === "unavailable") return true;
  if (status.kind !== "ready") return false;
  return status.blocked.length > 0 || status.dropped > 0;
}

/**
 * One friend by id, or null.
 *
 * The friend profile screen is reached from the list, so the list is where its
 * facts come from — a level or a handle re-fetched separately could disagree
 * with the row that was tapped. Null means "not in your friends list", which
 * the screen states rather than filling in.
 */
export function selectFriend(status: FriendsStatus, playerId: string): Friend | null {
  if (status.kind !== "ready") return null;
  return status.friends.find((friend) => friend.id === playerId) ?? null;
}
