/**
 * Arc 21 — user settings.
 *
 * This is the *whole* storage story for preferences: one typed record, one
 * validated envelope, written through the existing
 * `src/lib/persistence/key-value-store.ts`. There is deliberately no second
 * storage layer — a preference that lives in two places eventually disagrees
 * with itself, and the one the user last touched is not reliably the winner.
 *
 * A stored blob is UNTRUSTED INPUT, exactly like the Practice save: it may be
 * truncated, hand-edited, or written by a build whose settings differed. Every
 * load is validated and anything that fails falls back to defaults rather than
 * being handed half-decoded to the UI. Serialisation is pure so all of it can be
 * tested without a device — see `tests/stats/settings.test.ts`.
 *
 * Runtime-neutral: no React, React Native or Expo imports. The only import that
 * reaches outside this folder is a *type*, which is erased at compile time.
 */

import { z } from "zod";

import type { KeyValueStore } from "../../lib/persistence/key-value-store.js";
import type { AssistanceMode } from "../practice/practice-store.js";

/** Bump when the persisted shape changes incompatibly. */
export const SETTINGS_SCHEMA_VERSION = 1;

export const SETTINGS_KEY = "settings:v1";

/** Who may see your profile statistics once profiles exist. */
export type StatsVisibility = "public" | "friends" | "private";

export interface AppSettings {
  // Gameplay
  /** Assistance mode a new table starts in. */
  defaultAssistanceMode: AssistanceMode;
  /** Confirm before leaving a hand that is live on the server. */
  confirmLeavingOnlineGame: boolean;
  /** Larger rank/suit labels on the cards themselves. */
  largeCardLabels: boolean;

  // Audio
  soundEnabled: boolean;
  /**
   * Background music. Defaults OFF, and nothing may start it implicitly: an app
   * that begins playing music the moment it opens is a problem on a bus, in an
   * office, and for anyone who did not expect a card game to make noise.
   */
  musicEnabled: boolean;
  hapticsEnabled: boolean;

  // Accessibility
  /**
   * An app-level Reduce Motion override. The OS setting is read separately by
   * `useMotion()` and always wins: this can add reduction, never remove it.
   */
  reducedMotion: boolean;
  increasedContrast: boolean;
  largerTableText: boolean;

  // Notifications
  notificationsEnabled: boolean;
  notifyYourTurn: boolean;
  notifyFriendRequests: boolean;
  notifyDailyChallenge: boolean;

  // Privacy
  statsVisibility: StatsVisibility;
}

/**
 * Defaults chosen so the quietest, most private configuration is the one a
 * player gets without touching anything: music off, notifications off,
 * statistics private, no assistance at the table.
 */
export const DEFAULT_SETTINGS: AppSettings = {
  defaultAssistanceMode: "play",
  confirmLeavingOnlineGame: true,
  largeCardLabels: false,

  soundEnabled: true,
  musicEnabled: false,
  hapticsEnabled: true,

  reducedMotion: false,
  increasedContrast: false,
  largerTableText: false,

  notificationsEnabled: false,
  notifyYourTurn: false,
  notifyFriendRequests: false,
  notifyDailyChallenge: false,

  statsVisibility: "private",
};

/**
 * Exhaustive by construction: adding an assistance mode to the practice store's
 * union breaks this record, which is the point — a new mode must be given a
 * label here and a case in the stored enum below, rather than silently becoming
 * unselectable or unloadable.
 */
export const ASSISTANCE_MODE_LABELS: Record<AssistanceMode, string> = {
  play: "Play",
  learn: "Learn",
  analysis: "Analysis",
  challenge: "Challenge",
};

export const ASSISTANCE_MODE_HINTS: Record<AssistanceMode, string> = {
  play: "No assistance during the decision",
  learn: "Shows the recommended play",
  analysis: "Shows expected value for every legal action",
  challenge: "Grades each decision immediately after you make it",
};

/** Ordered for the picker. Derived from the labels so it cannot omit a mode. */
export const ASSISTANCE_MODES = Object.keys(ASSISTANCE_MODE_LABELS) as AssistanceMode[];

export const STATS_VISIBILITY_LABELS: Record<StatsVisibility, string> = {
  public: "Anyone",
  friends: "Friends only",
  private: "Only me",
};

/**
 * Only the unaided figure is ever published, whatever the visibility setting.
 *
 * Stated here rather than in the screen so the rule travels with the model: an
 * accuracy figure produced with the recommendation on screen would flatter a
 * profile without measuring anything, and it must not become a leaderboard.
 */
/**
 * What this control actually does, stated accurately.
 *
 * The second sentence used to read "Nothing on this device is uploaded today."
 * That was true when it was written and false by the time anyone read it: a
 * signed-in player's hands, decisions and standings are recorded on the server,
 * which is the whole reason leaderboards can be trusted. A privacy note is the
 * single worst place in a product for a sentence that has quietly expired.
 */
/*
 * WHAT THIS SENTENCE USED TO CLAIM, and why it is worded the way it is now.
 *
 * It read "who can see your profile and standings", and phase 10 measured what
 * `privacy = 'private'` actually does. Two of the three claims held and one did
 * not:
 *
 *   held    a direct read of `profiles` returns nothing to a stranger, and
 *           `player_public_profile` answers `stats_visible = false` with every
 *           statistic null rather than zero;
 *   did NOT the player is still on the global leaderboards under their display
 *           name — measured, a `private` account with 4,242 weekly XP was on
 *           the board a fresh stranger read — and still findable by handle in
 *           `search_players`.
 *
 * Both of those are the specification working. Its leaderboard section asks for
 * a global board of "avatar, display name, value" and forbids only exposing "a
 * private email or account identifier"; friend search is specified as "search
 * exact or partial username", and a player nobody can find is a player nobody
 * can befriend. Quietly narrowing either to fit a sentence would have broken a
 * specified feature to protect a wording.
 *
 * So the SENTENCE gave way, and it now says exactly what the column enforces.
 * "Standings" was the word doing the damage: a leaderboard placement is
 * precisely a standing, and it is the one thing this control has never governed.
 * `tests/settings/privacy-copy.test.ts` pins the claim to the enforcement.
 */
export const STATS_VISIBILITY_NOTE =
  "This controls who can see your statistics on your profile — hands, accuracy, " +
  "career and tournament record. It is sent to the server when you are signed in. " +
  "Your display name still appears on leaderboards and in player search. Practice " +
  "on this device is never uploaded and is not covered by this setting.";

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/**
 * Every field is optional so a blob written by an older build — one that
 * predates a setting added later — still loads, with the missing field taking
 * its default. Unknown keys are stripped, so a blob from a *newer* build
 * degrades instead of failing.
 *
 * A field that is present but of the wrong type is a different matter: that is
 * corruption or tampering, and the whole blob is rejected. Salvaging some
 * fields from a damaged record would produce a settings object that is part
 * real and part default with no way to tell which is which.
 */
const settingsSchema = z.object({
  defaultAssistanceMode: z.enum(["play", "learn", "analysis", "challenge"]).optional(),
  confirmLeavingOnlineGame: z.boolean().optional(),
  largeCardLabels: z.boolean().optional(),

  soundEnabled: z.boolean().optional(),
  musicEnabled: z.boolean().optional(),
  hapticsEnabled: z.boolean().optional(),

  reducedMotion: z.boolean().optional(),
  increasedContrast: z.boolean().optional(),
  largerTableText: z.boolean().optional(),

  notificationsEnabled: z.boolean().optional(),
  notifyYourTurn: z.boolean().optional(),
  notifyFriendRequests: z.boolean().optional(),
  notifyDailyChallenge: z.boolean().optional(),

  statsVisibility: z.enum(["public", "friends", "private"]).optional(),
});

const envelopeSchema = z.object({
  schemaVersion: z.number(),
  settings: settingsSchema,
});

export type SettingsLoadFailure =
  | "ABSENT"
  | "UNPARSEABLE"
  | "SCHEMA_MISMATCH"
  | "CORRUPT_FIELD";

export interface SettingsLoadResult {
  /** Always usable. Defaults when the stored value could not be trusted. */
  settings: AppSettings;
  /** Null on a clean load. `ABSENT` simply means nothing has been saved yet. */
  failure: SettingsLoadFailure | null;
}

export function serialiseSettings(settings: AppSettings): string {
  return JSON.stringify({
    schemaVersion: SETTINGS_SCHEMA_VERSION,
    settings: normaliseSettings(settings),
  });
}

export function deserialiseSettings(raw: string | null): SettingsLoadResult {
  if (raw === null) return { settings: { ...DEFAULT_SETTINGS }, failure: "ABSENT" };

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { settings: { ...DEFAULT_SETTINGS }, failure: "UNPARSEABLE" };
  }

  const envelope = envelopeSchema.safeParse(parsed);
  if (!envelope.success) {
    // Distinguish "this is not a settings blob at all" from "a field inside a
    // well-formed blob is the wrong type", because only the second is worth
    // treating as corruption of something that was once valid.
    const shell = z.object({
      schemaVersion: z.number(),
      settings: z.record(z.string(), z.unknown()),
    });
    return {
      settings: { ...DEFAULT_SETTINGS },
      failure: shell.safeParse(parsed).success ? "CORRUPT_FIELD" : "UNPARSEABLE",
    };
  }

  if (envelope.data.schemaVersion !== SETTINGS_SCHEMA_VERSION) {
    return { settings: { ...DEFAULT_SETTINGS }, failure: "SCHEMA_MISMATCH" };
  }

  return {
    settings: normaliseSettings({ ...DEFAULT_SETTINGS, ...envelope.data.settings }),
    failure: null,
  };
}

/**
 * Enforces the one cross-field invariant: the master notification switch really
 * is a master switch.
 *
 * Leaving per-category toggles on underneath a disabled master is how a UI ends
 * up promising a notification it will never send — and how a later refactor
 * accidentally starts sending them again.
 */
export function normaliseSettings(settings: AppSettings): AppSettings {
  if (settings.notificationsEnabled) return { ...settings };
  return {
    ...settings,
    notifyYourTurn: false,
    notifyFriendRequests: false,
    notifyDailyChallenge: false,
  };
}

/**
 * Plain-language explanation of a load failure, or null when there is nothing
 * worth telling the user.
 *
 * `ABSENT` is deliberately silent: "you have never changed a setting" is not a
 * problem, and announcing it would train people to ignore the one message that
 * does matter — that their saved preferences were discarded.
 */
export function describeSettingsFailure(failure: SettingsLoadFailure | null): string | null {
  switch (failure) {
    case null:
    case "ABSENT":
      return null;
    case "UNPARSEABLE":
      return "Your saved settings could not be read, so these are the defaults.";
    case "SCHEMA_MISMATCH":
      return "Your settings were saved by a different version of Arc 21, so these are the defaults.";
    case "CORRUPT_FIELD":
      return "Part of your saved settings was damaged, so these are the defaults.";
  }
}

// ---------------------------------------------------------------------------
// Durable storage
// ---------------------------------------------------------------------------

/**
 * Read/write of settings over the shared key/value store.
 *
 * A failed load never throws: settings that cannot be read must not stop the
 * app from opening, and defaults are always a usable answer.
 */
export class SettingsPersistence {
  constructor(private readonly store: KeyValueStore) {}

  async load(): Promise<SettingsLoadResult> {
    let raw: string | null;
    try {
      raw = await this.store.get(SETTINGS_KEY);
    } catch {
      return { settings: { ...DEFAULT_SETTINGS }, failure: "UNPARSEABLE" };
    }
    return deserialiseSettings(raw);
  }

  async save(settings: AppSettings): Promise<void> {
    await this.store.set(SETTINGS_KEY, serialiseSettings(settings));
  }

  async clear(): Promise<void> {
    await this.store.remove(SETTINGS_KEY);
  }
}
