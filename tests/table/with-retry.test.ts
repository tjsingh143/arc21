/**
 * Bounded exponential backoff.
 *
 * The schedule is asserted by reading it, per the module's own design note, and
 * `retryWhile` is driven with injected `sleep`/`jitter` seams so this file never
 * actually waits — a suite that really slept through three attempts of backoff
 * would cost real seconds for no more assurance than a fake clock gives for
 * free.
 */

import { describe, expect, it } from "vitest";

import {
  applyJitter,
  backoffSchedule,
  DEFAULT_BACKOFF,
  retryWhile,
  totalBackoffMs,
  type BackoffPolicy,
} from "../../src/lib/supabase/with-retry.js";

describe("backoffSchedule", () => {
  it("has one fewer wait than attempts — nothing waits before the first try", () => {
    expect(backoffSchedule(DEFAULT_BACKOFF)).toEqual([400, 800]);
  });

  it("is empty for a policy of one attempt, which is the honest 'no retry'", () => {
    const policy: BackoffPolicy = { attempts: 1, baseDelayMs: 400, maxDelayMs: 4_000 };
    expect(backoffSchedule(policy)).toEqual([]);
  });

  it("clamps a doubled delay to the ceiling rather than exceeding it", () => {
    const policy: BackoffPolicy = { attempts: 5, baseDelayMs: 1_000, maxDelayMs: 3_000 };
    // 1000, 2000, 4000->3000, 8000->3000
    expect(backoffSchedule(policy)).toEqual([1_000, 2_000, 3_000, 3_000]);
  });

  it("totals the schedule for a caller stating its own bound", () => {
    expect(totalBackoffMs(DEFAULT_BACKOFF)).toBe(1_200);
  });
});

describe("applyJitter", () => {
  it("returns exactly half the wait at roll 0 — the floor a retry never falls below", () => {
    expect(applyJitter(400, 0)).toBe(200);
  });

  it("returns the full wait at roll 1", () => {
    expect(applyJitter(400, 1)).toBe(400);
  });

  it("splits the difference at roll 0.5", () => {
    expect(applyJitter(400, 0.5)).toBe(300);
  });
});

describe("retryWhile", () => {
  it("makes exactly one attempt and never sleeps when the first outcome is final", async () => {
    let calls = 0;
    const sleeps: number[] = [];
    const result = await retryWhile(
      async () => {
        calls += 1;
        return "verdict";
      },
      () => false,
      { sleep: async (ms) => void sleeps.push(ms), jitter: () => 0 },
    );

    expect(calls).toBe(1);
    expect(sleeps).toEqual([]);
    expect(result).toEqual({ value: "verdict", attempts: 1 });
  });

  it("retries until the policy is exhausted, waiting the un-jittered schedule at roll 0", async () => {
    let calls = 0;
    const sleeps: number[] = [];
    const result = await retryWhile(
      async () => {
        calls += 1;
        return "silence";
      },
      () => true,
      {
        policy: DEFAULT_BACKOFF,
        sleep: async (ms) => void sleeps.push(ms),
        jitter: () => 0,
      },
    );

    // Three attempts total for DEFAULT_BACKOFF, waiting between each — the
    // schedule itself is asserted above, so this only checks retryWhile applies
    // it rather than re-deriving the numbers.
    expect(calls).toBe(3);
    expect(sleeps).toEqual([200, 400]); // half of [400, 800] at roll 0
    expect(result).toEqual({ value: "silence", attempts: 3 });
  });

  it("stops the moment an attempt is final, even mid-schedule", async () => {
    let calls = 0;
    const result = await retryWhile(
      async () => {
        calls += 1;
        return calls; // final on the second call
      },
      (outcome) => outcome < 2,
      { policy: DEFAULT_BACKOFF, sleep: async () => undefined, jitter: () => 0 },
    );

    expect(calls).toBe(2);
    expect(result).toEqual({ value: 2, attempts: 2 });
  });

  it("calls onRetry before each wait, with the attempt count made so far", async () => {
    const seen: Array<{ attemptsMade: number; outcome: string }> = [];
    await retryWhile(
      async () => "silence",
      () => true,
      {
        policy: DEFAULT_BACKOFF,
        sleep: async () => undefined,
        jitter: () => 0,
        onRetry: (attemptsMade, outcome) => seen.push({ attemptsMade, outcome }),
      },
    );

    // Fires after the 1st and 2nd attempts — never after the 3rd, because the
    // policy is exhausted and there is nothing left to wait for.
    expect(seen).toEqual([
      { attemptsMade: 1, outcome: "silence" },
      { attemptsMade: 2, outcome: "silence" },
    ]);
  });

  it("never calls the real clock when seams are supplied", async () => {
    // A regression guard: DEFAULT_BACKOFF's un-jittered total is 1.2s, so a
    // caller that forgot to inject `sleep` would make this test genuinely slow
    // rather than merely fail an assertion.
    const start = performance.now();
    await retryWhile(async () => "silence", () => true, {
      policy: DEFAULT_BACKOFF,
      sleep: async () => undefined,
      jitter: () => 0,
    });
    expect(performance.now() - start).toBeLessThan(100);
  });
});
