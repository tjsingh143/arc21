/**
 * Spoken text for the accessibility announcements the specification names:
 * "Your turn", "Dealer shows six", "Blackjack. You won 150 chips."
 *
 * Kept as pure string-building, apart from the `AccessibilityInfo` call site
 * in `src/lib/accessibility/announce.ts`, so the exact wording is testable
 * without a device — see `tests/table/outcome-announcement.test.ts`.
 */

import { formatChips } from "../../design/format-chips";
import type { HandOutcomeKind } from "../../../shared/blackjack/types.js";

const OUTCOME_LABELS: Record<HandOutcomeKind, string> = {
  BLACKJACK: "Blackjack",
  WIN: "Win",
  PUSH: "Push",
  LOSS: "Loss",
  BUST: "Bust",
  SURRENDER: "Surrender",
};

/** e.g. "Blackjack. You won 150 chips.", "Bust. You lost 100 chips.", "Push." */
export function describeOutcomeForAnnouncement(kind: HandOutcomeKind, net: number): string {
  const label = OUTCOME_LABELS[kind];
  if (net > 0) return `${label}. You won ${formatChips(net)} chips.`;
  if (net < 0) return `${label}. You lost ${formatChips(Math.abs(net))} chips.`;
  return `${label}.`;
}

/** e.g. "Dealer shows Six." */
export function describeDealerUpCardForAnnouncement(rankSpokenName: string): string {
  return `Dealer shows ${rankSpokenName}.`;
}

export const YOUR_TURN_ANNOUNCEMENT = "Your turn.";
