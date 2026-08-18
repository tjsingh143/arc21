/**
 * Arc 21 — the client's view of the server wallet.
 *
 * READ ONLY. There is no function in this folder that writes a balance, and
 * there is no way to add one that works: `wallets` and `wallet_ledger` grant
 * `SELECT` and nothing else to `authenticated`, have no INSERT/UPDATE/DELETE
 * policy, and sit under a guard trigger that refuses client writes even if a
 * policy is added by mistake. Chips move through `public.apply_wallet_delta`,
 * which is `SECURITY DEFINER` and executable by `service_role` only.
 *
 * This file therefore does exactly two things: it describes what a wallet row
 * looks like, and it validates that what arrived actually is one.
 *
 * The validation is not ceremony. Under this project's threat model the network
 * is attacker-controlled, so a response claiming to be a wallet is untrusted
 * input like any other. More prosaically: a malformed row must never be rendered
 * as `0`, because a zero balance is a *meaningful* number to a player. Anything
 * that fails to parse becomes an explicit "could not be read" state instead.
 *
 * Runtime-neutral: no React, no React Native, no Expo. Formatting for display
 * lives in `src/design/typography.ts`, which the screens import.
 */

import { z } from "zod";

import type { LedgerReason } from "../../lib/supabase/database.types.js";

/**
 * Chips are integers, always.
 *
 * `bigint` in Postgres, a JSON number on the wire. Asserting integrality here
 * means a value that somehow arrived fractional — a future `numeric` column, a
 * proxy that reformatted the payload — fails loudly instead of quietly
 * introducing floating point into a balance.
 */
const chips = z.number().int();
const nonNegativeChips = chips.min(0);

const ledgerReason = z.enum([
  "initial_grant",
  "table_buy_in",
  "table_cash_out",
  "career_reward",
  "tournament_entry",
  "tournament_prize",
  "daily_challenge_reward",
  "level_up_reward",
  "daily_top_up",
  "correction",
]);

export const walletRowSchema = z.object({
  id: z.string(),
  user_id: z.string(),
  balance: nonNegativeChips,
  lifetime_credited: nonNegativeChips,
  lifetime_debited: nonNegativeChips,
  version: z.number().int().min(0),
  updated_at: z.string(),
});

export const walletLedgerRowSchema = z.object({
  id: z.string(),
  user_id: z.string(),
  // The database constrains this to be non-zero; a zero delta would be a
  // ledger entry that records nothing.
  delta: chips.refine((value) => value !== 0, "a ledger delta is never zero"),
  balance_after: nonNegativeChips,
  reason: ledgerReason,
  reference_type: z.string().nullable(),
  reference_id: z.string().nullable(),
  created_at: z.string(),
});

export interface WalletSnapshot {
  readonly balance: number;
  readonly lifetimeCredited: number;
  readonly lifetimeDebited: number;
  readonly version: number;
  readonly updatedAt: string;
}

export interface LedgerEntry {
  readonly id: string;
  readonly delta: number;
  readonly balanceAfter: number;
  readonly reason: LedgerReason;
  readonly referenceType: string | null;
  readonly referenceId: string | null;
  readonly createdAt: string;
}

export function toWalletSnapshot(row: unknown): WalletSnapshot | null {
  const parsed = walletRowSchema.safeParse(row);
  if (!parsed.success) return null;
  return {
    balance: parsed.data.balance,
    lifetimeCredited: parsed.data.lifetime_credited,
    lifetimeDebited: parsed.data.lifetime_debited,
    version: parsed.data.version,
    updatedAt: parsed.data.updated_at,
  };
}

/**
 * Parses a page of ledger rows, dropping any that do not validate.
 *
 * Dropping rather than failing the whole read is the right trade for history: a
 * single unreadable row should not hide the twenty-four legible ones above it.
 * The count of dropped rows is returned so the screen can say the history is
 * incomplete instead of silently showing a shorter list.
 */
export function toLedgerEntries(rows: readonly unknown[]): {
  readonly entries: readonly LedgerEntry[];
  readonly dropped: number;
} {
  const entries: LedgerEntry[] = [];
  let dropped = 0;

  for (const row of rows) {
    const parsed = walletLedgerRowSchema.safeParse(row);
    if (!parsed.success) {
      dropped += 1;
      continue;
    }
    entries.push({
      id: parsed.data.id,
      delta: parsed.data.delta,
      balanceAfter: parsed.data.balance_after,
      reason: parsed.data.reason,
      referenceType: parsed.data.reference_type,
      referenceId: parsed.data.reference_id,
      createdAt: parsed.data.created_at,
    });
  }

  return { entries, dropped };
}

/**
 * Player-facing wording for each ledger reason.
 *
 * Exhaustive by construction — adding a member to `public.ledger_reason`
 * without giving it wording here is a compile error, rather than a row that
 * renders its raw enum label to a player.
 */
export const LEDGER_REASON_LABELS: Record<LedgerReason, string> = {
  initial_grant: "Welcome chips",
  table_buy_in: "Table buy-in",
  table_cash_out: "Cashed out",
  career_reward: "Career reward",
  tournament_entry: "Tournament entry",
  tournament_prize: "Tournament prize",
  daily_challenge_reward: "Daily challenge",
  level_up_reward: "Level up",
  // `daily_top_up` predates the enum having a proper name for this and is kept
  // so historic rows still read correctly to the player.
  daily_top_up: "Recovery grant",
  recovery_grant: "Recovery grant",
  correction: "Correction",
};

export function describeLedgerEntry(entry: LedgerEntry): string {
  return LEDGER_REASON_LABELS[entry.reason];
}
