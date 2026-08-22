/**
 * A server-authoritative table, as client state.
 *
 * The rule this file exists to enforce: **the server's snapshot is the truth,
 * and this store never invents a newer one.** No optimistic card, no locally
 * predicted phase, no guessed stack. A command is sent, and whatever comes back
 * replaces what was here. That costs a round trip of latency and buys the one
 * thing that matters at a shared table — five clients that agree.
 *
 * `expectedVersion` is carried on every command. If the server has moved on,
 * it answers `stale` with the authoritative snapshot rather than applying, and
 * this store adopts it. That is how a client that missed an update recovers,
 * and it is why a dropped message is not a corrupted table.
 *
 * **A lost connection is a state, not a notice.** The specification is explicit
 * that the client must not locally assume the hand stopped, so the two failures
 * are kept apart here rather than collapsed into one string:
 *
 *   * a REFUSAL is the server's verdict. The command did not apply, the table
 *     is unchanged, and the player can act again immediately.
 *   * an UNREACHABLE is silence. The command may or may not have applied, the
 *     server's clock is still running, and its timeout defaults will be used if
 *     this seat's turn passes. Command controls are disabled for as long as
 *     that lasts — not because the hand is paused, but because a second tap
 *     into silence tells the player nothing and stages an intent whose outcome
 *     is already unknown. The poll keeps trying, and the first snapshot that
 *     arrives is the authority on what actually happened.
 */

import { create } from "zustand";

import type { PublicGameState } from "../../../shared/blackjack/index.js";
import type { PlayerActionType } from "../../../shared/blackjack/index.js";
import { getSupabase } from "../../lib/supabase/client.js";
import {
  createSupabaseTableGateway,
  createUnconfiguredTableGateway,
  type TableEvents,
  type TableFailure,
  type TableGateway,
} from "./online-table-gateway.js";

/**
 * One shared empty array, not a fresh `[]` per set.
 *
 * The feedback hook decides whether a batch is new by IDENTITY — a new array
 * means new events to hear. A fresh empty array on every poll would look like a
 * new batch three times a second.
 */
const EMPTY_EVENTS: TableEvents = [];

export type OnlineTableStatus =
  | { readonly kind: "idle" }
  | { readonly kind: "loading" }
  | { readonly kind: "at-table"; readonly state: PublicGameState; readonly seatId: string }
  | { readonly kind: "not-configured"; readonly message: string }
  | { readonly kind: "signed-out"; readonly message: string }
  | { readonly kind: "unavailable"; readonly message: string };

/**
 * Whether this client is currently in touch with the table.
 *
 * Orthogonal to `status`: a reconnecting client is still `at-table` and still
 * renders the last snapshot it holds, because blanking the felt would hide the
 * very information the player needs — their cards, their wager, whose turn it
 * was. What changes is that the controls stop accepting input and the screen
 * says what the server is doing meanwhile.
 */
export type TableConnection =
  | { readonly kind: "live" }
  | { readonly kind: "reconnecting"; readonly message: string };

/**
 * The reconnect copy, in one place because it is the specification's own rule
 * rather than incidental wording.
 *
 * It states the two things a player cannot see for themselves: that the hand is
 * still running, and exactly what will be played for them if their turn passes.
 * The defaults named here are the engine's — stand, and decline insurance — and
 * are the same ones `RESOLVE_TIMEOUT` applies.
 */
export const RECONNECTING_MESSAGE =
  "Reconnecting… The hand has not stopped. The server's clock is still running, " +
  "and if your turn passes it will stand for you and decline insurance.";

export interface OnlineTableStoreState {
  readonly status: OnlineTableStatus;
  /** Live, or trying to get back. See `TableConnection`. */
  readonly connection: TableConnection;
  /** True while a command is in flight, so controls disable rather than double-fire. */
  readonly pending: boolean;
  /** Chips staged locally before LOCK_BET. Not a wager until the server says so. */
  readonly stagedBet: number;
  readonly notice: string | null;
  /**
   * What the server said happened, most recently.
   *
   * Kept so sound and haptics describe the server's account of the hand rather
   * than a diff between two snapshots — a diff cannot tell the second card of a
   * deal from a redraw, and would announce a settled payout again on reconnect.
   */
  readonly lastEvents: TableEvents;

  enter: (gameId: string, seatId: string) => Promise<void>;
  refresh: () => Promise<void>;
  addChip: (amount: number) => void;
  clearBet: () => void;
  lockBet: () => Promise<void>;
  act: (action: PlayerActionType) => Promise<void>;
  /**
   * Ask the server to start the next round.
   *
   * At a shared table whoever taps first starts it for everyone; the losers get
   * the first committed result back rather than a second round. Nothing is
   * predicted locally — the round has not begun until the server says so.
   */
  nextHand: () => Promise<void>;
  leaveTable: () => void;
}

/**
 * The live subscription, held outside the store.
 *
 * It is a side effect with a lifetime, not a value to render, so keeping it in
 * state would mean every incoming broadcast re-rendered the screen twice — once
 * for the table and once for the handle to the thing that delivered it.
 */
let unsubscribe: (() => void) | null = null;

let gatewayOverride: TableGateway | null = null;

export function setTableGateway(next: TableGateway | null): void {
  gatewayOverride = next;
}

export function activeTableGateway(): TableGateway {
  if (gatewayOverride !== null) return gatewayOverride;

  const availability = getSupabase();
  if (availability.status !== "ready") {
    return createUnconfiguredTableGateway(availability.message);
  }
  return createSupabaseTableGateway(availability.client);
}

const LIVE: TableConnection = { kind: "live" };
const RECONNECTING: TableConnection = {
  kind: "reconnecting",
  message: RECONNECTING_MESSAGE,
};

/**
 * What a failed call means for the screen.
 *
 * The split is the whole point. A refusal is shown as a notice and leaves the
 * connection live, because the server is plainly there and answering. Silence
 * flips the connection instead and shows NO notice — the reconnect banner
 * already says more than "could not reach the table" would, and a notice would
 * also buzz the rejection haptic for something that was never rejected.
 */
function afterFailure(failure: TableFailure): {
  readonly connection: TableConnection;
  readonly notice: string | null;
} {
  return failure.reason === "unreachable"
    ? { connection: RECONNECTING, notice: null }
    : { connection: LIVE, notice: failure.message };
}

function statusForFailure(failure: TableFailure): OnlineTableStatus {
  switch (failure.reason) {
    case "not-configured":
      return { kind: "not-configured", message: failure.message };
    case "signed-out":
      return { kind: "signed-out", message: failure.message };
    default:
      return { kind: "unavailable", message: failure.message };
  }
}

export const useOnlineTableStore = create<OnlineTableStoreState>((set, get) => ({
  status: { kind: "idle" },
  pending: false,
  stagedBet: 0,
  notice: null,
  lastEvents: EMPTY_EVENTS,

  enter: async (gameId, seatId) => {
    set({ status: { kind: "loading" }, notice: null });
    const read = await activeTableGateway().snapshot(gameId);
    if (!read.ok) {
      set({ status: statusForFailure(read) });
      return;
    }
    set({
      status: { kind: "at-table", state: read.state, seatId },
      stagedBet: 0,
      notice: null,
      lastEvents: read.events,
    });

    /*
     * Subscribe AFTER the first snapshot, so the screen never renders a pushed
     * state before it has a baseline. Pushed and polled states are treated
     * identically — both are the server's, and neither is more authoritative
     * than the other.
     */
    unsubscribe?.();
    unsubscribe = activeTableGateway().subscribe(gameId, (pushed, events) => {
      const current = get().status;
      if (current.kind !== "at-table" || current.state.gameId !== pushed.gameId) return;
      // An out-of-order message is dropped rather than rewinding the table.
      if (pushed.version < current.state.version) return;
      set({
        status: { kind: "at-table", state: pushed, seatId: current.seatId },
        // A pushed batch describes somebody else's action as well as your own,
        // which is exactly what should be heard at a shared table.
        lastEvents: events,
      });
    });
  },

  refresh: async () => {
    const current = get().status;
    if (current.kind !== "at-table") return;

    const read = await activeTableGateway().snapshot(current.state.gameId);
    if (!read.ok) {
      // A failed poll is not a reason to tear the table down — the last known
      // snapshot stays on screen and the next poll tries again.
      set({ notice: read.message });
      return;
    }
    set({
      status: { kind: "at-table", state: read.state, seatId: current.seatId },
      notice: null,
      /*
       * A poll deliberately carries NO events, and must clear them.
       *
       * `snapshot` is a stale command: the server applies nothing and returns
       * the table, so there is nothing to hear. Leaving the previous batch in
       * place would replay the last hand's win sound on every three-second
       * poll — an animation restart re-announcing a settled payout, which is
       * the one thing the specification names outright.
       */
      lastEvents: EMPTY_EVENTS,
    });
  },

  addChip: (amount) => {
    const current = get().status;
    if (current.kind !== "at-table") return;

    const seat = current.state.seats.find((candidate) => candidate.seatId === current.seatId);
    const legal = current.state.legalActions[current.seatId];
    if (!seat || !legal?.betBounds) return;

    // Clamped against the seat's own stack and the table maximum. The server
    // checks both again; this only stops the UI staging an impossible bet.
    const next = Math.min(get().stagedBet + amount, legal.betBounds.max, seat.stack);
    set({ stagedBet: next, notice: null });
  },

  clearBet: () => set({ stagedBet: 0, notice: null }),

  lockBet: async () => {
    const current = get().status;
    if (current.kind !== "at-table" || get().pending) return;

    const staged = get().stagedBet;
    const legal = current.state.legalActions[current.seatId];
    if (!legal?.betBounds) return;
    if (staged < legal.betBounds.min) {
      set({ notice: `The minimum bet here is ${legal.betBounds.min}.` });
      return;
    }

    set({ pending: true, notice: null });
    // Two commands, in order: the bet must be recorded before it is locked.
    const placed = await activeTableGateway().command(current.state.gameId, {
      type: "PLACE_BET",
      expectedVersion: current.state.version,
      payload: { amount: staged },
    });
    if (!placed.ok) {
      set({ pending: false, notice: placed.message });
      return;
    }

    const locked = await activeTableGateway().command(current.state.gameId, {
      type: "LOCK_BET",
      expectedVersion: placed.state.version,
      payload: {},
    });
    set({
      pending: false,
      stagedBet: 0,
      status: {
        kind: "at-table",
        state: locked.ok ? locked.state : placed.state,
        seatId: current.seatId,
      },
      notice: locked.ok ? null : locked.message,
      lastEvents: locked.ok ? locked.events : placed.events,
    });
  },

  act: async (action) => {
    const current = get().status;
    if (current.kind !== "at-table" || get().pending) return;

    set({ pending: true, notice: null });
    const result = await activeTableGateway().command(current.state.gameId, {
      type: action,
      expectedVersion: current.state.version,
      payload: {},
    });

    if (!result.ok) {
      set({ pending: false, notice: result.message });
      return;
    }
    set({
      pending: false,
      status: { kind: "at-table", state: result.state, seatId: current.seatId },
      lastEvents: result.events,
    });
  },

  nextHand: async () => {
    const current = get().status;
    if (current.kind !== "at-table" || get().pending) return;

    set({ pending: true, notice: null });
    const result = await activeTableGateway().command(current.state.gameId, {
      type: "NEXT_HAND",
      expectedVersion: current.state.version,
      payload: {},
    });

    if (!result.ok) {
      set({ pending: false, notice: result.message });
      return;
    }
    set({
      pending: false,
      stagedBet: 0,
      status: { kind: "at-table", state: result.state, seatId: current.seatId },
      lastEvents: result.events,
    });
  },

  leaveTable: () => {
    unsubscribe?.();
    unsubscribe = null;
    set({
      status: { kind: "idle" },
      stagedBet: 0,
      notice: null,
      pending: false,
      lastEvents: EMPTY_EVENTS,
    });
  },
}));

/** The seat this player occupies, or null while the table is not loaded. */
export function ownSeat(status: OnlineTableStatus) {
  if (status.kind !== "at-table") return null;
  return status.state.seats.find((seat) => seat.seatId === status.seatId) ?? null;
}

/** True when the server says it is this seat's turn to act. */
export function isMyTurn(status: OnlineTableStatus): boolean {
  if (status.kind !== "at-table") return false;
  return status.state.activeSeatId === status.seatId;
}
