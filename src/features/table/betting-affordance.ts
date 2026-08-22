/**
 * Whether the Deal control should be offered for the bet currently staged.
 *
 * Pure, and separate from `BettingBar` so it can be asserted without
 * rendering React Native — the same split as `format-chips.ts` and
 * `type-scale.ts`.
 *
 * THE BUG THIS EXISTS TO PIN. `BettingBar` used to gate Deal on
 * `legal.canLockBet` alone, which is
 * `!seat.betLocked && isBetAmountValid(seat.originalBet, …)` — a statement
 * about the bet the ENGINE already holds.
 *
 * At the practice table that is the same thing as the staged bet, because
 * `addChip` applies `PLACE_BET` to the local engine on every tap. At a
 * SERVER-AUTHORITATIVE table it is not: `addChip` only stages locally, and the
 * bet is not sent until Deal is pressed. So `originalBet` stayed 0,
 * `canLockBet` stayed false, and Deal was permanently disabled — no online
 * table could take a bet through the UI in any mode: private, public,
 * tournament or daily.
 *
 * Nothing was going to catch it. `tests/server/*` drive the Edge Function with
 * explicit commands and never touch this bar; the store's own `lockBet` is
 * unit-tested by CALLING it; and no E2E flow plays an online table. The
 * function was written, tested, and wired to a control that could not be
 * pressed. Found by playing a two-simulator private table in phase 14 s4.
 *
 * This decides only whether the button is worth offering. The engine re-checks
 * the amount and the server rejects an illegal `PLACE_BET` regardless.
 */

import type { LegalActionSet } from "../../../shared/blackjack/legal-actions.js";

export function canDealStagedBet(legal: LegalActionSet, stagedBet: number): boolean {
  if (legal.canLockBet) return true;
  const bounds = legal.betBounds;
  if (!bounds) return stagedBet > 0;
  return stagedBet >= bounds.min && stagedBet <= bounds.max;
}
