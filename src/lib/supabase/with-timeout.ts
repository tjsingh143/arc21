/**
 * Bounded waiting.
 *
 * Copied in spirit from `src/features/practice/practice-store.ts`, where this
 * pattern was introduced after a native module that failed to initialise
 * returned a promise that never settled and left the table stuck on
 * "Shuffling…" forever.
 *
 * Network calls have the same failure shape and a worse one besides: a request
 * to a host that silently drops packets neither resolves nor rejects until the
 * platform's own timeout, which on mobile can be well over a minute. A rejected
 * promise is already handled by the caller's try/catch; a pending one is not.
 *
 * Every remote call in `src/features/auth` and `src/features/wallet` goes
 * through this, so "the server is unreachable" is always a state the UI can
 * render rather than a spinner with no end.
 */

/** Long enough for a cold Edge Function, short enough to still feel like an app. */
export const DEFAULT_REQUEST_TIMEOUT_MS = 12_000;

export const TIMED_OUT = Symbol("timed-out");
export type TimedOut = typeof TIMED_OUT;

/**
 * Resolves with the promise's value, or with `TIMED_OUT` after `ms`.
 *
 * Returning a sentinel rather than rejecting keeps the caller's control flow
 * explicit: a timeout is an expected outcome to be turned into a state, not an
 * exception to be caught alongside genuine programming errors.
 */
export async function withTimeout<T>(
  promise: Promise<T>,
  ms: number = DEFAULT_REQUEST_TIMEOUT_MS,
): Promise<T | TimedOut> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<TimedOut>((resolve) => {
        timer = setTimeout(() => resolve(TIMED_OUT), ms);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export function isTimedOut<T>(value: T | TimedOut): value is TimedOut {
  return value === TIMED_OUT;
}
