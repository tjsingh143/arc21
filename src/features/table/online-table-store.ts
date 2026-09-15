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
  seqRangeOf,
  type TableEvents,
  type TableFailure,
  type TableGateway,
} from "./online-table-gateway.js";
import { shouldCompleteLeave } from "./leave-guard.js";
import { shouldRequestTimeoutResolution } from "./table-deadline.js";
import { useWalletStore } from "../wallet/wallet-store.js";

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
  /**
   * The last wager the SERVER accepted from this seat, for the Repeat control.
   *
   * THE DEFECT THIS CLOSES. `BettingBar` has always drawn a Repeat button and
   * `app/table/[gameId].tsx` passed it `lastBet={0}` with an `onRepeat` of
   * `() => undefined` — so at every server table the control rendered
   * permanently disabled. Practice passes both for real and works; the online
   * modes are exactly the ones where a player bets the same amount hand after
   * hand.
   *
   * Recorded only when `LOCK_BET` came back ok, which is the whole point: a
   * bet the server refused is not a bet to repeat.
   */
  readonly lastBet: number;
  readonly notice: string | null;
  /**
   * The highest event sequence this client has applied, or 0 before any.
   *
   * The specification's Realtime rule, which nothing implemented: ignore
   * `seq <= lastAppliedSeq`, apply `seq == lastAppliedSeq + 1`, and fetch an
   * authoritative snapshot on a gap. `version` alone cannot do it — a command's
   * own reply and the broadcast that follows it carry the SAME version, so
   * deduping on version let every action play its cards and its outcome twice.
   */
  readonly lastAppliedSeq: number;
  /**
   * The version this client last asked the server to time out, and when.
   *
   * The version alone would deadlock: an ask that goes unanswered leaves the
   * version where it was, so "already asked at 28" would block every later
   * attempt at 28 and freeze the table for this client with the deadline
   * permanently expired. Seen on a two-simulator run. The pair bounds the RATE
   * instead — see `TIMEOUT_RETRY_MS`.
   */
  readonly timeoutAskedForVersion: number | null;
  readonly timeoutAskedAt: number | null;
  /**
   * This player has asked to leave and the server said the hand was still live.
   *
   * A refused cash-out used to be the end of it: the notice said the chips came
   * back when the hand settled, and nothing made that happen. Somebody who taps
   * leave and puts the phone down stayed seated at a live public table, stood
   * in by the action timer hand after hand, with their buy-in in escrow. The
   * flag is the INTENT, held until `shouldCompleteLeave` says the table has
   * reached a phase the server will accept — and cleared the moment the player
   * stakes something, because betting is how somebody says they have changed
   * their mind.
   */
  readonly leavingWhenSafe: boolean;
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
  /**
   * Stage the previous accepted wager again.
   *
   * Staged, never sent: the specification is explicit that a previous bet may
   * be SUGGESTED next hand and must not be silently committed. It goes through
   * the same clamp `addChip` uses, so a stack that shrank since — or a table
   * whose maximum moved, which a tournament's boundary can do between hands —
   * cannot stage an impossible amount.
   */
  repeatBet: () => void;
  lockBet: () => Promise<void>;
  act: (action: PlayerActionType) => Promise<void>;
  /**
   * Answer the insurance offer.
   *
   * ADDED AFTER THIS WAS UNREACHABLE FOR A WHOLE PHASE. `INSURANCE` and
   * `DECLINE_INSURANCE` are engine commands, they are in
   * `COMMAND_TYPES`, the server applies them, and `tests/server` sends
   * `DECLINE_INSURANCE` on every hand of every daily-challenge attempt — but
   * `act()` takes a `PlayerActionType`, which is HIT/STAND/DOUBLE/SPLIT/
   * SURRENDER and nothing else, and no other method existed. So at EVERY
   * server table — Quick Play, public, private, tournament, daily — the
   * insurance offer could not be answered at all. The player saw "Waiting for
   * the next hand." until the deadline expired and the server applied its
   * default.
   *
   * Nothing caught it because the InsuranceSheet was mounted by
   * `app/game/practice.tsx` and `app/career/play/[slug].tsx`, both of which
   * drive the LOCAL engine, and neither goes anywhere near this store.
   */
  takeInsurance: () => Promise<void>;
  declineInsurance: () => Promise<void>;
  /**
   * Ask the server to start the next round.
   *
   * At a shared table whoever taps first starts it for everyone; the losers get
   * the first committed result back rather than a second round. Nothing is
   * predicted locally — the round has not begun until the server says so.
   */
  nextHand: () => Promise<void>;
  /**
   * Ask the server to apply its own timeout defaults to an expired deadline.
   *
   * ARC 21 HAS NO LONG-LIVED GAME PROCESS. A deadline is a stored
   * `deadline_at`, and the specification's mechanism for reaching it is that
   * "when a deadline is visually reached, any connected client may request
   * RESOLVE_TIMEOUT" — which the server honours only if its OWN clock has
   * passed it. Nothing in this app ever sent one: the single call site was
   * `TableGateway.snapshot()`, pinned to `expectedVersion: 0` so that it can
   * never apply, which makes it a read. So an absent player froze a shared
   * table for everybody, indefinitely, with the fifteen-second timer that
   * exists to prevent exactly that already long expired.
   *
   * Nothing is decided here. `DEADLINE_NOT_REACHED` is swallowed rather than
   * shown, because a device whose clock ran a little ahead has not done
   * anything a player needs telling about — and `stale` is the ordinary answer
   * when another client got there first, which is the specification's
   * "duplicates are harmless".
   */
  resolveTimeout: () => Promise<void>;
  /**
   * Close the seat, take the stack back, and drop the table.
   *
   * Returns false when the server refused — mid-hand, most often — so the
   * screen can keep the player at the table instead of walking them away from
   * chips that are still in escrow.
   *
   * This USED to be a synchronous state reset, and the screen's back button was
   * a plain `BackBar`. Between them, leaving a public table returned nothing:
   * the buy-in stayed in escrow, the seat stayed `active`, and the wallet was
   * short by the buy-in with no way in the app to get it back. The Public Table
   * screen promises "whatever is left comes back when you leave" — this is the
   * call that makes that sentence true.
   */
  leaveTable: () => Promise<boolean>;
  /** Abandons a leave the player asked for and has since thought better of. */
  stayAtTable: () => void;
  /**
   * Take a free reset back to the private table's fixed stack.
   *
   * THE OTHER HALF OF A MECHANISM THAT ONLY EVER HAD ONE. The server has
   * accepted `RESET_PRIVATE_STACK` since private tables were built and no
   * client had ever sent it, so the specification's *"if a private player
   * reaches zero session chips, permit a free reset to 5,000 between hands"*
   * was a rule with no way to invoke it: a player who busted sat out every
   * remaining hand of the table.
   *
   * Nothing is decided here. The amount, the mode check, the between-hands
   * check and the actually-broke check are all the server's; this sends the
   * game id and adopts the snapshot that comes back. See `mayResetPrivateStack`
   * for what an honest client offers it against.
   */
  resetStack: () => Promise<void>;
  /** Drops the table locally without cashing out. For a seat already closed. */
  forgetTable: () => void;
}

/**
 * The live subscription, held outside the store.
 *
 * It is a side effect with a lifetime, not a value to render, so keeping it in
 * state would mean every incoming broadcast re-rendered the screen twice — once
 * for the table and once for the handle to the thing that delivered it.
 */
let unsubscribe: (() => void) | null = null;
// Requests can outlive a cash-out, route change, or a second entry to the same
// game. A game id alone cannot distinguish those separate screen lifetimes.
let tableGeneration = 0;

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

/**
 * The two codes that mean THIS CLIENT NO LONGER HOLDS A SEAT HERE.
 *
 * `SESSION_CLOSED` for a seat that has been settled or a table that has ended;
 * `NOT_A_PARTICIPANT` for a game this account is not in. Either way there is
 * nothing at this table for this player any more.
 */
const CLOSED_CODES: ReadonlySet<string> = new Set(["SESSION_CLOSED", "NOT_A_PARTICIPANT"]);

/**
 * What a closed seat reads as.
 *
 * Deliberately says the chips are settled, because the case this is reached
 * from is a cash-out whose REPLY was lost: the seat closed, the stack came back,
 * and the client never heard. Telling the player only "this table has closed"
 * would leave them wondering where their chips went.
 */
export const SEAT_CLOSED_MESSAGE =
  "You are no longer at this table. Your seat is settled and anything it held has been returned.";

/**
 * Drops a table this client has no seat at, and reports whether it did.
 *
 * THE DEFECT, seen on a two-simulator run and photographed. A cash-out
 * committed on the server and its reply was lost — the ordinary `unreachable`
 * case, provoked here by a saturated local runtime. Every command afterwards
 * was correctly refused `SESSION_CLOSED`, and the store rendered that as an
 * ORDINARY NOTICE: the screen sat on a dead table showing other people's cards,
 * a live countdown for a hand this player was not in, "Waiting for the next
 * hand.", and, in the corner, "This table has closed. (ref bf302626-…)". The
 * seat's own stack read 0.
 *
 * A refusal that says the seat is gone is not a notice to show beside the felt;
 * it is the end of this screen's subject. `rooms-store` already draws exactly
 * this line for a lobby ("drop to the entry screen rather than leaving a lobby
 * on screen that is not yours any more") — this is the same rule one layer up.
 */
function dropIfSeatIsClosed(
  get: () => OnlineTableStoreState,
  set: (partial: Partial<OnlineTableStoreState>) => void,
  failure: TableFailure,
): boolean {
  if (failure.reason !== "refused" || failure.code === undefined) return false;
  if (!CLOSED_CODES.has(failure.code)) return false;

  // The channel belongs to a table this client is not at. Left subscribed it
  // would keep pushing a stranger's hands at a screen that has moved on.
  get().forgetTable();
  set({ status: { kind: "unavailable", message: SEAT_CLOSED_MESSAGE } });
  // Ranked completion and a lost cash-out reply can both close the seat before
  // leaveTable runs. Reconcile the reward/refund here too, or retained headers
  // keep showing the balance from before settlement.
  void useWalletStore.getState().refresh();
  return true;
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

/** HTTP replies and Realtime share one monotonically increasing server state. */
function snapshotUpdate(
  get: () => OnlineTableStoreState,
  state: PublicGameState,
  events?: TableEvents,
): Partial<OnlineTableStoreState> {
  const current = get().status;
  if (current.kind !== "at-table" || current.state.gameId !== state.gameId ||
      state.version < current.state.version) return {};
  const update: Partial<OnlineTableStoreState> = {
    status: { kind: "at-table", state, seatId: current.seatId },
  };
  if (events === undefined) return update;
  const seq = seqRangeOf(events);
  // A broadcast may beat the HTTP reply for the very same command. Keep the
  // event array's identity in that case, so feedback does not play twice.
  if (seq && seq.last <= get().lastAppliedSeq) return update;
  return {
    ...update,
    lastAppliedSeq: seq?.last ?? get().lastAppliedSeq,
    lastEvents: state.version === current.state.version && seq ? EMPTY_EVENTS : events,
  };
}

export const useOnlineTableStore = create<OnlineTableStoreState>((set, get) => ({
  status: { kind: "idle" },
  connection: LIVE,
  pending: false,
  stagedBet: 0,
  lastBet: 0,
  notice: null,
  lastAppliedSeq: 0,
  timeoutAskedForVersion: null,
  timeoutAskedAt: null,
  leavingWhenSafe: false,
  lastEvents: EMPTY_EVENTS,

  enter: async (gameId, seatId) => {
    get().forgetTable();
    const generation = tableGeneration;
    // A fresh entry starts live even if a previous table left this reconnecting —
    // there is no hand to reconnect to yet.
    set({ status: { kind: "loading" }, connection: LIVE, notice: null });
    const read = await activeTableGateway().snapshot(gameId);
    if (generation !== tableGeneration) return;
    if (!read.ok) {
      // A table this player has already left. Said in the app's own words, not
      // the server's — "This table has closed. (ref f77e1b11-…)" is a developer
      // message with a request reference in it, and a player who has just been
      // paid out does not need to read either half.
      if (dropIfSeatIsClosed(get, set, read)) return;
      set({ status: statusForFailure(read) });
      return;
    }
    set({
      status: { kind: "at-table", state: read.state, seatId },
      stagedBet: 0,
      // A different table has different limits and a different stack, and this
      // client has no history at THIS one yet. Repeat stays unavailable until
      // the server accepts a bet here.
      lastBet: 0,
      notice: null,
      // A fresh table has no sequence history and no outstanding ask. The
      // snapshot read carries no events, so this is 0 rather than a seq.
      lastAppliedSeq: seqRangeOf(read.events)?.last ?? 0,
      timeoutAskedForVersion: null,
      timeoutAskedAt: null,
      // A different table. An intent to leave the last one is not one to leave
      // this one.
      leavingWhenSafe: false,
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
      if (generation !== tableGeneration) return;
      applyPushedState(get, set, pushed, events);
    });
  },

  refresh: async () => {
    const current = get().status;
    if (current.kind !== "at-table") return;
    const generation = tableGeneration;

    // The poll is already a retry loop running every three seconds — stacking
    // the gateway's own backoff inside it would leave several polls in flight
    // at once against a server that is already struggling. See TableCallOptions.
    const read = await activeTableGateway().snapshot(current.state.gameId, { retry: false });
    if (generation !== tableGeneration) return;
    if (!read.ok) {
      // ...unless the seat itself is gone, which is not a transient.
      if (dropIfSeatIsClosed(get, set, read)) return;
      // A failed poll is not a reason to tear the table down — the last known
      // snapshot stays on screen and the next poll tries again.
      const { connection, notice } = afterFailure(read);
      set({ connection, notice });
      return;
    }
    const latest = get().status;
    if (latest.kind !== "at-table" || read.state.version < latest.state.version) return;
    set({
      ...snapshotUpdate(get, read.state, EMPTY_EVENTS),
      // A poll that lands is how a reconnecting client discovers it is live
      // again — there is no other signal, since the poll itself is silent
      // on success.
      connection: LIVE,
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

    /*
     * A leave the server refused mid-hand, completed now that it cannot be.
     *
     * The poll is the right driver: it is the only thing that keeps running
     * while a player watches out a hand they are no longer part of. The phase
     * test is the ENGINE's — `canCloseSeat`, the same function `cashOut`
     * refuses with — so this cannot ask, three seconds at a time, for something
     * that is about to be refused. `void` because a poll must not wait on it.
     */
    if (
      shouldCompleteLeave({
        leavingWhenSafe: get().leavingWhenSafe,
        pending: get().pending,
        table: read.state,
        seatId: current.seatId,
      })
    ) {
      void get().leaveTable();
    }
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
    get().stayAtTable();
  },

  clearBet: () => set({ stagedBet: 0, notice: null }),

  /*
   * Betting is how a player says they have changed their mind.
   *
   * Without this, somebody who tapped leave mid-hand, was told to wait and then
   * decided to play the next one would be cashed out from under their own
   * staged wager the moment betting opened. A held intent that outlives the
   * intention is worse than no intent at all.
   */
  stayAtTable: () => {
    if (get().leavingWhenSafe) set({ leavingWhenSafe: false, notice: null });
  },

  repeatBet: () => {
    const previous = get().lastBet;
    if (previous <= 0) return;
    // Clear first, then stage through `addChip`, so the clamp against this
    // seat's stack and the table maximum is applied exactly once and in one
    // place. Copying the clamp here would be a second implementation of it.
    set({ stagedBet: 0 });
    get().addChip(previous);
  },

  lockBet: async () => {
    const current = get().status;
    if (current.kind !== "at-table" || get().pending) return;
    const generation = tableGeneration;

    const staged = get().stagedBet;
    const legal = current.state.legalActions[current.seatId];
    if (!legal?.betBounds) return;
    if (staged < legal.betBounds.min) {
      set({ notice: `The minimum bet here is ${legal.betBounds.min}.` });
      return;
    }

    set({ pending: true, notice: null });
    // Fires the moment an attempt inside EITHER command comes back silent, so
    // the banner appears from the first failure rather than after the whole
    // backoff for both commands has run out.
    const onRetry = () => {
      if (generation === tableGeneration) set({ connection: RECONNECTING });
    };

    // Two commands, in order: the bet must be recorded before it is locked.
    const placed = await activeTableGateway().command(
      current.state.gameId,
      { type: "PLACE_BET", expectedVersion: current.state.version, payload: { amount: staged } },
      { onRetry },
    );
    if (generation !== tableGeneration) return;
    if (!placed.ok) {
      if (dropIfSeatIsClosed(get, set, placed)) return;
      const { connection, notice } = afterFailure(placed);
      set({ pending: false, connection, notice });
      return;
    }

    const locked = await activeTableGateway().command(
      current.state.gameId,
      { type: "LOCK_BET", expectedVersion: placed.state.version, payload: {} },
      { onRetry },
    );
    if (generation !== tableGeneration) return;
    if (!locked.ok) {
      if (dropIfSeatIsClosed(get, set, locked)) return;
      const { connection, notice } = afterFailure(locked);
      set({
        pending: false,
        stagedBet: 0,
        connection,
        ...snapshotUpdate(get, placed.state, placed.events),
        notice,
      });
      return;
    }
    set({
      pending: false,
      stagedBet: 0,
      // The amount the server ACCEPTED, not the amount that was staged: a
      // refused or clamped bet is not the one to offer again.
      lastBet: staged,
      connection: LIVE,
      ...snapshotUpdate(get, locked.state, locked.events),
      notice: null,
    });
  },

  act: async (action) => {
    await sendSimpleCommand(get, set, action);
  },

  takeInsurance: async () => {
    await sendSimpleCommand(get, set, "INSURANCE");
  },

  declineInsurance: async () => {
    await sendSimpleCommand(get, set, "DECLINE_INSURANCE");
  },

  nextHand: async () => {
    const current = get().status;
    if (current.kind !== "at-table" || get().pending) return;
    const generation = tableGeneration;

    set({ pending: true, notice: null });
    const result = await activeTableGateway().command(
      current.state.gameId,
      { type: "NEXT_HAND", expectedVersion: current.state.version, payload: {} },
      { onRetry: () => {
        if (generation === tableGeneration) set({ connection: RECONNECTING });
      } },
    );
    if (generation !== tableGeneration) return;

    if (!result.ok) {
      if (dropIfSeatIsClosed(get, set, result)) return;
      const { connection, notice } = afterFailure(result);
      set({ pending: false, connection, notice });
      return;
    }
    set({
      pending: false,
      stagedBet: 0,
      connection: LIVE,
      ...snapshotUpdate(get, result.state, result.events),
    });
  },

  resolveTimeout: async () => {
    const current = get().status;
    if (current.kind !== "at-table") return;
    const generation = tableGeneration;
    if (
      !shouldRequestTimeoutResolution({
        deadlineAt: current.state.deadlineAt,
        version: current.state.version,
        now: new Date(),
        pending: get().pending,
        connected: get().connection.kind === "live",
        alreadyAskedForVersion: get().timeoutAskedForVersion,
        lastAskedAt: get().timeoutAskedAt,
      })
    ) {
      return;
    }

    // Recorded BEFORE the call, not after: the await is what a second render
    // tick would race, and an ask that is in flight has already been made.
    set({ timeoutAskedForVersion: current.state.version, timeoutAskedAt: Date.now() });

    const result = await activeTableGateway().command(
      current.state.gameId,
      { type: "RESOLVE_TIMEOUT", expectedVersion: current.state.version, payload: {} },
      // No backoff. If this one is lost the deadline is still expired, the
      // version has not moved, and the next tick asks again.
      { retry: false },
    );
    if (generation !== tableGeneration) return;

    if (!result.ok) {
      /*
       * Silent, in both of the two ways this fails.
       *
       * DEADLINE_NOT_REACHED means this device's clock ran a little ahead of the
       * server's — nothing a player did and nothing they can act on. Silence
       * means the poll will find out what happened. Neither is a refusal of
       * anything the player asked for, and a notice here would also buzz the
       * rejection haptic for a request nobody made.
       */
      if (dropIfSeatIsClosed(get, set, result)) return;
      if (result.reason === "unreachable") set({ connection: RECONNECTING });
      return;
    }
    set({
      connection: LIVE,
      ...snapshotUpdate(get, result.state, result.events),
    });
  },

  leaveTable: async () => {
    const current = get().status;
    // Nothing to close: never sat down, or already closed.
    if (current.kind !== "at-table") {
      get().forgetTable();
      return true;
    }
    const generation = tableGeneration;

    set({ pending: true, notice: null });
    const outcome = await activeTableGateway().cashOut(current.state.gameId);
    if (generation !== tableGeneration) return false;
    set({ pending: false });

    if (!outcome.ok) {
      /*
       * Stay at the table. Walking away from a refused cash-out is exactly the
       * bug this replaced: the chips are still in escrow and the player has no
       * other route back to them.
       *
       * SESSION_BUSY is the one refusal that is a "not yet" rather than a "no",
       * so the ask is HELD and completed at the first safe boundary. Without
       * that the notice below was a promise the app did not keep: a player who
       * tapped leave mid-hand and stopped watching stayed seated, was stood in
       * by the action timer every hand, and their buy-in stayed in escrow.
       */
      const holding = outcome.reason === "refused" && outcome.code === "SESSION_BUSY";
      set({ notice: outcome.message, leavingWhenSafe: holding });
      return false;
    }

    /*
     * The server just told us the balance after the credit. Refreshing rather
     * than trusting a locally computed number keeps the client out of the
     * arithmetic, and refreshing AT ALL is what stops the header showing the
     * pre-cash-out figure until the next launch.
     */
    void useWalletStore.getState().refresh();

    get().forgetTable();
    return true;
  },

  resetStack: async () => {
    const current = get().status;
    if (current.kind !== "at-table" || get().pending) return;
    const generation = tableGeneration;

    set({ pending: true, notice: null });
    const outcome = await activeTableGateway().resetPrivateStack(current.state.gameId);
    if (generation !== tableGeneration) return;

    if (!outcome.ok) {
      // A seat that closed under this player is the one failure worth leaving
      // the table for; everything else is a notice beside a table they are
      // still at, exactly as it is for a command.
      if (dropIfSeatIsClosed(get, set, outcome)) return;
      const { connection, notice } = afterFailure(outcome);
      set({ pending: false, connection, notice });
      return;
    }

    /*
     * The snapshot replaces what was here, like every other server answer.
     *
     * `lastEvents` is NOT touched and `lastAppliedSeq` is left alone: a reset
     * emits no engine event, so there is nothing to hear and no sequence to
     * advance. Clearing the last batch would be wrong in the other direction —
     * the identity is what `useTableFeedback` keys on, and a fresh empty array
     * reads as a new batch.
     */
    set({
      pending: false,
      connection: LIVE,
      ...snapshotUpdate(get, outcome.state),
      // A different stack is a different set of affordable bets, and the wager
      // this seat last had accepted was made against chips it no longer has.
      stagedBet: 0,
      lastBet: 0,
      notice: null,
    });
  },

  forgetTable: () => {
    tableGeneration++;
    unsubscribe?.();
    unsubscribe = null;
    set({
      status: { kind: "idle" },
      connection: LIVE,
      stagedBet: 0,
      lastBet: 0,
      notice: null,
      pending: false,
      lastAppliedSeq: 0,
      timeoutAskedForVersion: null,
      timeoutAskedAt: null,
      leavingWhenSafe: false,
      lastEvents: EMPTY_EVENTS,
    });
  },
}));

/**
 * A pushed snapshot, applied under the specification's sequence rules.
 *
 * The three cases are the specification's own, verbatim:
 *
 *   seq <= lastAppliedSeq        ignore the duplicate
 *   seq == lastAppliedSeq + 1    apply
 *   seq >  lastAppliedSeq + 1    fetch the authoritative snapshot
 *
 * The first is the one that was doing damage. The store deduped on `version`,
 * and a command's own reply and the broadcast the server fans out after
 * committing it carry the SAME version — so every action at a server table
 * applied its events twice, and `useTableFeedback` keys on array identity,
 * which a second `set` changes. Every deal played its cards twice and every
 * settled hand fired its outcome haptic and sting twice.
 *
 * The third is softened by one deliberate difference. Arc 21's broadcast is a
 * FULL public state rather than a delta, so a gap loses events but never state:
 * dropping the payload and waiting for the fetch would blank nothing but would
 * delay a table the client already holds correctly. So the state is adopted, the
 * incomplete event batch is NOT played, and an authoritative snapshot is fetched
 * anyway — which is what makes the recovery real rather than assumed.
 *
 * A batch with no events at all (a competition closing) has no sequence to
 * compare and falls back to the version, which is the only ordering it has.
 */
function applyPushedState(
  get: () => OnlineTableStoreState,
  set: (partial: Partial<OnlineTableStoreState>) => void,
  pushed: PublicGameState,
  events: TableEvents,
): void {
  const current = get().status;
  if (current.kind !== "at-table" || current.state.gameId !== pushed.gameId) return;
  // Polling may already have adopted a newer state without any event sequence.
  // An unseen event number does not make an older snapshot current again.
  if (pushed.version <= current.state.version) return;

  const seq = seqRangeOf(events);
  const lastApplied = get().lastAppliedSeq;

  if (seq === null) {
    // No event sequence; the version check above establishes freshness.
    set({ status: { kind: "at-table", state: pushed, seatId: current.seatId } });
    return;
  }

  // Already applied — this client's own command reply, or a redelivery.
  if (seq.last <= lastApplied) return;

  if (seq.first === lastApplied + 1 || lastApplied === 0) {
    set({
      status: { kind: "at-table", state: pushed, seatId: current.seatId },
      lastAppliedSeq: seq.last,
      // A pushed batch describes somebody else's action as well as your own,
      // which is exactly what should be heard at a shared table.
      lastEvents: events,
    });
    return;
  }

  // A gap. Adopt the state — it is authoritative and never older than what is
  // held — but say nothing about a story with a hole in it, and go and ask.
  set({
    status: { kind: "at-table", state: pushed, seatId: current.seatId },
    lastAppliedSeq: seq.last,
    lastEvents: EMPTY_EVENTS,
  });
  void get().refresh();
}

/**
 * One command with an empty payload, sent and applied.
 *
 * `act`, `takeInsurance` and `declineInsurance` are the same six lines with a
 * different string, and they were about to become three copies of them. The
 * shape is deliberately narrow — no payload — because the two that DO carry one
 * (`PLACE_BET` and `LOCK_BET`) also differ in what they clear afterwards, and
 * folding them in here would hide that.
 *
 * Nothing is predicted locally. The snapshot in the reply is the whole of the
 * new state, so a refusal leaves the table exactly where the server has it.
 */
async function sendSimpleCommand(
  get: () => OnlineTableStoreState,
  set: (partial: Partial<OnlineTableStoreState>) => void,
  type: "INSURANCE" | "DECLINE_INSURANCE" | PlayerActionType,
): Promise<void> {
  const current = get().status;
  if (current.kind !== "at-table" || get().pending) return;
  const generation = tableGeneration;

  set({ pending: true, notice: null });
  const result = await activeTableGateway().command(
    current.state.gameId,
    { type, expectedVersion: current.state.version, payload: {} },
    { onRetry: () => {
      if (generation === tableGeneration) set({ connection: RECONNECTING });
    } },
  );
  if (generation !== tableGeneration) return;

  if (!result.ok) {
    if (dropIfSeatIsClosed(get, set, result)) return;
    const { connection, notice } = afterFailure(result);
    set({ pending: false, connection, notice });
    return;
  }
  set({
    pending: false,
    connection: LIVE,
    ...snapshotUpdate(get, result.state, result.events),
  });
}

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
