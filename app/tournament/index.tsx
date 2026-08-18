/**
 * Sprint Tournament.
 *
 * The specification requires the whole format to be visible before the entry fee
 * is spent, so this screen states it in full — and reads it from the server
 * rather than restating it in copy that could drift from what is actually
 * enforced.
 *
 * It is also explicit about the two chip flows, which are easy to conflate: the
 * 500-chip entry leaves the wallet, and the 10,000-chip stack does not enter it.
 * Tournament chips are a scoring medium and cannot be cashed.
 */

import { useCallback, useEffect, useMemo, useRef } from "react";
import { ScrollView, StyleSheet, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { router } from "expo-router";

import { AppText } from "../../src/components/ui/AppText";
import { BackBar } from "../../src/components/ui/BackBar";
import { Button } from "../../src/components/ui/Button";
import { SurfaceCard, UnavailableNote } from "../../src/components/ui/Card";
import { colors, layout, spacing } from "../../src/design/tokens";
import { formatChips } from "../../src/design/typography";
import { playSound } from "../../src/lib/audio/audio";
import { hapticTournamentAdvance } from "../../src/lib/haptics/haptics";
import { usePushRegistration } from "../../src/features/notifications";
import { useSettings } from "../../src/features/settings/use-settings";
import {
  describeProgress,
  ordinal,
  sharedPlacements,
  useTournamentStore,
} from "../../src/features/tournament";

/** The standings change as other people play, so the screen re-reads itself. */
const POLL_MS = 3_000;

export default function SprintTournament() {
  const status = useTournamentStore((state) => state.status);
  const notice = useTournamentStore((state) => state.notice);
  const registering = useTournamentStore((state) => state.registering);
  const load = useTournamentStore((state) => state.load);
  const register = useTournamentStore((state) => state.register);

  const offerPush = usePushRegistration((state) => state.offer);
  const { settings, update: updateSettings } = useSettings();

  /*
   * Entering is the third moment the specification allows for asking about
   * notifications, and the most obviously earned: the tournament will start when
   * three other people arrive, which could be in a minute or in an hour, and the
   * alternative is watching this screen.
   */
  const onRegister = useCallback(async () => {
    await register();
    const granted = await offerPush("entered-tournament", settings);
    if (granted) await updateSettings(granted);
  }, [register, offerPush, settings, updateSettings]);

  useEffect(() => {
    void load();
  }, [load]);

  const entry = useMemo(() => (status.kind === "ready" ? status.entry : null), [status]);
  const standings = useMemo(
    () => (status.kind === "ready" ? status.standings : []),
    [status],
  );
  const shared = useMemo(() => sharedPlacements(standings), [standings]);
  const waiting = entry !== null && entry.tournament_status === "registering";

  /*
   * The advancement cue, fired on a TRANSITION rather than on a state.
   *
   * The screen polls, so "the tournament is running" is true on every read; only
   * the moment it becomes true is worth a sound. The previous value is held in a
   * ref so a re-render cannot replay it, which is the same reason the table's
   * feedback hook keys on event identity.
   */
  const previousStatus = useRef<string | null>(null);
  useEffect(() => {
    const current = entry?.tournament_status ?? null;
    const previous = previousStatus.current;
    previousStatus.current = current;

    if (previous === null || current === null || previous === current) return;
    if (
      (previous === "registering" && current === "running") ||
      current === "completed"
    ) {
      playSound("tournamentAdvance");
      hapticTournamentAdvance();
    }
  }, [entry?.tournament_status]);

  // Only while waiting for the field to fill or while a hand is running
  // elsewhere. A completed tournament has nothing left to poll for.
  useEffect(() => {
    if (!entry || entry.tournament_status === "completed") return;
    const timer = setInterval(() => void load(), POLL_MS);
    return () => clearInterval(timer);
  }, [entry, load]);

  const onOpenTable = useCallback(() => {
    // Both ids, and the SEAT id rather than the entry id: the table screen finds
    // the player's own hand and controls by seat, so an entry id there renders a
    // table with no buttons on it.
    if (!entry?.game_session_id || !entry.game_session_seat_id) return;
    router.push({
      pathname: "/table/[gameId]",
      params: { gameId: entry.game_session_id, seatId: entry.game_session_seat_id },
    });
  }, [entry]);

  return (
    <SafeAreaView style={styles.screen} edges={["top"]}>
      <View style={styles.bar}>
        <BackBar />
      </View>

      <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
        <View style={styles.header}>
          <AppText variant="pageTitle" accessibilityRole="header">
            Sprint Tournament
          </AppText>
          <AppText variant="body" color="textSecondary">
            Four players, equal stacks, one elimination.
          </AppText>
        </View>

        {status.kind === "loading" ? (
          <AppText variant="body" color="textSecondary">
            Reading the format…
          </AppText>
        ) : status.kind === "unavailable" ? (
          <UnavailableNote>{status.message}</UnavailableNote>
        ) : (
          <>
            {/* The format, before the fee. */}
            <SurfaceCard>
              <AppText variant="bodyStrong">The format</AppText>
              <AppText variant="body" color="textSecondary" numeric>
                {`${status.format.seats} players · ${status.format.scheduled_hands} hands · ` +
                  `${formatChips(status.format.starting_chips)} equal stacks`}
              </AppText>
              <AppText variant="body" color="textSecondary" numeric>
                {`Bets ${formatChips(status.format.min_bet)}–${formatChips(status.format.early_max_bet)}, ` +
                  `rising to ${formatChips(status.format.late_max_bet)} from hand ${status.format.late_bets_from}`}
              </AppText>
              <AppText variant="body" color="textSecondary" numeric>
                {`Lowest stack is eliminated after hand ${status.format.elimination_hand}`}
              </AppText>
              <AppText variant="caption" color="textDisabled">
                The first bettor rotates one seat clockwise every hand, so no seat
                keeps a positional advantage. Bets are placed in turn and visible.
              </AppText>
            </SurfaceCard>

            <SurfaceCard>
              <AppText variant="bodyStrong" numeric>
                {`Entry ${formatChips(status.format.entry_fee_chips)} chips`}
              </AppText>
              <AppText variant="body" color="textSecondary">
                That is the only time your balance is touched. The tournament
                stack is for scoring and cannot be cashed out.
              </AppText>
              <View style={styles.prizes}>
                {status.format.prize_structure.map((prize) => (
                  <AppText
                    key={prize.placement}
                    variant="caption"
                    color="textSecondary"
                    numeric
                  >
                    {`${ordinal(prize.placement)} — ${formatChips(prize.chips)} chips · ${prize.xp} XP`}
                  </AppText>
                ))}
              </View>
              <AppText variant="caption" color="textDisabled">
                No rebuys. Strategy assistance is off in a ranked tournament, and
                tournament decisions are excluded from your basic-strategy accuracy
                — correct tournament play is not always basic strategy.
              </AppText>
            </SurfaceCard>

            {/* Signed out, the same wording is carried by the note below; showing
                both would say it twice. */}
            {notice && !status.signedOut ? (
              <AppText variant="body" color="warning" testID="tournament-notice">
                {notice}
              </AppText>
            ) : null}

            {status.signedOut ? (
              /*
               * The format above is real and read from the server; only entering
               * needs an account. Said plainly rather than shown as a button that
               * cannot work.
               */
              <UnavailableNote>{notice ?? "Entering a tournament needs an account."}</UnavailableNote>
            ) : entry ? (
              <SurfaceCard>
                <AppText variant="bodyStrong" testID="tournament-progress">
                  {describeProgress(entry)}
                </AppText>
                {waiting ? (
                  <AppText variant="caption" color="textDisabled" numeric>
                    {`${entry.entries_filled} of ${entry.seats_required} seats taken. Your entry is paid and held.`}
                  </AppText>
                ) : null}
                {entry.game_session_id && entry.game_session_seat_id ? (
                  <Button
                    label={entry.tournament_status === "completed" ? "Review the table" : "Open the table"}
                    testID="tournament-open-table"
                    accessibilityHint="Opens the tournament table"
                    onPress={onOpenTable}
                  />
                ) : null}
              </SurfaceCard>
            ) : (
              <Button
                label="Enter for 500 chips"
                testID="tournament-register"
                accessibilityHint="Takes the entry fee and holds a seat until four players have entered"
                disabled={registering}
                onPress={() => void onRegister()}
              />
            )}

            {standings.length > 0 ? (
              <View style={styles.standings}>
                <AppText variant="sectionTitle">Standings</AppText>
                {standings.map((row) => (
                  <SurfaceCard key={row.entry_id}>
                    <View style={styles.standingHeader}>
                      <AppText variant="bodyStrong">
                        {row.is_you ? `${row.display_name} (you)` : row.display_name}
                      </AppText>
                      <AppText variant="body" color="textSecondary" numeric>
                        {formatChips(row.chips)}
                      </AppText>
                    </View>
                    <AppText variant="caption" color="textSecondary">
                      {row.status === "eliminated"
                        ? `Out after hand ${row.eliminated_after_hand ?? "?"}`
                        : row.in_tie_break
                          ? "In sudden death"
                          : "Still in"}
                    </AppText>
                    {row.placement !== null ? (
                      <AppText variant="caption" color="textSecondary" numeric>
                        {`${ordinal(row.placement)}` +
                          (shared.has(row.placement) ? " (shared — prize divided)" : "") +
                          ` · ${formatChips(row.prize_chips)} chips · ${row.prize_xp} XP`}
                      </AppText>
                    ) : null}
                  </SurfaceCard>
                ))}
              </View>
            ) : null}
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
  prizes: { gap: spacing.xs, paddingTop: spacing.xs },
  standings: { gap: spacing.md },
  standingHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    gap: spacing.sm,
  },
});
