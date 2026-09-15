/**
 * OFFLINE AUTHORITY SEPARATION.
 *
 * A player can edit the Practice save. It is a plain row in a SQLite file on
 * their own device, and treating it as anything other than attacker-controlled
 * input would be a mistake. So the question this file answers is not "is the
 * save validated" — it is the harder one: **supposing a modified save is
 * accepted in full, what can it reach?**
 *
 * The answer must be nothing. Not the global wallet, not ranked statistics, not
 * a leaderboard, not a Career reward, not a tournament, not a ranked Daily
 * Challenge result.
 *
 * Two kinds of assertion here, and both are needed. The behavioural ones plant
 * an absurd save and check what comes out. The structural ones read the source
 * and assert the wiring does not exist — because a behavioural test can only
 * prove that today's call sites do not leak, and the failure mode that has bitten
 * this project repeatedly is a call site added later with nothing objecting.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import { beforeEach, describe, expect, it } from "vitest";

import { MemoryKeyValueStore } from "../../src/lib/persistence/key-value-store.js";
import { PracticePersistence, STATS_KEY } from "../../src/features/practice/persistence.js";
import { EMPTY_PRACTICE_STATS } from "../../src/features/practice/practice-record.js";
import {
  PRACTICE_SEAT_ID,
  setPracticePersistence,
  usePracticeStore,
} from "../../src/features/practice/practice-store.js";
import { buildGuestConversionPlan } from "../../src/features/auth/conversion.js";
import { DEFAULT_SETTINGS } from "../../src/features/settings/settings.js";

const store = () => usePracticeStore.getState();
let disk: MemoryKeyValueStore;

beforeEach(() => {
  disk = new MemoryKeyValueStore();
  setPracticePersistence(new PracticePersistence(disk));
  usePracticeStore.setState({
    hydrated: false,
    game: null,
    stats: { ...EMPTY_PRACTICE_STATS },
    decisionLog: [],
    handHistory: [],
    stagedBet: 0,
    lastBet: 0,
    mode: "play",
    error: null,
  });
});

// ---------------------------------------------------------------------------
// Behavioural
// ---------------------------------------------------------------------------

describe("a tampered Practice record reaches nothing", () => {
  it("cannot become global chips through a guest conversion", async () => {
    // The most optimistic save a cheat could write.
    await new PracticePersistence(disk).saveStats({
      ...EMPTY_PRACTICE_STATS,
      handsPlayed: 999_999,
      handsWon: 999_999,
      netChips: 5_000_000,
      maxBankroll: 9_000_000,
      chipsWagered: 50_000_000,
    });
    await store().hydrate();
    expect(store().stats.netChips).toBe(5_000_000);

    const plan = buildGuestConversionPlan({
      guestId: "guest-1",
      preferences: DEFAULT_SETTINGS,
      stats: store().stats,
      now: new Date("2026-08-24T00:00:00.000Z"),
    });

    // Everything about chips is absent from the plan's own vocabulary. A
    // conversion cannot EXPRESS a chip movement, which is stronger than a
    // conversion that expresses one and is refused.
    const serialised = JSON.stringify(plan);
    expect(serialised).not.toMatch(/netChips/);
    expect(serialised).not.toMatch(/maxBankroll/);
    expect(serialised).not.toMatch(/chipsWagered/);
    expect(serialised).not.toMatch(/\bbalance\b/);
    expect(serialised).not.toMatch(/\bdelta\b/);
    expect(serialised).not.toMatch(/idempotency/i);

    // The local bankroll is explicitly named as discarded, in every plan.
    expect(plan.discarded).toContain("LOCAL_BANKROLL");
    expect(plan.discarded).toContain("LOCAL_LEADERBOARD_STANDING");
    expect(plan.discarded).toContain("LOCAL_CAREER_STARS");
  });

  it("carries any imported figures as practice-scoped and self-reported", async () => {
    const plan = buildGuestConversionPlan({
      guestId: "guest-1",
      preferences: DEFAULT_SETTINGS,
      stats: { ...EMPTY_PRACTICE_STATS, decisions: 400, correct: 400 },
      now: new Date("2026-08-24T00:00:00.000Z"),
    });

    expect(plan.practiceHistory?.scope).toBe("practice");
    expect(plan.practiceHistory?.competitive).toBe(false);
    expect(plan.practiceHistory?.selfReported).toBe(true);
  });

  it("gives an inflated Practice bankroll no reach beyond its own seat", async () => {
    await store().hydrate();

    // Rewrite the seat stack to something absurd and save it, exactly as a
    // tampered file would.
    const game = store().game!;
    usePracticeStore.setState({
      game: {
        ...game,
        seats: [{ ...game.seats[0]!, stack: 8_000_000 }],
      },
    });
    await store().flush();

    usePracticeStore.setState({ hydrated: false, game: null });
    await store().hydrate();

    // It restores — Practice chips are disposable and there is nothing to
    // protect them from — and it stays a number inside one engine state.
    expect(store().game!.seats[0]!.stack).toBe(8_000_000);
    expect(store().game!.seats[0]!.seatId).toBe(PRACTICE_SEAT_ID);
    expect(store().game!.seats).toHaveLength(1);

    // Nothing that could carry it outward is present in the save at all.
    const raw = (await disk.get("practice:session")) ?? "";
    expect(raw).not.toMatch(/wallet/i);
    expect(raw).not.toMatch(/ledger/i);
    expect(raw).not.toMatch(/user_id|userId":"[^n]/);
  });

  it("keeps the statistics record free of anything competitive", async () => {
    await new PracticePersistence(disk).saveStats({
      ...EMPTY_PRACTICE_STATS,
      handsPlayed: 10,
    });

    const raw = (await disk.get(STATS_KEY)) ?? "";
    for (const forbidden of ["xp", "leaderboard", "tournament", "career", "wallet", "rank"]) {
      expect(raw.toLowerCase(), `stats record mentions ${forbidden}`).not.toContain(forbidden);
    }
  });
});

// ---------------------------------------------------------------------------
// Structural
// ---------------------------------------------------------------------------

/** Every `.ts`/`.tsx` file under a directory, recursively. */
function sourcesUnder(...segments: string[]): { path: string; source: string }[] {
  const root = join(process.cwd(), ...segments);
  const out: { path: string; source: string }[] = [];

  const walk = (directory: string) => {
    for (const entry of readdirSync(directory)) {
      const full = join(directory, entry);
      if (statSync(full).isDirectory()) {
        walk(full);
        continue;
      }
      if (!entry.endsWith(".ts") && !entry.endsWith(".tsx")) continue;
      out.push({ path: full.slice(root.length + 1), source: readFileSync(full, "utf8") });
    }
  };

  walk(root);
  return out;
}

describe("Practice has no wiring to a competitive system", () => {
  const practice = sourcesUnder("src", "features", "practice");

  it("covers the files it claims to", () => {
    // A source scan that matches nothing passes silently. This is the guard
    // against exactly that.
    expect(practice.length).toBeGreaterThanOrEqual(5);
    expect(practice.map((file) => file.path)).toContain("practice-store.ts");
  });

  it("names no wallet, ledger, XP, leaderboard, tournament or daily-challenge symbol", () => {
    const forbidden = [
      /apply_wallet_delta/,
      /wallet_ledger/,
      /\bwallets\b/,
      /awardXp|grantXp|\bxp_/i,
      /leaderboard/i,
      /tournament/i,
      /daily_?challenge/i,
      /career_?reward|awardCareer/i,
    ];

    for (const file of practice) {
      for (const pattern of forbidden) {
        expect(
          file.source,
          `src/features/practice/${file.path} matches ${pattern}`,
        ).not.toMatch(pattern);
      }
    }
  });

  it("proves the scan discriminates", () => {
    // The lesson from the engine's own source gates: a pattern that finds
    // nothing is indistinguishable from a pattern that cannot find anything.
    const planted = "await supabase.rpc('apply_wallet_delta', { delta: 1 });";
    expect(planted).toMatch(/apply_wallet_delta/);
  });

  it("keeps the practice store out of every competitive feature", () => {
    // The other direction: a competitive surface must not read the local
    // Practice record and treat it as authority. The Statistics, Profile, Home,
    // Learn and Settings screens legitimately DISPLAY it, which is why this
    // scans the competitive features rather than the whole app.
    for (const area of ["tournament", "daily", "leaderboards", "career", "wallet"]) {
      for (const file of sourcesUnder("src", "features", area)) {
        expect(
          file.source,
          `src/features/${area}/${file.path} imports the practice store`,
        ).not.toMatch(/practice\/practice-store/);
      }
    }
  });
});

describe("Practice statistics are excluded from ranked accuracy by an allowlist", () => {
  it("does not appear in ACCURACY_ELIGIBLE_MODES", async () => {
    const source = readFileSync(
      join(process.cwd(), "supabase", "functions", "_shared", "decision-grading.ts"),
      "utf8",
    );
    const block = /ACCURACY_ELIGIBLE_MODES[^=]*=\s*\[([^\]]*)\]/.exec(source);
    expect(block, "ACCURACY_ELIGIBLE_MODES is no longer an array literal").not.toBeNull();

    const modes = block![1]!;
    expect(modes).toContain("solo");
    expect(modes).toContain("public_table");
    expect(modes).not.toContain("practice");
  });
});
