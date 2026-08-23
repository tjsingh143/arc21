/**
 * The online table store.
 *
 * The property under test throughout: **this store never invents state.** It
 * shows what the server last said and nothing else. A store that optimistically
 * advanced a phase, predicted a card or adjusted a stack would look fine alone
 * and disagree with four other clients at the same table.
 */

import { beforeEach, describe, expect, it } from "vitest";

import {
  isMyTurn,
  ownSeat,
  setTableGateway,
  useOnlineTableStore,
  type TableCommand,
  type TableGateway,
  type TableSnapshotOutcome,
} from "../../src/features/table/index.js";
import type { PublicGameState } from "../../shared/blackjack/index.js";

const SEAT = "seat-mine";
const OTHER = "seat-theirs";

function tableState(overrides: Partial<PublicGameState> = {}): PublicGameState {
  return {
    gameId: "game-1",
    version: 4,
    phase: "BETTING_OPEN",
    rulesSummary: {
      deckCount: 6,
      dealerHitsSoft17: false,
      blackjackPayout: "3:2",
      surrenderAllowed: true,
      doubleAfterSplit: true,
    },
    handNumber: 1,
    seats: [
      {
        seatId: SEAT,
        userId: "user-1",
        displayName: "Me",
        stack: 5_000,
        originalBet: 0,
        insuranceBet: 0,
        hands: [],
        connected: true,
        sittingOut: false,
        betLocked: false,
      },
      {
        seatId: OTHER,
        userId: "user-2",
        displayName: "Them",
        stack: 5_000,
        originalBet: 0,
        insuranceBet: 0,
        hands: [],
        connected: true,
        sittingOut: false,
        betLocked: false,
      },
    ],
    dealer: { cards: [], displayedTotal: null, holeCardRevealed: false },
    activeSeatId: null,
    activeHandId: null,
    deadlineAt: null,
    shoe: { shuffleNumber: 1, approximateRemainingDecks: 6 },
    legalActions: {
      [SEAT]: {
        actions: [],
        chipCost: {},
        canPlaceBet: true,
        canLockBet: false,
        betBounds: { min: 20, max: 500, increment: 10 },
        canTakeInsurance: false,
        canDeclineInsurance: false,
        insuranceStake: null,
        insuranceIsEvenMoney: false,
      },
      [OTHER]: {
        actions: [],
        chipCost: {},
        canPlaceBet: true,
        canLockBet: false,
        betBounds: { min: 20, max: 500, increment: 10 },
        canTakeInsurance: false,
        canDeclineInsurance: false,
        insuranceStake: null,
        insuranceIsEvenMoney: false,
      },
    },
    ...overrides,
  } as PublicGameState;
}

interface Recorded {
  commands: TableCommand[];
  /** Game ids this gateway was asked to cash out. */
  cashOuts: string[];
}

function gateway(
  responses: TableSnapshotOutcome[],
  recorded: Recorded = { commands: [], cashOuts: [] },
): TableGateway & { recorded: Recorded } {
  let index = 0;
  const next = (): TableSnapshotOutcome =>
    responses[Math.min(index++, responses.length - 1)] ?? {
      ok: false,
      reason: "unreachable",
      message: "no response queued",
    };

  return {
    kind: "fake",
    recorded,
    snapshot: async () => next(),
    cashOut: async (gameId) => {
      recorded.cashOuts.push(gameId);
      return { ok: true, walletBalance: 1_000 };
    },
    command: async (_gameId, command) => {
      recorded.commands.push(command);
      return next();
    },
    // These tests drive the store directly; the live channel is exercised
    // against the real server, not faked here.
    subscribe: () => () => undefined,
  };
}

beforeEach(() => {
  setTableGateway(null);
  useOnlineTableStore.setState({
    status: { kind: "idle" },
    connection: { kind: "live" },
    pending: false,
    stagedBet: 0,
    notice: null,
  });
});

describe("entering a table", () => {
  it("adopts the server's snapshot", async () => {
    setTableGateway(gateway([{ ok: true, state: tableState(), events: [] }]));
    await useOnlineTableStore.getState().enter("game-1", SEAT);

    const status = useOnlineTableStore.getState().status;
    expect(status.kind).toBe("at-table");
    if (status.kind !== "at-table") throw new Error("unreachable");
    expect(status.state.version).toBe(4);
    expect(status.seatId).toBe(SEAT);
  });

  it("states a signed-out player rather than showing an empty table", async () => {
    setTableGateway(
      gateway([{ ok: false, reason: "signed-out", message: "Sign in to play at a table." }]),
    );
    await useOnlineTableStore.getState().enter("game-1", SEAT);

    expect(useOnlineTableStore.getState().status.kind).toBe("signed-out");
  });
});

describe("staging a bet", () => {
  beforeEach(async () => {
    setTableGateway(gateway([{ ok: true, state: tableState(), events: [] }]));
    await useOnlineTableStore.getState().enter("game-1", SEAT);
  });

  it("clamps to the table maximum", () => {
    const store = useOnlineTableStore.getState();
    store.addChip(500);
    store.addChip(500);
    expect(useOnlineTableStore.getState().stagedBet).toBe(500);
  });

  it("clamps to the seat's own stack", async () => {
    const poor = tableState();
    poor.seats[0]!.stack = 60;
    setTableGateway(gateway([{ ok: true, state: poor, events: [] }]));
    await useOnlineTableStore.getState().enter("game-1", SEAT);

    useOnlineTableStore.getState().addChip(100);
    expect(useOnlineTableStore.getState().stagedBet).toBe(60);
  });

  it("refuses to lock below the table minimum, without sending anything", async () => {
    const spy = gateway([{ ok: true, state: tableState(), events: [] }]);
    setTableGateway(spy);
    await useOnlineTableStore.getState().enter("game-1", SEAT);

    useOnlineTableStore.getState().addChip(10);
    await useOnlineTableStore.getState().lockBet();

    expect(spy.recorded.commands).toHaveLength(0);
    expect(useOnlineTableStore.getState().notice).toMatch(/minimum bet/i);
  });
});

describe("commands", () => {
  it("sends PLACE_BET then LOCK_BET, each at the version the server just reported", async () => {
    const afterBet = tableState({ version: 5 });
    const afterLock = tableState({ version: 6, phase: "PLAYER_TURNS" });
    const spy = gateway([
      { ok: true, state: tableState(), events: [] },
      { ok: true, state: afterBet, events: [] },
      { ok: true, state: afterLock, events: [] },
    ]);
    setTableGateway(spy);

    await useOnlineTableStore.getState().enter("game-1", SEAT);
    useOnlineTableStore.getState().addChip(100);
    await useOnlineTableStore.getState().lockBet();

    expect(spy.recorded.commands.map((command) => command.type)).toEqual([
      "PLACE_BET",
      "LOCK_BET",
    ]);
    // The lock must carry the version the BET returned, not the one it started
    // from — otherwise it is stale the moment it is sent.
    expect(spy.recorded.commands[0]?.expectedVersion).toBe(4);
    expect(spy.recorded.commands[1]?.expectedVersion).toBe(5);
    expect(useOnlineTableStore.getState().stagedBet).toBe(0);
  });

  it("keeps the last known table when a command is refused", async () => {
    const spy = gateway([
      { ok: true, state: tableState(), events: [] },
      { ok: false, reason: "refused", message: "That move was not accepted." },
    ]);
    setTableGateway(spy);

    await useOnlineTableStore.getState().enter("game-1", SEAT);
    await useOnlineTableStore.getState().act("HIT");

    const status = useOnlineTableStore.getState().status;
    expect(status.kind).toBe("at-table");
    if (status.kind !== "at-table") throw new Error("unreachable");
    // Nothing was invented: the version is exactly what the server last said.
    expect(status.state.version).toBe(4);
    expect(useOnlineTableStore.getState().notice).toMatch(/not accepted/i);
    expect(useOnlineTableStore.getState().pending).toBe(false);
  });

  it("ignores a second command while one is in flight", async () => {
    // Declared with an explicit type: assigning inside the executor narrows the
    // variable to `never` afterwards, so `release?.()` stops being callable.
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });

    const spy: TableGateway & { recorded: Recorded } = {
      kind: "fake",
      recorded: { commands: [], cashOuts: [] },
      subscribe: () => () => undefined,
      cashOut: async (gameId) => {
        spy.recorded.cashOuts.push(gameId);
        return { ok: true, walletBalance: 1_000 };
      },
      snapshot: async () => ({ ok: true, state: tableState(), events: [] }),
      command: async (_gameId, command) => {
        spy.recorded.commands.push(command);
        await held;
        return { ok: true, state: tableState({ version: 5 }), events: [] };
      },
    };
    setTableGateway(spy);

    await useOnlineTableStore.getState().enter("game-1", SEAT);
    const first = useOnlineTableStore.getState().act("HIT");
    await useOnlineTableStore.getState().act("STAND");

    // A double tap must not become two hits.
    expect(spy.recorded.commands).toHaveLength(1);
    release();
    await first;
  });
});

describe("a failed poll", () => {
  it("leaves the table on screen and shows reconnecting, not a notice", async () => {
    const spy = gateway([
      { ok: true, state: tableState(), events: [] },
      { ok: false, reason: "unreachable", message: "Could not reach the table." },
    ]);
    setTableGateway(spy);

    await useOnlineTableStore.getState().enter("game-1", SEAT);
    await useOnlineTableStore.getState().refresh();

    // The hand continues on the server; blanking the screen would be a lie
    // about that, and the next poll may well succeed.
    expect(useOnlineTableStore.getState().status.kind).toBe("at-table");
    // Silence is a connection STATE, not a notice — the specification requires
    // the two kept apart, because a refusal and a lost connection mean opposite
    // things for whether the player can act again immediately. The reconnect
    // banner (read from `connection`) already says more than a generic notice
    // would, so `notice` stays null rather than duplicating it.
    expect(useOnlineTableStore.getState().connection).toEqual({
      kind: "reconnecting",
      message: expect.stringMatching(/hand has not stopped/i),
    });
    expect(useOnlineTableStore.getState().notice).toBeNull();
  });

  it("does not retry inside the poll itself", async () => {
    const spy = gateway([
      { ok: true, state: tableState(), events: [] },
      { ok: false, reason: "unreachable", message: "Could not reach the table." },
    ]);
    setTableGateway(spy);

    await useOnlineTableStore.getState().enter("game-1", SEAT);
    await useOnlineTableStore.getState().refresh();

    // Exactly one snapshot call for `enter` and one for `refresh` — the poll is
    // already a retry loop on its own three-second cadence, so stacking the
    // gateway's backoff inside it would leave several polls in flight at once
    // against a server that is already struggling.
    expect(spy.recorded.commands).toHaveLength(0);
  });

  it("returns to live the moment a poll lands again", async () => {
    const spy = gateway([
      { ok: true, state: tableState(), events: [] },
      { ok: false, reason: "unreachable", message: "Could not reach the table." },
      { ok: true, state: tableState({ version: 5 }), events: [] },
    ]);
    setTableGateway(spy);

    await useOnlineTableStore.getState().enter("game-1", SEAT);
    await useOnlineTableStore.getState().refresh();
    expect(useOnlineTableStore.getState().connection.kind).toBe("reconnecting");

    await useOnlineTableStore.getState().refresh();

    // A successful poll is the only signal a reconnecting client gets that it
    // is back in touch — there is nothing else to observe silence ending on.
    expect(useOnlineTableStore.getState().connection).toEqual({ kind: "live" });
  });

  it("keeps the connection live for a refusal, which is the server plainly answering", async () => {
    const spy = gateway([
      { ok: true, state: tableState(), events: [] },
      { ok: false, reason: "refused", message: "That move was not accepted." },
    ]);
    setTableGateway(spy);

    await useOnlineTableStore.getState().enter("game-1", SEAT);
    await useOnlineTableStore.getState().refresh();

    expect(useOnlineTableStore.getState().connection).toEqual({ kind: "live" });
    expect(useOnlineTableStore.getState().notice).toMatch(/not accepted/i);
  });
});

describe("connection lost mid-command", () => {
  it("shows reconnecting from the first silent attempt, before backoff finishes", async () => {
    const spy = gateway([{ ok: true, state: tableState(), events: [] }]);
    setTableGateway(spy);
    await useOnlineTableStore.getState().enter("game-1", SEAT);

    let sawReconnecting = false;
    // A gateway whose every attempt is silent, so `retryWhile` exhausts its
    // policy and reports `unreachable` at the end — `act` awaits that whole
    // sequence, which is why `pending` alone already disables controls for its
    // entire duration.
    setTableGateway({
      kind: "fake",
      subscribe: () => () => undefined,
      cashOut: async () => ({ ok: true, walletBalance: 1_000 }),
      snapshot: async () => ({ ok: true, state: tableState(), events: [] }),
      command: async (_gameId, _command, options) => {
        options?.onRetry?.();
        sawReconnecting = useOnlineTableStore.getState().connection.kind === "reconnecting";
        return { ok: false, reason: "unreachable", message: "Could not reach the table." };
      },
    });

    await useOnlineTableStore.getState().act("STAND");

    expect(sawReconnecting).toBe(true);
    expect(useOnlineTableStore.getState().connection.kind).toBe("reconnecting");
    // A rejection is never invented: the last known table stays exactly as the
    // server last confirmed it, at the version it was already at.
    const status = useOnlineTableStore.getState().status;
    expect(status.kind).toBe("at-table");
    if (status.kind !== "at-table") throw new Error("unreachable");
    expect(status.state.version).toBe(4);
  });
});

describe("selectors", () => {
  it("finds the player's own seat and no one else's", async () => {
    setTableGateway(gateway([{ ok: true, state: tableState(), events: [] }]));
    await useOnlineTableStore.getState().enter("game-1", SEAT);

    const seat = ownSeat(useOnlineTableStore.getState().status);
    expect(seat?.seatId).toBe(SEAT);
    expect(seat?.displayName).toBe("Me");
  });

  it("reports whose turn it is from the server's field, not a guess", async () => {
    setTableGateway(gateway([{ ok: true, state: tableState({ activeSeatId: OTHER }), events: [] }]));
    await useOnlineTableStore.getState().enter("game-1", SEAT);
    expect(isMyTurn(useOnlineTableStore.getState().status)).toBe(false);

    setTableGateway(gateway([{ ok: true, state: tableState({ activeSeatId: SEAT }), events: [] }]));
    await useOnlineTableStore.getState().enter("game-1", SEAT);
    expect(isMyTurn(useOnlineTableStore.getState().status)).toBe(true);
  });
});

// ---------------------------------------------------------------------------

describe("leaving a table returns the stack", () => {
  /*
   * The defect this covers, found by playing a public table on the simulator:
   * "Leave table" was a plain back navigation. The seat stayed `active`, the
   * buy-in stayed in escrow, and the wallet stayed short — while the screen
   * that took the chips promised "whatever is left comes back when you leave".
   * `CASH_OUT` had been implemented and tested on the server since phase 5 with
   * ZERO client callers.
   *
   * Sitting at a second table then debited a second buy-in, because the
   * SESSION_ALREADY_ACTIVE guard lives in the solo `open()` path that no client
   * ever calls. Two visits cost 4,000 chips and returned none of it.
   */
  it("cashes out the seat before dropping the table", async () => {
    const spy = gateway([{ ok: true, state: tableState(), events: [] }]);
    setTableGateway(spy);

    await useOnlineTableStore.getState().enter("game-1", SEAT);
    const left = await useOnlineTableStore.getState().leaveTable();

    expect(left).toBe(true);
    expect(spy.recorded.cashOuts).toEqual(["game-1"]);
    expect(useOnlineTableStore.getState().status.kind).toBe("idle");
  });

  it("keeps the player at the table when the server refuses", async () => {
    const spy = gateway([{ ok: true, state: tableState(), events: [] }]);
    setTableGateway({
      ...spy,
      cashOut: async () => ({
        ok: false,
        reason: "refused",
        message: "This hand is still live. Your chips come back as soon as it settles.",
        code: "SESSION_BUSY",
      }),
    });

    await useOnlineTableStore.getState().enter("game-1", SEAT);
    const left = await useOnlineTableStore.getState().leaveTable();

    // Walking away from a refused cash-out is the bug, not the fallback.
    expect(left).toBe(false);
    expect(useOnlineTableStore.getState().status.kind).toBe("at-table");
    expect(useOnlineTableStore.getState().notice).toMatch(/still live/);
  });

  it("does not call the server when there is no seat to close", async () => {
    const spy = gateway([{ ok: true, state: tableState(), events: [] }]);
    setTableGateway(spy);

    const left = await useOnlineTableStore.getState().leaveTable();

    expect(left).toBe(true);
    expect(spy.recorded.cashOuts).toEqual([]);
  });
});
