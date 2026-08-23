/**
 * Paying a career node's first-completion reward.
 *
 * One implementation, two callers: the drill path in `create-session` and the
 * standard-node boundary in `session-boundary.ts`. They are different code
 * paths because a drill has no table, but the money must move the same way in
 * both — so it moves here.
 *
 * THE IDEMPOTENCY KEY IS DERIVED FROM THE NODE AND THE PLAYER, never from a
 * client request id. It is the same rule cash-out and the daily reward follow,
 * and for the same reason: a fresh request id must not be able to buy a second
 * credit. A node's reward is paid ONCE, on its first completion, however many
 * times it is replayed and however many stars a later attempt earns.
 *
 * `career_progress.reward_ledger_id` names the exact ledger row that paid it,
 * and the table's `career_progress_ledger_requires_claim` CHECK makes "claim a
 * prize twice" a constraint violation rather than a race to reason about.
 */

import type { Tx } from "./postgres-client.ts";
import { applyWalletDelta, findLedgerEntry, walletBalance } from "./session-repository.ts";
import type { CareerNode } from "./career/index.ts";

export interface CareerRewardOutcome {
  /** Chips actually credited. Zero on a replay, and zero for a node worth none. */
  readonly rewardChips: number;
  readonly rewardXp: number;
  readonly walletBalance: number;
}

/**
 * Folds a finished attempt into `career_progress` and pays the reward if it is
 * owed.
 *
 * The order matters. Progress is recorded FIRST, because a node is completed
 * whether or not it carries a reward and whether or not the reward has already
 * been paid — the star and the unlock are the receipt, and the chips are a
 * bonus on top of them. Only then is the ledger consulted.
 */
export async function settleCareerReward(
  tx: Tx,
  params: {
    userId: string;
    nodeId: string;
    node: CareerNode;
    stars: number;
    /** Best-score tie-break for the aggregate. Chips for a table, correct answers for a drill. */
    score: number;
  },
): Promise<CareerRewardOutcome> {
  await tx`
    select public.record_career_completion(
      ${params.userId}::uuid, ${params.nodeId}::uuid, ${params.stars}::int, ${params.score}::bigint
    )
  `;

  const rewardChips = params.node.reward.chips;
  const rewardXp = params.node.reward.xp;
  const key = `career_reward:${params.nodeId}:${params.userId}`;

  const already = await findLedgerEntry(tx, key);
  if (already || rewardChips <= 0) {
    /*
     * Nothing to pay. A node worth no chips can still owe XP on its first
     * completion, so the XP is stamped under the same claim marker rather than
     * being skipped along with the chips — otherwise a zero-chip node would
     * grant XP on every replay.
     */
    if (!already && rewardXp > 0) {
      const stamped = await stampClaim(tx, params.userId, params.nodeId, null);
      if (stamped) {
        await tx`select public.award_milestone_xp(${params.userId}::uuid, ${rewardXp}::int)`;
      }
    }
    await tx`select public.grant_earned_cosmetics_for(${params.userId}::uuid)`;
    return {
      rewardChips: 0,
      rewardXp: already ? 0 : rewardXp,
      walletBalance: await walletBalance(tx, params.userId),
    };
  }

  const ledger = await applyWalletDelta(tx, {
    userId: params.userId,
    delta: rewardChips,
    reason: "career_reward",
    idempotencyKey: key,
    referenceId: params.nodeId,
    metadata: { nodeCode: params.node.slug, stars: params.stars },
  });
  await stampClaim(tx, params.userId, params.nodeId, ledger.id);
  if (rewardXp > 0) {
    await tx`select public.award_milestone_xp(${params.userId}::uuid, ${rewardXp}::int)`;
  }

  /*
   * A paid reward can move a level, and a completed node can complete a
   * chapter — both of which unlock cosmetics. Granting here means the player
   * finds the item waiting rather than having to open the inventory to trigger
   * it. Idempotent, so a replayed finalisation grants nothing twice.
   */
  await tx`select public.grant_earned_cosmetics_for(${params.userId}::uuid)`;

  return {
    rewardChips,
    rewardXp,
    walletBalance: ledger.balanceAfter,
  };
}

/**
 * Marks the reward claimed, once.
 *
 * Returns false when it was already claimed, which is what makes the XP branch
 * above safe: two callers racing to finalise the same attempt both find the
 * ledger empty for a zero-chip node, and only one of them stamps.
 */
async function stampClaim(
  tx: Tx,
  userId: string,
  nodeId: string,
  ledgerId: string | null,
): Promise<boolean> {
  const rows = await tx<{ id: string }[]>`
    update public.career_progress
    set reward_claimed_at = now(),
        reward_ledger_id = coalesce(${ledgerId}::uuid, reward_ledger_id)
    where user_id = ${userId}::uuid
      and career_node_id = ${nodeId}::uuid
      and status = 'completed'
      and reward_claimed_at is null
    returning id
  `;
  return rows.length > 0;
}
