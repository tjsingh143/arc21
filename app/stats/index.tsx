/**
 * Statistics.
 *
 * THE HEADLINE IS ACCURACY, NOT WIN RATE — and specifically the *unaided*
 * accuracy, measured on decisions made with nothing on screen telling the
 * player what to do.
 *
 * Win percentage is the number every other blackjack app puts at the top, and
 * it is the least informative number available. Short-run results are dominated
 * by variance: a player can play every hand perfectly and lose for a very long
 * time. Ranking a player by it teaches them to blame their decisions for the
 * shoe's behaviour, and to credit their decisions for the shoe's generosity.
 *
 * Every percentage on this screen is rendered beside the sample it came from,
 * because "100%" from two decisions is not mastery, and no percentage is drawn
 * from a zero denominator — an unattempted category shows an em dash, never 0%.
 *
 * Competition is server-owned, so it says so rather than showing zeros.
 */

import { useEffect, useState } from "react";
import { router } from "expo-router";
import { ScrollView, StyleSheet, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { AppText } from "../../src/components/ui/AppText";
import { BackBar } from "../../src/components/ui/BackBar";
import { Button } from "../../src/components/ui/Button";
import { SurfaceCard, UnavailableNote } from "../../src/components/ui/Card";
import { ScreenHeader } from "../../src/components/ui/ScreenHeader";
import { colors, layout, MIN_TOUCH_TARGET, radius, spacing } from "../../src/design/tokens";
import { formatChipDelta, formatChips } from "../../src/design/typography";
import { AccuracyRing, RateBar, Sparkline, StatRow } from "../../src/features/stats/charts";
import {
  buildPracticeStatistics,
  HAND_RESULTS_UNAVAILABLE,
  type MistakePattern,
} from "../../src/features/stats/aggregate";
import {
  competitionState,
  describeCompetitionUnavailable,
} from "../../src/features/stats/competition";
import { hasLocalData, STATS_MODES, statsMode, type StatsMode } from "../../src/features/stats/modes";
import {
  describeSample,
  formatDecimal,
  formatPercent,
  sampleCaveat,
} from "../../src/features/stats/rate";
import { sessionChips } from "../../src/features/stats/session";
import { hasRoute } from "../../src/features/home/route-availability";
import { useRouteIndex } from "../../src/features/home/use-route-index";
import { actionLabel } from "../../src/features/practice/advice";
import {
  PRACTICE_SEAT_ID,
  PRACTICE_STARTING_BANKROLL,
  usePracticeStore,
} from "../../src/features/practice/practice-store";

export default function StatsScreen() {
  const stats = usePracticeStore((state) => state.stats);
  const decisionLog = usePracticeStore((state) => state.decisionLog);
  const game = usePracticeStore((state) => state.game);
  const hydrate = usePracticeStore((state) => state.hydrate);
  const hydrated = usePracticeStore((state) => state.hydrated);

  // Statistics are restored from the same save as the session, so this screen
  // has to hydrate too. Without it, a fresh launch straight into Statistics
  // would report an empty record that is sitting intact on disk.
  useEffect(() => {
    if (!hydrated) void hydrate();
  }, [hydrated, hydrate]);

  const [mode, setMode] = useState<StatsMode>("all");
  const selected = statsMode(mode);

  // The Strategy Guide is owned by another part of the product and lands on its
  // own schedule. The route contract forbids dead links, so the button appears
  // only once the router can actually reach it.
  const routes = useRouteIndex();
  const strategyGuideExists = hasRoute(routes, "/learn/strategy-guide");

  const chips = sessionChips(game, PRACTICE_SEAT_ID);
  const statistics = buildPracticeStatistics({
    stats,
    decisionLog,
    bankroll: chips.stack,
    startingBankroll: PRACTICE_STARTING_BANKROLL,
    committedChips: chips.atRisk,
  });

  const { mastery, play, behaviour, streaks, trend } = statistics;
  const competition = competitionState({ hasAccount: false, online: false });

  return (
    <SafeAreaView style={styles.screen} edges={["top"]}>
      <View style={{ paddingHorizontal: layout.screenPadding }}>
        <BackBar />
      </View>
      <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
        <ScreenHeader
          title="Statistics"
          subtitle="Everything recorded on this device."
          balance={null}
        />

        <ModeFilter selected={mode} onSelect={setMode} />

        {!hasLocalData(mode) ? (
          <SurfaceCard>
            <AppText variant="sectionTitle">{selected.label}</AppText>
            <UnavailableNote>{selected.description}</UnavailableNote>
          </SurfaceCard>
        ) : !statistics.hasData ? (
          <SurfaceCard>
            <AppText variant="sectionTitle">Nothing recorded yet</AppText>
            <AppText variant="body" color="textSecondary">
              Play a few hands and this fills with your own results. Nothing here
              is pre-filled, so an empty screen means exactly what it says.
            </AppText>
            <Button
              label="Play Practice"
              onPress={() => router.push("/game/practice")}
              style={styles.cta}
            />
          </SurfaceCard>
        ) : (
          <>
            {/* ---------------------------------------------------------- */}
            <View style={styles.section}>
              <AppText variant="sectionTitle">Mastery</AppText>

              <SurfaceCard>
                <View style={styles.ringRow}>
                  <AccuracyRing
                    value={mastery.unaided}
                    caption="unaided"
                    label="Strategy accuracy, unaided"
                    size={112}
                  />
                  <View style={styles.ringSide}>
                    <AppText variant="overline" color="textSecondary">
                      Strategy accuracy
                    </AppText>
                    <AppText variant="caption" color="textSecondary">
                      {mastery.unaided.denominator === 0
                        ? "Measured on decisions made with no recommendation on screen. You have not made one yet."
                        : `From ${describeSample(mastery.unaided.denominator, "decision")} made with no recommendation on screen.`}
                    </AppText>
                    {sampleCaveat(mastery.unaided.denominator) ? (
                      <AppText variant="caption" color="warning">
                        {sampleCaveat(mastery.unaided.denominator)}
                      </AppText>
                    ) : null}
                  </View>
                </View>

                <View style={styles.divider} />

                {/*
                  Both figures are shown, clearly separated. A "correct" choice
                  made while Learn or Analysis was displaying the answer measures
                  reading, not recall — so it is reported, but never headlined.
                */}
                <StatRow
                  label="With the answer on screen"
                  value={formatPercent(mastery.aided)}
                  detail={
                    mastery.aided.denominator === 0
                      ? "No hinted decisions yet"
                      : `${describeSample(mastery.aided.denominator, "decision")} in Learn or Analysis`
                  }
                  tone="textSecondary"
                />
                <StatRow
                  label="Every graded decision"
                  value={formatPercent(mastery.overall)}
                  detail={describeSample(mastery.overall.denominator, "decision")}
                  tone="textSecondary"
                />
              </SurfaceCard>

              <SurfaceCard>
                <AppText variant="overline" color="textSecondary">
                  By hand type
                </AppText>
                <View style={styles.bars}>
                  <RateBar label="Hard totals" value={mastery.hard} />
                  <RateBar label="Soft totals" value={mastery.soft} />
                  <RateBar label="Pairs" value={mastery.pairs} />
                </View>
                {mastery.unclassifiedDecisions > 0 ? (
                  <AppText variant="caption" color="textDisabled" numeric>
                    {`${describeSample(mastery.unclassifiedDecisions, "decision")} could not be attributed to a hand type.`}
                  </AppText>
                ) : null}
              </SurfaceCard>

              {trend.length > 1 ? (
                <SurfaceCard>
                  <AppText variant="overline" color="textSecondary">
                    Accuracy over your last decisions
                  </AppText>
                  <Sparkline
                    values={trend.map((point) => point.accuracy.value)}
                    label={`Accuracy across ${trend.length} groups of recent decisions, oldest first`}
                  />
                  <AppText variant="caption" color="textDisabled" numeric>
                    {`Oldest to newest, ${describeSample(behaviour.window, "decision")} in ${trend.length} groups. Bars are groups of roughly ${Math.max(1, Math.round(behaviour.window / trend.length))}.`}
                  </AppText>
                </SurfaceCard>
              ) : null}
            </View>

            {/* ---------------------------------------------------------- */}
            <View style={styles.section}>
              <AppText variant="sectionTitle">Play</AppText>

              <SurfaceCard>
                <StatRow label="Hands played" value={formatChips(play.handsPlayed)} />
                <StatRow label="Decisions graded" value={formatChips(play.decisions)} />
                <StatRow
                  label="Decisions per hand"
                  value={play.decisionsPerHand === null ? "—" : formatDecimal(play.decisionsPerHand)}
                  detail="Splits and doubles push this above one"
                />

                <View style={styles.divider} />

                <StatRow
                  label="Chips at the table"
                  value={play.bankroll === null ? "—" : formatChips(play.bankroll)}
                  detail={
                    chips.atRisk > 0 ? `Includes ${formatChips(chips.atRisk)} on the felt` : undefined
                  }
                />
                <StatRow
                  label="Net chips"
                  value={play.netChips === null ? "—" : formatChipDelta(play.netChips)}
                  detail={`Against the ${formatChips(play.startingBankroll)} this session started with`}
                  tone={
                    play.netChips === null || play.netChips === 0
                      ? "textPrimary"
                      : play.netChips > 0
                        ? "success"
                        : "danger"
                  }
                />

                {/*
                  Wins, losses, pushes and blackjacks are deliberately absent.
                  This device records hands, decisions and chips — not the result
                  of each hand — so those counters cannot be derived from
                  anything here. Zeros would read as "you have won nothing".
                */}
                <UnavailableNote>{HAND_RESULTS_UNAVAILABLE}</UnavailableNote>
              </SurfaceCard>
            </View>

            {/* ---------------------------------------------------------- */}
            <View style={styles.section}>
              <AppText variant="sectionTitle">Decision behaviour</AppText>

              <SurfaceCard>
                <AppText variant="caption" color="textSecondary" numeric>
                  {`Over your last ${describeSample(behaviour.window, "decision")}.`}
                </AppText>

                <View style={styles.divider} />

                <ActionLine label="Doubles" tally={behaviour.byAction.DOUBLE} />
                <ActionLine label="Splits" tally={behaviour.byAction.SPLIT} />
                <ActionLine label="Surrenders" tally={behaviour.byAction.SURRENDER} />
              </SurfaceCard>

              <SurfaceCard>
                <AppText variant="overline" color="textSecondary">
                  Estimated cost of mistakes
                </AppText>
                <AppText variant="display" numeric>
                  {formatDecimal(behaviour.estimatedEvLost)}
                </AppText>
                <AppText variant="caption" color="textSecondary" numeric>
                  {behaviour.evLostPerHundredDecisions === null
                    ? "bets of expected value given up"
                    : `bets of expected value given up — about ${formatDecimal(behaviour.evLostPerHundredDecisions)} per 100 decisions`}
                </AppText>
                <AppText variant="caption" color="textDisabled">
                  Expected value, not chips lost. It is what those choices cost on
                  average over the long run, which is not what any single hand did.
                </AppText>
              </SurfaceCard>

              {behaviour.costliest.length > 0 ? (
                <SurfaceCard>
                  <AppText variant="overline" color="textSecondary">
                    Repeated mistakes
                  </AppText>
                  <View style={styles.mistakes}>
                    {behaviour.costliest.map((pattern) => (
                      <MistakeLine key={pattern.key} pattern={pattern} />
                    ))}
                  </View>
                  {strategyGuideExists ? (
                    <Button
                      label="Open the Strategy Guide"
                      variant="secondary"
                      size="medium"
                      onPress={() => router.push("/learn/strategy-guide")}
                      style={styles.cta}
                    />
                  ) : null}
                </SurfaceCard>
              ) : null}
            </View>

            {/* ---------------------------------------------------------- */}
            <View style={styles.section}>
              <AppText variant="sectionTitle">Streaks</AppText>

              <SurfaceCard>
                {/*
                  Decision streaks, not win streaks. A run of winning hands says
                  nothing about the player, and celebrating one would teach the
                  wrong lesson about a game with this much variance.
                */}
                <StatRow
                  label="Correct in a row now"
                  value={formatChips(streaks.currentCorrect)}
                  tone={streaks.currentCorrect > 0 ? "success" : "textPrimary"}
                />
                <StatRow label="Best run of correct" value={formatChips(streaks.bestCorrect)} />
                <StatRow
                  label="Mistakes in a row now"
                  value={formatChips(streaks.currentIncorrect)}
                  tone={streaks.currentIncorrect > 0 ? "warning" : "textPrimary"}
                />
                <StatRow label="Longest run of mistakes" value={formatChips(streaks.worstIncorrect)} />
                <AppText variant="caption" color="textDisabled" numeric>
                  {`Measured over the last ${describeSample(streaks.window, "decision")}, which is all this device keeps.`}
                </AppText>
              </SurfaceCard>
            </View>
          </>
        )}

        {/* ------------------------------------------------------------ */}
        <View style={styles.section}>
          <AppText variant="sectionTitle">Competition</AppText>
          {competition.status === "unavailable" ? (
            <SurfaceCard>
              <AppText variant="bodyStrong">
                {describeCompetitionUnavailable(competition.reason).title}
              </AppText>
              <UnavailableNote>
                {describeCompetitionUnavailable(competition.reason).body}
              </UnavailableNote>
            </SurfaceCard>
          ) : null}
        </View>

        <Button
          label="Back"
          variant="quiet"
          onPress={() => router.back()}
          style={styles.back}
        />

        <AppText variant="caption" color="textDisabled" align="center">
          Simulated card game. Virtual chips have no monetary value and cannot be
          redeemed for money or prizes.
        </AppText>
      </ScrollView>
    </SafeAreaView>
  );
}

/**
 * Filter chips.
 *
 * All four ship even though only Practice has data on this device, because
 * hiding the distinction is exactly what makes people assume offline practice
 * counts towards ranked progression. Selecting a server-backed mode says so.
 */
function ModeFilter({
  selected,
  onSelect,
}: {
  selected: StatsMode;
  onSelect: (mode: StatsMode) => void;
}) {
  return (
    <View style={styles.filter} accessibilityRole="tablist">
      {STATS_MODES.map((mode) => {
        const active = mode.id === selected;
        return (
          <Button
            key={mode.id}
            label={mode.label}
            size="medium"
            variant={active ? "primary" : "secondary"}
            onPress={() => onSelect(mode.id)}
            accessibilityHint={mode.description}
            style={styles.filterButton}
          />
        );
      })}
    </View>
  );
}

/** Times an action was taken, was the right play, and was left on the table. */
function ActionLine({
  label,
  tally,
}: {
  label: string;
  tally: { taken: number; recommended: number; missed: number; unprompted: number };
}) {
  const detail =
    tally.recommended === 0 && tally.taken === 0
      ? "Never came up"
      : `${tally.recommended} were the right play · ${tally.missed} missed · ${tally.unprompted} taken when they were not`;

  return <StatRow label={label} value={`${tally.taken} taken`} detail={detail} />;
}

function MistakeLine({ pattern }: { pattern: MistakePattern }) {
  const cost =
    pattern.evLost === null
      ? "cost not priced"
      : `${formatDecimal(pattern.evLost)} bets given up`;

  return (
    <View
      style={styles.mistake}
      accessible
      accessibilityLabel={`${pattern.handLabel} against ${pattern.upcardLabel}: you chose ${actionLabel(
        pattern.chosen,
      )}, the correct play is ${actionLabel(pattern.recommended)}. ${pattern.count} times, ${cost}.`}
    >
      <View style={styles.mistakeText}>
        <AppText variant="bodyStrong">
          {`${pattern.handLabel} vs ${pattern.upcardLabel}`}
        </AppText>
        <AppText variant="caption" color="textSecondary">
          {`You chose ${actionLabel(pattern.chosen)} · correct is ${actionLabel(pattern.recommended)}`}
        </AppText>
      </View>
      <View style={styles.mistakeFigures}>
        <AppText variant="bodyStrong" numeric>
          {`×${pattern.count}`}
        </AppText>
        <AppText variant="caption" color="textDisabled" numeric>
          {cost}
        </AppText>
      </View>
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
  section: { gap: spacing.md },
  filter: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: spacing.sm,
  },
  filterButton: {
    flexGrow: 1,
    flexBasis: 72,
    paddingHorizontal: spacing.sm,
    minHeight: MIN_TOUCH_TARGET,
  },
  ringRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.lg,
  },
  ringSide: {
    flex: 1,
    gap: spacing.xs,
  },
  divider: {
    height: 1,
    backgroundColor: colors.border,
    marginVertical: spacing.sm,
  },
  bars: {
    gap: spacing.md,
    marginTop: spacing.sm,
  },
  mistakes: {
    gap: spacing.md,
    marginTop: spacing.sm,
  },
  mistake: {
    flexDirection: "row",
    alignItems: "flex-start",
    justifyContent: "space-between",
    gap: spacing.md,
    borderRadius: radius.small,
    backgroundColor: colors.surfaceRaised,
    padding: spacing.md,
  },
  mistakeText: { flexShrink: 1, gap: 2 },
  mistakeFigures: { alignItems: "flex-end" },
  cta: { marginTop: spacing.md },
  back: { marginTop: spacing.sm },
});
