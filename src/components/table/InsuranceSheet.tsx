/**
 * Insurance prompt — a bottom sheet, never a full-screen interruption.
 *
 * The copy states the cost and the payout plainly. When the player holds a
 * natural the prompt becomes "Even Money", which is booked internally as
 * ordinary insurance so there is one accounting path in the ledger.
 */

import { Modal, StyleSheet, View } from "react-native";

import { colors, radius, spacing } from "../../design/tokens";
import { formatChips } from "../../design/typography";
import { AppText } from "../ui/AppText";
import { Button } from "../ui/Button";

export interface InsuranceSheetProps {
  visible: boolean;
  stake: number;
  isEvenMoney: boolean;
  canAfford: boolean;
  onTake: () => void;
  onDecline: () => void;
}

export function InsuranceSheet({
  visible,
  stake,
  isEvenMoney,
  canAfford,
  onTake,
  onDecline,
}: InsuranceSheetProps) {
  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onDecline}>
      <View style={styles.scrim}>
        <View style={styles.sheet} accessibilityViewIsModal>
          <AppText variant="sectionTitle">Dealer is showing an Ace.</AppText>

          {isEvenMoney ? (
            <AppText variant="body" color="textSecondary">
              You have blackjack. Take even money to be paid 1:1 now, whatever the dealer holds.
            </AppText>
          ) : (
            <AppText variant="body" color="textSecondary">
              {`Insurance costs ${formatChips(stake)} chips. It pays 2:1 if the dealer has blackjack.`}
            </AppText>
          )}

          {!canAfford && !isEvenMoney ? (
            <AppText variant="caption" color="warning">
              You do not have enough chips to insure this hand.
            </AppText>
          ) : null}

          <View style={styles.actions}>
            <Button
              label={isEvenMoney ? "Decline" : "No thanks"}
              onPress={onDecline}
              variant="secondary"
              size="medium"
              testID="insurance-decline"
            />
            <Button
              label={isEvenMoney ? "Take Even Money" : `Insure ${formatChips(stake)}`}
              onPress={onTake}
              size="medium"
              disabled={!canAfford}
              testID="insurance-take"
            />
          </View>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  scrim: {
    flex: 1,
    backgroundColor: colors.scrim,
    justifyContent: "flex-end",
  },
  sheet: {
    backgroundColor: colors.surface,
    borderTopLeftRadius: radius.sheet,
    borderTopRightRadius: radius.sheet,
    padding: spacing.xl,
    paddingBottom: spacing.xxxl,
    gap: spacing.lg,
    borderTopWidth: 1,
    borderColor: colors.border,
  },
  actions: {
    flexDirection: "row",
    gap: spacing.md,
    marginTop: spacing.sm,
  },
});
