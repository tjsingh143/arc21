import { describe, expect, it } from "vitest";
import { describeProgress, tableForEntry, type SprintEntry } from "../../src/features/tournament/tournament.js";

const active: SprintEntry = {
  tournament_id: "11111111-1111-4111-8111-111111111111",
  entry_id: "22222222-2222-4222-8222-222222222222",
  tournament_status: "running", entry_status: "active",
  game_session_id: "33333333-3333-4333-8333-333333333333",
  game_session_seat_id: "44444444-4444-4444-8444-444444444444",
  entries_filled: 4, seats_required: 4, chips: 10_000, placement: null,
  tie_break_boundary: null, tie_break_hands_used: 0,
};

describe("Sprint entry navigation used by the production screen", () => {
  it("opens the active seat, including during sudden death", () => {
    expect(tableForEntry({ ...active, tie_break_boundary: 6 })).toEqual({
      gameId: active.game_session_id, seatId: active.game_session_seat_id,
    });
  });
  it.each(["eliminated", "withdrawn", "registered"] as const)("does not open a %s seat's historical ID", (entry_status) => {
    expect(tableForEntry({ ...active, entry_status })).toBeNull();
  });
  it.each(["registering", "completed", "cancelled", "scheduled"] as const)("does not open a %s tournament", (tournament_status) => {
    expect(tableForEntry({ ...active, tournament_status })).toBeNull();
  });
  it("requires both authoritative IDs", () => {
    expect(tableForEntry(null)).toBeNull();
    expect(tableForEntry({ ...active, game_session_id: null })).toBeNull();
    expect(tableForEntry({ ...active, game_session_seat_id: null })).toBeNull();
  });
  it("keeps an eliminated player out while other players contest a tie", () => {
    expect(describeProgress({ ...active, entry_status: "eliminated", tie_break_boundary: 12 }))
      .toBe("You are out. The tournament continues.");
    expect(describeProgress({ ...active, entry_status: "eliminated", tournament_status: "completed", placement: 4 }))
      .toBe("Finished 4th.");
  });
});
