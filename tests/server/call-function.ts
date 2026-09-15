/**
 * One way to call an Edge Function from a server test.
 *
 * THE DEFECT THIS FILE CLOSES, stated precisely, because it was carried as an
 * unexplained intermittent for a whole phase.
 *
 * `game-command.integration.test.ts > the daily challenge > deals two different
 * accounts the identical shoe` failed occasionally with
 *
 *     expected [ 18 items ] to deeply equal [ 20 items ]
 *
 * — a hand-COUNT mismatch, with every visible card agreeing. It read as a
 * defect in the deterministic shoe, which is the most important claim the whole
 * mode rests on. It was not a card defect at all.
 *
 * THE EVIDENCE, from `docker logs supabase_edge_runtime_arc21`:
 *
 *     CPU time soft limit reached: isolate: 01add706-…
 *     user worker failed to respond: request cannot be handled because the
 *       worker has already retired
 *     {"message":"command handled", … "commandType":"LOCK_BET", …
 *       "outcome":"accepted","stateVersion":14}
 *     WorkerAlreadyRetired: request cannot be handled because the worker has
 *       already retired
 *
 * Read the order of those lines. The runtime retires a user worker when its
 * isolate trips the CPU soft limit; a request already in flight is then answered
 * by a worker that is gone — and the "command handled … accepted" line lands
 * BETWEEN the two. **The command committed. Only the reply was lost.** Fourteen
 * of these occurred in one day of local runs, five of them adjacent to an
 * accepted command, twice for `NEXT_HAND` — which is exactly the shape of an
 * attempt that stops two hands short with every card it did record agreeing.
 *
 * WHY RETRYING IS CORRECT HERE, AND NOT A PAPERED-OVER FAILURE. It is what
 * `src/features/table/online-table-gateway.ts` already does with a real player's
 * command: a reply it cannot read means the client "did not learn what happened
 * to its command", which is `unreachable`, and it retries — presenting THE SAME
 * `clientActionId`, so `findAppliedCommand` returns the first committed result
 * byte for byte. The test was less robust than the app it tests, and that
 * difference was the whole of the intermittent.
 *
 * So the body is replayed VERBATIM. That is load-bearing: `clientActionId` for
 * `game-command` and `clientRequestId` for `create-session` are inside it, and
 * minting a new one on retry is how a retried bet becomes two bets. Every retry
 * here is therefore also an assertion that idempotency works — if it did not,
 * these suites would start failing on doubled charges rather than passing.
 *
 * WHAT IS NOT RETRIED, so that this cannot hide a real failure:
 *
 *   - a 4xx is the server's VERDICT — 401, 403, 409, 422, 429 are the contract,
 *     and retrying one would discard the answer the test is asking for;
 *   - A 5xx CARRYING THE FUNCTION'S OWN REJECTION ENVELOPE is also a verdict.
 *     `{"status":"rejected","code":"INTERNAL", …}` is our handler saying it
 *     caught an error: the runtime did not lose the reply, the command failed.
 *     Replaying that is not recovery, it is a second go at something that just
 *     went wrong — and it is how this helper spent a phase making a REAL defect
 *     invisible. The lock-order inversion between `CASH_OUT` and
 *     `JOIN_PUBLIC_TABLE` answered `deadlock detected` as exactly this envelope
 *     on every single run, and the race test PASSED all three times because the
 *     replay succeeded once the other transaction had committed. The rule now
 *     matches the app: `online-table-gateway.ts` reads a parseable rejection —
 *     INTERNAL included — as `refused` and does not retry it, and retries only
 *     an answer it could not read. A retired worker never reaches our handler,
 *     so it cannot produce this envelope, and the intermittent this file exists
 *     for is untouched;
 *   - a 5xx that persists is returned, on the last attempt, with its body
 *     intact, so a genuinely broken function fails the test that provoked it;
 *   - a fetch that keeps throwing raises, rather than being retried into a
 *     confusing assertion about an empty body;
 *   - and every retry WARNS on stderr naming the function and the status, so an
 *     absorbed 5xx is visible in the run log instead of silent. A suite that
 *     starts warning constantly is telling you something.
 *
 * THAT LAST ONE IS WRITTEN WITH `process.stderr.write`, NOT `console.warn`, and
 * the difference is not stylistic. Vitest 4 defaults to `silent: "passed-only"`:
 * console output from a test that PASSES is collected and discarded, and shown
 * only if the test fails. A `console.warn` here would therefore be visible in
 * exactly the case where it is not needed and invisible in the case it exists
 * for — a run that passed BECAUSE something was retried. Measured, not assumed:
 * a probe test emitting both showed only the stderr write.
 */

const FUNCTIONS = "http://127.0.0.1:54321/functions/v1";

export interface CallResult {
  readonly status: number;
  readonly body: Record<string, unknown>;
  readonly raw: string;
}

/** Two retries: a retired worker is replaced immediately, not after a queue drains. */
const MAX_ATTEMPTS = 3;
const BACKOFF_MS = [100, 300];

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Straight to the descriptor — see the note on `silent: "passed-only"` above. */
function warn(message: string): void {
  process.stderr.write(`[call-function] ${message}\n`);
}

/**
 * Did the FUNCTION answer, or did the runtime?
 *
 * Only our handler writes `{"status":"rejected","code":…}`; a retired worker is
 * answered by the gateway and never reaches it. So this is the line between a
 * reply that was lost — retry it, byte for byte — and a reply that says the
 * command failed, which is a verdict to be returned to the test that asked for
 * it. Parsed rather than pattern-matched, because a `message` field could
 * otherwise quote either string back.
 */
function isOurRejection(raw: string): boolean {
  try {
    const parsed = JSON.parse(raw) as { status?: unknown; code?: unknown };
    return parsed.status === "rejected" && typeof parsed.code === "string";
  } catch {
    return false;
  }
}

/** Every suite calls this; the local stack is the only base URL they use. */
export async function callFunction(
  fn: string,
  token: string | null,
  body: unknown,
): Promise<CallResult> {
  return await callFunctionAt(FUNCTIONS, fn, token, body);
}

/**
 * The same caller against an arbitrary base URL.
 *
 * Exists so `call-function.test.ts` can point it at a stub that reproduces the
 * retired-worker sequence — a 500 and then a 200 — and prove the retry replays a
 * BYTE-IDENTICAL body. Testing that against the real stack is impossible: the
 * retirement is the runtime's decision and cannot be provoked on demand.
 */
export async function callFunctionAt(
  baseUrl: string,
  fn: string,
  token: string | null,
  body: unknown,
  /**
   * Where a retry announces itself. Defaults to stderr; `call-function.test.ts`
   * passes a collector so it can ASSERT the diagnostic rather than merely keep
   * its own deliberate 500s out of the run log.
   */
  onRetry: (message: string) => void = warn,
): Promise<CallResult> {
  // Serialised ONCE, outside the loop, so every attempt is byte-identical and
  // carries the same idempotency key.
  const payload = JSON.stringify(body);
  let lastError: unknown = null;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    try {
      const response = await fetch(`${baseUrl}/${fn}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: payload,
      });
      const raw = await response.text();

      if (response.status >= 500 && attempt < MAX_ATTEMPTS && !isOurRejection(raw)) {
        onRetry(
          `${fn} answered HTTP ${response.status} on attempt ${attempt}; ` +
            `replaying the identical body. ${raw.slice(0, 200)}`,
        );
        await wait(BACKOFF_MS[attempt - 1] ?? 300);
        continue;
      }

      let parsed: Record<string, unknown> = {};
      try {
        parsed = JSON.parse(raw) as Record<string, unknown>;
      } catch {
        parsed = {};
      }
      return { status: response.status, body: parsed, raw };
    } catch (error) {
      // A thrown fetch is the same class of answer as a 5xx: the outcome is
      // unknown. Rethrown on the last attempt so a genuinely dead stack fails
      // loudly rather than being retried into a confusing assertion.
      lastError = error;
      if (attempt === MAX_ATTEMPTS) break;
      onRetry(
        `${fn} could not be reached on attempt ${attempt}; ` +
          `replaying the identical body. ${String(error)}`,
      );
      await wait(BACKOFF_MS[attempt - 1] ?? 300);
    }
  }

  throw new Error(
    `${fn} could not be called after ${MAX_ATTEMPTS} attempts: ${String(lastError)}`,
  );
}
