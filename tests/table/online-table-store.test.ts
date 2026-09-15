/**
 * The online table store.
 *
 * The property under test throughout: **this store never invents state.** It
 * shows what the server last said and nothing else. A store that optimistically
 * advanced a phase, predicted a card or adjusted a stack would look fine alone
 * and disagree with four other clients at the same table.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  isMyTurn,
  ownSeat,
  setTableGateway,
  useOnlineTableStore,
  type TableCommand,
  type TableEvents,
  type TableGateway,
  type TableSnapshotOutcome,
} from "../../src/features/table/index.js";
import { TIMEOUT_RETRY_MS } from "../../src/features/table/table-deadline.js";
import type { PublicGameState } from "../../shared/blackjack/index.js";
import { setWalletGateway, useWalletStore } from "../../src/features/wallet/wallet-store.js";

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
  /**
   * The live handler the store installed, so a test can push a broadcast at it.
   *
   * The realtime path had NO unit coverage at all before this: `subscribe` was a
   * no-op returning a no-op, under a comment saying the live channel is
   * exercised against the real server. It is — but the sequence RULES are
   * client logic, and the one that was wrong (a duplicate re-firing the event
   * batch, so every action played its cards and its outcome twice) is invisible
   * from the server side.
   */
  push: ((state: PublicGameState, events: TableEvents) => void) | null;
  /** How many times the store unsubscribed, for the cleanup assertion. */
  unsubscribes: number;
  /** Game ids the store read a snapshot for — the gap recovery asserts on this. */
  snapshots: string[];
  /** Game ids this gateway was asked to reset a private stack for. */
  resets: string[];
}

function gateway(
  responses: TableSnapshotOutcome[],
  recorded: Recorded = {
    commands: [],
    cashOuts: [],
    push: null,
    unsubscribes: 0,
    snapshots: [],
    resets: [],
  },
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
    snapshot: async (gameId) => {
      recorded.snapshots.push(gameId);
      return next();
    },
    cashOut: async (gameId) => {
      recorded.cashOuts.push(gameId);
      return { ok: true, walletBalance: 1_000 };
    },
    resetPrivateStack: async (gameId) => {
      recorded.resets.push(gameId);
      const outcome = next();
      return outcome.ok ? { ok: true, state: outcome.state } : outcome;
    },
    command: async (_gameId, command) => {
      recorded.commands.push(command);
      return next();
    },
    subscribe: (_gameId, onState) => {
      recorded.push = onState;
      return () => {
        recorded.push = null;
        recorded.unsubscribes += 1;
      };
    },
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
    lastAppliedSeq: 0,
    timeoutAskedForVersion: null,
  });
});

afterEach(() => {
  setWalletGateway(null);
  useWalletStore.getState().clear();
});

/**
 * One published event, in the ordering envelope the server actually sends.
 *
 * The type is deliberately the contract's rather than a local shape: the
 * envelope is what carries `seq`, and building a bare `EngineEvent` here would
 * test a payload the wire cannot produce.
 */
function published(seq: number, stateVersion: number): TableEvents[number] {
  return {
    seq,
    stateVersion,
    handNumber: 1,
    event: {
      type: "HAND_SETTLED",
      seatId: SEAT,
      handId: "hand-1",
      outcome: { kind: "WIN", credit: 200, net: 100 },
    },
  };
}

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

  /**
   * The commands that did not exist. `act()` takes a `PlayerActionType` —
   * HIT/STAND/DOUBLE/SPLIT/SURRENDER — so there was no spelling of either
   * insurance command anywhere in the client, at any server table.
   */
  it("sends INSURANCE and DECLINE_INSURANCE at the version the server reported", async () => {
    const offered = tableState({ version: 9, phase: "INSURANCE_OFFER" });
    const spy = gateway([
      { ok: true, state: offered, events: [] },
      { ok: true, state: tableState({ version: 10, phase: "PLAYER_TURNS" }), events: [] },
    ]);
    setTableGateway(spy);

    await useOnlineTableStore.getState().enter("game-1", SEAT);
    await useOnlineTableStore.getState().declineInsurance();

    expect(spy.recorded.commands.map((command) => command.type)).toEqual(["DECLINE_INSURANCE"]);
    expect(spy.recorded.commands[0]?.expectedVersion).toBe(9);
    // Nothing is predicted locally: the snapshot in the reply is the whole of
    // the new state.
    const status = useOnlineTableStore.getState().status;
    expect(status.kind === "at-table" && status.state.phase).toBe("PLAYER_TURNS");
  });

  it("sends INSURANCE when the offer is taken", async () => {
    const offered = tableState({ version: 9, phase: "INSURANCE_OFFER" });
    const spy = gateway([
      { ok: true, state: offered, events: [] },
      { ok: true, state: tableState({ version: 10, phase: "PLAYER_TURNS" }), events: [] },
    ]);
    setTableGateway(spy);

    await useOnlineTableStore.getState().enter("game-1", SEAT);
    await useOnlineTableStore.getState().takeInsurance();

    expect(spy.recorded.commands.map((command) => command.type)).toEqual(["INSURANCE"]);
    expect(spy.recorded.commands[0]?.expectedVersion).toBe(9);
  });

  /** A refusal leaves the table where the server has it, insurance included. */
  it("keeps the last known table when an insurance command is refused", async () => {
    const offered = tableState({ version: 9, phase: "INSURANCE_OFFER" });
    const spy = gateway([
      { ok: true, state: offered, events: [] },
      { ok: false, reason: "refused", message: "That move was not accepted." },
    ]);
    setTableGateway(spy);

    await useOnlineTableStore.getState().enter("game-1", SEAT);
    await useOnlineTableStore.getState().takeInsurance();

    const status = useOnlineTableStore.getState().status;
    expect(status.kind === "at-table" && status.state.phase).toBe("INSURANCE_OFFER");
    expect(useOnlineTableStore.getState().notice).toBe("That move was not accepted.");
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
      recorded: {
        commands: [],
        cashOuts: [],
        push: null,
        unsubscribes: 0,
        snapshots: [],
        resets: [],
      },
      subscribe: () => () => undefined,
      cashOut: async (gameId) => {
        spy.recorded.cashOuts.push(gameId);
        return { ok: true, walletBalance: 1_000 };
      },
      resetPrivateStack: async (gameId) => {
        spy.recorded.resets.push(gameId);
        return { ok: true, state: tableState() };
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
      resetPrivateStack: async () => ({ ok: true, state: tableState() }),
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

  /*
   * THE GAP THESE FOUR CLOSE. A refusal was the end of the story: the notice
   * promised "your chips come back as soon as it settles" and nothing made that
   * happen, so a player who tapped leave mid-hand and stopped watching stayed
   * seated at a live public table, stood in by the action timer hand after
   * hand, with their buy-in in escrow. The refusal was correct — the wager is
   * committed — but "not yet" was being rendered as "no".
   */
  it("holds a leave the server refused mid-hand", async () => {
    const spy = gateway([{ ok: true, state: tableState({ phase: "PLAYER_TURNS" }), events: [] }]);
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
    await useOnlineTableStore.getState().leaveTable();

    expect(useOnlineTableStore.getState().leavingWhenSafe).toBe(true);
  });

  /** Any OTHER refusal is a no, and holding it would retry it every three seconds. */
  it("does not hold a refusal that is not about the hand", async () => {
    const spy = gateway([{ ok: true, state: tableState(), events: [] }]);
    setTableGateway({
      ...spy,
      cashOut: async () => ({
        ok: false,
        reason: "refused",
        message: "Rate limited.",
        code: "RATE_LIMITED",
      }),
    });

    await useOnlineTableStore.getState().enter("game-1", SEAT);
    await useOnlineTableStore.getState().leaveTable();

    expect(useOnlineTableStore.getState().leavingWhenSafe).toBe(false);
  });

  it("completes the held leave at the first safe boundary", async () => {
    const refused = {
      ok: false as const,
      reason: "refused" as const,
      message: "This hand is still live.",
      code: "SESSION_BUSY",
    };
    let busy = true;
    const spy = gateway([
      // enter(), then the poll that finds the hand settled.
      { ok: true, state: tableState({ phase: "PLAYER_TURNS" }), events: [] },
      { ok: true, state: tableState({ phase: "HAND_COMPLETE", version: 5 }), events: [] },
    ]);
    setTableGateway({
      ...spy,
      cashOut: async (gameId) => {
        if (busy) return refused;
        spy.recorded.cashOuts.push(gameId);
        return { ok: true, walletBalance: 1_000 };
      },
    });

    await useOnlineTableStore.getState().enter("game-1", SEAT);
    await useOnlineTableStore.getState().leaveTable();
    expect(useOnlineTableStore.getState().leavingWhenSafe).toBe(true);
    expect(spy.recorded.cashOuts).toEqual([]);

    // The hand settles. The poll is the only thing still running for a player
    // who is watching out a hand they are no longer part of.
    busy = false;
    await useOnlineTableStore.getState().refresh();
    // `leaveTable` is fired without being awaited, exactly as the poll fires it.
    await Promise.resolve();
    await Promise.resolve();

    expect(spy.recorded.cashOuts).toEqual(["game-1"]);
    expect(useOnlineTableStore.getState().status.kind).toBe("idle");
  });

  /*
   * Staking chips is how somebody says they have changed their mind. Without
   * this, a player who asked to leave, was told to wait, and then decided to
   * play the next hand would be cashed out from under their own staged wager
   * the moment betting opened.
   */
  it("abandons the held leave when the player stakes a bet", async () => {
    const spy = gateway([{ ok: true, state: tableState({ phase: "PLAYER_TURNS" }), events: [] }]);
    setTableGateway({
      ...spy,
      cashOut: async () => ({
        ok: false,
        reason: "refused",
        message: "This hand is still live.",
        code: "SESSION_BUSY",
      }),
    });

    await useOnlineTableStore.getState().enter("game-1", SEAT);
    await useOnlineTableStore.getState().leaveTable();
    expect(useOnlineTableStore.getState().leavingWhenSafe).toBe(true);

    useOnlineTableStore.setState({
      status: { kind: "at-table", state: tableState(), seatId: SEAT },
    });
    useOnlineTableStore.getState().addChip(100);

    expect(useOnlineTableStore.getState().stagedBet).toBe(100);
    expect(useOnlineTableStore.getState().leavingWhenSafe).toBe(false);
  });

  it("does not call the server when there is no seat to close", async () => {
    const spy = gateway([{ ok: true, state: tableState(), events: [] }]);
    setTableGateway(spy);

    const left = await useOnlineTableStore.getState().leaveTable();

    expect(left).toBe(true);
    expect(spy.recorded.cashOuts).toEqual([]);
  });
});

// ---------------------------------------------------------------------------

/**
 * The Realtime sequence rules.
 *
 * ARCHITECTURE.md, `publicGameEventSchema` and `_shared/realtime-broadcast.ts`
 * all three describe a client that "tracks lastAppliedSeq and refetches on a
 * gap". None existed. The gateway unwrapped every event out of its ordering
 * envelope on the way in — under a comment saying the sequence numbers were the
 * store's concern — so the store had only `version` to compare, and deduped
 * with `pushed.version < current.version`.
 *
 * That misses the case that actually happens on every single action. The server
 * broadcasts AFTER committing, to every subscriber including the client that
 * sent the command — which has already applied the identical events from its own
 * reply, at the identical version. `<` is false for equal versions, so the batch
 * was applied a second time; `lastEvents` is a fresh array, `useTableFeedback`
 * decides "already felt" by array identity, and every deal played its cards
 * twice and every settled hand fired its outcome haptic and sting twice.
 */
describe("a pushed snapshot", () => {
  async function seated() {
    const spy = gateway([{ ok: true, state: tableState(), events: [] }]);
    setTableGateway(spy);
    await useOnlineTableStore.getState().enter("game-1", SEAT);
    return spy;
  }

  it("applies the next batch in sequence, with its events", async () => {
    const spy = await seated();
    spy.recorded.push?.(tableState({ version: 5 }), [published(1, 5)]);

    const state = useOnlineTableStore.getState();
    expect(state.status.kind === "at-table" && state.status.state.version).toBe(5);
    expect(state.lastEvents).toHaveLength(1);
    expect(state.lastAppliedSeq).toBe(1);
  });

  it("IGNORES a duplicate — the same batch delivered twice", async () => {
    const spy = await seated();
    const batch = [published(1, 5)];
    spy.recorded.push?.(tableState({ version: 5 }), batch);
    const felt = useOnlineTableStore.getState().lastEvents;

    spy.recorded.push?.(tableState({ version: 5 }), [published(1, 5)]);

    // The SAME array, by identity. That is the whole assertion: feedback keys on
    // identity, so a new array — even one holding the same events — replays the
    // settlement's haptic and its sound.
    expect(useOnlineTableStore.getState().lastEvents).toBe(felt);
  });

  it("ignores the broadcast of the client's OWN command", async () => {
    const spy = gateway([
      { ok: true, state: tableState(), events: [] },
      { ok: true, state: tableState({ version: 5 }), events: [published(1, 5)] },
    ]);
    setTableGateway(spy);
    await useOnlineTableStore.getState().enter("game-1", SEAT);
    await useOnlineTableStore.getState().act("STAND");

    const felt = useOnlineTableStore.getState().lastEvents;
    expect(felt).toHaveLength(1);

    // The fan-out of the command that was just applied. Same seq, same version.
    spy.recorded.push?.(tableState({ version: 5 }), [published(1, 5)]);
    expect(useOnlineTableStore.getState().lastEvents).toBe(felt);
  });

  it("does not replay feedback when the broadcast beats the command reply", async () => {
    const spy = await seated();
    let reply: (value: TableSnapshotOutcome) => void = () => undefined;
    spy.command = () => new Promise((resolve) => { reply = resolve; });
    const action = useOnlineTableStore.getState().act("STAND");
    spy.recorded.push?.(tableState({ version: 5 }), [published(1, 5)]);
    const felt = useOnlineTableStore.getState().lastEvents;
    reply({ ok: true, state: tableState({ version: 5 }), events: [published(1, 5)] });
    await action;
    expect(useOnlineTableStore.getState().lastEvents).toBe(felt);
    expect(useOnlineTableStore.getState().pending).toBe(false);
  });

  it("does not rewind a newer broadcast when an earlier command reply arrives", async () => {
    const spy = await seated();
    let reply: (value: TableSnapshotOutcome) => void = () => undefined;
    spy.command = () => new Promise((resolve) => { reply = resolve; });
    const action = useOnlineTableStore.getState().act("STAND");
    spy.recorded.push?.(tableState({ version: 6 }), [published(2, 6)]);
    const latest = useOnlineTableStore.getState();
    reply({ ok: true, state: tableState({ version: 5 }), events: [published(1, 5)] });
    await action;
    expect(useOnlineTableStore.getState().status).toEqual(latest.status);
    expect(useOnlineTableStore.getState().lastEvents).toBe(latest.lastEvents);
    expect(useOnlineTableStore.getState().lastAppliedSeq).toBe(2);
  });

  it("ignores an unseen but older broadcast after a newer poll", async () => {
    const spy = await seated();
    spy.snapshot = async () => ({ ok: true, state: tableState({ version: 8 }), events: [] });
    await useOnlineTableStore.getState().refresh();
    spy.recorded.push?.(tableState({ version: 5 }), [published(1, 5)]);
    const current = useOnlineTableStore.getState();
    expect(current.status.kind === "at-table" && current.status.state.version).toBe(8);
    expect(current.lastEvents).toHaveLength(0);
  });

  it("ignores a late closed-seat refusal from a previous entry to the same table", async () => {
    const spy = await seated();
    let reply: (value: TableSnapshotOutcome) => void = () => undefined;
    spy.snapshot = () => new Promise((resolve) => { reply = resolve; });
    const poll = useOnlineTableStore.getState().refresh();
    spy.snapshot = async () => ({ ok: true, state: tableState({ version: 8 }), events: [] });
    await useOnlineTableStore.getState().enter("game-1", SEAT);
    reply({ ok: false, reason: "refused", code: "SESSION_CLOSED", message: "Old request" });
    await poll;
    const current = useOnlineTableStore.getState();
    expect(current.status.kind === "at-table" && current.status.state.version).toBe(8);
    expect(current.notice).toBeNull();
    expect(spy.recorded.push).not.toBeNull();
  });

  it("adopts the state but plays nothing on a GAP, and fetches a snapshot", async () => {
    const spy = await seated();
    spy.recorded.push?.(tableState({ version: 5 }), [published(1, 5)]);
    const before = spy.recorded.snapshots.length;

    // seq 4 with seq 2 and 3 never delivered: the table is still correct — the
    // payload is a full public state, not a delta — but the story has a hole,
    // so nothing is announced and the authoritative snapshot is asked for.
    spy.recorded.push?.(tableState({ version: 8 }), [published(4, 8)]);

    const state = useOnlineTableStore.getState();
    expect(state.status.kind === "at-table" && state.status.state.version).toBe(8);
    expect(state.lastEvents).toHaveLength(0);
    expect(state.lastAppliedSeq).toBe(4);
    // The fetch is fired without awaiting, so let the microtask queue drain.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(spy.recorded.snapshots.length).toBeGreaterThan(before);
  });

  it("drops a message for a different game entirely", async () => {
    const spy = await seated();
    spy.recorded.push?.(tableState({ gameId: "game-2", version: 99 }), [published(1, 99)]);

    const state = useOnlineTableStore.getState();
    expect(state.status.kind === "at-table" && state.status.state.version).toBe(4);
  });

  it("falls back to the version for a batch with no events at all", async () => {
    // `closeCompetition` broadcasts an empty batch. There is no sequence to
    // compare, so the version is the only ordering it has.
    const spy = await seated();
    spy.recorded.push?.(tableState({ version: 4, phase: "SESSION_COMPLETE" }), []);
    expect(
      useOnlineTableStore.getState().status.kind === "at-table" &&
        (useOnlineTableStore.getState().status as { state: PublicGameState }).state.phase,
    ).toBe("BETTING_OPEN");

    spy.recorded.push?.(tableState({ version: 6, phase: "SESSION_COMPLETE" }), []);
    expect(
      (useOnlineTableStore.getState().status as { state: PublicGameState }).state.phase,
    ).toBe("SESSION_COMPLETE");
  });

  it("stops listening when the table is dropped", async () => {
    const spy = await seated();
    useOnlineTableStore.getState().forgetTable();
    expect(spy.recorded.unsubscribes).toBe(1);
    expect(spy.recorded.push).toBeNull();
  });
});

// ---------------------------------------------------------------------------

/**
 * Resolving an expired deadline.
 *
 * THE CONTROL, not the function behind it. `RESOLVE_TIMEOUT` has worked on the
 * server since phase 14 and the server suite has always sent it directly — but
 * the app's only call site was `TableGateway.snapshot()`, pinned to
 * `expectedVersion: 0` so that it can never apply. Measured against the running
 * stack: sixteen seconds past a private table's betting deadline, the client's
 * own three-second poll answered `stale` with the phase unchanged, while the
 * same command at the current version advanced it in one round trip. So an
 * absent player froze a shared table for everybody, indefinitely.
 */
describe("resolving an expired deadline", () => {
  const EXPIRED = new Date(Date.now() - 30_000).toISOString();
  const LATER = new Date(Date.now() + 30_000).toISOString();

  it("sends RESOLVE_TIMEOUT at the CURRENT version, not at zero", async () => {
    const spy = gateway([
      { ok: true, state: tableState({ deadlineAt: EXPIRED }), events: [] },
      { ok: true, state: tableState({ version: 5, deadlineAt: LATER }), events: [] },
    ]);
    setTableGateway(spy);
    await useOnlineTableStore.getState().enter("game-1", SEAT);

    await useOnlineTableStore.getState().resolveTimeout();

    expect(spy.recorded.commands).toEqual([
      { type: "RESOLVE_TIMEOUT", expectedVersion: 4, payload: {} },
    ]);
    const status = useOnlineTableStore.getState().status;
    expect(status.kind === "at-table" && status.state.version).toBe(5);
  });

  it("sends nothing at a table with no clock", async () => {
    // Solo, career and practice carry no deadline on purpose: nobody else is
    // waiting, and there is nothing to rush.
    const spy = gateway([{ ok: true, state: tableState({ deadlineAt: null }), events: [] }]);
    setTableGateway(spy);
    await useOnlineTableStore.getState().enter("game-1", SEAT);

    await useOnlineTableStore.getState().resolveTimeout();
    expect(spy.recorded.commands).toEqual([]);
  });

  it("sends nothing while the deadline is still running", async () => {
    const spy = gateway([{ ok: true, state: tableState({ deadlineAt: LATER }), events: [] }]);
    setTableGateway(spy);
    await useOnlineTableStore.getState().enter("game-1", SEAT);

    await useOnlineTableStore.getState().resolveTimeout();
    expect(spy.recorded.commands).toEqual([]);
  });

  it("asks once per version however often the countdown ticks", async () => {
    const spy = gateway([
      { ok: true, state: tableState({ deadlineAt: EXPIRED }), events: [] },
      // The server refuses: another client got there first and the version moved
      // under this one. The store must not keep hammering.
      { ok: false, reason: "refused", message: "The table has moved on.", code: "STALE_VERSION" },
    ]);
    setTableGateway(spy);
    await useOnlineTableStore.getState().enter("game-1", SEAT);

    await useOnlineTableStore.getState().resolveTimeout();
    await useOnlineTableStore.getState().resolveTimeout();
    await useOnlineTableStore.getState().resolveTimeout();

    expect(spy.recorded.commands).toHaveLength(1);
  });

  it("asks AGAIN after an ask that went unanswered", async () => {
    /*
     * THE DEADLOCK, seen on the two-simulator run. The version marker alone
     * blocks outright, and an ask that goes into silence leaves the version
     * exactly where it was — so the client never asks again and the table
     * freezes with its deadline permanently expired, which is the failure this
     * whole mechanism exists to prevent.
     *
     * The clock is moved rather than waited on: two seconds of real time in a
     * unit test is two seconds nobody gets back.
     */
    const spy = gateway([
      { ok: true, state: tableState({ deadlineAt: EXPIRED }), events: [] },
      { ok: false, reason: "unreachable", message: "no answer" },
      { ok: true, state: tableState({ version: 5, deadlineAt: LATER }), events: [] },
    ]);
    setTableGateway(spy);
    await useOnlineTableStore.getState().enter("game-1", SEAT);

    await useOnlineTableStore.getState().resolveTimeout();
    expect(spy.recorded.commands).toHaveLength(1);
    expect(useOnlineTableStore.getState().connection.kind).toBe("reconnecting");

    // The poll lands, so the client is live again, and the retry window passes.
    useOnlineTableStore.setState({
      connection: { kind: "live" },
      timeoutAskedAt: Date.now() - (TIMEOUT_RETRY_MS + 500),
    });
    await useOnlineTableStore.getState().resolveTimeout();

    expect(spy.recorded.commands).toHaveLength(2);
    expect(spy.recorded.commands[1]?.type).toBe("RESOLVE_TIMEOUT");
  });

  it("says nothing to the player when the server's clock disagrees", async () => {
    const spy = gateway([
      { ok: true, state: tableState({ deadlineAt: EXPIRED }), events: [] },
      {
        ok: false,
        reason: "refused",
        message: "The timer has not expired yet.",
        code: "DEADLINE_NOT_REACHED",
      },
    ]);
    setTableGateway(spy);
    await useOnlineTableStore.getState().enter("game-1", SEAT);

    await useOnlineTableStore.getState().resolveTimeout();

    // Nobody asked for this. A notice would also buzz the rejection haptic for a
    // request the player never made.
    expect(useOnlineTableStore.getState().notice).toBeNull();
    expect(useOnlineTableStore.getState().connection.kind).toBe("live");
  });

  it("shows reconnecting, not a notice, when the ask goes into silence", async () => {
    const spy = gateway([
      { ok: true, state: tableState({ deadlineAt: EXPIRED }), events: [] },
      { ok: false, reason: "unreachable", message: "no answer" },
    ]);
    setTableGateway(spy);
    await useOnlineTableStore.getState().enter("game-1", SEAT);

    await useOnlineTableStore.getState().resolveTimeout();

    expect(useOnlineTableStore.getState().connection.kind).toBe("reconnecting");
    expect(useOnlineTableStore.getState().notice).toBeNull();
  });
});

// ---------------------------------------------------------------------------

/**
 * A SEAT THAT IS GONE ENDS THE SCREEN, rather than becoming a notice beside it.
 *
 * PHOTOGRAPHED ON A TWO-SIMULATOR RUN. A cash-out committed on the server and
 * its reply was lost — the ordinary `unreachable` case, provoked there by a
 * saturated local edge runtime. Every command afterwards was correctly refused
 * `SESSION_CLOSED`, and this store rendered that as an ordinary notice: the
 * screen sat on a DEAD TABLE showing another player's cards, a live countdown
 * for a hand this player was not in, "Waiting for the next hand.", the seat's
 * own stack reading 0, and "This table has closed. (ref bf302626-…)" in the
 * corner. The player's chips were already back in their wallet.
 *
 * `rooms-store` has always drawn this line for a lobby — "drop to the entry
 * screen rather than leaving a lobby on screen that is not yours any more". The
 * table is the same rule one layer up.
 */
describe("a seat that is no longer at the table", () => {
  const closed = {
    ok: false as const,
    reason: "refused" as const,
    message: "This table has closed. (ref abc)",
    code: "SESSION_CLOSED",
  };

  it("reloads the credited wallet when settlement has already released the seat", async () => {
    let balance = 25_250;
    setWalletGateway({
      kind: "fake",
      fetch: async () => ({
        ok: true,
        wallet: { balance, lifetimeCredited: balance, lifetimeDebited: 0, version: 1, updatedAt: new Date().toISOString() },
        entries: [], dropped: 0, lastGrantAt: null,
      }),
      claimRecoveryGrant: async () => ({ ok: false, reason: "refused", message: "unused" }),
    });
    await useWalletStore.getState().refresh();
    const table = gateway([{ ok: true, state: tableState(), events: [] }, closed]);
    setTableGateway(table);
    await useOnlineTableStore.getState().enter("game-1", SEAT);

    // A ranked completion credits its reward and releases the seat on the
    // server. The next poll sees closure before the player can ask to cash out.
    balance = 25_450;
    await useOnlineTableStore.getState().refresh();
    await useOnlineTableStore.getState().leaveTable();

    expect(table.recorded.cashOuts).toEqual([]);
    expect(useWalletStore.getState().status).toMatchObject({ kind: "ready", wallet: { balance: 25_450 } });
  });

  it("drops the table when a command says the seat is closed", async () => {
    const spy = gateway([{ ok: true, state: tableState(), events: [] }, closed]);
    setTableGateway(spy);
    await useOnlineTableStore.getState().enter("game-1", SEAT);

    await useOnlineTableStore.getState().act("STAND");

    const status = useOnlineTableStore.getState().status;
    expect(status.kind).toBe("unavailable");
    if (status.kind !== "unavailable") throw new Error("unreachable");
    // The server's developer-facing wording, with its request reference, is not
    // what a player needs to read.
    expect(status.message).not.toMatch(/ref /);
    expect(status.message).toMatch(/no longer at this table/i);
  });

  it("drops it from the POLL too, which is where it is usually discovered", async () => {
    const spy = gateway([{ ok: true, state: tableState(), events: [] }, closed]);
    setTableGateway(spy);
    await useOnlineTableStore.getState().enter("game-1", SEAT);

    await useOnlineTableStore.getState().refresh();

    expect(useOnlineTableStore.getState().status.kind).toBe("unavailable");
  });

  it("stops listening to a table it is no longer at", async () => {
    // Left subscribed, the channel would keep pushing a stranger's hands at a
    // screen that has moved on.
    const spy = gateway([{ ok: true, state: tableState(), events: [] }, closed]);
    setTableGateway(spy);
    await useOnlineTableStore.getState().enter("game-1", SEAT);

    await useOnlineTableStore.getState().refresh();

    expect(spy.recorded.unsubscribes).toBe(1);
    expect(spy.recorded.push).toBeNull();
  });

  it("keeps the table for an ORDINARY refusal, which is not the seat going away", async () => {
    const spy = gateway([
      { ok: true, state: tableState(), events: [] },
      { ok: false, reason: "refused", message: "It is not your turn.", code: "NOT_YOUR_TURN" },
    ]);
    setTableGateway(spy);
    await useOnlineTableStore.getState().enter("game-1", SEAT);

    await useOnlineTableStore.getState().act("STAND");

    expect(useOnlineTableStore.getState().status.kind).toBe("at-table");
    expect(useOnlineTableStore.getState().notice).toMatch(/not your turn/i);
  });
});

/**
 * The free reset at a private table.
 *
 * THE DEFECT: `RESET_PRIVATE_STACK` had no caller anywhere in the app. The
 * server has accepted it since private tables were built — three guards, its own
 * log status, a rejection-contract test — and no gateway method, no store action
 * and no control existed, so the specification's "permit a free reset to 5,000
 * between hands" was a rule nobody could invoke. A player who busted sat out
 * every remaining hand of the table.
 *
 * What is asserted here is the STORE half: that it asks the right boundary, and
 * that it adopts the server's answer rather than predicting one.
 * `broke-affordance.test.ts` covers whether anybody can reach it.
 */
describe("a free reset at a private table", () => {
  /** The seat as the engine leaves it once it cannot cover the minimum. */
  const brokeState = tableState({
    version: 9,
    seats: [
      {
        seatId: SEAT,
        userId: "user-1",
        displayName: "Me",
        stack: 10,
        originalBet: 0,
        insuranceBet: 0,
        hands: [],
        connected: true,
        sittingOut: true,
        betLocked: false,
      },
    ],
  } as Partial<PublicGameState>);

  const refilled = tableState({
    version: 10,
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
        // Reinstated by the server in the same write: a reset that refilled the
        // stack and left the seat sitting out would answer a successful reset
        // with the same "waiting" the player was already looking at.
        sittingOut: false,
        betLocked: false,
      },
    ],
  } as Partial<PublicGameState>);

  it("asks the SERVER, naming only the game", async () => {
    const spy = gateway([
      { ok: true, state: brokeState, events: [] },
      { ok: true, state: refilled, events: [] },
    ]);
    setTableGateway(spy);
    await useOnlineTableStore.getState().enter("game-1", SEAT);

    await useOnlineTableStore.getState().resetStack();

    // Nothing about an amount. The figure is the ruleset's, applied server-side.
    expect(spy.recorded.resets).toEqual(["game-1"]);
    // And not sent as a game command: the economic boundary is `create-session`.
    expect(spy.recorded.commands).toEqual([]);
  });

  it("adopts the snapshot that comes back rather than predicting a stack", async () => {
    const spy = gateway([
      { ok: true, state: brokeState, events: [] },
      { ok: true, state: refilled, events: [] },
    ]);
    setTableGateway(spy);
    await useOnlineTableStore.getState().enter("game-1", SEAT);
    expect(ownSeat(useOnlineTableStore.getState().status)?.stack).toBe(10);

    await useOnlineTableStore.getState().resetStack();

    const status = useOnlineTableStore.getState().status;
    expect(status.kind).toBe("at-table");
    if (status.kind !== "at-table") throw new Error("unreachable");
    expect(status.state.version).toBe(10);
    expect(ownSeat(status)?.stack).toBe(5_000);
    // The seat is playable again, which is the whole point of asking.
    expect(ownSeat(status)?.sittingOut).toBe(false);
  });

  it("clears a staged bet and the repeat, which were made against chips that are gone", async () => {
    const spy = gateway([
      { ok: true, state: brokeState, events: [] },
      { ok: true, state: refilled, events: [] },
    ]);
    setTableGateway(spy);
    await useOnlineTableStore.getState().enter("game-1", SEAT);
    useOnlineTableStore.setState({ stagedBet: 40, lastBet: 200 });

    await useOnlineTableStore.getState().resetStack();

    expect(useOnlineTableStore.getState().stagedBet).toBe(0);
    expect(useOnlineTableStore.getState().lastBet).toBe(0);
  });

  it("keeps the player at the table when the server refuses", async () => {
    const spy = gateway([
      { ok: true, state: brokeState, events: [] },
      {
        ok: false,
        reason: "refused",
        message: "a reset is only available when you cannot cover the minimum bet",
        code: "ILLEGAL_ACTION",
      },
    ]);
    setTableGateway(spy);
    await useOnlineTableStore.getState().enter("game-1", SEAT);

    await useOnlineTableStore.getState().resetStack();

    expect(useOnlineTableStore.getState().status.kind).toBe("at-table");
    expect(useOnlineTableStore.getState().notice).toMatch(/cannot cover the minimum/i);
    expect(useOnlineTableStore.getState().pending).toBe(false);
  });

  it("leaves the table when the seat itself has closed under it", async () => {
    const spy = gateway([
      { ok: true, state: brokeState, events: [] },
      {
        ok: false,
        reason: "refused",
        message: "This table has closed. (ref 1234)",
        code: "SESSION_CLOSED",
      },
    ]);
    setTableGateway(spy);
    await useOnlineTableStore.getState().enter("game-1", SEAT);

    await useOnlineTableStore.getState().resetStack();

    const status = useOnlineTableStore.getState().status;
    expect(status.kind).toBe("unavailable");
    if (status.kind !== "unavailable") throw new Error("unreachable");
    expect(status.message).toMatch(/no longer at this table/i);
  });

  it("does not send a second reset while one is in flight", async () => {
    const spy = gateway([
      { ok: true, state: brokeState, events: [] },
      { ok: true, state: refilled, events: [] },
      { ok: true, state: refilled, events: [] },
    ]);
    setTableGateway(spy);
    await useOnlineTableStore.getState().enter("game-1", SEAT);

    const first = useOnlineTableStore.getState().resetStack();
    await useOnlineTableStore.getState().resetStack();
    await first;

    expect(spy.recorded.resets).toEqual(["game-1"]);
  });
});
