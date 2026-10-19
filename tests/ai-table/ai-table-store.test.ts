/**
 * Sitting down at an AI table, from the client (Astra Refresh C).
 *
 * The store asks and nothing more: it sends `OPEN_AI_TABLE` with no other
 * field, keeps ONE request id across a lost reply, and turns each answer into
 * something the player can act on. What a computer player does is never on
 * this side of the wire.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.fn();
const refreshActive = vi.fn(async () => null);

vi.mock("../../src/lib/supabase/client.js", () => ({
  getSupabase: () => ({
    status: "ready",
    client: {
      auth: {
        getSession: async () => ({
          data: { session: { access_token: "token-u", user: { id: "u" } } },
          error: null,
        }),
      },
      functions: { invoke },
    },
  }),
}));

vi.mock("../../src/features/table/active-session-store.js", () => ({
  useActiveSessionStore: { getState: () => ({ refresh: refreshActive }) },
}));

const {
  AI_TABLE_ALREADY_SEATED,
  AI_TABLE_UNREACHABLE,
  AI_TABLE_UNREADABLE,
  readAiTableOpened,
  useAiTableStore,
} = await import("../../src/features/ai-table/ai-table-store.js");

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

const OPENED = {
  status: "ai_table_opened",
  gameId: "0d5a4a59-4f0e-4b0f-8b1c-1a2b3c4d5e6f",
  seatId: "9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d",
  tableStack: 5_000,
  resumed: false,
  publicState: {},
};

beforeEach(() => {
  invoke.mockReset();
  refreshActive.mockClear();
  useAiTableStore.setState({ opening: false, notice: null });
});

describe("asking for an AI table", () => {
  it("names the action and nothing else about the table", async () => {
    invoke.mockResolvedValue({ data: OPENED, error: null });
    await useAiTableStore.getState().open();

    const [fn, request] = invoke.mock.calls[0] as [string, { body: Record<string, unknown>; headers: Record<string, string> }];
    expect(fn).toBe("create-session");
    expect(Object.keys(request.body).sort()).toEqual(["action", "clientRequestId", "clientSentAt"]);
    expect(request.body.action).toBe("OPEN_AI_TABLE");
    // Sent as the player who asked.
    expect(request.headers.Authorization).toBe("Bearer token-u");
  });

  it("returns the table address on success, and asks where the player is seated now", async () => {
    invoke.mockResolvedValue({ data: OPENED, error: null });
    expect(await useAiTableStore.getState().open()).toEqual({
      gameId: OPENED.gameId,
      seatId: OPENED.seatId,
      resumed: false,
    });
    expect(useAiTableStore.getState().notice).toBeNull();
    expect(refreshActive).toHaveBeenCalled();
  });

  it("goes back to the AI table the player already holds", async () => {
    invoke.mockResolvedValue({ data: { ...OPENED, resumed: true }, error: null });
    expect((await useAiTableStore.getState().open())?.resumed).toBe(true);
  });

  it("keeps ONE request id across a lost reply, so a retry cannot seat anybody twice", async () => {
    invoke.mockResolvedValue({ data: null, error: { name: "FunctionsFetchError" } });
    expect(await useAiTableStore.getState().open()).toBeNull();
    expect(invoke).toHaveBeenCalledTimes(2);
    expect(invoke.mock.calls[1]).toEqual(invoke.mock.calls[0]);
    // And it does not pretend to know what happened: the table may exist.
    expect(useAiTableStore.getState().notice).toBe(AI_TABLE_UNREACHABLE);
    expect(refreshActive).toHaveBeenCalled();
  });

  it("points a player seated elsewhere at the table they hold, rather than inviting a retry", async () => {
    invoke.mockResolvedValue(rejected("SESSION_ALREADY_ACTIVE", "You are already seated at a table."));
    expect(await useAiTableStore.getState().open()).toBeNull();
    expect(useAiTableStore.getState().notice).toBe(AI_TABLE_ALREADY_SEATED);
    expect(useAiTableStore.getState().notice).not.toMatch(/try again/i);
    expect(refreshActive).toHaveBeenCalled();
  });

  it("passes any other refusal through in the server's own words", async () => {
    invoke.mockResolvedValue(rejected("RATE_LIMITED", "Too many requests. Try again in a moment."));
    expect(await useAiTableStore.getState().open()).toBeNull();
    expect(useAiTableStore.getState().notice).toMatch(/too many requests/i);
  });

  it("does not guess at a reply it cannot read", async () => {
    invoke.mockResolvedValue({ data: { status: "opened", gameId: 1 }, error: null });
    expect(await useAiTableStore.getState().open()).toBeNull();
    expect(useAiTableStore.getState().notice).toBe(AI_TABLE_UNREADABLE);
  });

  it("asks only once while an ask is in flight", async () => {
    let release: (value: unknown) => void = () => undefined;
    invoke.mockReturnValue(new Promise((resolve) => (release = resolve)));
    const first = useAiTableStore.getState().open();
    // Let the first ask reach the network before the second tap.
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledTimes(1));
    expect(await useAiTableStore.getState().open()).toBeNull();
    release({ data: OPENED, error: null });
    expect(await first).not.toBeNull();
    expect(invoke).toHaveBeenCalledTimes(1);
  });
});

describe("reading the reply", () => {
  it("accepts only an AI table's reply", () => {
    expect(readAiTableOpened(OPENED)).toEqual({ gameId: OPENED.gameId, seatId: OPENED.seatId, resumed: false });
    expect(readAiTableOpened({ ...OPENED, status: "opened" })).toBeNull();
    expect(readAiTableOpened({ ...OPENED, seatId: undefined })).toBeNull();
    expect(readAiTableOpened(null)).toBeNull();
    expect(readAiTableOpened("ai_table_opened")).toBeNull();
  });
});
