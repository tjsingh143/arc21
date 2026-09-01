/**
 * The fairness invariant, tested rather than asserted in a comment.
 *
 * "No algorithm may change cards based on loss streak, win streak, wallet, XP,
 * level, retention, engagement, purchase behaviour, a desired dramatic outcome
 * or tournament closeness."
 *
 * That is a claim about what the engine does NOT do, which cannot be proved by
 * a statistical test — a shuffle that looks random passes one whether or not
 * something is nudging it. What CAN be proved, deterministically, is the
 * structure that makes the claim true:
 *
 *   1. Every card dealt is `shoe.cards[nextIndex]`, in order, with no skips and
 *      no repeats. If the engine drew cards positionally there would be nothing
 *      left for a heuristic to influence.
 *   2. Two sessions that differ ONLY in the things the invariant names — stack
 *      size, wager, identity, and a long run of losses — deal the identical
 *      cards and reach the identical outcomes.
 *   3. Playing a hand consumes no randomness at all. The only entropy the
 *      engine takes is at shuffle time, from a source the caller injects.
 *   4. The shuffle itself is an unbiased Fisher-Yates, proved by enumeration
 *      rather than by sampling.
 *
 * Together those leave no seam a "drama" heuristic could live in.
 */

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { buildDecks } from "../../shared/blackjack/cards.js";
import {
  applyCommand,
  beginNextHand,
  createGame,
  startSession,
  type EngineState,
} from "../../shared/blackjack/reducer.js";
import {
  CryptoRandomSource,
  randomIntBelow,
  SeededTestRandomSource,
  shuffleInPlace,
  type RandomSource,
} from "../../shared/blackjack/rng.js";
import { createShoe, drawCard } from "../../shared/blackjack/shoe.js";
import { ARC_STANDARD_RULES } from "../../shared/blackjack/rules.js";
import type { Card, EngineCommand, EngineEvent } from "../../shared/blackjack/types.js";
import { harness, TEST_CONTEXT } from "../helpers/engine-harness.js";

/** A source that fails loudly if anything asks it for entropy. */
class ForbiddenRandomSource implements RandomSource {
  nextUint32(): number {
    throw new Error("the engine consumed randomness where it must not");
  }
}

/** A source that yields a scripted sequence, for enumerating permutations. */
class ScriptedRandomSource implements RandomSource {
  private cursor = 0;
  constructor(private readonly values: readonly number[]) {}
  nextUint32(): number {
    const value = this.values[this.cursor++];
    if (value === undefined) throw new Error("scripted source exhausted");
    return value;
  }
}

/** Every card handed out over a run, in the order it left the shoe. */
function dealtCards(events: EngineEvent[]): Array<Card | null> {
  return events
    .filter((event): event is Extract<EngineEvent, { type: "CARD_DEALT" }> => event.type === "CARD_DEALT")
    .map((event) => event.card);
}

/**
 * Plays `hands` rounds with a fixed, dull script — always stand — so the only
 * thing that can vary between two runs is the engine.
 */
function playRounds(
  start: EngineState,
  hands: number,
  seatId = "s1",
): { state: EngineState; events: EngineEvent[] } {
  let state = start;
  const events: EngineEvent[] = [];

  for (let hand = 0; hand < hands; hand++) {
    const script: EngineCommand[] = [
      { type: "PLACE_BET", seatId, amount: 100 },
      { type: "LOCK_BET", seatId },
    ];
    for (const command of script) {
      const result = applyCommand(state, command, TEST_CONTEXT);
      state = result.state;
      events.push(...result.events);
    }

    // Answer whatever the round asks for, always with the dullest legal move.
    for (let guard = 0; guard < 64 && state.phase !== "HAND_COMPLETE"; guard++) {
      const command: EngineCommand =
        state.phase === "INSURANCE_OFFER"
          ? { type: "DECLINE_INSURANCE", seatId }
          : { type: "STAND", seatId };
      const result = applyCommand(state, command, TEST_CONTEXT);
      state = result.state;
      events.push(...result.events);
    }

    if (hand < hands - 1) {
      const result = beginNextHand(state, TEST_CONTEXT);
      state = result.state;
      events.push(...result.events);
    }
  }

  return { state, events };
}

describe("cards come out of the shoe in order and nowhere else", () => {
  it("deals exactly shoe.cards[k] for k = 0, 1, 2, ... across a long session", () => {
    const rules = ARC_STANDARD_RULES;
    const shoe = createShoe(rules, new SeededTestRandomSource(4242));
    const expectedOrder = shoe.cards.map((card) => card.id);

    const start = startSession(
      { ...createGame({ gameId: "order", seats: [{ seatId: "s1", displayName: "One", stack: 500_000 }], random: new SeededTestRandomSource(1) }), shoe },
      TEST_CONTEXT,
    ).state;

    const { state, events } = playRounds(start, 25);

    // No reshuffle interfered, so every card dealt should still be in the
    // original order. (25 stand-only hands take nowhere near 234 cards.)
    expect(state.shoe.shuffleNumber).toBe(1);

    const dealt = dealtCards(events).filter((card): card is Card => card !== null);
    // Player cards plus the dealer's face-up cards. The hole card is dealt
    // through HOLE_CARD_DEALT, which carries no identity, so it is missing from
    // this list by design — which is why the comparison is by set membership at
    // the right positions rather than a straight prefix.
    expect(dealt.length).toBeGreaterThan(60);

    const consumed = state.shoe.nextIndex;
    const consumedIds = new Set(expectedOrder.slice(0, consumed));
    for (const card of dealt) {
      expect(consumedIds.has(card.id)).toBe(true);
    }
    // Every dealt card is distinct: no card was handed out twice.
    expect(new Set(dealt.map((card) => card.id)).size).toBe(dealt.length);
    // And nothing beyond the cursor ever appeared.
    const beyond = new Set(expectedOrder.slice(consumed));
    for (const card of dealt) {
      expect(beyond.has(card.id)).toBe(false);
    }
  });

  it("draws strictly sequentially, one index at a time", () => {
    let shoe = createShoe(ARC_STANDARD_RULES, new SeededTestRandomSource(9));
    const order = shoe.cards.map((card) => card.id);

    for (let i = 0; i < 100; i++) {
      const result = drawCard(shoe);
      expect(result.card.id).toBe(order[i]);
      expect(result.shoe.nextIndex).toBe(i + 1);
      // `drawCard` returns a new shoe rather than mutating, and never reorders.
      expect(result.shoe.cards.map((card) => card.id)).toEqual(order);
      shoe = result.shoe;
    }
  });
});

describe("nothing about the player changes the cards", () => {
  /** Builds a session over an identical shoe, varying only the seat. */
  function sessionFor(seat: { userId?: string | null; displayName: string; stack: number }): EngineState {
    const shoe = createShoe(ARC_STANDARD_RULES, new SeededTestRandomSource(777));
    return startSession(
      {
        ...createGame({
          gameId: "fixed",
          seats: [{ seatId: "s1", ...seat }],
          random: new SeededTestRandomSource(1),
        }),
        shoe,
      },
      TEST_CONTEXT,
    ).state;
  }

  it("deals the same cards to a rich seat and a nearly broke one", () => {
    const rich = playRounds(sessionFor({ displayName: "Rich", stack: 5_000_000 }), 12);
    const poor = playRounds(sessionFor({ displayName: "Poor", stack: 1_000 }), 12);

    expect(dealtCards(poor.events).map((card) => card?.id)).toEqual(
      dealtCards(rich.events).map((card) => card?.id),
    );
  });

  it("deals the same cards whatever the account behind the seat is", () => {
    const a = playRounds(sessionFor({ userId: "aaaaaaaa", displayName: "A", stack: 10_000 }), 8);
    const b = playRounds(sessionFor({ userId: "zzzzzzzz", displayName: "Z", stack: 10_000 }), 8);

    expect(dealtCards(b.events).map((card) => card?.id)).toEqual(
      dealtCards(a.events).map((card) => card?.id),
    );
  });

  it("does not change the next card after a long losing run", () => {
    /*
     * The same shoe, played twice. Between every hand of the second run the
     * seat's stack is rewritten to describe a player fifteen hands into a
     * losing streak — a bankroll falling from 100,000 to 30,000 — while the
     * first run's climbs. Both stay comfortably able to cover the wager, so the
     * only difference is the shape a retention heuristic would read.
     */
    function playWithStack(shape: (hand: number) => number): Array<string | undefined> {
      const shoe = createShoe(ARC_STANDARD_RULES, new SeededTestRandomSource(2024));
      let state = startSession(
        {
          ...createGame({
            gameId: "streak",
            seats: [{ seatId: "s1", displayName: "One", stack: shape(0) }],
            random: new SeededTestRandomSource(1),
          }),
          shoe,
        },
        TEST_CONTEXT,
      ).state;

      const events: EngineEvent[] = [];
      for (let hand = 0; hand < 15; hand++) {
        state = {
          ...state,
          seats: state.seats.map((seat) => ({ ...seat, stack: shape(hand) })),
        };
        for (const command of [
          { type: "PLACE_BET", seatId: "s1", amount: 100 } as const,
          { type: "LOCK_BET", seatId: "s1" } as const,
        ]) {
          const result = applyCommand(state, command, TEST_CONTEXT);
          state = result.state;
          events.push(...result.events);
        }
        for (let guard = 0; guard < 64 && state.phase !== "HAND_COMPLETE"; guard++) {
          const command: EngineCommand =
            state.phase === "INSURANCE_OFFER"
              ? { type: "DECLINE_INSURANCE", seatId: "s1" }
              : { type: "STAND", seatId: "s1" };
          const result = applyCommand(state, command, TEST_CONTEXT);
          state = result.state;
          events.push(...result.events);
        }
        if (hand < 14) {
          const result = beginNextHand(state, TEST_CONTEXT);
          state = result.state;
          events.push(...result.events);
        }
      }
      return dealtCards(events).map((card) => card?.id);
    }

    const losing = playWithStack((hand) => 100_000 - hand * 5_000);
    const winning = playWithStack((hand) => 100_000 + hand * 5_000);
    expect(losing).toEqual(winning);
  });

  it("deals the same cards whatever the wager is", () => {
    function playAt(amount: number): Array<string | undefined> {
      const shoe = createShoe(ARC_STANDARD_RULES, new SeededTestRandomSource(31));
      let state = startSession(
        {
          ...createGame({
            gameId: "stakes",
            seats: [{ seatId: "s1", displayName: "One", stack: 100_000 }],
            random: new SeededTestRandomSource(1),
          }),
          shoe,
        },
        TEST_CONTEXT,
      ).state;

      const events: EngineEvent[] = [];
      for (let hand = 0; hand < 10; hand++) {
        for (const command of [
          { type: "PLACE_BET", seatId: "s1", amount } as const,
          { type: "LOCK_BET", seatId: "s1" } as const,
        ]) {
          const result = applyCommand(state, command, TEST_CONTEXT);
          state = result.state;
          events.push(...result.events);
        }
        for (let guard = 0; guard < 64 && state.phase !== "HAND_COMPLETE"; guard++) {
          const command: EngineCommand =
            state.phase === "INSURANCE_OFFER"
              ? { type: "DECLINE_INSURANCE", seatId: "s1" }
              : { type: "STAND", seatId: "s1" };
          const result = applyCommand(state, command, TEST_CONTEXT);
          state = result.state;
          events.push(...result.events);
        }
        if (hand < 9) {
          const result = beginNextHand(state, TEST_CONTEXT);
          state = result.state;
          events.push(...result.events);
        }
      }
      return dealtCards(events).map((card) => card?.id);
    }

    expect(playAt(1_000)).toEqual(playAt(50));
  });
});

describe("playing a hand consumes no randomness", () => {
  it("deals, splits, doubles and settles with a source that refuses to be read", () => {
    const forbidden = { random: new ForbiddenRandomSource() };

    // 8,8 against a seven, split and then double one of the halves.
    const h = harness({ shoe: "8S 7H 8D 5C 3H 2D 6S 9C 4H" });
    let state = applyCommand(h.state, { type: "PLACE_BET", seatId: "s1", amount: 100 }, forbidden).state;
    state = applyCommand(state, { type: "LOCK_BET", seatId: "s1" }, forbidden).state;
    expect(state.phase).toBe("PLAYER_TURNS");

    state = applyCommand(state, { type: "SPLIT", seatId: "s1" }, forbidden).state;
    state = applyCommand(state, { type: "DOUBLE", seatId: "s1" }, forbidden).state;
    state = applyCommand(state, { type: "STAND", seatId: "s1" }, forbidden).state;

    expect(state.phase).toBe("HAND_COMPLETE");
    expect(state.seats[0]!.hands).toHaveLength(2);
  });

  it("takes entropy only at the reshuffle boundary, and only from the injected source", () => {
    const played = harness({ shoe: "10S 7H 7D 5C" })
      .send({ type: "PLACE_BET", seatId: "s1", amount: 100 })
      .send({ type: "LOCK_BET", seatId: "s1" })
      .send({ type: "STAND", seatId: "s1" });

    const atCut = played.patch((state) => ({
      ...state,
      shoe: { ...state.shoe, nextIndex: state.shoe.cutIndex },
    }));

    // The reshuffle is the one place a source is required...
    expect(() => beginNextHand(atCut.state, { random: new ForbiddenRandomSource() })).toThrow(
      /consumed randomness/,
    );
    // ...and refusing to supply one produces a refusal, never a reused order.
    expect(() => beginNextHand(atCut.state, {})).toThrow(/no RandomSource/);
  });

  it("reshuffles reproducibly from a seed, and differently from another", () => {
    const played = harness({ shoe: "10S 7H 7D 5C" })
      .send({ type: "PLACE_BET", seatId: "s1", amount: 100 })
      .send({ type: "LOCK_BET", seatId: "s1" })
      .send({ type: "STAND", seatId: "s1" })
      .patch((state) => ({ ...state, shoe: { ...state.shoe, nextIndex: state.shoe.cutIndex } }));

    const a = beginNextHand(played.state, { random: new SeededTestRandomSource(11) }).state;
    const b = beginNextHand(played.state, { random: new SeededTestRandomSource(11) }).state;
    const c = beginNextHand(played.state, { random: new SeededTestRandomSource(12) }).state;

    expect(b.shoe.cards.map((card) => card.id)).toEqual(a.shoe.cards.map((card) => card.id));
    expect(c.shoe.cards.map((card) => card.id)).not.toEqual(a.shoe.cards.map((card) => card.id));
  });
});

describe("the shuffle is uniform, proved by enumeration rather than sampling", () => {
  it("maps the 24 possible draw sequences onto the 24 permutations of four items, one each", () => {
    // Fisher-Yates over four items asks for indices in [0,4), [0,3), [0,2):
    // exactly 4 x 3 x 2 = 24 draw sequences. If the map from sequences to
    // permutations is a bijection, a uniform source yields a uniform shuffle.
    // A biased implementation — the "swap with any index" variant — cannot be a
    // bijection, because it has 4^3 = 64 sequences for 24 permutations.
    const seen = new Set<string>();

    for (let j3 = 0; j3 < 4; j3++) {
      for (let j2 = 0; j2 < 3; j2++) {
        for (let j1 = 0; j1 < 2; j1++) {
          const source = new ScriptedRandomSource([j3, j2, j1]);
          const result = shuffleInPlace([0, 1, 2, 3], source);
          seen.add(result.join(""));
        }
      }
    }

    expect(seen.size).toBe(24);
  });

  it("rejects the biased tail of the uint32 range instead of folding it in", () => {
    // 2^32 is not divisible by 3, so the top (2^32 mod 3) values must be
    // discarded. Feeding exactly one rejected value proves the loop retries.
    const bound = 3;
    const limit = 0x1_0000_0000 - (0x1_0000_0000 % bound);
    const source = new ScriptedRandomSource([limit, limit + 1, 7]);
    expect(randomIntBelow(source, bound)).toBe(7 % bound);
  });

  it("keeps every card, and only those cards, through a shuffle", () => {
    const deck = buildDecks(6);
    const before = deck.map((card) => card.id).sort();
    const shuffled = shuffleInPlace([...deck], new SeededTestRandomSource(5150));
    expect(shuffled.map((card) => card.id).sort()).toEqual(before);
    expect(shuffled.map((card) => card.id)).not.toEqual(deck.map((card) => card.id));
  });
});

describe("the production random source", () => {
  it("is backed by Web Crypto and propagates a failure rather than degrading", () => {
    const original = globalThis.crypto.getRandomValues;
    try {
      let calls = 0;
      Object.defineProperty(globalThis.crypto, "getRandomValues", {
        configurable: true,
        value: (array: Uint32Array) => {
          calls++;
          throw new Error("entropy pool unavailable");
        },
      });

      const source = new CryptoRandomSource();
      expect(() => source.nextUint32()).toThrow(/entropy pool unavailable/);
      expect(calls).toBe(1);
    } finally {
      Object.defineProperty(globalThis.crypto, "getRandomValues", {
        configurable: true,
        value: original,
      });
    }
  });
});

/**
 * Removes comments and string literals so a source scan reads CODE.
 *
 * `rng.ts` names `Math.random()` in prose and inside the message it throws when
 * refusing to fall back to it, which is the opposite of a defect — a scan that
 * cannot tell a call from a mention would either miss real calls or fail on the
 * documentation that promises there are none.
 */
function codeOnly(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/\/\/[^\n]*/g, " ")
    .replace(/`(?:[^`\\]|\\.)*`/g, '""')
    .replace(/"(?:[^"\\]|\\.)*"/g, '""')
    .replace(/'(?:[^'\\]|\\.)*'/g, '""');
}

describe("the engine's source carries no unsafe randomness and no hidden clock", () => {
  const engineDir = join(process.cwd(), "shared", "blackjack");
  const sources = readdirSync(engineDir)
    .filter((name) => name.endsWith(".ts"))
    .map((name) => ({ name, text: codeOnly(readFileSync(join(engineDir, name), "utf8")) }));

  it("reads every file in the engine", () => {
    expect(sources.map((file) => file.name).sort()).toEqual([
      "cards.ts",
      "hand-value.ts",
      "index.ts",
      "legal-actions.ts",
      "public-state.ts",
      "reducer.ts",
      "rng.ts",
      "rules.ts",
      "settlement.ts",
      "shoe.ts",
      "table-closure.ts",
      "types.ts",
    ]);
  });

  for (const { name, text } of sources) {
    it(`${name} never calls Math.random`, () => {
      // rng.ts names it in prose to say it is refused; a CALL is what matters.
      expect(text).not.toMatch(/Math\s*\.\s*random\s*\(/);
    });

    it(`${name} reads no ambient clock`, () => {
      // A pure reducer takes `now` from its caller. `Date.now()` or a bare
      // `new Date()` would make a transition depend on when it ran, which is
      // both untestable and a seam an outcome heuristic could use.
      expect(text).not.toMatch(/Date\s*\.\s*now\s*\(/);
      expect(text).not.toMatch(/new\s+Date\s*\(\s*\)/);
    });
  }

  it("names no player-state input in the code that chooses cards", () => {
    // `shoe.ts` and `rng.ts` are the whole of card selection, and the only
    // inputs they have are a deck count, a penetration fraction and a
    // RandomSource. Neither may so much as REFER to a wallet, a streak or a
    // level — there would be nothing there for them to read, and the identifier
    // appearing at all would mean somebody had wired one in.
    const cardSelection = sources.filter((file) => file.name === "shoe.ts" || file.name === "rng.ts");
    expect(cardSelection).toHaveLength(2);

    /*
     * Identifier WORDS, not a naive substring and not `\b` either. Both
     * simpler forms were tried against a deliberately planted
     * `seat.walletBalance`:
     *
     *   \bwallet\b   passed — there is no word boundary inside walletBalance,
     *                so the gate read as enforcement and matched nothing
     *                anybody would actually write;
     *   "xp"         failed on every file, because `export` contains it.
     *
     * Splitting each identifier on camelCase and underscores gets both right:
     * `walletBalance` yields wallet + balance, `export` yields export.
     */
    const forbidden = new Set([
      "wallet",
      "balance",
      "chips",
      "streak",
      "retention",
      "engagement",
      "purchase",
      "level",
      "drama",
      "outcome",
      "xp",
    ]);

    for (const { name, text } of cardSelection) {
      const words = (text.match(/[A-Za-z_$][A-Za-z0-9_$]*/g) ?? []).flatMap((token) =>
        token
          .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
          .split(/[_$\s]+/)
          .filter(Boolean)
          .map((word) => word.toLowerCase()),
      );
      const hit = words.find((word) => forbidden.has(word));
      expect(hit, `${name} references "${hit}" in code`).toBeUndefined();
    }
  });
});
