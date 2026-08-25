/**
 * Practice persistence.
 *
 * A saved blob is untrusted input from disk. The property under test throughout
 * is that a bad save degrades safely — archived and replaced — rather than being
 * handed to the engine or crashing the app on every launch.
 */

import { beforeEach, describe, expect, it } from "vitest";

import { MemoryKeyValueStore } from "../../src/lib/persistence/key-value-store.js";
import {
  deserialisePractice,
  PracticePersistence,
  PRACTICE_SCHEMA_VERSION,
  serialisePractice,
} from "../../src/features/practice/persistence.js";
import {
  HYDRATE_TIMEOUT_MS,
  PRACTICE_SEAT_ID,
  setPracticePersistence,
  usePracticeStore,
} from "../../src/features/practice/practice-store.js";
import {
  EMPTY_PRACTICE_STATS,
  type PracticeStats,
} from "../../src/features/practice/practice-record.js";
import { ARC_STANDARD_RULES, rulesetKey, rulesForTier, TABLE_TIERS } from "../../shared/blackjack/rules.js";
import { applyCommand, createGame, startSession } from "../../shared/blackjack/reducer.js";
import { SeededTestRandomSource } from "../../shared/blackjack/rng.js";

const PRACTICE_RULES = rulesForTier(
  TABLE_TIERS.find((tier) => tier.id === "casual")!,
  ARC_STANDARD_RULES,
);
const KEY = rulesetKey(PRACTICE_RULES);

const STATS: PracticeStats = {
  ...EMPTY_PRACTICE_STATS,
  handsPlayed: 3,
  decisions: 7,
  correct: 6,
  unaidedDecisions: 4,
  unaidedCorrect: 3,
  estimatedEvLost: 0.12,
  hardDecisions: 5,
  hardCorrect: 4,
  softDecisions: 1,
  softCorrect: 1,
  pairDecisions: 1,
  pairCorrect: 1,
};

function liveSession() {
  const ctx = { random: new SeededTestRandomSource(11) };
  let state = createGame({
    gameId: "persist-test",
    rules: PRACTICE_RULES,
    seats: [{ seatId: PRACTICE_SEAT_ID, displayName: "You", stack: 5_000 }],
    random: new SeededTestRandomSource(9),
  });
  state = startSession(state, ctx).state;
  state = applyCommand(state, { type: "PLACE_BET", seatId: PRACTICE_SEAT_ID, amount: 100 }, ctx).state;
  state = applyCommand(state, { type: "LOCK_BET", seatId: PRACTICE_SEAT_ID }, ctx).state;
  return state;
}

function saved(overrides: Record<string, unknown> = {}): string {
  const base = JSON.parse(
    serialisePractice({
      engineState: liveSession(),
      stats: STATS,
      mode: "analysis",
      lastBet: 100,
      savedAt: "2026-08-13T00:00:00.000Z",
    }),
  );
  return JSON.stringify({ ...base, ...overrides });
}

describe("round trip", () => {
  it("restores an interrupted hand exactly", () => {
    const original = liveSession();
    const raw = serialisePractice({
      engineState: original,
      stats: STATS,
      mode: "challenge",
      lastBet: 250,
      savedAt: "2026-08-13T00:00:00.000Z",
    });

    const { session, failure } = deserialisePractice(raw, KEY);
    expect(failure).toBeNull();
    expect(session).not.toBeNull();

    // The shoe matters as much as the chips: resuming with a different shoe
    // would silently reshuffle the composition the player was reasoning about.
    expect(session!.engineState.shoe.nextIndex).toBe(original.shoe.nextIndex);
    expect(session!.engineState.shoe.cards.map((c) => c.id)).toEqual(
      original.shoe.cards.map((c) => c.id),
    );
    expect(session!.engineState.version).toBe(original.version);
    expect(session!.engineState.phase).toBe(original.phase);
    expect(session!.engineState.seats[0]!.hands).toHaveLength(1);
    expect(session!.mode).toBe("challenge");
    expect(session!.lastBet).toBe(250);
    // Statistics are no longer part of the session envelope — they have their
    // own record, so a corrupt session cannot take them with it. Their round
    // trip is asserted through `PracticePersistence` below.
    expect(session!.stats).toEqual(EMPTY_PRACTICE_STATS);
  });

  it("stamps the schema version and ruleset", () => {
    const parsed = JSON.parse(saved());
    expect(parsed.schemaVersion).toBe(PRACTICE_SCHEMA_VERSION);
    expect(parsed.rulesetKey).toBe(KEY);
  });
});

describe("rejecting bad saves", () => {
  it("reports an absent save without inventing one", () => {
    expect(deserialisePractice(null, KEY)).toEqual({ session: null, failure: "ABSENT" });
  });

  it("rejects unparseable JSON", () => {
    expect(deserialisePractice("{not json", KEY).failure).toBe("UNPARSEABLE");
  });

  it("rejects a truncated payload", () => {
    expect(deserialisePractice('{"schemaVersion":1}', KEY).failure).toBe("UNPARSEABLE");
  });

  it("rejects a save from an older schema", () => {
    expect(deserialisePractice(saved({ schemaVersion: 0 }), KEY).failure).toBe("SCHEMA_MISMATCH");
  });

  it("rejects a save made under different rules", () => {
    // A hand dealt under other rules is a different game, not a resumable one.
    expect(deserialisePractice(saved(), "arc-standard@99").failure).toBe("RULESET_MISMATCH");
  });

  it("rejects a structurally valid but undrivable state", () => {
    // Passes every shape check; the engine cannot act on it.
    const broken = JSON.parse(saved());
    broken.engineState.phase = "NOT_A_REAL_PHASE";
    broken.engineState.seats = [];
    expect(deserialisePractice(JSON.stringify(broken), KEY).failure).toBe("UNPARSEABLE");
  });

  it("rejects an empty shoe", () => {
    const broken = JSON.parse(saved());
    broken.engineState.shoe.cards = [];
    expect(deserialisePractice(JSON.stringify(broken), KEY).failure).toBe("UNPARSEABLE");
  });
});

describe("archiving", () => {
  it("archives and clears a corrupt save so it cannot crash on every launch", async () => {
    const store = new MemoryKeyValueStore();
    await store.set("practice:session", "{corrupt");

    const persistence = new PracticePersistence(store);
    const result = await persistence.load(KEY);

    expect(result.failure).toBe("UNPARSEABLE");
    // Gone, so the next launch starts clean...
    expect(await store.get("practice:session")).toBeNull();
    // ...but kept for diagnosis.
    const archive = await persistence.readArchive();
    expect(archive?.reason).toBe("UNPARSEABLE");
    expect(archive?.archivedRaw).toContain("corrupt");
  });

  it("leaves a good save in place", async () => {
    const store = new MemoryKeyValueStore();
    const persistence = new PracticePersistence(store);
    await persistence.save({
      engineState: liveSession(),
      stats: STATS,
      mode: "play",
      lastBet: 50,
      savedAt: "2026-08-13T00:00:00.000Z",
    });

    expect((await persistence.load(KEY)).failure).toBeNull();
    expect(await store.get("practice:session")).not.toBeNull();
  });
});

describe("store hydration", () => {
  beforeEach(() => {
    usePracticeStore.setState({ hydrated: false, game: null });
  });

  it("resumes the saved hand instead of dealing a new one", async () => {
    const store = new MemoryKeyValueStore();
    const persistence = new PracticePersistence(store);
    setPracticePersistence(persistence);

    const original = liveSession();
    await persistence.save({
      engineState: original,
      stats: STATS,
      mode: "learn",
      lastBet: 100,
      savedAt: "2026-08-13T00:00:00.000Z",
    });

    await usePracticeStore.getState().hydrate();

    const restored = usePracticeStore.getState();
    expect(restored.hydrated).toBe(true);
    expect(restored.game?.gameId).toBe(original.gameId);
    expect(restored.game?.version).toBe(original.version);
    expect(restored.stats.handsPlayed).toBe(STATS.handsPlayed);
    expect(restored.mode).toBe("learn");
  });

  it("starts a fresh session when nothing is saved", async () => {
    setPracticePersistence(new PracticePersistence(new MemoryKeyValueStore()));

    await usePracticeStore.getState().hydrate();

    const state = usePracticeStore.getState();
    expect(state.hydrated).toBe(true);
    expect(state.game).not.toBeNull();
    expect(state.game?.handNumber).toBe(1);
    expect(state.game?.seats[0]?.stack).toBe(5_000);
  });

  it("starts a fresh session when the save is corrupt, rather than failing", async () => {
    const store = new MemoryKeyValueStore();
    await store.set("practice:session", '{"schemaVersion":1,"garbage":true}');
    setPracticePersistence(new PracticePersistence(store));

    await usePracticeStore.getState().hydrate();

    const state = usePracticeStore.getState();
    expect(state.game).not.toBeNull();
    expect(state.game?.handNumber).toBe(1);
  });

  it("deals a fresh shoe rather than hanging when storage never answers", async () => {
    // A native storage module that fails to initialise can leave a promise
    // pending forever. Without a bound, the table would sit on "Shuffling…"
    // permanently with no way forward.
    const wedged = {
      get: () => new Promise<string | null>(() => {}),
      set: () => new Promise<void>(() => {}),
      remove: () => new Promise<void>(() => {}),
    };
    setPracticePersistence(new PracticePersistence(wedged));

    const started = Date.now();
    await usePracticeStore.getState().hydrate();
    const elapsed = Date.now() - started;

    const state = usePracticeStore.getState();
    expect(state.hydrated).toBe(true);
    expect(state.game).not.toBeNull();
    expect(state.game?.handNumber).toBe(1);
    expect(elapsed).toBeLessThan(HYDRATE_TIMEOUT_MS + 1_500);
  });

  it("is idempotent", async () => {
    setPracticePersistence(new PracticePersistence(new MemoryKeyValueStore()));

    await usePracticeStore.getState().hydrate();
    const first = usePracticeStore.getState().game;
    await usePracticeStore.getState().hydrate();

    expect(usePracticeStore.getState().game).toBe(first);
  });
});
