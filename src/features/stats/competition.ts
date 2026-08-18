/**
 * Arc 21 — competitive record availability.
 *
 * Tournament placements, daily-challenge results and every ranked figure are
 * **server-owned** (see docs/ARCHITECTURE.md, "Authority boundaries"). A client
 * cannot compute them, cache them into existence, or derive them from local
 * play, and offline results never touch ranked progression.
 *
 * So the only honest thing a client can render without a server is *why* there
 * is nothing to show. This module produces that state. It deliberately has no
 * shape for "zero tournaments played": a zero is a result, and showing one the
 * player did not earn is the same lie as showing a number they did not earn.
 */

export type CompetitionUnavailableReason =
  /** No account exists on this build, so no server record can be addressed. */
  | "NO_ACCOUNT"
  /** Signed in, but the device cannot reach the server right now. */
  | "OFFLINE";

export interface CompetitionRecord {
  tournamentsEntered: number;
  tournamentWins: number;
  bestFinish: number | null;
  dailyChallengesPlayed: number;
  dailyChallengeBestRank: number | null;
}

export type CompetitionState =
  | { status: "unavailable"; reason: CompetitionUnavailableReason }
  | { status: "loading" }
  | { status: "ready"; record: CompetitionRecord; stale: boolean };

export interface CompetitionContext {
  /** True once an authenticated session exists. Always false in this build. */
  hasAccount: boolean;
  online: boolean;
  /** A record already fetched and cached for this account, if any. */
  cached?: CompetitionRecord | null;
  loading?: boolean;
}

/**
 * Resolves what the Competition section may show.
 *
 * Precedence is deliberate: without an account there is no record to be offline
 * *from*, so `NO_ACCOUNT` outranks `OFFLINE`. A cached record is shown while
 * offline, flagged `stale`, because a previously fetched real result is still
 * real — but it is never fabricated when no fetch has ever succeeded.
 */
export function competitionState(context: CompetitionContext): CompetitionState {
  if (!context.hasAccount) return { status: "unavailable", reason: "NO_ACCOUNT" };
  if (context.cached) return { status: "ready", record: context.cached, stale: !context.online };
  if (!context.online) return { status: "unavailable", reason: "OFFLINE" };
  if (context.loading) return { status: "loading" };
  return { status: "loading" };
}

export interface UnavailableCopy {
  title: string;
  body: string;
}

/**
 * Plain-language explanations. Each states the reason and what would change it,
 * and none of them implies a result exists behind the message.
 */
export function describeCompetitionUnavailable(
  reason: CompetitionUnavailableReason,
): UnavailableCopy {
  switch (reason) {
    case "NO_ACCOUNT":
      return {
        title: "Requires an account",
        body:
          "Tournament and Daily Challenge records are kept on the server so they " +
          "cannot be edited from a phone. This build has no sign-in yet, so there " +
          "is no record to show — not a record of zero.",
      };
    case "OFFLINE":
      return {
        title: "Offline",
        body:
          "Your competitive record lives on the server and has not been loaded on " +
          "this device. It will appear when you are back online.",
      };
  }
}
