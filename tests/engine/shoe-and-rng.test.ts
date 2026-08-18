import { describe, expect, it } from "vitest";

import { buildDecks } from "../../shared/blackjack/cards.js";
import {
  CryptoRandomSource,
  randomIntBelow,
  SeededTestRandomSource,
  shuffleInPlace,
  CounterStreamRandomSource,
} from "../../shared/blackjack/rng.js";
import {
  approximateDecksRemaining,
  assertShoeIntegrity,
  cardsRemaining,
  computeCutIndex,
  createShoe,
  drawCard,
  needsReshuffle,
  reshuffle,
  SAFETY_RESERVE_CARDS,
  ShoeExhaustedError,
  createPreorderedShoe,
} from "../../shared/blackjack/shoe.js";
import { ARC_STANDARD_RULES, assertRulesAreCoherent } from "../../shared/blackjack/rules.js";
import { cards } from "../helpers/engine-harness.js";

const source = () => new SeededTestRandomSource(2024);

describe("deck construction", () => {
  it("builds six unique physical copies of every rank/suit", () => {
    const deck = buildDecks(6);
    expect(deck).toHaveLength(312);

    const ids = new Set(deck.map((card) => card.id));
    expect(ids.size).toBe(312);

    const aceOfSpades = deck.filter((card) => card.rank === "A" && card.suit === "S");
    expect(aceOfSpades).toHaveLength(6);
    // Same rank and suit, six distinct identities.
    expect(new Set(aceOfSpades.map((card) => card.id)).size).toBe(6);
  });

  it("rejects a non-positive deck count", () => {
    expect(() => buildDecks(0)).toThrow(/positive integer/);
    expect(() => buildDecks(1.5)).toThrow(/positive integer/);
  });
});

describe("shuffling", () => {
  it("produces a true permutation with no missing or duplicated cards", () => {
    const shoe = createShoe(ARC_STANDARD_RULES, source());
    expect(() => assertShoeIntegrity(shoe, 6)).not.toThrow();
  });

  it("actually reorders the deck", () => {
    const ordered = buildDecks(6).map((card) => card.id);
    const shuffled = createShoe(ARC_STANDARD_RULES, source()).cards.map((card) => card.id);
    expect(shuffled).not.toEqual(ordered);
    expect([...shuffled].sort()).toEqual([...ordered].sort());
  });

  it("is deterministic for a given seed", () => {
    const a = createShoe(ARC_STANDARD_RULES, new SeededTestRandomSource(7)).cards.map((c) => c.id);
    const b = createShoe(ARC_STANDARD_RULES, new SeededTestRandomSource(7)).cards.map((c) => c.id);
    expect(a).toEqual(b);
  });

  it("differs across seeds", () => {
    const a = createShoe(ARC_STANDARD_RULES, new SeededTestRandomSource(7)).cards.map((c) => c.id);
    const b = createShoe(ARC_STANDARD_RULES, new SeededTestRandomSource(8)).cards.map((c) => c.id);
    expect(a).not.toEqual(b);
  });

  it("shuffleInPlace preserves every element", () => {
    const items = Array.from({ length: 500 }, (_, i) => i);
    const shuffled = shuffleInPlace([...items], source());
    expect([...shuffled].sort((x, y) => x - y)).toEqual(items);
  });
});

describe("randomIntBelow", () => {
  it("always returns a value inside the requested range", () => {
    const rng = source();
    for (let i = 0; i < 5_000; i++) {
      const value = randomIntBelow(rng, 52);
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(52);
    }
  });

  it("returns 0 for a bound of 1 without consuming entropy", () => {
    let calls = 0;
    const counting = {
      nextUint32() {
        calls++;
        return 0;
      },
    };
    expect(randomIntBelow(counting, 1)).toBe(0);
    expect(calls).toBe(0);
  });

  it("rejects invalid bounds", () => {
    expect(() => randomIntBelow(source(), 0)).toThrow(/positive integer/);
    expect(() => randomIntBelow(source(), -3)).toThrow(/positive integer/);
  });

  it("rejects values in the biased tail rather than folding them in", () => {
    // 2^32 mod 3 == 1, so exactly one value (0xFFFFFFFF) must be rejected.
    // A biased `% 3` implementation would return 0 here instead of retrying.
    const scripted = [0xffffffff, 5];
    let index = 0;
    const rng = { nextUint32: () => scripted[index++]! };
    expect(randomIntBelow(rng, 3)).toBe(2); // 5 % 3
    expect(index).toBe(2); // proves the first draw was discarded
  });
});

describe("CryptoRandomSource", () => {
  it("produces values in the uint32 range", () => {
    const rng = new CryptoRandomSource();
    for (let i = 0; i < 1_000; i++) {
      const value = rng.nextUint32();
      expect(Number.isInteger(value)).toBe(true);
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThanOrEqual(0xffffffff);
    }
  });

  it("refuses to construct without Web Crypto rather than falling back", () => {
    const original = globalThis.crypto;
    try {
      Object.defineProperty(globalThis, "crypto", { value: undefined, configurable: true });
      expect(() => new CryptoRandomSource()).toThrow(/Refusing to fall back/);
    } finally {
      Object.defineProperty(globalThis, "crypto", { value: original, configurable: true });
    }
  });
});

describe("CounterStreamRandomSource", () => {
  it("is reproducible from the same digest stream", () => {
    const digest = (counter: number) =>
      new Uint8Array([counter, counter + 1, counter + 2, counter + 3, counter + 4, counter + 5, counter + 6, counter + 7]);
    const a = new CounterStreamRandomSource(digest);
    const b = new CounterStreamRandomSource(digest);
    const drawsA = Array.from({ length: 10 }, () => a.nextUint32());
    const drawsB = Array.from({ length: 10 }, () => b.nextUint32());
    expect(drawsA).toEqual(drawsB);
  });

  it("rejects a digest that returns too few bytes", () => {
    const rng = new CounterStreamRandomSource(() => new Uint8Array([1, 2]));
    expect(() => rng.nextUint32()).toThrow(/>= 4 bytes/);
  });
});

describe("penetration and reserve", () => {
  it("sets the cut card at the configured penetration", () => {
    expect(computeCutIndex(312, 0.75)).toBe(234);
  });

  it("does not require a reshuffle on a fresh shoe", () => {
    expect(needsReshuffle(createShoe(ARC_STANDARD_RULES, source()))).toBe(false);
  });

  it("requires a reshuffle once the cut card is reached", () => {
    const shoe = createShoe(ARC_STANDARD_RULES, source());
    expect(needsReshuffle({ ...shoe, nextIndex: shoe.cutIndex })).toBe(true);
    expect(needsReshuffle({ ...shoe, nextIndex: shoe.cutIndex - 1 })).toBe(false);
  });

  it("lets the cut card bind before the safety reserve, so stated penetration is real", () => {
    // Regression guard for the spec conflict between 75% penetration and a
    // 104-card reserve: if the reserve ever grows past the post-cut remainder
    // it silently reshuffles early and the Fair Play claim becomes false.
    const shoe = createShoe(ARC_STANDARD_RULES, source());
    const remainingAtCut = shoe.cards.length - shoe.cutIndex;
    expect(remainingAtCut).toBeGreaterThanOrEqual(SAFETY_RESERVE_CARDS);
    expect(needsReshuffle({ ...shoe, nextIndex: shoe.cutIndex - 1 })).toBe(false);
  });

  it("requires a reshuffle when the safety reserve would be breached", () => {
    const shoe = createShoe(ARC_STANDARD_RULES, source());
    // Push past the reserve while keeping nextIndex below the cut card, proving
    // the reserve is an independent trigger.
    const belowReserve = { ...shoe, cutIndex: 312, nextIndex: 312 - SAFETY_RESERVE_CARDS + 1 };
    expect(belowReserve.nextIndex).toBeLessThan(belowReserve.cutIndex);
    expect(needsReshuffle(belowReserve)).toBe(true);
  });

  it("rejects a ruleset whose reserve would pre-empt the cut card", () => {
    // One deck at 75% leaves only 13 cards — below the 52-card reserve.
    expect(() => createShoe({ ...ARC_STANDARD_RULES, deckCount: 1 }, source())).not.toThrow();
    expect(() => assertRulesAreCoherent({ ...ARC_STANDARD_RULES, deckCount: 1 })).toThrow(
      /below the 52-card safety reserve/,
    );
  });

  it("increments the shuffle number on reshuffle and restores a full shoe", () => {
    const shoe = createShoe(ARC_STANDARD_RULES, source());
    const next = reshuffle({ ...shoe, nextIndex: 300 }, ARC_STANDARD_RULES, source());
    expect(next.shuffleNumber).toBe(shoe.shuffleNumber + 1);
    expect(next.nextIndex).toBe(0);
    expect(cardsRemaining(next)).toBe(312);
    expect(() => assertShoeIntegrity(next, 6)).not.toThrow();
  });

  it("reports approximate decks remaining", () => {
    const shoe = createShoe(ARC_STANDARD_RULES, source());
    expect(approximateDecksRemaining(shoe)).toBe(6);
    expect(approximateDecksRemaining({ ...shoe, nextIndex: 156 })).toBe(3);
  });
});

describe("drawing", () => {
  it("draws strictly in order and advances the cursor", () => {
    const shoe = createPreorderedShoe(cards("AS KD 7C"));
    const first = drawCard(shoe);
    expect(first.card.rank).toBe("A");
    expect(first.shoe.nextIndex).toBe(1);

    const second = drawCard(first.shoe);
    expect(second.card.rank).toBe("K");

    // The original shoe is untouched — draws are pure.
    expect(shoe.nextIndex).toBe(0);
  });

  it("throws rather than fabricating a card when exhausted", () => {
    const shoe = createPreorderedShoe(cards("AS"));
    const after = drawCard(shoe).shoe;
    expect(() => drawCard(after)).toThrow(ShoeExhaustedError);
  });
});

describe("shoe integrity assertions", () => {
  it("detects a missing card", () => {
    const shoe = createShoe(ARC_STANDARD_RULES, source());
    const damaged = { ...shoe, cards: shoe.cards.slice(1) };
    expect(() => assertShoeIntegrity(damaged, 6)).toThrow(/312/);
  });

  it("detects a duplicated card id", () => {
    const shoe = createShoe(ARC_STANDARD_RULES, source());
    const duplicated = { ...shoe, cards: [shoe.cards[0]!, ...shoe.cards.slice(0, -1)] };
    expect(() => assertShoeIntegrity(duplicated, 6)).toThrow(/duplicate/);
  });
});
