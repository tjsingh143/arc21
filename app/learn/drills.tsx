/**
 * Decision Drills — pick a category.
 *
 * Two honest numbers per row and no others: how many distinct questions the
 * category can ask, and how accurate you have been on those questions. Accuracy
 * is `null` until something has actually been answered, and the row says "not
 * drilled yet" rather than showing 0% — a fabricated zero reads as a real result
 * and would be the exact dishonesty this product refuses.
 *
 * "My mistakes" is genuinely empty for a player who has not made one. It says
 * so and cannot be started, rather than quietly falling back to Mixed under a
 * label that would then be false.
 */

import { useMemo } from "react";
import { ScrollView, StyleSheet, View } from "react-native";
import { router } from "expo-router";
import { SafeAreaView } from "react-native-safe-area-context";

import { AppText } from "../../src/components/ui/AppText";
import { BackBar } from "../../src/components/ui/BackBar";
import { Button } from "../../src/components/ui/Button";
import { SurfaceCard } from "../../src/components/ui/Card";
import { colors, layout, radius, spacing } from "../../src/design/tokens";
import { ARC_STANDARD_STRATEGY_TABLE } from "../../shared/strategy/index.js";
import {
  buildDrillQuestions,
  DRILL_CATEGORIES,
} from "../../src/features/learn/drill-questions";
import { summariseCategory, type DrillCategorySummary } from "../../src/features/learn/drill-session";
import { summariseDrillHistory } from "../../src/features/learn/spaced-repetition";
import { useDrillHistory } from "../../src/features/learn/use-drill-history";

/**
 * The bank is derived from the validated strategy table and is identical on
 * every launch, so it is built once at module scope rather than per render.
 */
const QUESTIONS = buildDrillQuestions();

export default function DrillCategoriesScreen() {
  const { history, ready } = useDrillHistory();

  const summaries = useMemo<DrillCategorySummary[]>(
    () => DRILL_CATEGORIES.map((category) => summariseCategory(QUESTIONS, category.id, history)),
    [history],
  );
  const overall = useMemo(() => summariseDrillHistory(history), [history]);

  return (
    <SafeAreaView style={styles.screen} edges={["top"]}>
      <View style={{ paddingHorizontal: layout.screenPadding }}>
        <BackBar />
      </View>
      <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
        <View style={styles.header}>
          <AppText variant="pageTitle" accessibilityRole="header">
            Decision Drills
          </AppText>
          <AppText variant="body" color="textSecondary">
            One hand, one decision, graded straight away against the same tables
            the table itself uses.
          </AppText>
        </View>

        {ready && overall.answered > 0 ? (
          <SurfaceCard>
            <AppText variant="overline" color="textSecondary">
              Overall
            </AppText>
            <View style={styles.overallRow}>
              <AppText variant="display" numeric>
                {`${Math.round((overall.accuracy ?? 0) * 100)}%`}
              </AppText>
              <View style={styles.overallMeta}>
                <AppText variant="caption" color="textSecondary" numeric>
                  {`${overall.correct} of ${overall.answered} decisions`}
                </AppText>
                <AppText variant="caption" color="textSecondary" numeric>
                  {`${overall.keysSeen} of ${QUESTIONS.length} hands seen`}
                </AppText>
              </View>
            </View>
          </SurfaceCard>
        ) : null}

        {summaries.map((summary) => (
          <CategoryRow key={summary.id} summary={summary} ready={ready} />
        ))}

        <SurfaceCard>
          <AppText variant="overline" color="textSecondary">
            How questions are chosen
          </AppText>
          <AppText variant="body" color="textSecondary">
            A hand you have just missed comes back sooner, and that urgency fades
            over about three days rather than following you around forever. A hand
            you keep getting right drops down the rotation without ever leaving
            it.
          </AppText>
          <AppText variant="caption" color="textDisabled">
            {`Every question is a cell of the ${ARC_STANDARD_STRATEGY_TABLE.rulesetId} chart, realised as real cards. History is kept per decision, so 6,10 and a 16 you reached another way are the same thing to learn.`}
          </AppText>
        </SurfaceCard>

        <AppText variant="caption" color="textDisabled">
          Drills build the scenarios they need instead of dealing a fair shoe —
          that is what makes them a teaching tool, and it is why nothing here is
          presented as an organically shuffled hand. No chips are at stake.
        </AppText>

        <Button label="Back" onPress={() => router.back()} variant="quiet" />
      </ScrollView>
    </SafeAreaView>
  );
}

function CategoryRow({
  summary,
  ready,
}: {
  summary: DrillCategorySummary;
  ready: boolean;
}) {
  const percent = summary.accuracy === null ? null : Math.round(summary.accuracy * 100);
  const empty = !summary.startable;

  const accuracyText = !ready
    ? "Loading your history…"
    : percent === null
      ? "Not drilled yet"
      : `${percent}% over ${summary.answered} answer${summary.answered === 1 ? "" : "s"}`;

  const poolText = empty
    ? "Nothing to review"
    : `${summary.poolSize} hand${summary.poolSize === 1 ? "" : "s"}`;

  return (
    <SurfaceCard
      onPress={empty ? undefined : () => router.push(`/learn/drills/${summary.id}`)}
      disabled={empty}
      accessibilityLabel={summary.label}
      accessibilityHint={`${summary.blurb} ${poolText}. ${accuracyText}`}
    >
      <View style={styles.rowHead}>
        <AppText variant="sectionTitle" color={empty ? "textSecondary" : "textPrimary"}>
          {summary.label}
        </AppText>
        {/* The count is a number AND a word: never colour or position alone. */}
        <AppText variant="caption" color="textSecondary" numeric>
          {poolText}
        </AppText>
      </View>

      <AppText variant="body" color="textSecondary">
        {summary.blurb}
      </AppText>

      <View style={styles.rowMeta}>
        <AppText
          variant="caption"
          color={percent === null ? "textDisabled" : "textSecondary"}
          numeric
        >
          {accuracyText}
        </AppText>
        {summary.outstanding > 0 && summary.id !== "mistakes" ? (
          <View style={styles.badge}>
            <AppText variant="caption" color="warning" numeric>
              {`${summary.outstanding} outstanding`}
            </AppText>
          </View>
        ) : null}
      </View>

      {empty && summary.id === "mistakes" ? (
        <AppText variant="caption" color="textDisabled">
          Nothing is here until you get a hand wrong. Missed hands collect here
          automatically — this is not a list you have to build.
        </AppText>
      ) : null}
    </SurfaceCard>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background },
  content: {
    padding: layout.screenPadding,
    paddingBottom: spacing.xxxl,
    gap: spacing.md,
    maxWidth: layout.maxTableWidth,
    width: "100%",
    alignSelf: "center",
  },
  header: { gap: spacing.xs, paddingTop: spacing.sm, paddingBottom: spacing.xs },
  overallRow: {
    flexDirection: "row",
    alignItems: "flex-end",
    justifyContent: "space-between",
    gap: spacing.md,
  },
  overallMeta: { alignItems: "flex-end" },
  rowHead: {
    flexDirection: "row",
    alignItems: "baseline",
    justifyContent: "space-between",
    gap: spacing.sm,
  },
  rowMeta: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    marginTop: spacing.xs,
    flexWrap: "wrap",
  },
  badge: {
    paddingHorizontal: spacing.sm,
    paddingVertical: 1,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: colors.warning,
  },
});
