/**
 * Reading a daily challenge and a tournament on the client.
 *
 * Rows are parsed, never trusted, and the two things these guard are the ones a
 * player would be actively misled by:
 *
 *   - whether the attempt about to start is RANKED. That is the server's answer,
 *     and a client that guessed it wrong would tell someone their run counted when
 *     it did not.
 *   - a shared placement. Seeing 750 where the schedule says 1,000 needs an
 *     explanation on screen, or it reads as the game shortchanging you.
 */

import { describe, expect, it } from "vitest";

import {
  describeAttempt,
  describeVerdict,
  describeVerification,
  toAttempt,
  toChallenge,
  toVerification,
} from "../../src/features/daily/index.js";
import {
  describeProgress,
  ordinal,
  sharedPlacements,
  toEntry,
  toFormat,
  toStandings,
} from "../../src/features/tournament/index.js";

const CHALLENGE = {
  id: "11111111-1111-4111-8111-111111111111",
  challenge_date: "2026-08-17",
  seed_commitment: "a".repeat(64),
  revealed_seed: null,
  hand_count: 20,
  starting_chips: 5_000,
  reward_chips: 1_000,
  reward_xp: 150,
  closes_at: "2026-08-18T00:00:00.000Z",
};

/**
 * The audit row — a CLOSED challenge whose seed has been published.
 *
 * The whole point of a commitment is that somebody can check it, and for the
 * life of this feature nobody could: the column existed, the trigger guarded it,
 * the projection carried it and the screen rendered it, and nothing in the
 * product ever wrote it. These parse the row that now exists, and the wording
 * for each verdict — including the one that matters.
 */
describe("verifying a published seed", () => {
  const VERIFICATION = {
    challenge_date: "2026-08-16",
    seed_commitment: "b".repeat(64),
    revealed_seed: "arc21:daily:2026-08-16:" + "c".repeat(64),
    seed_revealed_at: "2026-08-17T00:00:01.000Z",
  };

  it("parses a published row", () => {
    const parsed = toVerification(VERIFICATION);
    expect(parsed?.date).toBe("2026-08-16");
    expect(parsed?.revealedSeed).toBe(VERIFICATION.revealed_seed);
  });

  it("accepts either a bare row or a single-row array", () => {
    expect(toVerification([VERIFICATION])?.date).toBe("2026-08-16");
  });

  it("refuses a row with no seed, which is not something to verify", () => {
    expect(toVerification({ ...VERIFICATION, revealed_seed: "" })).toBeNull();
    expect(toVerification({ ...VERIFICATION, revealed_seed: null })).toBeNull();
  });

  it("refuses a commitment that is not a SHA-256 hex digest", () => {
    expect(toVerification({ ...VERIFICATION, seed_commitment: "nope" })).toBeNull();
  });

  it("returns nothing for an empty answer, rather than an empty verdict", () => {
    expect(toVerification([])).toBeNull();
    expect(toVerification(null)).toBeNull();
  });

  it("says plainly when the hash does NOT match", () => {
    // Softening this would be worse than not checking at all: a mismatch would
    // mean the shoe was not the one committed to before play.
    expect(describeVerdict("does-not-match")).toMatch(/does NOT hash/);
  });

  it("does not claim a check it has not finished", () => {
    expect(describeVerdict("checking")).not.toMatch(/Checked on this device/);
    expect(describeVerdict("unavailable")).toMatch(/nothing has been checked/);
  });

  it("says WHERE the check happened when it passes", () => {
    // "The server says it matches" would be asking to be believed twice.
    expect(describeVerdict("matches")).toMatch(/on this device/);
  });
});

describe("reading today's challenge", () => {
  it("parses a live row", () => {
    const challenge = toChallenge(CHALLENGE);
    expect(challenge?.handCount).toBe(20);
    expect(challenge?.startingChips).toBe(5_000);
    expect(challenge?.revealedSeed).toBeNull();
  });

  it("accepts either a bare row or a single-row array", () => {
    // PostgREST returns a row for a scalar function and an array for a
    // set-returning one; depending on which would break on a schema change.
    expect(toChallenge([CHALLENGE])?.id).toBe(CHALLENGE.id);
  });

  it("rejects a commitment that is not a SHA-256 hex digest", () => {
    // The commitment is the whole fairness claim. A malformed one is refused
    // rather than rendered, because a hash a player cannot verify is worse than
    // no hash: it looks like evidence.
    expect(toChallenge({ ...CHALLENGE, seed_commitment: "not-a-hash" })).toBeNull();
    expect(toChallenge({ ...CHALLENGE, seed_commitment: "A".repeat(64) })).toBeNull();
  });

  it("rejects a half-readable row rather than filling in blanks", () => {
    expect(toChallenge({ id: CHALLENGE.id })).toBeNull();
    expect(toChallenge(null)).toBeNull();
    expect(toChallenge([])).toBeNull();
  });

  it("never carries a seed field at all", () => {
    // The server's projection does not expose it, so there is nothing here to
    // accidentally render — asserted so a future schema change cannot add one.
    const challenge = toChallenge(CHALLENGE)!;
    expect(Object.keys(challenge)).not.toContain("seedSecret");
    expect(Object.keys(challenge)).not.toContain("seed_secret");
  });
});

describe("what the player is told about their attempt", () => {
  it("offers a ranked attempt when none has been used", () => {
    const plan = describeAttempt(null);
    expect(plan.ranked).toBe(true);
    expect(plan.detail).toMatch(/one ranked attempt/i);
  });

  it("offers to resume one that is still open", () => {
    const attempt = toAttempt({
      daily_challenge_id: CHALLENGE.id,
      game_session_id: "22222222-2222-4222-8222-222222222222",
      status: "in_progress",
      hands_played: 7,
      final_chips: 5_200,
      score: 0,
      completed_at: null,
    });
    const plan = describeAttempt(attempt);
    expect(plan.ranked).toBe(true);
    expect(plan.label).toMatch(/resume/i);
    // Hand 8, not hand 7: seven are behind them.
    expect(plan.detail).toMatch(/Hand 8/);
  });

  it("says plainly that a replay scores nothing", () => {
    const attempt = toAttempt({
      daily_challenge_id: CHALLENGE.id,
      game_session_id: null,
      status: "completed",
      hands_played: 20,
      final_chips: 6_100,
      score: 6_100,
      completed_at: "2026-08-17T09:00:00.000Z",
    });
    const plan = describeAttempt(attempt);
    expect(plan.ranked).toBe(false);
    expect(plan.label).toMatch(/unranked/i);
    expect(plan.detail).toMatch(/scores nothing/i);
  });
});

describe("explaining the seed commitment", () => {
  it("says the seed is still secret while the challenge runs", () => {
    const text = describeVerification(toChallenge(CHALLENGE)!);
    expect(text).toMatch(/before anyone played/i);
    expect(text).toMatch(/secret until the challenge closes/i);
  });

  it("says how to check it once the seed is published", () => {
    const revealed = toChallenge({ ...CHALLENGE, revealed_seed: "arc21:daily:2026-08-17:beef" })!;
    expect(describeVerification(revealed)).toMatch(/SHA-256 of it must equal the commitment/i);
  });
});

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

const ENTRY = {
  tournament_id: "33333333-3333-4333-8333-333333333333",
  entry_id: "44444444-4444-4444-8444-444444444444",
  tournament_status: "registering" as const,
  entry_status: "registered" as const,
  game_session_id: null,
  game_session_seat_id: null,
  entries_filled: 2,
  seats_required: 4,
  chips: 0,
  placement: null,
  tie_break_boundary: null,
  tie_break_hands_used: 0,
};

describe("reading the tournament format", () => {
  it("parses the published configuration", () => {
    const format = toFormat(FORMAT);
    expect(format?.scheduled_hands).toBe(12);
    expect(format?.entry_fee_chips).toBe(500);
    expect(format?.prize_structure).toHaveLength(4);
  });

  it("refuses a format it cannot fully read", () => {
    // This is the screen a player reads before spending chips. A partially
    // understood format is not something to render half of.
    expect(toFormat({ ...FORMAT, prize_structure: "lots" })).toBeNull();
    expect(toFormat({ ...FORMAT, entry_fee_chips: -1 })).toBeNull();
    expect(toFormat(null)).toBeNull();
  });
});

describe("what the tournament screen says", () => {
  it("carries the SEAT id, not just the entry id", () => {
    // The table screen finds the player's own hand and controls by seat id. Handed
    // an entry id it matches no seat and renders a table with no buttons — which is
    // what happened before this field existed.
    const seated = toEntry({
      ...ENTRY,
      tournament_status: "running",
      entry_status: "active",
      game_session_id: "77777777-7777-4777-8777-777777777777",
      game_session_seat_id: "88888888-8888-4888-8888-888888888888",
    })!;
    expect(seated.game_session_seat_id).toBe("88888888-8888-4888-8888-888888888888");
    expect(seated.game_session_seat_id).not.toBe(seated.entry_id);
  });

  it("counts down the seats still to fill", () => {
    expect(describeProgress(toEntry(ENTRY)!)).toMatch(/Waiting for 2 more players/);
  });

  it("uses the singular for one remaining seat", () => {
    expect(describeProgress(toEntry({ ...ENTRY, entries_filled: 3 })!)).toMatch(
      /Waiting for 1 more player\./,
    );
  });

  it("says the field is full rather than waiting for minus one", () => {
    expect(describeProgress(toEntry({ ...ENTRY, entries_filled: 4 })!)).toMatch(/field is full/i);
  });

  it("names the sudden-death boundary while one is being played", () => {
    const entry = toEntry({
      ...ENTRY,
      tournament_status: "running",
      entry_status: "active",
      tie_break_boundary: 6,
      tie_break_hands_used: 1,
    })!;
    expect(describeProgress(entry)).toMatch(/Sudden death at hand 6/);
  });

  it("tells an eliminated player the tournament continues without them", () => {
    const entry = toEntry({
      ...ENTRY,
      tournament_status: "running",
      entry_status: "eliminated",
    })!;
    expect(describeProgress(entry)).toMatch(/tournament continues/i);
  });

  it("reports the final placement", () => {
    const entry = toEntry({
      ...ENTRY,
      tournament_status: "completed",
      entry_status: "active",
      placement: 2,
    })!;
    expect(describeProgress(entry)).toMatch(/Finished 2nd/);
  });
});

describe("ordinals", () => {
  it("handles the ordinary cases", () => {
    expect([1, 2, 3, 4].map(ordinal)).toEqual(["1st", "2nd", "3rd", "4th"]);
  });

  it("handles the teens, which are the ones that go wrong", () => {
    expect([11, 12, 13].map(ordinal)).toEqual(["11th", "12th", "13th"]);
    expect([21, 22, 23, 111].map(ordinal)).toEqual(["21st", "22nd", "23rd", "111th"]);
  });
});

describe("standings", () => {
  const row = (overrides: Record<string, unknown> = {}) => ({
    entry_id: "55555555-5555-4555-8555-555555555555",
    display_name: "player_one",
    chips: 10_000,
    status: "active" as const,
    placement: null,
    eliminated_after_hand: null,
    in_tie_break: false,
    prize_chips: 0,
    prize_xp: 0,
    is_you: false,
    ...overrides,
  });

  it("parses a list", () => {
    expect(toStandings([row(), row({ entry_id: "66666666-6666-4666-8666-666666666666" })])).toHaveLength(2);
  });

  it("drops a row it cannot read rather than half-rendering it", () => {
    // Standings with a gap are recoverable. Standings with an invented stack are
    // not — a player would read it as their real position.
    const rows = toStandings([row(), { entry_id: "nope" }]);
    expect(rows).toHaveLength(1);
  });

  it("returns nothing for a non-list", () => {
    expect(toStandings(null)).toEqual([]);
    expect(toStandings({ entry_id: "x" })).toEqual([]);
  });

  it("finds placements that more than one player shares", () => {
    // Surfaced on screen because a shared placement means the prize was pooled and
    // divided: 750 where the schedule says 1,000 has an explanation, not a bug.
    const shared = sharedPlacements([
      row({ entry_id: "a", placement: 1 }),
      row({ entry_id: "b", placement: 1 }),
      row({ entry_id: "c", placement: 3 }),
    ]);
    expect([...shared]).toEqual([1]);
  });

  it("does not report a placement nobody shares", () => {
    const shared = sharedPlacements([
      row({ entry_id: "a", placement: 1 }),
      row({ entry_id: "b", placement: 2 }),
    ]);
    expect(shared.size).toBe(0);
  });

  it("ignores players who have no placement yet", () => {
    const shared = sharedPlacements([row({ entry_id: "a" }), row({ entry_id: "b" })]);
    expect(shared.size).toBe(0);
  });
});
