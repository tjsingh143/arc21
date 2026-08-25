/**
 * What Practice does when something is wrong.
 *
 * The five states the phase gate names: strategy data missing, a corrupted save,
 * a local schema migration, no network, and an app restart. The rule that binds
 * them is one sentence — **fail safely without destroying unrelated user data**
 * — and the case that used to break it is the one at the top of this file.
 *
 * The session and the statistics used to share one blob. A single unparseable
 * byte in the middle of a shoe therefore erased a player's whole practice
 * history: hands, accuracy, EV lost, all of it, silently, on a launch that
 * otherwise looked completely normal. The hand in progress genuinely was
 * unrecoverable; the record of five hundred earlier hands never was.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  ARC_STANDARD_RULES,
  rulesetKey,
  rulesForTier,
  TABLE_TIERS,
} from "../../shared/blackjack/rules.js";
import { applyCommand, createGame, startSession } from "../../shared/blackjack/reducer.js";
import { SeededTestRandomSource } from "../../shared/blackjack/rng.js";
import { MemoryKeyValueStore } from "../../src/lib/persistence/key-value-store.js";
import {
  ARCHIVE_KEY,
  deserialisePracticeStats,
  migratePracticeStats,
  PracticePersistence,
  serialisePractice,
  serialisePracticeStats,
  SESSION_KEY,
  SESSION_SCHEMA_VERSION,
  STATS_KEY,
  type SavePracticeInput,
} from "../../src/features/practice/persistence.js";
import { EMPTY_PRACTICE_STATS } from "../../src/features/practice/practice-record.js";
import {
  PRACTICE_SEAT_ID,
  PRACTICE_STARTING_BANKROLL,
  setPracticePersistence,
  usePracticeStore,
} from "../../src/features/practice/practice-store.js";

const PRACTICE_RULES = rulesForTier(
  TABLE_TIERS.find((tier) => tier.id === "casual")!,
  ARC_STANDARD_RULES,
);
const KEY = rulesetKey(PRACTICE_RULES);

const HISTORY = {
  ...EMPTY_PRACTICE_STATS,
  handsPlayed: 512,
  handsSettled: 540,
  handsWon: 231,
  handsLost: 268,
  handsPushed: 41,
  decisions: 1_204,
  correct: 1_150,
  unaidedDecisions: 900,
  unaidedCorrect: 861,
  estimatedEvLost: 4.51,
};

const store = () => usePracticeStore.getState();

function liveSession() {
  const context = { random: new SeededTestRandomSource(11) };
  let state = createGame({
    gameId: "error-states",
    rules: PRACTICE_RULES,
    seats: [{ seatId: PRACTICE_SEAT_ID, displayName: "You", stack: 5_000 }],
    random: new SeededTestRandomSource(9),
    timing: null,
  });
  state = startSession(state, context).state;
  state = applyCommand(
    state,
    { type: "PLACE_BET", seatId: PRACTICE_SEAT_ID, amount: 100 },
    context,
  ).state;
  return applyCommand(state, { type: "LOCK_BET", seatId: PRACTICE_SEAT_ID }, context).state;
}

function savePayload(overrides: Partial<SavePracticeInput> = {}): SavePracticeInput {
  return {
    engineState: liveSession(),
    stats: HISTORY,
    mode: "learn",
    lastBet: 100,
    savedAt: "2026-08-24T00:00:00.000Z",
    ...overrides,
  };
}

/** Everything a process death destroys. */
function killTheApp(): void {
  usePracticeStore.setState({
    hydrated: false,
    game: null,
    stagedBet: 0,
    lastBet: 0,
    mode: "play",
    recentEvents: [],
    error: null,
    stats: { ...EMPTY_PRACTICE_STATS },
    feedback: null,
    decisionLog: [],
    handHistory: [],
  });
}

let disk: MemoryKeyValueStore;

beforeEach(() => {
  disk = new MemoryKeyValueStore();
  setPracticePersistence(new PracticePersistence(disk));
  killTheApp();
});

// ---------------------------------------------------------------------------
// A corrupted save
// ---------------------------------------------------------------------------

describe("a corrupted saved session", () => {
  it("does not take the cumulative statistics with it", async () => {
    const persistence = new PracticePersistence(disk);
    await persistence.save(savePayload());

    // A torn write: valid JSON up to the point the process died.
    await disk.set(SESSION_KEY, '{"schemaVersion":2,"engineState":{"phase":');

    const result = await persistence.load(KEY);
    expect(result.failure).toBe("UNPARSEABLE");
    expect(result.session).toBeNull();
    // THE POINT OF THIS FILE.
    expect(result.stats).toEqual(HISTORY);
  });

  it("archives the bad blob, names the failure, and removes it so it cannot recur", async () => {
    const persistence = new PracticePersistence(disk);
    await disk.set(SESSION_KEY, "not json at all");

    await persistence.load(KEY);

    expect(await disk.get(SESSION_KEY)).toBeNull();
    const archive = await persistence.readArchive();
    expect(archive?.reason).toBe("UNPARSEABLE");
    expect(archive?.archivedRaw).toBe("not json at all");
    // Archived under its own key, so the statistics record is untouched.
    expect(await disk.get(ARCHIVE_KEY)).not.toBeNull();
  });

  it("leaves the player playable on a fresh shoe with their record intact", async () => {
    await new PracticePersistence(disk).saveStats(HISTORY);
    await disk.set(SESSION_KEY, "}}}broken{{{");

    await store().hydrate();

    expect(store().game).not.toBeNull();
    expect(store().game!.phase).toBe("BETTING_OPEN");
    expect(store().game!.seats[0]!.stack).toBe(PRACTICE_STARTING_BANKROLL);
    expect(store().stats.handsPlayed).toBe(512);
    expect(store().stats.correct).toBe(1_150);
  });

  it("does not crash repeatedly: the second launch is clean", async () => {
    await disk.set(SESSION_KEY, "}}}broken{{{");
    await store().hydrate();
    const first = store().game!.gameId;

    killTheApp();
    await store().hydrate();

    // The bad save is gone, so the second launch restores the session the first
    // launch created rather than tripping over the same blob again.
    expect(store().game!.gameId).toBe(first);
  });
});

// ---------------------------------------------------------------------------
// Local schema migration
// ---------------------------------------------------------------------------

describe("local schema migration", () => {
  it("upgrades a v1 save instead of throwing it away", async () => {
    // Exactly what an older build wrote: statistics inside the envelope, no
    // decision log, no hand history, schemaVersion 1.
    const v1 = JSON.stringify({
      ...JSON.parse(serialisePractice(savePayload())),
      schemaVersion: 1,
      stats: {
        handsPlayed: 77,
        decisions: 200,
        correct: 180,
        unaidedDecisions: 150,
        unaidedCorrect: 140,
        estimatedEvLost: 1.25,
        hardDecisions: 120,
        hardCorrect: 110,
        softDecisions: 40,
        softCorrect: 36,
        pairDecisions: 40,
        pairCorrect: 34,
      },
    });
    await disk.set(SESSION_KEY, v1);

    const result = await new PracticePersistence(disk).load(KEY);

    expect(result.failure).toBeNull();
    expect(result.session).not.toBeNull();
    expect(result.session!.schemaVersion).toBe(1);
    // Lifted out of the envelope…
    expect(result.stats?.handsPlayed).toBe(77);
    expect(result.stats?.correct).toBe(180);
    // …counters the old build never had default to zero rather than failing…
    expect(result.stats?.handsWon).toBe(0);
    expect(result.stats?.chipsWagered).toBe(0);
    // …and the log defaults rather than being absent.
    expect(result.session!.decisionLog).toEqual([]);
    expect(result.session!.handHistory).toEqual([]);

    // The statistics are written to their own record, so the next load reads
    // them directly and the migration happens exactly once.
    expect(deserialisePracticeStats(await disk.get(STATS_KEY))?.handsPlayed).toBe(77);
  });

  it("adds a counter without losing a single figure from an older record", () => {
    const older = { handsPlayed: 9, decisions: 30, correct: 28 };
    const migrated = migratePracticeStats(older);

    expect(migrated.handsPlayed).toBe(9);
    expect(migrated.decisions).toBe(30);
    expect(migrated.correct).toBe(28);
    expect(migrated.handsWon).toBe(0);
    expect(Object.keys(migrated).sort()).toEqual(Object.keys(EMPTY_PRACTICE_STATS).sort());
  });

  it("refuses a save from a FUTURE version rather than guessing at it", async () => {
    const future = JSON.stringify({
      ...JSON.parse(serialisePractice(savePayload())),
      schemaVersion: SESSION_SCHEMA_VERSION + 1,
    });
    await disk.set(SESSION_KEY, future);
    await new PracticePersistence(disk).saveStats(HISTORY);

    const result = await new PracticePersistence(disk).load(KEY);

    expect(result.failure).toBe("SCHEMA_MISMATCH");
    expect(result.session).toBeNull();
    // Still not a reason to delete the player's history.
    expect(result.stats).toEqual(HISTORY);
  });

  it("discards a statistics record from a future version rather than misreading it", async () => {
    await disk.set(
      STATS_KEY,
      JSON.stringify({ schemaVersion: 99, savedAt: "now", stats: { handsPlayed: 5 } }),
    );
    expect(deserialisePracticeStats(await disk.get(STATS_KEY))).toBeNull();
  });

  it("survives a statistics record that is not JSON", async () => {
    await disk.set(STATS_KEY, "<<<not json>>>");
    await disk.set(SESSION_KEY, serialisePractice(savePayload()));

    const result = await new PracticePersistence(disk).load(KEY);

    // The session is still perfectly good; only the statistics were unreadable.
    expect(result.session).not.toBeNull();
    expect(result.stats).toEqual(EMPTY_PRACTICE_STATS);
  });
});

// ---------------------------------------------------------------------------
// A ruleset change
// ---------------------------------------------------------------------------

describe("a ruleset change", () => {
  it("refuses to resume a hand dealt under different rules, but keeps the record", async () => {
    await new PracticePersistence(disk).save(savePayload());

    const result = await new PracticePersistence(disk).load("some-other-ruleset@1");

    expect(result.failure).toBe("RULESET_MISMATCH");
    expect(result.session).toBeNull();
    expect(result.stats).toEqual(HISTORY);
  });
});

// ---------------------------------------------------------------------------
// Storage that never answers
// ---------------------------------------------------------------------------

describe("storage that fails", () => {
  it("deals a fresh shoe rather than hanging when the store never resolves", async () => {
    setPracticePersistence(
      new PracticePersistence({
        get: () => new Promise<string | null>(() => {}),
        set: async () => {},
        remove: async () => {},
      }),
    );

    vi.useFakeTimers();
    const hydrating = store().hydrate();
    await vi.advanceTimersByTimeAsync(5_000);
    await hydrating;
    vi.useRealTimers();

    expect(store().hydrated).toBe(true);
    expect(store().game).not.toBeNull();
  });

  it("keeps playing when every write throws", async () => {
    setPracticePersistence(
      new PracticePersistence({
        get: async () => null,
        set: async () => {
          throw new Error("disk full");
        },
        remove: async () => {},
      }),
    );

    await store().hydrate();
    store().addChip(100);
    store().lockBet();

    // A failed save must never interrupt play, and must never surface as a
    // table error: the player's hand is worth more than the write.
    expect(store().game!.phase).not.toBe("BETTING_OPEN");
    expect(store().error).toBeNull();
    await expect(store().flush()).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// No network
// ---------------------------------------------------------------------------

describe("no network", () => {
  it("imports nothing that could reach a server", async () => {
    // The whole Practice feature is asserted to be import-clean of network
    // clients. A store that pulled in the Supabase SDK would still "work"
    // offline right up until a call site was added, and the failure would be a
    // blank table rather than a compile error.
    const { readFileSync, readdirSync } = await import("node:fs");
    const { join } = await import("node:path");

    const directory = join(process.cwd(), "src", "features", "practice");
    for (const file of readdirSync(directory)) {
      if (!file.endsWith(".ts")) continue;
      const source = readFileSync(join(directory, file), "utf8");
      expect(source, `${file} imports a network client`).not.toMatch(
        /from\s+["'][^"']*supabase[^"']*["']/,
      );
      expect(source, `${file} calls fetch`).not.toMatch(/\bfetch\s*\(/);
    }
  });

  it("plays a full hand with no persistence configured at all", async () => {
    // The most hostile version of "offline": nothing to read, nothing to write.
    setPracticePersistence(
      new PracticePersistence({
        get: async () => null,
        set: async () => {},
        remove: async () => {},
      }),
    );

    await store().hydrate();
    store().addChip(100);
    store().lockBet();

    let guard = 0;
    while (store().game!.phase !== "HAND_COMPLETE" && guard < 20) {
      guard += 1;
      if (store().game!.phase === "INSURANCE_OFFER") {
        store().declineInsurance();
        continue;
      }
      store().act("STAND");
    }

    expect(store().game!.phase).toBe("HAND_COMPLETE");
    expect(store().stats.handsPlayed).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Restart
// ---------------------------------------------------------------------------

describe("app restart", () => {
  it("is idempotent: hydrating twice does not deal a second shoe", async () => {
    await store().hydrate();
    const first = store().game;
    await store().hydrate();
    expect(store().game).toBe(first);
  });

  it("restores statistics even when there is no session to restore", async () => {
    await disk.set(STATS_KEY, serialisePracticeStats(HISTORY, "2026-08-24T00:00:00.000Z"));

    await store().hydrate();

    expect(store().game).not.toBeNull();
    expect(store().stats).toEqual(HISTORY);
  });
});
