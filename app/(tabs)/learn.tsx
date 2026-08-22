/**
 * Learn — the hub for the product's differentiator.
 *
 * Everything reachable from here is backed by the generated, validated strategy
 * tables. Nothing here offers advice from a hand-typed chart.
 */

import { router } from "expo-router";
import { ScrollView, StyleSheet, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { SurfaceCard } from "../../src/components/ui/Card";
import { ScreenHeader } from "../../src/components/ui/ScreenHeader";
import { AppText } from "../../src/components/ui/AppText";
import { colors, layout, spacing } from "../../src/design/tokens";
import { usePracticeStore } from "../../src/features/practice/practice-store";

export default function LearnScreen() {
  const stats = usePracticeStore((state) => state.stats);

  const overall =
    stats.decisions > 0 ? Math.round((stats.correct / stats.decisions) * 100) : null;
  const unaided =
    stats.unaidedDecisions > 0
      ? Math.round((stats.unaidedCorrect / stats.unaidedDecisions) * 100)
      : null;

  return (
    <SafeAreaView style={styles.screen} edges={["top"]}>
      <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
        <ScreenHeader title="Learn" subtitle="Understand every decision." />

        {overall !== null ? (
          <SurfaceCard onPress={() => router.push("/stats")} accessibilityLabel="Your accuracy">
            <AppText variant="overline" color="textSecondary">
              Strategy accuracy
            </AppText>
            <View style={styles.accuracyRow}>
              <View>
                <AppText variant="display" numeric>
                  {`${unaided ?? overall}%`}
                </AppText>
                <AppText variant="caption" color="textSecondary" numeric>
                  {unaided !== null
                    ? `unaided · ${stats.unaidedDecisions} decisions`
                    : `${stats.decisions} decisions`}
                </AppText>
              </View>
              {unaided !== null && unaided !== overall ? (
                <View style={styles.secondary}>
                  <AppText variant="sectionTitle" color="textSecondary" numeric>
                    {`${overall}%`}
                  </AppText>
                  <AppText variant="caption" color="textDisabled">
                    including hinted
                  </AppText>
                </View>
              ) : null}
            </View>
            {/*
              Accuracy, not win rate. Short-run blackjack results are dominated
              by variance — a player can play perfectly and still lose — so win
              percentage would be a misleading measure of skill.
            */}
            <AppText variant="caption" color="textDisabled">
              Measured on decisions made without the answer on screen.
            </AppText>
          </SurfaceCard>
        ) : null}

        <SurfaceCard
          onPress={() => router.push("/learn/how-to-play")}
          accessibilityLabel="How to Play"
          accessibilityHint="The rules, from card values to payouts"
        >
          <AppText variant="sectionTitle">How to Play</AppText>
          <AppText variant="body" color="textSecondary">
            The rules end to end: card values, aces, blackjack, doubling,
            splitting, surrender, insurance and how the dealer plays.
          </AppText>
        </SurfaceCard>

        <SurfaceCard
          onPress={() => router.push("/learn/strategy-guide")}
          accessibilityLabel="Strategy Guide"
          accessibilityHint="The full basic strategy chart for these rules"
        >
          <AppText variant="sectionTitle">Strategy Guide</AppText>
          <AppText variant="body" color="textSecondary">
            The complete chart for Arc Standard — hard totals, soft totals and
            pairs — computed for these exact rules rather than copied.
          </AppText>
        </SurfaceCard>

        {/*
          Decision Drills belongs on this tab, not only at the foot of the How
          to Play article where it used to be the sole entry point. It is one of
          the two things the Learn tab exists for — the other being the chart —
          and a headline feature reachable only by scrolling to the end of a
          different screen is effectively unreachable.
        */}
        <SurfaceCard
          onPress={() => router.push("/learn/drills")}
          accessibilityLabel="Decision Drills"
          accessibilityHint="Graded practice on hard totals, soft totals and pairs"
          testID="learn-drills"
        >
          <AppText variant="sectionTitle">Decision Drills</AppText>
          <AppText variant="body" color="textSecondary">
            Single decisions, graded instantly — mixed, hard totals, soft totals,
            pairs, or the ones you have been getting wrong.
          </AppText>
        </SurfaceCard>

        <SurfaceCard
          onPress={() => router.push("/game/practice")}
          accessibilityLabel="Practice with guidance"
          accessibilityHint="Play with Learn, Analysis or Challenge assistance"
        >
          <AppText variant="sectionTitle">Practice with guidance</AppText>
          <AppText variant="body" color="textSecondary">
            Play real hands with the recommendation shown, the expected value of
            every action, or graded after each choice.
          </AppText>
        </SurfaceCard>

        <AppText variant="caption" color="textDisabled" align="center" style={styles.footer}>
          Correct play reduces the house edge. It does not remove it, and no
          strategy makes blackjack profitable over time.
        </AppText>
      </ScrollView>
    </SafeAreaView>
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
  accuracyRow: {
    flexDirection: "row",
    alignItems: "flex-end",
    justifyContent: "space-between",
  },
  secondary: { alignItems: "flex-end" },
  footer: { marginTop: spacing.lg },
});
