/**
 * THE FOUR ASSISTANCE MODES.
 *
 * The mode contract is the teaching product. Get it wrong and every downstream
 * number lies: a Challenge mode that shows the answer grades reading rather
 * than recall, and the unaided accuracy figure — the headline of the whole
 * Statistics screen — stops measuring anything.
 *
 * These assert the PREDICATES the table renders from, not the functions behind
 * them. That distinction is written into this repository's own recurring-mistake
 * list: `lockBet` was written, unit-tested and correct, and wired to a control
 * nobody could press. A test that calls the function proves the function; only a
 * test of the predicate proves what a player will actually see.
 */

import { beforeEach, describe, expect, it } from "vitest";

import {
  ASSISTANCE_MODES,
  assistanceMode,
  isUnaided,
  reviewLabelFor,
  reviewTabsFor,
  showsChallengeFeedback,
  showsProbabilities,
  showsStrategyPanel,
} from "../../src/features/practice/assistance.js";
import { computeAdvice, NO_ADVICE } from "../../src/features/practice/advice.js";
import { getLegalActions } from "../../shared/blackjack/legal-actions.js";
import { MemoryKeyValueStore } from "../../src/lib/persistence/key-value-store.js";
import { PracticePersistence } from "../../src/features/practice/persistence.js";
import {
  PRACTICE_SEAT_ID,
  setPracticePersistence,
  usePracticeStore,
  type AssistanceMode,
} from "../../src/features/practice/practice-store.js";
import { EMPTY_PRACTICE_STATS } from "../../src/features/practice/practice-record.js";
import { betAndDeal, harness } from "../helpers/engine-harness.js";

const store = () => usePracticeStore.getState();

/** Real advice for a real decision: hard 16 against a dealer 10. */
function liveAdvice() {
  const table = betAndDeal(harness({ shoe: "10S 10C 6H 7D" }), 100);
  const seat = table.seat("s1");
  return computeAdvice(table.state, seat, getLegalActions(table.state, "s1").actions);
}

beforeEach(async () => {
  setPracticePersistence(new PracticePersistence(new MemoryKeyValueStore()));
  usePracticeStore.setState({
    hydrated: false,
    game: null,
    stats: { ...EMPTY_PRACTICE_STATS },
    decisionLog: [],
    handHistory: [],
    feedback: null,
    stagedBet: 0,
    lastBet: 0,
    mode: "play",
    error: null,
  });
  await store().hydrate();
});

// ---------------------------------------------------------------------------

describe("during the decision", () => {
  const advice = liveAdvice();

  it("has a real recommendation to withhold or show", () => {
    // Everything below is vacuous if the advisor had nothing to say here.
    expect(advice.recommendation).not.toBeNull();
  });

  it("PLAY shows no assistance", () => {
    expect(showsStrategyPanel("play", advice)).toBe(false);
  });

  it("CHALLENGE shows no recommendation before acting", () => {
    expect(showsStrategyPanel("challenge", advice)).toBe(false);
  });

  it("PLAY and CHALLENGE are indistinguishable while the player decides", () => {
    // If they ever differ, a Challenge grade stops measuring recall.
    expect(showsStrategyPanel("challenge", advice)).toBe(showsStrategyPanel("play", advice));
    expect(assistanceMode("challenge").revealsAnswerBeforeDecision).toBe(
      assistanceMode("play").revealsAnswerBeforeDecision,
    );
    expect(assistanceMode("challenge").showsExpectedValues).toBe(
      assistanceMode("play").showsExpectedValues,
    );
  });

  it("LEARN shows a concise recommendation, without expected values", () => {
    expect(showsStrategyPanel("learn", advice)).toBe(true);
    expect(assistanceMode("learn").showsExpectedValues).toBe(false);
  });

  it("ANALYSIS shows the two solver probabilities, and only ANALYSIS does", () => {
    /*
     * The specification asks Analysis for "validated probabilities and EV where
     * the data is legitimately available". These two are legitimately available:
     * both fall out of the same solve that produces the EVs beside them —
     * `tests/strategy/probabilities.test.ts` re-derives each by a method that
     * shares no code with the solver — so they are shown. Nothing else is, and
     * nothing is estimated at render time to fill the panel out.
     */
    expect(showsProbabilities("analysis", advice)).toBe(true);
    expect(advice.probabilities).not.toBeNull();

    // Hard 16 against a ten. A player who hits busts more often than not, and
    // the dealer breaks less than a quarter of the time — which is exactly why
    // the cell is the worst one on the chart.
    expect(advice.probabilities!.bustIfHit).toBeGreaterThan(0.5);
    expect(advice.probabilities!.dealerBust).toBeLessThan(0.25);

    for (const mode of ASSISTANCE_MODES.filter((candidate) => candidate !== "analysis")) {
      expect(showsProbabilities(mode, advice), mode).toBe(false);
    }
  });

  it("shows no probability at all when the table carries none", () => {
    // The fail-safe, one level below the recommendation. A table generated
    // before probabilities existed still serves advice; the panel simply has
    // one fewer block, rather than a number invented to fill it.
    const without = { ...advice, probabilities: null };
    expect(showsProbabilities("analysis", without)).toBe(false);
    // ...and the recommendation itself is unaffected.
    expect(showsStrategyPanel("analysis", without)).toBe(true);
  });

  it("ANALYSIS shows the recommendation and expands to expected values", () => {
    expect(showsStrategyPanel("analysis", advice)).toBe(true);
    expect(assistanceMode("analysis").showsExpectedValues).toBe(true);
    expect(advice.evs.length).toBeGreaterThan(1);
    // Best first, so the panel's "recommended" row and its top EV agree.
    expect(advice.evs[0]!.ev).toBeGreaterThanOrEqual(advice.evs[1]!.ev);
  });
});

describe("after the decision", () => {
  it("CHALLENGE grades immediately and nothing else does", () => {
    expect(showsChallengeFeedback("challenge")).toBe(true);
    for (const mode of ASSISTANCE_MODES.filter((candidate) => candidate !== "challenge")) {
      expect(showsChallengeFeedback(mode)).toBe(false);
    }
  });

  it("PLAY offers a hand history and nothing else", () => {
    // "Optional hand history only" — a graded transcript at the end of the hand
    // is coaching with a delay, which is the one thing Play must not be.
    expect(reviewTabsFor("play")).toEqual(["hands"]);
    expect(reviewTabsFor("play")).not.toContain("decisions");
    expect(reviewLabelFor("play")).toBe("Hand history");
  });

  it("ANALYSIS offers the full decision log", () => {
    expect(reviewTabsFor("analysis")).toContain("decisions");
    expect(reviewTabsFor("analysis")[0]).toBe("decisions");
    expect(reviewLabelFor("analysis")).toBe("Decision log");
  });

  it("gives every mode a review surface that is never empty of meaning", () => {
    for (const mode of ASSISTANCE_MODES) {
      expect(reviewTabsFor(mode).length).toBeGreaterThan(0);
    }
  });
});

// ---------------------------------------------------------------------------

describe("a recommendation never prevents the player choosing otherwise", () => {
  it("accepts an action the tables advise against, and grades it honestly", () => {
    store().setMode("learn");

    // Seat the store on a decision with a known right answer.
    usePracticeStore.setState({
      game: betAndDeal(
        harness({
          shoe: "10S 10C 6H 7D 5C 4D 3H 2S",
          seats: [{ seatId: PRACTICE_SEAT_ID, displayName: "You", stack: 5_000 }],
        }),
        100,
        [PRACTICE_SEAT_ID],
      ).state,
    });

    const before = store().game!;
    const seat = before.seats[0]!;
    const advice = computeAdvice(before, seat, getLegalActions(before, PRACTICE_SEAT_ID).actions);
    expect(advice.recommendation?.action).toBe("SURRENDER");

    // Play the opposite of the advice. The engine must accept it.
    store().act("HIT");

    expect(store().error).toBeNull();
    expect(store().game).not.toBe(before);
    expect(store().stats.decisions).toBe(1);
    expect(store().stats.correct).toBe(0);
    expect(store().decisionLog[0]?.chosen).toBe("HIT");
    expect(store().decisionLog[0]?.recommended).toBe("SURRENDER");
    expect(store().decisionLog[0]?.correct).toBe(false);
  });
});

// ---------------------------------------------------------------------------

describe("aided and unaided decisions are separated by the same predicate the panel uses", () => {
  const cases: { mode: AssistanceMode; unaided: boolean }[] = [
    { mode: "play", unaided: true },
    { mode: "challenge", unaided: true },
    { mode: "learn", unaided: false },
    { mode: "analysis", unaided: false },
  ];

  for (const { mode, unaided } of cases) {
    it(`${mode} counts as ${unaided ? "unaided" : "aided"}`, () => {
      expect(isUnaided(mode)).toBe(unaided);
      // The screen and the figure cannot disagree: a mode that shows the answer
      // is exactly a mode whose decisions are aided.
      expect(isUnaided(mode)).toBe(!assistanceMode(mode).revealsAnswerBeforeDecision);
    });
  }

  it("moves the unaided counter only for the modes that withhold the answer", () => {
    const play = betAndDeal(
      harness({
        shoe: "10S 10C 6H 7D 5C 4D 3H 2S 9C 8D",
        seats: [{ seatId: PRACTICE_SEAT_ID, displayName: "You", stack: 5_000 }],
      }),
      100,
      [PRACTICE_SEAT_ID],
    ).state;

    store().setMode("learn");
    usePracticeStore.setState({ game: play });
    store().act("STAND");
    expect(store().stats.decisions).toBe(1);
    expect(store().stats.unaidedDecisions).toBe(0);

    store().setMode("challenge");
    usePracticeStore.setState({ game: play });
    store().act("STAND");
    expect(store().stats.decisions).toBe(2);
    expect(store().stats.unaidedDecisions).toBe(1);
  });
});

// ---------------------------------------------------------------------------

describe("no advice at all", () => {
  it("hides the panel in every mode, including the ones that normally show it", () => {
    for (const mode of ASSISTANCE_MODES) {
      expect(showsStrategyPanel(mode, NO_ADVICE)).toBe(false);
    }
  });
});
