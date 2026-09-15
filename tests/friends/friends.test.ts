/**
 * What arrives from the friend RPCs, and what a row is allowed to say.
 *
 * The rule this file enforces is that a friend list is made of *people*. A row
 * that does not parse must not become a card with a blank name or a player
 * called "undefined" — it is dropped and counted, so the screen can say the
 * list is short rather than quietly presenting a shorter one as complete.
 *
 * The second rule is that nothing here reveals a block. The server reports
 * acting on a blocked player as "no such player" on purpose, and any wording
 * that distinguished the two would confirm both that the account exists and who
 * blocked whom.
 */

import { describe, expect, it } from "vitest";

import {
  applySearchRelationship,
  describeLastSeen,
  describeRpcFailure,
  presentRequest,
  presentSearchResult,
  presentUnblockConfirmation,
  toBlockedPlayers,
  toFriendRequests,
  toFriends,
  toRelationshipState,
  toSearchResults,
  type SearchResult,
} from "../../src/features/friends/friends.js";

const ADA = "11111111-1111-4111-8111-111111111111";
const BO = "22222222-2222-4222-8222-222222222222";
const CASS = "33333333-3333-4333-8333-333333333333";

const NOW = new Date("2026-08-16T12:00:00.000Z");

describe("friend rows", () => {
  it("accepts a well-formed row", () => {
    const { friends, dropped } = toFriends([
      {
        id: ADA,
        username: "ada",
        display_name: "Ada",
        level: 7,
        last_seen_at: "2026-08-16T11:00:00.000Z",
      },
    ]);

    expect(dropped).toBe(0);
    expect(friends).toEqual([
      {
        id: ADA,
        username: "ada",
        displayName: "Ada",
        level: 7,
        lastSeenAt: "2026-08-16T11:00:00.000Z",
      },
    ]);
  });

  it.each([
    ["an id that is not a uuid", { id: "ada" }],
    ["an empty display name", { display_name: "" }],
    ["a fractional level", { level: 7.5 }],
    ["a level that is a string", { level: "7" }],
    ["a missing username", { username: undefined }],
    ["a missing last seen", { last_seen_at: undefined }],
  ])("drops a row with %s rather than rendering it", (_label, override) => {
    const { friends, dropped } = toFriends([
      {
        id: ADA,
        username: "ada",
        display_name: "Ada",
        level: 7,
        last_seen_at: "2026-08-16T11:00:00.000Z",
        ...override,
      },
    ]);

    expect(friends).toHaveLength(0);
    expect(dropped).toBe(1);
  });

  it("keeps the legible rows and counts the rest", () => {
    const { friends, dropped } = toFriends([
      {
        id: ADA,
        username: "ada",
        display_name: "Ada",
        level: 7,
        last_seen_at: "2026-08-16T11:00:00.000Z",
      },
      { id: "not-a-uuid", username: "bo", display_name: "Bo", level: 2, last_seen_at: "x" },
      null,
      "a string is not a row",
    ]);

    expect(friends.map((friend) => friend.username)).toEqual(["ada"]);
    expect(dropped).toBe(3);
  });
});

describe("search rows", () => {
  it("drops a relationship the client does not understand", () => {
    // A value outside the four the contract names would otherwise reach a
    // switch that has no branch for it, and render a row with no action.
    const { results, dropped } = toSearchResults([
      { id: ADA, username: "ada", display_name: "Ada", level: 3, relationship: "friends" },
      { id: BO, username: "bo", display_name: "Bo", level: 3, relationship: "acquaintance" },
    ]);

    expect(results.map((result) => result.relationship)).toEqual(["friends"]);
    expect(dropped).toBe(1);
  });
});

describe("request rows", () => {
  it("puts incoming requests first, newest first inside each group", () => {
    const { requests, dropped } = toFriendRequests([
      {
        direction: "outgoing",
        other_id: ADA,
        username: "ada",
        display_name: "Ada",
        created_at: "2026-08-16T11:00:00.000Z",
      },
      {
        direction: "incoming",
        other_id: BO,
        username: "bo",
        display_name: "Bo",
        created_at: "2026-08-16T10:00:00.000Z",
      },
      {
        direction: "incoming",
        other_id: CASS,
        username: "cass",
        display_name: "Cass",
        created_at: "2026-08-16T09:00:00.000Z",
      },
    ]);

    expect(dropped).toBe(0);
    expect(requests.map((request) => request.username)).toEqual(["bo", "cass", "ada"]);
  });

  it("drops a request with an unknown direction", () => {
    const { requests, dropped } = toFriendRequests([
      {
        direction: "sideways",
        other_id: ADA,
        username: "ada",
        display_name: "Ada",
        created_at: "2026-08-16T11:00:00.000Z",
      },
    ]);

    expect(requests).toEqual([]);
    expect(dropped).toBe(1);
  });
});

describe("blocked rows", () => {
  const ROW = {
    id: ADA,
    username: "ada",
    display_name: "Ada",
    blocked_at: "2026-08-16T11:00:00.000Z",
  };

  it("accepts a well-formed row", () => {
    const { blocked, dropped } = toBlockedPlayers([ROW]);

    expect(dropped).toBe(0);
    expect(blocked).toEqual([
      { id: ADA, username: "ada", displayName: "Ada", blockedAt: "2026-08-16T11:00:00.000Z" },
    ]);
  });

  it.each([
    ["an id that is not a uuid", { id: "ada" }],
    ["a missing id", { id: undefined }],
    ["an empty username", { username: "" }],
    ["an empty display name", { display_name: "" }],
    ["a missing blocked-at", { blocked_at: undefined }],
    ["a blocked-at that is not a string", { blocked_at: 1_770_000_000 }],
  ])("drops a row with %s rather than rendering it", (_label, override) => {
    const { blocked, dropped } = toBlockedPlayers([{ ...ROW, ...override }]);

    expect(blocked).toHaveLength(0);
    expect(dropped).toBe(1);
  });

  it("keeps the legible rows, counts the rest, and holds the server's order", () => {
    // The count is what lets the screen say a block it cannot list is still in
    // force. Silently showing two of three would say the third was lifted.
    const { blocked, dropped } = toBlockedPlayers([
      ROW,
      { ...ROW, id: BO, username: "bo", display_name: "Bo", blocked_at: "not-empty" },
      { ...ROW, id: "not-a-uuid" },
      null,
      "a string is not a row",
      { id: CASS },
    ]);

    expect(blocked.map((player) => player.username)).toEqual(["ada", "bo"]);
    expect(dropped).toBe(4);
  });

  it("reads no direction from a row, so it cannot carry who blocked you", () => {
    // `list_blocked` returns only the caller's own blocks. There is deliberately
    // no field here that could say otherwise.
    const { blocked } = toBlockedPlayers([{ ...ROW, direction: "incoming" }]);

    expect(blocked).toEqual([
      { id: ADA, username: "ada", displayName: "Ada", blockedAt: "2026-08-16T11:00:00.000Z" },
    ]);
  });
});

describe("what unblocking says it does", () => {
  const PLAYER = {
    id: ADA,
    username: "ada",
    displayName: "Ada",
    blockedAt: "2026-08-16T11:00:00.000Z",
  };

  it("names the person in the question", () => {
    expect(presentUnblockConfirmation(PLAYER).title).toBe("Unblock Ada?");
  });

  it("says they become strangers, not friends again", () => {
    const { body } = presentUnblockConfirmation(PLAYER);

    expect(body).toContain("strangers again");
    expect(body).toContain("does not make you friends");
    expect(body).toContain("does not bring back a friendship");
  });

  it("does not promise that anything is restored", () => {
    const body = presentUnblockConfirmation(PLAYER).body.toLowerCase();

    expect(body).not.toContain("restore");
    expect(body).not.toContain("friends again");
  });

  it("says the other person is not told, as they were not told about the block", () => {
    expect(presentUnblockConfirmation(PLAYER).body).toContain("They are not told");
  });
});

describe("what a request row offers", () => {
  it("renders an incoming request as acceptable", () => {
    const view = presentRequest({
      direction: "incoming",
      id: BO,
      username: "bo",
      displayName: "Bo",
      createdAt: "2026-08-16T10:00:00.000Z",
    });

    expect(view.canAccept).toBe(true);
    expect(view.canDecline).toBe(true);
    expect(view.title).toBe("Bo");
    expect(view.handle).toBe("@bo");
    expect(view.detail).toBe("Wants to be your friend");
  });

  it("offers nothing on an outgoing request, and says who is being waited on", () => {
    // There is no server operation for withdrawing a request, so a button that
    // appeared to do it would be a lie about what the tap did.
    const view = presentRequest({
      direction: "outgoing",
      id: ADA,
      username: "ada",
      displayName: "Ada",
      createdAt: "2026-08-16T10:00:00.000Z",
    });

    expect(view.canAccept).toBe(false);
    expect(view.canDecline).toBe(false);
    expect(view.detail).toBe("Sent — waiting for them to accept");
  });
});

describe("what a search row offers", () => {
  function row(relationship: SearchResult["relationship"]): SearchResult {
    return { id: BO, username: "bo", displayName: "Bo", level: 4, relationship };
  }

  it("offers Add to a stranger", () => {
    const view = presentSearchResult(row("none"));
    expect(view.action).toBe("add");
    expect(view.actionLabel).toBe("Add");
    expect(view.detail).toBe("Level 4");
  });

  it("offers Accept to someone who already asked", () => {
    const view = presentSearchResult(row("incoming_pending"));
    expect(view.action).toBe("accept");
    expect(view.actionLabel).toBe("Accept");
  });

  it("offers nothing to an existing friend or an unanswered request", () => {
    expect(presentSearchResult(row("friends")).action).toBeNull();
    expect(presentSearchResult(row("friends")).detail).toBe("Already your friend");
    expect(presentSearchResult(row("outgoing_pending")).action).toBeNull();
    expect(presentSearchResult(row("outgoing_pending")).detail).toBe(
      "Request sent — waiting for them",
    );
  });
});

describe("re-stating a row from the server's answer", () => {
  const results: readonly SearchResult[] = [
    { id: ADA, username: "ada", displayName: "Ada", level: 3, relationship: "none" },
    { id: BO, username: "bo", displayName: "Bo", level: 4, relationship: "none" },
  ];

  it("marks the row the server just changed", () => {
    const next = applySearchRelationship(results, BO, "outgoing_pending");

    expect(next.map((result) => result.relationship)).toEqual(["none", "outgoing_pending"]);
  });

  it("takes a blocked player out of the results", () => {
    // A repeat of the same search would no longer return them, so leaving the
    // row on screen would show a player who is no longer findable.
    const next = applySearchRelationship(results, BO, "blocked");

    expect(next.map((result) => result.id)).toEqual([ADA]);
  });

  it("reads the text the RPCs return, and refuses anything else", () => {
    expect(toRelationshipState("friends")).toBe("friends");
    expect(toRelationshipState("blocked")).toBe("blocked");
    expect(toRelationshipState("maybe")).toBeNull();
    expect(toRelationshipState(null)).toBeNull();
  });
});

describe("last seen", () => {
  it.each([
    ["2026-08-16T11:59:40.000Z", "Last seen just now"],
    ["2026-08-16T11:59:00.000Z", "Last seen 1 minute ago"],
    ["2026-08-16T11:30:00.000Z", "Last seen 30 minutes ago"],
    ["2026-08-16T09:00:00.000Z", "Last seen 3 hours ago"],
    ["2026-08-14T12:00:00.000Z", "Last seen 2 days ago"],
    ["2026-07-16T12:00:00.000Z", "Last seen over a week ago"],
  ])("describes %s as %s", (lastSeenAt, expected) => {
    expect(describeLastSeen(lastSeenAt, NOW)).toBe(expected);
  });

  it("says the time is unknown rather than inventing one", () => {
    expect(describeLastSeen("whenever", NOW)).toBe("Last seen unknown");
  });

  it("never claims somebody is online", () => {
    // Presence needs a live channel this build does not have. Every phrasing
    // here is about the past for that reason.
    const phrasings = [
      describeLastSeen("2026-08-16T11:59:40.000Z", NOW),
      describeLastSeen("2026-08-16T09:00:00.000Z", NOW),
      describeLastSeen("nonsense", NOW),
    ];

    for (const phrasing of phrasings) {
      expect(phrasing.toLowerCase()).not.toContain("online");
      expect(phrasing.startsWith("Last seen")).toBe(true);
    }
  });
});

describe("refusals", () => {
  it("says a player was not found, and never that they blocked you", () => {
    const message = describeRpcFailure({ message: "no such player", code: "PT404" });

    expect(message).toBe("That player could not be found.");
    expect(message.toLowerCase()).not.toContain("block");
  });

  it("passes on the two mistakes a player can actually correct", () => {
    expect(describeRpcFailure({ message: "you cannot add yourself" })).toBe(
      "You cannot add yourself.",
    );
    expect(describeRpcFailure({ message: "there is no pending request from that player" })).toBe(
      "That request is no longer there.",
    );
  });

  it("does not repeat a message that was written for a log", () => {
    expect(describeRpcFailure({ message: 'relation "friend_requests" does not exist' })).toBe(
      "That did not go through, and nothing has changed.",
    );
    expect(describeRpcFailure(null)).toBe("That did not go through, and nothing has changed.");
  });
});
