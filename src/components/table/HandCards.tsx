/**
 * A hand of cards plus its value.
 *
 * Cards overlap slightly so a four-card hand still fits a phone, while the
 * rank corner of every card stays visible. Values are announced in plain
 * language ("Soft 17", "Bust, 24") rather than as bare numbers.
 */

import { StyleSheet, View } from "react-native";

import { evaluateHand } from "../../../shared/blackjack/hand-value.js";
import { describeHandValue, handValueAccessibilityLabel } from "../../../shared/blackjack/hand-value.js";
import { isHiddenCard, isVisibleCard, type MaybeHiddenCard } from "../../../shared/blackjack/types.js";
import { useTableTextVariant } from "../../design/accessibility";
import { cardSizes, colors, radius, spacing, type CardSize } from "../../design/tokens";
import { AppText } from "../ui/AppText";
import { DealtCard } from "../cards/DealtCard";

export interface HandCardsProps {
  cards: MaybeHiddenCard[];
  size?: CardSize;
  /** Overrides the derived label, e.g. to show only the dealer's face-up total. */
  valueLabel?: string | null;
  /** Sub-line under the value, e.g. "Bet 100". */
  detail?: string;
  dimmed?: boolean;
  /** Highlights the hand currently being acted on. */
  focused?: boolean;
}

export function HandCards({
  cards,
  size = "hero",
  valueLabel,
  detail,
  dimmed = false,
  focused = false,
}: HandCardsProps) {
  const visible = cards.filter(isVisibleCard);
  const hasHidden = cards.some(isHiddenCard);

  // Value is derived from face-up cards only. A hidden card must never
  // contribute to a displayed total.
  const value = visible.length > 0 ? evaluateHand(visible) : null;

  const derivedLabel =
    valueLabel !== undefined
      ? valueLabel
      : value
        ? hasHidden
          ? `${value.bestTotal}`
          : describeHandValue(value)
        : null;

  const accessibleValue =
    value && !hasHidden ? handValueAccessibilityLabel(value) : derivedLabel ?? "";

  const overlap = cardSizes[size].width * 0.32;
  const valueVariant = useTableTextVariant(size === "hero" ? "sectionTitle" : "caption");
  const detailVariant = useTableTextVariant("caption");

  return (
    <View style={[styles.container, focused ? styles.focused : null]}>
      <View style={styles.fan} accessible={false}>
        {cards.map((card, index) => (
          <View
            // Keyed by physical card id so React mounts a fresh component per
            // arriving card — that is what makes the deal animation correct
            // without diffing previous hands by hand. The hole card keeps a
            // stable key across its reveal so it flips rather than remounting.
            key={isHiddenCard(card) ? `hole-${index}` : card.id}
            style={index === 0 ? null : { marginLeft: -overlap }}
          >
            <DealtCard card={card} size={size} index={index} dimmed={dimmed} />
          </View>
        ))}
      </View>

      {derivedLabel ? (
        <View style={styles.valueRow}>
          <AppText
            variant={valueVariant}
            color={dimmed ? "textSecondary" : "textPrimary"}
            numeric
            accessibilityLabel={accessibleValue}
          >
            {derivedLabel}
          </AppText>
          {detail ? (
            <AppText variant={detailVariant} color="textSecondary" numeric>
              {` · ${detail}`}
            </AppText>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    alignItems: "center",
    gap: spacing.sm,
    paddingVertical: spacing.xs,
  },
  focused: {
    borderRadius: radius.card,
    borderWidth: 1,
    borderColor: colors.accent,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  fan: {
    flexDirection: "row",
    alignItems: "center",
  },
  valueRow: {
    flexDirection: "row",
    alignItems: "baseline",
  },
});
