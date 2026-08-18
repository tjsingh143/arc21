/**
 * Drill history persistence.
 *
 * A saved blob is untrusted input. The property under test is not "we can write
 * JSON" — it is that **nothing a corrupt save contains can crash the Learn
 * screens**. Truncated bytes, a future schema, negative counts, a null where a
 * record should be, an array of primitives, an enormous blob: every one of them
 * must degrade to an empty history and let the player keep drilling.
 *
 * The store binding is exercised too, because "does not crash" is a claim about
 * the thing the screen actually calls, not only about the parser underneath it.
 */

import { beforeEach, describe, expect, it } from "vitest";

import { MemoryKeyValueStore, type KeyValueStore } from "../../src/lib/persistence/key-value-store.js";
import {
  deserialiseDrillHistory,
  DRILL_HISTORY_KEY,
  DRILL_HISTORY_SCHEMA_VERSION,
  DrillHistoryStore,
  MAX_DRILL_RECORDS,
  pruneDrillHistory,
  serialiseDrillHistory,
} from "../../src/features/learn/drill-history.js";
import {
  recordDrillAnswer,
  type DrillHistory,
  type DrillRecord,
} from "../../src/features/learn/spaced-repetition.js";
import {
  setDrillHistoryStore,
  useDrillHistoryStore,
} from "../../src/features/learn/use-drill-history.js";

const NOW = Date.UTC(2026, 7, 14, 12, 0, 0);

function record(overrides: Partial<DrillRecord> & { key: string }): DrillRecord {
  return {
    timesRight: 0,
    timesWrong: 0,
    lastSeenAt: NOW,
    lastWrongAt: null,
    ...overrides,
  };
}

function historyOf(...records: DrillRecord[]): DrillHistory {
  const history: Record<string, DrillRecord> = {};
  for (const entry of records) history[entry.key] = entry;
  return history;
}

// ---------------------------------------------------------------------------

describe("round trip", () => {
  it("restores exactly what was saved", () => {
    const history = historyOf(
      record({ key: "hard:16:10", timesRight: 3, timesWrong: 2, lastWrongAt: NOW - 1_000 }),
      record({ key: "soft:18:9", timesRight: 1 }),
    );

    const result = deserialiseDrillHistory(serialiseDrillHistory(history));

    expect(result.failure).toBeNull();
    expect(result.history).toEqual(history);
  });

  it("serialises the same history to the same bytes every time", () => {
    // Insertion order differs; the persisted form must not.
    const a = recordDrillAnswer(recordDrillAnswer({}, "pair:8:10", false, NOW), "hard:11:6", true, NOW);
    const b = recordDrillAnswer(recordDrillAnswer({}, "hard:11:6", true, NOW), "pair:8:10", false, NOW);

    expect(serialiseDrillHistory(a)).toBe(serialiseDrillHistory(b));
  });

  it("stamps the schema version it will later demand", () => {
    const raw = serialiseDrillHistory(historyOf(record({ key: "hard:9:3" })));
    expect(JSON.parse(raw)).toMatchObject({ schemaVersion: DRILL_HISTORY_SCHEMA_VERSION });
  });
});

// ---------------------------------------------------------------------------

describe("a corrupt blob never reaches the scheduler", () => {
  const CORRUPT: readonly [string, string][] = [
    ["not JSON at all", "{{{"],
    ["truncated JSON", '{"schemaVersion":1,"records":[{"key":"hard'],
    ["a bare string", '"hello"'],
    ["a number", "42"],
    ["null", "null"],
    ["an array where an object belongs", "[1,2,3]"],
    ["records as primitives", '{"schemaVersion":1,"records":["hard:16:10"]}'],
    ["records missing", '{"schemaVersion":1}'],
    ["a negative attempt count", '{"schemaVersion":1,"records":[{"key":"a","timesRight":-1,"timesWrong":0,"lastSeenAt":0,"lastWrongAt":null}]}'],
    ["a fractional attempt count", '{"schemaVersion":1,"records":[{"key":"a","timesRight":1.5,"timesWrong":0,"lastSeenAt":0,"lastWrongAt":null}]}'],
    ["an empty key", '{"schemaVersion":1,"records":[{"key":"","timesRight":0,"timesWrong":0,"lastSeenAt":0,"lastWrongAt":null}]}'],
    ["a null record", '{"schemaVersion":1,"records":[null]}'],
    ["a negative timestamp", '{"schemaVersion":1,"records":[{"key":"a","timesRight":0,"timesWrong":1,"lastSeenAt":-5,"lastWrongAt":null}]}'],
  ];

  for (const [name, raw] of CORRUPT) {
    it(`survives ${name}`, () => {
      const result = deserialiseDrillHistory(raw);
      expect(result.failure).toBe("UNPARSEABLE");
      expect(result.history).toEqual({});
    });
  }

  it("reports an absent save as absent, not as corruption", () => {
    const result = deserialiseDrillHistory(null);
    expect(result.failure).toBe("ABSENT");
    expect(result.history).toEqual({});
  });

  it("refuses a schema version it has no migration for", () => {
    const raw = JSON.stringify({
      schemaVersion: DRILL_HISTORY_SCHEMA_VERSION + 1,
      records: [{ key: "a", timesRight: 1, timesWrong: 0, lastSeenAt: NOW, lastWrongAt: null }],
    });
    const result = deserialiseDrillHistory(raw);
    // Inventing a migration for a shape that has never shipped would be fiction.
    expect(result.failure).toBe("SCHEMA_MISMATCH");
    expect(result.history).toEqual({});
  });

  it("rejects a blob far larger than the bank could ever justify", () => {
    const records = Array.from({ length: MAX_DRILL_RECORDS * 2 + 1 }, (_, index) => ({
      key: `k${index}`,
      timesRight: 0,
      timesWrong: 0,
      lastSeenAt: 0,
      lastWrongAt: null,
    }));
    const result = deserialiseDrillHistory(JSON.stringify({ schemaVersion: 1, records }));
    expect(result.failure).toBe("UNPARSEABLE");
  });
});

// ---------------------------------------------------------------------------

describe("pruning", () => {
  it("leaves a history under the cap untouched", () => {
    const history = historyOf(record({ key: "a" }), record({ key: "b" }));
    expect(pruneDrillHistory(history)).toBe(history);
  });

  it("keeps the most recently seen records and drops the stalest", () => {
    const history = historyOf(
      record({ key: "old", lastSeenAt: 1 }),
      record({ key: "mid", lastSeenAt: 2 }),
      record({ key: "new", lastSeenAt: 3 }),
    );
    const pruned = pruneDrillHistory(history, 2);
    expect(Object.keys(pruned).sort()).toEqual(["mid", "new"]);
  });

  it("breaks ties by key, so pruning is reproducible", () => {
    const history = historyOf(
      record({ key: "b", lastSeenAt: 5 }),
      record({ key: "a", lastSeenAt: 5 }),
    );
    expect(Object.keys(pruneDrillHistory(history, 1))).toEqual(["a"]);
  });
});

// ---------------------------------------------------------------------------

describe("DrillHistoryStore", () => {
  it("writes and reads back through a key/value store", async () => {
    const kv = new MemoryKeyValueStore();
    const store = new DrillHistoryStore(kv);

    await store.save(historyOf(record({ key: "hard:16:10", timesWrong: 1, lastWrongAt: NOW })));
    const loaded = await store.load();

    expect(loaded.failure).toBeNull();
    expect(loaded.history["hard:16:10"]?.timesWrong).toBe(1);
    expect(await kv.get(DRILL_HISTORY_KEY)).not.toBeNull();
  });

  it("deletes a blob it could not read, so the next launch starts clean", async () => {
    const kv = new MemoryKeyValueStore();
    await kv.set(DRILL_HISTORY_KEY, "{{{ not json");

    const loaded = await new DrillHistoryStore(kv).load();

    expect(loaded.failure).toBe("UNPARSEABLE");
    // Left in place, every launch would fail to parse the same bytes forever.
    expect(await kv.get(DRILL_HISTORY_KEY)).toBeNull();
  });

  it("leaves an absent key absent rather than writing an empty save", async () => {
    const kv = new MemoryKeyValueStore();
    const loaded = await new DrillHistoryStore(kv).load();
    expect(loaded.failure).toBe("ABSENT");
    expect(await kv.get(DRILL_HISTORY_KEY)).toBeNull();
  });

  it("clears on request", async () => {
    const kv = new MemoryKeyValueStore();
    const store = new DrillHistoryStore(kv);
    await store.save(historyOf(record({ key: "a", timesRight: 1 })));
    await store.clear();
    expect(await kv.get(DRILL_HISTORY_KEY)).toBeNull();
  });
});

// ---------------------------------------------------------------------------

/** A store whose backing storage is broken in the worst way it can be. */
class ThrowingKeyValueStore implements KeyValueStore {
  async get(): Promise<string | null> {
    throw new Error("storage unavailable");
  }
  async set(): Promise<void> {
    throw new Error("storage unavailable");
  }
  async remove(): Promise<void> {
    throw new Error("storage unavailable");
  }
}

describe("the store binding the screens use", () => {
  beforeEach(() => {
    useDrillHistoryStore.setState({ history: {}, ready: false, loadFailure: null });
  });

  it("loads saved history and records answers through it", async () => {
    const kv = new MemoryKeyValueStore();
    setDrillHistoryStore(new DrillHistoryStore(kv));

    await useDrillHistoryStore.getState().load();
    expect(useDrillHistoryStore.getState().ready).toBe(true);

    await useDrillHistoryStore.getState().record("hard:16:10", false);
    await useDrillHistoryStore.getState().record("hard:16:10", true);

    const live = useDrillHistoryStore.getState().history["hard:16:10"];
    expect(live?.timesWrong).toBe(1);
    expect(live?.timesRight).toBe(1);

    // And it really reached storage, not just React state.
    const reread = await new DrillHistoryStore(kv).load();
    expect(reread.history["hard:16:10"]?.timesWrong).toBe(1);
  });

  it("becomes ready with an empty history when storage throws", async () => {
    setDrillHistoryStore(new DrillHistoryStore(new ThrowingKeyValueStore()));

    await useDrillHistoryStore.getState().load();

    // The screen must render. A drill without history is still a drill.
    expect(useDrillHistoryStore.getState().ready).toBe(true);
    expect(useDrillHistoryStore.getState().history).toEqual({});
  });

  it("keeps the answer in memory when the write fails", async () => {
    setDrillHistoryStore(new DrillHistoryStore(new ThrowingKeyValueStore()));
    await useDrillHistoryStore.getState().load();

    await expect(useDrillHistoryStore.getState().record("pair:8:10", true)).resolves.toBeUndefined();
    expect(useDrillHistoryStore.getState().history["pair:8:10"]?.timesRight).toBe(1);
  });

  it("surfaces a corrupt save as a diagnostic rather than a crash", async () => {
    const kv = new MemoryKeyValueStore();
    await kv.set(DRILL_HISTORY_KEY, '{"schemaVersion":99,"records":[]}');
    setDrillHistoryStore(new DrillHistoryStore(kv));

    await useDrillHistoryStore.getState().load();

    expect(useDrillHistoryStore.getState().ready).toBe(true);
    expect(useDrillHistoryStore.getState().loadFailure).toBe("SCHEMA_MISMATCH");
    expect(useDrillHistoryStore.getState().history).toEqual({});
  });

  it("resets to an empty history and clears storage", async () => {
    const kv = new MemoryKeyValueStore();
    setDrillHistoryStore(new DrillHistoryStore(kv));
    await useDrillHistoryStore.getState().load();
    await useDrillHistoryStore.getState().record("soft:18:9", true);

    await useDrillHistoryStore.getState().reset();

    expect(useDrillHistoryStore.getState().history).toEqual({});
    expect(await kv.get(DRILL_HISTORY_KEY)).toBeNull();
  });
});
