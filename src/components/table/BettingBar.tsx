/**
 * Betting controls, shown in place of the action dock during BETTING_OPEN.
 *
 * Only chip denominations that are actually usable at this table are rendered.
 * The engine still validates every amount — these controls make an illegal bet
 * hard to express, they do not make it impossible, which is the server's job.
 */

import { ScrollView, StyleSheet, View } from "react-native";

import type { LegalActionSet } from "../../../shared/blackjack/legal-actions.js";
import { colors, MIN_TOUCH_TARGET, radius, spacing } from "../../design/tokens";
import { formatChips } from "../../design/typography";
import { playSound } from "../../lib/audio/audio";
import { AppText } from "../ui/AppText";
import { Button } from "../ui/Button";
import { Pressable } from "react-native";

const DENOMINATIONS = [10, 50, 100, 500, 1_000] as const;

export interface BettingBarProps {
  legal: LegalActionSet;
  stagedBet: number;
  lastBet: number;
  availableStack: number;
  onAddChip: (amount: number) => void;
  onClear: () => void;
  onRepeat: () => void;
  onLock: () => void;
}

export function BettingBar({
  legal,
  stagedBet,
  lastBet,
  availableStack,
  onAddChip,
  onClear,
  onRepeat,
  onLock,
}: BettingBarProps) {
  const bounds = legal.betBounds;

  /*
   * A chip set down, and a button pressed. Both come from the specification's
   * audio list, and both are the quietest cues in the palette — they accompany
   * a haptic rather than announce anything.
   */
  const addChip = (denomination: number) => {
    playSound("chipTap");
    onAddChip(denomination);
  };
  const deal = () => {
    playSound("buttonPress");
    onLock();
  };

  // Show only denominations that fit inside this table's limits.
  const usable = DENOMINATIONS.filter(
    (denomination) => !bounds || denomination <= bounds.max,
  );

  const belowMinimum = bounds ? stagedBet > 0 && stagedBet < bounds.min : false;

  return (
    <View style={styles.container}>
      <View style={styles.summary}>
        <View>
          <AppText variant="overline" color="textSecondary">
            Bet
          </AppText>
          <AppText variant="pageTitle" numeric>
            {formatChips(stagedBet)}
          </AppText>
        </View>
        <View style={styles.summaryRight}>
          <AppText variant="overline" color="textSecondary">
            Available
          </AppText>
          <AppText variant="sectionTitle" color="textSecondary" numeric>
            {formatChips(availableStack)}
          </AppText>
        </View>
      </View>

      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.chipRow}
      >
        {usable.map((denomination) => {
          const affordable = stagedBet + denomination <= availableStack + stagedBet;
          const withinMax = !bounds || stagedBet + denomination <= bounds.max;
          const enabled = legal.canPlaceBet && affordable && withinMax;

          return (
            <Pressable
              key={denomination}
              onPress={() => addChip(denomination)}
              disabled={!enabled}
              // testID is distinct from the accessibility label: on iOS the label
              // is what a screen reader speaks, while the identifier is what E2E
              // selects on. Relying on the label made a flow match nothing.
              testID={`chip-${denomination}`}
              accessibilityRole="button"
              accessibilityLabel={`Add ${formatChips(denomination)} chips`}
              accessibilityState={{ disabled: !enabled }}
              style={({ pressed }) => [
                styles.chip,
                pressed && enabled ? styles.chipPressed : null,
                !enabled ? styles.chipDisabled : null,
              ]}
            >
              <AppText variant="bodyStrong" color={enabled ? "textPrimary" : "textDisabled"} numeric>
                {formatChips(denomination)}
              </AppText>
            </Pressable>
          );
        })}
      </ScrollView>

      {belowMinimum && bounds ? (
        <AppText variant="caption" color="warning">
          {`Table minimum is ${formatChips(bounds.min)}.`}
        </AppText>
      ) : null}

      <View style={styles.actions}>
        <Button
          label="Clear"
          onPress={onClear}
          variant="quiet"
          size="medium"
          disabled={stagedBet === 0}
        />
        <Button
          label="Repeat"
          onPress={onRepeat}
          variant="secondary"
          size="medium"
          disabled={lastBet <= 0 || lastBet > availableStack + stagedBet}
          accessibilityHint={lastBet > 0 ? `Bet ${formatChips(lastBet)} again` : undefined}
        />
        <Button
          label="Deal"
          onPress={deal}
          size="medium"
          disabled={!legal.canLockBet}
          testID="bet-deal"
        />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    gap: spacing.md,
  },
  summary: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "flex-end",
  },
  summaryRight: {
    alignItems: "flex-end",
  },
  chipRow: {
    gap: spacing.sm,
    paddingVertical: spacing.xs,
  },
  chip: {
    minWidth: 64,
    minHeight: MIN_TOUCH_TARGET,
    paddingHorizontal: spacing.md,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: colors.borderStrong,
    backgroundColor: colors.surfaceRaised,
    alignItems: "center",
    justifyContent: "center",
  },
  chipPressed: {
    opacity: 0.7,
    transform: [{ scale: 0.97 }],
  },
  chipDisabled: {
    opacity: 0.35,
  },
  actions: {
    flexDirection: "row",
    gap: spacing.md,
  },
});
