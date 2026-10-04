/**
 * Presence.
 *
 * The property these tests defend: **absence from the channel is not evidence
 * of being offline.** A friend who has never opened Social is not "offline",
 * they are unknown — and the screen must fall back to a timestamp rather than
 * assert a state nothing supports.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  describePresence,
  summarisePresence,
  presenceFromRows,
  usePresenceStore,
} from "../../src/features/presence/index.js";
import { setSupabaseAvailabilityForTests } from "../../src/lib/supabase/client.js";

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
    expect(describePresence("available")).toBe("Recently active");
    expect(describePresence("in_game")).toBe("In a game");
  });

  it("returns null for someone not on the channel, so the caller falls back", () => {
    // Not "Offline": that would be a claim. Null means "no evidence", and the
    // friend row then shows the last-seen timestamp instead.
    expect(describePresence(undefined)).toBeNull();
  });
});

// ---------------------------------------------------------------------------

/**
 * The DURABLE half of presence.
 *
 * `profiles.last_seen_at` was written by `handle_new_user` at signup and by
 * NOTHING ELSE. `list_friends()` returns it, `player_public_profile()` returns
 * it, and the row beneath every friend renders it through `describeLastSeen` —
 * whose own doc comment says the value is "written at some unstated moment in
 * the past". The specification asks for exactly this column as the fallback
 * under ephemeral presence, and what shipped was the account's creation date
 * wearing its clothes: a friend playing at that moment read as "Last seen over
 * a week ago" unless they happened to have the Social tab open, which is the
 * only place the channel is joined.
 *
 * These assert the CALL, because the SQL function is proved against the real
 * database in `tests/server/private-rooms.integration.test.ts` and a function
 * nobody calls is a feature that does not exist.
 */
describe("stamping last seen", () => {
  const ME = "33333333-3333-4333-8333-333333333333";

  function fakeSupabase(calls: string[]) {
    const channel = {
      on() {
        return this;
      },
      subscribe() {
        return this;
      },
      track() {
        return undefined;
      },
      presenceState() {
        return {};
      },
    };
    return {
      status: "ready" as const,
      client: {
        channel: () => channel,
        removeChannel: () => undefined,
        rpc: async (name: string) => {
          calls.push(name);
          return { data: null, error: null };
        },
      } as never,
    };
  }

  beforeEach(() => {
    usePresenceStore.getState().leave();
    setSupabaseAvailabilityForTests(null);
  });

  afterEach(() => {
    usePresenceStore.getState().leave();
    setSupabaseAvailabilityForTests(null);
  });

  it("stamps and reads the friend-scoped projection on join", () => {
    const calls: string[] = [];
    setSupabaseAvailabilityForTests(fakeSupabase(calls));

    usePresenceStore.getState().join(ME, "available");

    expect(calls).toEqual(["touch_last_seen", "list_friend_presence"]);
  });

  it("stamps again when the player sits down at a table", () => {
    const calls: string[] = [];
    setSupabaseAvailabilityForTests(fakeSupabase(calls));

    usePresenceStore.getState().join(ME, "available");
    usePresenceStore.getState().setOwnState("in_game");

    expect(calls).toEqual(["touch_last_seen", "list_friend_presence", "touch_last_seen"]);
  });

  it("stamps for a player who never opened Social, so the fallback is still true", () => {
    // `setOwnState` returns early when there is no channel — which is most
    // players, since the channel is joined on the Social tab and only there.
    // The durable stamp must not be inside that early return.
    const calls: string[] = [];
    setSupabaseAvailabilityForTests(fakeSupabase(calls));

    usePresenceStore.getState().setOwnState("in_game");

    expect(calls).toEqual(["touch_last_seen"]);
    expect(usePresenceStore.getState().joined).toBe(false);
  });

  it("asks nothing at all when there is no server in this build", () => {
    setSupabaseAvailabilityForTests({
      status: "not-configured",
      problems: [],
      message: "no server configured",
    });

    // No throw, no request, and no pretence of presence.
    usePresenceStore.getState().join(ME, "available");
    usePresenceStore.getState().setOwnState("in_game");
    expect(usePresenceStore.getState().joined).toBe(false);
  });
});


describe("verified friend presence projection", () => {
  afterEach(() => {
    usePresenceStore.getState().leave();
    setSupabaseAvailabilityForTests(null);
    vi.useRealTimers();
  });

  it("accepts server user_id rows and rejects spoof-shaped client metadata", () => {
    const result = presenceFromRows([
      { user_id: A, state: "available" },
      { user_id: B, state: "in_game" },
      { userId: A, state: "in_game" },
      { user_id: "not-a-uuid", state: "available" },
    ]);
    expect([...result]).toEqual([[A, "available"], [B, "in_game"]]);
  });

  it("never publishes an identity and drops delayed presence after leaving", async () => {
    let finish!: (value: unknown) => void;
    const pending = new Promise((resolve) => { finish = resolve; });
    const calls: Array<{ name: string; args: unknown }> = [];
    setSupabaseAvailabilityForTests({ status: "ready", client: {
      rpc: (name: string, args: unknown) => {
        calls.push({ name, args });
        return name === "list_friend_presence" ? pending : Promise.resolve({ data: null, error: null });
      },
      channel: () => { throw new Error("shared presence channels must not be used"); },
    } as never });
    usePresenceStore.getState().join(A, "in_game");
    usePresenceStore.getState().leave();
    finish({ data: [{ user_id: B, state: "available" }], error: null });
    await Promise.resolve();
    await Promise.resolve();
    expect(calls).toEqual([{ name: "touch_last_seen", args: undefined }, { name: "list_friend_presence", args: undefined }]);
    expect(usePresenceStore.getState().online.size).toBe(0);
    expect(usePresenceStore.getState().joined).toBe(false);
  });

  it("expires the displayed projection when the next heartbeat cannot be read", async () => {
    vi.useFakeTimers();
    let failed = false;
    setSupabaseAvailabilityForTests({ status: "ready", client: {
      rpc: async (name: string) => name === "touch_last_seen"
        ? { data: null, error: null }
        : failed ? { data: null, error: { message: "unreachable" } }
        : { data: [{ user_id: B, state: "available" }], error: null },
    } as never });
    usePresenceStore.getState().join(A, "available");
    await vi.advanceTimersByTimeAsync(0);
    expect(usePresenceStore.getState().online.get(B)).toBe("available");
    failed = true;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(usePresenceStore.getState().online.size).toBe(0);
    expect(usePresenceStore.getState().joined).toBe(false);
  });
});
