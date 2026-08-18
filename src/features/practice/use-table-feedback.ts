/**
 * Fires sound and haptics from authoritative engine events.
 *
 * One hook for both, because they describe the same moments and must never
 * disagree: a hand that buzzes as a win and chimes as a loss is worse than one
 * that does neither. Both mappings live beside the thing they describe —
 * `hapticForOutcome` and `soundForOutcome` — so a new outcome is a compile-time
 * question in two known places rather than a search.
 *
 * Lives in the UI layer, not the store, for two reasons. First, feedback is a
 * presentation concern: the engine's job is to decide what happened, not how it
 * feels. Second, the store is imported by Node tests and neither `expo-haptics`
 * nor `expo-audio` has native backing there.
 *
 * Driving this from events rather than from state diffs means the feedback can
 * never disagree with what actually happened.
 */

import { useEffect, useRef } from "react";

import type { EngineEvent } from "../../../shared/blackjack/types.js";
import { playSound, soundForOutcome } from "../../lib/audio/audio";
import {
  hapticAction,
  hapticForOutcome,
  hapticRejected,
} from "../../lib/haptics/haptics";

export function useTableFeedback(
  events: readonly EngineEvent[],
  error: string | null,
): void {
  // Events arrive as a new array per command; the ref stops a re-render from
  // replaying feedback for events that were already felt.
  const lastPlayed = useRef<readonly EngineEvent[] | null>(null);

  useEffect(() => {
    if (events === lastPlayed.current) return;
    lastPlayed.current = events;

    let dealt = 0;
    for (const event of events) {
      switch (event.type) {
        case "CARD_DEALT":
          dealt++;
          break;
        case "HOLE_CARD_REVEALED":
          playSound("cardFlip");
          break;
        case "HAND_SETTLED":
          hapticForOutcome(event.outcome.kind);
          soundForOutcome(event.outcome.kind);
          break;
        default:
          break;
      }
    }

    /*
     * ONE haptic for the batch and one sound PER card.
     *
     * They differ on purpose. A four-card deal that buzzes four times reads as a
     * malfunction — the device cannot convey which card is which — but four
     * card sounds staggered behind the animation is what a deal sounds like, and
     * the sink pools three voices for exactly this. Capped so a resplit cannot
     * turn into a burst.
     */
    if (dealt > 0) {
      hapticAction();
      for (let i = 0; i < Math.min(dealt, 4); i++) playSound("cardDeal");
    }
  }, [events]);

  const lastError = useRef<string | null>(null);
  useEffect(() => {
    if (error && error !== lastError.current) hapticRejected();
    lastError.current = error;
  }, [error]);
}
