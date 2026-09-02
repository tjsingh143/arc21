/**
 * Checking a published seed against the commitment, ON THE DEVICE.
 *
 * The whole value of a commitment is that the player does not have to take the
 * server's word for it. A server that also answered "yes, it matches" would be
 * asking to be believed twice, so `latest_verifiable_daily_challenge` returns
 * the seed and the hash and no opinion, and this recomputes SHA-256 here.
 *
 * `expo-crypto` is the platform's own digest — CryptoKit on iOS, the JCA
 * provider on Android — for the same reason `install-crypto-polyfill.ts` uses it
 * for randomness: a hand-rolled SHA-256 in JavaScript would be a second
 * implementation of the one thing being verified.
 *
 * FAILING SAFE HERE MEANS SAYING NOTHING, not saying "verified". A digest that
 * throws — an old build, a platform without the module — answers `unavailable`,
 * and the screen says so. Reporting a match nobody computed would be worse than
 * offering no check at all.
 */

import * as ExpoCrypto from "expo-crypto";

import type { Verification, VerificationVerdict } from "./daily.js";

/**
 * Constant-time-ish comparison is deliberately NOT used.
 *
 * Both values are public: the commitment has been readable since the challenge
 * opened and the seed is published once it closes. There is no secret here for a
 * timing side channel to leak, and pretending otherwise would suggest one exists.
 */
function sameHash(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

export async function verifyCommitment(
  verification: Verification,
): Promise<VerificationVerdict> {
  try {
    const digest = await ExpoCrypto.digestStringAsync(
      ExpoCrypto.CryptoDigestAlgorithm.SHA256,
      verification.revealedSeed,
    );
    return sameHash(digest, verification.seedCommitment) ? "matches" : "does-not-match";
  } catch {
    return "unavailable";
  }
}
