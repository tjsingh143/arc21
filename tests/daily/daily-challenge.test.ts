/**
 * The Daily Challenge's deterministic shoe.
 *
 * The mode's whole claim is that every ranked entrant faces the identical
 * sequence. That claim rests entirely on this stream, so it is tested for the
 * three properties that would break it: the same seed must give the same cards,
 * a different seed must give different cards, and neither must depend on anything
 * outside the seed.
 *
 * The specification also requires the stream to be cryptographic rather than the
 * simple test PRNG — `SeededTestRandomSource` would make the entire shoe
 * recoverable from 32 bits — so the last block here checks it is genuinely
 * HMAC-SHA-256 and not merely deterministic.
 */

import crypto from "node:crypto";
import { describe, expect, it } from "vitest";

import {
  commitmentMatches,
  DAILY,
  dailyScore,
  hmacCounterStream,
  isComplete,
  isRankedAttempt,
} from "../../supabase/functions/_shared/daily-challenge.js";
import {
  ARC_STANDARD_RULES,
  createShoe,
  randomIntBelow,
} from "../../shared/blackjack/index.js";

const SEED = "arc21:daily:2026-08-17:" + "a".repeat(64);
const OTHER = "arc21:daily:2026-08-18:" + "b".repeat(64);

function draw(seed: string, count: number): number[] {
  const source = hmacCounterStream(seed);
  return Array.from({ length: count }, () => source.nextUint32());
}

describe("the format matches the specification", () => {
  it("is twenty hands on five thousand challenge chips", () => {
    expect(DAILY.hands).toBe(20);
    expect(DAILY.startingStack).toBe(5_000);
    expect(DAILY.minBet).toBe(100);
    expect(DAILY.maxBet).toBe(1_000);
  });
});

describe("the same seed gives the same cards", () => {
  it("produces an identical stream on every construction", () => {
    expect(draw(SEED, 64)).toEqual(draw(SEED, 64));
  });

  it("produces an identical SHOE, which is what a player actually faces", () => {
    const first = createShoe(ARC_STANDARD_RULES, hmacCounterStream(SEED));
    const second = createShoe(ARC_STANDARD_RULES, hmacCounterStream(SEED));
    expect(first.cards.map((card) => card.id)).toEqual(second.cards.map((card) => card.id));
  });

  it("does not depend on how many values were asked for first", () => {
    // A stream that behaved differently when read in different batch sizes would
    // deal different cards to two players who split their hands differently.
    const inOneGo = draw(SEED, 40);
    const source = hmacCounterStream(SEED);
    const inPieces = [
      ...Array.from({ length: 7 }, () => source.nextUint32()),
      ...Array.from({ length: 33 }, () => source.nextUint32()),
    ];
    expect(inPieces).toEqual(inOneGo);
  });
});

describe("a different seed gives different cards", () => {
  it("diverges immediately", () => {
    expect(draw(OTHER, 32)).not.toEqual(draw(SEED, 32));
  });

  it("shuffles a different shoe", () => {
    const mine = createShoe(ARC_STANDARD_RULES, hmacCounterStream(SEED));
    const theirs = createShoe(ARC_STANDARD_RULES, hmacCounterStream(OTHER));
    expect(mine.cards.map((c) => c.id)).not.toEqual(theirs.cards.map((c) => c.id));
  });

  it("changes completely for a one-character change in the seed", () => {
    const nearly = SEED.slice(0, -1) + "b";
    expect(draw(nearly, 16)).not.toEqual(draw(SEED, 16));
  });
});

describe("the stream is cryptographic, not just deterministic", () => {
  it("is HMAC-SHA-256 over a big-endian counter", () => {
    // Recomputed independently here. If someone swaps the digest for something
    // cheaper, this fails rather than the shoe quietly becoming predictable.
    const message = new Uint8Array(8);
    new DataView(message.buffer).setBigUint64(0, 0n, false);
    const expected = crypto.createHmac("sha256", SEED).update(message).digest();

    const source = hmacCounterStream(SEED);
    const first = source.nextUint32();
    const fromDigest =
      ((expected[0]! << 24) >>> 0) +
      ((expected[1]! << 16) >>> 0) +
      ((expected[2]! << 8) >>> 0) +
      expected[3]!;
    expect(first).toBe(fromDigest >>> 0);
  });

  it("keeps going past one digest block", () => {
    // Eight uint32s exhaust a 32-byte digest, so the ninth proves the counter
    // advanced rather than the stream repeating.
    const values = draw(SEED, 16);
    expect(values.slice(0, 8)).not.toEqual(values.slice(8, 16));
  });

  it("stays uniform enough to shuffle with", () => {
    // Not a statistical test of HMAC — that is not this suite's job — but a guard
    // that the bytes reach `randomIntBelow` as a full 32-bit range rather than,
    // say, only ever the low byte.
    const source = hmacCounterStream(SEED);
    const buckets = new Array<number>(4).fill(0);
    for (let i = 0; i < 400; i += 1) buckets[randomIntBelow(source, 4)]! += 1;
    for (const count of buckets) expect(count).toBeGreaterThan(50);
  });
});

describe("the seed commitment", () => {
  it("verifies against the seed it committed to", () => {
    const commitment = crypto.createHash("sha256").update(SEED).digest("hex");
    expect(commitmentMatches(SEED, commitment)).toBe(true);
  });

  it("refuses a commitment for a different seed", () => {
    const commitment = crypto.createHash("sha256").update(OTHER).digest("hex");
    expect(commitmentMatches(SEED, commitment)).toBe(false);
  });

  it("covers the date, because the date is inside the seed", () => {
    // The specification asks for SHA-256(context + seed). The context is part of
    // the preimage, so a commitment cannot be reused for another date.
    expect(SEED.startsWith(DAILY.seedContext)).toBe(true);
    const sameRandomOtherDay = SEED.replace("2026-08-17", "2026-08-18");
    const commitment = crypto.createHash("sha256").update(SEED).digest("hex");
    expect(commitmentMatches(sameRandomOtherDay, commitment)).toBe(false);
  });
});

describe("scoring", () => {
  it("is the ending bankroll and nothing else", () => {
    expect(dailyScore({ handsPlayed: 20, finalChips: 6_400 })).toBe(6_400);
  });

  it("does not reward finishing in fewer hands", () => {
    // "Do not use completion speed as a primary skill metric." There is no time
    // or hand-count term in the score, so this asserts a property rather than a
    // check that could be removed.
    expect(dailyScore({ handsPlayed: 3, finalChips: 5_000 })).toBe(
      dailyScore({ handsPlayed: 20, finalChips: 5_000 }),
    );
  });

  it("scores a wipeout as zero rather than as a negative", () => {
    expect(dailyScore({ handsPlayed: 20, finalChips: 0 })).toBe(0);
  });
});

describe("one ranked attempt a day", () => {
  it("ranks the first attempt", () => {
    expect(isRankedAttempt(null)).toBe(true);
  });

  it("does not rank a replay after a completed attempt", () => {
    expect(isRankedAttempt({ status: "completed" })).toBe(false);
  });

  it("does not rank a replay after an ABANDONED attempt either", () => {
    // Retrying until the cards fall well is exactly what one-attempt-per-day
    // exists to prevent, so walking away does not return the slot.
    expect(isRankedAttempt({ status: "abandoned" })).toBe(false);
  });
});

describe("knowing when an attempt is over", () => {
  it("is not complete before the hand count", () => {
    expect(isComplete(19, DAILY.hands)).toBe(false);
  });

  it("is complete at the hand count", () => {
    expect(isComplete(20, DAILY.hands)).toBe(true);
  });

  it("is complete past it, so an overshoot cannot run forever", () => {
    expect(isComplete(21, DAILY.hands)).toBe(true);
  });

  it("honours the CHALLENGE's count, not the constant", () => {
    // The authoritative figure is the row's `hand_count`. A challenge minted with
    // a different length must be played to ITS length, which is why the count is
    // a parameter rather than a constant read inside.
    expect(isComplete(10, 10)).toBe(true);
    expect(isComplete(10, 25)).toBe(false);
  });
});
