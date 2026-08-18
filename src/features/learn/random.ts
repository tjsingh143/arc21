/**
 * Arc 21 — the roll used to choose the next drill question.
 *
 * `Math.random()` is not used anywhere in this product, and a drill is not an
 * exception carved out for convenience: the same CSPRNG that shuffles the shoe
 * picks the next question, so there is one answer to "where does randomness come
 * from here" rather than two.
 *
 * The source is constructed lazily because `CryptoRandomSource` refuses to exist
 * without Web Crypto — the root layout installs the polyfill before any screen
 * mounts, exactly as the Practice store relies on. There is deliberately no
 * fallback: a silent downgrade is the defect this product promises does not
 * exist, and a drill is not worth introducing one for.
 */

import { CryptoRandomSource } from "../../../shared/blackjack/rng.js";

let source: CryptoRandomSource | null = null;

/** A uniformly distributed value in [0, 1). */
export function nextRoll(): number {
  source ??= new CryptoRandomSource();
  // 2^32 as the divisor keeps the result strictly below 1.
  return source.nextUint32() / 0x1_0000_0000;
}
