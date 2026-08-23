/**
 * What a player is TOLD when a seat is refused.
 *
 * `takeSeat` collapsed every failure into one sentence — "That seat could not
 * be taken. Nothing has been charged." — which is true of all of them and
 * useful for only some. The refusal it is most likely to be says the opposite
 * of what that sentence implies: the player's chips are already in escrow at
 * another table, so "try again" sends them somewhere that will refuse them for
 * ever.
 *
 * That state was reachable and paid twice before the server grew the guard that
 * produces `SESSION_ALREADY_ACTIVE` here — see
 * `tests/server/economy-guards.integration.test.ts`, which proves the server
 * half against the running stack. This file is the other half of the lesson
 * this repository keeps relearning: test the CONTROL, not only the function
 * behind it. A guard the client renders as a shrug is a guard nobody can act on.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.fn();
const rpc = vi.fn();

vi.mock("../../src/lib/supabase/client.js", () => ({
  getSupabase: () => ({
    status: "ready",
    client: {
      auth: { getSession: async () => ({ data: { session: { user: { id: "u" } } } }) },
      rpc,
      functions: { invoke },
    },
  }),
}));

vi.mock("../../src/features/wallet/wallet-store.js", () => ({
  useWalletStore: { getState: () => ({ refresh: () => undefined }) },
}));

const { useMatchmakingStore } = await import("../../src/features/matchmaking/matchmaking-store.js");

/** A rejection exactly as `functions.invoke` reports one: the Response, not the body. */
function rejected(code: string, message: string) {
  return {
    data: null,
    error: {
      name: "FunctionsHttpError",
      context: { json: async () => ({ status: "rejected", code, message }) },
    },
  };
}

const MATCHED = {
  status: {
    kind: "matched" as const,
    place: {
      status: "matched" as const,
      tier: "casual" as const,
      roomId: "room-1",
      seatedBefore: 0,
      waitingSince: new Date(0),
    },
  },
  notice: null,
};

beforeEach(() => {
  invoke.mockReset();
  rpc.mockReset();
  useMatchmakingStore.setState({ status: { kind: "idle" }, notice: null });
});

describe("taking a matched seat", () => {
  it("names the table already holding the player's chips", async () => {
    useMatchmakingStore.setState(MATCHED);
    invoke.mockResolvedValue(rejected("SESSION_ALREADY_ACTIVE", "You are already seated at a table."));

    const seat = await useMatchmakingStore.getState().takeSeat();

    expect(seat).toBeNull();
    const { notice, status } = useMatchmakingStore.getState();
    expect(notice).toMatch(/already seated/i);
    expect(notice).toMatch(/leave that table/i);
    // And it does not invite a retry that would be refused identically.
    expect(notice).not.toMatch(/try again/i);
    // The match is over: the player must go to the table they are at.
    expect(status.kind).toBe("idle");
  });

  it("passes any other refusal through in the server's own words", async () => {
    useMatchmakingStore.setState(MATCHED);
    invoke.mockResolvedValue(rejected("TABLE_LOCKED", "This table is not available at your level yet."));

    expect(await useMatchmakingStore.getState().takeSeat()).toBeNull();
    expect(useMatchmakingStore.getState().notice).toMatch(/not available at your level/i);
  });

  it("still says nothing was charged when the refusal cannot be read", async () => {
    // A 503 from the gateway, an HTML error page, a body that fails the schema:
    // this client did not learn what happened and must not invent a reason.
    useMatchmakingStore.setState(MATCHED);
    invoke.mockResolvedValue({ data: null, error: { name: "FunctionsFetchError" } });

    expect(await useMatchmakingStore.getState().takeSeat()).toBeNull();
    expect(useMatchmakingStore.getState().notice).toMatch(/nothing has been charged/i);
  });

  it("returns the ids on success", async () => {
    useMatchmakingStore.setState(MATCHED);
    invoke.mockResolvedValue({ data: { gameId: "g1", seatId: "s1" }, error: null });

    expect(await useMatchmakingStore.getState().takeSeat()).toEqual({ gameId: "g1", seatId: "s1" });
    expect(useMatchmakingStore.getState().notice).toBeNull();
  });
});

describe("queueing", () => {
  it("shows the server's refusal when the player already holds a seat", async () => {
    // The COURTESY half. `join_matchmaking` raises rather than enrolling, and
    // the server's own wording is more useful than anything this layer could
    // infer — the same reason the level gate's message is passed through.
    rpc.mockResolvedValue({ data: null, error: { message: "you are already seated at a table" } });

    await useMatchmakingStore.getState().queue("casual");

    expect(useMatchmakingStore.getState().notice).toMatch(/already seated/i);
  });
});
