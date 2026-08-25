/**
 * THE THIRD HALF OF FAILING SAFE, TESTED.
 *
 * When the tables cannot answer, three things must happen: play continues, the
 * recommendation is hidden, and the reason is RECORDED. The first two are
 * asserted elsewhere. This file is the third, and it exists because the module
 * that does the recording was, until now, exercised only incidentally through
 * one call site — which is a strange place for the evidence-keeping code to be,
 * since the whole reason it exists is that a silent failure had once been
 * indistinguishable from success.
 *
 * The properties that matter are all about NOT losing evidence and NOT becoming
 * noise: a hole hit a thousand times is one record with a count of a thousand,
 * a sink at its cap keeps the holes still being hit rather than the ones that
 * stopped, and a listener hears about a hole once rather than once per hand.
 * Each is easy to get subtly wrong and none of them would produce a visible
 * symptom.
 */

import { beforeEach, describe, expect, it } from "vitest";

import {
  describeStrategyDiagnostic,
  MAX_STRATEGY_DIAGNOSTICS,
  onStrategyDiagnostic,
  recordStrategyDiagnostic,
  resetStrategyDiagnostics,
  strategyDiagnosticCount,
  strategyDiagnostics,
  type StrategyDiagnosticRecord,
} from "../../src/features/practice/strategy-diagnostics.js";

const BASE = {
  code: "NO_ENTRY" as const,
  key: "hard:16:10",
  rulesetId: "arc-standard",
  rulesetVersion: 1,
};

beforeEach(() => {
  resetStrategyDiagnostics();
});

// ---------------------------------------------------------------------------

describe("recording", () => {
  it("starts empty, so an absence of diagnostics means something", () => {
    expect(strategyDiagnostics()).toEqual([]);
    expect(strategyDiagnosticCount()).toBe(0);
  });

  it("keeps the reason, the coordinate and the ruleset", () => {
    const record = recordStrategyDiagnostic({ ...BASE, at: 1_000 });
    expect(record).toEqual({
      code: "NO_ENTRY",
      key: "hard:16:10",
      rulesetId: "arc-standard",
      rulesetVersion: 1,
      count: 1,
      lastSeenAt: 1_000,
    });
  });

  it("counts repeats instead of accumulating duplicates", () => {
    for (let hand = 0; hand < 1_000; hand += 1) {
      recordStrategyDiagnostic({ ...BASE, at: hand });
    }
    const all = strategyDiagnostics();
    expect(all).toHaveLength(1);
    expect(all[0]!.count).toBe(1_000);
    expect(all[0]!.lastSeenAt).toBe(999);
    expect(strategyDiagnosticCount()).toBe(1_000);
  });

  it("separates diagnostics that differ in any part of their identity", () => {
    recordStrategyDiagnostic({ ...BASE, at: 1 });
    recordStrategyDiagnostic({ ...BASE, key: "soft:18:9", at: 2 });
    recordStrategyDiagnostic({ ...BASE, code: "NO_TABLE", at: 3 });
    recordStrategyDiagnostic({ ...BASE, rulesetVersion: 2, at: 4 });
    recordStrategyDiagnostic({ ...BASE, rulesetId: "vegas", at: 5 });
    expect(strategyDiagnostics()).toHaveLength(5);
    expect(strategyDiagnosticCount()).toBe(5);
  });

  it("records a malformed state under a key of its own rather than dropping it", () => {
    // INVALID_STATE has no coordinate to name. Losing it would hide the one
    // diagnostic that says the caller, not the table, is wrong.
    const record = recordStrategyDiagnostic({
      ...BASE,
      code: "INVALID_STATE",
      key: null,
      at: 7,
    });
    expect(record.key).toBeNull();
    expect(strategyDiagnostics()).toHaveLength(1);

    recordStrategyDiagnostic({ ...BASE, code: "INVALID_STATE", key: null, at: 8 });
    expect(strategyDiagnostics()[0]!.count).toBe(2);
  });

  it("orders most recently seen first", () => {
    recordStrategyDiagnostic({ ...BASE, key: "hard:12:2", at: 10 });
    recordStrategyDiagnostic({ ...BASE, key: "hard:13:3", at: 30 });
    recordStrategyDiagnostic({ ...BASE, key: "hard:14:4", at: 20 });
    expect(strategyDiagnostics().map((record) => record.key)).toEqual([
      "hard:13:3",
      "hard:14:4",
      "hard:12:2",
    ]);
  });
});

// ---------------------------------------------------------------------------

describe("the cap keeps the holes that are still being hit", () => {
  it("never grows past the cap however many distinct holes appear", () => {
    for (let index = 0; index < MAX_STRATEGY_DIAGNOSTICS * 4; index += 1) {
      recordStrategyDiagnostic({ ...BASE, key: `hard:${index}:10`, at: index });
    }
    expect(strategyDiagnostics()).toHaveLength(MAX_STRATEGY_DIAGNOSTICS);
  });

  it("evicts the least recently SEEN, not the least recently added", () => {
    // The distinction is the whole design. `stale` is added first and then
    // touched again at the end; a first-in-first-out cache would drop it, and
    // it is precisely the hole a player is still walking into.
    recordStrategyDiagnostic({ ...BASE, key: "stale", at: 1 });
    for (let index = 0; index < MAX_STRATEGY_DIAGNOSTICS - 1; index += 1) {
      recordStrategyDiagnostic({ ...BASE, key: `filler-${index}`, at: 100 + index });
    }
    // Touch the first one so it becomes the most recent.
    recordStrategyDiagnostic({ ...BASE, key: "stale", at: 10_000 });

    // Now overflow by one. The victim must be the oldest filler, not `stale`.
    recordStrategyDiagnostic({ ...BASE, key: "newcomer", at: 10_001 });

    const keys = strategyDiagnostics().map((record) => record.key);
    expect(keys).toHaveLength(MAX_STRATEGY_DIAGNOSTICS);
    expect(keys).toContain("stale");
    expect(keys).toContain("newcomer");
    expect(keys).not.toContain("filler-0");
  });

  it("keeps the surviving records' counts intact through an eviction", () => {
    recordStrategyDiagnostic({ ...BASE, key: "busy", at: 1 });
    recordStrategyDiagnostic({ ...BASE, key: "busy", at: 2 });
    recordStrategyDiagnostic({ ...BASE, key: "busy", at: 3 });
    for (let index = 0; index < MAX_STRATEGY_DIAGNOSTICS * 2; index += 1) {
      recordStrategyDiagnostic({ ...BASE, key: `other-${index}`, at: 1_000 + index });
    }
    const busy = strategyDiagnostics().find((record) => record.key === "busy");
    // `busy` was evicted — it is genuinely the least recently seen — and the
    // total no longer counts it. That is the honest consequence of a bounded
    // sink, and it is asserted rather than assumed not to happen.
    expect(busy).toBeUndefined();
    expect(strategyDiagnostics()).toHaveLength(MAX_STRATEGY_DIAGNOSTICS);
  });
});

// ---------------------------------------------------------------------------

describe("listeners hear about a hole once", () => {
  it("fires on the first sighting only", () => {
    const seen: StrategyDiagnosticRecord[] = [];
    const stop = onStrategyDiagnostic((record) => seen.push(record));

    for (let hand = 0; hand < 50; hand += 1) {
      recordStrategyDiagnostic({ ...BASE, at: hand });
    }

    expect(seen).toHaveLength(1);
    expect(seen[0]!.key).toBe("hard:16:10");
    expect(seen[0]!.count).toBe(1);
    stop();
  });

  it("fires again for a genuinely different hole", () => {
    const seen: string[] = [];
    const stop = onStrategyDiagnostic((record) => seen.push(record.key ?? "-"));
    recordStrategyDiagnostic({ ...BASE, key: "a", at: 1 });
    recordStrategyDiagnostic({ ...BASE, key: "a", at: 2 });
    recordStrategyDiagnostic({ ...BASE, key: "b", at: 3 });
    expect(seen).toEqual(["a", "b"]);
    stop();
  });

  it("stops when unsubscribed, and does not disturb other listeners", () => {
    const first: string[] = [];
    const second: string[] = [];
    const stopFirst = onStrategyDiagnostic((record) => first.push(record.key ?? "-"));
    const stopSecond = onStrategyDiagnostic((record) => second.push(record.key ?? "-"));

    recordStrategyDiagnostic({ ...BASE, key: "one", at: 1 });
    stopFirst();
    recordStrategyDiagnostic({ ...BASE, key: "two", at: 2 });

    expect(first).toEqual(["one"]);
    expect(second).toEqual(["one", "two"]);
    stopSecond();
  });
});

// ---------------------------------------------------------------------------

describe("the log line carries nothing private", () => {
  it("names the reason, the coordinate and the ruleset, and nothing else", () => {
    const record = recordStrategyDiagnostic({ ...BASE, at: 1 });
    const line = describeStrategyDiagnostic(record);
    expect(line).toContain("NO_ENTRY");
    expect(line).toContain("hard:16:10");
    expect(line).toContain("arc-standard@1");

    // The invariant from CLAUDE.md, asserted rather than trusted: never log a
    // hidden shoe, an unrevealed hole card, a seed or a credential.
    for (const forbidden of ["shoe", "hole", "seed", "token", "password", "user"]) {
      expect(line.toLowerCase(), `log line mentions ${forbidden}`).not.toContain(forbidden);
    }
    // A strategy key is a chart coordinate, not a card. No rank or suit letters
    // ride out in it.
    expect(line).not.toMatch(/\b(?:[2-9]|10|[JQKA])[SHDC]\b/);
  });

  it("says an invalid state in words rather than printing null", () => {
    const record = recordStrategyDiagnostic({
      ...BASE,
      code: "INVALID_STATE",
      key: null,
      at: 1,
    });
    const line = describeStrategyDiagnostic(record);
    expect(line).toContain("an invalid state");
    expect(line).not.toContain("null");
  });
});
