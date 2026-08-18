/**
 * Leaderboards.
 *
 * Four boards, the specification's four, and global bankroll is deliberately not
 * among them: making the biggest pile the flagship would reward grinding rather
 * than playing well.
 *
 * Each row shows an avatar, a display name and a value. No account identifier
 * appears here because none is sent — the server's projection has no user id and
 * no email in it.
 */

import { useCallback, useEffect, useMemo } from "react";
import { ScrollView, StyleSheet, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { AppText } from "../../src/components/ui/AppText";
import { BackBar } from "../../src/components/ui/BackBar";
import { SurfaceCard, UnavailableNote } from "../../src/components/ui/Card";
import { CosmeticAvatar } from "../../src/features/cosmetics/art";
import { colors, layout, radius, spacing } from "../../src/design/tokens";
import {
  CATEGORY_COPY,
  LEADERBOARD_CATEGORIES,
  describePosition,
  formatValue,
  useLeaderboardStore,
  type LeaderboardCategory,
} from "../../src/features/leaderboards";

export default function Leaderboards() {
  const status = useLeaderboardStore((state) => state.status);
  const category = useLeaderboardStore((state) => state.category);
  const strategyProgress = useLeaderboardStore((state) => state.strategyProgress);
  const select = useLeaderboardStore((state) => state.select);

  useEffect(() => {
    void select("weekly_xp");
  }, [select]);

  /*
   * Derived with `useMemo` from subscribed state rather than by calling a store
   * getter during render — that freezes the value under the React Compiler.
   */
  const entries = useMemo(
    () => (status.kind === "ready" ? status.entries : []),
    [status],
  );
  const positionLine = useMemo(
    () => (status.kind === "ready" ? describePosition(category, status.position) : null),
    [status, category],
  );
  const copy = CATEGORY_COPY[category];

  const onSelect = useCallback(
    (next: LeaderboardCategory) => void select(next),
    [select],
  );

  return (
    <SafeAreaView style={styles.screen} edges={["top"]}>
      <View style={styles.bar}>
        <BackBar />
      </View>

      <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
        <View style={styles.header}>
          <AppText variant="pageTitle" accessibilityRole="header">
            Leaderboards
          </AppText>
          <AppText variant="body" color="textSecondary">
            Every figure here is recorded by the server.
          </AppText>
        </View>

        {/* Tabs. Rendered as a row of pills rather than a scroll view, because
            four fit and a hidden fifth would be worse than a tight fit. */}
        <View style={styles.tabs}>
          {LEADERBOARD_CATEGORIES.map((option) => (
            <SurfaceCard
              key={option}
              onPress={() => onSelect(option)}
              testID={`leaderboard-tab-${option}`}
              accessibilityLabel={CATEGORY_COPY[option].title}
              selected={option === category}
              style={[styles.tab, option === category ? styles.tabActive : null]}
            >
              <AppText
                variant="caption"
                color={option === category ? "textPrimary" : "textSecondary"}
                align="center"
              >
                {CATEGORY_COPY[option].title}
              </AppText>
            </SurfaceCard>
          ))}
        </View>

        <AppText variant="caption" color="textSecondary" testID="leaderboard-purpose">
          {copy.purpose}
        </AppText>

        {status.kind === "loading" ? (
          <AppText variant="body" color="textSecondary">
            Reading the board…
          </AppText>
        ) : status.kind === "unavailable" ? (
          <UnavailableNote>{status.message}</UnavailableNote>
        ) : (
          <>
            {/* Where the player stands, which the top 100 cannot tell them if
                they are not in it. */}
            {positionLine ? (
              <SurfaceCard>
                <AppText variant="bodyStrong" testID="leaderboard-my-position">
                  {positionLine}
                </AppText>
              </SurfaceCard>
            ) : null}

            {/* On the accuracy board someone below the bar is absent by design.
                How many decisions remain is more use than an empty list. */}
            {category === "strategy_accuracy" && strategyProgress && !strategyProgress.qualified ? (
              <SurfaceCard>
                <AppText variant="bodyStrong">Not qualified yet</AppText>
                <AppText variant="body" color="textSecondary" numeric>
                  {`${strategyProgress.decisionsTotal} of ${strategyProgress.minimumRequired} decisions this week.`}
                </AppText>
                <AppText variant="caption" color="textDisabled">
                  Decisions count at Quick Play, public tables and the Daily
                  Challenge. Practice, private tables and tournaments do not.
                </AppText>
              </SurfaceCard>
            ) : null}

            {entries.length === 0 ? (
              /* Says WHY it is empty, and never renders a sample row. */
              <SurfaceCard>
                <AppText variant="body" color="textSecondary" testID="leaderboard-empty">
                  {copy.emptyReason}
                </AppText>
              </SurfaceCard>
            ) : (
              <View style={styles.rows}>
                {entries.map((entry) => (
                  <SurfaceCard
                    key={`${entry.rank}-${entry.display_name}`}
                    style={entry.is_you ? styles.you : null}
                  >
                    <View style={styles.row}>
                      <AppText variant="bodyStrong" color="textSecondary" numeric style={styles.rank}>
                        {entry.rank}
                      </AppText>
                      {/* The row's EQUIPPED avatar, from the server's projection.
                          A null key renders the default mark rather than a gap. */}
                      <CosmeticAvatar assetKey={entry.avatar_asset_key} size={32} />
                      <View style={styles.who}>
                        <AppText variant="bodyStrong">
                          {entry.is_you ? `${entry.display_name} (you)` : entry.display_name}
                        </AppText>
                        {entry.detail ? (
                          <AppText variant="caption" color="textDisabled" numeric>
                            {entry.detail}
                          </AppText>
                        ) : null}
                      </View>
                      <AppText variant="bodyStrong" numeric>
                        {formatValue(category, entry.value)}
                      </AppText>
                    </View>
                  </SurfaceCard>
                ))}
              </View>
            )}
          </>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background },
  bar: { paddingHorizontal: layout.screenPadding },
  content: {
    padding: layout.screenPadding,
    paddingBottom: spacing.xxxl,
    gap: spacing.lg,
    maxWidth: layout.maxTableWidth,
    width: "100%",
    alignSelf: "center",
  },
  header: { gap: spacing.xs },
  tabs: { flexDirection: "row", gap: spacing.xs },
  tab: { flex: 1, paddingHorizontal: spacing.xs, paddingVertical: spacing.sm },
  tabActive: { borderColor: colors.accent },
  rows: { gap: spacing.sm },
  row: { flexDirection: "row", alignItems: "center", gap: spacing.md },
  rank: { minWidth: 28 },
  who: { flex: 1, gap: 2 },
  you: { borderColor: colors.accent, borderRadius: radius.card },
});
