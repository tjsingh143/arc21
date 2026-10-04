import { useAuthStore } from "../../src/features/auth/auth-store";
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
 *
 * WAITING IS REAL NOW, AND IT WAS NOT BEFORE. `poll_matchmaking` used to open a
 * table for a lone player on their first poll, so this screen went from "Choose
 * your stakes" to "Seat found" in one round trip and `status === "queued"` was
 * observable for a few milliseconds at most. Everything below that gate — the
 * ticking wait, and the specification's Keep Waiting / Play Solo / Cancel — was
 * unreachable code sitting in a shipped screen. A public table is "two to five
 * human seats"; a room is now opened only when there is somebody to share it
 * with, so a player at a quiet hour genuinely waits and genuinely needs the
 * three ways out.
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
  describeOthersWaiting,
  describeWait,
  shouldOfferAlternatives,
  useMatchmakingStore,
  type TierId,
} from "../../src/features/matchmaking";
import { useQuickPlayStore } from "../../src/features/quick-play";
import { useLevelStore } from "../../src/features/stats/level-store";

/** How often the client asks whether a seat has appeared. */
const POLL_MS = 2_000;

export default function PublicTable() {
  const userId = useAuthStore((state) => state.session?.account.userId ?? null);
  const status = useMatchmakingStore((state) => state.status);
  const notice = useMatchmakingStore((state) => state.notice);
  const queue = useMatchmakingStore((state) => state.queue);
  const poll = useMatchmakingStore((state) => state.poll);
  const cancel = useMatchmakingStore((state) => state.cancel);
  const takeSeat = useMatchmakingStore((state) => state.takeSeat);
  const keepWaiting = useMatchmakingStore((state) => state.keepWaiting);
  const keepWaitingUntil = useMatchmakingStore((state) => state.keepWaitingUntil);

  /*
   * The player's level, for the tier that unlocks at ten.
   *
   * Quick Play has always disabled a tier it cannot open; this screen rendered
   * all three as pressable and let the server refuse the third. "Do not expose
   * unavailable tiers falsely" is the rule, and two screens offering the same
   * three tiers must not disagree about which of them can be tapped.
   */
  const level = useLevelStore((state) => state.record);
  const loadLevel = useLevelStore((state) => state.load);
  const rememberQuickPlay = useQuickPlayStore((state) => state.remember);
  const rememberedQuickPlay = useQuickPlayStore((state) => state.remembered);

  useEffect(() => {
    void loadLevel();
  }, [userId, loadLevel]);

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
    () =>
      place && status.kind === "queued"
        ? shouldOfferAlternatives(place.waitingSince, now, keepWaitingUntil)
        : false,
    [place, status.kind, now, keepWaitingUntil],
  );
  const playerLevel = level?.level ?? 1;

  const onCancel = useCallback(() => void cancel(), [cancel]);

  /*
   * "Play Solo", and it means the SERVER'S one-player table.
   *
   * This used to route to local Practice. Practice is the right answer for a
   * guest — it is what Quick Play does when there is no account — but nobody
   * without an account can reach this screen at all: `queue()` refuses with
   * "Public tables need an account". So the player standing here is a signed-in
   * player who asked for stakes, and sending them to a local table that touches
   * no wallet is a quieter answer than the specification's: *"registered online
   * Quick Play is server authoritative and uses a one-player table unless the
   * user selects Public Table."* The stakes they chose are carried over, so
   * Quick Play opens on the tier they were queueing for.
   */
  const onPlaySolo = useCallback(() => {
    void (async () => {
      const tier = place?.tier ?? "casual";
      await cancel();
      await rememberQuickPlay({
        tier,
        assistance: rememberedQuickPlay?.assistance ?? "play",
      });
      router.replace("/table/quick");
    })();
  }, [cancel, place?.tier, rememberQuickPlay, rememberedQuickPlay?.assistance]);

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
              Counted by the server, not asserted here. This card used to state
              "Nobody else is queueing for these stakes right now" whenever it
              offered a way out, without having asked — and it was wrong in
              exactly the case that matters, because two people waiting is when
              holding on for a few more seconds is worth doing.
            */}
            <AppText variant="caption" color="textSecondary" testID="matchmaking-others">
              {describeOthersWaiting(place)}
            </AppText>
            {/*
              After about twenty seconds the player is offered something else.
              Not because anything failed — an empty queue at a quiet hour is
              normal — but because silence for that long reads as a bug. All
              three of the specification's controls are here: Keep Waiting holds
              the search open for another window, Play Solo opens the server's
              one-player table at the same stakes, Cancel stops.
            */}
            {offerWayOut ? (
              <View style={styles.waysOut}>
                <Button
                  label="Keep waiting"
                  testID="matchmaking-keep-waiting"
                  accessibilityHint="Keeps looking for another twenty seconds"
                  onPress={() => void keepWaiting()}
                />
                <Button
                  label="Play solo instead"
                  variant="secondary"
                  testID="matchmaking-solo"
                  accessibilityHint="Leaves the queue and opens a one-player table at these stakes"
                  onPress={onPlaySolo}
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
            {TABLE_TIERS.map((tier) => {
              const tierLocked = playerLevel < tier.unlockLevel;
              return (
                <SurfaceCard
                  key={tier.id}
                  disabled={tierLocked}
                  onPress={tierLocked ? undefined : () => void queue(tier.id as TierId)}
                  testID={`matchmaking-tier-${tier.id}`}
                  accessibilityLabel={`${tier.label} table`}
                  accessibilityHint={
                    tierLocked
                      ? `Unlocks at level ${tier.unlockLevel}`
                      : `Buy-in ${tier.buyIn} chips, bets from ${tier.minBet} to ${tier.maxBet}`
                  }
                >
                  <AppText variant="bodyStrong">{tier.label}</AppText>
                  <AppText variant="body" color="textSecondary" numeric>
                    {`Buy-in ${formatChips(tier.buyIn)} · Bets ${formatChips(tier.minBet)}–${formatChips(tier.maxBet)}`}
                  </AppText>
                  {tierLocked ? (
                    <AppText variant="caption" color="textDisabled">
                      {`Unlocks at level ${tier.unlockLevel}`}
                    </AppText>
                  ) : null}
                </SurfaceCard>
              );
            })}
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
