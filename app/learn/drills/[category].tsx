/**
 * A drill session.
 *
 * Nothing on this screen decides what the right play is. The question comes from
 * the validated bank in `drill-questions.ts` — every entry of which round-trips
 * through the engine's own classifier and is answered by `adviseAction` — and the
 * verdict comes from `gradeDrillAnswer`, which asks the same tables the Practice
 * table asks. The explanation is assembled from the solver's own expected values
 * rather than from prose written per cell, so it cannot drift from the cell it is
 * explaining.
 *
 * The buttons are the hand's real legal actions, not a fixed row: a drill that
 * offered a button the table would refuse is a drill that teaches the wrong
 * thing. `tests/learn/drill-questions.test.ts` deals every question's cards
 * through the real engine and asserts `getLegalActions` agrees.
 *
 * Which question comes next is the spaced-repetition weighting, rolled from the
 * same CSPRNG that shuffles the shoe. No chips are at stake and no bankroll
 * moves — these are constructed scenarios, and the screen says so.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { ScrollView, StyleSheet, View } from "react-native";
import { router, useLocalSearchParams } from "expo-router";
import { SafeAreaView } from "react-native-safe-area-context";
import Animated, { useAnimatedStyle, useSharedValue, withTiming } from "react-native-reanimated";

import { AppText } from "../../../src/components/ui/AppText";
import { Button } from "../../../src/components/ui/Button";
import { SurfaceCard } from "../../../src/components/ui/Card";
import { DealtCard } from "../../../src/components/cards/DealtCard";
import { colors, layout, MIN_TOUCH_TARGET, radius, spacing } from "../../../src/design/tokens";
import { easings, useMotion } from "../../../src/design/motion";
import type { StrategyAction } from "../../../shared/strategy/index.js";
import { actionLabel } from "../../../src/features/practice/advice";
import {
  buildDrillQuestions,
  drillCategory,
  gradeDrillAnswer,
  parseDrillCategory,
  type DrillQuestion,
  type DrillVerdict,
} from "../../../src/features/learn/drill-questions";
import {
  describeScore,
  drillPoolFor,
  EMPTY_SCORE,
  nextDrillQuestion,
  scoreAnswer,
  scorePercent,
  type DrillScore,
} from "../../../src/features/learn/drill-session";
import { nextRoll } from "../../../src/features/learn/random";
import { useDrillHistory } from "../../../src/features/learn/use-drill-history";

/** Identical on every launch, so it is built once rather than per render. */
const QUESTIONS = buildDrillQuestions();

export default function DrillSessionScreen() {
  const params = useLocalSearchParams<{ category?: string }>();
  const category = parseDrillCategory(
    typeof params.category === "string" ? params.category : undefined,
  );
  const definition = drillCategory(category);

  const { history, ready, record } = useDrillHistory();

  const pool = useMemo(() => drillPoolFor(QUESTIONS, category, history), [category, history]);

  const [question, setQuestion] = useState<DrillQuestion | null>(null);
  const [verdict, setVerdict] = useState<DrillVerdict | null>(null);
  const [score, setScore] = useState<DrillScore>(EMPTY_SCORE);

  /**
   * Draws the next question.
   *
   * `excludeKey` keeps the same hand from appearing twice running: the weighting
   * can genuinely choose it, but being handed an identical question immediately
   * reads as a bug even when it is not.
   */
  const draw = useCallback(
    (excludeKey: string | null) => {
      setVerdict(null);
      setQuestion(
        nextDrillQuestion({
          pool,
          history,
          now: Date.now(),
          roll: nextRoll(),
          excludeKey,
        }),
      );
    },
    [pool, history],
  );

  // The first question waits for stored history, so the very first hand is
  // already weighted by what the player has missed before rather than by an
  // empty record that happens to be on screen first.
  useEffect(() => {
    if (!ready || question !== null) return;
    /*
     * Drawing needs randomness, so it cannot happen during render, and it
     * cannot happen before stored history has loaded without defeating the
     * weighting this effect exists for. The guard above makes it run exactly
     * once per question rather than cascade.
     */
    // eslint-disable-next-line react-hooks/set-state-in-effect
    draw(null);
  }, [ready, question, draw]);

  const answer = useCallback(
    (action: StrategyAction) => {
      if (!question || verdict) return;
      const graded = gradeDrillAnswer(question, action);
      setVerdict(graded);
      setScore((current) => scoreAnswer(current, graded.correct));
      void record(question.key, graded.correct);
    },
    [question, verdict, record],
  );

  const percent = scorePercent(score);

  if (ready && pool.length === 0) {
    return <EmptyPool label={definition.label} category={category} />;
  }

  return (
    <SafeAreaView style={styles.screen} edges={["top"]}>
      <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
        <View style={styles.header}>
          <View style={styles.headerRow}>
            <AppText variant="pageTitle" accessibilityRole="header">
              {definition.label}
            </AppText>
            <View style={styles.badge}>
              <AppText variant="caption" color="info">
                Drill
              </AppText>
            </View>
          </View>
          <View
            style={styles.scoreRow}
            accessible
            accessibilityLabel={`Score: ${describeScore(score)}`}
          >
            <AppText variant="caption" color="textSecondary" numeric>
              {describeScore(score)}
            </AppText>
            {percent !== null ? (
              <AppText variant="caption" color="textSecondary" numeric>
                {`${percent}%`}
              </AppText>
            ) : null}
            {score.bestStreak > 1 ? (
              <AppText variant="caption" color="textDisabled" numeric>
                {`best run ${score.bestStreak}`}
              </AppText>
            ) : null}
          </View>
        </View>

        {question === null ? (
          <SurfaceCard>
            <AppText variant="body" color="textSecondary">
              {ready ? "Drawing a hand…" : "Loading your drill history…"}
            </AppText>
          </SurfaceCard>
        ) : (
          <>
            <SurfaceCard style={styles.table}>
              <View style={styles.side}>
                <AppText variant="overline" color="textSecondary">
                  Dealer shows
                </AppText>
                <View style={styles.hand}>
                  <DealtCard
                    key={question.dealerUpcard.id}
                    card={question.dealerUpcard}
                    size="medium"
                  />
                </View>
              </View>

              <View style={styles.divider} />

              <View style={styles.side}>
                <AppText variant="overline" color="textSecondary">
                  You have
                </AppText>
                <View style={styles.hand}>
                  {question.playerCards.map((card, index) => (
                    <DealtCard key={card.id} card={card} size="hero" index={index} />
                  ))}
                </View>
                <AppText variant="sectionTitle" numeric>
                  {question.handLabel}
                </AppText>
              </View>
            </SurfaceCard>

            {verdict === null ? (
              <>
                <View style={styles.actions}>
                  {question.actions.map((action) => (
                    <Button
                      key={action}
                      label={actionLabel(action)}
                      size="medium"
                      variant="secondary"
                      onPress={() => answer(action)}
                      accessibilityHint={`Answer ${actionLabel(action)} for ${question.handLabel} against ${question.upcardLabel}`}
                      style={styles.actionButton}
                    />
                  ))}
                </View>
                <AppText variant="caption" color="textDisabled">
                  Only the actions the engine would actually allow on this hand are
                  offered.
                </AppText>
              </>
            ) : (
              <Feedback
                verdict={verdict}
                question={question}
                onNext={() => draw(question.key)}
              />
            )}
          </>
        )}

        <AppText variant="caption" color="textDisabled">
          Constructed scenarios, not a dealt shoe. No chips are at stake and
          nothing here affects a balance.
        </AppText>

        <Button label="Finish" onPress={() => router.back()} variant="quiet" />
      </ScrollView>
    </SafeAreaView>
  );
}

// ---------------------------------------------------------------------------
// Feedback
// ---------------------------------------------------------------------------

/**
 * The verdict, with the solver's reasoning.
 *
 * Correct and incorrect are distinguished by a word and a glyph before they are
 * distinguished by a colour — a player who cannot separate green from red still
 * reads "Correct" or "Not this one".
 */
function Feedback({
  verdict,
  question,
  onNext,
}: {
  verdict: DrillVerdict;
  question: DrillQuestion;
  onNext: () => void;
}) {
  const motion = useMotion();
  const appear = useSharedValue(0);

  useEffect(() => {
    appear.value = withTiming(1, {
      duration: motion.duration("buttonPress"),
      easing: easings.fade,
    });
  }, [appear, motion]);

  const style = useAnimatedStyle(() => ({ opacity: appear.value }));

  return (
    <Animated.View style={style}>
      <View
        style={[
          styles.feedback,
          { borderColor: verdict.correct ? colors.success : colors.warning },
        ]}
        accessible
        accessibilityRole="alert"
        accessibilityLabel={`${verdict.correct ? "Correct" : "Not this one"}. ${
          verdict.correct ? "" : `The play is ${actionLabel(verdict.expected)}. `
        }${verdict.explanation}`}
      >
        <View style={styles.feedbackHead}>
          <AppText variant="bodyStrong" color={verdict.correct ? "success" : "warning"}>
            {verdict.correct ? "✓  Correct" : "✕  Not this one"}
          </AppText>
          {!verdict.correct ? (
            <AppText variant="bodyStrong" color="textPrimary">
              {actionLabel(verdict.expected)}
            </AppText>
          ) : null}
        </View>

        <AppText variant="body" color="textSecondary">
          {verdict.explanation}
        </AppText>

        {/*
          Null is not zero. When the cell does not price the choice we say we do
          not know, rather than claiming the mistake was free.
        */}
        {!verdict.correct && verdict.evLost === null ? (
          <AppText variant="caption" color="textDisabled">
            The solver does not price that action for this hand, so the cost of
            the choice is not shown.
          </AppText>
        ) : null}

        <AppText variant="caption" color="textDisabled" numeric>
          {`${question.handLabel} vs ${question.upcardLabel}`}
        </AppText>
      </View>

      <Button
        label="Next hand"
        onPress={onNext}
        style={styles.next}
        accessibilityHint="Draw another question"
      />
    </Animated.View>
  );
}

// ---------------------------------------------------------------------------
// Empty pool
// ---------------------------------------------------------------------------

/**
 * "My mistakes" before any mistake exists.
 *
 * An explicit, truthful state rather than a silent redirect to Mixed — the
 * category would then be showing hands the player has never missed, under a
 * label saying they had.
 */
function EmptyPool({ label, category }: { label: string; category: string }) {
  return (
    <SafeAreaView style={styles.screen} edges={["top"]}>
      <View style={styles.empty}>
        <AppText variant="sectionTitle" accessibilityRole="header">
          {label}
        </AppText>
        <AppText variant="body" color="textSecondary" align="center">
          {category === "mistakes"
            ? "You have not missed a hand yet, so there is nothing to review. Missed hands collect here on their own."
            : "This category has no gradeable hands under the current ruleset."}
        </AppText>
        <Button label="Back to drills" onPress={() => router.replace("/learn/drills")} />
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background },
  content: {
    padding: layout.screenPadding,
    paddingBottom: spacing.xxxl,
    gap: spacing.lg,
    maxWidth: layout.maxTableWidth,
    width: "100%",
    alignSelf: "center",
  },
  header: { gap: spacing.xs, paddingTop: spacing.sm },
  headerRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
  },
  badge: {
    paddingHorizontal: spacing.sm,
    paddingVertical: 1,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: colors.info,
  },
  scoreRow: {
    flexDirection: "row",
    alignItems: "baseline",
    gap: spacing.md,
    flexWrap: "wrap",
  },

  table: { gap: spacing.md },
  side: { gap: spacing.sm, alignItems: "flex-start" },
  hand: {
    flexDirection: "row",
    gap: spacing.sm,
    paddingVertical: spacing.xs,
  },
  divider: {
    height: 1,
    backgroundColor: colors.border,
    marginVertical: spacing.xs,
  },

  actions: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: spacing.sm,
  },
  actionButton: {
    flexBasis: "30%",
    minHeight: MIN_TOUCH_TARGET,
  },

  feedback: {
    gap: spacing.sm,
    padding: spacing.lg,
    borderRadius: radius.card,
    borderWidth: 1,
    backgroundColor: colors.surface,
  },
  feedbackHead: {
    flexDirection: "row",
    alignItems: "baseline",
    justifyContent: "space-between",
    gap: spacing.md,
  },
  next: { marginTop: spacing.md },

  empty: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: spacing.lg,
    padding: layout.screenPadding,
  },
});
