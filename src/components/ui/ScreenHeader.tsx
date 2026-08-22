/**
 * Shared screen header: title on the left, profile avatar on the right.
 *
 * The avatar is how Profile is reached, which is why it appears on every tab
 * rather than in a fifth tab slot.
 *
 * THE BALANCE IS READ HERE, not passed in. It used to be a `balance` prop —
 * and all eight call sites passed `null` or omitted it, so the "Chips" branch
 * was unreachable and every signed-in player was labelled GUEST on every tab
 * while `src/features/wallet` (store, gateway, three test files) sat wired to
 * nothing at all. Found in phase 14 s4 by signing in on the simulator and
 * watching the header not change. A prop that every caller must remember to
 * pass is a prop every caller eventually forgets; reading the store is the
 * only version that cannot silently regress.
 *
 * The four not-a-number states are deliberately distinct and none of them
 * renders a zero — see `wallet-store.ts`, which makes the same point at
 * length. A rendered `0` is a claim about someone's chips.
 */

import { useEffect } from "react";
import { Pressable, StyleSheet, useWindowDimensions, View } from "react-native";
import { router } from "expo-router";
import Svg, { Circle, Path } from "react-native-svg";

import { useAuthStore } from "../../features/auth/auth-store";
import { useWalletStore } from "../../features/wallet";
import { colors, MIN_TOUCH_TARGET, radius, spacing } from "../../design/tokens";
import { formatChips } from "../../design/typography";
import { AppText } from "./AppText";

export interface ScreenHeaderProps {
  title: string;
  subtitle?: string;
}

/**
 * Above this text scale the header stacks instead of sitting in one row.
 *
 * 1.5 is where iOS's own "accessibility sizes" begin. Below it the row has
 * room for both halves; above it the fixed-width balance and avatar squeeze
 * the title block to a few characters and "Blackjack, without the noise."
 * wraps mid-word beside the GUEST badge — verified on the simulator at
 * `accessibility-extra-extra-extra-large`.
 */
const STACK_ABOVE_FONT_SCALE = 1.5;

export function ScreenHeader({ title, subtitle }: ScreenHeaderProps) {
  const { fontScale } = useWindowDimensions();
  const stacked = fontScale > STACK_ABOVE_FONT_SCALE;

  /*
   * Subscribed, then derived — never read through a store getter during
   * render, which the React Compiler memoises against a stable function
   * reference and freezes. That bug shipped here once and disabled the Deal
   * button permanently.
   */
  const signedIn = useAuthStore((state) => state.mode === "account" && state.session !== null);
  const walletStatus = useWalletStore((state) => state.status);
  const refreshWallet = useWalletStore((state) => state.refresh);
  const clearWallet = useWalletStore((state) => state.clear);

  /*
   * Keyed on the session, not on mount: the header is on every tab, so a
   * per-mount fetch would re-read the wallet on each tab switch. Signing out
   * clears it, so a number never outlives the session that earned it.
   */
  useEffect(() => {
    if (signedIn) void refreshWallet();
    else clearWallet();
  }, [signedIn, refreshWallet, clearWallet]);

  const chips = walletStatus.kind === "ready" ? walletStatus.wallet.balance : null;

  return (
    <View style={[styles.header, stacked ? styles.headerStacked : null]}>
      <View style={[styles.titleBlock, stacked ? styles.titleBlockStacked : null]}>
        <AppText variant="pageTitle">{title}</AppText>
        {subtitle ? (
          <AppText variant="caption" color="textSecondary">
            {subtitle}
          </AppText>
        ) : null}
      </View>

      <View style={[styles.right, stacked ? styles.rightStacked : null]}>
        {/*
          A guest has no server wallet, so we say "Guest" rather than showing a
          zero that would read as an empty balance. A signed-in player whose
          balance has not arrived yet gets the label alone for the same
          reason — the number appears when it is real, and never before.
        */}
        <View style={styles.balance}>
          <AppText variant="overline" color="textSecondary">
            {signedIn ? "Chips" : "Guest"}
          </AppText>
          {chips !== null ? (
            <AppText variant="bodyStrong" numeric testID="header-chips">
              {formatChips(chips)}
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
  headerStacked: {
    flexDirection: "column",
    alignItems: "flex-start",
  },
  titleBlock: {
    flex: 1,
    gap: 2,
  },
  // `flex: 1` would grow the title block vertically once the header is a
  // column, pushing the balance and avatar to the bottom of a tall box.
  titleBlockStacked: {
    flex: 0,
    alignSelf: "stretch",
  },
  right: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
  },
  // Stacked, the row is no longer competing for width, so it takes the full
  // line and keeps the avatar reachable at the leading edge.
  rightStacked: {
    alignSelf: "stretch",
    justifyContent: "flex-start",
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
