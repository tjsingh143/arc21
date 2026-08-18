/**
 * Arc 21 — randomness.
 *
 * INVARIANT: production gameplay never uses `Math.random()`, and the production
 * random source never silently falls back to the seeded test source. A missing
 * CSPRNG is a hard failure, not a degraded mode — a quietly weak shuffle is
 * exactly the kind of defect this product promises users does not exist.
 */

export interface RandomSource {
  /** A uniformly distributed unsigned 32-bit integer. */
  nextUint32(): number;
}

/**
 * Cryptographically secure source backed by Web Crypto, which is available in
 * modern React Native (Hermes + expo-crypto polyfill), Deno/Supabase Edge
 * Functions and Node 19+. Used for local Practice and server shoes alike.
 */
export class CryptoRandomSource implements RandomSource {
  private readonly buffer = new Uint32Array(64);
  private cursor = this.buffer.length;

  constructor() {
    if (typeof globalThis.crypto?.getRandomValues !== "function") {
      throw new Error(
        "No cryptographically secure random source available. Refusing to fall " +
          "back to Math.random() for gameplay. Install a Web Crypto polyfill " +
          "(expo-crypto / react-native-get-random-values) before dealing cards.",
      );
    }
  }

  nextUint32(): number {
    // Refill in blocks; getRandomValues is comparatively expensive per call.
    if (this.cursor >= this.buffer.length) {
      globalThis.crypto.getRandomValues(this.buffer);
      this.cursor = 0;
    }
    return this.buffer[this.cursor++]!;
  }
}

/**
 * Deterministic source for the Daily Challenge, derived from a server-held
 * secret seed via an HMAC-style counter stream. Reproducible on the server for
 * auditability, unpredictable to clients (the seed stays secret until the
 * challenge closes and its commitment is revealed).
 *
 * `digest` is injected so this module stays runtime-neutral: the server passes
 * a real HMAC-SHA-256, tests can pass a stub.
 */
export class CounterStreamRandomSource implements RandomSource {
  private counter = 0;
  private block: Uint8Array = new Uint8Array(0);
  private offset = 0;

  constructor(private readonly digest: (counter: number) => Uint8Array) {}

  nextUint32(): number {
    if (this.offset + 4 > this.block.length) {
      this.block = this.digest(this.counter++);
      this.offset = 0;
      if (this.block.length < 4) {
        throw new Error("CounterStreamRandomSource digest must return >= 4 bytes");
      }
    }
    const value =
      ((this.block[this.offset]! << 24) >>> 0) +
      ((this.block[this.offset + 1]! << 16) >>> 0) +
      ((this.block[this.offset + 2]! << 8) >>> 0) +
      this.block[this.offset + 3]!;
    this.offset += 4;
    return value >>> 0;
  }
}

/**
 * TEST ONLY — a seeded mulberry32 PRNG.
 *
 * Never reachable from production code paths. It exists so engine tests can
 * assert exact card sequences. Using it for real gameplay would make the shoe
 * predictable from a 32-bit seed.
 */
export class SeededTestRandomSource implements RandomSource {
  private state: number;

  constructor(seed: number) {
    this.state = seed >>> 0;
  }

  nextUint32(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return (t ^ (t >>> 14)) >>> 0;
  }
}

/**
 * A uniformly distributed integer in [0, boundExclusive) with no modulo bias.
 *
 * Naive `next() % bound` over-weights the low values whenever `bound` does not
 * divide 2^32. Rejection sampling discards the unusable tail of the range so
 * every outcome stays equally likely.
 */
export function randomIntBelow(source: RandomSource, boundExclusive: number): number {
  if (!Number.isInteger(boundExclusive) || boundExclusive < 1) {
    throw new Error(`bound must be a positive integer, received ${boundExclusive}`);
  }
  if (boundExclusive === 1) return 0;

  const range = 0x1_0000_0000; // 2^32
  const limit = range - (range % boundExclusive);

  // Expected iterations < 2 for any bound; the loop is bounded in practice.
  for (;;) {
    const value = source.nextUint32();
    if (value < limit) {
      return value % boundExclusive;
    }
  }
}

/**
 * Unbiased Fisher-Yates. Mutates and returns `items`.
 *
 * Iterating downward and swapping with an index in [0, i] is the correct form;
 * the common "swap with any index" variant produces a non-uniform permutation.
 */
export function shuffleInPlace<T>(items: T[], source: RandomSource): T[] {
  for (let i = items.length - 1; i > 0; i--) {
    const j = randomIntBelow(source, i + 1);
    const tmp = items[i]!;
    items[i] = items[j]!;
    items[j] = tmp;
  }
  return items;
}
