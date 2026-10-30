/**
 * Arc 21 — what the app is FOR, in the order it says it.
 *
 * Refresh D's product hierarchy, stated once and rendered by both Home and
 * Play:
 *
 *   1. CHIP GAMES — tables with other people first, then solo chip play.
 *   2. AI TABLES — computer players, labelled AI, unranked, table chips only.
 *   3. PRACTICE AND PROGRESS — offline Practice, Career and learning.
 *
 * ── Why the claims are FIELDS rather than prose ─────────────────────────────
 *
 * The Play tab's whole job is saying who is at a table, whose chips are at
 * stake and whether a hand counts for anything. Written as free sentences,
 * those claims drift from what the server enforces one edit at a time — the
 * leave confirmation promised "N chips return to your balance" at every table
 * until Refresh C, including the ones whose chips cannot leave. So each mode
 * carries classified fields, the sentences are composed FROM them, and
 * `tests/home/product-hierarchy.test.ts` holds every field against the
 * server's own lists: `WALLET_BACKED_MODES`, `SETTLEMENT_RECORDING_MODES`,
 * `ACCURACY_ELIGIBLE_MODES`, and which tables carry a clock (a clock exists
 * because somebody else is waiting on you).
 *
 * ── Why Home has two layouts ─────────────────────────────────────────────────
 *
 * The connected order leads with chip play. A player the SERVER has not
 * confirmed — no configuration, no answer, or a credential still being checked
 * — cannot open any of it, so the working thing leads instead: Practice. The
 * specification's own rule ("Quick Play online CTA becomes Practice"), extended
 * to the whole first two tiers. Both layouts keep every mode reachable.
 *
 * Pure and free of React Native, so all of the above is testable under Node.
 */

import {
  AI_TABLE_SEAT_COUNT,
  AI_TABLE_STACK,
  PRIVATE_TABLE_STACK,
} from "../../../shared/blackjack/rules.js";
import { CAREER_CHAPTERS, CAREER_NODES } from "../../../shared/career/nodes.js";
import { formatChips } from "../../design/format-chips.js";
import type { ActiveSessionStatus } from "../table/active-session-store.js";
import type { ActiveSession, ActiveSessionMode } from "../table/active-session.js";
import type { ModeAvailability } from "./play-mode-presentation.js";

// ---------------------------------------------------------------------------
// Tiers
// ---------------------------------------------------------------------------

export type ProductTier = "chips" | "ai" | "practice";

/** The product order. Every surface that lists modes lists them in this order. */
export const PRODUCT_TIER_ORDER: readonly ProductTier[] = ["chips", "ai", "practice"];

// ---------------------------------------------------------------------------
// What a mode claims
// ---------------------------------------------------------------------------

/**
 * Who else is at the table. `people` means other PEOPLE, live, at the same
 * table — never a leaderboard of strangers who played the same shoe alone.
 */
export type Participants = "people" | "solo" | "computer";

/** Whose chips are at stake, in the terms the server settles them. */
export type ChipStake =
  /** A buy-in leaves the wallet; what is left comes back on leaving. */
  | "wallet-buy-in"
  /** A fixed entry fee leaves the wallet; the stack itself never enters it. */
  | "wallet-entry-fee"
  /** Chips created at the table and ended with it. Nothing in or out. */
  | "table-chips"
  /** A scoring stack with no buy-in. */
  | "scoring-stack"
  /** Device-local, disposable. */
  | "practice-chips";

/** What a hand there counts toward on the server. */
export type Recording = "xp-stats-accuracy" | "xp-stats" | "none";

export type PlayModeId =
  | "public-table"
  | "private-table"
  | "sprint"
  | "quick-play"
  | "daily"
  | "ai-table"
  | "practice"
  | "career";

export interface PlayMode {
  readonly id: PlayModeId;
  readonly tier: ProductTier;
  readonly title: string;
  readonly purpose: string;
  readonly structure: string;
  readonly availability: ModeAvailability;
  /** The mode's own entry screen. Never the table itself: setup comes first. */
  readonly route: string;
  /** The server session mode a seat here is held in, or null for none. */
  readonly sessionMode: ActiveSessionMode | null;
  readonly participants: Participants;
  /** Null where no chips are staked at all. */
  readonly chips: ChipStake | null;
  /** Null for a mode the server never sees. */
  readonly recording: Recording | null;
}

export const PLAY_MODES: Readonly<Record<PlayModeId, PlayMode>> = {
  "public-table": {
    id: "public-table",
    tier: "chips",
    title: "Public Table",
    purpose: "Two to five players sharing one dealer and one shoe.",
    structure: "2–5 seats · Casual, Standard or High stakes",
    availability: "online",
    route: "/table/public",
    sessionMode: "public_table",
    participants: "people",
    chips: "wallet-buy-in",
    recording: "xp-stats-accuracy",
  },
  "private-table": {
    id: "private-table",
    tier: "chips",
    title: "Private Table",
    purpose: "Open a table for friends, or join one with a code.",
    structure: `2–5 seats · ${formatChips(PRIVATE_TABLE_STACK)} table chips each`,
    availability: "online",
    route: "/table/lobby",
    sessionMode: "private_table",
    participants: "people",
    chips: "table-chips",
    recording: "xp-stats",
  },
  sprint: {
    id: "sprint",
    tier: "chips",
    title: "Sprint Tournament",
    purpose: "Four players, equal stacks, twelve hands.",
    structure: "12 hands · 500 entry · elimination after hand 6",
    availability: "online",
    route: "/tournament",
    sessionMode: "tournament",
    participants: "people",
    chips: "wallet-entry-fee",
    recording: "xp-stats",
  },
  "quick-play": {
    id: "quick-play",
    tier: "chips",
    title: "Quick Play",
    purpose: "Just you and the dealer, at a table of your own.",
    structure: "Casual, Standard or High stakes",
    availability: "online",
    route: "/table/quick",
    sessionMode: "solo",
    participants: "solo",
    chips: "wallet-buy-in",
    recording: "xp-stats-accuracy",
  },
  daily: {
    id: "daily",
    tier: "chips",
    title: "Daily Challenge",
    purpose: "Everyone is dealt the same shoe, and you play it on your own.",
    structure: "20 hands · one ranked attempt a day",
    availability: "online",
    route: "/daily",
    sessionMode: "daily_challenge",
    participants: "solo",
    chips: "scoring-stack",
    recording: "xp-stats-accuracy",
  },
  "ai-table": {
    id: "ai-table",
    tier: "ai",
    title: "AI Table",
    // "computer players" is matched by `tests/e2e/ai-table.yaml`.
    purpose: "You and computer players, each one marked AI, at one table.",
    structure: `${AI_TABLE_SEAT_COUNT} seats · ${formatChips(AI_TABLE_STACK)} table chips each`,
    availability: "online",
    route: "/table/ai",
    sessionMode: "ai_table",
    participants: "computer",
    chips: "table-chips",
    recording: "none",
  },
  practice: {
    id: "practice",
    tier: "practice",
    title: "Practice",
    purpose: "Play as long as you like with disposable chips.",
    structure: "Unlimited hands · resettable bankroll",
    availability: "offline",
    route: "/game/practice",
    sessionMode: null,
    participants: "solo",
    chips: "practice-chips",
    recording: null,
  },
  career: {
    id: "career",
    tier: "practice",
    title: "Career",
    purpose: `${CAREER_NODES.length} challenges that build correct decisions.`,
    structure: `${CAREER_CHAPTERS.length} chapters · ${CAREER_NODES.length} nodes · up to 3 stars each`,
    availability: "offline",
    route: "/career",
    sessionMode: "career",
    participants: "solo",
    chips: null,
    recording: null,
  },
};

const PARTICIPANTS_COPY: Readonly<Record<Participants, string>> = {
  people: "With other players",
  solo: "Solo",
  computer: "With computer players",
};

const STAKE_COPY: Readonly<Record<ChipStake, string>> = {
  "wallet-buy-in": "Buy-in from your chips",
  "wallet-entry-fee": "Entry fee from your chips",
  "table-chips": "Table chips only",
  "scoring-stack": "No buy-in",
  "practice-chips": "Practice chips, kept on this device",
};

const RECORDING_COPY: Readonly<Record<Recording, string>> = {
  "xp-stats-accuracy": "Counts toward XP, statistics and accuracy",
  "xp-stats": "Counts toward XP and statistics",
  none: "Unranked: no XP, statistics or accuracy",
};

/** The one line that states who is there, whose chips and what it counts toward. */
export function modeFacts(mode: PlayMode): string {
  const parts = [PARTICIPANTS_COPY[mode.participants]];
  if (mode.chips !== null) parts.push(STAKE_COPY[mode.chips]);
  if (mode.recording !== null) parts.push(RECORDING_COPY[mode.recording]);
  return parts.join(" · ");
}

const STAKE_SENTENCE: Readonly<Record<ChipStake, string>> = {
  "wallet-buy-in": "The buy-in comes from your chips, and what is left comes back when you leave.",
  "wallet-entry-fee": "The entry fee comes from your chips; the tournament stack never enters your balance.",
  "table-chips": "It uses its own table chips, so nothing moves to or from your balance.",
  "scoring-stack": "There is no buy-in: the stack is for scoring only.",
  "practice-chips": "Its chips stay on this device and never touch your balance.",
};

/** The same stake as `modeFacts`, as a sentence for a card that has room for one. */
export function stakeSentence(mode: PlayMode): string | null {
  return mode.chips === null ? null : STAKE_SENTENCE[mode.chips];
}

/*
 * "Unranked" belongs only to a table that records nothing. Every recorded hand
 * pays repeatable XP, and the weekly XP board sums that XP across every mode,
 * so a private hand does reach a leaderboard — the private lobby once said
 * otherwise.
 */
const RECORDING_SENTENCE: Readonly<Record<Recording, string>> = {
  "xp-stats-accuracy":
    "Hands here earn XP for the weekly XP leaderboard and count toward your statistics and strategy accuracy.",
  "xp-stats":
    "Hands here earn XP for the weekly XP leaderboard and count toward your statistics, but not toward strategy accuracy.",
  none: "Unranked: hands here earn no XP and count toward no statistics or accuracy.",
};

/** The same recording as `modeFacts`, as a sentence for a card that has room for one. */
export function recordingSentence(mode: PlayMode): string | null {
  return mode.recording === null ? null : RECORDING_SENTENCE[mode.recording];
}

// ---------------------------------------------------------------------------
// The Play tab
// ---------------------------------------------------------------------------

export interface PlayGroup {
  /** A subheading inside a section, or null for a section with one group. */
  readonly title: string | null;
  readonly modes: readonly PlayModeId[];
}

export interface PlaySection {
  readonly tier: ProductTier;
  readonly title: string;
  readonly summary: string;
  readonly groups: readonly PlayGroup[];
  readonly testID: string;
}

export const AI_TABLES_SUMMARY =
  `You and ${AI_TABLE_SEAT_COUNT - 1} computer players, each labelled AI, ` +
  "deciding and dealt on the server from the same fair shoe. Unranked, with " +
  "table chips only: nothing moves to or from your balance.";

export const PLAY_SECTIONS: readonly PlaySection[] = [
  {
    tier: "chips",
    title: "Play for chips",
    summary:
      "Dealt on the server. Each table says who you are playing with and whose chips are at stake.",
    groups: [
      { title: "With other people", modes: ["public-table", "private-table", "sprint"] },
      { title: "Solo, against the dealer", modes: ["quick-play", "daily"] },
    ],
    testID: "play-section-chips",
  },
  {
    tier: "ai",
    title: "AI Tables",
    summary: AI_TABLES_SUMMARY,
    groups: [{ title: null, modes: ["ai-table"] }],
    testID: "play-section-ai",
  },
  {
    tier: "practice",
    title: "Practice and progress",
    summary: "Practice, Career and Learn work offline. Leaderboards show where online play has put you.",
    groups: [{ title: null, modes: ["practice", "career"] }],
    testID: "play-section-practice",
  },
];

/** A compact link to a destination that is not a game mode. */
export interface ProductLink {
  readonly id: string;
  readonly label: string;
  readonly detail: string;
  readonly route: string;
  readonly testID: string;
}

const LEARN_LINK: ProductLink = {
  id: "learn",
  label: "Learn",
  detail: "Rules, strategy guide and drills, offline",
  route: "/(tabs)/learn",
  testID: "link-learn",
};

const LEADERBOARDS_LINK: ProductLink = {
  id: "leaderboards",
  label: "Leaderboards",
  detail: "Weekly standings",
  route: "/leaderboards",
  testID: "link-leaderboards",
};

const FRIENDS_LINK: ProductLink = {
  id: "friends",
  label: "Friends",
  detail: "Requests and presence",
  route: "/(tabs)/social",
  testID: "link-friends",
};

const DAILY_LINK: ProductLink = {
  id: "daily",
  label: "Daily Challenge",
  detail: "Solo · same shoe for everyone",
  route: "/daily",
  testID: "link-daily",
};

const SPRINT_LINK: ProductLink = {
  id: "sprint",
  label: "Sprint Tournament",
  detail: "Four players · 12 hands",
  route: "/tournament",
  testID: "link-sprint",
};

/** Under the Practice and progress section on Play. */
export const PLAY_SUPPORT_LINKS: readonly ProductLink[] = [LEARN_LINK, LEADERBOARDS_LINK];

// ---------------------------------------------------------------------------
// Whether online play can be offered at all
// ---------------------------------------------------------------------------

export type OnlineAvailability =
  | { readonly kind: "ready" }
  | {
      readonly kind: "unconfigured" | "offline" | "connecting" | "disconnected";
      readonly message: string;
    };

/**
 * Ready means the SERVER has vouched for a player and is still answering.
 *
 * `hasPlayer` must come from the auth store's `session`, which the adapter sets
 * only once the server has answered for the credential (B-G1) — a credential
 * restored from the keychain is not a player until then. Offline wins over a
 * confirmed player, because a confirmed player whose server has stopped
 * answering cannot open a table either.
 *
 * `serverUnreached` is the auth bootstrap's own answer — its last attempt could
 * not reach the server — and it counts as offline too. The connectivity store
 * calls itself offline only after TWO transport failures in a row, and a failed
 * bootstrap is one, so without this an existing player whose server had
 * stopped answering was told that online tables "need your player identity".
 */
export function onlineAvailability(input: {
  readonly configured: boolean;
  readonly hasPlayer: boolean;
  readonly offline: boolean;
  readonly serverUnreached: boolean;
  readonly connecting: boolean;
}): OnlineAvailability {
  if (!input.configured) {
    return {
      kind: "unconfigured",
      message:
        "This build has no server configured, so online tables cannot open here. " +
        "Practice, Career and Learn work without one.",
    };
  }
  if (input.offline || input.serverUnreached) {
    return {
      kind: "offline",
      message:
        "The Arc 21 server is not answering, so online tables cannot open right now. " +
        "Practice, Career and Learn keep working.",
    };
  }
  if (input.hasPlayer) return { kind: "ready" };
  if (input.connecting) {
    return {
      kind: "connecting",
      message: "Connecting your player for online play. Practice, Career and Learn work offline.",
    };
  }
  return {
    kind: "disconnected",
    message:
      "Online tables need your player identity, which connects without an email or password. " +
      "Practice, Career and Learn work offline.",
  };
}

// ---------------------------------------------------------------------------
// Returning to a held seat
// ---------------------------------------------------------------------------

export type HomeResume =
  | { readonly kind: "none" }
  | { readonly kind: "seated"; readonly session: ActiveSession }
  /** The lookup failed. NOT the same as "no seat", and never rendered as one. */
  | { readonly kind: "unknown" };

/**
 * What Home says about a held seat.
 *
 * Asked only for a ready player: the active-session store is a module-level
 * cache, and a reading taken for somebody who is no longer the confirmed player
 * — or before anybody was — is not a fact about whoever is looking at Home now.
 * `resetPlayerState` clears it on a player change as well; this is the second
 * lock, at the place the value is shown.
 */
export function homeResume(status: ActiveSessionStatus, playerReady: boolean): HomeResume {
  if (!playerReady) return { kind: "none" };
  switch (status.kind) {
    case "ready":
      return status.session === null ? { kind: "none" } : { kind: "seated", session: status.session };
    case "unavailable":
      return { kind: "unknown" };
    case "idle":
    case "loading":
      return { kind: "none" };
  }
}

// ---------------------------------------------------------------------------
// Home
// ---------------------------------------------------------------------------

export type HomeBlock =
  | "resume"
  | "resume-unknown"
  | "chip-tables"
  | "ai-table"
  | "practice"
  | "online-unavailable"
  | "career"
  | "mastery"
  | "links";

/** Which tier each Home block belongs to, or null for one outside the hierarchy. */
export const HOME_BLOCK_TIER: Readonly<Record<HomeBlock, ProductTier | null>> = {
  resume: null,
  "resume-unknown": null,
  "chip-tables": "chips",
  "ai-table": "ai",
  practice: "practice",
  "online-unavailable": null,
  career: "practice",
  mastery: "practice",
  links: null,
};

/**
 * Home, top to bottom.
 *
 * A held seat goes first in either layout it can appear in: while it is held
 * the server refuses every new table, so offering one above it would be
 * offering a refusal.
 */
export function homeLayout(input: {
  readonly online: OnlineAvailability;
  readonly resume: HomeResume;
  readonly hasCareer: boolean;
  readonly hasMastery: boolean;
}): HomeBlock[] {
  const blocks: HomeBlock[] = [];
  if (input.resume.kind === "seated") blocks.push("resume");
  if (input.resume.kind === "unknown") blocks.push("resume-unknown");

  if (input.online.kind === "ready") {
    blocks.push("chip-tables", "ai-table", "practice");
  } else {
    blocks.push("practice", "online-unavailable");
  }

  if (input.hasCareer) blocks.push("career");
  if (input.hasMastery) blocks.push("mastery");
  blocks.push("links");
  return blocks;
}

/**
 * The formats inside Home's chip block, beside the two table cards. Shown as
 * links rather than cards so Home stays a home base and not a second Play tab.
 */
export const HOME_CHIP_FORMAT_LINKS: readonly ProductLink[] = [DAILY_LINK, SPRINT_LINK];

/**
 * The compact links at the bottom of Home.
 *
 * Without a ready player the chip block is not shown, so its two formats move
 * here: their screens state plainly what they need, and nothing that exists
 * becomes unreachable from Home.
 */
export function homeLinks(online: OnlineAvailability): readonly ProductLink[] {
  return online.kind === "ready"
    ? [LEARN_LINK, FRIENDS_LINK, LEADERBOARDS_LINK]
    : [LEARN_LINK, DAILY_LINK, SPRINT_LINK, FRIENDS_LINK, LEADERBOARDS_LINK];
}

/**
 * Link tiles, `perRow` to a row: two across at ordinary sizes, and one each at
 * an accessibility size, where half a card no longer holds a word — the iPhone
 * 17e drew "Lear / n" and "Chall / enge" two across. The screens choose with
 * `rowStacksAtFontScale`, the same predicate the screen header reflows on.
 */
export function inRows<T>(items: readonly T[], perRow: number): T[][] {
  const rows: T[][] = [];
  for (let index = 0; index < items.length; index += perRow) rows.push(items.slice(index, index + perRow));
  return rows;
}

/** What a screen reader hears for a compact link: everything the tile shows. */
export function linkAccessibilityLabel(link: Pick<ProductLink, "label" | "detail">): string {
  return `${link.label}. ${link.detail}.`;
}
