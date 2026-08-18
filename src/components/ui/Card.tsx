/**
 * Surface primitives shared by Home, Play and Career.
 *
 * `UnavailableNote` is load-bearing for the product's honesty rule: a surface
 * that needs a server we do not have yet says so plainly. It never renders
 * zeros, fake friends or an empty leaderboard that would read as real data.
 */

import { Pressable, StyleSheet, View, type StyleProp, type ViewStyle } from "react-native";

import { colors, MIN_TOUCH_TARGET, radius, spacing } from "../../design/tokens";
import { AppText } from "./AppText";

export interface SurfaceCardProps {
  children: React.ReactNode;
  onPress?: () => void;
  accessibilityLabel?: string;
  accessibilityHint?: string;
  /** Dims the card and blocks interaction. */
  disabled?: boolean;
  /**
   * `StyleProp` rather than a bare `ViewStyle`, so a caller can compose a base
   * style with a conditional one — a selected tab, a highlighted row — without
   * merging objects by hand at every call site.
   */
  style?: StyleProp<ViewStyle>;
  /**
   * Marks a card used as a tab or an option. Passed through to
   * `accessibilityState`, because a screen reader announcing four identical
   * buttons with no indication of which is active is not usable.
   */
  selected?: boolean;
  testID?: string;
}

export function SurfaceCard({
  children,
  onPress,
  accessibilityLabel,
  accessibilityHint,
  disabled = false,
  style,
  selected,
  testID,
}: SurfaceCardProps) {
  if (!onPress) {
    return <View style={[styles.card, disabled ? styles.disabled : null, style]}>{children}</View>;
  }

  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      testID={testID}
      accessibilityRole={selected === undefined ? "button" : "tab"}
      accessibilityLabel={accessibilityLabel}
      accessibilityHint={accessibilityHint}
      accessibilityState={selected === undefined ? { disabled } : { disabled, selected }}
      style={({ pressed }) => [
        styles.card,
        pressed && !disabled ? styles.pressed : null,
        disabled ? styles.disabled : null,
        style,
      ]}
    >
      {children}
    </Pressable>
  );
}

/** Small labelled tile used in rows on Home. */
export function Tile({
  label,
  detail,
  onPress,
  disabled = false,
  testID,
}: {
  label: string;
  detail: string;
  onPress?: () => void;
  disabled?: boolean;
  testID?: string;
}) {
  return (
    <SurfaceCard
      onPress={onPress}
      disabled={disabled}
      testID={testID}
      accessibilityLabel={label}
      accessibilityHint={detail}
      style={styles.tile}
    >
      <AppText variant="bodyStrong" color={disabled ? "textDisabled" : "textPrimary"}>
        {label}
      </AppText>
      <AppText variant="caption" color="textSecondary">
        {detail}
      </AppText>
    </SurfaceCard>
  );
}

/**
 * States a capability the build does not have yet, in the user's terms.
 *
 * The alternative — a disabled button with no explanation, or worse, zeros
 * standing in for real numbers — reads as broken or, much worse, as true.
 */
export function UnavailableNote({ children }: { children: React.ReactNode }) {
  return (
    <View style={styles.unavailable} accessibilityRole="summary">
      <AppText variant="caption" color="textSecondary">
        {children}
      </AppText>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.surface,
    borderRadius: radius.card,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.lg,
    gap: spacing.xs,
  },
  tile: {
    flex: 1,
    minHeight: MIN_TOUCH_TARGET + spacing.lg,
    justifyContent: "center",
  },
  pressed: {
    opacity: 0.8,
    transform: [{ scale: 0.995 }],
  },
  disabled: {
    opacity: 0.55,
  },
  unavailable: {
    borderRadius: radius.small,
    borderWidth: 1,
    borderColor: colors.border,
    borderStyle: "dashed",
    padding: spacing.md,
  },
});
