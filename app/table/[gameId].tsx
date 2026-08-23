/**
 * A shared table.
 *
 * Everything here renders the server's last snapshot and nothing else. There is
 * no locally predicted card, no optimistic stack and no phase this screen
 * decided for itself — at a table with five people, a client that guesses is a
 * client that disagrees with everyone.
 *
 * Other seats are drawn compactly and the player's own hand large, because at
 * this size showing five equal hands makes all five unreadable.
 */

import { useEffect, useMemo } from "react";
import { ScrollView, StyleSheet, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { router, useLocalSearchParams } from "expo-router";

import { AppText } from "../../src/components/ui/AppText";
import { BackBar } from "../../src/components/ui/BackBar";
import { Button } from "../../src/components/ui/Button";
import { SurfaceCard, UnavailableNote } from "../../src/components/ui/Card";
import { TableSurface } from "../../src/features/cosmetics/art";
import { ActionDock } from "../../src/components/table/ActionDock";
import { BettingBar } from "../../src/components/table/BettingBar";
import { HandCards } from "../../src/components/table/HandCards";
import { OutcomeBadge } from "../../src/components/table/OutcomeBadge";
import { useTableFeedback } from "../../src/features/practice/use-table-feedback";
import { useTableTextVariant } from "../../src/design/accessibility";
import { colors, layout, spacing } from "../../src/design/tokens";
import { formatChips } from "../../src/design/typography";
import { announce } from "../../src/lib/accessibility/announce";
import { rankName } from "../../shared/blackjack/cards.js";
import { isVisibleCard } from "../../shared/blackjack/types.js";
import type { PublicGameState } from "../../shared/blackjack/index.js";
import {
  describeDealerUpCardForAnnouncement,
  isMyTurn,
  ownSeat,
  useOnlineTableStore,
  YOUR_TURN_ANNOUNCEMENT,
} from "../../src/features/table";
import { usePresenceStore } from "../../src/features/presence";

/**
 * How often the table re-reads itself.
 *
 * The table is live over Realtime — the server broadcasts after commit and the
 * store subscribes — so this is the fallback, not the mechanism. It is kept
 * because a dropped broadcast must not freeze a hand: any snapshot, pushed or
 * polled, is the authoritative one.
 */
const POLL_MS = 3_000;

export default function SharedTable() {
  const params = useLocalSearchParams<{ gameId?: string; seatId?: string }>();
  const gameId = typeof params.gameId === "string" ? params.gameId : null;
  const seatId = typeof params.seatId === "string" ? params.seatId : null;

  const status = useOnlineTableStore((state) => state.status);
  const connection = useOnlineTableStore((state) => state.connection);
  const pending = useOnlineTableStore((state) => state.pending);
  const stagedBet = useOnlineTableStore((state) => state.stagedBet);
  const notice = useOnlineTableStore((state) => state.notice);
  const enter = useOnlineTableStore((state) => state.enter);
  const refresh = useOnlineTableStore((state) => state.refresh);
  const addChip = useOnlineTableStore((state) => state.addChip);
  const clearBet = useOnlineTableStore((state) => state.clearBet);
  const lockBet = useOnlineTableStore((state) => state.lockBet);
  const act = useOnlineTableStore((state) => state.act);
  const nextHand = useOnlineTableStore((state) => state.nextHand);
  const setOwnPresence = usePresenceStore((state) => state.setOwnState);
  const lastEvents = useOnlineTableStore((state) => state.lastEvents);

  /*
   * The same feedback the practice table uses, from the same kind of event
   * stream. A shared table is where sound matters most — you hear somebody
   * else's card land — and it is driven by what the SERVER said happened, never
   * by a diff between two snapshots.
   */
  useTableFeedback(lastEvents, notice);

  useEffect(() => {
    if (!gameId || !seatId) return;
    void enter(gameId, seatId);
  }, [gameId, seatId, enter]);

  /*
   * Tell friends this player is at a table, and put them back to available on
   * the way out. The state is published to the channel only — nothing is
   * written down, so closing the app mid-hand cannot strand a permanent
   * "In a game" beside their name.
   */
  useEffect(() => {
    setOwnPresence("in_game");
    return () => setOwnPresence("available");
  }, [setOwnPresence]);

  // Other people act while this screen is open, so it re-reads on a timer.
  useEffect(() => {
    if (status.kind !== "at-table") return;
    const timer = setInterval(() => void refresh(), POLL_MS);
    return () => clearInterval(timer);
  }, [status.kind, refresh]);

  /*
   * Derived with `useMemo` from subscribed state. Calling a Zustand getter
   * during render freezes the value under the React Compiler — that bug shipped
   * in this project once and permanently disabled the Deal button.
   */
  const seat = useMemo(() => ownSeat(status), [status]);
  const myTurn = useMemo(() => isMyTurn(status), [status]);
  const legal = useMemo(
    () => (status.kind === "at-table" ? status.state.legalActions[status.seatId] : undefined),
    [status],
  );
  const dealerUpCard = useMemo(() => {
    if (status.kind !== "at-table") return null;
    const first = status.state.dealer.cards[0];
    return first && isVisibleCard(first) ? first : null;
  }, [status]);
  // The physical card's id, not the card object: the table snapshot is a
  // fresh object on every poll even when nothing changed, so keying the
  // announcement effect below on the object would re-announce it every 3
  // seconds while a hand sits waiting.
  const dealerUpCardId = dealerUpCard?.id ?? null;
  const dealerUpCardAnnouncement = dealerUpCard
    ? describeDealerUpCardForAnnouncement(rankName(dealerUpCard.rank))
    : null;

  // "Your turn." — keyed on the boolean itself, so a 3-second poll that
  // confirms the SAME turn does not re-announce it.
  useEffect(() => {
    if (myTurn) announce(YOUR_TURN_ANNOUNCEMENT);
  }, [myTurn]);

  // "Dealer shows six."
  useEffect(() => {
    if (dealerUpCardAnnouncement) announce(dealerUpCardAnnouncement);
  }, [dealerUpCardId, dealerUpCardAnnouncement]);

  const overlineVariant = useTableTextVariant("overline");

  /*
   * A command already in flight, or the table currently unreachable: either
   * way, a new command must not be sent. Kept as one flag at the call sites
   * below rather than two separate checks, because the reason does not change
   * what a control does — it stays disabled either way.
   */
  const controlsDisabled = pending || connection.kind === "reconnecting";

  if (!gameId || !seatId) {
    return (
      <Frame>
        <UnavailableNote>
          This screen needs a table to open. Start or join one from Social.
        </UnavailableNote>
      </Frame>
    );
  }

  if (status.kind === "loading" || status.kind === "idle") {
    return (
      <Frame>
        <AppText variant="body" color="textSecondary">
          Reading the table…
        </AppText>
      </Frame>
    );
  }

  if (status.kind !== "at-table") {
    return (
      <Frame>
        <UnavailableNote>{status.message}</UnavailableNote>
      </Frame>
    );
  }

  const table = status.state;
  const others = table.seats.filter((candidate) => candidate.seatId !== status.seatId);

  return (
    <Frame>
      <View style={styles.dealer}>
        <AppText variant={overlineVariant} color="textSecondary">
          Dealer
        </AppText>
        {table.dealer.cards.length > 0 ? (
          <HandCards
            cards={[...table.dealer.cards]}
            size="medium"
            /*
             * Only the face-up total, until the hole card is turned. The server
             * sends `displayedTotal` for exactly this reason — the client is
             * never given the hidden card to add up.
             */
            valueLabel={
              table.dealer.displayedTotal === null ? null : String(table.dealer.displayedTotal)
            }
          />
        ) : (
          <AppText variant="caption" color="textDisabled">
            Waiting for bets
          </AppText>
        )}
      </View>

      {others.length > 0 ? (
        <View style={styles.others}>
          {others.map((other) => {
            const hand = other.hands[0];
            return (
              <SurfaceCard key={other.seatId}>
                <View style={styles.otherHeader}>
                  <AppText variant="bodyStrong">{other.displayName}</AppText>
                  <AppText variant="caption" color="textSecondary" numeric>
                    {formatChips(other.stack)}
                  </AppText>
                </View>
                {hand && hand.cards.length > 0 ? (
                  <HandCards
                    cards={[...hand.cards]}
                    size="compact"
                    detail={hand.wager > 0 ? `Bet ${formatChips(hand.wager)}` : undefined}
                    focused={table.activeSeatId === other.seatId}
                  />
                ) : (
                  <AppText variant="caption" color="textDisabled">
                    {other.betLocked ? "Bet placed" : "Yet to bet"}
                  </AppText>
                )}
                {/* Player cards are public in blackjack; a stack is not a secret either. */}
                {!other.connected ? (
                  <AppText variant="caption" color="warning">
                    Disconnected — their clock keeps running.
                  </AppText>
                ) : null}
              </SurfaceCard>
            );
          })}
        </View>
      ) : null}

      <View style={styles.mine}>
        <AppText variant={overlineVariant} color="textSecondary">
          You
        </AppText>
        {seat?.hands.map((hand) => (
          <View key={hand.id} style={styles.myHand}>
            <HandCards
              cards={[...hand.cards]}
              size="hero"
              detail={hand.wager > 0 ? `Bet ${formatChips(hand.wager)}` : undefined}
              focused={table.activeHandId === hand.id}
            />
            {hand.outcome ? (
              <OutcomeBadge kind={hand.outcome.kind} net={hand.outcome.net} />
            ) : null}
          </View>
        ))}
        {seat && seat.hands.every((hand) => hand.cards.length === 0) ? (
          <AppText variant="caption" color="textDisabled">
            No cards yet.
          </AppText>
        ) : null}
      </View>

      {connection.kind === "reconnecting" ? (
        /*
         * Distinct from `notice` on purpose. This is a CONNECTION state, not a
         * one-off refusal — it says the hand has not stopped and what the
         * server will do if this seat's turn passes, which a generic error
         * message does not. See `afterFailure` in online-table-store.ts.
         */
        <AppText variant="body" color="warning" testID="table-reconnecting">
          {connection.message}
        </AppText>
      ) : notice ? (
        <AppText variant="body" color="warning" testID="table-notice">
          {notice}
        </AppText>
      ) : null}

      {table.phase === "SESSION_COMPLETE" ? (
        <SurfaceCard>
          <AppText variant="bodyStrong" testID="table-complete">
            This table has finished.
          </AppText>
          <AppText variant="body" color="textSecondary">
            Nothing more will be dealt here. Any result has already been recorded.
          </AppText>
        </SurfaceCard>
      ) : legal?.canPlaceBet && seat ? (
        <BettingBar
          legal={legal}
          stagedBet={stagedBet}
          lastBet={0}
          availableStack={seat.stack}
          onAddChip={addChip}
          onClear={clearBet}
          onRepeat={() => undefined}
          onLock={() => void lockBet()}
          pending={controlsDisabled}
        />
      ) : myTurn && legal ? (
        <>
          {/*
            Help, when the session asked for it.

            The recommendation is the SERVER's, computed from authoritative
            state by the same advisor that grades the decision, and it arrives
            on the snapshot. Nothing is derived here: a client that rebuilt
            advice locally would be a second implementation of the chart, and
            the two would disagree the first time a ruleset changed.

            Only a Quick Play table opened in Learn or Analysis ever carries it,
            and the server knows it sent it — so those decisions are excluded
            from the ranked accuracy board without the client being asked.
          */}
          <TableAdvice advice={table.advice ?? null} seatId={seatId} />
          <ActionDock
            legal={legal}
            onAction={(action) => void act(action)}
            pending={controlsDisabled}
          />
        </>
      ) : legal?.canStartNextHand ? (
        /*
         * The engine parks at HAND_COMPLETE deliberately, so a settlement is
         * never animated over. Someone has to ask for the next round, and at a
         * shared table the first tap starts it for everyone.
         */
        <Button
          label="Next hand"
          testID="table-next-hand"
          accessibilityHint="Starts the next round for everyone at this table"
          disabled={controlsDisabled}
          onPress={() => void nextHand()}
        />
      ) : (
        <AppText variant="caption" color="textDisabled" align="center" testID="table-waiting">
          {table.activeSeatId === null
            ? "Waiting for the next hand."
            : "Waiting for another player."}
        </AppText>
      )}
    </Frame>
  );
}

/**
 * Leaving CASHES OUT, and only navigates if the server agreed.
 *
 * This was a plain `<BackBar />` — a back navigation and nothing else. A public
 * table's buy-in therefore stayed in escrow for ever: the seat remained
 * `active`, the wallet stayed short, and the screen that took the chips
 * promises "whatever is left comes back when you leave". Nothing in the app had
 * ever sent `CASH_OUT`, though the server has implemented it since phase 5.
 *
 * A refusal keeps the player here with the reason on screen, because walking
 * away from a refused cash-out strands exactly the chips this is meant to
 * return.
 */
function Frame({ children }: { children: React.ReactNode }) {
  const leaveTable = useOnlineTableStore((state) => state.leaveTable);

  return (
    <SafeAreaView style={styles.screen} edges={["top"]}>
      {/* The equipped table theme, behind everything. Private, public,
          tournament and daily tables all render through this frame. */}
      <TableSurface />
      <View style={styles.bar}>
        <BackBar
          label="Leave table"
          onPress={() => {
            void (async () => {
              if (await leaveTable()) router.back();
            })();
          }}
        />
      </View>
      <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
        {children}
      </ScrollView>
    </SafeAreaView>
  );
}

/**
 * The recommended play, and — in Analysis — what each action is worth.
 *
 * Renders nothing at all when the server sent nothing, which is every table
 * except a Quick Play session opened in Learn or Analysis. `null` is the
 * ordinary case, not an error.
 *
 * EV is shown as a percentage of the wager, from the integer millionths the
 * server sends. No float crosses the wire and none decides anything; this is
 * presentation arithmetic on a number that has already been fixed.
 */
function TableAdvice({
  advice,
  seatId,
}: {
  advice: PublicGameState["advice"];
  seatId: string | null;
}) {
  if (!advice || advice.seatId !== seatId) return null;

  const evs = advice.actionEvMicros;
  return (
    <SurfaceCard testID="table-advice">
      <AppText variant="overline" color="textSecondary">
        Recommended
      </AppText>
      <AppText variant="sectionTitle" testID="table-advice-action">
        {ACTION_LABELS[advice.recommended] ?? advice.recommended}
      </AppText>
      <AppText variant="caption" color="textSecondary">
        {advice.explanation}
      </AppText>
      {evs
        ? Object.entries(evs)
            .map(([action, micros]) => [action, Number(micros)] as const)
            .sort((a, b) => b[1] - a[1])
            .map(([action, micros]) => (
              <AppText key={action} variant="caption" color="textSecondary" numeric>
                {`${ACTION_LABELS[action] ?? action}: ${(micros / 10_000).toFixed(2)}% of your bet`}
              </AppText>
            ))
        : null}
    </SurfaceCard>
  );
}

/** Player-facing names for the five graded actions. */
const ACTION_LABELS: Record<string, string> = {
  HIT: "Hit",
  STAND: "Stand",
  DOUBLE: "Double",
  SPLIT: "Split",
  SURRENDER: "Surrender",
};

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
  dealer: { alignItems: "center", gap: spacing.sm },
  others: { gap: spacing.md },
  otherHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
  },
  mine: { alignItems: "center", gap: spacing.md },
  myHand: { alignItems: "center", gap: spacing.sm },
});
