/**
 * Bounded exponential backoff.
 *
 * `with-timeout.ts` stops one call waiting forever. This decides whether to
 * make the call again, and how long to wait first. The two compose: every
 * attempt is individually bounded, and the number of attempts is bounded too,
 * so the total time a caller can spend is a number that can be written down.
 *
 * Three rules shape this file.
 *
 * **Retry is a property of the FAILURE, not of the call.** The caller supplies
 * `isRetryable`, because only the caller knows whether what came back was a
 * verdict or a silence. A server that answered "that bet is below the minimum"
 * must never be asked again; a request that vanished must be. Getting this
 * backwards is how a client ends up hammering a server that is already
 * refusing it — see `RATE_LIMITED`, which is a verdict and is not retried.
 *
 * **A retry must be the SAME request, not a new one.** Nothing here mints an
 * identifier, and that is deliberate: at a table, the thing being retried is an
 * economic command whose `clientActionId` is what stops it applying twice. The
 * id belongs to the intent and must be generated before the first attempt.
 * `retryWhile` takes a thunk precisely so the caller closes over one id rather
 * than being handed a fresh attempt number to build a request from.
 *
 * **The schedule is pure and the waiting is injected.** `backoffSchedule` is a
 * function from a policy to a list of milliseconds, so the bound is asserted in
 * tests by reading it rather than by timing anything, and `retryWhile` takes
 * `sleep` and `jitter` as seams so a test never actually waits.
 */

import { CryptoRandomSource } from "../../../shared/blackjack/rng.js";

export interface BackoffPolicy {
  /** Total attempts INCLUDING the first. `1` means "no retry". */
  readonly attempts: number;
  /** The wait before the second attempt. Each later wait doubles it. */
  readonly baseDelayMs: number;
  /** The ceiling a doubled delay is clamped to. */
  readonly maxDelayMs: number;
}

/**
 * Three attempts, ~0.4s then ~0.8s apart.
 *
 * Chosen against the per-attempt bound rather than in isolation: with
 * `DEFAULT_REQUEST_TIMEOUT_MS` at 12s the worst case is 3 × 12s of silence plus
 * 1.2s of waiting — about 37 seconds before a caller gives up on a host that is
 * black-holing packets. That is the pathological case and it is why the table
 * shows a reconnecting state for the whole of it rather than a frozen screen.
 * The ordinary case — a refused connection — rejects in milliseconds, so three
 * attempts cost barely more than the 1.2s of deliberate waiting.
 *
 * More attempts would not help. If a server has not answered three times over
 * half a minute, the thing that recovers the client is the table's own poll,
 * not a fourth try inside the same command.
 */
export const DEFAULT_BACKOFF: BackoffPolicy = {
  attempts: 3,
  baseDelayMs: 400,
  maxDelayMs: 4_000,
};

/**
 * The un-jittered waits, in order, between the attempts a policy allows.
 *
 * Length is `attempts - 1`: there is no wait before the first attempt. A policy
 * of one attempt yields an empty schedule, which is the honest description of
 * "do not retry" rather than a special case elsewhere.
 */
export function backoffSchedule(policy: BackoffPolicy): readonly number[] {
  const waits: number[] = [];
  for (let index = 0; index < Math.max(0, policy.attempts - 1); index += 1) {
    waits.push(Math.min(policy.baseDelayMs * 2 ** index, policy.maxDelayMs));
  }
  return waits;
}

/**
 * The longest a `retryWhile` under this policy can spend waiting, excluding the
 * attempts themselves. Exported so a caller can state its own total bound
 * without re-deriving the arithmetic.
 */
export function totalBackoffMs(policy: BackoffPolicy): number {
  return backoffSchedule(policy).reduce((sum, wait) => sum + wait, 0);
}

/**
 * Equal jitter: half the computed wait, plus a random share of the other half.
 *
 * Five clients at one table notice the same outage in the same second, and an
 * un-jittered schedule has all five retrying in the same millisecond three
 * times over — turning a blip into a burst against a server that is already
 * struggling. Half the delay is kept fixed so a retry still has a floor.
 */
export function applyJitter(waitMs: number, roll: number): number {
  const half = waitMs / 2;
  return Math.round(half + half * roll);
}

/**
 * The default roll, from the same CSPRNG that shuffles the shoe.
 *
 * Not because a retry delay needs cryptographic randomness — it does not — but
 * because `Math.random()` appears nowhere in this product and a backoff is not
 * worth being the first exception. Constructed lazily for the reason
 * `src/features/learn/random.ts` gives: `CryptoRandomSource` refuses to exist
 * without Web Crypto, and the polyfill is installed by the root layout.
 */
let source: CryptoRandomSource | null = null;

function defaultJitterRoll(): number {
  source ??= new CryptoRandomSource();
  return source.nextUint32() / 0x1_0000_0000;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export interface RetryOptions<T> {
  readonly policy?: BackoffPolicy;
  /** Test seam. Never waits in unit tests. */
  readonly sleep?: (ms: number) => Promise<void>;
  /** Test seam. Returns a value in [0, 1). */
  readonly jitter?: () => number;
  /**
   * Called after a retryable outcome, before the wait.
   *
   * The table uses this to show "reconnecting" from the FIRST failure rather
   * than after the last one — a player watching a dead screen for thirty
   * seconds and then being told is worse than being told immediately.
   */
  readonly onRetry?: (attemptsMade: number, outcome: T) => void;
}

export interface RetryResult<T> {
  readonly value: T;
  /** How many attempts were actually made, including the successful one. */
  readonly attempts: number;
}

/**
 * Runs `attempt` until `isRetryable` says the outcome is final, or the policy
 * runs out. Returns the last outcome either way — exhausting the attempts is
 * not an error, it is the last answer received.
 */
export async function retryWhile<T>(
  attempt: () => Promise<T>,
  isRetryable: (outcome: T) => boolean,
  options: RetryOptions<T> = {},
): Promise<RetryResult<T>> {
  const policy = options.policy ?? DEFAULT_BACKOFF;
  const sleep = options.sleep ?? defaultSleep;
  const jitter = options.jitter ?? defaultJitterRoll;
  const waits = backoffSchedule(policy);

  let outcome = await attempt();
  let attempts = 1;

  for (const wait of waits) {
    if (!isRetryable(outcome)) break;
    options.onRetry?.(attempts, outcome);
    await sleep(applyJitter(wait, jitter()));
    outcome = await attempt();
    attempts += 1;
  }

  return { value: outcome, attempts };
}
