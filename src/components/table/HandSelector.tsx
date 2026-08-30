/**
 * The chip row above a split.
 *
 * One row, up to four chips, each naming a hand and its total. It exists so the
 * three hands you are NOT looking at remain understandable while the one you
 * are acting on keeps the whole of the felt — which is the only way four hands
 * fit a phone in portrait.
 *
 * This is not a control. It reports; it does not select. The engine decides
 * which hand is live and plays them strictly in order, so a tap that "chose" a
 * hand would either do nothing or contradict the rules — and a chip that looks
 * pressable and is not is worse than one that plainly is not. Each chip is a
 * `View` carrying its own accessibility label, so a screen reader reads four
 * summaries rather than announcing a button that cannot be pressed.
 *
 * A labelled `Pressable` REPLACES the text of everything inside it on iOS. That
 * has cost this project four surfaces (the Home card, the accessibility
 * switches, both Practice sheets), and it is why these are `View`s with
 * `accessible` rather than anything tappable.
 */

import { ScrollView, StyleSheet, View } from "react-native";

import type { SplitHandSummary } from "../../features/table/split-hands.js";
import { useTableTextVariant } from "../../design/accessibility";
import { colors, radius, spacing } from "../../design/tokens";
import { MAX_FIXED_CONTROL_FONT_SCALE } from "../../design/type-metrics";
import { AppText } from "../ui/AppText";

export interface HandSelectorProps {
  /** Empty for an unsplit hand, in which case this renders nothing at all. */
  hands: readonly SplitHandSummary[];
  testID?: string;
}

export function HandSelector({ hands, testID }: HandSelectorProps) {
  const variant = useTableTextVariant("caption");
  if (hands.length === 0) return null;

  return (
    /*
     * Horizontally scrollable, because four chips at the largest Dynamic Type
     * size are wider than a small phone. The row is fixed-geometry chrome, so
     * the text is capped as well — see `MAX_FIXED_CONTROL_FONT_SCALE`, which is
     * measured against the longest label that ships rather than picked.
     */
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      /*
       * `flexGrow: 0` and `alignItems: "center"` are BOTH load-bearing, and the
       * first version had neither. Found by looking at the rendered screen, not
       * by reading the code: inside `playerArea` — a column with `flexGrow: 1`
       * and `justifyContent: "center"` — the ScrollView expanded to the space
       * available, its children stretched to match, and `radius.pill` (999) on
       * a 200-point-tall box draws an ELLIPSE with the label spilling out of it.
       * A screenshot showed two ovals with "Hand 1 · 13" written across them.
       */
      style={styles.scroll}
      contentContainerStyle={styles.row}
      testID={testID}
    >
      {hands.map((hand) => (
        <View
          key={hand.id}
          style={[styles.chip, hand.active ? styles.chipActive : null]}
          accessible
          accessibilityLabel={hand.accessibilityLabel}
        >
          <AppText
            variant={variant}
            color={hand.active ? "textPrimary" : hand.settled ? "textDisabled" : "textSecondary"}
            numeric
            maxFontSizeMultiplier={MAX_FIXED_CONTROL_FONT_SCALE}
          >
            {hand.label}
          </AppText>
        </View>
      ))}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  scroll: {
    // Sizes to its content rather than to the space available.
    flexGrow: 0,
  },
  row: {
    flexDirection: "row",
    // So each chip is as tall as its own label, not as tall as the row.
    alignItems: "center",
    gap: spacing.sm,
    paddingVertical: spacing.xs,
  },
  chip: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surfaceRaised,
  },
  chipActive: {
    borderColor: colors.accent,
    backgroundColor: colors.surfaceSoft,
  },
});
