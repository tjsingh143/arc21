/**
 * Shared screen header: title on the left, profile avatar on the right.
 *
 * The avatar is how Profile is reached, which is why it appears on every tab
 * rather than in a fifth tab slot.
 */

import { Pressable, StyleSheet, View } from "react-native";
import { router } from "expo-router";
import Svg, { Circle, Path } from "react-native-svg";

import { colors, MIN_TOUCH_TARGET, radius, spacing } from "../../design/tokens";
import { formatChips } from "../../design/typography";
import { AppText } from "./AppText";

export interface ScreenHeaderProps {
  title: string;
  subtitle?: string;
  /** Global wallet balance. Null for a guest, who has no server wallet. */
  balance?: number | null;
}

export function ScreenHeader({ title, subtitle, balance = null }: ScreenHeaderProps) {
  return (
    <View style={styles.header}>
      <View style={styles.titleBlock}>
        <AppText variant="pageTitle">{title}</AppText>
        {subtitle ? (
          <AppText variant="caption" color="textSecondary">
            {subtitle}
          </AppText>
        ) : null}
      </View>

      <View style={styles.right}>
        {/*
          A guest has no server wallet, so we say "Guest" rather than showing a
          zero that would read as an empty balance.
        */}
        <View style={styles.balance}>
          <AppText variant="overline" color="textSecondary">
            {balance === null ? "Guest" : "Chips"}
          </AppText>
          {balance !== null ? (
            <AppText variant="bodyStrong" numeric>
              {formatChips(balance)}
            </AppText>
          ) : null}
        </View>

        <Pressable
          onPress={() => router.push("/profile")}
          // testID is separate from the accessibility label: on iOS the label is
          // what a screen reader speaks, while `id:` in an E2E flow matches the
          // identifier. Relying on the label alone made this untargetable.
          testID="open-profile"
          accessibilityRole="button"
          accessibilityLabel="Open profile"
          style={({ pressed }) => [styles.avatar, pressed ? styles.pressed : null]}
        >
          <Svg width={26} height={26} viewBox="0 0 24 24">
            <Circle cx="12" cy="9" r="3.4" stroke={colors.textSecondary} strokeWidth={1.6} fill="none" />
            <Path
              d="M5 20c0-3.6 3.1-6 7-6s7 2.4 7 6"
              stroke={colors.textSecondary}
              strokeWidth={1.6}
              fill="none"
              strokeLinecap="round"
            />
          </Svg>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingTop: spacing.sm,
    paddingBottom: spacing.lg,
    gap: spacing.md,
  },
  titleBlock: {
    flex: 1,
    gap: 2,
  },
  right: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
  },
  balance: {
    alignItems: "flex-end",
  },
  avatar: {
    width: MIN_TOUCH_TARGET,
    height: MIN_TOUCH_TARGET,
    borderRadius: radius.pill,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.surfaceRaised,
    borderWidth: 1,
    borderColor: colors.border,
  },
  pressed: {
    opacity: 0.7,
  },
});
