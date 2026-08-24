/**
 * Grading a decision on the server.
 *
 * This is what makes the strategy leaderboard mean anything: the specification's
 * bar is "minimum 100 eligible SERVER-AUTHORITATIVE decisions", and an accuracy a
 * client reports is an accuracy a client chooses.
 *
 * The tests below are mostly about what is NOT counted. A grade that is wrong in
 * the player's favour inflates a leaderboard; a grade that is wrong against them
 * takes credit for play they did correctly. Both are worse than not counting.
 */

import { describe, expect, it } from "vitest";

import {
  ACCURACY_ELIGIBLE_MODES,
  adviceFor,
  assistanceShowsTheAnswer,
  countsTowardsAccuracy,
  gradeDecision,
  isGradedMode,
} from "../../supabase/functions/_shared/decision-grading.js";
import type { EngineState } from "../../shared/blackjack/index.js";
import { harness } from "../helpers/engine-harness.js";

/**
 * A table dealt from an exact card sequence, stopped at the player's decision.
 *
 * Uses the shared `harness` rather than assembling a shoe by hand. A first
 * version did the latter and silently dealt entirely different cards — the
 * fixtures read as "16 against a 10" while the engine dealt 9,5 against a 7, and
 * every assertion still passed because they were about the grading rather than
 * the cards. Deal order is player, dealer up, player, dealer hole.
 */
function tableAt(shoe: string): EngineState {
  return harness({ shoe, seats: [{ seatId: "s1", displayName: "P", stack: 5_000 }] })
    .send({ type: "PLACE_BET", seatId: "s1", amount: 100 })
    .send({ type: "LOCK_BET", seatId: "s1" }).state;
}

describe("assistance, which is the other half of eligibility", () => {
  /*
   * "Solo is unassisted" used to be true by construction: the shared table
   * screen rendered no advice, and the comment above `ACCURACY_ELIGIBLE_MODES`
   * said exactly that. Quick Play's assistance selector made it false, so it is
   * now a fact recorded on the session row — chosen once at OPEN, never
   * revisable, because a client that could name its assistance per decision
   * could opt a MISTAKE out of its own accuracy.
   */
  it("counts an unassisted solo table", () => {
    expect(countsTowardsAccuracy("solo", "play")).toBe(true);
    expect(countsTowardsAccuracy("solo", "challenge")).toBe(true);
  });

  it("does not count a table that showed the answer first", () => {
    expect(countsTowardsAccuracy("solo", "learn")).toBe(false);
    expect(countsTowardsAccuracy("solo", "analysis")).toBe(false);
  });

  it("defaults to unassisted, so every existing caller is unchanged", () => {
    // The column defaults to 'play' and the parameter defaults to 'play'. A
    // mode with no selector — public tables, tournaments, the daily challenge —
    // must keep exactly the eligibility it had.
    expect(countsTowardsAccuracy("solo")).toBe(true);
    expect(countsTowardsAccuracy("public_table")).toBe(true);
    expect(countsTowardsAccuracy("daily_challenge")).toBe(true);
  });

  it("never lets assistance rescue a mode that was excluded anyway", () => {
    expect(countsTowardsAccuracy("tournament", "play")).toBe(false);
    expect(countsTowardsAccuracy("practice", "challenge")).toBe(false);
  });

  it("names the two modes that show the answer, and only those", () => {
    expect(assistanceShowsTheAnswer("learn")).toBe(true);
    expect(assistanceShowsTheAnswer("analysis")).toBe(true);
    expect(assistanceShowsTheAnswer("play")).toBe(false);
    expect(assistanceShowsTheAnswer("challenge")).toBe(false);
    expect(assistanceShowsTheAnswer("")).toBe(false);
  });

  it("grades career without counting it, which is a wider set than eligibility", () => {
    // A career node's second and third stars ARE accuracy thresholds, so its
    // decisions must be graded — but half the nodes run in Learn, so they must
    // not reach the ranked board. Two questions, two predicates.
    expect(isGradedMode("career")).toBe(true);
    expect(countsTowardsAccuracy("career")).toBe(false);
    for (const mode of ACCURACY_ELIGIBLE_MODES) expect(isGradedMode(mode)).toBe(true);
    expect(isGradedMode("practice")).toBe(false);
    expect(isGradedMode("tournament")).toBe(false);
  });
});

describe("which modes count", () => {
  it("is the ranked, unassisted, server-authoritative three", () => {
    expect([...ACCURACY_ELIGIBLE_MODES]).toEqual(["solo", "public_table", "daily_challenge"]);
  });

  it("excludes Practice", () => {
    // Practice offers assistance modes, so the answer can be shown before the
    // choice. It is also local and never reaches a server command at all.
    expect(countsTowardsAccuracy("practice")).toBe(false);
  });

  it("excludes tournaments", () => {
    // Named in the specification. Correct tournament play deviates from the
    // chart, so scoring it against basic strategy would punish playing the format
    // properly.
    expect(countsTowardsAccuracy("tournament")).toBe(false);
  });

  it("excludes private tables", () => {
    // The product calls them unranked. Their chips are unranked, so their
    // decisions are too.
    expect(countsTowardsAccuracy("private_table")).toBe(false);
  });

  it("excludes anything nobody has classified", () => {
    // An allowlist, not a denylist: a mode added later counts for nothing until
    // somebody decides it should.
    expect(countsTowardsAccuracy("some_new_mode")).toBe(false);
    expect(countsTowardsAccuracy("")).toBe(false);
  });
});

describe("grading a real decision", () => {
  it("marks the chart's play as optimal", () => {
    // Hard 16 against a dealer 10 — verified as the dealt hand, not assumed.
    // The chart's answer is not asserted from memory here; the property is that
    // whatever it says, it says exactly ONE thing.
    const state = tableAt("10S 10D 6H 7C");
    const graded = (["HIT", "STAND", "DOUBLE", "SURRENDER"] as const).map((action) => ({
      action,
      grade: gradeDecision({ mode: "solo", state, seatId: "s1", action }),
    }));

    const counted = graded.filter((entry) => entry.grade.counted);
    expect(counted.length).toBeGreaterThan(0);
    // Whatever the chart says, it says ONE thing.
    expect(counted.filter((entry) => entry.grade.optimal)).toHaveLength(1);
  });

  it("gives the same verdict every time for the same state", () => {
    const state = tableAt("10S 10D 6H 7C");
    const first = gradeDecision({ mode: "solo", state, seatId: "s1", action: "HIT" });
    const second = gradeDecision({ mode: "solo", state, seatId: "s1", action: "HIT" });
    expect(first).toEqual(second);
  });

  it("counts a decision at a public table and at the daily challenge too", () => {
    const state = tableAt("10S 10D 6H 7C");
    for (const mode of ["solo", "public_table", "daily_challenge"]) {
      expect(gradeDecision({ mode, state, seatId: "s1", action: "STAND" }).counted).toBe(true);
    }
  });
});

describe("what is deliberately not counted", () => {
  const state = tableAt("10S 10D 6H 7C");

  it("a decision in an excluded mode", () => {
    const grade = gradeDecision({ mode: "tournament", state, seatId: "s1", action: "STAND" });
    expect(grade.counted).toBe(false);
    expect(grade.skipped).toBe("mode");
  });

  it("a default the SERVER applied for an absent player", () => {
    // The engine's documented timeout default is to stand. Recording that as the
    // player's own choice would move their accuracy for something they did not do.
    const grade = gradeDecision({
      mode: "solo",
      state,
      seatId: "s1",
      action: "STAND",
      wasTimeout: true,
    });
    expect(grade.counted).toBe(false);
    expect(grade.skipped).toBe("timeout-default");
  });

  it("a seat that is not at the table", () => {
    const grade = gradeDecision({ mode: "solo", state, seatId: "nobody", action: "STAND" });
    expect(grade.counted).toBe(false);
    expect(grade.skipped).toBe("no-hand");
  });

  it("a hand the chart has no cell for", () => {
    // A natural blackjack is not a decision. `describeStrategyState` returns null
    // for it, and the grader counts nothing rather than inventing a coordinate.
    const natural = tableAt("AS 10D 10H 7C");
    const grade = gradeDecision({ mode: "solo", state: natural, seatId: "s1", action: "STAND" });
    expect(grade.counted).toBe(false);
  });
});

describe("the diagnostic", () => {
  it("never names the recommended action", () => {
    // A diagnostic that said "should have hit" would be a hint leaking through
    // the logs, on the one screen where assistance is off.
    const state = tableAt("10S 10D 6H 7C");
    for (const mode of ["tournament", "private_table", "practice"]) {
      const grade = gradeDecision({ mode, state, seatId: "s1", action: "STAND" });
      expect(grade.skipped).toBeDefined();
      expect(grade.skipped).not.toMatch(/HIT|STAND|DOUBLE|SPLIT|SURRENDER/);
    }
  });
});

/**
 * What a decision COST, which is the daily board's second tie-break.
 *
 * The grade already answered "did this match the chart". Ranking two players who
 * made the same NUMBER of mistakes needs the other half: how expensive they were.
 * `evMistakeForDecision` has priced that since the strategy tables were
 * generated; nothing on the server asked it until the daily entry needed it.
 *
 * Millionths of one unit wagered, as an integer, because the column it lands in
 * is a `bigint` — no floating-point column exists anywhere in the public schema,
 * and an ordering key computed in floating point can rank two identical records
 * differently on two machines.
 */
describe("what a decision cost", () => {
  it("charges nothing for playing the chart", () => {
    const state = tableAt("10S 10D 6H 7C");
    const graded = (["HIT", "STAND", "DOUBLE", "SURRENDER"] as const)
      .map((action) => gradeDecision({ mode: "solo", state, seatId: "s1", action }))
      .filter((grade) => grade.counted);

    const best = graded.find((grade) => grade.optimal);
    expect(best).toBeDefined();
    expect(best!.evLostMicros).toBe(0);
  });

  it("charges a real price for a real mistake", () => {
    const state = tableAt("10S 10D 6H 7C");
    const mistakes = (["HIT", "STAND", "DOUBLE", "SURRENDER"] as const)
      .map((action) => gradeDecision({ mode: "solo", state, seatId: "s1", action }))
      .filter((grade) => grade.counted && !grade.optimal);

    expect(mistakes.length).toBeGreaterThan(0);
    // Every wrong play costs something. A mistake priced at zero would be
    // indistinguishable from the right answer in the tie-break, which is the one
    // thing this number exists to prevent.
    for (const mistake of mistakes) {
      expect(mistake.evLostMicros).toBeGreaterThan(0);
    }
  });

  it("is always a non-negative integer", () => {
    const state = tableAt("10S 10D 6H 7C");
    for (const action of ["HIT", "STAND", "DOUBLE", "SURRENDER"] as const) {
      const grade = gradeDecision({ mode: "solo", state, seatId: "s1", action });
      expect(Number.isInteger(grade.evLostMicros)).toBe(true);
      expect(grade.evLostMicros).toBeGreaterThanOrEqual(0);
    }
  });

  it("charges nothing for a decision it did not count", () => {
    const state = tableAt("10S 10D 6H 7C");
    // A tournament decision, a timeout default and a hand the chart cannot price
    // all reach the entry as zero rather than as an unknown. Zero is right here:
    // the tie-break has to be a number, and an ungraded decision must not move
    // it in either direction.
    expect(
      gradeDecision({ mode: "tournament", state, seatId: "s1", action: "STAND" }).evLostMicros,
    ).toBe(0);
    expect(
      gradeDecision({ mode: "solo", state, seatId: "s1", action: "STAND", wasTimeout: true })
        .evLostMicros,
    ).toBe(0);
  });
});

/**
 * What a Learn or Analysis table SHOWS, which had no unit test at all.
 *
 * `adviceFor` was the whole uncovered half of this module — lines 234-291,
 * 47.76% statements against an 85% gate — and the coverage run that says so is
 * not in CI, so it had been failing unnoticed since the assistance selector
 * shipped. It is not a minor function: it decides what a player is told to do
 * before they choose, and it is the SAME advisor that then grades the choice.
 * If the two ever disagreed, a Learn table would recommend a play and mark it
 * wrong.
 *
 * The last test here is the one that matters most, and it is about integrity
 * rather than coverage: advice must be computed from the UPCARD alone. Nothing
 * else in the repository asserts that the recommendation cannot depend on the
 * hole card.
 */
describe("the recommendation a Learn table shows", () => {
  /** Hard 16 against a dealer 10 — a coordinate every chart prices. */
  const SIXTEEN_VS_TEN = "10S 10D 6H 7C";

  function advise(state: EngineState, assistance: string) {
    return adviceFor({ state, seatId: "s1", assistance });
  }

  it("says nothing at all when the session did not ask for help", () => {
    const state = tableAt(SIXTEEN_VS_TEN);
    // The two modes that do NOT put the answer on screen. `challenge` is the
    // subtle one: it is a distinct product mode and still shows nothing.
    expect(advise(state, "play")).toBeNull();
    expect(advise(state, "challenge")).toBeNull();
    expect(advise(state, "")).toBeNull();
  });

  it("answers on a learn table, from the seat's own cards and the upcard", () => {
    const advice = advise(tableAt(SIXTEEN_VS_TEN), "learn");
    expect(advice).not.toBeNull();
    expect(advice?.seatId).toBe("s1");
    expect(["HIT", "STAND", "DOUBLE", "SPLIT", "SURRENDER"]).toContain(advice?.recommended);
    // Says WHY, naming the hand and the upcard rather than only the verb.
    expect(advice?.explanation).toMatch(/against/);
  });

  /**
   * `actionEvMicros` is `analysis`-only, and integer millionths. No float
   * decides anything a player is scored on, and this is the only place in the
   * advice payload where a number could have been one.
   */
  it("prices every legal action on an analysis table, and only there", () => {
    const state = tableAt(SIXTEEN_VS_TEN);
    expect(advise(state, "learn")?.actionEvMicros).toBeNull();

    const priced = advise(state, "analysis")?.actionEvMicros;
    expect(priced).not.toBeNull();
    const entries = Object.entries(priced ?? {});
    expect(entries.length).toBeGreaterThan(0);
    for (const [action, ev] of entries) {
      expect(["HIT", "STAND", "DOUBLE", "SPLIT", "SURRENDER"]).toContain(action);
      expect(Number.isInteger(ev)).toBe(true);
    }
  });

  it("says nothing before the turns begin or after they end", () => {
    // BETTING_OPEN: no hand to advise on.
    const betting = harness({
      shoe: SIXTEEN_VS_TEN,
      seats: [{ seatId: "s1", displayName: "P", stack: 5_000 }],
    }).state;
    expect(advise(betting, "learn")).toBeNull();

    // HAND_COMPLETE: the decision has been made.
    const settled = harness({
      shoe: SIXTEEN_VS_TEN,
      seats: [{ seatId: "s1", displayName: "P", stack: 5_000 }],
    })
      .send({ type: "PLACE_BET", seatId: "s1", amount: 100 })
      .send({ type: "LOCK_BET", seatId: "s1" })
      .send({ type: "STAND", seatId: "s1" }).state;
    expect(settled.phase).toBe("HAND_COMPLETE");
    expect(advise(settled, "learn")).toBeNull();
  });

  /** Advice is addressed to whoever is ACTING. A seat that is not gets none. */
  it("says nothing to a seat whose turn it is not", () => {
    const state = tableAt(SIXTEEN_VS_TEN);
    expect(adviceFor({ state, seatId: "s2", assistance: "learn" })).toBeNull();
    expect(adviceFor({ state, seatId: "", assistance: "learn" })).toBeNull();
  });

  /**
   * THE ONE THAT IS NOT ABOUT COVERAGE.
   *
   * The recommendation must come from the seat's cards and the dealer's UPCARD
   * and nothing else. The hole card is at `dealer.cards[1]` and this function
   * has it in hand — a single index slip would silently turn Learn into an
   * oracle that reads the unrevealed card, which is the most valuable thing
   * anyone could steal from this product and would look exactly like better
   * advice.
   *
   * Asserted by changing ONLY the hole card and requiring the identical answer.
   */
  it("cannot be influenced by the hole card, because it never reads it", () => {
    /*
     * Same player hand and same upcard; the dealer's second card differs. Deal
     * order is player, dealer UP, player, dealer HOLE — so the fourth card is
     * the one under test.
     *
     * Neither hole card may make a natural. The first version of this used an
     * ace, the dealer peeked, the hand settled before anyone could act, and the
     * assertion failed on a null that was entirely correct. Two and seven both
     * leave the hand live.
     */
    const withTwo = tableAt("10S 10D 6H 2C");
    const withSeven = tableAt("10S 10D 6H 7C");

    expect(withTwo.phase).toBe("PLAYER_TURNS");
    expect(withTwo.dealer.cards[0]?.rank).toBe(withSeven.dealer.cards[0]?.rank);
    expect(withTwo.dealer.cards[1]?.rank).not.toBe(withSeven.dealer.cards[1]?.rank);

    const a = advise(withTwo, "analysis");
    const b = advise(withSeven, "analysis");
    expect(a).not.toBeNull();
    expect(a?.recommended).toBe(b?.recommended);
    expect(a?.explanation).toBe(b?.explanation);
    expect(a?.actionEvMicros).toEqual(b?.actionEvMicros);
  });
});

/**
 * The refusals both halves of this module make on a state they cannot price.
 *
 * Every one of these returns "say nothing" rather than a guess. That is the
 * contract the advisor sets — `adviseAction` answers null rather than guessing
 * — and grading has to follow it, because a grade that assumes the player was
 * wrong on a coordinate nobody priced takes credit for play they may have got
 * right.
 *
 * They are also the branches the coverage gate was missing. The gate had been
 * failing since the assistance selector shipped and nothing noticed, because
 * `npm run test:coverage` is not run by CI.
 */
describe("states neither half will price", () => {
  const SIXTEEN_VS_TEN = "10S 10D 6H 7C";

  /** Everything the engine can be sent that is not a player DECISION. */
  it("does not grade a command that is not a decision", () => {
    const state = tableAt(SIXTEEN_VS_TEN);
    for (const action of ["NEXT_HAND", "PLACE_BET", "LOCK_BET", "DECLINE_INSURANCE"]) {
      const grade = gradeDecision({
        mode: "solo",
        state,
        seatId: "s1",
        action: action as never,
      });
      expect(grade.counted).toBe(false);
      expect(grade.skipped).toBe("not-an-action");
    }
  });

  /**
   * No upcard is not a state the engine can reach during PLAYER_TURNS — it is
   * patched here deliberately. The guard exists because grading against a
   * dealer card that is not there would price a decision nobody faced, and both
   * functions must refuse rather than reach into `cards[1]`.
   */
  it("refuses when there is no dealer upcard, rather than reaching further in", () => {
    const noUpcard = harness({
      shoe: SIXTEEN_VS_TEN,
      seats: [{ seatId: "s1", displayName: "P", stack: 5_000 }],
    })
      .send({ type: "PLACE_BET", seatId: "s1", amount: 100 })
      .send({ type: "LOCK_BET", seatId: "s1" })
      .patch((state) => ({ ...state, dealer: { ...state.dealer, cards: [] } })).state;

    const grade = gradeDecision({ mode: "solo", state: noUpcard, seatId: "s1", action: "HIT" });
    expect(grade.counted).toBe(false);
    expect(grade.skipped).toBe("no-upcard");

    expect(adviceFor({ state: noUpcard, seatId: "s1", assistance: "learn" })).toBeNull();
  });

  /** A seat id that is not at this table gets no grade and no advice. */
  it("refuses a seat that is not seated here", () => {
    const state = tableAt(SIXTEEN_VS_TEN);
    const grade = gradeDecision({ mode: "solo", state, seatId: "nobody", action: "HIT" });
    expect(grade.counted).toBe(false);
    expect(grade.skipped).toBe("no-hand");
    expect(adviceFor({ state, seatId: "nobody", assistance: "analysis" })).toBeNull();
  });
});
