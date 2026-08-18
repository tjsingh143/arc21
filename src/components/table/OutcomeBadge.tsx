/**
 * How a settled hand is announced.
 *
 * The specification is specific about the tone here, and the asymmetry is the
 * whole point:
 *
 *   natural blackjack   a small halo, restrained, and a short chime
 *   ordinary win        the chip delta and a subtle glow
 *   loss                no aggressive red flash, no punitive shake
 *
 * So a win gets a flourish and a loss gets a label. Losing a hand is an ordinary
 * outcome of a fair game — the house edge is stated on the Fair Play screen — and
 * an app that punishes it with motion is teaching a feeling rather than a game.
 *
 * The halo is a single scaling ring, not particles. Particles would be more
 * expensive, harder to make interruptible, and the first thing Reduce Motion has
 * to remove anyway.
 *
 * INVARIANT, inherited from `DealtCard`: animation never gates game truth. The
 * label and the number are rendered by the same pass whatever the animation is
 * doing, so a transition cut short by navigation, backgrounding or a reconnect
 * leaves the authoritative result on screen. Nothing here can delay or suppress
 * a settlement.
 */

import { memo, useEffect } from "react";
import { StyleSheet, View } from "react-native";
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withSequence,
  withTiming,
} from "react-native-reanimated";

import { AppText } from "../ui/AppText";
import { colors, radius, spacing } from "../../design/tokens";
import { easings, useMotion } from "../../design/motion";
import { formatChipDelta } from "../../design/typography";
import type { HandOutcomeKind } from "../../../shared/blackjack/types.js";

const LABELS: Record<HandOutcomeKind, string> = {
  BLACKJACK: "Blackjack",
  WIN: "Win",
  PUSH: "Push",
  LOSS: "Loss",
  BUST: "Bust",
  SURRENDER: "Surrender",
};

export interface OutcomeBadgeProps {
  kind: HandOutcomeKind;
  /** Signed chips. Zero on a push, which is rendered as no number at all. */
  net: number;
}

export const OutcomeBadge = memo(function OutcomeBadge({ kind, net }: OutcomeBadgeProps) {
  const motion = useMotion();

  // Only the two positive outcomes get a halo, and blackjack's is the larger.
  const halo = kind === "BLACKJACK" ? "strong" : kind === "WIN" && net > 0 ? "subtle" : "none";

  const progress = useSharedValue(0);

  useEffect(() => {
    if (halo === "none" || motion.reduceMotion) return;
    // One pass, then done. A looping celebration would keep drawing while the
    // next hand is being dealt.
    progress.value = withSequence(
      withTiming(1, { duration: motion.duration("chipMove"), easing: easings.settle }),
      withTiming(0, { duration: 0 }),
    );
  }, [halo, motion, progress]);

  const haloStyle = useAnimatedStyle(() => ({
    opacity: (1 - progress.value) * (halo === "strong" ? 0.45 : 0.28),
    transform: [{ scale: 0.85 + progress.value * (halo === "strong" ? 0.5 : 0.3) }],
  }));

  const tone = net > 0 ? "success" : net < 0 ? "danger" : "textSecondary";

  return (
    <View style={styles.wrapper}>
      {halo !== "none" && !motion.reduceMotion ? (
        <Animated.View
          pointerEvents="none"
          style={[
            styles.halo,
            halo === "strong" ? styles.haloStrong : styles.haloSubtle,
            haloStyle,
          ]}
        />
      ) : null}

      <View style={styles.badge}>
        <AppText variant="bodyStrong" color={tone}>
          {LABELS[kind]}
        </AppText>
        {net !== 0 ? (
          <AppText variant="caption" color={tone} numeric>
            {formatChipDelta(net)}
          </AppText>
        ) : null}
      </View>
    </View>
  );
});

const styles = StyleSheet.create({
  wrapper: { alignItems: "center", justifyContent: "center" },
  badge: { alignItems: "center", gap: 2 },
  halo: {
    position: "absolute",
    left: -spacing.md,
    right: -spacing.md,
    top: -spacing.xs,
    bottom: -spacing.xs,
    borderRadius: radius.card,
    borderWidth: 1,
  },
  haloStrong: { borderColor: colors.accent, backgroundColor: colors.accentSoft },
  haloSubtle: { borderColor: colors.success, backgroundColor: "transparent" },
});
