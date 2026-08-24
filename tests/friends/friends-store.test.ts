/**
 * The friends store.
 *
 * Two things are being defended here.
 *
 * The first is that an empty friends list is a *claim about a person*, and it
 * must only ever be made when the server said so. No server in this build, a
 * guest, an unreachable host and a refused read are four different states, and
 * none of them may render as "you have no friends".
 *
 * The second is that no relationship is decided on this device. Every action
 * asks the server and re-reads the graph, because what a tap did is not
 * derivable from what it asked for — `send_friend_request` accepts when the
 * other person had already asked, and `block_player` also ends a friendship.
 * The fake below is a small implementation of those rules rather than a
 * canned answer, so a store that stopped re-reading would fail.
 */

import { beforeEach, describe, expect, it } from "vitest";

import { setSupabaseAvailabilityForTests } from "../../src/lib/supabase/client.js";
import type {
  FriendsGateway,
  RelationshipOutcome,
} from "../../src/features/friends/friends-gateway.js";
import {
  selectBlocked,
  selectFriend,
  selectFriends,
  selectIncomingRequests,
  selectOutgoingRequests,
  setFriendsGateway,
  shouldShowBlocked,
  useFriendsStore,
} from "../../src/features/friends/friends-store.js";
import type {
  BlockedPlayer,
  Friend,
  FriendRequest,
  SearchResult,
} from "../../src/features/friends/friends.js";

const ADA = "11111111-1111-4111-8111-111111111111";
const BO = "22222222-2222-4222-8222-222222222222";
const CASS = "33333333-3333-4333-8333-333333333333";

const SEEN = "2026-08-16T11:00:00.000Z";

function friend(id: string, username: string, displayName: string): Friend {
  return { id, username, displayName, level: 5, lastSeenAt: SEEN };
}

function incoming(id: string, username: string, displayName: string): FriendRequest {
  return { direction: "incoming", id, username, displayName, createdAt: SEEN };
}

function outgoing(id: string, username: string, displayName: string): FriendRequest {
  return { direction: "outgoing", id, username, displayName, createdAt: SEEN };
}

function result(id: string, username: string, relationship: SearchResult["relationship"]): SearchResult {
  return { id, username, displayName: username.toUpperCase(), level: 5, relationship };
}

function blockedPlayer(id: string, username: string, displayName: string): BlockedPlayer {
  return { id, username, displayName, blockedAt: SEEN };
}

/**
 * A small honest server.
 *
 * It applies the same rules the SQL does — accepting an incoming request rather
 * than mirroring it, removing the friendship when blocking, and restoring
 * nothing at all when unblocking — so a test can assert on the *lists*
 * afterwards instead of on the call that was made.
 */
function fakeServer(world: {
  friends?: Friend[];
  requests?: FriendRequest[];
  results?: SearchResult[];
  blocked?: BlockedPlayer[];
}) {
  const state = {
    friends: world.friends ?? [],
    requests: world.requests ?? [],
    results: world.results ?? [],
    blocked: world.blocked ?? [],
  };
  const searched: string[] = [];
  const loads = { count: 0 };
  const blockedReads = { count: 0 };

  const gateway: FriendsGateway = {
    kind: "fake",

    // Not exercised by these tests, which are about the LIST. Present because
    // the interface requires it: a fake that silently omits a method would let
    // the store call something that does not exist.
    profile: async () => ({ ok: true as const, profile: null }),

    load: async () => {
      loads.count += 1;
      return {
        ok: true,
        friends: [...state.friends],
        requests: [...state.requests],
        dropped: 0,
        requestsUnavailable: null,
      };
    },

    search: async (query) => {
      searched.push(query);
      return { ok: true, query, results: [...state.results], dropped: 0 };
    },

    listBlocked: async () => {
      blockedReads.count += 1;
      return { ok: true, blocked: [...state.blocked], dropped: 0 };
    },

    sendRequest: async (playerId): Promise<RelationshipOutcome> => {
      const theirs = state.requests.find(
        (request) => request.id === playerId && request.direction === "incoming",
      );
      if (theirs) {
        state.requests = state.requests.filter((request) => request.id !== playerId);
        state.friends = [...state.friends, friend(playerId, theirs.username, theirs.displayName)];
        return { ok: true, relationship: "friends" };
      }
      state.requests = [...state.requests, outgoing(playerId, "unknown", "Unknown")];
      return { ok: true, relationship: "outgoing_pending" };
    },

    acceptRequest: async (playerId): Promise<RelationshipOutcome> => {
      const theirs = state.requests.find(
        (request) => request.id === playerId && request.direction === "incoming",
      );
      if (!theirs) {
        return { ok: false, reason: "refused", message: "That request is no longer there." };
      }
      state.requests = state.requests.filter((request) => request.id !== playerId);
      state.friends = [...state.friends, friend(playerId, theirs.username, theirs.displayName)];
      return { ok: true, relationship: "friends" };
    },

    declineRequest: async (playerId): Promise<RelationshipOutcome> => {
      state.requests = state.requests.filter(
        (request) => !(request.id === playerId && request.direction === "incoming"),
      );
      return { ok: true, relationship: "none" };
    },

    removeFriend: async (playerId): Promise<RelationshipOutcome> => {
      state.friends = state.friends.filter((existing) => existing.id !== playerId);
      return { ok: true, relationship: "none" };
    },

    blockPlayer: async (playerId): Promise<RelationshipOutcome> => {
      const known =
        state.friends.find((existing) => existing.id === playerId) ??
        state.requests.find((request) => request.id === playerId) ??
        state.results.find((row) => row.id === playerId);

      state.friends = state.friends.filter((existing) => existing.id !== playerId);
      state.requests = state.requests.filter((request) => request.id !== playerId);
      state.results = state.results.filter((row) => row.id !== playerId);
      // Newest block first, as `list_blocked` orders them.
      state.blocked = [
        blockedPlayer(playerId, known?.username ?? "unknown", known?.displayName ?? "Unknown"),
        ...state.blocked.filter((row) => row.id !== playerId),
      ];
      return { ok: true, relationship: "blocked" };
    },

    unblockPlayer: async (playerId): Promise<RelationshipOutcome> => {
      state.blocked = state.blocked.filter((row) => row.id !== playerId);
      /*
       * Nothing else changes. The SQL deletes one row in `blocks` and stops —
       * no friendship is restored and no request is revived — so a store that
       * put somebody back on the friends list would be inventing a friendship.
       */
      return { ok: true, relationship: "none" };
    },
  };

  return { gateway, searched, loads, blockedReads, state };
}

/** A gateway that answers everything with the same stated failure. */
function refusing(
  reason: "not-configured" | "signed-out" | "unreachable" | "refused",
  message: string,
): FriendsGateway {
  const failure = async () => ({ ok: false as const, reason, message });
  return {
    kind: "fake",
    load: failure,
    search: failure,
    listBlocked: failure,
    sendRequest: failure,
    acceptRequest: failure,
    declineRequest: failure,
    removeFriend: failure,
    blockPlayer: failure,
    profile: failure,
    unblockPlayer: failure,
  };
}

beforeEach(() => {
  setSupabaseAvailabilityForTests(null);
  setFriendsGateway(null);
  useFriendsStore.getState().clear();
});

describe("states with no list", () => {
  it("says so when this build has no server", async () => {
    setFriendsGateway(refusing("not-configured", "No server in this build."));

    await useFriendsStore.getState().refresh();

    const { status } = useFriendsStore.getState();
    expect(status.kind).toBe("not-configured");
    expect(selectFriends(status)).toBeNull();
  });

  it("treats a guest as signed out, not as friendless", async () => {
    setFriendsGateway(refusing("signed-out", "Friends need an Arc 21 account."));

    await useFriendsStore.getState().refresh();

    const { status } = useFriendsStore.getState();
    expect(status.kind).toBe("signed-out");
    expect(selectFriends(status)).toBeNull();
  });

  it("says the server is unreachable rather than showing an empty list", async () => {
    setFriendsGateway(refusing("unreachable", "Could not reach the server."));

    await useFriendsStore.getState().refresh();

    const { status } = useFriendsStore.getState();
    expect(status.kind).toBe("unavailable");
    expect(selectFriends(status)).toBeNull();
  });

  it("says a refused read was refused", async () => {
    setFriendsGateway(refusing("refused", "Your friends list could not be read."));

    await useFriendsStore.getState().refresh();

    expect(useFriendsStore.getState().status).toEqual({
      kind: "unavailable",
      message: "Your friends list could not be read.",
    });
  });

  it("survives a gateway that throws", async () => {
    const { gateway } = fakeServer({});
    setFriendsGateway({ ...gateway, load: () => Promise.reject(new Error("boom")) });

    await expect(useFriendsStore.getState().refresh()).resolves.toBeUndefined();

    expect(useFriendsStore.getState().status.kind).toBe("unavailable");
  });

  it("reports nothing before anything has been read", () => {
    expect(selectFriends({ kind: "idle" })).toBeNull();
    expect(selectIncomingRequests({ kind: "loading" })).toBeNull();
    expect(selectOutgoingRequests({ kind: "signed-out", message: "" })).toBeNull();
    expect(selectFriend({ kind: "idle" }, ADA)).toBeNull();
  });
});

describe("a successful read", () => {
  it("passes through idle, loading and ready in that order", async () => {
    setFriendsGateway(fakeServer({ friends: [friend(ADA, "ada", "Ada")] }).gateway);
    expect(useFriendsStore.getState().status.kind).toBe("idle");

    const seen: string[] = [];
    const unsubscribe = useFriendsStore.subscribe((state) => seen.push(state.status.kind));
    await useFriendsStore.getState().refresh();
    unsubscribe();

    expect(seen.indexOf("loading")).toBeGreaterThanOrEqual(0);
    expect(seen.lastIndexOf("ready")).toBeGreaterThan(seen.indexOf("loading"));
    expect(useFriendsStore.getState().status.kind).toBe("ready");
  });

  it("exposes the friends and splits the requests by direction", async () => {
    setFriendsGateway(
      fakeServer({
        friends: [friend(ADA, "ada", "Ada")],
        requests: [incoming(BO, "bo", "Bo"), outgoing(CASS, "cass", "Cass")],
      }).gateway,
    );

    await useFriendsStore.getState().refresh();

    const { status } = useFriendsStore.getState();
    expect(selectFriends(status)?.map((each) => each.username)).toEqual(["ada"]);
    expect(selectIncomingRequests(status)?.map((each) => each.username)).toEqual(["bo"]);
    expect(selectOutgoingRequests(status)?.map((each) => each.username)).toEqual(["cass"]);
    expect(selectFriend(status, ADA)?.displayName).toBe("Ada");
    expect(selectFriend(status, BO)).toBeNull();
  });

  it("carries the count of rows that could not be read", async () => {
    const { gateway } = fakeServer({});
    setFriendsGateway({
      ...gateway,
      load: async () => ({
        ok: true,
        friends: [friend(ADA, "ada", "Ada")],
        requests: [],
        dropped: 2,
        requestsUnavailable: null,
      }),
    });

    await useFriendsStore.getState().refresh();

    const { status } = useFriendsStore.getState();
    expect(status.kind === "ready" ? status.dropped : null).toBe(2);
  });

  it("keeps the friends when only the requests half failed, and says which is missing", async () => {
    const { gateway } = fakeServer({});
    setFriendsGateway({
      ...gateway,
      load: async () => ({
        ok: true,
        friends: [friend(ADA, "ada", "Ada")],
        requests: [],
        dropped: 0,
        requestsUnavailable: "Your pending requests could not be read.",
      }),
    });

    await useFriendsStore.getState().refresh();

    const { status } = useFriendsStore.getState();
    expect(selectFriends(status)).toHaveLength(1);
    expect(status.kind === "ready" ? status.requestsUnavailable : null).toBe(
      "Your pending requests could not be read.",
    );
  });

  it("drops the cached list on clear, so no list outlives a session", async () => {
    setFriendsGateway(fakeServer({ friends: [friend(ADA, "ada", "Ada")] }).gateway);
    await useFriendsStore.getState().refresh();

    useFriendsStore.getState().clear();

    expect(selectFriends(useFriendsStore.getState().status)).toBeNull();
    expect(useFriendsStore.getState().searchStatus.kind).toBe("idle");
  });
});

describe("searching", () => {
  it("does not ask the server below the minimum length", async () => {
    const { gateway, searched } = fakeServer({ results: [result(BO, "bo", "none")] });
    setFriendsGateway(gateway);

    useFriendsStore.getState().setQuery("b");
    await useFriendsStore.getState().search();

    expect(searched).toEqual([]);
    const { searchStatus } = useFriendsStore.getState();
    expect(searchStatus.kind).toBe("too-short");
    expect(searchStatus.kind === "too-short" ? searchStatus.message : "").toContain(
      "at least 2 characters",
    );
  });

  it("does not ask the server for whitespace either", async () => {
    const { gateway, searched } = fakeServer({});
    setFriendsGateway(gateway);

    useFriendsStore.getState().setQuery("   a   ");
    await useFriendsStore.getState().search();

    expect(searched).toEqual([]);
    expect(useFriendsStore.getState().searchStatus.kind).toBe("too-short");
  });

  it("asks once, with the query trimmed, at the minimum length", async () => {
    const { gateway, searched } = fakeServer({ results: [result(BO, "bo", "none")] });
    setFriendsGateway(gateway);

    useFriendsStore.getState().setQuery("  bo  ");
    await useFriendsStore.getState().search();

    expect(searched).toEqual(["bo"]);
    const { searchStatus } = useFriendsStore.getState();
    expect(searchStatus.kind === "results" ? searchStatus.results.map((r) => r.id) : []).toEqual([
      BO,
    ]);
  });

  it("labels results with the query they answer, not the one in the box", async () => {
    const { gateway } = fakeServer({ results: [] });
    setFriendsGateway(gateway);

    useFriendsStore.getState().setQuery("bo");
    await useFriendsStore.getState().search();
    useFriendsStore.getState().setQuery("bobby");

    const { searchStatus } = useFriendsStore.getState();
    expect(searchStatus.kind === "results" ? searchStatus.query : null).toBe("bo");
    expect(searchStatus.kind === "results" ? searchStatus.results : null).toEqual([]);
  });

  it("states a failed search instead of showing no matches", async () => {
    setFriendsGateway(refusing("unreachable", "Could not reach the server."));

    useFriendsStore.getState().setQuery("ada");
    await useFriendsStore.getState().search();

    const { searchStatus } = useFriendsStore.getState();
    expect(searchStatus.kind).toBe("failed");
    expect(searchStatus.kind === "failed" ? searchStatus.message : "").toBe(
      "Could not reach the server.",
    );
  });
});

describe("acting on a request", () => {
  it("makes an incoming request a friendship, and takes it out of the requests", async () => {
    setFriendsGateway(fakeServer({ requests: [incoming(BO, "bo", "Bo")] }).gateway);
    await useFriendsStore.getState().refresh();
    expect(selectIncomingRequests(useFriendsStore.getState().status)).toHaveLength(1);

    await expect(useFriendsStore.getState().acceptRequest(BO)).resolves.toBe(true);

    const { status } = useFriendsStore.getState();
    expect(selectFriends(status)?.map((each) => each.username)).toEqual(["bo"]);
    expect(selectIncomingRequests(status)).toEqual([]);
    expect(useFriendsStore.getState().pending).toBeNull();
  });

  it("declining removes the request and adds nobody", async () => {
    setFriendsGateway(fakeServer({ requests: [incoming(BO, "bo", "Bo")] }).gateway);
    await useFriendsStore.getState().refresh();

    await useFriendsStore.getState().declineRequest(BO);

    const { status } = useFriendsStore.getState();
    expect(selectIncomingRequests(status)).toEqual([]);
    expect(selectFriends(status)).toEqual([]);
  });

  it("accepts instead of sending when they had already asked", async () => {
    // The server does this, not the client. The store has to render whatever it
    // reports rather than the outgoing request it expected to create.
    setFriendsGateway(
      fakeServer({
        requests: [incoming(BO, "bo", "Bo")],
        results: [result(BO, "bo", "incoming_pending")],
      }).gateway,
    );
    await useFriendsStore.getState().refresh();
    useFriendsStore.getState().setQuery("bo");
    await useFriendsStore.getState().search();

    await useFriendsStore.getState().sendRequest(BO);

    const { status, searchStatus } = useFriendsStore.getState();
    expect(selectFriends(status)?.map((each) => each.username)).toEqual(["bo"]);
    expect(
      searchStatus.kind === "results" ? searchStatus.results.map((r) => r.relationship) : null,
    ).toEqual(["friends"]);
  });

  it("changes nothing and says why when the server refuses", async () => {
    setFriendsGateway(fakeServer({ friends: [friend(ADA, "ada", "Ada")] }).gateway);
    await useFriendsStore.getState().refresh();

    // Nobody has asked, so accepting is refused by the fake exactly as the SQL
    // refuses it.
    await expect(useFriendsStore.getState().acceptRequest(CASS)).resolves.toBe(false);

    const { status, actionError, pending } = useFriendsStore.getState();
    expect(actionError).toBe("That request is no longer there.");
    expect(pending).toBeNull();
    expect(selectFriends(status)?.map((each) => each.username)).toEqual(["ada"]);
  });

  it("stops claiming a list when an action finds the session gone", async () => {
    setFriendsGateway(fakeServer({ friends: [friend(ADA, "ada", "Ada")] }).gateway);
    await useFriendsStore.getState().refresh();

    setFriendsGateway(refusing("signed-out", "Friends need an Arc 21 account."));
    await useFriendsStore.getState().removeFriend(ADA);

    const { status } = useFriendsStore.getState();
    expect(status.kind).toBe("signed-out");
    expect(selectFriends(status)).toBeNull();
  });
});

describe("removing and blocking", () => {
  it("takes a removed friend off the list", async () => {
    setFriendsGateway(
      fakeServer({ friends: [friend(ADA, "ada", "Ada"), friend(BO, "bo", "Bo")] }).gateway,
    );
    await useFriendsStore.getState().refresh();

    await expect(useFriendsStore.getState().removeFriend(ADA)).resolves.toBe(true);

    expect(selectFriends(useFriendsStore.getState().status)?.map((each) => each.username)).toEqual([
      "bo",
    ]);
  });

  it("takes a blocked player off the friends list", async () => {
    setFriendsGateway(
      fakeServer({
        friends: [friend(ADA, "ada", "Ada"), friend(BO, "bo", "Bo")],
        requests: [incoming(CASS, "cass", "Cass")],
      }).gateway,
    );
    await useFriendsStore.getState().refresh();

    await expect(useFriendsStore.getState().blockPlayer(ADA)).resolves.toBe(true);

    const { status } = useFriendsStore.getState();
    expect(selectFriends(status)?.map((each) => each.username)).toEqual(["bo"]);
    expect(selectFriend(status, ADA)).toBeNull();
    // Blocking one person leaves everybody else exactly where they were.
    expect(selectIncomingRequests(status)?.map((each) => each.username)).toEqual(["cass"]);
  });

  it("takes a blocked player out of the search results on screen", async () => {
    setFriendsGateway(
      fakeServer({
        friends: [friend(ADA, "ada", "Ada")],
        results: [result(ADA, "ada", "friends"), result(BO, "bo", "none")],
      }).gateway,
    );
    await useFriendsStore.getState().refresh();
    useFriendsStore.getState().setQuery("a");
    useFriendsStore.getState().setQuery("ad");
    await useFriendsStore.getState().search();

    await useFriendsStore.getState().blockPlayer(ADA);

    const { searchStatus } = useFriendsStore.getState();
    expect(searchStatus.kind === "results" ? searchStatus.results.map((r) => r.id) : null).toEqual([
      BO,
    ]);
  });

  it("re-reads the graph after every change rather than editing it locally", async () => {
    const { gateway, loads } = fakeServer({ friends: [friend(ADA, "ada", "Ada")] });
    setFriendsGateway(gateway);
    await useFriendsStore.getState().refresh();
    expect(loads.count).toBe(1);

    await useFriendsStore.getState().removeFriend(ADA);

    expect(loads.count).toBe(2);
  });

  it("puts a blocked player on the blocked list, read back from the server", async () => {
    setFriendsGateway(fakeServer({ friends: [friend(ADA, "ada", "Ada")] }).gateway);
    await useFriendsStore.getState().refresh();
    expect(selectBlocked(useFriendsStore.getState().blocked)).toEqual([]);

    await useFriendsStore.getState().blockPlayer(ADA);

    const { blocked } = useFriendsStore.getState();
    expect(selectBlocked(blocked)?.map((each) => each.username)).toEqual(["ada"]);
    expect(shouldShowBlocked(blocked)).toBe(true);
  });
});

describe("undoing a block", () => {
  it("takes the player off the blocked list", async () => {
    setFriendsGateway(
      fakeServer({
        blocked: [blockedPlayer(ADA, "ada", "Ada"), blockedPlayer(BO, "bo", "Bo")],
      }).gateway,
    );
    await useFriendsStore.getState().refresh();
    expect(selectBlocked(useFriendsStore.getState().blocked)).toHaveLength(2);

    await expect(useFriendsStore.getState().unblockPlayer(ADA)).resolves.toBe(true);

    const { blocked, pending } = useFriendsStore.getState();
    expect(selectBlocked(blocked)?.map((each) => each.username)).toEqual(["bo"]);
    expect(pending).toBeNull();
  });

  it("makes nobody a friend again", async () => {
    // Unblocking deletes a block and nothing else. Ada and the player were
    // friends before the block; they are strangers who can find each other
    // afterwards, and a friends list that gained a row here would be this app
    // inventing a friendship the server never reported.
    const { gateway } = fakeServer({ friends: [friend(BO, "bo", "Bo")] });
    setFriendsGateway(gateway);
    await useFriendsStore.getState().refresh();
    await useFriendsStore.getState().blockPlayer(BO);
    expect(selectFriends(useFriendsStore.getState().status)).toEqual([]);

    await useFriendsStore.getState().unblockPlayer(BO);

    const { status, blocked } = useFriendsStore.getState();
    expect(selectFriends(status)).toEqual([]);
    expect(selectBlocked(blocked)).toEqual([]);
  });

  it("re-reads the blocked list rather than editing it locally", async () => {
    const { gateway, blockedReads } = fakeServer({ blocked: [blockedPlayer(ADA, "ada", "Ada")] });
    setFriendsGateway(gateway);
    await useFriendsStore.getState().refresh();
    expect(blockedReads.count).toBe(1);

    await useFriendsStore.getState().unblockPlayer(ADA);

    expect(blockedReads.count).toBe(2);
  });

  it("does not spend a read on the blocked list after an unrelated action", async () => {
    const { gateway, blockedReads } = fakeServer({ friends: [friend(ADA, "ada", "Ada")] });
    setFriendsGateway(gateway);
    await useFriendsStore.getState().refresh();

    await useFriendsStore.getState().removeFriend(ADA);

    expect(blockedReads.count).toBe(1);
  });

  it("says the blocked list is unreadable rather than showing it as empty", async () => {
    const { gateway } = fakeServer({});
    setFriendsGateway({
      ...gateway,
      listBlocked: async () => ({
        ok: false,
        reason: "unreachable",
        message: "Your blocked list could not be read. Nobody has been unblocked.",
      }),
    });

    await useFriendsStore.getState().refresh();

    const { blocked, status } = useFriendsStore.getState();
    expect(blocked).toEqual({
      kind: "unavailable",
      message: "Your blocked list could not be read. Nobody has been unblocked.",
    });
    expect(selectBlocked(blocked)).toBeNull();
    // The friends half read cleanly and is not taken down with it.
    expect(status.kind).toBe("ready");
  });
});

describe("whether the Blocked section appears at all", () => {
  it("stays away entirely when the server says nobody is blocked", async () => {
    setFriendsGateway(fakeServer({ friends: [friend(ADA, "ada", "Ada")] }).gateway);

    await useFriendsStore.getState().refresh();

    const { blocked } = useFriendsStore.getState();
    expect(blocked).toEqual({ kind: "ready", blocked: [], dropped: 0 });
    // No heading, no "you have blocked nobody" — a player who has never needed
    // this is shown nothing rather than an empty moderation surface.
    expect(shouldShowBlocked(blocked)).toBe(false);
  });

  it("stays away before anything has been read, so it never precedes an answer", () => {
    expect(shouldShowBlocked({ kind: "idle" })).toBe(false);
    expect(shouldShowBlocked({ kind: "loading" })).toBe(false);
    expect(selectBlocked({ kind: "idle" })).toBeNull();
  });

  it("appears when the list is non-empty", () => {
    expect(
      shouldShowBlocked({ kind: "ready", blocked: [blockedPlayer(ADA, "ada", "Ada")], dropped: 0 }),
    ).toBe(true);
  });

  it("appears when the read failed, because silence would read as nobody blocked", () => {
    expect(shouldShowBlocked({ kind: "unavailable", message: "Could not be read." })).toBe(true);
  });

  it("appears when every row was dropped, so the count is not swallowed", () => {
    // Hiding this would tell somebody their block is gone when it is in force.
    expect(shouldShowBlocked({ kind: "ready", blocked: [], dropped: 2 })).toBe(true);
  });

  it("drops the blocked list on clear, so no list outlives a session", async () => {
    setFriendsGateway(fakeServer({ blocked: [blockedPlayer(ADA, "ada", "Ada")] }).gateway);
    await useFriendsStore.getState().refresh();
    expect(selectBlocked(useFriendsStore.getState().blocked)).toHaveLength(1);

    useFriendsStore.getState().clear();

    expect(useFriendsStore.getState().blocked).toEqual({ kind: "idle" });
    expect(selectBlocked(useFriendsStore.getState().blocked)).toBeNull();
  });
});
