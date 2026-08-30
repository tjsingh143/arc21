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
import { HandSelector } from "../../../src/components/table/HandSelector";
import { OutcomeBadge } from "../../../src/components/table/OutcomeBadge";
import { InsuranceSheet } from "../../../src/components/table/InsuranceSheet";
import { StrategyPanel } from "../../../src/components/table/StrategyPanel";
import { PlayingCard } from "../../../src/components/cards/PlayingCard";
import { TableSurface } from "../../../src/features/cosmetics/art";
import { useTableTextVariant } from "../../../src/design/accessibility";
import { colors, layout, MIN_TOUCH_TARGET, radius, spacing } from "../../../src/design/tokens";
import { MAX_FIXED_CONTROL_FONT_SCALE } from "../../../src/design/type-metrics";
import { formatChips } from "../../../src/design/typography";
import { announce } from "../../../src/lib/accessibility/announce";
import { rankName } from "../../../shared/blackjack/cards.js";
import { isVisibleCard } from "../../../shared/blackjack/types.js";
import { getLegalActions } from "../../../shared/blackjack/legal-actions.js";
import { careerNodeBySlug, careerNodeWorkload } from "../../../shared/career/nodes.js";
import { describeDealerUpCardForAnnouncement } from "../../../src/features/table/outcome-announcement.js";
import {
  describeSplitHands,
  focusedSplitHandId,
  splitHandFromEngineHand,
} from "../../../src/features/table/split-hands";
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
  const overlineVariant = useTableTextVariant("overline");

  // "Dealer shows six." Keyed on the up-card's own id, not the card object or
  // `game` as a whole, so a re-render that leaves the same up-card in place
  // does not re-announce it.
  const dealerUpCard = game?.dealer.cards[0];
  const dealerUpCardId = dealerUpCard && isVisibleCard(dealerUpCard) ? dealerUpCard.id : null;
  const dealerUpCardAnnouncement =
    dealerUpCard && isVisibleCard(dealerUpCard)
      ? describeDealerUpCardForAnnouncement(rankName(dealerUpCard.rank))
      : null;
  useEffect(() => {
    if (dealerUpCardAnnouncement) announce(dealerUpCardAnnouncement);
  }, [dealerUpCardId, dealerUpCardAnnouncement]);

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

  /*
   * The split presentation. Career runs the LOCAL engine, so its hands are
   * `PlayerHand`s and are mapped into the shared shape rather than the module
   * growing a second code path for them.
   */
  const activeHandId =
    seat.hands[game.activeHandIndex ?? seat.currentHandIndex]?.id ?? null;
  const splitInputs = seat.hands.map((hand) =>
    splitHandFromEngineHand(hand, game.rules.splitAceTwentyOneIsBlackjack),
  );
  const splitHands = describeSplitHands({ hands: splitInputs, activeHandId });
  const focusedHandId = focusedSplitHandId({ hands: seat.hands, activeHandId });

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
      {/* The equipped table theme — the career table is a table like any other. */}
      <TableSurface />
      <SessionHeader
        title={node.title}
        progress={`Hand ${Math.min(session.totals.handsPlayed + 1, target)} of ${target}`}
      />

      <ScrollView contentContainerStyle={styles.felt} showsVerticalScrollIndicator={false}>
        <View style={styles.dealer}>
          <AppText variant={overlineVariant} color="textSecondary">
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
            <>
              {/*
                THE CHIP ROW A SPLIT NEEDS.

                This screen rendered the active hand and nothing else, so after
                a split the other hands — their totals, their wagers, whether
                they had busted — were simply not on screen. The player was
                acting on hand 2 of 3 with no way to know that was what they
                were doing. Practice has had this row since it shipped; the
                logic now lives in `split-hands.ts` so all three tables share
                one implementation rather than three.
              */}
              <HandSelector hands={splitHands} testID="career-hand-selector" />

              {seat.hands.map((hand) =>
                hand.id === focusedHandId ? (
                  <View key={hand.id} style={styles.hand}>
                    <HandCards
                      cards={[...hand.cards]}
                      size="hero"
                      detail={`Bet ${formatChips(hand.wager)}`}
                      focused={seat.hands.length > 1}
                    />
                    {/*
                      THE RESULT OF THE HAND, WHICH WAS NEVER SHOWN HERE.

                      Practice and the online table both render this badge; the
                      career table settled a hand and moved straight to "Next
                      hand", so the one screen in the product whose whole
                      purpose is teaching correct play never told the player
                      how the hand had turned out.
                    */}
                    {hand.outcome ? (
                      <OutcomeBadge kind={hand.outcome.kind} net={hand.outcome.net} />
                    ) : null}
                  </View>
                ) : null,
              )}
            </>
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
            // Wired, not a literal 0 with an empty callback — see the store.
            lastBet={session.lastBet}
            availableStack={seat.stack}
            onAddChip={session.addChip}
            onClear={session.clearBet}
            onRepeat={session.repeatBet}
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
  const overlineVariant = useTableTextVariant("overline");

  // "Dealer shows six." Keyed on the scenario's own card id so moving to the
  // next scenario re-announces it, while grading feedback on the SAME
  // scenario does not.
  const dealerUpCardId = scenario?.dealerUpcard.id ?? null;
  const dealerUpCardAnnouncement = scenario
    ? describeDealerUpCardForAnnouncement(rankName(scenario.dealerUpcard.rank))
    : null;
  useEffect(() => {
    if (dealerUpCardAnnouncement) announce(dealerUpCardAnnouncement);
  }, [dealerUpCardId, dealerUpCardAnnouncement]);

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
      {/* Drills deal scenarios onto the same themed surface as the hand table. */}
      <TableSurface />
      <SessionHeader
        title={node.title}
        progress={`Decision ${Math.min(session.totals.decisions + 1, target)} of ${target}`}
        badge="Drill"
      />

      <ScrollView contentContainerStyle={styles.felt} showsVerticalScrollIndicator={false}>
        <View style={styles.dealer}>
          <AppText variant={overlineVariant} color="textSecondary">
            Dealer shows
          </AppText>
          <PlayingCard card={scenario.dealerUpcard} size="medium" />
        </View>

        <View style={styles.divider} />

        <View style={styles.player}>
          <AppText variant={overlineVariant} color="textSecondary">
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
        {/* Fixed-geometry header chrome — see the Practice table's own note. */}
        <AppText color="textSecondary" maxFontSizeMultiplier={MAX_FIXED_CONTROL_FONT_SCALE}>
          Close
        </AppText>
      </Pressable>
      <View style={styles.headerCentre}>
        <AppText
          variant="overline"
          color="textSecondary"
          maxFontSizeMultiplier={MAX_FIXED_CONTROL_FONT_SCALE}
        >
          {title}
        </AppText>
        <AppText
          variant="caption"
          color="textDisabled"
          numeric
          maxFontSizeMultiplier={MAX_FIXED_CONTROL_FONT_SCALE}
        >
          {progress}
        </AppText>
      </View>
      <View style={styles.headerButton}>
        {badge ? (
          <AppText
            variant="caption"
            color="info"
            maxFontSizeMultiplier={MAX_FIXED_CONTROL_FONT_SCALE}
          >
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
  headerButton: { minWidth: 64, minHeight: MIN_TOUCH_TARGET, justifyContent: "center" },
  // `flex: 1` bounds the title block to the row. Without it the node title and
  // progress line grew past the screen edge at the largest Dynamic Type size
  // and overlapped the Close control — same fix as the Practice header.
  headerCentre: { flex: 1, alignItems: "center", gap: 2 },
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
  hand: { alignItems: "center", gap: spacing.sm },
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
