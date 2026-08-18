/**
 * The Practice table.
 *
 * This screen renders authoritative engine state and nothing else. It owns no
 * rules: what the player may do comes from `getLegalActions`, and every change
 * goes through `applyCommand`. If a control here disagrees with the engine, the
 * engine is right.
 *
 * The current player's hand is the visual priority. Split hands use a selector
 * rather than shrinking four hands into unreadability.
 */

import { useEffect, useMemo } from "react";
import { Pressable, ScrollView, StyleSheet, View } from "react-native";
import { router } from "expo-router";
import { SafeAreaView } from "react-native-safe-area-context";

import { describeHandValue, evaluatePlayerHand } from "../../shared/blackjack/hand-value.js";
import { getLegalActions } from "../../shared/blackjack/legal-actions.js";
import type { PlayerHand } from "../../shared/blackjack/types.js";
import { ActionDock } from "../../src/components/table/ActionDock";
import { BettingBar } from "../../src/components/table/BettingBar";
import { HandCards } from "../../src/components/table/HandCards";
import { OutcomeBadge } from "../../src/components/table/OutcomeBadge";
import { InsuranceSheet } from "../../src/components/table/InsuranceSheet";
import { AppText } from "../../src/components/ui/AppText";
import { Button } from "../../src/components/ui/Button";
import { colors, layout, radius, spacing } from "../../src/design/tokens";
import { formatChipDelta, formatChips } from "../../src/design/typography";
import {
  AssistanceModeSelector,
  ChallengeFeedback,
  StrategyPanel,
} from "../../src/components/table/StrategyPanel";
import { actionLabel, computeAdvice, NO_ADVICE } from "../../src/features/practice/advice";
import { useTableFeedback } from "../../src/features/practice/use-table-feedback";
import { usePersistOnBackground } from "../../src/features/practice/use-persist-on-background";
import {
  NO_LEGAL_ACTIONS,
  PRACTICE_SEAT_ID,
  usePracticeStore,
} from "../../src/features/practice/practice-store";

export default function PracticeTableScreen() {
  const game = usePracticeStore((state) => state.game);
  const stagedBet = usePracticeStore((state) => state.stagedBet);
  const lastBet = usePracticeStore((state) => state.lastBet);
  const error = usePracticeStore((state) => state.error);
  const recentEvents = usePracticeStore((state) => state.recentEvents);
  const hydrate = usePracticeStore((state) => state.hydrate);
  const hydrated = usePracticeStore((state) => state.hydrated);

  const addChip = usePracticeStore((state) => state.addChip);
  const clearBet = usePracticeStore((state) => state.clearBet);
  const repeatLastBet = usePracticeStore((state) => state.repeatLastBet);
  const lockBet = usePracticeStore((state) => state.lockBet);
  const act = usePracticeStore((state) => state.act);
  const takeInsurance = usePracticeStore((state) => state.takeInsurance);
  const declineInsurance = usePracticeStore((state) => state.declineInsurance);
  const nextHand = usePracticeStore((state) => state.nextHand);
  const resetBankroll = usePracticeStore((state) => state.resetBankroll);
  const mode = usePracticeStore((state) => state.mode);
  const setMode = usePracticeStore((state) => state.setMode);
  const feedback = usePracticeStore((state) => state.feedback);
  const dismissFeedback = usePracticeStore((state) => state.dismissFeedback);
  const stats = usePracticeStore((state) => state.stats);

  /**
   * Legality is DERIVED from the subscribed game state, never fetched by calling
   * a store getter during render. A getter call does not subscribe, so it only
   * appears to work when something else re-renders the component — and under the
   * React Compiler it is memoised against a stable function reference and frozen
   * at its first result, silently leaving controls stuck in their initial state.
   *
   * `game` is replaced by every accepted command (the engine returns new state
   * rather than mutating), so it is a sound memo key.
   */
  const legal = useMemo(
    () => (game ? getLegalActions(game, PRACTICE_SEAT_ID) : NO_LEGAL_ACTIONS),
    [game],
  );

  /**
   * Advice is derived from the same subscribed state as legality, for the same
   * reason: a store getter called during render does not subscribe and, under
   * the React Compiler, freezes at its first result.
   */
  const advice = useMemo(() => {
    if (!game) return NO_ADVICE;
    const current = game.seats.find((candidate) => candidate.seatId === PRACTICE_SEAT_ID);
    if (!current) return NO_ADVICE;
    return computeAdvice(game, current, legal.actions);
  }, [game, legal]);

  // Restore the saved session before showing a table. Starting a fresh shoe and
  // swapping it out a moment later would flash a hand the player never played.
  useEffect(() => {
    if (!hydrated) void hydrate();
  }, [hydrated, hydrate]);

  // Feedback follows authoritative events, so it can never disagree with what
  // actually happened at the table.
  useTableFeedback(recentEvents, error);

  // Force the save to land before iOS suspends or kills the app.
  usePersistOnBackground();

  if (!game) {
    return (
      <SafeAreaView style={styles.screen}>
        <View style={styles.centered}>
          <AppText color="textSecondary">Shuffling…</AppText>
        </View>
      </SafeAreaView>
    );
  }

  const seat = game.seats.find((candidate) => candidate.seatId === PRACTICE_SEAT_ID);
  if (!seat) return null;

  const isBetting = game.phase === "BETTING_OPEN";
  const isComplete = game.phase === "HAND_COMPLETE";
  const activeHandIndex = game.activeHandIndex ?? seat.currentHandIndex;

  // Dealer total before reveal reflects face-up cards only; HandCards derives
  // that itself from the cards it is given.
  const dealerCards = game.dealer.holeCardRevealed
    ? game.dealer.cards
    : game.dealer.cards.map((card, index) =>
        index === 1 && game.rules.dealerHoleCard ? ({ hidden: true } as const) : card,
      );

  const roundNet = isComplete
    ? seat.hands.reduce((sum, hand) => sum + (hand.outcome?.net ?? 0), 0)
    : 0;

  return (
    <SafeAreaView style={styles.screen} edges={["top", "bottom"]}>
      <View style={styles.header}>
        <Pressable
          onPress={() => router.back()}
          accessibilityRole="button"
          accessibilityLabel="Leave practice table"
          style={styles.headerButton}
        >
          <AppText color="textSecondary">Close</AppText>
        </Pressable>

        <View style={styles.headerCenter}>
          <AppText variant="overline" color="textSecondary">
            Practice
          </AppText>
          <AppText variant="caption" color="textDisabled" numeric>
            {`Hand ${game.handNumber} · Shoe ${game.shoe.shuffleNumber}`}
          </AppText>
        </View>

        <Pressable
          onPress={resetBankroll}
          disabled={!isBetting}
          accessibilityRole="button"
          accessibilityLabel="Reset practice bankroll"
          style={[styles.headerButton, !isBetting ? styles.headerButtonDisabled : null]}
        >
          <AppText color={isBetting ? "textSecondary" : "textDisabled"}>Reset</AppText>
        </Pressable>
      </View>

      <ScrollView contentContainerStyle={styles.felt} showsVerticalScrollIndicator={false}>
        <View style={styles.dealerArea}>
          <AppText variant="overline" color="textSecondary">
            Dealer
          </AppText>
          {dealerCards.length > 0 ? (
            <HandCards cards={[...dealerCards]} size="medium" />
          ) : (
            <AppText variant="caption" color="textDisabled">
              Waiting for bets
            </AppText>
          )}
        </View>

        <View style={styles.divider} />

        <View style={styles.playerArea}>
          {seat.hands.length === 0 ? (
            <AppText variant="caption" color="textDisabled">
              Place a bet to be dealt in.
            </AppText>
          ) : (
            <>
              {seat.hands.length > 1 ? (
                <View style={styles.handSelector}>
                  {seat.hands.map((hand, index) => (
                    <HandChip
                      key={hand.id}
                      hand={hand}
                      index={index}
                      active={index === activeHandIndex}
                      splitAceTwentyOneIsBlackjack={game.rules.splitAceTwentyOneIsBlackjack}
                    />
                  ))}
                </View>
              ) : null}

              {seat.hands.map((hand, index) => {
                const isActive = index === activeHandIndex;
                // Only the focused hand gets the large treatment.
                if (seat.hands.length > 1 && !isActive) return null;

                return (
                  <View key={hand.id} style={styles.heroHand}>
                    <HandCards
                      cards={[...hand.cards]}
                      size="hero"
                      detail={`Bet ${formatChips(hand.wager)}`}
                      focused={seat.hands.length > 1}
                    />
                    {hand.outcome ? (
                      <OutcomeBadge kind={hand.outcome.kind} net={hand.outcome.net} />
                    ) : null}
                  </View>
                );
              })}
            </>
          )}
        </View>
      </ScrollView>

      {error ? (
        <View style={styles.errorBar}>
          <AppText variant="caption" color="danger">
            {error}
          </AppText>
        </View>
      ) : null}

      <View style={styles.dock}>
        {/* Assistance is chosen between hands, not mid-decision: switching to
            Learn while holding a hard 16 would turn a graded choice into a
            revealed one. */}
        {isBetting ? (
          <View style={styles.modeSection}>
            <AssistanceModeSelector mode={mode} onChange={setMode} />
            {stats.decisions > 0 ? (
              <AppText variant="caption" color="textDisabled" align="center" numeric>
                {`Strategy accuracy ${Math.round((stats.correct / stats.decisions) * 100)}% · ${stats.decisions} decisions`}
              </AppText>
            ) : null}
          </View>
        ) : null}

        {/* Learn and Analysis surface the recommendation before the decision. */}
        {!isBetting && !isComplete ? <StrategyPanel mode={mode} advice={advice} /> : null}

        {/* Challenge grades it immediately afterwards, without blocking play. */}
        {feedback && mode === "challenge" ? (
          <ChallengeFeedback
            correct={feedback.correct}
            recommended={actionLabel(feedback.recommended)}
            evLost={feedback.evLost}
            onDismiss={dismissFeedback}
          />
        ) : null}

        {isBetting ? (
          <BettingBar
            legal={legal}
            stagedBet={stagedBet}
            lastBet={lastBet}
            availableStack={seat.stack}
            onAddChip={addChip}
            onClear={clearBet}
            onRepeat={repeatLastBet}
            onLock={lockBet}
          />
        ) : isComplete ? (
          <View style={styles.completeDock}>
            <View style={styles.resultSummary}>
              <AppText variant="sectionTitle" numeric>
                {roundNet === 0 ? "Push" : formatChipDelta(roundNet)}
              </AppText>
              <AppText variant="caption" color="textSecondary" numeric>
                {`Bankroll ${formatChips(seat.stack)}`}
              </AppText>
            </View>
            <Button label="Next hand" onPress={nextHand} testID="next-hand" />
          </View>
        ) : (
          <ActionDock legal={legal} onAction={act} />
        )}
      </View>

      {/*
        Mounted only during the offer. Relying on the Modal's `visible` prop
        alone left it on screen after the phase advanced, rendering meaningless
        props ("Insurance costs 0 chips") because the stake is only defined
        while the offer is live. Unmounting is unambiguous on every platform.
      */}
      {game.phase === "INSURANCE_OFFER" ? (
        <InsuranceSheet
          visible
          stake={legal.insuranceStake ?? 0}
          isEvenMoney={legal.insuranceIsEvenMoney}
          canAfford={legal.canTakeInsurance}
          onTake={takeInsurance}
          onDecline={declineInsurance}
        />
      ) : null}
    </SafeAreaView>
  );
}

/** Compact representation of one split hand in the selector. */
function HandChip({
  hand,
  index,
  active,
  splitAceTwentyOneIsBlackjack,
}: {
  hand: PlayerHand;
  index: number;
  active: boolean;
  splitAceTwentyOneIsBlackjack: boolean;
}) {
  const value = evaluatePlayerHand(hand, splitAceTwentyOneIsBlackjack);
  const done = hand.status !== "ACTIVE";

  return (
    <View
      style={[styles.handChip, active ? styles.handChipActive : null]}
      accessible
      accessibilityLabel={`Hand ${index + 1}, ${done ? hand.status.toLowerCase() : describeHandValue(value)}${
        active ? ", active" : ""
      }`}
    >
      <AppText variant="caption" color={active ? "textPrimary" : "textSecondary"} numeric>
        {`Hand ${index + 1} · ${done && hand.status === "BUSTED" ? "Bust" : value.bestTotal}`}
      </AppText>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: colors.background,
  },
  centered: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
  },
  headerButton: {
    minWidth: 64,
    minHeight: 44,
    justifyContent: "center",
  },
  headerButtonDisabled: {
    opacity: 0.4,
  },
  headerCenter: {
    alignItems: "center",
    gap: 2,
  },
  felt: {
    flexGrow: 1,
    paddingHorizontal: layout.screenPadding,
    paddingBottom: spacing.xl,
    gap: spacing.xl,
    maxWidth: layout.maxTableWidth,
    width: "100%",
    alignSelf: "center",
  },
  dealerArea: {
    alignItems: "center",
    gap: spacing.sm,
    paddingTop: spacing.lg,
    minHeight: 140,
  },
  divider: {
    height: 1,
    backgroundColor: colors.border,
  },
  playerArea: {
    alignItems: "center",
    gap: spacing.lg,
    flexGrow: 1,
    justifyContent: "center",
    minHeight: 200,
  },
  heroHand: {
    alignItems: "center",
    gap: spacing.md,
  },
  handSelector: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: spacing.sm,
    justifyContent: "center",
  },
  handChip: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  handChipActive: {
    borderColor: colors.accent,
    backgroundColor: colors.surfaceRaised,
  },
  outcomeBadge: {
    alignItems: "center",
    gap: 2,
  },
  errorBar: {
    paddingHorizontal: layout.screenPadding,
    paddingBottom: spacing.sm,
  },
  modeSection: {
    gap: spacing.sm,
  },
  dock: {
    gap: spacing.md,
    paddingHorizontal: layout.screenPadding,
    paddingTop: spacing.lg,
    paddingBottom: spacing.md,
    borderTopWidth: 1,
    borderTopColor: colors.border,
    backgroundColor: colors.surface,
    maxWidth: layout.maxTableWidth,
    width: "100%",
    alignSelf: "center",
  },
  completeDock: {
    gap: spacing.md,
  },
  resultSummary: {
    alignItems: "center",
    gap: 2,
  },
});
