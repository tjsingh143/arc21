/**
 * Arc 21 — writing notifications from the command functions.
 *
 * Everything here goes through `public.notify_user`, which is revoked from every
 * client role, and every write happens inside the command's own transaction. A
 * tournament that does not commit does not announce itself.
 *
 * The wording is deliberately dull. A notification that says "You are third with
 * two hands left!" is a retention nudge dressed as information, and this product
 * does not do that: it states what happened and lets the player decide whether it
 * is worth opening.
 */

import type { Tx } from "./postgres-client.ts";

export type NotificationKind =
  | "friend_request"
  | "friend_accepted"
  | "table_invite"
  | "your_turn"
  | "tournament_starting"
  | "tournament_result"
  | "daily_challenge"
  | "career_unlocked"
  | "system";

/** Deep-link parameters only — the same allowlist the database enforces. */
export type NotificationData = Record<string, string | number>;

async function notify(
  tx: Tx,
  params: {
    userId: string;
    kind: NotificationKind;
    title: string;
    body: string;
    data?: NotificationData;
    dedupeKey?: string;
  },
): Promise<void> {
  await tx`
    select public.notify_user(
      ${params.userId}::uuid,
      ${params.kind}::public.notification_kind,
      ${params.title},
      ${params.body},
      ${JSON.stringify(params.data ?? {})}::text::jsonb,
      ${params.dedupeKey ?? null}
    )
  `;
}

/**
 * The field is full and the first hand is about to be dealt.
 *
 * Deduped on the tournament, so a retried registration cannot announce the same
 * tournament twice to the same player.
 */
export async function notifyTournamentStarting(
  tx: Tx,
  params: { tournamentId: string; userIds: readonly string[] },
): Promise<void> {
  for (const userId of params.userIds) {
    await notify(tx, {
      userId,
      kind: "tournament_starting",
      title: "Your tournament is starting",
      body: "Four players are seated. Twelve hands, equal stacks.",
      data: { tournament_id: params.tournamentId },
      dedupeKey: `tournament_starting:${params.tournamentId}`,
    });
  }
}

const PLACE_WORDS = ["", "first", "second", "third", "fourth"] as const;

/** The tournament is settled. Stated plainly, prize included, without fanfare. */
export async function notifyTournamentResult(
  tx: Tx,
  params: {
    tournamentId: string;
    userId: string;
    placement: number;
    prizeChips: number;
  },
): Promise<void> {
  const place = PLACE_WORDS[params.placement] ?? `${params.placement}th`;
  const prize =
    params.prizeChips > 0
      ? ` You won ${params.prizeChips.toLocaleString("en-GB")} chips.`
      : "";

  await notify(tx, {
    userId: params.userId,
    kind: "tournament_result",
    title: "Tournament finished",
    body: `You finished ${place}.${prize}`,
    data: { tournament_id: params.tournamentId, placement: params.placement },
    dedupeKey: `tournament_result:${params.tournamentId}`,
  });
}

/**
 * A hand was played for a player who was not there.
 *
 * The specification asks for "your turn where timing makes sense", and the
 * honest reading is that a turn notification almost never does. A shared table
 * gives fifteen seconds to act. A push written the moment the turn arrives is
 * racing a countdown it cannot win: by the time the OS surfaces it the deadline
 * has passed and the default has been applied, so the player is told to hurry
 * for a decision that is already made.
 *
 * What is worth telling someone is that it HAPPENED. `TIMEOUT_RESOLVED` is an
 * observable fact — the server applied a documented default because nobody
 * answered — and it names the exact seat that was absent, rather than inferring
 * absence from a `connected` flag that only an explicit LEAVE ever clears.
 *
 * The dedupe key is the TABLE, not the hand. A player who has put their phone
 * down will time out on every hand that follows; one notification says "you are
 * still seated here", and a dozen say "turn these off".
 */
export async function notifyTurnPlayedByTimeout(
  tx: Tx,
  params: { gameId: string; userId: string },
): Promise<void> {
  await notify(tx, {
    userId: params.userId,
    kind: "your_turn",
    title: "A hand was played for you",
    body: "You are still seated at a table. Timed-out hands stand and decline insurance.",
    data: { game_id: params.gameId },
    dedupeKey: `your_turn:${params.gameId}`,
  });
}
