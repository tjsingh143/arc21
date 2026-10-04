import { useAuthStore } from "../../src/features/auth/auth-store";
/**
 * Career map — a vertical route of challenge cards.
 *
 * Progression is suggested with typography and spacing rather than casino
 * signage: no neon, no slot-machine framing, no jackpot language.
 *
 * Locked nodes always say what unlocks them. And because one star is awarded
 * for completing a node at all, a run of bad cards can never permanently block
 * the route — the map is a path, not a gate.
 */

import { router, useFocusEffect } from "expo-router";
import { useCallback } from "react";
import { ScrollView, StyleSheet, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { AppText } from "../../src/components/ui/AppText";
import { BackBar } from "../../src/components/ui/BackBar";
import { SurfaceCard, UnavailableNote } from "../../src/components/ui/Card";
import { ScreenHeader } from "../../src/components/ui/ScreenHeader";
import { colors, layout, radius, spacing } from "../../src/design/tokens";
import {
  CAREER_CHAPTERS,
  CAREER_NODES,
  careerNodesInChapter,
  careerNodeWorkload,
  TOTAL_CAREER_STARS,
} from "../../shared/career/nodes.js";
import {
  isNodeUnlocked,
  starsForNode,
} from "../../shared/career/progress.js";
import { useCareerProgress } from "../../src/features/career/use-career-progress";
import { useCareerServerStore } from "../../src/features/career/career-server-store";

export default function CareerMapScreen() {
  const { progress, ready } = useCareerProgress();
  const serverProgress = useCareerServerStore((state) => state.progress);
  const refreshServer = useCareerServerStore((state) => state.refresh);

  const userId = useAuthStore((state) => state.session?.account.userId ?? null);
  useFocusEffect(useCallback(() => {
    if (userId) void refreshServer();
  }, [userId, refreshServer]));

  /*
   * A node is unlocked by EITHER record.
   *
   * Local progress alone would hide ranked progress made on another device;
   * server progress alone would lock a signed-out player out of a map the
   * specification says must be playable offline. The union is the only answer
   * that is right in both directions, and the star count shown is the better of
   * the two — a ranked three-star run and an offline three-star run both really
   * happened.
   */
  const starsFor = (slug: string): number =>
    Math.max(starsForNode(progress, slug), serverProgress[slug]?.stars ?? 0);
  const rankedCount = Object.values(serverProgress).filter((row) => row.completed).length;

  return (
    <SafeAreaView style={styles.screen} edges={["top"]}>
      <View style={styles.bar}>
        <BackBar />
      </View>
      <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
        <ScreenHeader
          title="Career"
          subtitle={
            ready
              ? `${CAREER_NODES.reduce((sum, node) => sum + starsFor(node.slug), 0)} of ${TOTAL_CAREER_STARS} stars`
              : "Loading your progress…"
          }
        />

        <UnavailableNote>
          {rankedCount > 0
            ? `${rankedCount} of ${CAREER_NODES.length} nodes completed on the server. Ranked attempts pay chips, XP and cosmetics; offline practice plays the same node and grants nothing.`
            : "Every node is playable offline and grants nothing. A ranked attempt runs on the server, on a shoe the server owns, and pays the node's chips, XP and cosmetics the first time you finish it."}
        </UnavailableNote>

        {CAREER_CHAPTERS.map((chapter) => {
          const nodes = careerNodesInChapter(chapter.id);
          const earned = nodes.reduce((sum, node) => sum + starsFor(node.slug), 0);
          const available = nodes.length * 3;

          return (
            <View key={chapter.id} style={styles.chapter}>
              <View style={styles.chapterHeader}>
                <AppText variant="sectionTitle">{chapter.title}</AppText>
                <AppText variant="caption" color="textSecondary" numeric>
                  {`${earned}/${available} ★`}
                </AppText>
              </View>
              <AppText variant="caption" color="textSecondary">
                {chapter.subtitle}
              </AppText>

              {nodes.map((node) => {
                const unlocked =
                  isNodeUnlocked(progress, node) ||
                  node.prerequisiteSlug === null ||
                  serverProgress[node.prerequisiteSlug]?.completed === true;
                const stars = starsFor(node.slug);
                const workload = careerNodeWorkload(node);

                return (
                  <SurfaceCard
                    key={node.slug}
                    onPress={unlocked ? () => router.push(`/career/${node.slug}`) : undefined}
                    disabled={!unlocked}
                    accessibilityLabel={`${node.title}, ${stars} of 3 stars${unlocked ? "" : ", locked"}`}
                    accessibilityHint={unlocked ? node.summary : "Complete the previous node to unlock"}
                    style={styles.node}
                  >
                    <View style={styles.nodeHeader}>
                      <AppText variant="bodyStrong" color={unlocked ? "textPrimary" : "textSecondary"}>
                        {node.title}
                      </AppText>
                      <StarRow earned={stars} />
                    </View>

                    <AppText variant="caption" color="textSecondary">
                      {node.summary}
                    </AppText>

                    <View style={styles.nodeMeta}>
                      {/* A drill builds targeted scenarios rather than dealing a
                          fair shoe, and it must always say so. */}
                      {node.format === "drill" ? (
                        <View style={styles.badge}>
                          <AppText variant="caption" color="info">
                            Drill
                          </AppText>
                        </View>
                      ) : null}
                      <AppText variant="caption" color="textDisabled" numeric>
                        {`${workload.count} ${workload.unit}`}
                      </AppText>
                      {!unlocked ? (
                        <AppText variant="caption" color="warning">
                          Locked
                        </AppText>
                      ) : null}
                    </View>
                  </SurfaceCard>
                );
              })}
            </View>
          );
        })}
      </ScrollView>
    </SafeAreaView>
  );
}

/** Stars as filled/empty glyphs plus an accessible count — never colour alone. */
export function StarRow({ earned, total = 3 }: { earned: number; total?: number }) {
  return (
    <View
      style={styles.stars}
      accessible
      accessibilityLabel={`${earned} of ${total} stars`}
    >
      {Array.from({ length: total }, (_, index) => (
        <AppText
          key={index}
          variant="caption"
          color={index < earned ? "accent" : "textDisabled"}
        >
          {index < earned ? "★" : "☆"}
        </AppText>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background },
  bar: { paddingHorizontal: layout.screenPadding },
  content: {
    padding: layout.screenPadding,
    paddingBottom: spacing.xxxl,
    gap: spacing.xl,
    maxWidth: layout.maxTableWidth,
    width: "100%",
    alignSelf: "center",
  },
  chapter: { gap: spacing.sm },
  chapterHeader: {
    flexDirection: "row",
    alignItems: "baseline",
    justifyContent: "space-between",
  },
  node: { marginTop: spacing.xs },
  nodeHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: spacing.sm,
  },
  nodeMeta: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    marginTop: spacing.xs,
  },
  stars: { flexDirection: "row", gap: 2 },
  badge: {
    paddingHorizontal: spacing.sm,
    paddingVertical: 1,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: colors.info,
  },
});
