/**
 * One other player's profile, as this caller may see it.
 *
 * The specification's FRIEND PROFILE list is nine things — avatar, display
 * name, username, level, presence, public stats according to privacy setting,
 * career stars, tournament wins, Invite to Table — and until this file the
 * screen showed four of them plus a last-seen line. There was no client-side
 * source for the rest: `my_competition_record` and `my_career_progress` both
 * derive from `auth.uid()` and answer only about the caller, correctly.
 * `public.player_public_profile(uuid)` is the read this parses.
 *
 * TWO RULES ARE CARRIED HERE RATHER THAN INFERRED AT THE SCREEN.
 *
 * The first is that VISIBILITY IS THE SERVER'S ANSWER, not a comparison the
 * client makes. `stats_visible` comes back already decided from
 * `profiles.privacy` plus the friendship, and every number is NULL when it is
 * false. A client that re-derived it from `privacy` and `is_friend` would be a
 * second implementation of a privacy rule, and the two would eventually
 * disagree — with the client's version being the one a player sees.
 *
 * The second is that A MISSING RECORD IS NOT A RECORD OF ZERO. The RPC returns
 * NULL, not 0, wherever the record is hidden, and `null` survives into
 * `PlayerProfile` for the same reason Statistics says "no record" instead of
 * rendering zeroes. `hasRecord` distinguishes the third case — visible, but
 * they have genuinely never played — so the screen can say that too.
 *
 * Pure and free of React Native, so all of it is provable under Node. No chip
 * balance appears anywhere in this file: a wallet is nobody else's business and
 * the RPC does not return one.
 */

import { z } from "zod";

import type { PresenceState } from "../presence/presence.js";
import { describeLastSeen } from "./friends.js";

/** Matches `profiles.privacy`. */
export type ProfilePrivacy = "public" | "friends" | "private";

/** The record half of a profile. Present only when the server disclosed it. */
export interface PlayerRecord {
  readonly handsPlayed: number;
  readonly handsWon: number;
  readonly handsPushed: number;
  readonly decisionsTotal: number;
  readonly decisionsOptimal: number;
  readonly careerStars: number;
  readonly careerNodesCompleted: number;
  readonly tournamentsEntered: number;
  readonly tournamentWins: number;
}

export interface PlayerProfile {
  readonly userId: string;
  readonly username: string;
  readonly displayName: string;
  readonly avatarUrl: string | null;
  readonly countryCode: string | null;
  readonly level: number;
  readonly privacy: ProfilePrivacy;
  readonly isFriend: boolean;
  /** The server's verdict. Never recomputed from `privacy` and `isFriend`. */
  readonly statsVisible: boolean;
  /** `null` when the record is not visible to this caller. */
  readonly record: PlayerRecord | null;
  readonly lastSeenAt: string;
}

const uuid = z.string().uuid();
const counter = z.number().int().nonnegative().nullable();

export const playerProfileRowSchema = z.object({
  user_id: uuid,
  username: z.string().min(1),
  display_name: z.string().min(1),
  avatar_url: z.string().nullable().optional(),
  country_code: z.string().nullable().optional(),
  level: z.number().int().nonnegative(),
  privacy: z.enum(["public", "friends", "private"]),
  is_friend: z.boolean(),
  stats_visible: z.boolean(),
  hands_played: counter,
  hands_won: counter,
  hands_pushed: counter,
  decisions_total: counter,
  decisions_optimal: counter,
  career_stars: counter,
  career_nodes_completed: counter,
  tournaments_entered: counter,
  tournament_wins: counter,
  last_seen_at: z.string().min(1),
});

/**
 * Parses the one row the RPC returns, or `null`.
 *
 * `null` covers three server answers that are deliberately indistinguishable —
 * a block in either direction, a user id that never existed, and a profile that
 * is gone. The screen must state one absence for all three, or the block
 * becomes discoverable by the person blocked.
 */
export function toPlayerProfile(value: unknown): PlayerProfile | null {
  const candidate = Array.isArray(value) ? value[0] : value;
  const parsed = playerProfileRowSchema.safeParse(candidate);
  if (!parsed.success) return null;
  const row = parsed.data;

  /*
   * The record is built only when the server said it is visible AND every
   * number arrived. A half-populated record would render some real figures
   * beside some invented zeroes, which is worse than showing none.
   */
  const numbers = [
    row.hands_played,
    row.hands_won,
    row.hands_pushed,
    row.decisions_total,
    row.decisions_optimal,
    row.career_stars,
    row.career_nodes_completed,
    row.tournaments_entered,
    row.tournament_wins,
  ];
  const complete = numbers.every((value) => value !== null);

  return {
    userId: row.user_id,
    username: row.username,
    displayName: row.display_name,
    avatarUrl: row.avatar_url ?? null,
    countryCode: row.country_code ?? null,
    level: row.level,
    privacy: row.privacy,
    isFriend: row.is_friend,
    statsVisible: row.stats_visible,
    record:
      row.stats_visible && complete
        ? {
            handsPlayed: row.hands_played ?? 0,
            handsWon: row.hands_won ?? 0,
            handsPushed: row.hands_pushed ?? 0,
            decisionsTotal: row.decisions_total ?? 0,
            decisionsOptimal: row.decisions_optimal ?? 0,
            careerStars: row.career_stars ?? 0,
            careerNodesCompleted: row.career_nodes_completed ?? 0,
            tournamentsEntered: row.tournaments_entered ?? 0,
            tournamentWins: row.tournament_wins ?? 0,
          }
        : null,
    lastSeenAt: row.last_seen_at,
  };
}

// ---------------------------------------------------------------------------
// Presence
// ---------------------------------------------------------------------------

/** The four values the specification names. */
export type ProfilePresence = "online" | "available" | "in_game" | "offline";

export interface PresencePresentation {
  readonly presence: ProfilePresence;
  readonly label: string;
  /** Always shown, because a live state is a claim about *now* and nothing else. */
  readonly detail: string;
  /** True only for a claim the connection itself is making. */
  readonly live: boolean;
}

/**
 * What to say about where somebody is.
 *
 * ABSENCE FROM THE CHANNEL IS NOT PROOF OF BEING OFFLINE, and this is the whole
 * subtlety. The presence channel is joined by a signed-in client; a player on a
 * flaky connection, or one whose app is backgrounded, is missing from it while
 * being perfectly awake. So `offline` is reported with the last-seen line beside
 * it rather than on its own, and `live` says which of the two the label rests
 * on. `describePresence` in the presence module answers the same question for a
 * LIST ROW and returns `null` for "not on the channel"; this returns the fourth
 * value instead, because a profile has room to explain itself and a list row
 * does not.
 *
 * `available` and `online` are both in the specification's list and mean the
 * same thing to a viewer — signed in, not at a table. One word is shown;
 * `presence` keeps both so a caller that needs the distinction has it.
 */
export function presentPresence(
  state: PresenceState | undefined,
  lastSeenAt: string,
  now: Date,
): PresencePresentation {
  const seen = describeLastSeen(lastSeenAt, now);

  if (state === "in_game") {
    return { presence: "in_game", label: "In a game", detail: seen, live: true };
  }
  if (state === "available") {
    return { presence: "available", label: "Online", detail: seen, live: true };
  }
  return {
    presence: "offline",
    label: "Offline",
    // Said plainly, because the app cannot tell "signed out" from "signed in
    // with no connection" and must not imply it can.
    detail: `${seen}. Presence needs a live connection, so someone with a poor one shows as offline.`,
    live: false,
  };
}

// ---------------------------------------------------------------------------
// The record, as rows
// ---------------------------------------------------------------------------

export interface StatRow {
  readonly key: string;
  readonly label: string;
  readonly value: string;
}

/**
 * Why a record is not being shown, in that player's own terms.
 *
 * Never "you are not allowed": the setting belongs to the person being looked
 * at, and phrasing it as a refusal aimed at the viewer invites them to think
 * they did something wrong.
 */
export function describeHiddenRecord(profile: PlayerProfile): string {
  if (profile.privacy === "private") {
    return `${profile.displayName} keeps their record private, so none of it is shown here.`;
  }
  if (profile.privacy === "friends" && !profile.isFriend) {
    return `${profile.displayName} shows their record to friends only.`;
  }
  // `public` and still hidden should not happen; if the server ever says so, say
  // that rather than inventing a reason for it.
  return `${profile.displayName}'s record is not being shown.`;
}

/** True when a visible record contains anything at all. */
export function hasRecord(record: PlayerRecord): boolean {
  return (
    record.handsPlayed > 0 ||
    record.decisionsTotal > 0 ||
    record.careerNodesCompleted > 0 ||
    record.tournamentsEntered > 0
  );
}

/**
 * A visible record as the rows a screen renders.
 *
 * Accuracy is omitted rather than shown as 0% when nothing has been graded —
 * a player with no ranked decisions has no accuracy, which is not the same as
 * being wrong every time. Same rule as Statistics.
 */
export function presentRecord(record: PlayerRecord): readonly StatRow[] {
  const rows: StatRow[] = [
    { key: "hands", label: "Hands played", value: record.handsPlayed.toLocaleString("en-US") },
    { key: "won", label: "Hands won", value: record.handsWon.toLocaleString("en-US") },
    { key: "pushed", label: "Hands pushed", value: record.handsPushed.toLocaleString("en-US") },
  ];

  if (record.decisionsTotal > 0) {
    const pct = (record.decisionsOptimal / record.decisionsTotal) * 100;
    rows.push({
      key: "accuracy",
      label: "Strategy accuracy",
      // One decimal, matching Statistics, and floored rather than rounded so a
      // player is never shown a figure above what they achieved.
      value: `${(Math.floor(pct * 10) / 10).toFixed(1)}%`,
    });
  }

  rows.push(
    {
      key: "stars",
      label: "Career stars",
      value: `${record.careerStars} from ${record.careerNodesCompleted} node${
        record.careerNodesCompleted === 1 ? "" : "s"
      }`,
    },
    {
      key: "wins",
      label: "Tournament wins",
      value: `${record.tournamentWins} from ${record.tournamentsEntered} entered`,
    },
  );

  return rows;
}
