/**
 * Refresh D — the product hierarchy Home and Play render.
 *
 * Two kinds of assertion live here, and they are kept apart on purpose.
 *
 *   1. ORDER: chip play with other people first, AI Tables second, Practice
 *      and progress third — and, without a ready player, Practice first.
 *   2. CLAIMS: every "who is at the table / whose chips / what it counts
 *      toward" fact a mode card states is held against the list the SERVER
 *      enforces, imported from `supabase/functions/_shared`. A card that
 *      promised chips back from a closed-economy table, or called a solo table
 *      multiplayer, fails here rather than in a player's hands.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  AI_TABLE_SEAT_COUNT,
  AI_TABLE_STACK,
  PRIVATE_TABLE_STACK,
} from "../../shared/blackjack/rules.js";
import { modeAccessibilityLabel, modeBadge } from "../../src/features/home/play-mode-presentation.js";
import {
  AI_TABLES_SUMMARY,
  HOME_BLOCK_TIER,
  HOME_CHIP_FORMAT_LINKS,
  PLAY_MODES,
  PLAY_SECTIONS,
  PLAY_SUPPORT_LINKS,
  PRODUCT_TIER_ORDER,
  homeLayout,
  homeLinks,
  homeResume,
  linkAccessibilityLabel,
  modeFacts,
  onlineAvailability,
  recordingSentence,
  stakeSentence,
  type HomeBlock,
  type OnlineAvailability,
  type PlayMode,
  type PlayModeId,
} from "../../src/features/home/product-hierarchy.js";
import type { ActiveSessionStatus } from "../../src/features/table/active-session-store.js";
import {
  ACTIVE_SESSION_ROUTE,
  handCompletionForMode,
  type ActiveSession,
} from "../../src/features/table/active-session.js";
import { ACCURACY_ELIGIBLE_MODES } from "../../supabase/functions/_shared/decision-grading.js";
import {
  ALL_SESSION_MODES,
  WALLET_BACKED_MODES,
} from "../../supabase/functions/_shared/session-economics.js";
import { SETTLEMENT_RECORDING_MODES } from "../../supabase/functions/_shared/settlement-accounting.js";
import { SPRINT } from "../../supabase/functions/_shared/tournament-format.js";

const MODES: PlayMode[] = Object.values(PLAY_MODES);
const SERVER_MODES = MODES.filter(
  (mode): mode is PlayMode & { sessionMode: NonNullable<PlayMode["sessionMode"]> } =>
    mode.sessionMode !== null,
);

/** The modes the Play tab renders, in the order it renders them. */
const PLAY_ORDER: PlayModeId[] = PLAY_SECTIONS.flatMap((section) =>
  section.groups.flatMap((group) => [...group.modes]),
);

/** Wording that would describe live company at the table. */
const MULTIPLAYER_WORDING =
  /\b(multiplayer|other (players|people)|with (friends|people|players)|live players|opponents?)\b/i;

const READY: OnlineAvailability = { kind: "ready" };
const OFFLINE = onlineAvailability({ configured: true, hasPlayer: true, offline: true, serverUnreached: false, connecting: false });
const UNCONFIGURED = onlineAvailability({ configured: false, hasPlayer: false, offline: false, serverUnreached: false, connecting: false });

const SEAT: ActiveSession = {
  gameId: "b3bcfb9b-8199-452b-b808-c5ce4d8b74c5",
  seatId: "41745c30-26b5-40fe-8e81-406a448c5a3c",
  mode: "public_table",
  tier: "casual",
  startedAt: null,
};

function tierIndex(block: HomeBlock): number | null {
  const tier = HOME_BLOCK_TIER[block];
  return tier === null ? null : PRODUCT_TIER_ORDER.indexOf(tier);
}

// ---------------------------------------------------------------------------

describe("the Play tab's order", () => {
  it("lists its sections in the product order", () => {
    expect(PLAY_SECTIONS.map((section) => section.tier)).toEqual(["chips", "ai", "practice"]);
    expect(PRODUCT_TIER_ORDER).toEqual(["chips", "ai", "practice"]);
  });

  it("leads with tables of other people, the public table first", () => {
    const [chips] = PLAY_SECTIONS;
    const [people, solo] = chips!.groups;
    expect(people!.title).toBe("With other people");
    expect(people!.modes[0]).toBe("public-table");
    expect(people!.modes).toEqual(["public-table", "private-table", "sprint"]);
    expect(solo!.title).toBe("Solo, against the dealer");
    expect(solo!.modes).toEqual(["quick-play", "daily"]);
  });

  it("puts AI Tables second, on their own", () => {
    const ai = PLAY_SECTIONS[1]!;
    expect(ai.title).toBe("AI Tables");
    expect(ai.groups.flatMap((group) => group.modes)).toEqual(["ai-table"]);
    expect(PLAY_ORDER.indexOf("ai-table")).toBeGreaterThan(PLAY_ORDER.indexOf("daily"));
    expect(PLAY_ORDER.indexOf("ai-table")).toBeLessThan(PLAY_ORDER.indexOf("practice"));
  });

  it("keeps Practice, Career and Learn discoverable in the third tier", () => {
    const practice = PLAY_SECTIONS[2]!;
    expect(practice.groups.flatMap((group) => group.modes)).toEqual(["practice", "career"]);
    expect(PLAY_SUPPORT_LINKS.map((link) => link.id)).toContain("learn");
  });

  it("files every mode in the section of its own tier", () => {
    for (const section of PLAY_SECTIONS) {
      for (const id of section.groups.flatMap((group) => group.modes)) {
        expect(PLAY_MODES[id].tier, id).toBe(section.tier);
      }
    }
  });

  it("renders every mode exactly once", () => {
    expect([...PLAY_ORDER].sort()).toEqual(Object.keys(PLAY_MODES).sort());
    expect(new Set(PLAY_ORDER).size).toBe(PLAY_ORDER.length);
  });
});

describe("every mode that exists stays reachable", () => {
  it("covers every server session mode a player can hold a seat in", () => {
    // `practice` is in the enum and never opens a server session.
    const expected = ALL_SESSION_MODES.filter((mode) => mode !== "practice");
    expect(new Set(SERVER_MODES.map((mode) => mode.sessionMode))).toEqual(new Set(expected));
  });

  it("points every card and link at a screen that exists", () => {
    const routes = [
      ...MODES.map((mode) => mode.route),
      ...PLAY_SUPPORT_LINKS.map((link) => link.route),
      ...HOME_CHIP_FORMAT_LINKS.map((link) => link.route),
      ...homeLinks(READY).map((link) => link.route),
      ...homeLinks(UNCONFIGURED).map((link) => link.route),
    ];
    const app = join(process.cwd(), "app");
    const missing = routes.filter(
      (route) => !existsSync(join(app, `${route}.tsx`)) && !existsSync(join(app, route, "index.tsx")),
    );
    expect(routes.length).toBeGreaterThan(10);
    expect(missing).toEqual([]);
  });

  it("enters each mode through its own setup screen, never a table", () => {
    // A card that opened `/table/[gameId]` or a career node's session would
    // skip the screen that states the buy-in and the terms before anything is
    // spent.
    for (const mode of MODES) {
      expect(mode.route, mode.id).not.toBe(ACTIVE_SESSION_ROUTE);
      expect(mode.route, mode.id).not.toMatch(/\[|\/career\/play\//);
    }
  });

  it("reaches private tables through the lobby Social already uses", () => {
    expect(PLAY_MODES["private-table"].route).toBe("/table/lobby");
  });

  it("reaches AI Tables through their existing entry screen", () => {
    expect(PLAY_MODES["ai-table"].route).toBe("/table/ai");
  });
});

describe("each card's claims match what the server enforces", () => {
  it("says the buy-in comes from your chips exactly where the server returns it", () => {
    for (const mode of SERVER_MODES) {
      const walletBacked = (WALLET_BACKED_MODES as readonly string[]).includes(mode.sessionMode);
      expect(mode.chips === "wallet-buy-in", mode.id).toBe(walletBacked);
    }
  });

  it("charges an entry fee only for the Sprint, at the server's figure", () => {
    const feeModes = MODES.filter((mode) => mode.chips === "wallet-entry-fee").map((mode) => mode.id);
    expect(feeModes).toEqual(["sprint"]);
    expect(PLAY_MODES.sprint.structure).toContain(`${SPRINT.entryFee} entry`);
    expect(PLAY_MODES.sprint.structure).toContain(`${SPRINT.scheduledHands} hands`);
    expect(PLAY_MODES.sprint.structure).toContain(`after hand ${SPRINT.eliminationHand}`);
    expect(PLAY_MODES.sprint.purpose).toMatch(/^Four players/);
    expect(SPRINT.seats).toBe(4);
  });

  it("claims XP and statistics exactly where hands are recorded", () => {
    for (const mode of SERVER_MODES) {
      if (mode.recording === null) continue; // Career: stated without a claim.
      const records = (SETTLEMENT_RECORDING_MODES as readonly string[]).includes(mode.sessionMode);
      expect(mode.recording !== "none", mode.id).toBe(records);
    }
  });

  it("claims accuracy exactly where decisions reach the accuracy board", () => {
    for (const mode of SERVER_MODES) {
      if (mode.recording === null) continue;
      const graded = (ACCURACY_ELIGIBLE_MODES as readonly string[]).includes(mode.sessionMode);
      expect(mode.recording === "xp-stats-accuracy", mode.id).toBe(graded);
    }
  });

  /**
   * "Other people at the table" is derived from the server's own shape: a
   * table carries a clock precisely because somebody else is waiting on you.
   * The untimed tables are Quick Play, the Daily Challenge, Career and the AI
   * table — and of those only the AI table has anybody else at it.
   */
  it("says other people are there exactly where the table runs a clock", () => {
    for (const mode of SERVER_MODES) {
      const timed = handCompletionForMode(mode.sessionMode) === "clock";
      expect(mode.participants === "people", mode.id).toBe(timed);
      if (mode.sessionMode === "ai_table") expect(mode.participants).toBe("computer");
      if (!timed && mode.sessionMode !== "ai_table") expect(mode.participants, mode.id).toBe("solo");
    }
  });

  it("promises chips back in a sentence only where the facts line says buy-in", () => {
    for (const mode of MODES) {
      const sentence = stakeSentence(mode);
      if (mode.chips === null) {
        expect(sentence, mode.id).toBeNull();
        continue;
      }
      const promisesReturn = /comes back when you leave/.test(sentence ?? "");
      expect(promisesReturn, mode.id).toBe(mode.chips === "wallet-buy-in");
      const promisesNothingMoves = /nothing moves to or from your balance|never (enters|touch)/.test(sentence ?? "");
      expect(promisesNothingMoves, mode.id).toBe(mode.chips !== "wallet-buy-in" && mode.chips !== "scoring-stack");
    }
  });

  /**
   * The private lobby once said "Unranked. Hands here do not count towards
   * leaderboards" while `game-command` paid XP for every private hand and the
   * weekly XP board sums that XP across every mode. The sentence is composed
   * from `recording`, which the two tests above hold against the server.
   */
  it("says unranked, or not, exactly where the recording field says so", () => {
    for (const mode of MODES) {
      const sentence = recordingSentence(mode);
      if (mode.recording === null) {
        expect(sentence, mode.id).toBeNull();
        continue;
      }
      expect(/^Unranked/.test(sentence ?? ""), mode.id).toBe(mode.recording === "none");
      expect(/\bearn XP\b/.test(sentence ?? ""), mode.id).toBe(mode.recording !== "none");
      expect(/weekly XP leaderboard/.test(sentence ?? ""), mode.id).toBe(mode.recording !== "none");
      expect(/not toward strategy accuracy/.test(sentence ?? ""), mode.id).toBe(mode.recording === "xp-stats");
    }
    expect(recordingSentence(PLAY_MODES["private-table"])).not.toMatch(/do not count|Unranked/);
  });

  it("states table-chip stacks at the engine's figures", () => {
    expect(PLAY_MODES["private-table"].structure).toContain(PRIVATE_TABLE_STACK.toLocaleString("en-US"));
    expect(PLAY_MODES["ai-table"].structure).toContain(AI_TABLE_STACK.toLocaleString("en-US"));
    expect(PLAY_MODES["ai-table"].structure).toContain(`${AI_TABLE_SEAT_COUNT} seats`);
  });
});

describe("Quick Play is solo chip play, and never described as anything else", () => {
  const quick = PLAY_MODES["quick-play"];

  it("is a wallet-backed table with nobody else at it", () => {
    expect(quick.tier).toBe("chips");
    expect(quick.participants).toBe("solo");
    expect(quick.chips).toBe("wallet-buy-in");
    expect(quick.sessionMode).toBe("solo");
  });

  it("is filed under solo play, not under tables with other people", () => {
    const groups = PLAY_SECTIONS.flatMap((section) => section.groups);
    const home = groups.find((group) => group.modes.includes("quick-play"));
    expect(home?.title).toBe("Solo, against the dealer");
  });

  it("never uses wording that implies company, anywhere it is described", () => {
    for (const mode of MODES.filter((candidate) => candidate.participants !== "people")) {
      const spoken = modeAccessibilityLabel({
        title: mode.title,
        availability: mode.availability,
        purpose: mode.purpose,
        structure: mode.structure,
        facts: modeFacts(mode),
        playable: true,
      });
      for (const text of [mode.title, mode.purpose, mode.structure, modeFacts(mode), spoken]) {
        expect(text, `${mode.id}: ${text}`).not.toMatch(MULTIPLAYER_WORDING);
      }
    }
    expect(modeFacts(quick)).toMatch(/^Solo · /);
  });

  /** Positive control: the pattern above does catch the wording it exists for. */
  it("would catch the wording it guards against", () => {
    expect(modeFacts(PLAY_MODES["public-table"])).toMatch(MULTIPLAYER_WORDING);
    expect("Quick Play with other players").toMatch(MULTIPLAYER_WORDING);
  });
});

describe("AI Tables are described accurately", () => {
  const ai = PLAY_MODES["ai-table"];

  it("states computer players, the table chips and that nothing counts", () => {
    expect(ai.availability).toBe("online");
    expect(modeFacts(ai)).toBe(
      "With computer players · Table chips only · Unranked: no XP, statistics or accuracy",
    );
    // Matched by tests/e2e/ai-table.yaml as ".*AI Table.*computer players.*".
    expect(`${ai.title} ${ai.purpose}`).toMatch(/AI Table.*computer players/);
  });

  it("summarises the section from the engine's seat count and the closed economy", () => {
    expect(AI_TABLES_SUMMARY).toContain(`${AI_TABLE_SEAT_COUNT - 1} computer players`);
    expect(AI_TABLES_SUMMARY).toContain("labelled AI");
    expect(AI_TABLES_SUMMARY).toContain("on the server");
    expect(AI_TABLES_SUMMARY).toContain("Unranked");
    expect(AI_TABLES_SUMMARY).toContain("nothing moves to or from your balance");
  });
});

// ---------------------------------------------------------------------------

describe("whether online play can be offered", () => {
  const base = { configured: true, hasPlayer: true, offline: false, serverUnreached: false, connecting: false };

  it("is ready only for a server-confirmed player whose server is answering", () => {
    expect(onlineAvailability(base).kind).toBe("ready");
    expect(onlineAvailability({ ...base, hasPlayer: false }).kind).toBe("disconnected");
    expect(onlineAvailability({ ...base, offline: true }).kind).toBe("offline");
    expect(onlineAvailability({ ...base, configured: false }).kind).toBe("unconfigured");
  });

  it("names a bootstrap that could not reach the server as the server not answering", () => {
    // Measured on the iPhone 17e with the gateway stopped: an EXISTING player's
    // one failed bootstrap is one transport failure, the connectivity store
    // waits for two before it calls itself offline, and the card told that
    // player "Online tables need your player identity" above the bootstrap's own
    // "Could not reach the server". The reason is the server, not the player.
    for (const state of [
      { ...base, hasPlayer: false, serverUnreached: true },
      { ...base, serverUnreached: true },
    ]) {
      const result = onlineAvailability(state);
      expect(result.kind).toBe("offline");
      expect(result.kind !== "ready" && result.message).not.toMatch(/player identity/);
    }
    // A player the server has never answered for, with the server answering, is
    // still told what connecting does.
    expect(onlineAvailability({ ...base, hasPlayer: false }).kind).toBe("disconnected");
  });

  it("says a player is still connecting rather than that they are not", () => {
    expect(onlineAvailability({ ...base, hasPlayer: false, connecting: true }).kind).toBe("connecting");
  });

  it("names what still works whenever online play cannot open", () => {
    for (const state of [
      { ...base, configured: false },
      { ...base, offline: true },
      { ...base, hasPlayer: false, serverUnreached: true },
      { ...base, hasPlayer: false },
      { ...base, hasPlayer: false, connecting: true },
    ]) {
      const result = onlineAvailability(state);
      expect(result.kind).not.toBe("ready");
      if (result.kind !== "ready") expect(result.message).toMatch(/Practice, Career and Learn/);
    }
  });

  it("states an unconfigured build in the words the audit flow matches", () => {
    const result = onlineAvailability({ ...base, configured: false });
    // tests/e2e/every-screen.yaml asserts ".*no server configured.*" on Play.
    expect(result.kind === "unconfigured" && result.message).toMatch(/no server configured/);
  });
});

describe("the return to a held seat", () => {
  const ready = (session: ActiveSession | null): ActiveSessionStatus => ({ kind: "ready", session });

  it("offers the table the server says the player is still at", () => {
    expect(homeResume(ready(SEAT), true)).toEqual({ kind: "seated", session: SEAT });
  });

  it("says nothing when the server confirms there is no seat", () => {
    expect(homeResume(ready(null), true)).toEqual({ kind: "none" });
  });

  /** "We could not find out" is not "you are not at a table". */
  it("never reads an unanswered lookup as no seat", () => {
    for (const reason of ["unreachable", "signed-out", "not-configured"] as const) {
      expect(homeResume({ kind: "unavailable", reason }, true)).toEqual({ kind: "unknown" });
    }
  });

  it("does not claim anything while the lookup is still out", () => {
    expect(homeResume({ kind: "loading" }, true)).toEqual({ kind: "none" });
    expect(homeResume({ kind: "idle" }, true)).toEqual({ kind: "none" });
  });

  /**
   * The store is a module-level cache. A reading held from before the current
   * player was confirmed — or from a player who has since been replaced — is not
   * a fact about whoever is looking at Home now.
   */
  it("shows no seat to anybody who is not a ready player", () => {
    expect(homeResume(ready(SEAT), false)).toEqual({ kind: "none" });
    expect(homeResume({ kind: "unavailable", reason: "unreachable" }, false)).toEqual({ kind: "none" });
  });
});

describe("Home's layout", () => {
  const layout = (online: OnlineAvailability, resume = homeResume({ kind: "idle" }, false)) =>
    homeLayout({ online, resume, hasCareer: true, hasMastery: true });

  it("leads a ready player with chip tables, then AI Tables, then Practice", () => {
    const blocks = layout(READY);
    expect(blocks).toEqual(["chip-tables", "ai-table", "practice", "career", "mastery", "links"]);
  });

  it("never lets a lower tier rise above a higher one for a ready player", () => {
    const tiers = layout(READY)
      .map(tierIndex)
      .filter((index): index is number => index !== null);
    expect(tiers).toEqual([...tiers].sort((a, b) => a - b));
    expect(tiers[0]).toBe(0);
  });

  it("puts a held seat above everything, because every new table is refused until it is resolved", () => {
    const blocks = layout(READY, { kind: "seated", session: SEAT });
    expect(blocks[0]).toBe("resume");
    expect(blocks.indexOf("chip-tables")).toBe(1);
  });

  it("says when it could not check for a held seat", () => {
    expect(layout(READY, { kind: "unknown" })[0]).toBe("resume-unknown");
  });

  it("leads with Practice whenever online play cannot open", () => {
    for (const online of [
      UNCONFIGURED,
      OFFLINE,
      onlineAvailability({ configured: true, hasPlayer: false, offline: false, serverUnreached: false, connecting: true }),
      onlineAvailability({ configured: true, hasPlayer: false, offline: false, serverUnreached: false, connecting: false }),
      onlineAvailability({ configured: true, hasPlayer: false, offline: false, serverUnreached: true, connecting: false }),
    ]) {
      const blocks = layout(online);
      expect(blocks[0], online.kind).toBe("practice");
      expect(blocks[1], online.kind).toBe("online-unavailable");
      expect(blocks, online.kind).not.toContain("chip-tables");
      expect(blocks, online.kind).not.toContain("ai-table");
    }
  });

  it("keeps Practice on Home in every layout", () => {
    for (const online of [READY, OFFLINE, UNCONFIGURED]) {
      expect(layout(online)).toContain("practice");
    }
  });

  it("omits Career and mastery only when there is nothing to show", () => {
    expect(
      homeLayout({ online: READY, resume: { kind: "none" }, hasCareer: false, hasMastery: false }),
    ).toEqual(["chip-tables", "ai-table", "practice", "links"]);
  });

  it("keeps the Daily Challenge and the Sprint reachable from Home in both layouts", () => {
    const ready = [...HOME_CHIP_FORMAT_LINKS, ...homeLinks(READY)].map((link) => link.id);
    const fallback = homeLinks(UNCONFIGURED).map((link) => link.id);
    for (const ids of [ready, fallback]) {
      expect(ids).toEqual(expect.arrayContaining(["daily", "sprint", "learn", "friends", "leaderboards"]));
    }
    // And never twice on one screen.
    expect(new Set(ready).size).toBe(ready.length);
  });
});

describe("what a screen reader hears", () => {
  it("is told every fact a Play card shows, in the order it shows them", () => {
    for (const mode of MODES) {
      const spoken = modeAccessibilityLabel({
        title: mode.title,
        availability: mode.availability,
        purpose: mode.purpose,
        structure: mode.structure,
        facts: modeFacts(mode),
        playable: true,
      });
      const parts = [
        mode.title,
        modeBadge(mode.availability).label,
        mode.purpose.replace(/\.$/, ""),
        mode.structure,
        modeFacts(mode),
      ];
      let cursor = 0;
      for (const part of parts) {
        const found = spoken.indexOf(part, cursor);
        expect(found, `${mode.id} is missing or reorders "${part}" in "${spoken}"`).toBeGreaterThanOrEqual(cursor);
        cursor = found + part.length;
      }
    }
  });

  it("hears a compact link's detail, not only its name", () => {
    for (const link of [...PLAY_SUPPORT_LINKS, ...HOME_CHIP_FORMAT_LINKS, ...homeLinks(UNCONFIGURED)]) {
      const spoken = linkAccessibilityLabel(link);
      expect(spoken).toContain(link.label);
      expect(spoken).toContain(link.detail);
    }
  });

  // Per screen: Play and Home share link objects on purpose, so one id may
  // appear on both, but never twice on the same screen.
  it("gives every section and link a distinct test id on each screen", () => {
    const play = [
      ...PLAY_SECTIONS.map((section) => section.testID),
      ...PLAY_SUPPORT_LINKS.map((link) => link.testID),
    ];
    const homeReady = [...HOME_CHIP_FORMAT_LINKS, ...homeLinks(READY)].map((link) => link.testID);
    const homeFallback = homeLinks(UNCONFIGURED).map((link) => link.testID);
    for (const ids of [play, homeReady, homeFallback]) {
      expect(new Set(ids).size).toBe(ids.length);
    }
  });
});
