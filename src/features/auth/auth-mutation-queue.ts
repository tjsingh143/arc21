import { DEFAULT_REQUEST_TIMEOUT_MS, TIMED_OUT, type TimedOut } from "../../lib/supabase/with-timeout.js";

/**
 * A timed-out request still owns the mutation lock until its real response.
 * An intent that times out while queued never executes later. Human CAPTCHA
 * time is excluded from the network deadline; Cancel remains available.
 */
export function createAuthMutationQueue(timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS) {
  let tail: Promise<unknown> = Promise.resolve();
  return function run<T>(work: (human: <R>(prompt: () => Promise<R>) => Promise<R>) => Promise<T>): Promise<T | TimedOut> {
    let expired = false;
    let remaining = timeoutMs;
    let startedAt = Date.now();
    let timer: ReturnType<typeof setTimeout> | undefined;
    return new Promise<T | TimedOut>((resolve, reject) => {
      const arm = () => {
        if (expired) return;
        startedAt = Date.now();
        timer = setTimeout(() => { expired = true; resolve(TIMED_OUT); }, remaining);
      };
      const human = async <R>(prompt: () => Promise<R>): Promise<R> => {
        if (expired) throw Object.assign(new Error("Auth wait expired"), { name: "AuthRetryableFetchError" });
        clearTimeout(timer);
        remaining = Math.max(0, remaining - (Date.now() - startedAt));
        try { return await prompt(); }
        finally { arm(); }
      };
      arm();
      const actual = tail.then<T | TimedOut>(() => expired ? TIMED_OUT : work(human));
      tail = actual.catch(() => undefined);
      actual.then(resolve, reject).finally(() => clearTimeout(timer));
    });
  };
}
