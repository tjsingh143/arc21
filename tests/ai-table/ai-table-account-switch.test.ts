/**
 * Refresh C audit finding C-3: an AI-table open that player A started must not
 * outlive A on this device.
 *
 * The audit held A's `OPEN_AI_TABLE` reply, replaced the player, released the
 * reply, and found the store at `{ opening: true }` with the replacement
 * player's `open()` returning null WITHOUT SENDING — so "Sit down" stayed
 * disabled for B for the life of the process. The scoped setter had correctly
 * refused to write A's late answer into B's state; that included the line that
 * cleared `opening`, and `resetPlayerState()` reset Quick Play's equivalent
 * flag but not this store's.
 *
 * Driven through the PRODUCTION store, the production `sendSessionIntent` and
 * the production `resetPlayerState()` (what `usePlayerState` calls at the
 * identity boundary). Only the transport is fake, and its replies are released
 * by hand, so the ordering is the test's and never the scheduler's.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const auth = vi.hoisted(() => ({ userId: "player-a", token: "token-a" }));
const invoke = vi.hoisted(() => vi.fn());
const refreshActive = vi.hoisted(() => vi.fn(async () => null));

vi.mock("../../src/lib/supabase/client.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/lib/supabase/client.js")>()),
  getSupabase: () => ({
    status: "ready",
    client: {
      auth: {
        getSession: async () => ({
          data: { session: { access_token: auth.token, user: { id: auth.userId } } },
          error: null,
        }),
      },
      functions: { invoke },
    },
  }),
}));

// The active-session store's own refresh is not what is under test, but the
// reset touches its state, so the fake carries the store surface the reset uses.
vi.mock("../../src/features/table/active-session-store.js", () => ({
  useActiveSessionStore: {
    getState: () => ({ refresh: refreshActive }),
    setState: () => undefined,
    getInitialState: () => ({}),
  },
}));

const { useAiTableStore } = await import("../../src/features/ai-table/ai-table-store.js");
const { resetPlayerState } = await import("../../src/features/player/reset-player-state.js");

interface Held {
  resolve(value: unknown): void;
  reject(error: unknown): void;
}

/** The next `invoke` waits until the test releases it. */
function holdNextReply(): Held {
  const held = {} as Held;
  invoke.mockImplementationOnce(
    () =>
      new Promise((resolve, reject) => {
        held.resolve = resolve;
        held.reject = reject;
      }),
  );
  return held;
}

const opened = (gameId: string) => ({
  data: {
    status: "ai_table_opened",
    gameId,
    seatId: `${gameId}-seat`,
    tableStack: 5_000,
    resumed: false,
    publicState: {},
  },
  error: null,
});

function rejected(code: string, message: string) {
  return {
    data: null,
    error: { name: "FunctionsHttpError", context: { json: async () => ({ status: "rejected", code, message }) } },
  };
}

const sentAs = (): string[] =>
  invoke.mock.calls.map((call) => (call[1] as { headers: Record<string, string> }).headers.Authorization!);

async function untilSent(count: number): Promise<void> {
  for (let tick = 0; tick < 200 && invoke.mock.calls.length < count; tick += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  expect(invoke).toHaveBeenCalledTimes(count);
}

/** The account switch, in the order the app performs it. */
function switchToPlayerB(): void {
  auth.userId = "player-b";
  auth.token = "token-b";
  resetPlayerState();
}

beforeEach(() => {
  auth.userId = "player-a";
  auth.token = "token-a";
  invoke.mockReset();
  refreshActive.mockClear();
  resetPlayerState();
  // Directly as well, so one case's stuck flag cannot fail the next one: each
  // case must fail or pass on its own ordering.
  useAiTableStore.setState({ opening: false, notice: null });
});

afterEach(() => {
  resetPlayerState();
});

describe("C-3: player A's AI-table open never holds player B's entry", () => {
  it("THE AUDIT'S ORDER: A's reply lands after the switch, and B can still sit down", async () => {
    const aReply = holdNextReply();
    const aOpen = useAiTableStore.getState().open();
    await untilSent(1);
    expect(useAiTableStore.getState().opening).toBe(true);

    switchToPlayerB();
    // B's screen is not busy with A's request.
    expect(useAiTableStore.getState().opening).toBe(false);

    aReply.resolve(opened("game-a"));
    // A's table is never handed to B's screen to navigate into.
    expect(await aOpen).toBeNull();
    expect(useAiTableStore.getState()).toMatchObject({ opening: false, notice: null });

    invoke.mockResolvedValueOnce(opened("game-b"));
    expect(await useAiTableStore.getState().open()).toEqual({ gameId: "game-b", seatId: "game-b-seat", resumed: false });
    expect(sentAs()).toEqual(["Bearer token-a", "Bearer token-b"]);
    expect(useAiTableStore.getState().opening).toBe(false);
  });

  it("A's reply landing WHILE B's own open is in flight does not clear or answer B's", async () => {
    const aReply = holdNextReply();
    const aOpen = useAiTableStore.getState().open();
    await untilSent(1);
    switchToPlayerB();

    const bReply = holdNextReply();
    const bOpen = useAiTableStore.getState().open();
    await untilSent(2);
    expect(useAiTableStore.getState().opening).toBe(true);

    aReply.resolve(opened("game-a"));
    expect(await aOpen).toBeNull();
    // Still B's request outstanding: A's late answer did not touch it.
    expect(useAiTableStore.getState().opening).toBe(true);

    bReply.resolve(opened("game-b"));
    expect((await bOpen)?.gameId).toBe("game-b");
    expect(useAiTableStore.getState().opening).toBe(false);
    expect(sentAs()).toEqual(["Bearer token-a", "Bearer token-b"]);
  });

  it("A's late REFUSAL writes nothing into B's screen", async () => {
    const aReply = holdNextReply();
    const aOpen = useAiTableStore.getState().open();
    await untilSent(1);
    switchToPlayerB();

    aReply.resolve(rejected("SESSION_ALREADY_ACTIVE", "You are already seated at a table."));
    expect(await aOpen).toBeNull();
    expect(useAiTableStore.getState()).toMatchObject({ opening: false, notice: null });
  });

  it("A's late TRANSPORT FAILURE is not retried as B, and leaves B free to open", async () => {
    const aReply = holdNextReply();
    const aOpen = useAiTableStore.getState().open();
    await untilSent(1);
    switchToPlayerB();

    aReply.reject(new Error("socket hang up"));
    expect(await aOpen).toBeNull();
    // The response-loss retry belongs to A's intent; it is abandoned, not sent as anyone.
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(useAiTableStore.getState()).toMatchObject({ opening: false, notice: null });

    invoke.mockResolvedValueOnce(opened("game-b"));
    expect((await useAiTableStore.getState().open())?.gameId).toBe("game-b");
  });

  it("control: with no switch, the same held reply is the player's own and is honoured", async () => {
    const aReply = holdNextReply();
    const aOpen = useAiTableStore.getState().open();
    await untilSent(1);
    // A second tap while the first is outstanding sends nothing.
    expect(await useAiTableStore.getState().open()).toBeNull();
    expect(invoke).toHaveBeenCalledTimes(1);

    aReply.resolve(opened("game-a"));
    expect((await aOpen)?.gameId).toBe("game-a");
    expect(useAiTableStore.getState().opening).toBe(false);
  });
});
