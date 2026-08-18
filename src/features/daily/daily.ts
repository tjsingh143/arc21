/**
 * Reading today's Daily Challenge.
 *
 * Rows are parsed, never trusted. Everything the screen shows about the shoe is
 * a claim the server makes, and the one that matters most — the seed commitment
 * — is shown verbatim rather than summarised, because its whole purpose is that
 * a player can check it against the seed after the challenge closes.
 *
 * Note what is NOT here: the seed. The server's projection does not carry the
 * column, so there is nothing to accidentally render.
 */

import { z } from "zod";

export const challengeRowSchema = z.object({
  id: z.string().uuid(),
  challenge_date: z.string(),
  seed_commitment: z.string().regex(/^[0-9a-f]{64}$/),
  revealed_seed: z.string().nullable(),
  hand_count: z.number().int().positive(),
  starting_chips: z.number().int().positive(),
  reward_chips: z.number().int().nonnegative(),
  reward_xp: z.number().int().nonnegative(),
  closes_at: z.string(),
});

export const attemptRowSchema = z.object({
  daily_challenge_id: z.string().uuid(),
  game_session_id: z.string().uuid().nullable(),
  status: z.enum(["in_progress", "completed", "abandoned"]),
  hands_played: z.number().int().nonnegative(),
  final_chips: z.number().int().nonnegative(),
  score: z.number().int(),
  completed_at: z.string().nullable(),
});

export interface Challenge {
  readonly id: string;
  readonly date: string;
  readonly seedCommitment: string;
  /** Published only after the challenge closes, for verification. */
  readonly revealedSeed: string | null;
  readonly handCount: number;
  readonly startingChips: number;
  readonly rewardChips: number;
  readonly rewardXp: number;
  readonly closesAt: string;
}

export interface Attempt {
  readonly challengeId: string;
  readonly gameId: string | null;
  readonly status: "in_progress" | "completed" | "abandoned";
  readonly handsPlayed: number;
  readonly finalChips: number;
  readonly score: number;
  readonly completedAt: string | null;
}

function firstOf(value: unknown): unknown {
  return Array.isArray(value) ? value[0] : value;
}

export function toChallenge(value: unknown): Challenge | null {
  const parsed = challengeRowSchema.safeParse(firstOf(value));
  if (!parsed.success) return null;
  return {
    id: parsed.data.id,
    date: parsed.data.challenge_date,
    seedCommitment: parsed.data.seed_commitment,
    revealedSeed: parsed.data.revealed_seed,
    handCount: parsed.data.hand_count,
    startingChips: parsed.data.starting_chips,
    rewardChips: parsed.data.reward_chips,
    rewardXp: parsed.data.reward_xp,
    closesAt: parsed.data.closes_at,
  };
}

export function toAttempt(value: unknown): Attempt | null {
  const parsed = attemptRowSchema.safeParse(firstOf(value));
  if (!parsed.success) return null;
  return {
    challengeId: parsed.data.daily_challenge_id,
    gameId: parsed.data.game_session_id,
    status: parsed.data.status,
    handsPlayed: parsed.data.hands_played,
    finalChips: parsed.data.final_chips,
    score: parsed.data.score,
    completedAt: parsed.data.completed_at,
  };
}

/**
 * What the button should say, and whether the attempt about to start counts.
 *
 * "Ranked" is stated before the player commits, never after. Someone replaying a
 * shoe they have already seen must know their score will not be recorded — that
 * is the difference between an honest practice mode and a silently pointless one.
 */
export function describeAttempt(attempt: Attempt | null): {
  label: string;
  ranked: boolean;
  detail: string;
} {
  if (!attempt) {
    return {
      label: "Play today's challenge",
      ranked: true,
      detail: "This is your one ranked attempt today.",
    };
  }
  if (attempt.status === "in_progress") {
    return {
      label: "Resume your attempt",
      ranked: true,
      detail: `Hand ${attempt.handsPlayed + 1}. Your ranked attempt is still open.`,
    };
  }
  return {
    label: "Replay unranked",
    ranked: false,
    detail: "Your ranked attempt is finished. A replay is practice and scores nothing.",
  };
}

/** How the seed can be checked, in plain language and only when it is possible. */
export function describeVerification(challenge: Challenge): string {
  if (challenge.revealedSeed) {
    return "The seed has been published. SHA-256 of it must equal the commitment below.";
  }
  return "The commitment below was published before anyone played. The seed itself stays secret until the challenge closes, then it can be checked against this hash.";
}
