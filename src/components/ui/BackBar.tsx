/**
 * A back control at the TOP of a pushed screen.
 *
 * These screens are presented without a navigation header, and several of them
 * carried their only "Back" button at the foot of a long article — How to Play
 * scrolls for several screens before reaching it. iOS edge-swipe still works,
 * but a gesture is not discoverable and is not available to someone driving the
 * phone by other means, so the only reliable way out was to scroll to the end.
 *
 * The label is spelled out rather than a bare chevron: a lone glyph gives a
 * screen reader nothing useful, and "Back" costs one word.
 */

import { Pressable, StyleSheet, View } from "react-native";
import { router } from "expo-router";
import Svg, { Path } from "react-native-svg";

import { colors, MIN_TOUCH_TARGET, spacing } from "../../design/tokens";
import { AppText } from "./AppText";

export interface BackBarProps {
  /** Announced destination, e.g. "Back to Learn". Defaults to "Back". */
  label?: string;
  /** Overrides the default `router.back()`. */
  onPress?: () => void;
  testID?: string;
}

export function BackBar({ label = "Back", onPress, testID = "back-bar" }: BackBarProps) {
  return (
    <View style={styles.bar}>
      <Pressable
        onPress={onPress ?? (() => router.back())}
        testID={testID}
        accessibilityRole="button"
        accessibilityLabel={label}
        // Generous hit area: this sits near the screen edge where a thumb is
        // least precise.
        hitSlop={{ top: 8, bottom: 8, left: 12, right: 12 }}
        style={({ pressed }) => [styles.button, pressed ? styles.pressed : null]}
      >
        <Svg width={18} height={18} viewBox="0 0 24 24">
          <Path
            d="M15 5l-7 7 7 7"
            stroke={colors.textSecondary}
            strokeWidth={2}
            strokeLinecap="round"
            strokeLinejoin="round"
            fill="none"
          />
        </Svg>
        <AppText variant="body" color="textSecondary">
          {label}
        </AppText>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  bar: {
    flexDirection: "row",
    alignItems: "center",
    paddingBottom: spacing.sm,
  },
  button: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.xs,
    minHeight: MIN_TOUCH_TARGET,
    paddingRight: spacing.md,
  },
  pressed: {
    opacity: 0.6,
  },
});
