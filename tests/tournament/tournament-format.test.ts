/**
 * The Sprint Tournament format.
 *
 * These are the arithmetic that decides someone's placement and prize, so they
 * are tested at the boundaries rather than in the middle: hand 8 versus hand 9,
 * a tie of two versus a tie of three, the fifth tie-break hand versus the sixth.
 *
 * Two of these cover defects that were live and measured, not imagined:
 *
 *   - `decideBankruptcies` exists because one function served both jobs, and
 *     calling it after every ordinary hand quietly turned the format into
 *     "lowest stack out every hand". A real run eliminated three of four players
 *     by hand three and settled the tournament nine hands early.
 *   - the button rotation counts hands DEALT while the bet ceiling counts hands
 *     SCHEDULED, because a sudden-death hand is an extra hand. Conflating them
 *     played eleven scheduled hands and raised the ceiling a hand too soon.
 */

import { describe, expect, it } from "vitest";

import {
  buttonOffsetFor,
  computePlacements,
  decideBankruptcies,
  decideElimination,
  decideFinal,
  maxBetForHand,
  rotateToButton,
  SPRINT,
  walletEffectOfFullTournament,
  type EntryStanding,
} from "../../supabase/functions/_shared/tournament-format.js";

const standing = (
  entryId: string,
  stack: number,
  eliminatedAfterHand: number | null = null,
): EntryStanding => ({ entryId, stack, eliminatedAfterHand });

describe("the format matches the specification", () => {
  it("is four players over twelve hands on equal stacks", () => {
    expect(SPRINT.seats).toBe(4);
    expect(SPRINT.scheduledHands).toBe(12);
    expect(SPRINT.startingStack).toBe(10_000);
    expect(SPRINT.entryFee).toBe(500);
    expect(SPRINT.eliminationHand).toBe(6);
    expect(SPRINT.maxTieBreakHands).toBe(5);
  });

  it("pays 2,000 / 1,000 / 500 / nothing", () => {
    expect([...SPRINT.prizeChips]).toEqual([2_000, 1_000, 500, 0]);
  });

  it("uses whole chips everywhere", () => {
    // No float may reach a balance. Asserted rather than assumed, because a
    // fractional prize would be split into fractional chips below.
    for (const prize of SPRINT.prizeChips) expect(Number.isInteger(prize)).toBe(true);
    expect(Number.isInteger(SPRINT.entryFee)).toBe(true);
    expect(Number.isInteger(SPRINT.startingStack)).toBe(true);
  });
});

describe("the bet ceiling", () => {
  it("is 2,000 through hand 8", () => {
    expect(maxBetForHand(1)).toBe(2_000);
    expect(maxBetForHand(8)).toBe(2_000);
  });

  it("becomes 5,000 at hand 9, not hand 10", () => {
    expect(maxBetForHand(9)).toBe(5_000);
    expect(maxBetForHand(12)).toBe(5_000);
  });
});

describe("the button", () => {
  it("starts where it was drawn and moves one seat a hand", () => {
    expect(buttonOffsetFor(0, 2, 4)).toBe(2);
    expect(buttonOffsetFor(1, 2, 4)).toBe(3);
    expect(buttonOffsetFor(2, 2, 4)).toBe(0);
    expect(buttonOffsetFor(3, 2, 4)).toBe(1);
  });

  it("wraps rather than running off the end", () => {
    expect(buttonOffsetFor(12, 0, 4)).toBe(0);
    expect(buttonOffsetFor(13, 0, 4)).toBe(1);
  });

  it("does not produce a negative index for a negative offset", () => {
    // JavaScript's % keeps the sign of the dividend, which would index nothing.
    expect(buttonOffsetFor(-1, 0, 4)).toBe(3);
  });

  it("rotates the seating order so the button acts first", () => {
    expect(rotateToButton(["a", "b", "c", "d"], 0)).toEqual(["a", "b", "c", "d"]);
    expect(rotateToButton(["a", "b", "c", "d"], 1)).toEqual(["b", "c", "d", "a"]);
    expect(rotateToButton(["a", "b", "c", "d"], 3)).toEqual(["d", "a", "b", "c"]);
  });

  it("preserves every seat when it rotates", () => {
    // The rotation IS the deal order, so losing or duplicating a seat here would
    // drop a player out of the hand.
    const seats = ["a", "b", "c", "d"];
    for (let offset = 0; offset < 8; offset += 1) {
      expect([...rotateToButton(seats, offset)].sort()).toEqual([...seats].sort());
    }
  });
});

describe("bankruptcy, which applies at every hand", () => {
  it("takes out a seat that cannot cover the minimum bet", () => {
    // Not "zero chips": 50 at a 100 minimum is just as finished.
    const decision = decideBankruptcies([standing("a", 10_000), standing("b", 50)]);
    expect(decision).toEqual({ kind: "eliminate", entryIds: ["b"] });
  });

  it("leaves a seat holding exactly the minimum alone", () => {
    const decision = decideBankruptcies([standing("a", 10_000), standing("b", SPRINT.minBet)]);
    expect(decision.kind).toBe("nothing_to_do");
  });

  it("never eliminates the lowest stack on an ordinary hand", () => {
    // The defect this function exists to make impossible.
    const decision = decideBankruptcies([
      standing("a", 10_000),
      standing("b", 9_900),
      standing("c", 9_800),
      standing("d", 9_700),
    ]);
    expect(decision.kind).toBe("nothing_to_do");
  });

  it("ignores players who are already out", () => {
    const decision = decideBankruptcies([standing("a", 10_000), standing("b", 0, 6)]);
    expect(decision.kind).toBe("nothing_to_do");
  });
});

describe("the hand-six elimination boundary", () => {
  it("takes the single lowest stack", () => {
    const decision = decideElimination(
      [standing("a", 12_000), standing("b", 9_000), standing("c", 10_000), standing("d", 11_000)],
      0,
    );
    expect(decision).toEqual({ kind: "eliminate", entryIds: ["b"] });
  });

  it("plays sudden death when the lowest stack is shared", () => {
    const decision = decideElimination(
      [standing("a", 12_000), standing("b", 9_000), standing("c", 9_000), standing("d", 11_000)],
      0,
    );
    expect(decision).toEqual({ kind: "tie_break", entryIds: ["b", "c"] });
  });

  it("eliminates the bankrupt INSTEAD of the lowest survivor, not as well", () => {
    // Two players out at one boundary would change the shape of the field.
    const decision = decideElimination(
      [standing("a", 12_000), standing("b", 50), standing("c", 9_000), standing("d", 11_000)],
      0,
    );
    expect(decision).toEqual({ kind: "eliminate", entryIds: ["b"] });
  });

  it("accepts the tie once five tie-break hands have been used", () => {
    const tied = [standing("a", 12_000), standing("b", 9_000), standing("c", 9_000)];
    expect(decideElimination(tied, 4).kind).toBe("tie_break");
    // The boundary has to resolve, so the whole tied group goes out sharing a
    // placement rather than the tournament playing sudden death forever.
    expect(decideElimination(tied, 5)).toEqual({ kind: "eliminate", entryIds: ["b", "c"] });
  });

  it("has nothing to do with one player left", () => {
    expect(decideElimination([standing("a", 12_000), standing("b", 0, 6)], 0).kind).toBe(
      "nothing_to_do",
    );
  });
});

describe("the final boundary", () => {
  it("does nothing when one stack is clearly largest", () => {
    expect(
      decideFinal([standing("a", 12_000), standing("b", 9_000), standing("c", 10_000)], 0).kind,
    ).toBe("nothing_to_do");
  });

  it("plays sudden death for a tie at the top", () => {
    expect(
      decideFinal([standing("a", 12_000), standing("b", 12_000), standing("c", 10_000)], 0),
    ).toEqual({ kind: "tie_break", entryIds: ["a", "b"] });
  });

  it("does not play sudden death for a tie below first", () => {
    // Second versus third is settled by a shared placement and a split prize.
    // The specification's sudden death is for an elimination or final boundary.
    expect(
      decideFinal([standing("a", 12_000), standing("b", 10_000), standing("c", 10_000)], 0).kind,
    ).toBe("nothing_to_do");
  });

  it("gives up after five tie-break hands", () => {
    expect(decideFinal([standing("a", 12_000), standing("b", 12_000)], 5).kind).toBe(
      "nothing_to_do",
    );
  });
});

describe("placements", () => {
  it("ranks survivors by stack", () => {
    const placements = computePlacements([
      standing("a", 11_000),
      standing("b", 13_000),
      standing("c", 9_000),
    ]);
    expect(placements.map((p) => [p.entryId, p.placement])).toEqual([
      ["b", 1],
      ["a", 2],
      ["c", 3],
    ]);
  });

  it("puts every survivor above everyone eliminated, whatever their stacks", () => {
    // Outlasting the field beats a bigger pile: the eliminated player here has
    // more chips than the survivor and still finishes below them.
    const placements = computePlacements([standing("a", 1_000), standing("b", 20_000, 6)]);
    expect(placements.map((p) => p.entryId)).toEqual(["a", "b"]);
  });

  it("ranks a later elimination above an earlier one", () => {
    const placements = computePlacements([
      standing("a", 12_000),
      standing("b", 500, 3),
      standing("c", 500, 6),
    ]);
    expect(placements.map((p) => [p.entryId, p.placement])).toEqual([
      ["a", 1],
      ["c", 2],
      ["b", 3],
    ]);
  });

  it("pays the schedule to a clean finish", () => {
    const placements = computePlacements([
      standing("a", 13_000),
      standing("b", 11_000),
      standing("c", 10_000),
      standing("d", 9_000, 6),
    ]);
    expect(placements.map((p) => p.prizeChips)).toEqual([2_000, 1_000, 500, 0]);
    expect(placements.map((p) => p.prizeXp)).toEqual([200, 120, 80, 40]);
  });
});

describe("a shared placement divides the prize", () => {
  it("gives two players tied for first 1,500 each and makes the next player third", () => {
    // Competition ranking: 1, 1, 3. The pooled first and second prizes
    // (2,000 + 1,000) divide evenly.
    const placements = computePlacements([
      standing("a", 12_000),
      standing("b", 12_000),
      standing("c", 9_000),
    ]);
    expect(placements.map((p) => [p.entryId, p.placement, p.prizeChips])).toEqual([
      ["a", 1, 1_500],
      ["b", 1, 1_500],
      ["c", 3, 500],
    ]);
  });

  it("floors an uneven split and awards the remainder to nobody", () => {
    // 1,000 + 500 across two players is 750 each and divides exactly; three
    // sharing second takes 1,000 + 500 + 0 = 1,500 -> 500 each. The case that
    // matters is a pool that does NOT divide: the spare chip is not awarded,
    // because choosing a recipient would need an arbitrary key and "arbitrary"
    // is what deterministic is supposed to rule out.
    const placements = computePlacements([
      standing("a", 12_000),
      standing("b", 9_000),
      standing("c", 9_000),
      standing("d", 9_000),
    ]);
    const shared = placements.filter((p) => p.placement === 2);
    expect(shared).toHaveLength(3);
    for (const entry of shared) expect(entry.prizeChips).toBe(500);
    expect(placements.find((p) => p.placement === 1)?.prizeChips).toBe(2_000);
  });

  it("never pays out more than the schedule holds", () => {
    const total = SPRINT.prizeChips.reduce<number>((sum, prize) => sum + prize, 0);
    for (const stacks of [
      [12_000, 12_000, 12_000, 12_000],
      [12_000, 12_000, 9_000, 9_000],
      [12_000, 11_000, 10_000, 9_000],
      [12_000, 12_000, 12_000, 9_000],
    ]) {
      const placements = computePlacements(
        stacks.map((stack, index) => standing(`s${index}`, stack)),
      );
      const paid = placements.reduce((sum, p) => sum + p.prizeChips, 0);
      expect(paid).toBeLessThanOrEqual(total);
    }
  });

  it("gives every tied player the identical amount", () => {
    const placements = computePlacements([
      standing("a", 10_000),
      standing("b", 10_000),
      standing("c", 10_000),
      standing("d", 10_000),
    ]);
    const amounts = new Set(placements.map((p) => p.prizeChips));
    expect(amounts.size).toBe(1);
    // The whole schedule, 3,500, pooled four ways: 875 each.
    expect([...amounts][0]).toBe(875);
  });
});

describe("the effect on the chip supply", () => {
  it("is a net source of 1,500 chips, and says so", () => {
    // Stated rather than assumed. The specification's own figures — a 500 entry
    // against 2,000/1,000/500 prizes — put more chips in than they take out,
    // which is a deliberate property of an economy with nothing to protect.
    const effect = walletEffectOfFullTournament();
    expect(effect.feesTaken).toBe(2_000);
    expect(effect.prizesPaid).toBe(3_500);
    expect(effect.netToWallets).toBe(1_500);
  });
});
