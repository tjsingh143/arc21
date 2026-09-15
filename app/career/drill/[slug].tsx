/**
 * A RANKED drill — the scenarios come from the server and the server marks them.
 *
 * The offline drill in `app/career/play/[slug].tsx` builds its own scenarios
 * and grades them locally, which is right for practice and worth nothing. This
 * one is the reward-bearing half: the questions were constructed from a secret
 * held in the `private` schema and are regenerated to grade the answers, so a
 * modified client can answer whatever it likes and still cannot answer an
 * EASIER question than it was asked, nor decide what its answer was worth.
 *
 * Feedback lands at the END rather than after each answer. Not a shortcut — the
 * whole sheet is submitted once, and telling a player their first answer was
 * wrong before they have given the twelfth would mean either sending the
 * recommendation with the question (which is the answer) or a round trip per
 * decision that buys nothing: a client that knows basic strategy already knows
 * the mark it is about to be given.
 */

import { useEffect, useMemo, useState } from "react";
import { router, useLocalSearchParams } from "expo-router";
import { Pressable, ScrollView, StyleSheet, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { AppText } from "../../../src/components/ui/AppText";
import { Button } from "../../../src/components/ui/Button";
import { SurfaceCard } from "../../../src/components/ui/Card";
import { PlayingCard } from "../../../src/components/cards/PlayingCard";
import { TableSurface } from "../../../src/features/cosmetics/art";
import { actionLabel } from "../../../src/features/practice/advice";
import { useTableTextVariant } from "../../../src/design/accessibility";
import { MAX_FIXED_CONTROL_FONT_SCALE } from "../../../src/design/type-metrics";
import { colors, layout, radius, spacing } from "../../../src/design/tokens";
import { formatChips } from "../../../src/design/typography";
import { announce } from "../../../src/lib/accessibility/announce";
import { rankName } from "../../../shared/blackjack/cards.js";
import type { PlayerActionType } from "../../../shared/blackjack/index.js";
import { careerNodeBySlug } from "../../../shared/career/nodes.js";
import { describeDealerUpCardForAnnouncement } from "../../../src/features/table";
import { useCareerServerStore } from "../../../src/features/career/career-server-store";
import { StarRow } from "../index";

export default function RankedDrillScreen() {
  const { slug } = useLocalSearchParams<{ slug: string }>();
  const node = typeof slug === "string" ? careerNodeBySlug(slug) : null;

  const drill = useCareerServerStore((state) => state.drill);
  const graded = useCareerServerStore((state) => state.graded);
  const busy = useCareerServerStore((state) => state.busy);
  const notice = useCareerServerStore((state) => state.notice);
  const submitDrill = useCareerServerStore((state) => state.submitDrill);
  const clearDrill = useCareerServerStore((state) => state.clearDrill);

  const [answers, setAnswers] = useState<PlayerActionType[]>([]);
  const overlineVariant = useTableTextVariant("overline");

  const scenario = drill?.scenarios[answers.length] ?? null;
  const total = drill?.scenarios.length ?? 0;

  // "Dealer shows six." Keyed on the card's own id, so moving to the next
  // question re-announces and re-rendering the same one does not.
  const dealerCardId = scenario?.dealerUpCard.id ?? null;
  const dealerAnnouncement = scenario
    ? describeDealerUpCardForAnnouncement(rankName(scenario.dealerUpCard.rank))
    : null;
  useEffect(() => {
    if (dealerAnnouncement) announce(dealerAnnouncement);
  }, [dealerCardId, dealerAnnouncement]);

  // The sheet is complete: send it. Guarded on `graded` and `busy` so a
  // re-render cannot submit twice.
  useEffect(() => {
    if (!drill || graded || busy) return;
    if (answers.length > 0 && answers.length === total) void submitDrill(answers);
  }, [answers, total, drill, graded, busy, submitDrill]);

  const rewardLine = useMemo(() => {
    if (!graded) return null;
    if (graded.rewardChips > 0 || graded.rewardXp > 0) {
      return `${formatChips(graded.rewardChips)} chips and ${graded.rewardXp} XP credited.`;
    }
    return "Rewards for this node were already paid. Your stars still count.";
  }, [graded]);

  function leave(): void {
    clearDrill();
    router.replace(node ? `/career/${node.slug}` : "/career");
  }

  if (!node || !drill) {
    return (
      <SafeAreaView style={styles.screen} edges={["top"]}>
        <View style={styles.centred}>
          <AppText variant="sectionTitle">No drill in progress</AppText>
          <AppText variant="body" color="textSecondary">
            Start a ranked attempt from the node to be issued its scenarios.
          </AppText>
          <Button label="Back to Career" onPress={() => router.replace("/career")} />
        </View>
      </SafeAreaView>
    );
  }

  if (graded) {
    return (
      <SafeAreaView style={styles.screen} edges={["top", "bottom"]}>
        <ScrollView contentContainerStyle={styles.resultContent}>
          <AppText variant="pageTitle">{node.title}</AppText>
          <StarRow earned={graded.stars} />
          <SurfaceCard>
            <AppText variant="sectionTitle">
              {`${graded.correct} of ${graded.decisions} correct`}
            </AppText>
            {rewardLine ? (
              <AppText variant="body" color="textSecondary" testID="drill-reward">
                {rewardLine}
              </AppText>
            ) : null}
          </SurfaceCard>

          <SurfaceCard>
            <AppText variant="overline" color="textSecondary">
              Every decision
            </AppText>
            {graded.verdicts.map((verdict, index) => (
              <View key={index} style={styles.verdictRow}>
                <AppText variant="caption" color="textSecondary">
                  {`${index + 1}.`}
                </AppText>
                <AppText variant="body" color={verdict.correct ? "success" : "warning"}>
                  {verdict.correct
                    ? `✓ ${actionLabel(verdict.chosen as never)}`
                    : `${actionLabel(verdict.chosen as never)} — better: ${actionLabel(
                        verdict.recommended as never,
                      )}`}
                </AppText>
              </View>
            ))}
          </SurfaceCard>

          <Button label="Back to the node" onPress={leave} testID="drill-done" />
        </ScrollView>
      </SafeAreaView>
    );
  }

  if (!scenario) {
    return (
      <SafeAreaView style={styles.screen} edges={["top"]}>
        <View style={styles.centred}>
          <AppText color="textSecondary">
            {busy ? "Marking your answers…" : "Preparing drill…"}
          </AppText>
          {notice ? (
            <AppText variant="caption" color="textSecondary" testID="drill-notice">
              {notice}
            </AppText>
          ) : null}
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.screen} edges={["top", "bottom"]}>
      <TableSurface />
      <View style={styles.header}>
        <Pressable
          onPress={leave}
          accessibilityRole="button"
          accessibilityLabel="Leave this drill"
          style={styles.headerButton}
        >
          {/* Fixed-geometry header chrome, capped for the same reason the table's is. */}
          <AppText color="textSecondary" maxFontSizeMultiplier={MAX_FIXED_CONTROL_FONT_SCALE}>
            Close
          </AppText>
        </Pressable>
        <View style={styles.headerTitle}>
          <AppText variant="bodyStrong" numberOfLines={1}>
            {node.title}
          </AppText>
          <AppText variant="caption" color="textSecondary">
            {`Decision ${answers.length + 1} of ${total} · Ranked`}
          </AppText>
        </View>
        <View style={styles.headerButton} />
      </View>

      <ScrollView contentContainerStyle={styles.felt} showsVerticalScrollIndicator={false}>
        <View style={styles.dealer}>
          <AppText variant={overlineVariant} color="textSecondary">
            Dealer shows
          </AppText>
          <PlayingCard card={scenario.dealerUpCard} size="medium" />
        </View>

        <View style={styles.divider} />

        <View style={styles.player}>
          <AppText variant={overlineVariant} color="textSecondary">
            Your hand
          </AppText>
          <View style={styles.hand}>
            {scenario.playerCards.map((card) => (
              <PlayingCard key={card.id} card={card} size="hero" />
            ))}
          </View>
          <AppText variant="sectionTitle">{scenario.label}</AppText>
        </View>
      </ScrollView>

      <View style={styles.dock}>
        <View style={styles.actions}>
          {scenario.legalActions.map((action) => (
            <Button
              key={action}
              label={actionLabel(action as never)}
              onPress={() => setAnswers((current) => [...current, action])}
              variant={action === "HIT" ? "primary" : "secondary"}
              size="medium"
              testID={`ranked-drill-${action.toLowerCase()}`}
            />
          ))}
        </View>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background },
  centred: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: spacing.md,
    padding: layout.screenPadding,
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: layout.screenPadding,
    paddingVertical: spacing.sm,
    gap: spacing.sm,
  },
  headerButton: { minWidth: 64, minHeight: 44, justifyContent: "center" },
  headerTitle: { flex: 1, alignItems: "center" },
  felt: {
    flexGrow: 1,
    justifyContent: "center",
    gap: spacing.lg,
    padding: layout.screenPadding,
  },
  dealer: { alignItems: "center", gap: spacing.sm },
  divider: { height: 1, backgroundColor: colors.border },
  player: { alignItems: "center", gap: spacing.sm },
  hand: { flexDirection: "row", gap: spacing.sm },
  dock: {
    padding: layout.screenPadding,
    gap: spacing.sm,
    backgroundColor: colors.surface,
    borderTopLeftRadius: radius.sheet,
    borderTopRightRadius: radius.sheet,
  },
  actions: { gap: spacing.sm },
  resultContent: {
    padding: layout.screenPadding,
    paddingBottom: spacing.xxxl,
    gap: spacing.lg,
  },
  verdictRow: { flexDirection: "row", gap: spacing.sm, alignItems: "center" },
});
