/**
 * Whether the insurance offer should be shown, and what it says.
 *
 * Pure, and separate from `app/table/[gameId].tsx` for the reason
 * `betting-affordance.ts` gives: a control that cannot be reached is a defect
 * a test of the function behind it will never find.
 *
 * THE DEFECT THIS EXISTS TO PIN, and it is the same shape as the Deal button's.
 * `INSURANCE` and `DECLINE_INSURANCE` are engine commands. They are in
 * `COMMAND_TYPES` on the wire. `game-command` applies them. Every
 * daily-challenge attempt in `tests/server` sends `DECLINE_INSURANCE` on hands
 * where the dealer shows an ace. And **no client could send either one at a
 * server table**: `InsuranceSheet` was mounted by `app/game/practice.tsx` and
 * `app/career/play/[slug].tsx`, both driving the LOCAL engine, and the online
 * table screen had no insurance branch at all. Its `myTurn` check reads
 * `activeSeatId`, which is null during the offer because insurance is not a
 * turn — so the screen fell through to "Waiting for the next hand." and stayed
 * there until the insurance deadline expired and the server applied its
 * default.
 *
 * The player was never wrongly charged: the timeout declines, which is the
 * stated default. They simply could not take insurance at any server table —
 * Quick Play, public, private, tournament or daily — in a game whose rules
 * offer it.
 *
 * NOT A CONTROL. The engine re-checks the phase and the seat's pending
 * decision, and the server rejects an insurance command in any other phase.
 * This decides what an honest client shows.
 */

import type { LegalActionSet } from "../../../shared/blackjack/legal-actions.js";

export interface InsuranceOffer {
  /** Chips the insurance bet would cost. Never negative. */
  readonly stake: number;
  /** The player holds a natural, so the offer is Even Money. */
  readonly isEvenMoney: boolean;
  /**
   * Whether TAKING it is affordable. Declining always is — the sheet must not
   * become a dead end for a player who cannot cover the stake.
   */
  readonly canAfford: boolean;
}

/**
 * The offer to show, or `null`.
 *
 * Both conditions are required and neither is redundant. The PHASE is checked
 * because `LegalActionSet` is computed per seat and the sheet must unmount the
 * instant the phase advances — leaving it up on the `visible` prop alone
 * rendered "Insurance costs 0 chips", since the stake is only defined while the
 * offer is live. And `canDeclineInsurance` is checked because a seat that has
 * already answered, or never had a bet down, is not being offered anything.
 */
export function insuranceOffer(phase: string, legal: LegalActionSet | null): InsuranceOffer | null {
  if (phase !== "INSURANCE_OFFER") return null;
  if (legal === null || !legal.canDeclineInsurance) return null;
  return {
    stake: legal.insuranceStake ?? 0,
    isEvenMoney: legal.insuranceIsEvenMoney,
    canAfford: legal.canTakeInsurance,
  };
}
