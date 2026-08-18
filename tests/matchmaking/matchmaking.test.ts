/**
 * Matchmaking.
 *
 * What these defend: the screen never invents a queue position, never claims a
 * charge that has not happened, and always offers a way out of a long wait.
 */

import { describe, expect, it } from "vitest";

import {
  OFFER_ALTERNATIVES_AFTER_MS,
  describeWait,
  shouldOfferAlternatives,
  toQueuePlace,
} from "../../src/features/matchmaking/index.js";

const ROOM = "33333333-3333-4333-8333-333333333333";

function row(overrides: Record<string, unknown> = {}) {
  return {
    status: "waiting",
    tier: "casual",
    room_id: null,
    room_code: null,
    waiting_since: "2026-08-17T00:00:00.000Z",
    queued_at_tier: 0,
    ...overrides,
  };
}

describe("reading a place in the queue", () => {
  it("parses a waiting row", () => {
    const place = toQueuePlace(row());
    expect(place?.status).toBe("waiting");
    expect(place?.tier).toBe("casual");
    expect(place?.roomId).toBeNull();
  });

  it("parses a matched row and carries the room", () => {
    const place = toQueuePlace(row({ status: "matched", room_id: ROOM, queued_at_tier: 2 }));
    expect(place?.status).toBe("matched");
    expect(place?.roomId).toBe(ROOM);
    expect(place?.seatedBefore).toBe(2);
  });

  it("accepts either a bare row or a single-row array", () => {
    // PostgREST returns a row for a scalar function and an array for a
    // set-returning one; depending on which would break on a schema change.
    expect(toQueuePlace([row()])?.status).toBe("waiting");
    expect(toQueuePlace(row())?.status).toBe("waiting");
  });

  it("rejects a malformed row rather than half-reading it", () => {
    expect(toQueuePlace({ status: "waiting" })).toBeNull();
    expect(toQueuePlace({ ...row(), status: "on-fire" })).toBeNull();
    expect(toQueuePlace({ ...row(), room_id: "not-a-uuid" })).toBeNull();
    expect(toQueuePlace(null)).toBeNull();
    expect(toQueuePlace([])).toBeNull();
  });

  it("treats an unreadable timestamp as a long wait, not a fresh one", () => {
    // The safe direction: a player whose clock cannot be read is offered a way
    // out immediately rather than left waiting on a timer that never advances.
    const place = toQueuePlace(row({ waiting_since: "not a date" }));
    expect(place).not.toBeNull();
    expect(shouldOfferAlternatives(place!.waitingSince, new Date())).toBe(true);
  });
});

describe("offering a way out", () => {
  const start = new Date("2026-08-17T00:00:00.000Z");

  it("does not offer immediately", () => {
    expect(shouldOfferAlternatives(start, new Date(start.getTime() + 1_000))).toBe(false);
  });

  it("offers at the boundary, not one tick after", () => {
    expect(
      shouldOfferAlternatives(start, new Date(start.getTime() + OFFER_ALTERNATIVES_AFTER_MS)),
    ).toBe(true);
  });

  it("still offers well past it", () => {
    expect(shouldOfferAlternatives(start, new Date(start.getTime() + 120_000))).toBe(true);
  });
});

describe("what the player is told", () => {
  const start = new Date("2026-08-17T00:00:00.000Z");
  const waiting = toQueuePlace(row({ waiting_since: start.toISOString() }))!;

  it("says a seat was found once matched", () => {
    const matched = toQueuePlace(row({ status: "matched", room_id: ROOM }))!;
    expect(describeWait(matched, start)).toBe("Seat found.");
  });

  it("never invents a queue position", () => {
    // The server reports no position. A number here would be one the player
    // could watch fail to move.
    const text = describeWait(waiting, new Date(start.getTime() + 30_000));
    expect(text).not.toMatch(/\b\d+(st|nd|rd|th)\b/);
    expect(text).toMatch(/still looking/i);
  });

  it("says plainly that a timed-out search cost nothing", () => {
    // Matchmaking moves no chips, and a player who waited and got nothing must
    // not be left wondering whether they were charged.
    const expired = toQueuePlace(row({ status: "expired" }))!;
    expect(describeWait(expired, start)).toMatch(/nothing was charged/i);
  });

  it("distinguishes cancelling from timing out", () => {
    const cancelled = toQueuePlace(row({ status: "cancelled" }))!;
    expect(describeWait(cancelled, start)).toMatch(/cancelled/i);
  });
});
