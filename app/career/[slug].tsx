/**
 * Career node detail — what the challenge is, before committing to it.
 *
 * The player sees the rules, the workload, the assistance mode and every star
 * requirement up front. Nothing about a node is a surprise, and a drill is
 * always labelled as one.
 *
 * TWO WAYS TO PLAY, SAID OUT LOUD. A ranked attempt runs on the server — the
 * server owns the shoe, grades every decision and pays the chips, XP and
 * cosmetics — and offline practice runs the identical node locally and grants
 * nothing. That is the specification's own line ("a Career node may be
 * practiced offline, but any reward-bearing attempt requires server
 * authority"), and the screen states which one each button is rather than
 * choosing quietly.
 */

import { useEffect } from "react";
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
import { useCareerServerStore } from "../../src/features/career/career-server-store";
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

        <RankedCta node={node} />

        <Button
          label="Practice offline"
          variant="quiet"
          onPress={() => router.push(`/career/play/${node.slug}`)}
          testID="career-start"
        />

        <UnavailableNote>
          Offline practice plays the identical node and grants nothing: no chips,
          no XP, no cosmetics. A client that could credit a wallet is a client an
          attacker could credit one from, so a reward-bearing attempt runs on the
          server, on a shoe the server owns.
        </UnavailableNote>

        <Button label="Back to Career" onPress={() => router.back()} variant="quiet" />
      </ScrollView>
    </SafeAreaView>
  );
}

/**
 * The ranked attempt.
 *
 * Disabled with a reason rather than hidden. A player who is signed out should
 * be told that rewards need an account, not left wondering why one node looks
 * different from another — and a player who has already been paid for this node
 * should know a replay is worth stars and not chips before they spend twenty
 * hands on it.
 */
function RankedCta({ node }: { node: NonNullable<ReturnType<typeof careerNodeBySlug>> }) {
  const busy = useCareerServerStore((state) => state.busy);
  const notice = useCareerServerStore((state) => state.notice);
  const serverProgress = useCareerServerStore((state) => state.progress);
  const loaded = useCareerServerStore((state) => state.loaded);
  const refresh = useCareerServerStore((state) => state.refresh);
  const start = useCareerServerStore((state) => state.start);

  useEffect(() => {
    if (!loaded) void refresh();
  }, [loaded, refresh]);

  const recorded = serverProgress[node.slug];
  const paid = recorded?.rewardClaimed === true;

  /*
   * The RANKED prerequisite is the server's record, not the local one.
   *
   * Offline practice unlocks the map locally, which is right — the
   * specification asks for a career that is playable offline. It does not
   * unlock a ranked attempt, because the server checks its own progress. Saying
   * so here beats letting the player press the button and read a refusal.
   */
  const prerequisite = node.prerequisiteSlug;
  const prerequisiteMet =
    prerequisite === null || serverProgress[prerequisite]?.completed === true;
  const prerequisiteNode = prerequisite === null ? null : careerNodeBySlug(prerequisite);

  async function begin(): Promise<void> {
    const attempt = await start(node.slug);
    if (!attempt) return;
    if (attempt.format === "drill") {
      router.push(`/career/drill/${node.slug}`);
      return;
    }
    if (attempt.gameId && attempt.seatId) {
      router.push({
        pathname: "/table/[gameId]",
        params: { gameId: attempt.gameId, seatId: attempt.seatId },
      });
    }
  }

  return (
    <View style={styles.rankedBlock}>
      <Button
        label={busy ? "Opening…" : recorded?.completed ? "Play ranked again" : "Play ranked"}
        onPress={() => void begin()}
        disabled={busy || !prerequisiteMet}
        testID="career-start-ranked"
      />
      <AppText variant="caption" color="textSecondary">
        {!prerequisiteMet && prerequisiteNode
          ? `Finish “${prerequisiteNode.title}” on the server first. Offline practice unlocks the map, not the rewards.`
          : paid
            ? "Rewards for this node have already been paid. A replay can still raise your stars, and pays no chips again."
            : `Earns ${formatChips(node.reward.chips)} chips and ${node.reward.xp} XP the first time you finish it.`}
      </AppText>
      {recorded ? (
        <AppText variant="caption" color="textSecondary" testID="career-server-record">
          {`Server record: ${recorded.stars} of 3 stars across ${recorded.attempts} ${
            recorded.attempts === 1 ? "attempt" : "attempts"
          }.`}
        </AppText>
      ) : null}
      {notice ? (
        <AppText variant="caption" color="textSecondary" testID="career-ranked-notice">
          {notice}
        </AppText>
      ) : null}
    </View>
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
  rankedBlock: { gap: spacing.sm },
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
