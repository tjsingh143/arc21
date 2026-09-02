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

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Alert, Pressable, ScrollView, StyleSheet, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { router, useLocalSearchParams, useNavigation } from "expo-router";

import { AppText } from "../../src/components/ui/AppText";
import { BackBar } from "../../src/components/ui/BackBar";
import { Button } from "../../src/components/ui/Button";
import { SurfaceCard, UnavailableNote } from "../../src/components/ui/Card";
import { TableSurface } from "../../src/features/cosmetics/art";
import { ActionDock } from "../../src/components/table/ActionDock";
import { BettingBar } from "../../src/components/table/BettingBar";
import { InsuranceSheet } from "../../src/components/table/InsuranceSheet";
import { HandCards } from "../../src/components/table/HandCards";
import { HandSelector } from "../../src/components/table/HandSelector";
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
  describeLeaveTableConfirmation,
  LEAVE_TABLE_CONFIRM_TITLE,
  LEAVING_AT_BOUNDARY_NOTICE,
  mayLeaveTable,
  STAY_AT_TABLE_LABEL,
  shouldConfirmLeavingTable,
  TABLE_EXIT_ROUTE,
  tableExitSequence,
} from "../../src/features/table/leave-guard";
import { useSettings } from "../../src/features/settings/use-settings";
import {
  BROKE_AT_PRIVATE_TABLE_BODY,
  BROKE_AT_PRIVATE_TABLE_TITLE,
  COUNTDOWN_TICK_MS,
  deadlineAwaitsSeat,
  describeDeadline,
  describeDealerUpCardForAnnouncement,
  engineEventsOf,
  insuranceOffer,
  isMyTurn,
  mayResetPrivateStack,
  ownSeat,
  RESET_PRIVATE_STACK_LABEL,
  resolveTableSeat,
  selectActiveSession,
  useActiveSessionStore,
  useOnlineTableStore,
  YOUR_TURN_ANNOUNCEMENT,
} from "../../src/features/table";
import { describeWaiting } from "../../src/features/table/betting-affordance";
import {
  describeSplitHands,
  focusedSplitHandId,
} from "../../src/features/table/split-hands";
import {
  describeTableProgress,
  describeTableRules,
} from "../../src/features/table/table-rules";
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
  const paramSeatId = typeof params.seatId === "string" ? params.seatId : null;

  const status = useOnlineTableStore((state) => state.status);
  const connection = useOnlineTableStore((state) => state.connection);
  const pending = useOnlineTableStore((state) => state.pending);
  const stagedBet = useOnlineTableStore((state) => state.stagedBet);
  const notice = useOnlineTableStore((state) => state.notice);
  /*
   * A leave the server refused mid-hand, still outstanding.
   *
   * Rendered from the STORE rather than from `notice`, because a poll clears
   * the notice three seconds later — so the refusal's own promise ("your chips
   * come back as soon as it settles") disappeared while the thing it promised
   * had not happened yet and, before `leavingWhenSafe` existed, never would.
   */
  const leavingWhenSafe = useOnlineTableStore((state) => state.leavingWhenSafe);
  const stayAtTable = useOnlineTableStore((state) => state.stayAtTable);
  const enter = useOnlineTableStore((state) => state.enter);
  const refresh = useOnlineTableStore((state) => state.refresh);
  const addChip = useOnlineTableStore((state) => state.addChip);
  const clearBet = useOnlineTableStore((state) => state.clearBet);
  const lastBet = useOnlineTableStore((state) => state.lastBet);
  const repeatBet = useOnlineTableStore((state) => state.repeatBet);
  const lockBet = useOnlineTableStore((state) => state.lockBet);
  const act = useOnlineTableStore((state) => state.act);
  const takeInsurance = useOnlineTableStore((state) => state.takeInsurance);
  const declineInsurance = useOnlineTableStore((state) => state.declineInsurance);
  const nextHand = useOnlineTableStore((state) => state.nextHand);
  const setOwnPresence = usePresenceStore((state) => state.setOwnState);
  const lastEvents = useOnlineTableStore((state) => state.lastEvents);
  const resolveTimeout = useOnlineTableStore((state) => state.resolveTimeout);
  const resetStack = useOnlineTableStore((state) => state.resetStack);

  /*
   * WHICH KIND OF TABLE THIS IS, asked of the server rather than carried.
   *
   * `my_active_session()` derives the mode from the session row for the seat
   * the caller actually holds. A route parameter would have been cheaper and
   * would have been the wrong kind of answer: this screen is reached by a
   * `router.replace` from the lobby, by a resume card, and by a deep link, and
   * a value that outlives one of those is precisely the shape of the defect
   * `mayOpenDealtTable` exists to close.
   *
   * Only used to decide whether the free reset is DRAWN. The server checks the
   * mode again inside `RESET_PRIVATE_STACK`, so a client that got this wrong
   * would be refused rather than obeyed.
   */
  const activeSessionStatus = useActiveSessionStore((state) => state.status);
  const refreshActiveSession = useActiveSessionStore((state) => state.refresh);
  const activeSession = useMemo(
    () => selectActiveSession(activeSessionStatus),
    [activeSessionStatus],
  );
  const [sessionChecked, setSessionChecked] = useState(false);

  /*
   * THE SEAT, WHICH THE ROUTE DOES NOT ALWAYS CARRY.
   *
   * Every in-app route to this screen passes `seatId` — except the `your_turn`
   * notification, whose payload may hold only a fixed set of short scalars and
   * carries `game_id` alone. So the one message written specifically to bring an
   * absent player back landed on "This screen needs a table to open", which is
   * the opposite of what the notification had just told them. See
   * `resolveTableSeat`.
   */
  const seatLookup = useMemo(
    () =>
      resolveTableSeat({
        gameId,
        paramSeatId,
        checked: sessionChecked,
        session: activeSession,
      }),
    [gameId, paramSeatId, sessionChecked, activeSession],
  );
  const seatId = seatLookup.kind === "known" ? seatLookup.seatId : null;

  /*
   * The same feedback the practice table uses, from the same kind of event
   * stream. A shared table is where sound matters most — you hear somebody
   * else's card land — and it is driven by what the SERVER said happened, never
   * by a diff between two snapshots.
   *
   * Unwrapped from the ordering envelope HERE rather than in the gateway, and
   * memoised on the batch's identity so the array is stable for exactly as long
   * as the batch is: `useTableFeedback` decides "already felt" by identity, and
   * a fresh array per render would replay the last hand's outcome on every tick
   * of the countdown below.
   */
  const feedbackEvents = useMemo(() => engineEventsOf(lastEvents), [lastEvents]);
  useTableFeedback(feedbackEvents, notice);

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

  /*
   * Asked once per mount, alongside the snapshot.
   *
   * `sessionChecked` is COMPONENT state for the reason `mayOpenDealtTable`'s
   * `checked` is: the store behind this lookup is a module-level cache the Play
   * screen also fills, so a `ready` reading can arrive here already carried over
   * from a previous screen. A failure means the reset is simply not offered —
   * never a wrong offer — and the next mount asks again.
   */
  useEffect(() => {
    let live = true;
    void refreshActiveSession().finally(() => {
      if (live) setSessionChecked(true);
    });
    return () => {
      live = false;
    };
  }, [refreshActiveSession]);

  // Other people act while this screen is open, so it re-reads on a timer.
  useEffect(() => {
    if (status.kind !== "at-table") return;
    const timer = setInterval(() => void refresh(), POLL_MS);
    return () => clearInterval(timer);
  }, [status.kind, refresh]);

  /*
   * THE SERVER'S CLOCK, AND THE ASK THAT GOES WITH IT.
   *
   * `deadlineAt` has been on every snapshot since the wire contract was written,
   * under the comment "Clients render countdowns against server time", and no
   * client code read it. Two things were missing, and the second is the one that
   * mattered: there was no countdown, and NOTHING EVER ASKED THE SERVER TO
   * RESOLVE AN EXPIRED DEADLINE. Arc 21 runs no long-lived game process, so a
   * connected client asking is the only thing that moves a lapsed timer — and
   * the app's one `RESOLVE_TIMEOUT` call site is `snapshot()`, pinned to
   * `expectedVersion: 0` so it can never apply. So an absent player froze a
   * shared table for everybody, with the fifteen-second timer that exists to
   * stop exactly that already long expired.
   *
   * The clock ticks only while there IS a deadline: a solo table and a career
   * node carry none on purpose, and a screen that re-rendered every second to
   * display nothing would be a battery cost for no one.
   */
  const deadlineAt = status.kind === "at-table" ? status.state.deadlineAt : null;
  const [now, setNow] = useState<Date>(() => new Date());
  useEffect(() => {
    if (deadlineAt === null) return;
    const timer = setInterval(() => setNow(new Date()), COUNTDOWN_TICK_MS);
    return () => clearInterval(timer);
  }, [deadlineAt]);

  /*
   * Asked on every tick, and refused by the store on all but one of them:
   * `shouldRequestTimeoutResolution` requires the deadline to have passed, no
   * command in flight, a live connection, and no ask already made at this
   * version. The server checks its OWN clock again and answers
   * DEADLINE_NOT_REACHED if it disagrees, so this can never do more than waste
   * one round trip.
   */
  useEffect(() => {
    void resolveTimeout();
  }, [now, deadlineAt, resolveTimeout]);

  /*
   * WHO THE CLOCK IS FOR, derived from the server's snapshot.
   *
   * On a two-simulator run the host's screen read "10 seconds to act · you
   * stand if you do not" while the OTHER seat was the one being waited on —
   * wrong twice over, and invisible to every assertion about that string. The
   * phase alone does not say whose deadline it is; the snapshot does.
   */
  const awaitingYou = useMemo(() => {
    if (status.kind !== "at-table") return false;
    const table = status.state;
    const mine = table.seats.find((candidate) => candidate.seatId === status.seatId);
    const mineLegal = table.legalActions[status.seatId];
    return deadlineAwaitsSeat({
      phase: table.phase,
      seatId: status.seatId,
      activeSeatId: table.activeSeatId,
      betLocked: mine?.betLocked ?? false,
      sittingOut: mine?.sittingOut ?? true,
      canAnswerInsurance: Boolean(mineLegal?.canTakeInsurance || mineLegal?.canDeclineInsurance),
    });
  }, [status]);

  const countdown = useMemo(
    () =>
      status.kind === "at-table"
        ? describeDeadline({ deadlineAt, phase: status.state.phase, now, awaitingYou })
        : null,
    [status, deadlineAt, now, awaitingYou],
  );

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
  /*
   * The insurance offer, or null.
   *
   * There was no branch here at all until this phase, and the consequence was
   * quiet: `myTurn` reads `activeSeatId`, which is null during the offer
   * because insurance is not a turn, so the screen fell through to "Waiting for
   * the next hand." and sat there until the deadline expired and the server
   * declined for the player. Insurance was unreachable at EVERY server table.
   */
  const offer = useMemo(
    () => (status.kind === "at-table" ? insuranceOffer(status.state.phase, legal ?? null) : null),
    [status, legal],
  );

  /*
   * THE FREE RESET, and the reason this branch exists at all.
   *
   * A seat that cannot cover the table minimum is sat out by the engine, and
   * `getLegalActions` answers NO_ACTIONS for a seat that is sitting out — so
   * every branch below is false and the screen falls through to "Waiting for
   * the next hand.", hand after hand, for the life of the table. At a private
   * table the specification's remedy is a free reset to the fixed stack, which
   * the server has always accepted and nothing had ever sent.
   */
  const canResetStack = useMemo(
    () =>
      status.kind === "at-table" && seat !== null
        ? mayResetPrivateStack({
            isPrivateTable:
              activeSession?.mode === "private_table" &&
              activeSession.gameId === status.state.gameId,
            phase: status.state.phase,
            sittingOut: seat.sittingOut,
            connected: seat.connected,
          })
        : false,
    [status, seat, activeSession],
  );

  /*
   * The split presentation, derived from subscribed state with `useMemo` — the
   * same discipline as `seat` and `legal` above, and for the same reason.
   * `describeSplitHands` returns an empty array for a single hand, so an
   * ordinary hand renders no chip row at all.
   */
  const splitHands = useMemo(
    () =>
      describeSplitHands({
        hands: seat?.hands ?? [],
        activeHandId: status.kind === "at-table" ? status.state.activeHandId : null,
      }),
    [seat, status],
  );
  const focusedHandId = useMemo(
    () =>
      focusedSplitHandId({
        hands: seat?.hands ?? [],
        activeHandId: status.kind === "at-table" ? status.state.activeHandId : null,
      }),
    [seat, status],
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

  if (!seatId) {
    return (
      <Frame>
        {seatLookup.kind === "checking" ? (
          // The lookup has not answered yet. Saying "you have no table" here
          // would be the same dead end one beat earlier.
          <AppText variant="body" color="textSecondary">
            Reading the table…
          </AppText>
        ) : (
          <UnavailableNote>
            This screen needs a table to open. Start or join one from Social.
          </UnavailableNote>
        )}
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
      {/*
        THE TERMS OF THE TABLE, ON THE TABLE.

        `rulesSummary`, `handNumber` and `shoe` have been on every snapshot
        since the contract was written and this screen rendered none of them —
        so the tables where the rules are NOT the player's own choice were the
        only ones that never stated them. Derived from the snapshot by
        `table-rules.ts`, never typed into copy.
      */}
      <View style={styles.tableInfo}>
        <AppText variant="caption" color="textSecondary" numeric testID="table-progress">
          {describeTableProgress(table)}
        </AppText>
        <AppText
          variant="caption"
          color="textDisabled"
          align="center"
          testID="table-rules"
        >
          {describeTableRules(table.rulesSummary)}
        </AppText>
      </View>

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
        <View style={styles.mineHeader}>
          <AppText variant={overlineVariant} color="textSecondary">
            You
          </AppText>
          {/*
            YOUR OWN STACK, VISIBLE THE WHOLE TIME.

            Every other seat at the table showed its stack; this one showed its
            stack only during betting, inside `BettingBar`'s "Available". So
            from the moment the cards were dealt until the next betting round
            the player could see four other people's chips and not their own.
          */}
          {seat ? (
            <AppText variant="bodyStrong" numeric testID="table-my-stack">
              {formatChips(seat.stack)}
            </AppText>
          ) : null}
        </View>

        {/*
          The chip row for a split, and nothing at all for an ordinary hand.
          Rendered ABOVE the hero hand so the reading order is "which hands do I
          hold" then "the one I am playing" — see `split-hands.ts` for what this
          replaced at each of the three tables.
        */}
        <HandSelector hands={splitHands} testID="table-hand-selector" />

        {seat?.hands.map((hand) =>
          /*
            ONE hand at hero size. This used to render EVERY hand at hero size,
            stacked: four of them do not fit a phone in portrait, and the only
            thing distinguishing the live one was a one-pixel border.
          */
          hand.id === focusedHandId ? (
            <View key={hand.id} style={styles.myHand}>
              <HandCards
                cards={[...hand.cards]}
                size="hero"
                detail={hand.wager > 0 ? `Bet ${formatChips(hand.wager)}` : undefined}
                focused={seat.hands.length > 1}
                testID="table-hand-value"
              />
              {hand.outcome ? (
                <OutcomeBadge kind={hand.outcome.kind} net={hand.outcome.net} />
              ) : null}
            </View>
          ) : null,
        )}
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
      ) : leavingWhenSafe ? (
        /*
         * A STATE, not a one-off message, so it stays on screen for as long as
         * it is true — and carries the way back out of itself. A player who
         * asked to leave and then decided to play on can also just bet: staking
         * chips cancels the intent, because that is what changing your mind
         * looks like.
         */
        <View style={styles.leaving}>
          <AppText variant="body" color="warning" testID="table-leaving">
            {LEAVING_AT_BOUNDARY_NOTICE}
          </AppText>
          <Pressable
            accessibilityRole="button"
            onPress={stayAtTable}
            style={styles.stayButton}
            testID="table-stay"
          >
            <AppText variant="caption" color="accent">
              {STAY_AT_TABLE_LABEL}
            </AppText>
          </Pressable>
        </View>
      ) : notice ? (
        <AppText variant="body" color="warning" testID="table-notice">
          {notice}
        </AppText>
      ) : null}

      {/*
        Presentation only. The number comes from the server's `deadlineAt` and
        the sentence beside it names the default that will be applied — the
        specification's position on timeouts is that they are predictable and
        STATED, and a bare number beside a button is a threat rather than a
        statement.
      */}
      {countdown ? (
        <AppText
          variant="caption"
          color="textSecondary"
          align="center"
          numeric
          testID="table-countdown"
        >
          {countdown}
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
      ) : offer ? (
        /*
         * The insurance offer, first in the chain and rendering INSTEAD of the
         * controls rather than over them.
         *
         * It has to come before the fall-through, not merely alongside it: the
         * sheet is a Modal and would have overlaid "Waiting for the next hand."
         * — a sentence that is wrong twice, because nothing is waiting and the
         * next hand is not what is being asked about.
         *
         * Unmounted the instant the phase advances. Relying on the Modal's
         * `visible` prop alone left it on screen rendering "Insurance costs 0
         * chips", because the stake is only defined while the offer is live —
         * the same lesson `app/game/practice.tsx` learned.
         */
        <InsuranceSheet
          visible
          stake={offer.stake}
          isEvenMoney={offer.isEvenMoney}
          canAfford={offer.canAfford}
          onTake={() => void takeInsurance()}
          onDecline={() => void declineInsurance()}
        />
      ) : canResetStack ? (
        /*
         * Ahead of the betting bar, which cannot render for this seat anyway —
         * a sitting-out seat has no legal actions at all. Placed here so the
         * one thing a stuck player can do is the one thing on screen.
         */
        <SurfaceCard>
          <AppText variant="bodyStrong" testID="table-broke-title">
            {BROKE_AT_PRIVATE_TABLE_TITLE}
          </AppText>
          <AppText variant="body" color="textSecondary">
            {BROKE_AT_PRIVATE_TABLE_BODY}
          </AppText>
          <Button
            label={RESET_PRIVATE_STACK_LABEL}
            testID="table-reset-stack"
            accessibilityHint="Puts your seat back on this table's full stack of chips"
            disabled={controlsDisabled}
            onPress={() => void resetStack()}
          />
        </SurfaceCard>
      ) : legal?.canPlaceBet && seat ? (
        <BettingBar
          legal={legal}
          stagedBet={stagedBet}
          /*
            REPEAT USED TO BE DEAD HERE. `lastBet` was the literal 0 and
            `onRepeat` was `() => undefined`, so the control rendered
            permanently disabled at every server table — Quick Play, public,
            private, tournament and daily — while Practice, which passes both
            for real, worked. The store remembers the last bet the SERVER
            accepted; see `online-table-store.ts`.
          */
          lastBet={lastBet}
          availableStack={seat.stack}
          onAddChip={addChip}
          onClear={clearBet}
          onRepeat={repeatBet}
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
          {describeWaiting({
            phase: table.phase,
            activeSeatId: table.activeSeatId,
            activeSeatName:
              table.seats.find((candidate) => candidate.seatId === table.activeSeatId)
                ?.displayName ?? null,
          })}
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
  const status = useOnlineTableStore((state) => state.status);
  const { settings } = useSettings();
  const navigation = useNavigation();
  /*
   * A route can be removed without anybody pressing "Leave table": the Android
   * hardware back button, a deep link that replaces the stack, a parent
   * navigator resetting. `gestureEnabled: false` in `app/_layout.tsx` closes
   * the swipe; this closes the rest.
   *
   * The removal is CANCELLED, the cash-out is sent, and the navigation is
   * replayed only if the server agreed. A refusal — mid-hand, most often —
   * therefore keeps the player at the table with the reason on screen, rather
   * than walking them away from chips that are still in escrow.
   *
   * `leaving` guards the replay: dispatching the original action re-fires
   * `beforeRemove`, and without it the second pass would send a second
   * CASH_OUT. That one is idempotent server-side — the key is derived from
   * `gameId:seatId` — but a loop that relies on idempotency to terminate is a
   * loop.
   */
  const leaving = useRef(false);

  /** Whether a leave confirmation is already on screen. See `confirmThenLeave`. */
  const confirming = useRef(false);

  /*
   * The stack this seat would be cashing out, from the server's snapshot and
   * nowhere else. Derived with `useMemo` on subscribed state rather than by
   * calling a store getter during render — the React Compiler freezes a getter
   * call at its first result, which is how the Deal button was once disabled
   * permanently.
   */
  const stack = useMemo(() => ownSeat(status)?.stack ?? 0, [status]);

  /*
   * "Confirm before leaving an online game" — `AppSettings.confirmLeavingOnlineGame`.
   *
   * Read HERE, and this is the whole point of the fix: the preference existed,
   * defaulted to true and persisted correctly, and no code anywhere read it.
   * See `shouldConfirmLeavingTable` for why the stack is part of the question.
   */
  const confirmFirst = shouldConfirmLeavingTable({
    confirmEnabled: settings.confirmLeavingOnlineGame,
    stack,
  });

  /**
   * Ask, then cash out — or cash out directly when there is nothing to confirm.
   *
   * Resolves to the server's answer, exactly as `leaveTable()` does, so every
   * caller keeps treating a refusal as "stay at the table". Declining the
   * dialog resolves `false` for the same reason: nothing was cashed out, so
   * nothing may navigate.
   */
  const confirmThenLeave = useCallback(async (): Promise<boolean> => {
    if (!confirmFirst) return leaveTable();

    /*
     * ONE CONFIRMATION AT A TIME.
     *
     * `Alert.alert` is fire-and-forget: iOS presents at most one, and a second
     * raised while the first is still dismissing is DROPPED — which leaves the
     * promise below with no button left to settle it, so this call never
     * returns. A caller awaiting it hangs, and `beforeRemove`'s caller has
     * already cancelled the navigation by then, so the screen stops accepting
     * any route away at all.
     *
     * Reached by tapping "Leave table" twice in quick succession while the
     * server is refusing a mid-hand cash-out — which is exactly what a player
     * does when the first tap appears to do nothing, and what the E2E flow does
     * once a second. Refusing the second ask is the right answer anyway: there
     * is one question on screen and it is already being asked.
     */
    if (confirming.current) return false;
    confirming.current = true;
    try {
      return await askThenLeave();
    } finally {
      confirming.current = false;
    }

    async function askThenLeave(): Promise<boolean> {
    const agreed = await new Promise<boolean>((resolve) => {
      Alert.alert(LEAVE_TABLE_CONFIRM_TITLE, describeLeaveTableConfirmation(stack), [
        // `onDismiss` is Android-only and does not fire for a backdrop tap on
        // iOS, so Cancel carries the negative answer rather than relying on it.
        { text: "Stay", style: "cancel", onPress: () => resolve(false) },
        { text: "Leave table", style: "destructive", onPress: () => resolve(true) },
      ]);
    });
    if (!agreed) return false;
    return leaveTable();
    }
  }, [confirmFirst, leaveTable, stack]);

  /**
   * Everything that must happen AFTER the server has settled the seat, for both
   * of the two ways off this screen.
   *
   * IT EXISTS BECAUSE THE TWO PATHS DISAGREED, and the half that was missing was
   * `leaving.current`. The `beforeRemove` listener set it; the back bar did not
   * — so the back bar confirmed, cashed out, and then navigated, at which point
   * `beforeRemove` fired with `alreadyLeaving: false`, cancelled the navigation,
   * and **asked a second time whether to leave a table the player had already
   * left**, quoting the stack the seat no longer holds. Photographed on the
   * simulator: the dialog sitting over the screen's own
   * "You are no longer at this table" notice. And because an `Alert` is modal,
   * the app was then stuck — a deep link to the lobby COMPLETED and landed
   * behind it.
   *
   * `replayBack` is the only thing the two callers do differently: the listener
   * re-dispatches the action it cancelled, the back bar has none to re-dispatch.
   * Everything else is here, once.
   *
   * REPLAYING IS NOT ENOUGH WHEN THERE IS NOTHING BEHIND THIS ROUTE. The table
   * is reached by `router.replace` from the lobby, by `arc21://table/...`, by a
   * notification and by the resume card on a cold launch — in every one of those
   * a GO_BACK is an action no navigator can handle. Seen on a device: the
   * cash-out committed, the seat settled, the chips came back, and the screen
   * sat on "Reading the table…" with no way off it.
   */
  const finishLeaving = useCallback(
    (replayBack: () => void) => {
      for (const step of tableExitSequence(navigation.canGoBack())) {
        if (step === "mark-leaving") leaving.current = true;
        else if (step === "replay-back") replayBack();
        else router.replace(TABLE_EXIT_ROUTE);
      }
    },
    [navigation],
  );

  useEffect(() => {
    const unsubscribe = navigation.addListener("beforeRemove", (event) => {
      // `holdsSeat` FIRST: with no seat there is nothing to protect, and
      // cancelling here is what wedged the screen — see `mayLeaveTable`.
      const holdsSeat = useOnlineTableStore.getState().status.kind === "at-table";
      if (mayLeaveTable({ alreadyLeaving: leaving.current, cashedOut: false, holdsSeat })) return;
      event.preventDefault();
      void (async () => {
        const cashedOut = await confirmThenLeave();
        if (!mayLeaveTable({ alreadyLeaving: false, cashedOut, holdsSeat: true })) return;
        finishLeaving(() => navigation.dispatch(event.data.action));
      })();
    });
    return unsubscribe;
  }, [navigation, confirmThenLeave, finishLeaving]);

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
              if (!(await confirmThenLeave())) return;
              // The SAME exit as the `beforeRemove` listener, `leaving.current`
              // included — see `finishLeaving` for what happened when this path
              // had its own copy that left that one line out.
              finishLeaving(() => router.back());
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
  leaving: { alignItems: "center", gap: spacing.xs },
  /*
   * A tap target, not a line of text. The accessibility switches taught this
   * the expensive way: a label inside a plain `View` is matched, tapped and
   * does nothing, and every tap reports success.
   */
  stayButton: {
    minHeight: layout.minTouchTarget,
    justifyContent: "center",
    paddingHorizontal: spacing.md,
  },
  tableInfo: { alignItems: "center", gap: spacing.xs },
  dealer: { alignItems: "center", gap: spacing.sm },
  others: { gap: spacing.md },
  otherHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
  },
  mine: { alignItems: "center", gap: spacing.md },
  mineHeader: {
    flexDirection: "row",
    alignItems: "baseline",
    justifyContent: "space-between",
    alignSelf: "stretch",
    gap: spacing.md,
  },
  myHand: { alignItems: "center", gap: spacing.sm },
});
