/**
 * The Daily Challenge.
 *
 * Every ranked entrant faces the identical shoe. That is the entire point of the
 * mode — it removes deal luck from the comparison — and it is also what makes
 * the seed exactly as dangerous as the shoe itself: knowing it while the
 * challenge is live means knowing every card. So the seed never leaves the
 * server, its SHA-256 is published before play, and the seed itself may be
 * revealed only after the challenge closes.
 *
 * The specification is explicit that the shuffle must come from "a deterministic
 * cryptographic stream or HMAC-counter approach ... not the simple test PRNG",
 * which is what `hmacCounterStream` below builds. `SeededTestRandomSource` would
 * make the whole shoe recoverable from 32 bits.
 */

import { createHmac, createHash } from "node:crypto";

import {
  CounterStreamRandomSource,
  type RandomSource,
} from "../../../shared/blackjack/index.js";

/**
 * The format, verbatim from the specification.
 *
 * `minBet` and `maxBet` are authoritative here — they are the rules band the
 * engine is built with and appear nowhere in SQL. `hands` and `startingStack`
 * are the EXPECTED configuration: the authoritative values are the
 * `daily_challenges` row's `hand_count` and `starting_chips`, which is what the
 * server actually reads, so a challenge minted with different numbers is honoured
 * rather than overridden. `supabase/tests/16_sprint_and_daily.test.sql` pins the
 * row to these figures, so the two cannot drift silently.
 *
 * The reward is deliberately absent. It lives only on the row, is read from there
 * when it is paid, and a constant here would be a second number to keep in step
 * with nothing gained.
 */
export const DAILY = {
  hands: 20,
  startingStack: 5_000,
  minBet: 100,
  maxBet: 1_000,
  /**
   * Prefixed into the seed so the commitment commits to the date as well.
   *
   * The specification asks for `SHA-256(context + seed)`. The database's
   * `guard_daily_challenge_seed` trigger — already written and already tested —
   * verifies `seed_commitment = sha256(seed_secret)` exactly. Putting the
   * context INSIDE the secret satisfies both without a second commitment scheme:
   * the published hash covers the context because the context is part of the
   * preimage.
   */
  seedContext: "arc21:daily:",
} as const;

/**
 * The deterministic card stream for a challenge.
 *
 * `CounterStreamRandomSource` asks for a synchronous digest, so this uses
 * `node:crypto`'s HMAC rather than Web Crypto's async `subtle.sign`.
 *
 * Everything here is `Uint8Array` and `DataView`, deliberately: `Buffer` is a
 * Node global that the Supabase Edge runtime does not define, and a first
 * version written with `Buffer.alloc` typechecked, passed unit tests and then
 * failed against the real runtime with "ReferenceError: Buffer is not defined" —
 * after the session row had already been created. Typed arrays are the same in
 * both runtimes.
 *
 * The counter goes into eight big-endian bytes. Explicit byte order rather than a
 * decimal string, so the stream is defined by the bytes and cannot drift with a
 * formatting choice or a platform's endianness.
 *
 * Same seed in, same shoe out, in any process — the property the whole mode rests
 * on, asserted directly in `tests/daily/daily-challenge.test.ts`.
 */
export function hmacCounterStream(seedSecret: string): RandomSource {
  return new CounterStreamRandomSource((counter) => {
    const message = new Uint8Array(8);
    new DataView(message.buffer).setBigUint64(0, BigInt(counter), false);
    return Uint8Array.from(createHmac("sha256", seedSecret).update(message).digest());
  });
}

/**
 * The card stream for ONE shuffle of a challenge's shoe.
 *
 * THE DEFECT THIS CLOSES. The shoe was built from `hmacCounterStream(seed)` at
 * session creation and nowhere else, while `game-command` handed every command
 * `serverRandom()` — the CSPRNG. Randomness reaches the engine at exactly two
 * points, `createShoe` and `reshuffle`, and the second one is inside
 * `openBetting`: so the moment an attempt crossed the cut card, the next shoe
 * was shuffled from the CSPRNG and the two ranked entrants stopped facing the
 * same cards. Nothing would have failed — both attempts would run to twenty
 * hands and simply disagree, which is the mode's central claim quietly ceasing
 * to hold.
 *
 * At twenty hands heads-up the cut card is not reached in practice (measured;
 * see the phase report), so this was latent rather than live — but `hand_count`
 * is the CHALLENGE ROW's, constrained only to 1..100 and honoured as authored,
 * and past roughly forty hands a reshuffle becomes ordinary. A guarantee that
 * holds only because of a number nobody is checking is not a guarantee.
 *
 * Keying on the shuffle number is what makes shuffle two reproducible AND
 * different from shuffle one. Every entrant therefore faces the same stream —
 * `shuffle 1 || shuffle 2 || …` — however differently they play, which is what
 * "the same deterministic card sequence" actually means: they draw from one
 * agreed order, at whatever rate their own decisions consume it.
 */
export function dailyShoeSource(seedSecret: string, shuffleNumber: number): RandomSource {
  if (!Number.isInteger(shuffleNumber) || shuffleNumber < 1) {
    throw new Error(`shuffleNumber must be a positive integer, received ${shuffleNumber}`);
  }
  return hmacCounterStream(`${seedSecret}:shuffle:${shuffleNumber}`);
}

/** Verifies a published commitment against a revealed seed, for the audit view. */
export function commitmentMatches(seedSecret: string, commitment: string): boolean {
  return createHash("sha256").update(seedSecret).digest("hex") === commitment;
}

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

export interface DailyResult {
  handsPlayed: number;
  finalChips: number;
}

/**
 * The primary score: the ending challenge bankroll, and nothing else.
 *
 * The specification is pointed about what must NOT be in here — "do not use
 * completion speed as a primary skill metric" — so there is no time term, and no
 * hand-count term either: finishing 20 hands with 5,000 chips scores the same as
 * any other route to 5,000. Speed and accuracy are tie-breakers, applied after
 * this, never folded into it.
 */
export function dailyScore(result: DailyResult): number {
  return result.finalChips;
}

/**
 * Whether an attempt counts for the ranked leaderboard.
 *
 * One ranked attempt per UTC date. A replay is playable — practice against a
 * known shoe is useful — but it is unranked, and an unranked replay must never
 * overwrite the ranked row. Enforced here by never writing one, rather than by
 * comparing scores and hoping the comparison is the right way round.
 */
export function isRankedAttempt(existingEntry: { status: string } | null): boolean {
  if (!existingEntry) return true;
  // An abandoned attempt used up the ranked slot: retrying until the cards fall
  // well is exactly what one-attempt-per-day exists to prevent.
  return false;
}

/**
 * True once the attempt has played its full complement of hands.
 *
 * `handCount` is passed in rather than read from `DAILY`, because the
 * authoritative figure is the challenge row's and a challenge minted with a
 * different count must be honoured. `>=` rather than `===` so an overshoot ends
 * the attempt instead of running forever.
 */
export function isComplete(handsPlayed: number, handCount: number): boolean {
  return handsPlayed >= handCount;
}

/** Why an attempt stopped. Both are completions; neither is a failure. */
export type DailyCompletion = "hand_count" | "bankroll_exhausted";

/**
 * Whether the attempt is over, and why.
 *
 * THE DEFECT THIS EXISTS TO CLOSE. Only the hand count was ever checked, and a
 * challenge stack can be exhausted long before hand twenty: 5,000 chips with a
 * 1,000 ceiling is five losing hands at the maximum. Below the table minimum
 * there is no legal bet left to place — `getLegalActions` answers with no
 * actions and null bounds — and a Daily Challenge deliberately carries NO
 * CLOCKS, so no timeout can move it either. The attempt therefore sat at
 * BETTING_OPEN for ever: the entry stayed `in_progress`, no score was written,
 * no reward was paid, the player never appeared on the board, and because
 * `startDailyChallenge` resumes an in-progress attempt, that account's one
 * ranked run for the day was permanently unfinishable. Nothing failed; the
 * screen simply stopped offering anything.
 *
 * `careerBoundary` has had this branch since career sessions shipped —
 * "BANKROLL EXHAUSTION IS A COMPLETION" — and the same reasoning applies here
 * with more force, because a career node can be replayed and a ranked daily
 * attempt cannot.
 *
 * The score is unaffected either way: the specification's primary metric is the
 * ending bankroll, and an attempt that ends at zero scores zero honestly.
 */
export function attemptCompletion(params: {
  handsPlayed: number;
  handCount: number;
  finalChips: number;
  minBet: number;
}): DailyCompletion | null {
  if (isComplete(params.handsPlayed, params.handCount)) return "hand_count";
  if (params.finalChips < params.minBet) return "bankroll_exhausted";
  return null;
}
