/**
 * Play — the game-mode selector.
 *
 * Every mode states honestly whether it can be played in this build. A mode that
 * needs a server it does not have renders as clearly unavailable, never as a
 * button that silently does nothing.
 *
 * No mode is ever described as having an "easy" or "hard" dealer, because none
 * does: the dealer follows fixed rules and never varies with anything.
 */

import { router } from "expo-router";
import { ScrollView, StyleSheet, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { SurfaceCard } from "../../src/components/ui/Card";
import { ScreenHeader } from "../../src/components/ui/ScreenHeader";
import { AppText } from "../../src/components/ui/AppText";
import { colors, layout, radius, spacing } from "../../src/design/tokens";

interface Mode {
  title: string;
  purpose: string;
  structure: string;
  availability: "offline" | "online";
  route?: string;
  reason?: string;
}

const MODES: Mode[] = [
  {
    title: "Practice",
    purpose: "Play as long as you like with disposable chips.",
    structure: "Unlimited hands · resettable bankroll",
    availability: "offline",
    route: "/game/practice",
  },
  {
    title: "Career",
    purpose: "Eighteen challenges that build correct decisions.",
    structure: "3 chapters · 18 nodes · up to 3 stars each",
    availability: "offline",
    route: "/career",
  },
  {
    title: "Quick Play",
    purpose: "A standard table using your global chip balance.",
    structure: "Casual, Standard or High stakes",
    availability: "online",
    reason: "Needs an account so chips are server-authoritative.",
  },
  {
    title: "Public Table",
    purpose: "Two to five players sharing one dealer and one shoe.",
    structure: "2–5 seats · buy-in from your balance",
    availability: "online",
    route: "/table/public",
    // Reachable now. The screen itself states what an account is needed for and
    // what the buy-in costs, rather than this card refusing on its behalf.
    reason: "Needs an account so chips are server-authoritative.",
  },
  {
    title: "Sprint Tournament",
    purpose: "Four players, equal stacks, twelve hands.",
    structure: "12 hands · 500 entry · elimination after hand 6",
    availability: "online",
    route: "/tournament",
    // Reachable. The screen states the whole format and the entry fee before
    // anything is spent, which is where that belongs.
    reason: "Needs an account and a server-run tournament.",
  },
  {
    title: "Daily Challenge",
    purpose: "The same shoe for everyone, once a day.",
    structure: "20 hands · one ranked attempt",
    availability: "online",
    route: "/daily",
    reason: "Needs the server-held daily shoe.",
  },
];

export default function PlayScreen() {
  return (
    <SafeAreaView style={styles.screen} edges={["top"]}>
      <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
        <ScreenHeader title="Play" subtitle="Same rules everywhere." balance={null} />

        {MODES.map((mode) => {
          const playable = mode.route !== undefined;
          return (
            <SurfaceCard
              key={mode.title}
              onPress={playable ? () => router.push(mode.route as never) : undefined}
              disabled={!playable}
              accessibilityLabel={mode.title}
              accessibilityHint={playable ? mode.purpose : mode.reason}
            >
              <View style={styles.cardHeader}>
                <AppText variant="sectionTitle" color={playable ? "textPrimary" : "textSecondary"}>
                  {mode.title}
                </AppText>
                <View style={[styles.badge, playable ? styles.badgeOffline : styles.badgeOnline]}>
                  <AppText variant="caption" color={playable ? "success" : "textSecondary"}>
                    {mode.availability === "offline" ? "Offline" : "Online"}
                  </AppText>
                </View>
              </View>

              <AppText variant="body" color="textSecondary">
                {mode.purpose}
              </AppText>

              {/* Structure, not a time promise — how long a session takes is up
                  to the player, and claiming "about 5 minutes" would be a guess. */}
              <AppText variant="caption" color="textDisabled" numeric>
                {mode.structure}
              </AppText>

              {!playable && mode.reason ? (
                <AppText variant="caption" color="warning">
                  {mode.reason}
                </AppText>
              ) : null}
            </SurfaceCard>
          );
        })}

        <AppText variant="caption" color="textDisabled" align="center" style={styles.footer}>
          The dealer follows the same fixed rules in every mode. No mode deals
          differently, and nothing changes the cards based on how you are doing.
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
  cardHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: spacing.sm,
  },
  badge: {
    paddingHorizontal: spacing.sm,
    paddingVertical: 2,
    borderRadius: radius.pill,
    borderWidth: 1,
  },
  badgeOffline: { borderColor: colors.success },
  badgeOnline: { borderColor: colors.border },
  footer: { marginTop: spacing.lg },
});
