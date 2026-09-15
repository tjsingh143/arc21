/**
 * The Practice record — the fold that turns engine events into statistics.
 *
 * Everything here is asserted against DETERMINISTIC fixtures, because the whole
 * claim being made is "this counter is what the engine said happened". A random
 * shoe can prove an invariant holds; only a known shoe can prove that a natural
 * was counted as a blackjack and not as an ordinary win.
 *
 * The one exception is the chip-conservation property at the bottom, which is
 * exactly the kind of claim a randomised run is right for: over hundreds of
 * hands taking every legal action, lifetime net must equal the change in the
 * player's chips, or some counter is inventing money.
 */

import { describe, expect, it } from "vitest";

import {
  chipsHeld,
  EMPTY_PRACTICE_STATS,
  foldCommand,
  type PracticeStats,
} from "../../src/features/practice/practice-record.js";
import { getLegalActions } from "../../shared/blackjack/legal-actions.js";
import { harness, type Harness } from "../helpers/engine-harness.js";
import type { EngineEvent } from "../../shared/blackjack/types.js";
import type { EngineState } from "../../shared/blackjack/reducer.js";

const SEAT = "s1";

/**
 * Drives a harness and folds every command exactly as the store does.
 *
 * The store calls `foldCommand` once per accepted command with the states either
 * side of it; anything less faithful here would be testing a different fold from
 * the one that ships.
 */
class Recorder {
  stats: PracticeStats = { ...EMPTY_PRACTICE_STATS };
  records: ReturnType<typeof foldCommand>["record"][] = [];
  private current: Harness;

  constructor(start: Harness) {
    this.current = start;
  }

  get harness(): Harness {
    return this.current;
  }

  private absorb(next: Harness, before: EngineState, events: readonly EngineEvent[]): void {
    const folded = foldCommand({
      stats: this.stats,
      before,
      after: next.state,
      events,
      seatId: SEAT,
    });
    this.stats = folded.stats;
    if (folded.record) this.records.push(folded.record);
    this.current = next;
  }

  send(command: Parameters<Harness["send"]>[0]): this {
    const before = this.current.state;
    const seen = this.current.events.length;
    const next = this.current.send(command);
    this.absorb(next, before, next.events.slice(seen));
    return this;
  }

  nextHand(): this {
    const before = this.current.state;
    const seen = this.current.events.length;
    const next = this.current.nextHand();
    this.absorb(next, before, next.events.slice(seen));
    return this;
  }

  bet(amount: number): this {
    return this.send({ type: "PLACE_BET", seatId: SEAT, amount }).send({
      type: "LOCK_BET",
      seatId: SEAT,
    });
  }
}

// ---------------------------------------------------------------------------
// Outcomes
// ---------------------------------------------------------------------------

describe("outcomes are tallied from the engine's own settlement events", () => {
  it("counts a natural as a blackjack AND as a win, never as two wins", () => {
    // Deal order: player, dealer up, player, dealer hole.
    const recorder = new Recorder(harness({ shoe: "AS 9C 10H 7D" })).bet(100);

    expect(recorder.harness.state.phase).toBe("HAND_COMPLETE");
    expect(recorder.stats.blackjacks).toBe(1);
    expect(recorder.stats.handsWon).toBe(1);
    expect(recorder.stats.handsSettled).toBe(1);
    expect(recorder.stats.handsPlayed).toBe(1);
  });

  it("counts a bust as a loss and as a bust", () => {
    const recorder = new Recorder(harness({ shoe: "10S 9C 6H 7D 10D" }))
      .bet(100)
      .send({ type: "HIT", seatId: SEAT });

    expect(recorder.stats.busts).toBe(1);
    expect(recorder.stats.handsLost).toBe(1);
    expect(recorder.stats.handsWon).toBe(0);
  });

  it("counts a push as neither a win nor a loss", () => {
    const recorder = new Recorder(harness({ shoe: "10S 10C 9H 9D" }))
      .bet(100)
      .send({ type: "STAND", seatId: SEAT });

    expect(recorder.stats.handsPushed).toBe(1);
    expect(recorder.stats.handsWon).toBe(0);
    expect(recorder.stats.handsLost).toBe(0);
    expect(recorder.stats.netChips).toBe(0);
  });

  it("counts a surrender apart from wins and losses", () => {
    // A correct surrender is not a defeat, and counting it as one would teach
    // the opposite of what this product is for.
    const recorder = new Recorder(harness({ shoe: "10S 10C 6H 7D" }))
      .bet(100)
      .send({ type: "SURRENDER", seatId: SEAT });

    expect(recorder.stats.handsSurrendered).toBe(1);
    expect(recorder.stats.surrenders).toBe(1);
    expect(recorder.stats.handsLost).toBe(0);
    expect(recorder.stats.handsWon).toBe(0);
    expect(recorder.stats.netChips).toBe(-50);
  });
});

// ---------------------------------------------------------------------------
// Two counts of "hands"
// ---------------------------------------------------------------------------

describe("rounds and settled hands are counted separately", () => {
  it("a split round is one round and two settled hands", () => {
    const recorder = new Recorder(harness({ shoe: "8S 9C 8H 7D 10D 10C" }))
      .bet(100)
      .send({ type: "SPLIT", seatId: SEAT })
      .send({ type: "STAND", seatId: SEAT })
      .send({ type: "STAND", seatId: SEAT });

    expect(recorder.harness.state.phase).toBe("HAND_COMPLETE");
    expect(recorder.stats.handsPlayed).toBe(1);
    expect(recorder.stats.handsSettled).toBe(2);
    expect(recorder.stats.splits).toBe(1);

    const total =
      recorder.stats.handsWon +
      recorder.stats.handsLost +
      recorder.stats.handsPushed +
      recorder.stats.handsSurrendered;
    expect(total).toBe(recorder.stats.handsSettled);
  });

  it("stakes the second hand of a split, so wagered chips include it", () => {
    const recorder = new Recorder(harness({ shoe: "8S 9C 8H 7D 10D 10C" }))
      .bet(100)
      .send({ type: "SPLIT", seatId: SEAT });

    expect(recorder.stats.chipsWagered).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// Doubles
// ---------------------------------------------------------------------------

describe("doubles", () => {
  it("counts the extra chips a double commits", () => {
    const recorder = new Recorder(harness({ shoe: "6S 9C 5H 7D 9D" }))
      .bet(100)
      .send({ type: "DOUBLE", seatId: SEAT });

    expect(recorder.stats.doubles).toBe(1);
    expect(recorder.stats.chipsWagered).toBe(200);
  });

  it("counts a winning double as a double win", () => {
    // 6+5 = 11, doubles into a 9 for 20; dealer stands on 16 + 2 → 16, loses.
    const recorder = new Recorder(harness({ shoe: "6S 9C 5H 7D 9D 2C" }))
      .bet(100)
      .send({ type: "DOUBLE", seatId: SEAT });

    expect(recorder.harness.hand(SEAT, 0).outcome?.kind).toBe("WIN");
    expect(recorder.stats.doubleWins).toBe(1);
  });

  it("never counts a doubled hand that busted as a double win", () => {
    const recorder = new Recorder(harness({ shoe: "10S 9C 5H 7D 10D" }))
      .bet(100)
      .send({ type: "DOUBLE", seatId: SEAT });

    expect(recorder.stats.doubles).toBe(1);
    expect(recorder.stats.busts).toBe(1);
    expect(recorder.stats.doubleWins).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Insurance
// ---------------------------------------------------------------------------

describe("insurance", () => {
  /**
   * THE CASE THAT WAS WRONG AND LOOKED RIGHT.
   *
   * When the dealer peeks and HAS a natural, the engine takes the insurance and
   * settles the whole round inside the SAME command. Reading the stake from the
   * state before that command finds zero, so adding the settlement `credit`
   * credited the player with chips they had already paid — lifetime net then
   * disagreed with the bankroll by exactly the total staked on insurance, which
   * reads as a rounding oddity rather than as a defect.
   */
  it("nets the stake against the return when the dealer has a natural", () => {
    const recorder = new Recorder(harness({ shoe: "10S AC 9H 10D" }))
      .bet(100)
      .send({ type: "INSURANCE", seatId: SEAT });

    expect(recorder.harness.state.phase).toBe("HAND_COMPLETE");
    expect(recorder.stats.insuranceTaken).toBe(1);
    // 100 wager lost, 50 staked, 150 returned: exactly even.
    expect(recorder.stats.netChips).toBe(0);
    expect(recorder.stats.chipsWagered).toBe(150);
    expect(recorder.records.at(-1)?.insuranceNet).toBe(100);
  });

  it("charges the stake when the dealer does not have a natural", () => {
    const recorder = new Recorder(harness({ shoe: "10S AC 9H 9D 8C" }))
      .bet(100)
      .send({ type: "INSURANCE", seatId: SEAT })
      .send({ type: "STAND", seatId: SEAT });

    expect(recorder.stats.insuranceTaken).toBe(1);
    // The insurance stake is gone; the hand itself is settled on its own merits.
    const handNet = recorder.harness.hand(SEAT, 0).outcome?.net ?? 0;
    expect(recorder.stats.netChips).toBe(handNet - 50);
  });
});

// ---------------------------------------------------------------------------
// Streaks
// ---------------------------------------------------------------------------

describe("round streaks", () => {
  it("runs, breaks on a push, and remembers the longest of each", () => {
    let stats: PracticeStats = { ...EMPTY_PRACTICE_STATS };

    // A REAL settled round is the template, so the fold is folding a state the
    // engine could actually produce rather than an object shaped like one.
    const settled = harness({ shoe: "10S 9C 9H 7D 8C" })
      .send({ type: "PLACE_BET", seatId: SEAT, amount: 100 })
      .send({ type: "LOCK_BET", seatId: SEAT })
      .send({ type: "STAND", seatId: SEAT }).state;
    expect(settled.phase).toBe("HAND_COMPLETE");

    const settle = (net: number) => {
      stats = foldCommand({
        stats,
        before: { ...settled, phase: "PLAYER_TURNS" },
        after: {
          ...settled,
          seats: [
            {
              ...settled.seats[0]!,
              hands: [
                { ...settled.seats[0]!.hands[0]!, outcome: { kind: "WIN", credit: 0, net } },
              ],
            },
          ],
        },
        events: [],
        seatId: SEAT,
      }).stats;
    };

    settle(100);
    settle(100);
    expect(stats.currentWinStreak).toBe(2);
    expect(stats.longestWinStreak).toBe(2);

    settle(0);
    expect(stats.currentWinStreak).toBe(0);

    settle(-100);
    settle(-100);
    settle(-100);
    expect(stats.currentWinStreak).toBe(-3);
    expect(stats.longestLossStreak).toBe(3);
    expect(stats.longestWinStreak).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Hand history
// ---------------------------------------------------------------------------

describe("the hand history", () => {
  it("records totals and outcomes, and no cards at all", () => {
    const recorder = new Recorder(harness({ shoe: "10S 9C 9H 7D 8C" }))
      .bet(100)
      .send({ type: "STAND", seatId: SEAT });

    const record = recorder.records.at(-1);
    expect(record).toBeDefined();
    expect(record!.playerTotals).toEqual([19]);
    // The dealer holds 9,7 and must draw: 8 takes them to 24.
    expect(record!.dealerTotal).toBe(24);
    expect(record!.dealerBusted).toBe(true);
    expect(record!.outcomes).toEqual(["WIN"]);
    expect(record!.wagered).toBe(100);
    expect(record!.net).toBe(100);

    // A card list is shoe information wearing a different hat. Nothing on the
    // record may carry one, whatever it is called.
    const serialised = JSON.stringify(record);
    expect(serialised).not.toMatch(/"rank"/);
    expect(serialised).not.toMatch(/"suit"/);
    expect(serialised).not.toMatch(/"cards"/);
  });

  it("produces exactly one record per settled round", () => {
    const recorder = new Recorder(harness({ shoe: "10S 9C 9H 7D 8C 10D 5S 6H 4C" }))
      .bet(100)
      .send({ type: "STAND", seatId: SEAT })
      .nextHand()
      .bet(100)
      .send({ type: "STAND", seatId: SEAT });

    expect(recorder.records).toHaveLength(2);
    expect(recorder.stats.handsPlayed).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// The property that catches a counter inventing money
// ---------------------------------------------------------------------------

describe("chip conservation", () => {
  it("lifetime net equals the change in chips over 200 randomised hands", () => {
    let current = harness({
      shoe: "5C 6D 7H 8S 9C",
      pad: Array.from({ length: 300 }, () => "2C 3D 4H 5S 6C 7D 8H 9S 10C AD").join(" "),
      seats: [{ seatId: SEAT, displayName: "Tester", stack: 100_000 }],
    });
    let stats: PracticeStats = { ...EMPTY_PRACTICE_STATS };
    const opening = chipsHeld(current.state, SEAT);

    // A seeded walk, so a failure is reproducible.
    let seed = 20260824;
    const next = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed / 2147483648;
    };

    const drive = (run: () => Harness) => {
      const before = current.state;
      const seen = current.events.length;
      const after = run();
      stats = foldCommand({
        stats,
        before,
        after: after.state,
        events: after.events.slice(seen),
        seatId: SEAT,
      }).stats;
      current = after;
    };

    for (let round = 0; round < 200; round += 1) {
      if (current.state.phase === "HAND_COMPLETE") drive(() => current.nextHand());
      if ((current.state.phase as string) !== "BETTING_OPEN") break;

      drive(() => current.send({ type: "PLACE_BET", seatId: SEAT, amount: 100 }));
      drive(() => current.send({ type: "LOCK_BET", seatId: SEAT }));

      let guard = 0;
      // Read through a widened local: `drive` reassigns `current` inside a
      // closure, so the compiler's narrowing of the previous check does not
      // survive the call and would otherwise reject every comparison below.
      let phase: string = current.state.phase;
      while (phase !== "HAND_COMPLETE" && guard < 40) {
        guard += 1;
        if (phase === "INSURANCE_OFFER") {
          const take = next() < 0.5;
          drive(() =>
            current.send({ type: take ? "INSURANCE" : "DECLINE_INSURANCE", seatId: SEAT }),
          );
          phase = current.state.phase;
          continue;
        }
        if (phase !== "PLAYER_TURNS") break;

        // Every action the engine offers, chosen at random — doubles, splits
        // and surrenders included, because those are the ones that move chips
        // in ways a naive counter gets wrong.
        const legal = getLegalActions(current.state, SEAT).actions as readonly string[];
        if (legal.length === 0) break;
        const action = legal[Math.floor(next() * legal.length)]!;
        drive(() => current.send({ type: action, seatId: SEAT } as never));
        phase = current.state.phase;
      }
    }

    expect(stats.handsPlayed).toBeGreaterThan(50);
    expect(chipsHeld(current.state, SEAT) - opening).toBe(stats.netChips);

    // And the breakdown must add up to the total it is a breakdown of.
    expect(
      stats.handsWon + stats.handsLost + stats.handsPushed + stats.handsSurrendered,
    ).toBe(stats.handsSettled);
    expect(stats.blackjacks).toBeLessThanOrEqual(stats.handsWon);
    expect(stats.busts).toBeLessThanOrEqual(stats.handsLost);
    expect(stats.doubleWins).toBeLessThanOrEqual(stats.doubles);
    expect(stats.maxBankroll).toBeGreaterThanOrEqual(chipsHeld(current.state, SEAT));
  });
});
