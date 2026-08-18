/**
 * Public table — pick your stakes and wait for a seat.
 *
 * The screen states the money before it states anything else, because this is
 * the one table where a player's real balance is at stake. A private table's
 * chips belong to the table; here the buy-in comes out of the wallet and the
 * remainder comes back when they leave.
 *
 * Queueing itself costs nothing. That is said out loud, because a player who
 * waits twenty seconds and gives up must not be left wondering whether they
 * were charged for the privilege.
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
import { TABLE_TIERS } from "../../shared/blackjack";
import {
  describeWait,
  shouldOfferAlternatives,
  useMatchmakingStore,
  type TierId,
} from "../../src/features/matchmaking";

/** How often the client asks whether a seat has appeared. */
const POLL_MS = 2_000;

export default function PublicTable() {
  const status = useMatchmakingStore((state) => state.status);
  const notice = useMatchmakingStore((state) => state.notice);
  const queue = useMatchmakingStore((state) => state.queue);
  const poll = useMatchmakingStore((state) => state.poll);
  const cancel = useMatchmakingStore((state) => state.cancel);
  const takeSeat = useMatchmakingStore((state) => state.takeSeat);

  // A ticking clock, so "Still looking — 14s" actually advances.
  const [now, setNow] = useState(() => new Date());

  useEffect(() => {
    if (status.kind !== "queued") return;
    const timer = setInterval(() => {
      setNow(new Date());
      void poll();
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [status.kind, poll]);

  /*
   * Derived with `useMemo` from subscribed state, never by calling a store
   * getter during render — under the React Compiler that freezes the value.
   */
  const place = useMemo(
    () => (status.kind === "queued" || status.kind === "matched" ? status.place : null),
    [status],
  );
  const offerWayOut = useMemo(
    () => (place && status.kind === "queued" ? shouldOfferAlternatives(place.waitingSince, now) : false),
    [place, status.kind, now],
  );

  const onCancel = useCallback(() => void cancel(), [cancel]);

  return (
    <SafeAreaView style={styles.screen} edges={["top"]}>
      <View style={styles.bar}>
        <BackBar />
      </View>

      <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
        <View style={styles.header}>
          <AppText variant="pageTitle" accessibilityRole="header">
            Public table
          </AppText>
          <AppText variant="body" color="textSecondary">
            Two to five players, one dealer, one shoe.
          </AppText>
        </View>

        {/*
          The distinction from a private table, stated plainly. This is the only
          shared table where the global balance is involved at all.
        */}
        <SurfaceCard>
          <AppText variant="bodyStrong">Your chips are at stake here</AppText>
          <AppText variant="body" color="textSecondary">
            A buy-in is taken from your balance when you sit down, and whatever
            is left comes back when you leave. Unlike a private table, these are
            your real chips.
          </AppText>
          <AppText variant="caption" color="textDisabled">
            Looking for a table costs nothing. You are only charged once a seat
            is opened.
          </AppText>
        </SurfaceCard>

        {status.kind === "unavailable" ? <UnavailableNote>{status.message}</UnavailableNote> : null}

        {notice ? (
          <AppText variant="body" color="warning" testID="matchmaking-notice">
            {notice}
          </AppText>
        ) : null}

        {status.kind === "matched" && place?.roomId ? (
          <SurfaceCard>
            <AppText variant="bodyStrong">Seat found</AppText>
            <AppText variant="body" color="textSecondary">
              {place.seatedBefore === 0
                ? "You are first at this table. Others will join as they queue."
                : `${place.seatedBefore} already seated.`}
            </AppText>
            <Button
              label="Take the seat"
              testID="matchmaking-take-seat"
              accessibilityHint="Takes the buy-in from your balance and opens the table"
              onPress={() => {
                void (async () => {
                  const seat = await takeSeat();
                  if (!seat) return;
                  router.replace({
                    pathname: "/table/[gameId]",
                    params: { gameId: seat.gameId, seatId: seat.seatId },
                  });
                })();
              }}
            />
          </SurfaceCard>
        ) : status.kind === "queued" && place ? (
          <SurfaceCard>
            <AppText variant="bodyStrong" testID="matchmaking-wait">
              {describeWait(place, now)}
            </AppText>
            {/*
              After about twenty seconds the player is offered something else.
              Not because anything failed — an empty queue at a quiet hour is
              normal — but because silence for that long reads as a bug.
            */}
            {offerWayOut ? (
              <View style={styles.waysOut}>
                <AppText variant="caption" color="textSecondary">
                  Nobody else is queueing for these stakes right now.
                </AppText>
                <Button
                  label="Play solo instead"
                  variant="secondary"
                  testID="matchmaking-solo"
                  accessibilityHint="Leaves the queue and opens a one-player table"
                  onPress={() => {
                    void cancel();
                    router.replace("/game/practice");
                  }}
                />
              </View>
            ) : null}
            <Button
              label="Cancel"
              variant="quiet"
              testID="matchmaking-cancel"
              accessibilityHint="Stops looking for a table"
              onPress={onCancel}
            />
          </SurfaceCard>
        ) : (
          <View style={styles.tiers}>
            <AppText variant="sectionTitle">Choose your stakes</AppText>
            {TABLE_TIERS.map((tier) => (
              <SurfaceCard
                key={tier.id}
                onPress={() => void queue(tier.id as TierId)}
                testID={`matchmaking-tier-${tier.id}`}
                accessibilityLabel={`${tier.label} table`}
                accessibilityHint={`Buy-in ${tier.buyIn} chips, bets from ${tier.minBet} to ${tier.maxBet}`}
              >
                <AppText variant="bodyStrong">{tier.label}</AppText>
                <AppText variant="body" color="textSecondary" numeric>
                  {`Buy-in ${formatChips(tier.buyIn)} · Bets ${formatChips(tier.minBet)}–${formatChips(tier.maxBet)}`}
                </AppText>
                {tier.unlockLevel > 1 ? (
                  <AppText variant="caption" color="textDisabled">
                    {`Unlocks at level ${tier.unlockLevel}`}
                  </AppText>
                ) : null}
              </SurfaceCard>
            ))}
          </View>
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
  tiers: { gap: spacing.md },
  waysOut: { gap: spacing.sm, paddingTop: spacing.sm },
});
