/**
 * Daily Challenge.
 *
 * The screen leads with the thing that makes the mode fair: everyone gets the
 * same shoe, and the proof of that was published before anyone played. The
 * commitment is shown in full rather than summarised, because a hash a player
 * cannot copy is a hash they cannot check.
 *
 * It also states, before the player commits, whether the attempt they are about
 * to start is ranked. A replay that silently scores nothing would be worse than
 * no replay at all.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { ScrollView, StyleSheet, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { router } from "expo-router";

import { AppText } from "../../src/components/ui/AppText";
import { BackBar } from "../../src/components/ui/BackBar";
import { Button } from "../../src/components/ui/Button";
import { SurfaceCard, UnavailableNote } from "../../src/components/ui/Card";
import { colors, layout, spacing } from "../../src/design/tokens";
import { formatChips } from "../../src/design/typography";
import {
  describeAttempt,
  describeVerdict,
  describeVerification,
  useDailyStore,
  type VerificationVerdict,
} from "../../src/features/daily";
// Direct, not through the barrel: this module imports `expo-crypto` and would
// otherwise put React Native in front of every pure helper the tests import.
import { verifyCommitment } from "../../src/features/daily/verify-commitment";

export default function DailyChallenge() {
  const status = useDailyStore((state) => state.status);
  const notice = useDailyStore((state) => state.notice);
  const starting = useDailyStore((state) => state.starting);
  const load = useDailyStore((state) => state.load);
  const start = useDailyStore((state) => state.start);

  useEffect(() => {
    void load();
  }, [load]);

  /*
   * Derived with `useMemo` from subscribed state rather than by calling a store
   * getter during render — that freezes the value under the React Compiler.
   */
  const attempt = useMemo(
    () => (status.kind === "ready" ? status.attempt : null),
    [status],
  );
  const plan = useMemo(() => describeAttempt(attempt), [attempt]);

  /*
   * The audit half of the commitment scheme.
   *
   * Today's seed is secret, so what can be checked is the most recently CLOSED
   * challenge — and the check is done HERE, on the device, by recomputing
   * SHA-256 of the published seed. A server that also said "yes, it matches"
   * would be asking to be believed twice.
   *
   * The verdict is COMPONENT state and starts as `checking`: the digest is
   * asynchronous, and a screen that rendered "verified" before it had finished
   * would be asserting something it had not done. Same rule as
   * `mayOpenDealtTable` — gate on the answer having come back, not on the
   * question having been asked.
   */
  const verification = useMemo(
    () => (status.kind === "ready" ? status.verification : null),
    [status],
  );
  const [checked, setChecked] = useState<{
    date: string;
    verdict: VerificationVerdict;
  } | null>(null);

  useEffect(() => {
    if (!verification) return;
    let cancelled = false;
    void verifyCommitment(verification).then((answer) => {
      if (!cancelled) setChecked({ date: verification.date, verdict: answer });
    });
    return () => {
      cancelled = true;
    };
  }, [verification]);

  /*
   * DERIVED, not set. Writing "checking" from inside the effect is a synchronous
   * setState in an effect body — the React Compiler rejects it — and it would
   * also leave a window in which yesterday's verdict was rendered beside today's
   * seed. Keying the stored answer by DATE removes both: anything that is not an
   * answer about THIS row reads as still checking.
   */
  const verdict: VerificationVerdict =
    checked && verification && checked.date === verification.date
      ? checked.verdict
      : "checking";

  const onStart = useCallback(() => {
    void (async () => {
      const opened = await start();
      if (!opened) return;
      router.replace({
        pathname: "/table/[gameId]",
        params: { gameId: opened.gameId, seatId: opened.seatId },
      });
    })();
  }, [start]);

  return (
    <SafeAreaView style={styles.screen} edges={["top"]}>
      <View style={styles.bar}>
        <BackBar />
      </View>

      <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
        <View style={styles.header}>
          <AppText variant="pageTitle" accessibilityRole="header">
            Daily Challenge
          </AppText>
          <AppText variant="body" color="textSecondary">
            Everyone plays the same shoe. One ranked attempt a day.
          </AppText>
        </View>

        {status.kind === "loading" ? (
          <AppText variant="body" color="textSecondary">
            {"Reading today's challenge…"}
          </AppText>
        ) : status.kind === "unavailable" ? (
          <UnavailableNote>{status.message}</UnavailableNote>
        ) : (
          <>
            <SurfaceCard>
              <AppText variant="bodyStrong">{"Today's format"}</AppText>
              <AppText variant="body" color="textSecondary" numeric>
                {`${status.challenge.handCount} hands · ${formatChips(status.challenge.startingChips)} challenge chips`}
              </AppText>
              <AppText variant="caption" color="textDisabled">
                Challenge chips are for scoring only. They never come out of your
                balance and never go back into it.
              </AppText>
              {status.challenge.rewardChips > 0 ? (
                <AppText variant="caption" color="textSecondary" numeric>
                  {`Finishing a ranked attempt pays ${formatChips(status.challenge.rewardChips)} chips and ${status.challenge.rewardXp} XP.`}
                </AppText>
              ) : null}
            </SurfaceCard>

            <SurfaceCard>
              <AppText variant="bodyStrong">Your score is the ending bankroll</AppText>
              <AppText variant="body" color="textSecondary">
                Nothing else counts, and speed counts for nothing — finishing
                quickly is not a measure of playing well.
              </AppText>
            </SurfaceCard>

            {/* The fairness claim, and the evidence for it. */}
            <SurfaceCard>
              <AppText variant="bodyStrong">How you can check the shoe</AppText>
              <AppText variant="body" color="textSecondary">
                {describeVerification(status.challenge)}
              </AppText>
              <AppText variant="caption" color="textDisabled" numeric testID="daily-commitment">
                {status.challenge.seedCommitment}
              </AppText>
              {status.challenge.revealedSeed ? (
                <AppText variant="caption" color="textSecondary" numeric>
                  {`Seed: ${status.challenge.revealedSeed}`}
                </AppText>
              ) : null}
            </SurfaceCard>

            {/* The check itself, on a challenge that has actually closed.
                Absent rather than empty before the first one does: an audit
                panel with nothing in it would suggest a check that failed. */}
            {verification ? (
              <SurfaceCard>
                <AppText variant="bodyStrong">{`Verified: ${verification.date}`}</AppText>
                <AppText
                  variant="body"
                  color={verdict === "does-not-match" ? "danger" : "textSecondary"}
                  testID="daily-verification-verdict"
                >
                  {describeVerdict(verdict)}
                </AppText>
                <AppText variant="caption" color="textDisabled" numeric>
                  {`Commitment: ${verification.seedCommitment}`}
                </AppText>
                <AppText variant="caption" color="textDisabled" numeric>
                  {`Seed: ${verification.revealedSeed}`}
                </AppText>
              </SurfaceCard>
            ) : null}

            {attempt && attempt.status === "completed" ? (
              <SurfaceCard>
                <AppText variant="bodyStrong">{"Today's result"}</AppText>
                <AppText variant="body" color="textSecondary" numeric testID="daily-score">
                  {`${formatChips(attempt.score)} after ${attempt.handsPlayed} hands`}
                </AppText>
              </SurfaceCard>
            ) : null}

            {notice ? (
              <AppText variant="body" color="warning" testID="daily-notice">
                {notice}
              </AppText>
            ) : null}

            <View style={styles.action}>
              <AppText
                variant="caption"
                color={plan.ranked ? "textSecondary" : "warning"}
                testID="daily-ranked-note"
              >
                {plan.detail}
              </AppText>
              <Button
                label={plan.label}
                testID="daily-start"
                accessibilityHint={
                  plan.ranked
                    ? "Opens today's ranked attempt"
                    : "Opens an unranked replay that does not affect your score"
                }
                disabled={starting}
                onPress={onStart}
              />
            </View>
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
    gap: spacing.xl,
    maxWidth: layout.maxTableWidth,
    width: "100%",
    alignSelf: "center",
  },
  header: { gap: spacing.xs },
  action: { gap: spacing.sm },
});
