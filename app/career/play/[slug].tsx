/**
 * A career session — either a dealt table or a drill, depending on the node.
 *
 * Both paths reuse what already exists: standard nodes render the same table
 * components as Practice and run through the same engine; drill nodes present
 * scenarios from `drillPool`, which guarantees every question is gradeable.
 *
 * The result screen reports the stars honestly, including the ones that were
 * not measurable — "you were not measured" and "you fell short" are different
 * statements and must not look the same.
 */

import { useEffect } from "react";
import { router, useLocalSearchParams } from "expo-router";
import { Pressable, ScrollView, StyleSheet, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { AppText } from "../../../src/components/ui/AppText";
import { Button } from "../../../src/components/ui/Button";
import { SurfaceCard } from "../../../src/components/ui/Card";
import { ActionDock } from "../../../src/components/table/ActionDock";
import { BettingBar } from "../../../src/components/table/BettingBar";
import { HandCards } from "../../../src/components/table/HandCards";
import { InsuranceSheet } from "../../../src/components/table/InsuranceSheet";
import { StrategyPanel } from "../../../src/components/table/StrategyPanel";
import { PlayingCard } from "../../../src/components/cards/PlayingCard";
import { colors, layout, radius, spacing } from "../../../src/design/tokens";
import { formatChips } from "../../../src/design/typography";
import { getLegalActions } from "../../../shared/blackjack/legal-actions.js";
import { careerNodeBySlug, careerNodeWorkload } from "../../../shared/career/nodes.js";
import { actionLabel, computeAdvice, NO_ADVICE } from "../../../src/features/practice/advice";
import { NO_LEGAL_ACTIONS, PRACTICE_SEAT_ID } from "../../../src/features/practice/practice-store";
import {
  CAREER_SEAT_ID,
  useCareerSessionStore,
} from "../../../src/features/career/career-session-store";
import { StarRow } from "../index";

export default function CareerSessionScreen() {
  const { slug } = useLocalSearchParams<{ slug: string }>();
  const node = typeof slug === "string" ? careerNodeBySlug(slug) : null;

  const session = useCareerSessionStore();

  useEffect(() => {
    if (typeof slug === "string" && session.node?.slug !== slug && !session.finished) {
      session.start(slug);
    }
    // Starting is keyed on the slug alone; re-running on every store change
    // would restart the session mid-hand.
  }, [slug]);

  if (!node) {
    return (
      <SafeAreaView style={styles.screen} edges={["top"]}>
        <View style={styles.centred}>
          <AppText variant="sectionTitle">Node not found</AppText>
          <Button label="Back to Career" onPress={() => router.replace("/career")} />
        </View>
      </SafeAreaView>
    );
  }

  if (session.finished && session.evaluation) {
    return <SessionResult />;
  }

  return node.format === "drill" ? <DrillSession /> : <StandardSession />;
}

// ---------------------------------------------------------------------------

function StandardSession() {
  const session = useCareerSessionStore();
  const game = session.game;
  const node = session.node;

  if (!game || !node) {
    return (
      <SafeAreaView style={styles.screen} edges={["top"]}>
        <View style={styles.centred}>
          <AppText color="textSecondary">Shuffling…</AppText>
        </View>
      </SafeAreaView>
    );
  }

  const seat = game.seats.find((candidate) => candidate.seatId === CAREER_SEAT_ID);
  if (!seat) return null;

  const legal = getLegalActions(game, CAREER_SEAT_ID);
  const advice = computeAdvice(game, seat, legal.actions);
  const isBetting = game.phase === "BETTING_OPEN";
  const isComplete = game.phase === "HAND_COMPLETE";

  const dealerCards = game.dealer.holeCardRevealed
    ? game.dealer.cards
    : game.dealer.cards.map((card, index) =>
        index === 1 && game.rules.dealerHoleCard ? ({ hidden: true } as const) : card,
      );

  const target = node.hands ?? 0;

  return (
    <SafeAreaView style={styles.screen} edges={["top", "bottom"]}>
      <SessionHeader
        title={node.title}
        progress={`Hand ${Math.min(session.totals.handsPlayed + 1, target)} of ${target}`}
      />

      <ScrollView contentContainerStyle={styles.felt} showsVerticalScrollIndicator={false}>
        <View style={styles.dealer}>
          <AppText variant="overline" color="textSecondary">
            Dealer
          </AppText>
          {dealerCards.length > 0 ? (
            <HandCards cards={[...dealerCards]} size="medium" />
          ) : (
            <AppText variant="caption" color="textDisabled">
              Waiting for your bet
            </AppText>
          )}
        </View>

        <View style={styles.divider} />

        <View style={styles.player}>
          {seat.hands.length === 0 ? (
            <AppText variant="caption" color="textDisabled">
              Place a bet to be dealt in.
            </AppText>
          ) : (
            seat.hands.map((hand, index) =>
              index === (game.activeHandIndex ?? seat.currentHandIndex) || seat.hands.length === 1 ? (
                <HandCards
                  key={hand.id}
                  cards={[...hand.cards]}
                  size="hero"
                  detail={`Bet ${formatChips(hand.wager)}`}
                />
              ) : null,
            )
          )}
        </View>
      </ScrollView>

      <View style={styles.dock}>
        {!isBetting && !isComplete ? (
          <StrategyPanel mode={node.assistance} advice={advice} />
        ) : null}

        {isBetting ? (
          <BettingBar
            legal={legal}
            stagedBet={session.stagedBet}
            lastBet={0}
            availableStack={seat.stack}
            onAddChip={session.addChip}
            onClear={session.clearBet}
            onRepeat={() => {}}
            onLock={session.lockBet}
          />
        ) : isComplete ? (
          <View style={styles.completeDock}>
            <AppText variant="caption" color="textSecondary" numeric align="center">
              {`Bankroll ${formatChips(seat.stack)}`}
            </AppText>
            <Button label="Next hand" onPress={session.nextHand} testID="career-next-hand" />
          </View>
        ) : (
          <ActionDock legal={legal} onAction={session.act} />
        )}
      </View>

      {game.phase === "INSURANCE_OFFER" ? (
        <InsuranceSheet
          visible
          stake={legal.insuranceStake ?? 0}
          isEvenMoney={legal.insuranceIsEvenMoney}
          canAfford={legal.canTakeInsurance}
          onTake={session.takeInsurance}
          onDecline={session.declineInsurance}
        />
      ) : null}
    </SafeAreaView>
  );
}

// ---------------------------------------------------------------------------

function DrillSession() {
  const session = useCareerSessionStore();
  const node = session.node;
  const scenario = session.scenarios[session.scenarioIndex];

  if (!node || !scenario) {
    return (
      <SafeAreaView style={styles.screen} edges={["top"]}>
        <View style={styles.centred}>
          <AppText color="textSecondary">Preparing drill…</AppText>
        </View>
      </SafeAreaView>
    );
  }

  const target = node.decisions ?? 0;
  const feedback = session.drillFeedback;

  return (
    <SafeAreaView style={styles.screen} edges={["top", "bottom"]}>
      <SessionHeader
        title={node.title}
        progress={`Decision ${Math.min(session.totals.decisions + 1, target)} of ${target}`}
        badge="Drill"
      />

      <ScrollView contentContainerStyle={styles.felt} showsVerticalScrollIndicator={false}>
        <View style={styles.dealer}>
          <AppText variant="overline" color="textSecondary">
            Dealer shows
          </AppText>
          <PlayingCard card={scenario.dealerUpcard} size="medium" />
        </View>

        <View style={styles.divider} />

        <View style={styles.player}>
          <AppText variant="overline" color="textSecondary">
            Your hand
          </AppText>
          <View style={styles.drillHand}>
            {scenario.playerCards.map((card) => (
              <PlayingCard key={card.id} card={card} size="hero" />
            ))}
          </View>
          <AppText variant="sectionTitle">{scenario.handLabel}</AppText>
        </View>
      </ScrollView>

      <View style={styles.dock}>
        {feedback ? (
          <View
            style={[styles.feedback, feedback.correct ? styles.feedbackGood : styles.feedbackBad]}
            accessibilityLiveRegion="polite"
          >
            <AppText variant="bodyStrong" color={feedback.correct ? "success" : "warning"}>
              {feedback.correct
                ? "✓ Correct"
                : `Better: ${actionLabel(feedback.recommended as never)}`}
            </AppText>
            <AppText variant="caption" color="textSecondary">
              {`${scenario.handLabel} against ${scenario.upcardLabel}`}
            </AppText>
          </View>
        ) : null}

        {feedback ? (
          <Button label="Next" onPress={session.nextDrill} testID="drill-next" />
        ) : (
          <View style={styles.drillActions}>
            {scenario.legalActions.map((action) => (
              <Button
                key={action}
                label={actionLabel(action as never)}
                onPress={() => session.answerDrill(action)}
                variant={action === "HIT" ? "primary" : "secondary"}
                size="medium"
                testID={`drill-${action.toLowerCase()}`}
              />
            ))}
          </View>
        )}
      </View>
    </SafeAreaView>
  );
}

// ---------------------------------------------------------------------------

function SessionResult() {
  const session = useCareerSessionStore();
  const node = session.node;
  const evaluation = session.evaluation;
  if (!node || !evaluation) return null;

  return (
    <SafeAreaView style={styles.screen} edges={["top", "bottom"]}>
      <ScrollView contentContainerStyle={styles.result} showsVerticalScrollIndicator={false}>
        <AppText variant="overline" color="textSecondary">
          {node.title}
        </AppText>
        <StarRow earned={evaluation.stars} />
        <AppText variant="display" numeric>
          {`${evaluation.stars} of 3`}
        </AppText>

        <SurfaceCard>
          <Objective label="Finish the node" status={evaluation.completion} />
          <Objective
            label={`Strategy accuracy ${node.accuracyStarPercent}%`}
            status={evaluation.accuracy}
            detail={
              evaluation.accuracyPercent === null
                ? "Not measured — no gradeable decisions"
                : `${evaluation.accuracyPercent}% over ${evaluation.gradedDecisions} decisions`
            }
          />
          <Objective label="Mastery target" status={evaluation.mastery} />
        </SurfaceCard>

        {evaluation.unlocksNext ? (
          <AppText variant="caption" color="success" align="center">
            Next node unlocked.
          </AppText>
        ) : null}

        <Button
          label="Back to Career"
          onPress={() => {
            session.abandon();
            router.replace("/career");
          }}
          testID="career-result-done"
        />
      </ScrollView>
    </SafeAreaView>
  );
}

function Objective({
  label,
  status,
  detail,
}: {
  label: string;
  status: "EARNED" | "MISSED" | "UNMEASURED";
  detail?: string;
}) {
  // Three distinct states, and the glyph carries the meaning so it is never
  // colour alone. "Not measured" must not look like "missed".
  const glyph = status === "EARNED" ? "★" : status === "MISSED" ? "☆" : "–";
  const tone = status === "EARNED" ? "success" : status === "MISSED" ? "textSecondary" : "textDisabled";

  return (
    <View style={styles.objective} accessible accessibilityLabel={`${label}: ${status.toLowerCase()}`}>
      <AppText variant="body" color={tone}>
        {`${glyph}  ${label}`}
      </AppText>
      {detail ? (
        <AppText variant="caption" color="textDisabled">
          {detail}
        </AppText>
      ) : null}
    </View>
  );
}

function SessionHeader({
  title,
  progress,
  badge,
}: {
  title: string;
  progress: string;
  badge?: string;
}) {
  const session = useCareerSessionStore();
  return (
    <View style={styles.header}>
      <Pressable
        onPress={() => {
          session.abandon();
          router.back();
        }}
        accessibilityRole="button"
        accessibilityLabel="Leave this session"
        style={styles.headerButton}
      >
        <AppText color="textSecondary">Close</AppText>
      </Pressable>
      <View style={styles.headerCentre}>
        <AppText variant="overline" color="textSecondary">
          {title}
        </AppText>
        <AppText variant="caption" color="textDisabled" numeric>
          {progress}
        </AppText>
      </View>
      <View style={styles.headerButton}>
        {badge ? (
          <AppText variant="caption" color="info">
            {badge}
          </AppText>
        ) : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background },
  centred: { flex: 1, alignItems: "center", justifyContent: "center", gap: spacing.lg },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
  },
  headerButton: { minWidth: 64, minHeight: 44, justifyContent: "center" },
  headerCentre: { alignItems: "center", gap: 2 },
  felt: {
    flexGrow: 1,
    paddingHorizontal: layout.screenPadding,
    gap: spacing.xl,
    maxWidth: layout.maxTableWidth,
    width: "100%",
    alignSelf: "center",
  },
  dealer: { alignItems: "center", gap: spacing.sm, paddingTop: spacing.lg, minHeight: 130 },
  divider: { height: 1, backgroundColor: colors.border },
  player: { alignItems: "center", gap: spacing.md, flexGrow: 1, justifyContent: "center" },
  drillHand: { flexDirection: "row", gap: spacing.sm },
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
  completeDock: { gap: spacing.md },
  drillActions: { gap: spacing.sm },
  feedback: {
    alignItems: "center",
    gap: 2,
    paddingVertical: spacing.sm,
    borderRadius: radius.small,
    borderWidth: 1,
  },
  feedbackGood: { borderColor: colors.success },
  feedbackBad: { borderColor: colors.warning },
  result: {
    flexGrow: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: spacing.lg,
    padding: layout.screenPadding,
    maxWidth: layout.maxTableWidth,
    width: "100%",
    alignSelf: "center",
  },
  objective: { gap: 2, paddingVertical: spacing.xs },
});
