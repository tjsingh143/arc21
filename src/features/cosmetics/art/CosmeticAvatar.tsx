/**
 * An avatar as it appears in the app: the mark on its circular field.
 *
 * Every caller — Profile, a leaderboard row, the inventory grid — renders the
 * same field so the set reads as one system at every size. An unknown or null
 * key falls back to the default mark rather than a blank: a missing picture is
 * a defect, a default is a look.
 */

import { memo } from "react";
import { StyleSheet, View } from "react-native";

import { colors, radius } from "../../../design/tokens";
import { avatarArt } from "./registry.js";

export interface CosmeticAvatarProps {
  assetKey: string | null;
  /** Diameter in px. Marks are drawn to stay distinct down to 32. */
  size: number;
  accessibilityLabel?: string;
}

export const CosmeticAvatar = memo(function CosmeticAvatar({
  assetKey,
  size,
  accessibilityLabel,
}: CosmeticAvatarProps) {
  const Mark = avatarArt(assetKey);
  return (
    <View
      style={[styles.field, { width: size, height: size }]}
      accessible={accessibilityLabel !== undefined}
      accessibilityRole={accessibilityLabel !== undefined ? "image" : undefined}
      accessibilityLabel={accessibilityLabel}
    >
      <Mark size={size} />
    </View>
  );
});

const styles = StyleSheet.create({
  field: {
    borderRadius: radius.pill,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.surfaceSoft,
    borderWidth: 1,
    borderColor: colors.border,
    overflow: "hidden",
  },
});
