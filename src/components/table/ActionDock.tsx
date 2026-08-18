/**
 * The action dock.
 *
 * Hit and Stand are always primary and always in the same place. Double and
 * Split are secondary but immediately visible when legal — never hidden behind
 * an overflow menu, because a player who cannot find Split will misplay the
 * hand. Surrender is a quieter text control.
 *
 * Illegal actions render disabled rather than disappearing, so the dock does not
 * reflow between hands and muscle memory keeps working.
 */

import { StyleSheet, View } from "react-native";

import type { LegalActionSet } from "../../../shared/blackjack/legal-actions.js";
import type { PlayerActionType } from "../../../shared/blackjack/types.js";
import { formatChips } from "../../design/typography";
import { spacing } from "../../design/tokens";
import { Button } from "../ui/Button";
import { playSound } from "../../lib/audio/audio";

export interface ActionDockProps {
  legal: LegalActionSet;
  onAction: (action: PlayerActionType) => void;
  /** True while an online command is in flight. */
  pending?: boolean;
}

export function ActionDock({ legal, onAction, pending = false }: ActionDockProps) {
  const can = (action: PlayerActionType) => legal.actions.includes(action);

  /*
   * The specification's "button feedback", scoped to the table.
   *
   * Deliberately NOT wired into the shared `Button`, which would put a click on
   * every navigation tap, every Settings toggle and every sign-in field in the
   * app. Feedback belongs where a decision is being made.
   */
  const act = (action: PlayerActionType) => {
    playSound("buttonPress");
    onAction(action);
  };

  const doubleCost = legal.chipCost.DOUBLE;
  const splitCost = legal.chipCost.SPLIT;

  return (
    <View style={styles.dock}>
      <View style={styles.row}>
        <Button
          label="Hit"
          onPress={() => act("HIT")}
          disabled={!can("HIT")}
          pending={pending}
          accessibilityHint="Take another card"
          testID="action-hit"
        />
        <Button
          label="Stand"
          onPress={() => act("STAND")}
          variant="secondary"
          disabled={!can("STAND")}
          accessibilityHint="Take no more cards"
          testID="action-stand"
        />
      </View>

      <View style={styles.row}>
        <Button
          label="Double"
          onPress={() => act("DOUBLE")}
          variant="secondary"
          size="medium"
          disabled={!can("DOUBLE")}
          accessibilityHint={
            doubleCost ? `Adds ${formatChips(doubleCost)} chips and takes exactly one more card` : undefined
          }
          testID="action-double"
        />
        <Button
          label="Split"
          onPress={() => act("SPLIT")}
          variant="secondary"
          size="medium"
          disabled={!can("SPLIT")}
          accessibilityHint={splitCost ? `Adds ${formatChips(splitCost)} chips` : undefined}
          testID="action-split"
        />
      </View>

      {can("SURRENDER") ? (
        <Button
          label="Surrender"
          onPress={() => act("SURRENDER")}
          variant="quiet"
          size="medium"
          accessibilityHint="Give up this hand and take back half your bet"
          testID="action-surrender"
        />
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  dock: {
    gap: spacing.md,
  },
  row: {
    flexDirection: "row",
    gap: spacing.md,
  },
});
