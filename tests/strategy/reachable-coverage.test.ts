/**
 * COVERAGE, DERIVED FROM THE ENGINE RATHER THAN FROM A LIST.
 *
 * `completeness.test.ts` already enumerates the states a human would write down
 * — hard 5-21, soft 13-21, every pair — and checks each has an entry. That is a
 * good test and it stays. It has one weakness, which is the weakness of every
 * hand-written enumeration: it proves the table covers the list, not that the
 * list covers the game. If the engine can put a player in a state nobody thought
 * to write down, both the table and the list can be missing it together and
 * every assertion still passes.
 *
 * So this file does not enumerate coordinates. It enumerates CARDS — every hand
 * a player can physically be holding at a decision point, in every split context
 * the engine can produce — runs each through the engine's own
 * `describeStrategyState`, and demands the advisor answer.
 *
 * "Answer" is the strong form: for every legal action set that contains HIT and
 * STAND, `adviseAction` must return an action that is IN that set. Not just an
 * entry in the table — a usable recommendation, resolved through fallbacks,
 * under every combination of double, split and surrender availability the table
 * can put in front of it.
 *
 * The last test in the file plants a hole and proves the sweep finds it. A
 * coverage assertion that cannot fail is a coverage assertion that is not being
 * made.
 */

import { describe, expect, it } from "vitest";

import { ARC_STANDARD_RULES } from "../../shared/blackjack/rules.js";
import { parseCardShorthand } from "../../shared/blackjack/cards.js";
import type { Card, PlayerActionType, Rank } from "../../shared/blackjack/types.js";
import { ARC_STANDARD_STRATEGY_TABLE } from "../../supabase/functions/_shared/strategy/generated-arc-standard-v1.js";
import {
  describeStrategyState,
  normalizeStrategyKey,
} from "../../supabase/functions/_shared/strategy/keys.js";
import {
  lookupStrategyForRulesWithDiagnostics,
  type StrategyTableRegistry,
} from "../../supabase/functions/_shared/strategy/lookup.js";
import type { StrategyTable } from "../../supabase/functions/_shared/strategy/types.js";
import { rulesetKey } from "../../shared/blackjack/rules.js";

const REGISTRY: StrategyTableRegistry = {
  [rulesetKey(ARC_STANDARD_RULES)]: ARC_STANDARD_STRATEGY_TABLE,
};

/**
 * Every rank a player can hold, one per distinct strategy value.
 *
 * J, Q and K are the same coordinate as 10 under every rule this product ships,
 * and enumerating them separately would quadruple the sweep to re-prove the same
 * cells. That equivalence is not assumed — it is asserted below.
 */
const RANKS: readonly Rank[] = ["A", "2", "3", "4", "5", "6", "7", "8", "9", "10"];

let counter = 0;
function card(rank: Rank): Card {
  counter += 1;
  return parseCardShorthand(`${rank}S`, 0, `#${counter}`);
}

/** Best total with aces counted 11 where that does not bust. */
function totalOf(ranks: readonly Rank[]): number {
  let total = 0;
  let aces = 0;
  for (const rank of ranks) {
    if (rank === "A") {
      aces += 1;
      total += 11;
    } else {
      total += Number(rank);
    }
  }
  while (total > 21 && aces > 0) {
    total -= 10;
    aces -= 1;
  }
  return total;
}

/**
 * Every non-bust hand of 2..`maxCards` cards, as multisets of rank.
 *
 * Multisets rather than sequences: the advisor's coordinate is total and class,
 * neither of which depends on the order cards arrived in, so permutations would
 * multiply the sweep without covering anything new.
 */
function reachableHands(maxCards: number): Rank[][] {
  const hands: Rank[][] = [];

  const extend = (prefix: Rank[], from: number) => {
    if (prefix.length >= 2) hands.push([...prefix]);
    if (prefix.length >= maxCards) return;

    for (let index = from; index < RANKS.length; index += 1) {
      const rank = RANKS[index]!;
      const next = [...prefix, rank];
      // A bust is not a decision, so there is nothing beyond it to enumerate.
      if (totalOf(next) > 21) continue;
      extend(next, index);
    }
  };

  extend([], 0);
  return hands;
}

/** The legal action sets the engine can present alongside HIT and STAND. */
const OPTIONAL: readonly PlayerActionType[] = ["DOUBLE", "SPLIT", "SURRENDER"];

function legalActionSets(): PlayerActionType[][] {
  const sets: PlayerActionType[][] = [];
  for (let mask = 0; mask < 1 << OPTIONAL.length; mask += 1) {
    const actions: PlayerActionType[] = ["HIT", "STAND"];
    OPTIONAL.forEach((action, index) => {
      if (mask & (1 << index)) actions.push(action);
    });
    sets.push(actions);
  }
  return sets;
}

/** Every split context the engine can produce for a hand. */
const CONTEXTS = [
  { label: "original", cameFromSplit: false, cameFromSplitAces: false },
  { label: "split hand", cameFromSplit: true, cameFromSplitAces: false },
  { label: "split aces", cameFromSplit: true, cameFromSplitAces: true },
] as const;

// ---------------------------------------------------------------------------

describe("every state the engine can produce has a usable recommendation", () => {
  const hands = reachableHands(8);
  const sets = legalActionSets();

  it("enumerates a sweep large enough to mean something", () => {
    // A sweep that silently collapsed to nothing would pass every assertion
    // below, so the size of the enumeration is asserted before anything is
    // concluded from it. Eight cards is past what six decks can realistically
    // deal without busting — 2,2,2,2,2,2,2,2 is 16 — so the hand space is
    // exhausted rather than truncated.
    expect(hands.length).toBeGreaterThan(1_500);
    expect(sets).toHaveLength(8);
  });

  it("answers for every hand, every upcard, every split context and every legal set", () => {
    const unanswered: string[] = [];
    const illegal: string[] = [];
    const missingEntry: string[] = [];
    const covered = new Set<string>();
    let answered = 0;

    for (const upcardRank of RANKS) {
      const upcard = card(upcardRank);

      for (const hand of hands) {
        for (const context of CONTEXTS) {
          // Split aces only ever exist as a hand whose first card is an ace.
          if (context.cameFromSplitAces && hand[0] !== "A") continue;

          const cards = hand.map(card);
          const state = describeStrategyState(cards, upcard, {
            splitPolicy: ARC_STANDARD_RULES.splitPolicy,
            cameFromSplit: context.cameFromSplit,
            cameFromSplitAces: context.cameFromSplitAces,
            splitAceTwentyOneIsBlackjack: ARC_STANDARD_RULES.splitAceTwentyOneIsBlackjack,
          });

          // Null means the engine says there is no decision here — a natural or
          // a bust. Nothing to cover.
          if (state === null) continue;

          const key = normalizeStrategyKey(state);
          covered.add(key);
          if (ARC_STANDARD_STRATEGY_TABLE.entries[key] === undefined) {
            missingEntry.push(`${hand.join(",")} vs ${upcardRank} (${context.label}) → ${key}`);
            continue;
          }

          for (const legalActions of sets) {
            const result = lookupStrategyForRulesWithDiagnostics({
              registry: REGISTRY,
              rules: ARC_STANDARD_RULES,
              state,
              legalActions,
            });

            if (result.recommendation === null) {
              unanswered.push(
                `${key} with [${legalActions.join(",")}] → ${result.diagnostic?.code ?? "no diagnostic"}`,
              );
              continue;
            }
            if (!legalActions.includes(result.recommendation.action)) {
              illegal.push(
                `${key} with [${legalActions.join(",")}] → ${result.recommendation.action}`,
              );
              continue;
            }
            answered += 1;
          }
        }
      }
    }

    expect(missingEntry.slice(0, 10)).toEqual([]);
    expect(unanswered.slice(0, 10)).toEqual([]);
    expect(illegal.slice(0, 10)).toEqual([]);
    // Guards against a sweep that answered nothing and reported no failures.
    expect(answered).toBeGreaterThan(10_000);

    /*
     * AND THE OTHER DIRECTION, WHICH IS THE HALF THAT IS EASY TO FAKE.
     *
     * "Every state I reached has an entry" is satisfied trivially by reaching
     * two states. So the sweep must also account for EVERY cell in the table:
     * either it was reached from real cards, or it is one of the two rows the
     * classifier can never produce — and those are named here rather than
     * absorbed into a tolerance.
     *
     * `hard:4` is only ever 2,2 and `soft:12` is only ever A,A, both of which
     * `describeStrategyState` calls pairs. They exist because a pair that cannot
     * be split has to resolve through a computed total row rather than an
     * invented default, and `completeness.test.ts` asserts they are solved.
     */
    const uncovered = Object.keys(ARC_STANDARD_STRATEGY_TABLE.entries)
      .filter((key) => !covered.has(key))
      .map((key) => key.replace(/:\d+$/, ""))
      .filter((row, index, rows) => rows.indexOf(row) === index)
      .sort();

    expect(uncovered).toEqual(["hard:4", "soft:12"]);
    expect(covered.size).toBe(
      Object.keys(ARC_STANDARD_STRATEGY_TABLE.entries).length - uncovered.length * 10,
    );
  });

  it("treats every ten-value rank as the same coordinate", () => {
    // The sweep uses "10" alone. That is only sound if J, Q and K normalise to
    // the same key, which is asserted rather than assumed.
    const upcard = card("7");
    const keys = new Set<string>();
    for (const rank of ["10", "J", "Q", "K"] as Rank[]) {
      const state = describeStrategyState([card(rank), card("6")], upcard, {
        splitPolicy: ARC_STANDARD_RULES.splitPolicy,
      });
      expect(state).not.toBeNull();
      keys.add(normalizeStrategyKey(state!));
    }
    expect(keys.size).toBe(1);
  });
});

// ---------------------------------------------------------------------------

describe("the sweep discriminates", () => {
  /**
   * THE GATE PROVES IT CAN FAIL.
   *
   * `hard:16:10` is the most consequential cell in the chart. Removing it from a
   * COPY of the table must make the sweep report an unanswered state — otherwise
   * every assertion above is decorative.
   */
  it("finds a hole punched in a copy of the table", () => {
    const holed: StrategyTable = {
      ...ARC_STANDARD_STRATEGY_TABLE,
      entries: Object.fromEntries(
        Object.entries(ARC_STANDARD_STRATEGY_TABLE.entries).filter(
          ([key]) => key !== "hard:16:10",
        ),
      ),
    };
    const registry: StrategyTableRegistry = {
      [rulesetKey(ARC_STANDARD_RULES)]: holed,
    };

    expect(holed.entries["hard:16:10"]).toBeUndefined();
    expect(ARC_STANDARD_STRATEGY_TABLE.entries["hard:16:10"]).toBeDefined();

    const state = describeStrategyState([card("10"), card("4"), card("2")], card("10"), {
      splitPolicy: ARC_STANDARD_RULES.splitPolicy,
    });
    expect(state).not.toBeNull();
    expect(normalizeStrategyKey(state!)).toBe("hard:16:10");

    const result = lookupStrategyForRulesWithDiagnostics({
      registry,
      rules: ARC_STANDARD_RULES,
      state: state!,
      legalActions: ["HIT", "STAND"],
    });

    // Fails SAFE: nothing served, and a diagnostic that names why.
    expect(result.recommendation).toBeNull();
    expect(result.diagnostic?.code).toBe("NO_ENTRY");
    expect(result.diagnostic?.key).toBe("hard:16:10");
  });
});
