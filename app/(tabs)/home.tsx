/**
 * Home — a home base, not a promotional lobby.
 *
 * What is deliberately absent matters as much as what is here: no rotating
 * offers, no purchase packages, no countdown sales, no wheel, no second
 * currency, no automatic modal rewards. Play is one tap away.
 *
 * Everything server-dependent states that plainly instead of rendering zeros
 * that would read as real results.
 */

import { useEffect } from "react";
import { router } from "expo-router";
import { ScrollView, StyleSheet, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { SurfaceCard, Tile, UnavailableNote } from "../../src/components/ui/Card";
import { ScreenHeader } from "../../src/components/ui/ScreenHeader";
import { AppText } from "../../src/components/ui/AppText";
import { Button } from "../../src/components/ui/Button";
import { colors, layout, spacing } from "../../src/design/tokens";
import { formatChips } from "../../src/design/typography";
import { CAREER_NODES } from "../../shared/career/nodes.js";
import { usePracticeStore } from "../../src/features/practice/practice-store";

export default function HomeScreen() {
  const stats = usePracticeStore((state) => state.stats);
  const game = usePracticeStore((state) => state.game);
  const hydrate = usePracticeStore((state) => state.hydrate);
  const hydrated = usePracticeStore((state) => state.hydrated);

  // Home must hydrate too, not just the table. Without this, a player who was
  // killed mid-hand comes back to a card offering a *new* session, because the
  // saved one has not been read yet — the hand is intact on disk but invisible.
  // `hydrate` is idempotent, so the table calling it as well is harmless.
  useEffect(() => {
    if (!hydrated) void hydrate();
  }, [hydrated, hydrate]);

  const bankroll = game?.seats[0]?.stack ?? null;
  const firstNode = CAREER_NODES[0]!;

  const accuracy =
    stats.decisions > 0 ? Math.round((stats.correct / stats.decisions) * 100) : null;

  return (
    <SafeAreaView style={styles.screen} edges={["top"]}>
      <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
        {/* The header reads the session and the wallet itself — see ScreenHeader.
            This comment used to say Arc 21 had "no auth backend, so no server
            wallet to show", which stopped being true several phases ago. */}
        <ScreenHeader title="Arc 21" subtitle="Blackjack, without the noise." />

        <SurfaceCard
          onPress={() => router.push("/game/practice")}
          testID="home-practice"
          accessibilityLabel="Play Practice"
          accessibilityHint="Offline blackjack with disposable chips"
        >
          <AppText variant="overline" color="accent">
            Practice
          </AppText>
          <AppText variant="sectionTitle">
            {bankroll === null ? "Play offline, at your own pace" : "Resume your session"}
          </AppText>
          <AppText variant="body" color="textSecondary">
            {bankroll === null
              ? "Six decks, dealer stands on soft 17, blackjack pays 3:2."
              : `Bankroll ${formatChips(bankroll)} · hand ${game?.handNumber ?? 1}`}
          </AppText>
          <Button
            label={bankroll === null ? "Play Practice" : "Continue"}
            onPress={() => router.push("/game/practice")}
            style={styles.cta}
          />
        </SurfaceCard>

        <SurfaceCard
          onPress={() => router.push("/career")}
          accessibilityLabel="Career"
          accessibilityHint="Structured challenges that build correct decisions"
        >
          <AppText variant="overline" color="textSecondary">
            Career
          </AppText>
          <AppText variant="sectionTitle">{firstNode.title}</AppText>
          <AppText variant="body" color="textSecondary">
            {firstNode.summary}
          </AppText>
        </SurfaceCard>

        {accuracy !== null ? (
          <SurfaceCard>
            <AppText variant="overline" color="textSecondary">
              Your mastery
            </AppText>
            <AppText variant="display" numeric>
              {`${accuracy}%`}
            </AppText>
            <AppText variant="caption" color="textSecondary" numeric>
              {`strategy accuracy over ${stats.decisions} decision${stats.decisions === 1 ? "" : "s"}`}
            </AppText>
          </SurfaceCard>
        ) : null}

        <View style={styles.tileRow}>
          <Tile
            label="Practice"
            detail="Offline, unlimited"
            onPress={() => router.push("/game/practice")}
          />
          <Tile label="Learn" detail="Guide and drills" onPress={() => router.push("/(tabs)/learn")} />
        </View>

        <View style={styles.section}>
          <AppText variant="sectionTitle">Online</AppText>
          <UnavailableNote>
            Daily Challenge, tournaments, friends and leaderboards need an Arc 21
            account, because each of them is recorded on the server rather than
            taken on trust. Practice, the strategy guide and drills never do.
          </UnavailableNote>
        </View>

        <AppText variant="caption" color="textDisabled" align="center" style={styles.disclaimer}>
          Simulated card game. Virtual chips have no monetary value and cannot be
          redeemed for money or prizes.
        </AppText>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: colors.background,
  },
  content: {
    padding: layout.screenPadding,
    paddingBottom: spacing.xxxl,
    gap: spacing.lg,
    maxWidth: layout.maxTableWidth,
    width: "100%",
    alignSelf: "center",
  },
  cta: {
    marginTop: spacing.md,
  },
  tileRow: {
    flexDirection: "row",
    gap: spacing.md,
  },
  section: {
    gap: spacing.sm,
  },
  disclaimer: {
    marginTop: spacing.lg,
  },
});
