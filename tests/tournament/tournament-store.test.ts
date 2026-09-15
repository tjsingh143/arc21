/**
 * What the Sprint screen actually SAYS after an action.
 *
 * THE DEFECT THIS FILE PINS, and it was found on a device rather than here.
 * `register` and `withdraw` both finish by reloading — they have to, because
 * what the player now holds is the server's answer and not theirs — and `load`
 * ended with `notice: null`. So every message either action produced was
 * destroyed a few milliseconds after it was written: the refund sentence a
 * player needs in order to believe their 500 chips came back, and "You were
 * already entered. No second fee was taken.", which exists precisely because
 * being entered with no visible charge otherwise reads as a bug.
 *
 * Nothing failed. The Maestro flow tapped "Leave the queue and refund 500
 * chips", the tap COMPLETED, the control disappeared, the entry was gone and
 * the money was back — and the sentence explaining it was never on screen. It
 * was caught by asserting the RESULT rather than the tap, which is the rule
 * this repository has now paid for four times.
 *
 * The other half — that a background poll must not wipe a notice either — is
 * the same bug with a different trigger: the screen re-reads itself every three
 * seconds while a tournament is live.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.fn();
const rpc = vi.fn();
const getSession = vi.fn();
vi.mock("../../src/features/wallet/wallet-store.js", () => ({
  useWalletStore: { getState: () => ({ refresh: async () => undefined }) },
}));

vi.mock("../../src/lib/supabase/client.js", () => ({
  getSupabase: () => ({
    status: "ready",
    client: {
      auth: { getSession },
      rpc,
      functions: { invoke },
    },
  }),
}));

const { useTournamentStore } = await import(
  "../../src/features/tournament/tournament-store.js"
);

const FORMAT = {
  seats: 4,
  scheduled_hands: 12,
  starting_chips: 10_000,
  entry_fee_chips: 500,
  min_bet: 100,
  early_max_bet: 2_000,
  late_max_bet: 5_000,
  late_bets_from: 9,
  elimination_hand: 6,
  prize_structure: [
    { placement: 1, chips: 2_000, xp: 200 },
    { placement: 2, chips: 1_000, xp: 120 },
    { placement: 3, chips: 500, xp: 80 },
    { placement: 4, chips: 0, xp: 40 },
  ],
};

const WAITING_ENTRY = {
  tournament_id: "11111111-1111-4111-8111-111111111111",
  entry_id: "22222222-2222-4222-8222-222222222222",
  tournament_status: "registering" as const,
  entry_status: "registered" as const,
  game_session_id: null,
  game_session_seat_id: null,
  entries_filled: 1,
  seats_required: 4,
  chips: 0,
  placement: null,
  tie_break_boundary: null,
  tie_break_hands_used: 0,
};

/** What `my_sprint_entry` answers next. Null means "no entry". */
let entryRow: unknown = null;

beforeEach(() => {
  invoke.mockReset();
  rpc.mockReset();
  getSession.mockReset();
  entryRow = null;

  getSession.mockResolvedValue({ data: { session: { user: { id: "u" } } } });
  rpc.mockImplementation(async (name: string) => {
    if (name === "sprint_format") return { data: [FORMAT], error: null };
    if (name === "my_sprint_entry") return { data: entryRow ? [entryRow] : [], error: null };
    if (name === "sprint_standings") return { data: [], error: null };
    return { data: null, error: null };
  });

  useTournamentStore.setState({
    status: { kind: "loading" },
    notice: null,
    registering: false,
    withdrawing: false,
  });
});

describe("leaving the sprint queue", () => {
  it("replays a lost withdrawal reply with the same intent and reloads the refunded entry", async () => {
    entryRow = WAITING_ENTRY;
    await useTournamentStore.getState().load();
    invoke.mockImplementationOnce(async () => {
      entryRow = null;
      return { data: null, error: { name: "FunctionsFetchError" } };
    }).mockResolvedValueOnce({ data: { status: "sprint_withdrawn", refundChips: 0 }, error: null });
    await useTournamentStore.getState().withdraw();
    expect(invoke).toHaveBeenCalledTimes(2);
    expect(invoke.mock.calls[1]).toEqual(invoke.mock.calls[0]);
    expect(useTournamentStore.getState().status).toMatchObject({ kind: "ready", entry: null });
    expect(useTournamentStore.getState().notice).toContain("No second refund was made");
  });
  it("tells the player their entry fee came back, and the message survives the reload", async () => {
    entryRow = WAITING_ENTRY;
    await useTournamentStore.getState().load();
    expect(useTournamentStore.getState().status).toMatchObject({ kind: "ready" });

    invoke.mockResolvedValue({
      data: {
        status: "sprint_withdrawn",
        tournamentId: WAITING_ENTRY.tournament_id,
        entryId: WAITING_ENTRY.entry_id,
        refundChips: 500,
        walletBalance: 25_000,
        tournamentCancelled: true,
      },
      error: null,
    });
    // The withdrawal empties the tournament, so the reload finds no entry.
    entryRow = null;

    await useTournamentStore.getState().withdraw();

    const state = useTournamentStore.getState();
    expect(state.notice).toContain("500 chips is back in your balance");
    expect(state.withdrawing).toBe(false);
    // And the screen is back to offering an entry rather than showing one.
    expect(state.status).toMatchObject({ kind: "ready", entry: null });
  });

  it("says a replayed withdrawal refunded nothing a second time", async () => {
    entryRow = WAITING_ENTRY;
    await useTournamentStore.getState().load();

    invoke.mockResolvedValue({
      data: { status: "sprint_withdrawn", refundChips: 0 },
      error: null,
    });
    entryRow = null;

    await useTournamentStore.getState().withdraw();
    expect(useTournamentStore.getState().notice).toContain("No second refund");
  });

  it("distinguishes a refusal by what the player still holds, not by guessing", async () => {
    /*
     * `WITHDRAW_SPRINT` refuses for exactly two reasons — the cards are out, or
     * there is no entry — and the reload is the only thing that knows which.
     * Telling a player whose entry had already expired that "the tournament has
     * been dealt" would send them looking for a table that does not exist.
     */
    entryRow = { ...WAITING_ENTRY, tournament_status: "running" as const };
    await useTournamentStore.getState().load();

    invoke.mockResolvedValue({ data: null, error: { name: "FunctionsHttpError",
      context: { json: async () => ({ status: "rejected", code: "INVALID_PHASE", message: "Cannot withdraw." }) },
    } });
    await useTournamentStore.getState().withdraw();
    expect(useTournamentStore.getState().notice).toContain("already been dealt");

    // Now the same refusal with nothing held.
    entryRow = null;
    await useTournamentStore.getState().withdraw();
    expect(useTournamentStore.getState().notice).toContain("not in a tournament");
  });
});

describe("entering", () => {
  it("says plainly when a retry took no second fee", async () => {
    entryRow = null;
    await useTournamentStore.getState().load();

    invoke.mockResolvedValue({
      data: { status: "sprint_registered", entryFee: 0, tournamentId: WAITING_ENTRY.tournament_id },
      error: null,
    });
    entryRow = WAITING_ENTRY;

    await useTournamentStore.getState().register();
    expect(useTournamentStore.getState().notice).toContain("No second fee was taken");
  });

  it("says nothing extra when the fee was actually taken", async () => {
    entryRow = null;
    await useTournamentStore.getState().load();

    invoke.mockResolvedValue({
      data: { status: "sprint_registered", entryFee: 500 },
      error: null,
    });
    entryRow = WAITING_ENTRY;

    await useTournamentStore.getState().register();
    expect(useTournamentStore.getState().notice).toBeNull();
  });
});

describe("the background poll", () => {
  it("does not turn an unreadable entry into an invitation to register again", async () => {
    rpc.mockImplementation(async (name: string) => name === "sprint_format"
      ? { data: [FORMAT], error: null }
      : { data: null, error: { message: "offline" } });
    await useTournamentStore.getState().load();
    expect(useTournamentStore.getState().status.kind).toBe("unavailable");
  });
  it("does not wipe a message the player has not read yet", async () => {
    // The screen re-reads itself every three seconds while a tournament is
    // live. A notice destroyed by that is a notice nobody sees.
    entryRow = WAITING_ENTRY;
    await useTournamentStore.getState().load();
    useTournamentStore.setState({ notice: "Your entry fee of 500 chips is back." });

    await useTournamentStore.getState().load();
    expect(useTournamentStore.getState().notice).toContain("500 chips is back");
  });

  it("clears the signed-out explanation once an account appears", async () => {
    getSession.mockResolvedValue({ data: { session: null } });
    await useTournamentStore.getState().load();
    expect(useTournamentStore.getState().notice).toContain("need an account");

    getSession.mockResolvedValue({ data: { session: { user: { id: "u" } } } });
    await useTournamentStore.getState().load();
    expect(useTournamentStore.getState().notice).toBeNull();
  });
});
