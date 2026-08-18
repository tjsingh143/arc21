/**
 * Arc 21 — card motion.
 *
 * Animation here is informational, not decorative: it shows a card arriving and
 * the hole card turning over, which is how a player tracks what changed. It is
 * short, interruptible, and never the source of truth.
 *
 * INVARIANT: animation never gates game state. If a transition is cut short by
 * navigation, backgrounding or a reconnect, the authoritative final state is
 * already rendered underneath — the animation only affects how it got there.
 * Nothing in this file may delay, reorder or suppress an engine event.
 */

import { memo, useEffect } from "react";
import Animated, {
  interpolate,
  useAnimatedStyle,
  useSharedValue,
  withDelay,
  withTiming,
} from "react-native-reanimated";

import { durations, easings, useMotion } from "../../design/motion";
import type { Card, MaybeHiddenCard } from "../../../shared/blackjack/types.js";
import { isHiddenCard } from "../../../shared/blackjack/types.js";
import { CardBack, PlayingCard } from "./PlayingCard";
import type { CardSize } from "../../design/tokens";

export interface DealtCardProps {
  card: MaybeHiddenCard;
  size?: CardSize;
  /** Position in the hand, used to stagger arrivals. */
  index?: number;
  dimmed?: boolean;
  accessibilityLabel?: string;
}

/**
 * A card that animates in on mount and flips when its hidden card is revealed.
 *
 * Keyed by card id at the call site, so React mounts a new component per
 * physical card — that is what makes "animate on arrival" correct without any
 * manual diffing of previous hands.
 */
export const DealtCard = memo(function DealtCard({
  card,
  size = "hero",
  index = 0,
  dimmed = false,
  accessibilityLabel,
}: DealtCardProps) {
  const motion = useMotion();
  const hidden = isHiddenCard(card);

  const arrival = useSharedValue(0);
  // 0 = showing the back, 1 = showing the face.
  const flip = useSharedValue(hidden ? 0 : 1);

  useEffect(() => {
    arrival.value = withDelay(
      motion.stagger(index),
      withTiming(1, { duration: motion.duration("cardDeal"), easing: easings.settle }),
    );
    // `arrival` is a stable shared value; re-running on every render would
    // restart the animation mid-flight.
  }, [arrival, index, motion]);

  useEffect(() => {
    const target = hidden ? 0 : 1;
    if (flip.value === target) return;
    flip.value = withTiming(target, {
      duration: motion.duration("dealerFlip"),
      easing: easings.fade,
    });
  }, [flip, hidden, motion]);

  const arrivalStyle = useAnimatedStyle(() => ({
    opacity: arrival.value,
    transform: [
      // A short drop rather than a long slide: the point is "a card arrived
      // here", which reads in 200ms.
      { translateY: interpolate(arrival.value, [0, 1], [-18, 0]) },
      { scale: interpolate(arrival.value, [0, 1], [0.94, 1]) },
    ],
  }));

  // Cross-fading the two faces avoids a 3D rotation that would need
  // backface-visibility support and behaves inconsistently across platforms.
  const backStyle = useAnimatedStyle(() => ({
    opacity: 1 - flip.value,
  }));

  const faceStyle = useAnimatedStyle(() => ({
    opacity: flip.value,
  }));

  return (
    <Animated.View style={arrivalStyle}>
      {hidden ? (
        <Animated.View style={backStyle}>
          <CardBack size={size} accessibilityLabel={accessibilityLabel ?? "Dealer hidden card"} />
        </Animated.View>
      ) : (
        <Animated.View style={faceStyle}>
          <PlayingCard card={card as Card} size={size} dimmed={dimmed} />
        </Animated.View>
      )}
    </Animated.View>
  );
});

/**
 * Total time for a hand of `count` cards to finish arriving.
 *
 * Exposed so a caller can schedule what follows without hardcoding the same
 * numbers — and so tests can assert the sequence stays under a sane budget
 * rather than growing unbounded as hands get longer.
 */
export function dealSequenceDuration(count: number, reduceMotion: boolean): number {
  if (count <= 0) return 0;
  const perCard = reduceMotion ? 120 : durations.cardDeal;
  const stagger = reduceMotion ? 0 : durations.cardStagger;
  return perCard + stagger * Math.max(0, count - 1);
}
