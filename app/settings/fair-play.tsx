/**
 * Fair Play.
 *
 * EVERY SENTENCE ON THIS SCREEN MUST BE TRUE OF THE SHIPPED CODE.
 *
 * That constraint is why almost nothing here is written as literal prose. The
 * claims and the numbers come from `src/features/settings/fair-play-facts.ts`,
 * which derives them from `ARC_STANDARD_RULES` and the shoe module — so a rule
 * change edits this page automatically instead of silently making it false.
 *
 * Equally important is what is absent. There is NO claim of external
 * certification, independent audit, testing-house approval or published return
 * to player, because none of those exist. A fairness page that overstates its
 * own standing is worse than no fairness page: it is the exact claim a player
 * has no way to check, offered by the party with every reason to make it.
 */

import { router } from "expo-router";
import { ScrollView, StyleSheet, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { AppText } from "../../src/components/ui/AppText";
import { BackBar } from "../../src/components/ui/BackBar";
import { Button } from "../../src/components/ui/Button";
import { SurfaceCard, UnavailableNote } from "../../src/components/ui/Card";
import { ScreenHeader } from "../../src/components/ui/ScreenHeader";
import { colors, layout, spacing } from "../../src/design/tokens";
import {
  fairPlayClaims,
  NO_CERTIFICATION_STATEMENT,
  NO_GUARANTEE_STATEMENT,
  shuffleFacts,
} from "../../src/features/settings/fair-play-facts";
import { ARC_STANDARD_RULES } from "../../shared/blackjack/rules.js";

export default function FairPlayScreen() {
  const claims = fairPlayClaims(ARC_STANDARD_RULES);
  const shoe = shuffleFacts(ARC_STANDARD_RULES);

  return (
    <SafeAreaView style={styles.screen} edges={["top"]}>
      <View style={{ paddingHorizontal: layout.screenPadding }}>
        <BackBar />
      </View>
      <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
        <ScreenHeader
          title="Fair Play"
          subtitle="How the cards are dealt, and who decides."
          balance={null}
        />

        <AppText variant="body" color="textSecondary">
          You cannot see the shuffle, so this page describes it. Everything below
          is a description of how the code actually works, written so that
          somebody reading the code could check it line by line.
        </AppText>

        <View style={styles.facts}>
          <Fact label="Decks" value={`${shoe.deckCount}`} />
          <Fact
            label="Dealer"
            value={ARC_STANDARD_RULES.dealerHitsSoft17 ? "Hits soft 17" : "Stands on all 17s"}
          />
          <Fact
            label="Blackjack"
            value={`Pays ${ARC_STANDARD_RULES.blackjackPayoutNumerator}:${ARC_STANDARD_RULES.blackjackPayoutDenominator}`}
          />
          <Fact label="Shuffle" value={`At ~${shoe.penetrationPercent}%`} />
        </View>

        {claims.map((claim) => (
          <SurfaceCard key={claim.id}>
            <AppText variant="bodyStrong">{claim.title}</AppText>
            <AppText variant="body" color="textSecondary">
              {claim.body}
            </AppText>
          </SurfaceCard>
        ))}

        {/*
          The numbers behind the shuffle claim, so it can be checked rather than
          taken on trust.
        */}
        <SurfaceCard>
          <AppText variant="overline" color="textSecondary">
            The shoe, in numbers
          </AppText>
          <Row label="Cards in the shoe" value={`${shoe.totalCards}`} />
          <Row label="Cut card after" value={`${shoe.cutIndex} cards`} />
          <Row label="Still behind the cut card" value={`${shoe.cardsBehindCut} cards`} />
          <Row label="Safety reserve" value={`${shoe.safetyReserve} cards`} />
          <AppText variant="caption" color="textDisabled">
            The reserve sits behind the cut card, so it can never trigger a
            shuffle earlier than the penetration stated above. A hand is never
            interrupted by a shuffle.
          </AppText>
        </SurfaceCard>

        {/* The two paragraphs that make the rest worth reading. */}
        <View style={styles.section}>
          <AppText variant="sectionTitle">What this page is not</AppText>
          <UnavailableNote>{NO_CERTIFICATION_STATEMENT}</UnavailableNote>
          <UnavailableNote>{NO_GUARANTEE_STATEMENT}</UnavailableNote>
        </View>

        <Button label="Back" variant="quiet" onPress={() => router.back()} />

        <AppText variant="caption" color="textDisabled" align="center">
          Simulated card game. Virtual chips have no monetary value and cannot be
          redeemed for money or prizes.
        </AppText>
      </ScrollView>
    </SafeAreaView>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.fact} accessible accessibilityLabel={`${label}: ${value}`}>
      <AppText variant="overline" color="textSecondary">
        {label}
      </AppText>
      <AppText variant="bodyStrong" numeric>
        {value}
      </AppText>
    </View>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.row} accessible accessibilityLabel={`${label}: ${value}`}>
      <AppText variant="body" color="textSecondary">
        {label}
      </AppText>
      <AppText variant="bodyStrong" numeric>
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
    gap: spacing.md,
    maxWidth: layout.maxTableWidth,
    width: "100%",
    alignSelf: "center",
  },
  section: { gap: spacing.sm, marginTop: spacing.sm },
  facts: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: spacing.sm,
  },
  fact: {
    flexGrow: 1,
    flexBasis: 110,
    gap: 2,
    padding: spacing.md,
    borderRadius: 12,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: spacing.md,
    minHeight: 28,
  },
});
