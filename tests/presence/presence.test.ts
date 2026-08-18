/**
 * Presence.
 *
 * The property these tests defend: **absence from the channel is not evidence
 * of being offline.** A friend who has never opened Social is not "offline",
 * they are unknown — and the screen must fall back to a timestamp rather than
 * assert a state nothing supports.
 */

import { describe, expect, it } from "vitest";

import { describePresence, summarisePresence } from "../../src/features/presence/index.js";

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";

describe("summarising the channel", () => {
  it("reads a single available player", () => {
    const online = summarisePresence({ [A]: [{ userId: A, state: "available" }] });
    expect(online.get(A)).toBe("available");
  });

  it("prefers in_game when one person holds two entries", () => {
    // Signing in on two devices is permitted, so one player can publish twice.
    // Someone at a table on their phone is at a table, whatever the tablet
    // idling on Home is reporting.
    const online = summarisePresence({
      [A]: [
        { userId: A, state: "available" },
        { userId: A, state: "in_game" },
      ],
    });
    expect(online.get(A)).toBe("in_game");
  });

  it("does not let a later available entry downgrade in_game", () => {
    const online = summarisePresence({
      [A]: [
        { userId: A, state: "in_game" },
        { userId: A, state: "available" },
      ],
    });
    expect(online.get(A)).toBe("in_game");
  });

  it("drops a malformed entry rather than inventing someone online", () => {
    const online = summarisePresence({
      [A]: [{ userId: A, state: "available" }],
      [B]: [{ userId: "not-a-uuid", state: "available" }],
      junk: [{ state: "available" }],
    });

    expect(online.get(A)).toBe("available");
    expect(online.has(B)).toBe(false);
    expect(online.size).toBe(1);
  });

  it("survives a payload that is not a presence map at all", () => {
    expect(summarisePresence(null).size).toBe(0);
    expect(summarisePresence("nonsense").size).toBe(0);
    expect(summarisePresence({ [A]: "not-an-array" }).size).toBe(0);
  });

  it("ignores a state outside the two it publishes", () => {
    // `offline` is never published — it is the absence of an entry — so a
    // payload claiming it is malformed and dropped.
    const online = summarisePresence({ [A]: [{ userId: A, state: "offline" }] });
    expect(online.size).toBe(0);
  });
});

describe("what a row says", () => {
  it("names the two live states", () => {
    expect(describePresence("available")).toBe("Online");
    expect(describePresence("in_game")).toBe("In a game");
  });

  it("returns null for someone not on the channel, so the caller falls back", () => {
    // Not "Offline": that would be a claim. Null means "no evidence", and the
    // friend row then shows the last-seen timestamp instead.
    expect(describePresence(undefined)).toBeNull();
  });
});
