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

import { router } from "expo-router";
import { ScrollView, StyleSheet, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { AppText } from "../../src/components/ui/AppText";
import { SurfaceCard, UnavailableNote } from "../../src/components/ui/Card";
import { ScreenHeader } from "../../src/components/ui/ScreenHeader";
import { colors, layout, radius, spacing } from "../../src/design/tokens";
import {
  CAREER_CHAPTERS,
  careerNodesInChapter,
  careerNodeWorkload,
  TOTAL_CAREER_STARS,
} from "../../shared/career/nodes.js";
import {
  chapterStars,
  isNodeUnlocked,
  starsForNode,
  totalStars,
} from "../../shared/career/progress.js";
import { useCareerProgress } from "../../src/features/career/use-career-progress";

export default function CareerMapScreen() {
  const { progress, ready } = useCareerProgress();

  return (
    <SafeAreaView style={styles.screen} edges={["top"]}>
      <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
        <ScreenHeader
          title="Career"
          subtitle={
            ready
              ? `${totalStars(progress)} of ${TOTAL_CAREER_STARS} stars`
              : "Loading your progress…"
          }
        />

        <UnavailableNote>
          Career runs entirely on your device. Stars are yours to keep; chip and XP
          rewards need an account, so they are held until accounts exist rather
          than credited locally.
        </UnavailableNote>

        {CAREER_CHAPTERS.map((chapter) => {
          const nodes = careerNodesInChapter(chapter.id);
          // `chapterStars` returns a record, not a number — interpolating it
          // directly renders "[object Object]", which TypeScript happily allows
          // inside a template literal.
          const { earned, available } = chapterStars(progress, chapter.id);

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
                const unlocked = isNodeUnlocked(progress, node);
                const stars = starsForNode(progress, node.slug);
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
