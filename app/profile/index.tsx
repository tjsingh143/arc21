/**
 * Profile.
 *
 * Level and XP are SERVER-OWNED, and this screen reads them rather than
 * computing them: `my_level_progress` derives a level from stored XP, so there
 * is no arithmetic here that could disagree with the leaderboards.
 *
 * There is deliberately no "Level 1, 0 / 500 XP" fallback. A zero is a value,
 * and a value nobody earned asserts the app is keeping score of something it is
 * not. A guest, and a signed-in player whose progression could not be read, are
 * told which of those they are.
 *
 * That mattered more than it looks. Until this phase's audit, `hasAccount` was
 * the literal `false` — written when there genuinely was no sign-in, and never
 * revisited once accounts, XP and the level curve shipped. Every signed-in
 * player saw the guest profile, and the level bar could not appear for anybody.
 *
 * What this device knows on its own is still shown either way: strategy accuracy
 * from practice decisions, hands played, and career stars earned locally.
 */

import { useEffect } from "react";
import { router } from "expo-router";
import { ScrollView, StyleSheet, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import Svg, { Circle, Path } from "react-native-svg";

import { AppText } from "../../src/components/ui/AppText";
import { BackBar } from "../../src/components/ui/BackBar";
import { Button } from "../../src/components/ui/Button";
import { SurfaceCard, UnavailableNote } from "../../src/components/ui/Card";
import { colors, layout, radius, spacing } from "../../src/design/tokens";
import { formatChips } from "../../src/design/typography";
import { AccuracyRing, StatRow } from "../../src/features/stats/charts";
import {
  describeProgressionUnavailable,
  summariseProfile,
  type ProfileIdentity,
} from "../../src/features/stats/profile";
import { describeSample, formatPercent, sampleCaveat } from "../../src/features/stats/rate";
import { useLevelStore } from "../../src/features/stats/level-store";
import { useLoadoutStore } from "../../src/features/cosmetics";
import { CosmeticAvatar } from "../../src/features/cosmetics/art";
import { useAuthStore } from "../../src/features/auth";
import { usePracticeStore } from "../../src/features/practice/practice-store";
import { useCareerProgress } from "../../src/features/career/use-career-progress";
import { TOTAL_CAREER_STARS } from "../../shared/career/nodes.js";
import { totalStars } from "../../shared/career/progress.js";
import { CHIPS_NOT_MONEY_FOOTER } from "../../src/features/settings/fair-play-facts";

export default function ProfileScreen() {
  const stats = usePracticeStore((state) => state.stats);
  const hydrate = usePracticeStore((state) => state.hydrate);
  const hydrated = usePracticeStore((state) => state.hydrated);

  // Same reason as Home and Statistics: the record is on disk, and a profile
  // that reports an empty one because it never read it is simply wrong.
  useEffect(() => {
    if (!hydrated) void hydrate();
  }, [hydrated, hydrate]);

  const { progress, ready } = useCareerProgress();

  const session = useAuthStore((state) => state.session);
  const authHydrated = useAuthStore((state) => state.hydrated);
  const hydrateAuth = useAuthStore((state) => state.hydrate);
  const levelRecord = useLevelStore((state) => state.record);
  const loadLevel = useLevelStore((state) => state.load);

  useEffect(() => {
    if (!authHydrated) void hydrateAuth();
  }, [authHydrated, hydrateAuth]);

  const avatarKey = useLoadoutStore((state) => state.loadout.avatarKey);
  const loadLoadout = useLoadoutStore((state) => state.load);

  // Re-read on every change of session: signing out must empty this screen, and
  // a level left over from a previous account is somebody else's figure. The
  // loadout follows the same rule — an equipped avatar belongs to an account.
  useEffect(() => {
    if (authHydrated) {
      void loadLevel();
      void loadLoadout();
    }
  }, [authHydrated, session?.account.userId, loadLevel, loadLoadout]);

  const profile = summariseProfile({
    stats,
    careerStars: { earned: totalStars(progress), available: TOTAL_CAREER_STARS },
    hasAccount: session !== null,
    displayName: session?.account.email ?? null,
    progression: levelRecord,
  });

  const { identity, headline, progression } = profile;

  return (
    <SafeAreaView style={styles.screen} edges={["top"]}>
      <View style={{ paddingHorizontal: layout.screenPadding }}>
        <BackBar />
      </View>
      <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
        <View style={styles.identity}>
          <Avatar identity={identity} avatarKey={avatarKey} />
          <View style={styles.identityText}>
            <AppText variant="pageTitle">{identity.displayName}</AppText>
            <AppText variant="caption" color="textSecondary">
              {identity.detail}
            </AppText>
          </View>
        </View>

        {/* Level and XP: absent, and the screen says why rather than showing a
            level the player has not earned. */}
        {progression.status === "unavailable" ? (
          <SurfaceCard>
            <AppText variant="bodyStrong">
              {describeProgressionUnavailable(progression.reason).title}
            </AppText>
            <UnavailableNote>
              {describeProgressionUnavailable(progression.reason).body}
            </UnavailableNote>
          </SurfaceCard>
        ) : null}

        <SurfaceCard
          onPress={() => router.push("/stats")}
          accessibilityLabel="Your statistics"
          accessibilityHint="Accuracy, play and decision behaviour in full"
        >
          <View style={styles.ringRow}>
            <AccuracyRing
              value={headline.accuracy}
              caption="unaided"
              label="Strategy accuracy, unaided"
              size={104}
            />
            <View style={styles.ringSide}>
              <AppText variant="overline" color="textSecondary">
                Strategy accuracy
              </AppText>
              <AppText variant="caption" color="textSecondary">
                {headline.accuracy.denominator === 0
                  ? "Measured on decisions made with no recommendation on screen. You have not made one yet."
                  : `From ${describeSample(headline.accuracy.denominator, "decision")} made with no recommendation on screen.`}
              </AppText>
              {sampleCaveat(headline.accuracy.denominator) ? (
                <AppText variant="caption" color="warning">
                  {sampleCaveat(headline.accuracy.denominator)}
                </AppText>
              ) : null}
            </View>
          </View>

          <View style={styles.divider} />

          <StatRow
            label="Including hinted decisions"
            value={formatPercent(headline.accuracyIncludingAided)}
            detail={describeSample(headline.accuracyIncludingAided.denominator, "decision")}
            tone="textSecondary"
          />
          <StatRow label="Practice hands played" value={formatChips(headline.handsPlayed)} />
          <StatRow
            label="Career stars"
            value={
              ready
                ? `${headline.careerStars.earned} / ${headline.careerStars.available} ★`
                : "—"
            }
            detail={ready ? "Earned on this device" : "Loading your progress…"}
          />
        </SurfaceCard>

        {/*
          Accuracy, not win rate. A profile headlined by win percentage would be
          reporting the shoe's behaviour as if it were the player's skill.
        */}
        <AppText variant="caption" color="textDisabled">
          Accuracy is the measure here, not win rate. Blackjack results over a few
          hundred hands are dominated by luck — you can play every hand correctly
          and still lose — so a win percentage would say more about the cards than
          about you.
        </AppText>

        <View style={styles.actions}>
          <Button label="Statistics" onPress={() => router.push("/stats")} />
          <Button
            label="Inventory"
            variant="secondary"
            testID="profile-inventory"
            accessibilityHint="Avatars, card backs and table themes you have earned"
            onPress={() => router.push("/profile/inventory")}
          />
          <Button
            label="Settings"
            variant="secondary"
            onPress={() => router.push("/settings")}
          />
        </View>

        <SurfaceCard>
          <AppText variant="bodyStrong">Your data</AppText>
          <AppText variant="body" color="textSecondary">
            Practice results, settings and career stars stay on this device and
            are never uploaded. Chips, statistics, friends and leaderboard
            standing come with an account and live on the server, because they
            are checked rather than taken on trust.
          </AppText>
        </SurfaceCard>

        <Button label="Back" variant="quiet" onPress={() => router.back()} />

        <AppText variant="caption" color="textDisabled" align="center">
          {CHIPS_NOT_MONEY_FOOTER}
        </AppText>
      </ScrollView>
    </SafeAreaView>
  );
}

/**
 * The avatar.
 *
 * A guest gets the same anonymous glyph the header uses, not a generated
 * identicon: a distinctive auto-generated mark reads as an identity the player
 * was given, when in fact there is no identity here at all.
 *
 * An account shows its EQUIPPED avatar — the loadout store's answer, which is
 * the default House Dealer mark until the player equips something else in
 * Inventory.
 */
function Avatar({
  identity,
  avatarKey,
}: {
  identity: ProfileIdentity;
  avatarKey: string;
}) {
  if (identity.kind !== "guest") {
    return (
      <CosmeticAvatar
        assetKey={avatarKey}
        size={72}
        accessibilityLabel={`Profile picture for ${identity.displayName}`}
      />
    );
  }
  return (
    <View style={styles.avatar} accessible accessibilityLabel="Guest profile picture">
      <Svg width={34} height={34} viewBox="0 0 24 24">
        <Circle cx="12" cy="9" r="3.4" stroke={colors.textSecondary} strokeWidth={1.6} fill="none" />
        <Path
          d="M5 20c0-3.6 3.1-6 7-6s7 2.4 7 6"
          stroke={colors.textSecondary}
          strokeWidth={1.6}
          fill="none"
          strokeLinecap="round"
        />
      </Svg>
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
  identity: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.lg,
    paddingTop: spacing.sm,
  },
  identityText: { flex: 1, gap: 2 },
  avatar: {
    width: 72,
    height: 72,
    borderRadius: radius.pill,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.surfaceRaised,
    borderWidth: 1,
    borderColor: colors.border,
  },
  ringRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.lg,
  },
  ringSide: { flex: 1, gap: spacing.xs },
  divider: {
    height: 1,
    backgroundColor: colors.border,
    marginVertical: spacing.sm,
  },
  actions: {
    flexDirection: "row",
    gap: spacing.md,
  },
});
