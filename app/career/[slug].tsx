/**
 * Career node detail — what the challenge is, before committing to it.
 *
 * The player sees the rules, the workload, the assistance mode and every star
 * requirement up front. Nothing about a node is a surprise, and a drill is
 * always labelled as one.
 */

import { router, useLocalSearchParams } from "expo-router";
import { ScrollView, StyleSheet, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { AppText } from "../../src/components/ui/AppText";
import { Button } from "../../src/components/ui/Button";
import { SurfaceCard, UnavailableNote } from "../../src/components/ui/Card";
import { colors, layout, radius, spacing } from "../../src/design/tokens";
import { formatChips } from "../../src/design/typography";
import { careerNodeBySlug, careerNodeWorkload, CAREER_RULES } from "../../shared/career/nodes.js";
import {
  describeAccuracyStar,
  describeCompletionStar,
  describeMasteryStar,
} from "../../shared/career/stars.js";
import { progressForNode } from "../../shared/career/progress.js";
import { useCareerProgress } from "../../src/features/career/use-career-progress";
import { StarRow } from "./index";

const ASSISTANCE_COPY: Record<string, string> = {
  play: "No guidance during the hand.",
  learn: "The recommended play is shown before you choose.",
  analysis: "Expected value for every legal action is available.",
  challenge: "No hint before you act; each decision is graded straight after.",
};

export default function CareerNodeScreen() {
  const { slug } = useLocalSearchParams<{ slug: string }>();
  const node = typeof slug === "string" ? careerNodeBySlug(slug) : null;
  const { progress } = useCareerProgress();

  if (!node) {
    return (
      <SafeAreaView style={styles.screen} edges={["top"]}>
        <View style={styles.missing}>
          <AppText variant="sectionTitle">Node not found</AppText>
          <AppText variant="body" color="textSecondary">
            That career node does not exist in this build.
          </AppText>
          <Button label="Back to Career" onPress={() => router.replace("/career")} />
        </View>
      </SafeAreaView>
    );
  }

  const best = progressForNode(progress, node.slug);
  const workload = careerNodeWorkload(node);

  return (
    <SafeAreaView style={styles.screen} edges={["top"]}>
      <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
        <View style={styles.header}>
          <View style={styles.titleRow}>
            <AppText variant="pageTitle">{node.title}</AppText>
            <StarRow earned={best.bestStars} />
          </View>
          <AppText variant="body" color="textSecondary">
            {node.summary}
          </AppText>
          {node.format === "drill" ? (
            <View style={styles.badge}>
              <AppText variant="caption" color="info">
                Drill · constructed scenarios, not a dealt shoe
              </AppText>
            </View>
          ) : null}
        </View>

        <SurfaceCard>
          <AppText variant="overline" color="textSecondary">
            Format
          </AppText>
          <Row label={workload.unit === "hands" ? "Hands" : "Decisions"} value={String(workload.count)} />
          <Row label="Assistance" value={ASSISTANCE_COPY[node.assistance] ?? node.assistance} />
          <Row label="Starting chips" value={formatChips(node.startingBankroll)} />
          <Row
            label="Table"
            value={`${CAREER_RULES.deckCount} decks · dealer stands soft 17 · 3:2`}
          />
          {node.maxWagerPercentOfStart !== null ? (
            <Row
              label="Maximum wager"
              value={`${node.maxWagerPercentOfStart}% of your starting chips`}
            />
          ) : null}
        </SurfaceCard>

        <SurfaceCard>
          <AppText variant="overline" color="textSecondary">
            Stars
          </AppText>
          <Row label="★" value={describeCompletionStar(node)} />
          <Row label="★★" value={describeAccuracyStar(node)} />
          <Row label="★★★" value={describeMasteryStar(node)} />
          {/* Stated plainly so a losing streak never reads as a dead end. */}
          <AppText variant="caption" color="textDisabled">
            Finishing always earns the first star and unlocks the next node, however
            the cards fall.
          </AppText>
        </SurfaceCard>

        {best.attempts > 0 ? (
          <SurfaceCard>
            <AppText variant="overline" color="textSecondary">
              Your best
            </AppText>
            <Row label="Attempts" value={String(best.attempts)} />
            {best.bestAccuracyPercent !== null ? (
              <Row label="Best accuracy" value={`${best.bestAccuracyPercent}%`} />
            ) : null}
            {best.bestEndingBankroll !== null ? (
              <Row label="Best finish" value={formatChips(best.bestEndingBankroll)} />
            ) : null}
          </SurfaceCard>
        ) : null}

        <Button
          label={best.attempts > 0 ? "Play again" : "Start"}
          onPress={() => router.push(`/career/play/${node.slug}`)}
          testID="career-start"
        />

        <UnavailableNote>
          Stars are saved on this device. Chip and XP rewards are
          server-authoritative and are held until accounts exist — nothing is
          credited locally, because a client that could grant chips is a client an
          attacker could grant them from.
        </UnavailableNote>

        <Button label="Back to Career" onPress={() => router.back()} variant="quiet" />
      </ScrollView>
    </SafeAreaView>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.row}>
      <AppText variant="caption" color="textSecondary">
        {label}
      </AppText>
      <AppText variant="body" style={styles.rowValue}>
        {value}
      </AppText>
    </View>
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
  header: { gap: spacing.sm, paddingTop: spacing.sm },
  titleRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: spacing.sm,
  },
  badge: {
    alignSelf: "flex-start",
    paddingHorizontal: spacing.sm,
    paddingVertical: 2,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: colors.info,
  },
  row: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "flex-start",
    gap: spacing.lg,
    paddingVertical: 2,
  },
  rowValue: { flexShrink: 1, textAlign: "right" },
  missing: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: spacing.lg,
    padding: layout.screenPadding,
  },
});
