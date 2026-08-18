/**
 * Arc 21 — button.
 *
 * Every variant meets the 48dp minimum touch target even with a short label.
 * Disabled buttons stay in the tree (rather than disappearing) so the action
 * dock does not reflow as legality changes mid-hand — a moving Hit button is a
 * misclick waiting to happen.
 */

import { ActivityIndicator, Pressable, StyleSheet, View, type ViewStyle } from "react-native";

import { colors, MIN_TOUCH_TARGET, radius, spacing } from "../../design/tokens";
import { AppText } from "./AppText";

export type ButtonVariant = "primary" | "secondary" | "quiet" | "danger";
export type ButtonSize = "large" | "medium";

export interface ButtonProps {
  label: string;
  onPress: () => void;
  variant?: ButtonVariant;
  size?: ButtonSize;
  disabled?: boolean;
  pending?: boolean;
  /** Extra context for screen readers, e.g. "adds 100 chips". */
  accessibilityHint?: string;
  style?: ViewStyle;
  testID?: string;
}

export function Button({
  label,
  onPress,
  variant = "primary",
  size = "large",
  disabled = false,
  pending = false,
  accessibilityHint,
  style,
  testID,
}: ButtonProps) {
  const inactive = disabled || pending;

  return (
    <Pressable
      onPress={onPress}
      disabled={inactive}
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityHint={accessibilityHint}
      accessibilityState={{ disabled: inactive, busy: pending }}
      style={({ pressed }) => [
        styles.base,
        size === "large" ? styles.large : styles.medium,
        VARIANT_STYLES[variant].container,
        pressed && !inactive ? styles.pressed : null,
        inactive ? styles.inactive : null,
        style,
      ]}
    >
      {pending ? (
        <ActivityIndicator color={colors.textPrimary} />
      ) : (
        <AppText
          variant={size === "large" ? "bodyStrong" : "body"}
          color={inactive ? "textDisabled" : VARIANT_STYLES[variant].label}
          numberOfLines={1}
        >
          {label}
        </AppText>
      )}
    </Pressable>
  );
}

const VARIANT_STYLES = {
  primary: {
    container: { backgroundColor: colors.accent },
    label: "cardInk",
  },
  secondary: {
    container: {
      backgroundColor: colors.surfaceRaised,
      borderWidth: 1,
      borderColor: colors.border,
    },
    label: "textPrimary",
  },
  quiet: {
    container: { backgroundColor: "transparent" },
    label: "textSecondary",
  },
  danger: {
    container: {
      backgroundColor: "transparent",
      borderWidth: 1,
      borderColor: colors.danger,
    },
    label: "danger",
  },
} as const satisfies Record<ButtonVariant, { container: ViewStyle; label: Parameters<typeof AppText>[0]["color"] }>;

/** Row helper so the action dock keeps consistent gaps. */
export function ButtonRow({ children }: { children: React.ReactNode }) {
  return <View style={styles.row}>{children}</View>;
}

const styles = StyleSheet.create({
  base: {
    minHeight: MIN_TOUCH_TARGET,
    borderRadius: radius.small,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: spacing.lg,
  },
  large: {
    minHeight: 56,
    flex: 1,
  },
  medium: {
    minHeight: MIN_TOUCH_TARGET,
    flex: 1,
  },
  pressed: {
    opacity: 0.75,
    transform: [{ scale: 0.985 }],
  },
  inactive: {
    opacity: 0.4,
  },
  row: {
    flexDirection: "row",
    gap: spacing.md,
  },
});
